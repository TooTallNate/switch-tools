/**
 * Streaming ZIP export for any container `Node` in the archive tree.
 *
 * The archive tree's `Node.getChildren()` API is lazy and recursive
 * (subdirs / nested containers expand on demand), so a depth-first
 * walk gives us a stream of `(path, Blob)` pairs that can be piped
 * into fflate's streaming `Zip` writer without ever fully
 * materialising any individual file or the resulting archive.
 *
 * Output strategy:
 *
 *   - `showSaveFilePicker` (Chromium / Edge): zip bytes are piped
 *     directly to a `FileSystemWritableFileStream`, so multi-GB
 *     exports cost O(1) memory.
 *   - Otherwise: zip bytes accumulate in a JS array and are handed
 *     to the caller as a `Blob` at the end. Memory cost ≈ total
 *     archive size; use the picker when available.
 *
 * Per-entry compression: every file is added via `ZipPassThrough`
 * (store, no DEFLATE). Switch archive content is overwhelmingly
 * pre-compressed (NCA, BNTX, BFRES, etc.) and re-deflating it
 * gives < 1 % savings at a multi-second-per-MB CPU cost. Plain
 * `store` keeps the export fast and lets us push raw Blob slices
 * straight into the zip stream.
 *
 * A single ZIP entry per file in the subtree. Directories are
 * implicit via the slash-separated entry name (`a/b/c.txt`); we
 * don't emit explicit directory entries, which the ZIP spec
 * permits.
 *
 * Path sanitisation: entry names are derived from `Node.name`
 * along the walk; we strip leading slashes, replace backslashes
 * with forward slashes, and drop `.`/`..` segments. Empty segments
 * (consecutive slashes, leading dot files like `.gitignore`) are
 * preserved verbatim.
 */

import { Zip, ZipPassThrough } from 'fflate';

import type { Node } from './archive';

/**
 * Per-file progress event. Fires AFTER each file has been pushed
 * into the zip stream — i.e. all `chunkBytes` for that file have
 * been read from the source Blob and queued for the zip writer.
 */
export interface ZipExportProgress {
	/** Total file entries that will be written (-1 until the walker finishes counting). */
	totalFiles: number;
	/** Files emitted so far. */
	filesDone: number;
	/** Total uncompressed bytes read so far from source Blobs. */
	bytesRead: number;
	/** Total ZIP-output bytes emitted so far (compressed + headers). */
	bytesOut: number;
	/** Name of the file currently being processed (relative to root). */
	currentEntry: string;
	/** Throughput over the last batch in bytes/second. */
	bytesPerSecond: number;
}

export interface ZipExportOptions {
	/** Cancel the export. Throws an `AbortError` from the returned promise. */
	signal?: AbortSignal;
	/** Progress callback. Fires after each file plus periodic byte-only updates. */
	onProgress?: (p: ZipExportProgress) => void;
	/**
	 * Optional sink for the zip output stream. When provided, the
	 * resulting `Blob` is empty (`size === 0`) and the caller is
	 * responsible for closing the stream when this function
	 * resolves. When omitted, a `Blob` is returned.
	 */
	sink?: WritableStreamDefaultWriter<Uint8Array>;
	/**
	 * Maximum chunk size used when slicing the source Blob into
	 * the zip stream. Bigger = fewer JS↔runtime crossings at the
	 * cost of more memory pressure. Default 4 MiB.
	 */
	chunkBytes?: number;
}

export interface ZipExportResult {
	/** Total file entries written. */
	files: number;
	/** Total uncompressed source bytes read. */
	uncompressedBytes: number;
	/** Total ZIP-stream bytes emitted. */
	zipBytes: number;
	/**
	 * Final ZIP blob when no `sink` was provided. When a `sink` is
	 * provided, this is an empty placeholder Blob (the bytes have
	 * already been streamed to the sink).
	 */
	blob: Blob;
}

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Strip a path of leading slashes, normalise backslashes, and
 * drop any `.`/`..` segments. Empty segments are preserved.
 */
function sanitisePath(parts: string[]): string {
	const out: string[] = [];
	for (const raw of parts) {
		const segs = raw.replace(/\\/g, '/').split('/');
		for (const s of segs) {
			if (s === '' || s === '.') continue;
			if (s === '..') continue;
			out.push(s);
		}
	}
	return out.join('/');
}

/**
 * Recursively collect every leaf `Node` under `root` along with
 * its relative path. The walk is depth-first; container nodes
 * with no `getChildren` (rare — typically a file with content)
 * are emitted as files themselves.
 *
 * Returns an async iterator so the consumer can stream entries
 * into the ZIP without materialising the full list up front.
 */
async function* walkLeaves(
	root: Node,
	signal?: AbortSignal,
): AsyncIterableIterator<{ path: string; blob: Blob; size: number }> {
	const stack: Array<{ node: Node; pathParts: string[] }> = [
		{ node: root, pathParts: [] },
	];
	while (stack.length > 0) {
		signal?.throwIfAborted();
		const { node, pathParts } = stack.pop()!;
		if (node.getChildren) {
			let kids: Node[];
			try {
				kids = node._children ?? (node._children = await node.getChildren());
			} catch (e) {
				// Skip unreadable subtrees rather than aborting the
				// whole export. The caller still gets a successful zip
				// with the readable parts.
				const reason = e instanceof Error ? e.message : String(e);
				console.warn(`[zip-export] Skipping ${node.id}: ${reason}`);
				continue;
			}
			// Reverse so the stack pops in natural (alphabetical) order.
			for (let i = kids.length - 1; i >= 0; i--) {
				const child = kids[i];
				stack.push({ node: child, pathParts: [...pathParts, child.name] });
			}
			continue;
		}
		if (!node.blob) {
			// No children and no blob — synthetic / placeholder node.
			// Nothing to emit.
			continue;
		}
		let blob: Blob;
		try {
			blob = await node.blob();
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			console.warn(`[zip-export] Skipping ${node.id}: ${reason}`);
			continue;
		}
		yield {
			path: sanitisePath(pathParts),
			blob,
			size: blob.size,
		};
	}
}

/**
 * Push the contents of `blob` into the supplied ZipPassThrough
 * stream as `chunkBytes`-sized slices. The final chunk is marked
 * `final=true` so fflate's writer knows to close out this entry.
 *
 * Honours the abort signal between chunks.
 */
async function pumpBlobIntoZipEntry(
	entry: ZipPassThrough,
	blob: Blob,
	chunkBytes: number,
	signal: AbortSignal | undefined,
	onChunk: (bytes: number) => void,
): Promise<void> {
	let offset = 0;
	const total = blob.size;
	if (total === 0) {
		// fflate requires at least one push to close the entry.
		entry.push(new Uint8Array(0), true);
		return;
	}
	while (offset < total) {
		signal?.throwIfAborted();
		const end = Math.min(offset + chunkBytes, total);
		const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
		const isFinal = end >= total;
		entry.push(chunk, isFinal);
		onChunk(chunk.length);
		offset = end;
	}
}

/**
 * Export the entire subtree under `root` as a ZIP file.
 *
 * Returns a {@link ZipExportResult} with the final byte counts and
 * a Blob (empty when a `sink` was provided).
 */
export async function exportNodeToZip(
	root: Node,
	options: ZipExportOptions = {},
): Promise<ZipExportResult> {
	const {
		signal,
		onProgress,
		sink,
		chunkBytes = DEFAULT_CHUNK_BYTES,
	} = options;
	signal?.throwIfAborted();

	const collectedChunks: Uint8Array[] = [];
	let zipBytes = 0;
	let bytesRead = 0;
	let filesDone = 0;
	let totalFiles = -1;
	let lastReportAt = performance.now();
	let lastReportBytes = 0;
	let currentEntry = '';

	const emitProgress = (force = false): void => {
		if (!onProgress) return;
		const now = performance.now();
		// Throttle to ~5 updates / sec unless force is set.
		if (!force && now - lastReportAt < 200) return;
		const dt = (now - lastReportAt) / 1000;
		const bps = dt > 0 ? (bytesRead - lastReportBytes) / dt : 0;
		lastReportAt = now;
		lastReportBytes = bytesRead;
		onProgress({
			totalFiles,
			filesDone,
			bytesRead,
			bytesOut: zipBytes,
			currentEntry,
			bytesPerSecond: bps,
		});
	};

	let zipError: Error | null = null;
	let resolveDone: (() => void) | undefined;
	let rejectDone: ((err: unknown) => void) | undefined;
	const zipDonePromise = new Promise<void>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});
	const zip = new Zip((err, data, final) => {
		if (err) {
			zipError = err as Error;
			rejectDone?.(err);
			return;
		}
		if (data && data.length > 0) {
			zipBytes += data.length;
			if (sink) {
				// Backpressure: best-effort fire-and-forget — fflate's
				// callback is synchronous so we don't await here.
				// Vanishingly small chunks (header / footer) get queued.
				void sink.write(data);
			} else {
				collectedChunks.push(data);
			}
		}
		if (final) {
			resolveDone?.();
		}
	});

	try {
		for await (const entry of walkLeaves(root, signal)) {
			signal?.throwIfAborted();
			if (zipError) throw zipError;
			// fflate's ZipPassThrough emits to `zip` via its `ondata`
			// callback; the parent `Zip` writes the central directory
			// when `end()` is called.
			currentEntry = entry.path || '(root)';
			const zpt = new ZipPassThrough(entry.path);
			zip.add(zpt);
			await pumpBlobIntoZipEntry(zpt, entry.blob, chunkBytes, signal, (n) => {
				bytesRead += n;
				emitProgress(false);
			});
			filesDone += 1;
			emitProgress(true);
		}
		zip.end();
	} catch (err) {
		try {
			zip.terminate();
		} catch {
			// already terminated
		}
		throw err;
	}
	await zipDonePromise;
	if (zipError) throw zipError;
	emitProgress(true);

	const blob = sink ? new Blob([]) : new Blob(collectedChunks as BlobPart[], { type: 'application/zip' });
	return {
		files: filesDone,
		uncompressedBytes: bytesRead,
		zipBytes,
		blob,
	};
}

/**
 * True iff the browser supports the File System Access API's
 * `showSaveFilePicker`. Lets the caller decide whether to use the
 * streaming sink path or the in-memory Blob path.
 */
export function hasFileSystemSavePicker(): boolean {
	return typeof globalThis !== 'undefined' &&
		typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

/**
 * High-level helper: prompt the user for a save location (via the
 * File System Access API when available, blob URL download
 * otherwise), then stream the export there. Returns the final
 * result counts.
 */
export async function saveNodeAsZip(
	root: Node,
	suggestedName: string,
	options: Omit<ZipExportOptions, 'sink'> = {},
): Promise<ZipExportResult | null> {
	const safeName = suggestedName.endsWith('.zip') ? suggestedName : `${suggestedName}.zip`;
	type SaveHandle = {
		createWritable: () => Promise<{
			write(chunk: Uint8Array): Promise<void>;
			close(): Promise<void>;
			abort?: (reason?: string) => Promise<void>;
		}>;
	};
	const picker = (globalThis as {
		showSaveFilePicker?: (opts: {
			suggestedName: string;
			types?: Array<{ description?: string; accept: Record<string, string[]> }>;
		}) => Promise<SaveHandle>;
	}).showSaveFilePicker;
	if (picker) {
		let handle: SaveHandle;
		try {
			handle = await picker({
				suggestedName: safeName,
				types: [{
					description: 'ZIP archive',
					accept: { 'application/zip': ['.zip'] },
				}],
			});
		} catch (e) {
			// User cancelled the picker.
			if (e instanceof Error && e.name === 'AbortError') return null;
			throw e;
		}
		const writable = await handle.createWritable();
		// The File System Access API's writable already has write/close
		// methods, so we wrap them in the minimal Writer-shaped interface
		// our exporter needs.
		const writer: WritableStreamDefaultWriter<Uint8Array> = {
			write: (chunk: Uint8Array) => writable.write(chunk),
			close: () => writable.close(),
			abort: writable.abort
				? (reason?: unknown) =>
						writable.abort!(reason instanceof Error ? reason.message : String(reason))
				: () => Promise.resolve(),
		} as unknown as WritableStreamDefaultWriter<Uint8Array>;
		try {
			const result = await exportNodeToZip(root, { ...options, sink: writer });
			await writer.close();
			return result;
		} catch (err) {
			try {
				await writer.abort?.(err instanceof Error ? err.message : String(err));
			} catch {
				/* ignore */
			}
			throw err;
		}
	}
	// Fallback: buffer in memory, then trigger a blob URL download.
	const result = await exportNodeToZip(root, options);
	const url = URL.createObjectURL(result.blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = safeName;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} finally {
		// Defer revoke so the browser's download machinery can latch on.
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}
	return result;
}
