/// <reference lib="webworker" />
/**
 * Web Worker that runs the media-library scan off the main thread.
 *
 * The scanner is DOM-free (the Bun CLI runs it too), so the worker
 * builds its own copy of the opened file's node tree from the posted
 * `File` / directory listing and walks that. Node ids are
 * deterministic paths, so the resulting index lines up with the main
 * thread's tree (which previews and thumbnails keep using). Expensive
 * container parses persist their results in the shared IndexedDB `kv`
 * store (e.g. GFPAK sniffing), so the main tree's later on-demand
 * expansion of the same containers is cheap.
 *
 * Protocol: see `scan-client.ts`.
 */

import type { KeySet } from '@tootallnate/nca';

import { buildDirectoryRootNode, buildRootNode, type ArchiveContext } from '../archive';
import type { WalkedDirectory } from '../directory';
import { getOodleDecompressor, loadStoredOodleWasm } from '../oodle-store';
import { persistentCacheFor } from './cache';
import { scanMedia } from './scanner';
import type { MediaIndex } from './types';

export type ScanSource = { kind: 'file'; file: File } | { kind: 'directory'; directory: WalkedDirectory };

export interface ScanStartMessage {
	type: 'start';
	source: ScanSource;
	fileKey: string | null;
	keys: KeySet | null;
	base: { fileName: string; fileSize: number };
	include?: string[];
	deep?: boolean;
	updateIntervalMs: number;
}

export type ScanWorkerRequest = ScanStartMessage | { type: 'cancel' } | { type: 'keys'; keys: KeySet | null };

export type ScanWorkerResponse =
	| { type: 'ready' }
	| { type: 'update'; index: MediaIndex }
	| { type: 'progress'; visited: number; path: string }
	| { type: 'done'; index: MediaIndex }
	| { type: 'error'; message: string }
	| { type: 'request-keys' }
	| { type: 'request-oodle' };

const post = (msg: ScanWorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

let keys: KeySet | null = null;
let abort: AbortController | null = null;

async function run(msg: ScanStartMessage) {
	keys = msg.keys;
	abort = new AbortController();
	const signal = abort.signal;
	// Oodle bytes live in IndexedDB; load them here (the main thread's
	// copy is in its own memory).
	await loadStoredOodleWasm().catch(() => null);
	const ctx: ArchiveContext = {
		getKeys: () => keys,
		requestKeys: () => post({ type: 'request-keys' }),
		getOodleDecompressor,
		requestOodle: () => post({ type: 'request-oodle' }),
		getPersistentCache: () => (msg.fileKey ? persistentCacheFor(msg.fileKey) : null),
	};
	const root =
		msg.source.kind === 'file'
			? await buildRootNode(msg.source.file, msg.source.file.name, ctx)
			: await buildDirectoryRootNode(msg.source.directory, ctx);
	let lastProgress = 0;
	const index = await scanMedia(
		root,
		{ ...msg.base, platform: root.format ?? 'file' },
		{
			signal,
			include: msg.include ? new Set(msg.include) : undefined,
			deep: msg.deep,
			updateIntervalMs: msg.updateIntervalMs,
			onUpdate: (idx) => {
				if (!signal.aborted) post({ type: 'update', index: idx });
			},
			onProgress: (visited, path) => {
				const now = performance.now();
				if (now - lastProgress > 150 && !signal.aborted) {
					lastProgress = now;
					post({ type: 'progress', visited, path });
				}
			},
		},
	);
	if (!signal.aborted) post({ type: 'done', index });
}

self.onmessage = (e: MessageEvent<ScanWorkerRequest>) => {
	const msg = e.data;
	if (msg.type === 'start') {
		run(msg).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
	} else if (msg.type === 'cancel') {
		abort?.abort();
	} else if (msg.type === 'keys') {
		keys = msg.keys;
	}
};

post({ type: 'ready' });
