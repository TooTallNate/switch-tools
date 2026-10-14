/**
 * FRAGMENT modules: Pokémon Stadium's relocatable overlays. Every
 * Pokémon and arena model is one (code and data together), linked at
 * a fixed virtual address, with its data pointers stored as absolute
 * addresses (e.g. `0x8FF11120` → module offset `0x11120`).
 *
 *   +0x08  "FRAGMENT"
 *   +0x14  u32 relocation-table start (end of the module image)
 *   +0x18  u32 file end
 *   +0x1C  u32 loaded-memory end
 *
 * The loader consumes the relocation table and zero-fills
 * relocStart…memEnd; some models point textures into that scratch
 * range, so {@link fragmentImage} rebuilds the loaded image.
 *
 * The module's entry code returns its root: Pokémon models build the
 * root-struct address with a `lui` / `addiu` pair in the first words
 * (see {@link findModelRoot}); arena modules return a geo-layout
 * pointer from `lui v1` at 0x3C and `addiu v0, v1` in the `jr` delay
 * slot at 0x44 (see {@link findStageRoot}). The link base is that
 * address rounded down to 1 MiB.
 *
 * Source: gen1recomp-mod-stadium2-importer `lib/fragment.lua` and
 * `lib/extract.lua` (Deftones565), building on pret/pokestadiumgs.
 */

export interface Fragment {
	/** The loaded module image (relocation table replaced by zeroed memory). */
	data: Uint8Array;
	/** Virtual address the module is linked at. */
	base: number;
}

const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

const FRAGMENT = [0x46, 0x52, 0x41, 0x47, 0x4d, 0x45, 0x4e, 0x54];

export function isFragment(bytes: Uint8Array): boolean {
	if (bytes.length < 0x80) return false;
	for (let i = 0; i < 8; i++) if (bytes[8 + i] !== FRAGMENT[i]) return false;
	return true;
}

/** The loaded memory image: the module up to its relocations, then zeroed BSS. */
export function fragmentImage(bytes: Uint8Array): Uint8Array {
	const relocStart = u32(bytes, 0x14), fileEnd = u32(bytes, 0x18), memEnd = u32(bytes, 0x1c);
	if (fileEnd !== bytes.length || relocStart > fileEnd || memEnd < relocStart || memEnd - relocStart > 16 << 20) return bytes;
	const out = new Uint8Array(memEnd);
	out.set(bytes.subarray(0, relocStart));
	return out;
}

/**
 * The model root-struct address: the first `lui rN` / `addiu rN, rN`
 * pair in the entry code (words 0x20–0x7C).
 */
export function findModelRoot(bytes: Uint8Array): number | null {
	for (let o = 0x20; o <= 0x7c && o + 8 <= bytes.length; o += 4) {
		const a = u32(bytes, o), b = u32(bytes, o + 4);
		if (a >>> 26 !== 0x0f) continue;
		const reg = (a >>> 16) & 0x1f;
		if (b >>> 26 === 0x09 && ((b >>> 21) & 0x1f) === reg && ((b >>> 16) & 0x1f) === reg) {
			return ((u16(bytes, o + 2) << 16) + s16(bytes, o + 6)) >>> 0;
		}
	}
	return null;
}

/** The arena geo-layout address (`lui v1` at 0x3C, `addiu v0, v1` at 0x44), or null. */
export function findStageRoot(bytes: Uint8Array): number | null {
	if (bytes.length < 0x50) return null;
	if (u16(bytes, 0x3c) !== 0x3c03 || u16(bytes, 0x44) !== 0x2462) return null;
	return ((u16(bytes, 0x3e) << 16) + s16(bytes, 0x46)) >>> 0;
}

/** Open a decompressed FRAGMENT whose link base is derived from `rootAddress`. */
export function openFragment(bytes: Uint8Array, rootAddress: number): Fragment {
	return { data: fragmentImage(bytes), base: (rootAddress & 0xfff00000) >>> 0 };
}
