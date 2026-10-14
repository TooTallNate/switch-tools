/**
 * Pokémon Stadium 2 asset archives and PERS-SZP compression.
 *
 * Most of the ROM past the code (`0x437610` in the US release) is a
 * hierarchy of archive tables, as defined by `cattbl.c` in
 * pret/pokestadium's old notes:
 *
 *   header (16 bytes):  u32 tag (0 or 0xEF), u32 0, u32 total size, u32 count
 *   record (16 bytes):  u32 offset (from the header), u32 size, u32 0, u32 0
 *
 * Offsets and sizes are 16-byte aligned and lie inside the table's total
 * size; empty records have size 0. Records are usually `PERS-SZP`
 * wrappers: the magic, a big-endian u32 header size at +8, then a Yay0
 * stream at that offset (pret/pokestadium `tools/decompress_persszp.py`).
 * Records can also be nested archives (the pose tables) or raw data.
 *
 * Facts and validation rules follow Deftones565's
 * gen1recomp-mod-stadium2-importer (`lib/rom.lua`, `DECOMP_NOTES.md`),
 * which audits them against the US ROM.
 */

import { decompressYay0Bytes } from '@tootallnate/yay0';

export interface StadiumArchiveRecord {
	index: number;
	/** Absolute offset of the record within the buffer the archive was read from. */
	start: number;
	/** Size in bytes (0 for an empty record). */
	size: number;
}

export interface StadiumArchive {
	offset: number;
	tag: number;
	total: number;
	records: StadiumArchiveRecord[];
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Parse the archive table at `offset`, or null when the bytes there
 * don't satisfy every invariant (tag, zero word, alignment, bounds).
 */
export function parseStadiumArchive(bytes: Uint8Array, offset = 0): StadiumArchive | null {
	if (offset < 0 || offset + 16 > bytes.length) return null;
	const tag = u32(bytes, offset);
	const total = u32(bytes, offset + 8);
	const count = u32(bytes, offset + 12);
	if ((tag !== 0 && tag !== 0xef) || u32(bytes, offset + 4) !== 0) return null;
	if (count <= 0 || count >= 4096) return null;
	const tableEnd = 16 + count * 16;
	if (total < tableEnd || total % 16 !== 0 || offset + total > bytes.length) return null;
	const records: StadiumArchiveRecord[] = [];
	for (let i = 0; i < count; i++) {
		const row = offset + 16 + i * 16;
		const rel = u32(bytes, row);
		const size = u32(bytes, row + 4);
		if (u32(bytes, row + 8) !== 0 || u32(bytes, row + 12) !== 0) return null;
		if (size !== 0) {
			if (rel < tableEnd || rel % 16 !== 0 || size % 16 !== 0 || rel + size > total) return null;
		}
		records.push({ index: i, start: offset + rel, size });
	}
	return { offset, tag, total, records };
}

const PERS_SZP = [0x50, 0x45, 0x52, 0x53, 0x2d, 0x53, 0x5a, 0x50]; // "PERS-SZP"

/** Does a PERS-SZP wrapper start at `offset`? */
export function isPersSzp(bytes: Uint8Array, offset = 0): boolean {
	if (offset + 12 > bytes.length) return false;
	for (let i = 0; i < 8; i++) if (bytes[offset + i] !== PERS_SZP[i]) return false;
	return true;
}

const isYay0 = (b: Uint8Array, o: number) => b[o] === 0x59 && b[o + 1] === 0x61 && b[o + 2] === 0x79 && b[o + 3] === 0x30;

/**
 * Decode an asset record: PERS-SZP and bare Yay0 are decompressed,
 * anything else is returned as-is (a view, not a copy).
 */
export function decodeStadiumAsset(bytes: Uint8Array): Uint8Array {
	if (isPersSzp(bytes)) return decompressYay0Bytes(bytes, u32(bytes, 8));
	if (bytes.length >= 16 && isYay0(bytes, 0)) return decompressYay0Bytes(bytes, 0);
	return bytes;
}

/** The bytes of `record` within `bytes` (a view). */
export function stadiumRecordBytes(bytes: Uint8Array, record: StadiumArchiveRecord): Uint8Array {
	return bytes.subarray(record.start, record.start + record.size);
}
