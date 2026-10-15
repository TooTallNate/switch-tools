/**
 * Object URLs for anything `node.blob()` returns.
 *
 * `node.blob()` can hand back three kinds of value:
 *
 *  - a real `Blob` (RomFS slices of plain files, `File`s, decoded output);
 *  - a duck-typed facade that only *looks* like a Blob, such as NCA
 *    AES-CTR sections (`@tootallnate/nca`), BKTR patched sections and
 *    ZIP / UnityFS entries. These fail `instanceof Blob`;
 *  - a class that `extends Blob` but reads its bytes on demand
 *    (`LazyDecompressBlob`, `SectorFileBlob`; see `blob-facade.ts`).
 *    These pass `instanceof Blob` with an empty native backing.
 *
 * `URL.createObjectURL` only accepts the first kind. The other two
 * either throw ("could not be converted to any of: Blob, MediaSource"
 * or "Overload resolution failed") or produce an empty resource. These
 * helpers route each kind correctly: native Blobs directly, facades
 * through the service-worker VFS when it's up (Range-streamed, so
 * multi-GB videos never sit in memory), else materialised into a real
 * Blob.
 */
import { isBlobFacade } from './blob-facade';
import { isVfsAvailable, registerBlobAsVfsResource, unregisterVfsResource } from './vfs';

/** True if `blob` can go straight to `URL.createObjectURL`. */
export function isNativeBlob(blob: Blob): boolean {
	return typeof Blob !== 'undefined' && blob instanceof Blob && !isBlobFacade(blob);
}

/**
 * A real `Blob` with `blob`'s bytes and the given MIME type. Native
 * Blobs are re-tagged without copying; facades are read in full
 * (memory ≈ file size), reporting progress as chunks arrive.
 */
export async function toNativeBlob(
	blob: Blob,
	mime: string,
	onProgress?: (bytesRead: number, bytesTotal: number) => void,
): Promise<Blob> {
	if (isNativeBlob(blob)) {
		onProgress?.(blob.size, blob.size);
		return blob.type === mime ? blob : blob.slice(0, blob.size, mime);
	}
	const total = blob.size;
	if (typeof blob.stream !== 'function') {
		const buf = await blob.arrayBuffer();
		onProgress?.(total, total);
		return new Blob([buf], { type: mime });
	}
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	const reader = blob.stream().getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			bytesRead += value.byteLength;
			onProgress?.(bytesRead, total);
		}
	}
	return new Blob(chunks as BlobPart[], { type: mime });
}

/**
 * A URL for `blob`, plus a `dispose()` that releases it. Native Blobs
 * get a blob URL; facades get a VFS URL when the service worker is
 * available, else a blob URL of the materialised bytes.
 */
export async function makeObjectUrl(
	blob: Blob,
	mime: string,
	filename: string,
	onProgress?: (bytesRead: number, bytesTotal: number) => void,
): Promise<{ url: string; dispose: () => void }> {
	if (!isNativeBlob(blob) && isVfsAvailable()) {
		const url = registerBlobAsVfsResource(blob, mime, filename);
		if (url) {
			onProgress?.(blob.size, blob.size);
			return { url, dispose: () => unregisterVfsResource(url) };
		}
	}
	const real = await toNativeBlob(blob, mime, onProgress);
	const url = URL.createObjectURL(real);
	return { url, dispose: () => URL.revokeObjectURL(url) };
}
