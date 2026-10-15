/**
 * Title executables, for formats whose decoding depends on data in the
 * game's own code (Pokkén DX's version 5 DRPs need a table from `main`;
 * see `@tootallnate/drp`'s `findLiteralTable`).
 *
 * Program NCAs register their exefs `main` here when their sections are
 * listed. A file inside that NCA's RomFS finds it by node id (the NCA's
 * id is a prefix of every node under it), so nothing has to walk the
 * tree. Shipping such tables in the repo isn't an option: they're game
 * data, and the user's own dump already contains them.
 */
import { decodeBlock } from '@tootallnate/lz4';
import { parseHeader } from '@tootallnate/nso';

const mains = new Map<string, () => Promise<Blob | null>>();

/** Register the exefs `main` of the NCA node `ncaId`. */
export function registerExefsMain(ncaId: string, getMain: () => Promise<Blob | null>): void {
	mains.set(ncaId, getMain);
}

/**
 * The `main` of the title a node belongs to: the registered NCA whose id
 * is the longest prefix of `nodeId`, else (for an update whose RomFS was
 * patched) any NCA in the same package.
 */
export function exefsMainFor(nodeId: string): (() => Promise<Blob | null>) | null {
	let best: string | null = null;
	for (const id of mains.keys()) {
		if (nodeId.startsWith(`${id}/`) && (!best || id.length > best.length)) best = id;
	}
	if (best) return mains.get(best)!;
	const pkg = nodeId.split('/').slice(0, 2).join('/');
	for (const [id, get] of mains) if (id.startsWith(`${pkg}/`)) return get;
	return null;
}

/** Flatten an NSO into its load image (text at 0, rodata and data at their offsets). */
export async function nsoImage(blob: Blob): Promise<Uint8Array> {
	const h = await parseHeader(blob);
	if (h.usesZstd) throw new Error('zstd-compressed NSO segments are not supported here');
	const segs = [h.textSegment, h.rodataSegment, h.dataSegment];
	const image = new Uint8Array(Math.max(...segs.map((s) => s.memoryOffset + s.size)));
	for (const s of segs) {
		const raw = new Uint8Array(await blob.slice(s.fileOffset, s.fileOffset + s.fileSize).arrayBuffer());
		const data = s.compressed ? decodeBlock(raw, s.size) : raw;
		image.set(data.subarray(0, s.size), s.memoryOffset);
	}
	return image;
}
