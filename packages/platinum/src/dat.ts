/**
 * PlatinumGames DAT archive (`.dat`, `.dtt`, `.eff`, `.evn`, …): the
 * container every Platinum game since Bayonetta uses. A `.dat` usually
 * holds a model (`.wmb`), its texture headers (`.wta`), animations
 * (`.mot`) and data; the paired `.dtt` holds the texture pixels
 * (`.wtp`) so they can be streamed separately.
 *
 * Layout (little-endian), from Kerilk's `Bayonetta dat.bt`:
 *
 *   0x00 'DAT\0'
 *   0x04 u32 file count
 *   0x08 u32 offset of the u32 file offsets table
 *   0x0c u32 offset of the extensions table (4 bytes per file)
 *   0x10 u32 offset of the names table: u32 name length, then
 *            fixed-width NUL-padded names
 *   0x14 u32 offset of the u32 file sizes table
 *   0x18 u32 offset of the hash map (name lookup, optional)
 */

export interface DatEntry {
	index: number;
	name: string;
	offset: number;
	size: number;
}

export function isDat(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x44 && head[1] === 0x41 && head[2] === 0x54 && head[3] === 0x00;
}

/**
 * List a DAT's files. `bytes` must hold at least the header and
 * tables (the whole file is simplest); offsets are absolute. Throws
 * when the tables are out of bounds, so random `DAT\0` data is
 * rejected.
 */
export function parseDat(bytes: Uint8Array, fileSize = bytes.length): DatEntry[] {
	if (!isDat(bytes) || bytes.length < 0x1c) throw new Error('Not a DAT (missing "DAT\\0" magic)');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(4, true);
	const offT = dv.getUint32(8, true);
	const nameT = dv.getUint32(0x10, true);
	const sizeT = dv.getUint32(0x14, true);
	if (count === 0) return [];
	const fits = (o: number, n: number) => o >= 0x1c && o + n <= bytes.length;
	if (count > 200_000 || !fits(offT, count * 4) || !fits(sizeT, count * 4) || !fits(nameT, 4)) {
		throw new Error('DAT tables are out of bounds');
	}
	const nameLen = dv.getUint32(nameT, true);
	if (nameLen === 0 || nameLen > 256 || !fits(nameT + 4, count * nameLen)) throw new Error('DAT name table is out of bounds');
	const dec = new TextDecoder();
	const out: DatEntry[] = [];
	for (let i = 0; i < count; i++) {
		const nb = bytes.subarray(nameT + 4 + i * nameLen, nameT + 4 + (i + 1) * nameLen);
		const z = nb.indexOf(0);
		const name = dec.decode(z >= 0 ? nb.subarray(0, z) : nb);
		const offset = dv.getUint32(offT + i * 4, true);
		const size = dv.getUint32(sizeT + i * 4, true);
		if (offset + size > fileSize) throw new Error(`DAT entry ${name} is out of bounds`);
		out.push({ index: i, name, offset, size });
	}
	return out;
}
