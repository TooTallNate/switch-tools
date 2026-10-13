/**
 * Blob facades: classes that `extend Blob` (so they flow through code
 * typed for Blobs) but read their bytes on demand, like
 * `LazyDecompressBlob` (archive.ts) and `SectorFileBlob` (psx.ts).
 * Their native backing is empty, so browser APIs that read a Blob
 * directly (`URL.createObjectURL`, `new Blob([...])`, `<a download>`)
 * see 0 bytes. Facades carry {@link BLOB_FACADE}; use
 * {@link realBlob} before handing one to such an API.
 */

export const BLOB_FACADE: unique symbol = Symbol.for('nx-archive.blob-facade') as never;

/** True for Blob facades (see the module comment). */
export function isBlobFacade(blob: Blob): boolean {
	return (blob as { [BLOB_FACADE]?: true })[BLOB_FACADE] === true;
}

/** `blob` itself if it's a real Blob, else its bytes copied into one. */
export async function realBlob(blob: Blob, type = blob.type): Promise<Blob> {
	if (!isBlobFacade(blob)) return blob;
	return new Blob([await blob.arrayBuffer()], { type });
}
