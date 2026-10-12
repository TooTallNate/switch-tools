/**
 * Main-thread side of the scan worker (`scan-worker.ts`): run a media
 * scan in a dedicated module worker with the same callbacks as
 * `scanMedia`, so heavy work (decryption, decompression, GFPAK sniffing,
 * duplicate hashing) never blocks rendering.
 *
 * `scanInWorker` rejects with {@link ScanWorkerUnavailableError} when
 * the worker can't start (no Worker support, bundling / CSP failure),
 * so callers can fall back to an in-thread scan. Set
 * `localStorage['nx-archive:scan-worker'] = '0'` to force that path.
 */

import type { KeySet } from '@tootallnate/nca';

import type { ScanSource, ScanWorkerRequest, ScanWorkerResponse } from './scan-worker';
import type { MediaIndex } from './types';

export class ScanWorkerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ScanWorkerUnavailableError';
	}
}

export function scanWorkerEnabled(): boolean {
	if (typeof Worker === 'undefined') return false;
	try {
		return localStorage.getItem('nx-archive:scan-worker') !== '0';
	} catch {
		return true;
	}
}

export interface WorkerScanOptions {
	source: ScanSource;
	fileKey: string | null;
	keys: KeySet | null;
	base: { fileName: string; fileSize: number };
	include?: string[];
	deep?: boolean;
	/**
	 * Snapshot interval. Each snapshot is structured-cloned onto the main
	 * thread, so this is longer than the in-thread default.
	 */
	updateIntervalMs?: number;
	signal?: AbortSignal;
	onUpdate?: (index: MediaIndex) => void;
	onProgress?: (visited: number, path: string) => void;
	onRequestKeys?: () => void;
	onRequestOodle?: () => void;
}

export function scanInWorker(opts: WorkerScanOptions): Promise<MediaIndex> {
	return new Promise((resolve, reject) => {
		let worker: Worker;
		try {
			worker = new Worker(new URL('./scan-worker.ts', import.meta.url), { type: 'module', name: 'nx-archive-scan' });
		} catch (err) {
			reject(new ScanWorkerUnavailableError(err instanceof Error ? err.message : String(err)));
			return;
		}
		let started = false;
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			opts.signal?.removeEventListener('abort', onAbort);
			worker.terminate();
			fn();
		};
		const onAbort = () => {
			// The scan is abandoned: stop the worker outright.
			worker.postMessage({ type: 'cancel' } satisfies ScanWorkerRequest);
			finish(() => reject(new DOMException('Scan aborted', 'AbortError')));
		};
		if (opts.signal?.aborted) return onAbort();
		opts.signal?.addEventListener('abort', onAbort);
		worker.onerror = (e) => {
			e.preventDefault();
			const message = e.message || 'Scan worker failed';
			finish(() => reject(started ? new Error(message) : new ScanWorkerUnavailableError(message)));
		};
		worker.onmessage = (e: MessageEvent<ScanWorkerResponse>) => {
			const msg = e.data;
			switch (msg.type) {
				case 'ready': {
					started = true;
					const start: ScanWorkerRequest = {
						type: 'start',
						source: opts.source,
						fileKey: opts.fileKey,
						keys: opts.keys,
						base: opts.base,
						include: opts.include,
						deep: opts.deep,
						updateIntervalMs: opts.updateIntervalMs ?? 2500,
					};
					worker.postMessage(start);
					break;
				}
				case 'update':
					opts.onUpdate?.(msg.index);
					break;
				case 'progress':
					opts.onProgress?.(msg.visited, msg.path);
					break;
				case 'request-keys':
					opts.onRequestKeys?.();
					break;
				case 'request-oodle':
					opts.onRequestOodle?.();
					break;
				case 'done':
					finish(() => resolve(msg.index));
					break;
				case 'error':
					finish(() => reject(new Error(msg.message)));
					break;
			}
		};
	});
}
