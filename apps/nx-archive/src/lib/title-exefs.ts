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

const stringCache = new Map<() => Promise<Blob | null>, Promise<Set<string>>>();

/**
 * Identifier-like strings (`[A-Za-z0-9_]{2,64}`, NUL-terminated) from the
 * title's `main`. Formats that store names only as hashes (AAMP's CRC32
 * keys, for example) resolve them against these. The names are the
 * game's own, read from the user's dump. Empty when there's no `main`.
 * Cached per title.
 */
export function exefsStringsFor(nodeId: string): Promise<Set<string>> {
	const get = exefsMainFor(nodeId);
	if (!get) return Promise.resolve(new Set());
	let cached = stringCache.get(get);
	if (!cached) {
		cached = (async () => {
			const main = await get().catch(() => null);
			if (!main) return new Set<string>();
			return identifierStrings(await nsoImage(main));
		})().catch(() => new Set<string>());
		stringCache.set(get, cached);
	}
	return cached;
}

/** NUL-terminated runs of identifier characters, 2 to 64 long. */
export function identifierStrings(bytes: Uint8Array): Set<string> {
	const out = new Set<string>();
	let start = -1;
	for (let i = 0; i < bytes.length; i++) {
		const c = bytes[i]!;
		const ident = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
		if (ident) {
			if (start < 0) start = i;
			continue;
		}
		if (c === 0 && start >= 0 && i - start >= 2 && i - start <= 64) {
			out.add(String.fromCharCode(...bytes.subarray(start, i)));
		}
		start = -1;
	}
	return out;
}
