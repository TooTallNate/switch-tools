/**
 * Game Freak's Trinity virtual file system (Pokémon Scarlet / Violet;
 * Legends: Arceus uses the same `arc/data.trpfs` + `arc/data.trpfd`).
 *
 * All three structures are FlatBuffers (schemas from pkZukan's GFTool,
 * `GFTool.Core/Flatbuffers/TR/ResourceDictionary`):
 *
 * - `data.trpfd` (descriptor): `FileHashes: [u64]`, `PackNames: [string]`,
 *   `FileInfo: [{ PackIndex: u64, … }]` (one per file hash),
 *   `PackInfo: [{ FileSize: u64, FileCount: u64 }]`.
 * - `data.trpfs` (the data): `'ONEPACK\0'`, u64 offset of a trailing
 *   `{ FileHashes: [u64], FileOffsets: [u64] }` table; the hashes are of
 *   the pack names, the offsets point at each pack.
 * - A pack (`.trpak`): `{ FileHashes: [u64], FileEntry: [{ Field_00,
 *   EncryptionType: i8, Level: u8, FileSize: u64, FileBuffer: [u8] }] }`.
 *   `EncryptionType` −1 is stored; anything else is Oodle-compressed.
 *
 * File and pack names are 64-bit FNV-1a hashes of their paths with Game
 * Freak's offset basis (`0xCBF29CE484222645`, not the standard one).
 * Names aren't stored, so they're recovered: pack names are the path of
 * one file in the pack with the slashes removed, and the Pokémon
 * catalog (`pokemon/catalog/catalog/poke_resource_table.trpmcatalog`)
 * lists every model's full path; see {@link parsePokemonCatalog}.
 */

export const GF_FNV_BASIS = 0xcbf29ce484222645n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** Game Freak FNV-1a 64 of a UTF-8 string (optionally continuing from a state). */
export function gfFnv64(str: string, basis: bigint = GF_FNV_BASIS): bigint {
	let h = basis;
	for (const b of new TextEncoder().encode(str)) {
		h ^= BigInt(b);
		h = (h * FNV_PRIME) & MASK;
	}
	return h;
}

/** Minimal FlatBuffers table reader. */
class Fb {
	readonly dv: DataView;
	constructor(readonly bytes: Uint8Array) {
		this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	u32(o: number) {
		return this.dv.getUint32(o, true);
	}
	root(): number {
		return this.u32(0);
	}
	/** Absolute offset of a table's field, or 0 when absent. */
	field(table: number, i: number): number {
		const vt = table - this.dv.getInt32(table, true);
		const vlen = this.dv.getUint16(vt, true);
		if (4 + i * 2 >= vlen) return 0;
		const off = this.dv.getUint16(vt + 4 + i * 2, true);
		return off ? table + off : 0;
	}
	/** Vector at a field: element start offset and length. */
	vector(table: number, i: number): { start: number; length: number } {
		const f = this.field(table, i);
		if (!f) return { start: 0, length: 0 };
		const v = f + this.u32(f);
		return { start: v + 4, length: this.u32(v) };
	}
	u64Vector(table: number, i: number): BigUint64Array {
		const { start, length } = this.vector(table, i);
		const out = new BigUint64Array(length);
		for (let k = 0; k < length; k++) out[k] = this.dv.getBigUint64(start + k * 8, true);
		return out;
	}
	/** Offsets of the tables in a vector of tables. */
	tables(table: number, i: number): number[] {
		const { start, length } = this.vector(table, i);
		const out: number[] = [];
		for (let k = 0; k < length; k++) out.push(start + k * 4 + this.u32(start + k * 4));
		return out;
	}
	strings(table: number, i: number): string[] {
		const dec = new TextDecoder();
		return this.tables(table, i).map((s) => dec.decode(this.bytes.subarray(s + 4, s + 4 + this.u32(s))));
	}
	string(table: number, i: number): string {
		const f = this.field(table, i);
		if (!f) return '';
		const s = f + this.u32(f);
		return new TextDecoder().decode(this.bytes.subarray(s + 4, s + 4 + this.u32(s)));
	}
	u64(table: number, i: number): bigint {
		const f = this.field(table, i);
		return f ? this.dv.getBigUint64(f, true) : 0n;
	}
	i8(table: number, i: number, dflt = 0): number {
		const f = this.field(table, i);
		return f ? this.dv.getInt8(f) : dflt;
	}
	u16(table: number, i: number): number {
		const f = this.field(table, i);
		return f ? this.dv.getUint16(f, true) : 0;
	}
}

export interface Trpfd {
	fileHashes: BigUint64Array;
	packNames: string[];
	/** Pack index per file (parallel to `fileHashes`). */
	filePack: Uint32Array;
	packs: { size: number; fileCount: number }[];
}

export function parseTrpfd(bytes: Uint8Array): Trpfd {
	const fb = new Fb(bytes);
	const r = fb.root();
	const fileHashes = fb.u64Vector(r, 0);
	const packNames = fb.strings(r, 1);
	const infos = fb.tables(r, 2);
	const filePack = new Uint32Array(infos.length);
	infos.forEach((t, k) => (filePack[k] = Number(fb.u64(t, 0))));
	const packs = fb.tables(r, 3).map((t) => ({ size: Number(fb.u64(t, 0)), fileCount: Number(fb.u64(t, 1)) }));
	if (packNames.length !== packs.length || fileHashes.length !== filePack.length) throw new Error('TRPFD tables disagree');
	return { fileHashes, packNames, filePack, packs };
}

export const TRPFS_MAGIC = 'ONEPACK\0';

export function isTrpfs(head: Uint8Array): boolean {
	return head.length >= 8 && new TextDecoder().decode(head.subarray(0, 8)) === TRPFS_MAGIC;
}

/** Offset of the trailing index table (read 16 header bytes). */
export function trpfsIndexOffset(head: Uint8Array): number {
	if (!isTrpfs(head)) throw new Error('Not a TRPFS (missing "ONEPACK")');
	return Number(new DataView(head.buffer, head.byteOffset, head.byteLength).getBigUint64(8, true));
}

export interface TrpfsIndex {
	/** Pack-name hash → byte offset of the pack in the `.trpfs`. */
	offsets: Map<bigint, number>;
	/** Sorted pack offsets, to bound each pack's length. */
	sorted: number[];
}

export function parseTrpfsIndex(bytes: Uint8Array, indexOffset: number): TrpfsIndex {
	const fb = new Fb(bytes);
	const r = fb.root();
	const hashes = fb.u64Vector(r, 0);
	const offs = fb.u64Vector(r, 1);
	const offsets = new Map<bigint, number>();
	hashes.forEach((h, i) => offsets.set(h, Number(offs[i] ?? 0n)));
	const sorted = [...offsets.values()].sort((a, b) => a - b);
	sorted.push(indexOffset);
	return { offsets, sorted };
}

/** Byte range of a pack in the `.trpfs`. */
export function packRange(index: TrpfsIndex, packName: string): { start: number; end: number } | null {
	const start = index.offsets.get(gfFnv64(packName));
	if (start === undefined) return null;
	let lo = 0;
	let hi = index.sorted.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (index.sorted[mid]! <= start) lo = mid + 1;
		else hi = mid;
	}
	return { start, end: index.sorted[lo]! };
}

export interface TrpakFile {
	hash: bigint;
	/** −1: stored; otherwise Oodle-compressed. */
	encryption: number;
	size: number;
	/** The (possibly compressed) data, a view into the pack bytes. */
	data: Uint8Array;
}

export function parseTrpak(bytes: Uint8Array): TrpakFile[] {
	const fb = new Fb(bytes);
	const r = fb.root();
	const hashes = fb.u64Vector(r, 0);
	return fb.tables(r, 1).map((t, i) => {
		const buf = fb.vector(t, 4);
		return {
			hash: hashes[i] ?? 0n,
			encryption: fb.i8(t, 1, -1),
			size: Number(fb.u64(t, 3)),
			data: bytes.subarray(buf.start, buf.start + buf.length),
		};
	});
}

// ----- Pokémon catalog -----

export const POKEMON_CATALOG_PATH = 'pokemon/catalog/catalog/poke_resource_table.trpmcatalog';

export interface PokemonCatalogEntry {
	species: number;
	form: number;
	/** Full paths (the catalog stores them relative to `pokemon/data/`). */
	modelPath: string;
	materialPath: string;
	configPath: string;
	/** Every other path the entry mentions (animation sets, skeletons, locators, …). */
	paths: string[];
}

/** Where catalog paths are rooted. */
export const POKEMON_DATA_ROOT = 'pokemon/data/';

/**
 * `poke_resource_table.trpmcatalog`: every species / form's model,
 * material and config paths (fields 1–3 of each entry). The remaining
 * fields differ between games and versions, so their strings are
 * harvested rather than read by schema.
 */
export function parsePokemonCatalog(bytes: Uint8Array): PokemonCatalogEntry[] {
	const fb = new Fb(bytes);
	const r = fb.root();
	const full = (p: string) => (p && !p.startsWith(POKEMON_DATA_ROOT) && !p.startsWith('pokemon/') ? POKEMON_DATA_ROOT + p : p);
	return fb.tables(r, 1).map((e) => {
		const sp = fb.field(e, 0);
		const spT = sp ? sp + fb.u32(sp) : 0;
		const paths: string[] = [];
		for (let i = 4; i < 12; i++) harvest(fb, e, i, paths, 0);
		return {
			species: spT ? fb.u16(spT, 0) : 0,
			form: spT ? fb.u16(spT, 1) : 0,
			modelPath: full(fb.string(e, 1)),
			materialPath: full(fb.string(e, 2)),
			configPath: full(fb.string(e, 3)),
			paths: paths.map(full),
		};
	});
}

/** Collect path-like strings under a table field (string, table, or vector of either). */
function harvest(fb: Fb, table: number, i: number, out: string[], depth: number): void {
	if (depth > 2) return;
	const f = safe(() => fb.field(table, i), 0);
	if (!f) return;
	const target = safe(() => f + fb.u32(f), 0);
	if (!target || target + 4 > fb.bytes.length) return;
	const len = fb.u32(target);
	// A string?
	if (len > 0 && len < 512 && target + 4 + len <= fb.bytes.length) {
		const str = new TextDecoder().decode(fb.bytes.subarray(target + 4, target + 4 + len));
		if (/^[\w./-]+\.\w+$/.test(str) && str.includes('/')) {
			out.push(str);
			return;
		}
	}
	// A vector: of tables or strings.
	if (len > 0 && len < 10_000 && target + 4 + len * 4 <= fb.bytes.length) {
		for (let k = 0; k < len; k++) {
			const elem = target + 4 + k * 4 + fb.u32(target + 4 + k * 4);
			if (elem + 4 > fb.bytes.length) continue;
			const elen = fb.u32(elem);
			if (elen > 0 && elen < 512 && elem + 4 + elen <= fb.bytes.length) {
				const str = new TextDecoder().decode(fb.bytes.subarray(elem + 4, elem + 4 + elen));
				if (/^[\w./-]+\.\w+$/.test(str) && str.includes('/')) {
					out.push(str);
					continue;
				}
			}
			for (let j = 0; j < 4; j++) harvest(fb, elem, j, out, depth + 1);
		}
		return;
	}
	// A table.
	for (let j = 0; j < 4; j++) harvest(fb, target, j, out, depth + 1);
}

function safe<T>(fn: () => T, dflt: T): T {
	try {
		return fn();
	} catch {
		return dflt;
	}
}

// ----- Name recovery -----

/** Folder of a path, with the trailing slash (`a/b/c.x` → `a/b/`). */
export function folderOf(path: string): string {
	return path.slice(0, path.lastIndexOf('/') + 1);
}

/**
 * Hash → path map, grown as names are proposed. Proposing a name that
 * hashes to a known file records it.
 */
export class TrinityNames {
	readonly known = new Map<bigint, string>();
	constructor(readonly fileHashes: ReadonlySet<bigint>) {}
	propose(path: string): boolean {
		const h = gfFnv64(path);
		if (!this.fileHashes.has(h)) return false;
		this.known.set(h, path);
		return true;
	}
	/** Propose `folder + name` for each name; returns how many matched. */
	proposeIn(folder: string, names: Iterable<string>): number {
		let n = 0;
		for (const name of names) if (this.propose(folder + name)) n++;
		return n;
	}
	get(hash: bigint): string | undefined {
		return this.known.get(hash);
	}
}
