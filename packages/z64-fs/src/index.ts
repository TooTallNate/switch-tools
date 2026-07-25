/**
 * Zelda 64 "dmadata" filesystem parser.
 *
 * Nintendo 64 Zelda titles (Ocarina of Time / Majora's Mask) embed a
 * simple file table — known as "dmadata" — that maps a *virtual* ROM
 * address space ("vrom") onto physical ROM offsets. The game's DMA
 * manager uses this table to locate and (when needed) decompress files
 * at runtime.
 *
 * Wire layout: the table is an array of 16-byte entries, each made up
 * of four u32 big-endian fields:
 *
 *   bytes  0..3  = vromStart
 *   bytes  4..7  = vromEnd
 *   bytes  8..11 = physStart
 *   bytes 12..15 = physEnd
 *
 * Entry semantics:
 *
 *   • Virtual (decompressed) size = vromEnd - vromStart.
 *   • physEnd == 0 → file is UNCOMPRESSED: stored at ROM offset
 *     `physStart` with length `vromEnd - vromStart`.
 *   • physEnd != 0 (and physStart != 0xFFFFFFFF) → file is
 *     Yaz0-COMPRESSED: stored at ROM offsets [physStart, physEnd).
 *   • physStart == 0xFFFFFFFF (and physEnd == 0xFFFFFFFF) → file exists
 *     in the vrom map but is NOT present in this ROM (deleted/unused).
 *   • The table terminates at an all-zero entry.
 *
 * The first entry is always "makerom" — the ROM header + boot chunk —
 * with the fixed values vromStart=0, vromEnd=0x1060, physStart=0,
 * physEnd=0. That fixed shape doubles as a signature we can scan for
 * to locate the table inside an arbitrary ROM image (its offset varies
 * across game versions).
 *
 * References:
 *   - https://wiki.cloudmodding.com/oot/Filesystem
 *   - zeldaret/oot `dmadata` spec segment
 */

import { decompressYaz0 } from '@tootallnate/yaz0';

/** Size of a single dmadata entry, in bytes. */
const ENTRY_SIZE = 16;

/** Sentinel `physStart`/`physEnd` value for deleted entries. */
const DELETED = 0xffffffff;

/** `vromEnd` of the fixed first ("makerom") entry. */
const MAKEROM_VROM_END = 0x1060;

/** Sanity cap on table size when validating a candidate table. */
const MAX_ENTRIES = 8192;

/** Minimum entry count for a candidate table to be considered valid. */
const MIN_ENTRIES = 3;

export interface DmaEntry {
	/** Position of this entry within the dmadata table. */
	index: number;
	vromStart: number;
	vromEnd: number;
	physStart: number;
	physEnd: number;
	/** Virtual (decompressed) size: `vromEnd - vromStart`. */
	size: number;
	/** `true` when the file payload is Yaz0-compressed in the ROM. */
	compressed: boolean;
	/** `true` when the file is not present in this ROM. */
	deleted: boolean;
	/** Physical ROM offset of the payload (meaningless when deleted). */
	romStart: number;
	/**
	 * Physical ROM end offset of the payload: `physStart + size` for
	 * uncompressed files, `physEnd` for compressed ones (meaningless
	 * when deleted).
	 */
	romEnd: number;
	/** Human-friendly name — see {@link dmaFileName}. */
	name: string;
}

export interface Z64Fs {
	/** Byte offset of the dmadata table within the ROM. */
	dmadataOffset: number;
	entries: DmaEntry[];
}

/**
 * Well-known file names for the first few dmadata indices. These are
 * stable across all Zelda 64 versions. Real per-version filename
 * tables (from the zeldaret decompilation projects) are a future
 * enhancement; everything past index 5 gets a generated name.
 */
const KNOWN_NAMES: readonly string[] = [
	'makerom',
	'boot',
	'dmadata',
	'Audiobank',
	'Audioseq',
	'Audiotable',
];

/**
 * Produce a display name for a dmadata entry. Well-known indices get
 * their real names; everything else gets `file_NNNN_0xXXXXXXXX` where
 * `NNNN` is the zero-padded decimal index and `XXXXXXXX` is the
 * upper-case hex `vromStart`.
 */
export function dmaFileName(
	index: number,
	entry: { vromStart: number },
): string {
	const known = KNOWN_NAMES[index];
	if (known) return known;
	const idx = String(index).padStart(4, '0');
	const vrom = entry.vromStart.toString(16).toUpperCase().padStart(8, '0');
	return `file_${idx}_0x${vrom}`;
}

/** Read a big-endian u32 at `offset` (caller guarantees bounds). */
function u32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] << 24) |
			(bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) |
			bytes[offset + 3]) >>>
		0
	);
}

/**
 * Walk a candidate dmadata table at `offset` and decide whether it is
 * plausible. Requirements:
 *
 *   • terminates with an all-zero entry before the end of `bytes`,
 *   • at least {@link MIN_ENTRIES} and fewer than {@link MAX_ENTRIES}
 *     entries,
 *   • every non-deleted entry has `vromEnd >= vromStart`,
 *   • `vromStart` values strictly increase across entries.
 */
function validateTable(bytes: Uint8Array, offset: number): boolean {
	let count = 0;
	let prevVromStart = -1;
	for (let pos = offset; pos + ENTRY_SIZE <= bytes.length; pos += ENTRY_SIZE) {
		const vromStart = u32(bytes, pos);
		const vromEnd = u32(bytes, pos + 4);
		const physStart = u32(bytes, pos + 8);
		const physEnd = u32(bytes, pos + 12);
		if (vromStart === 0 && vromEnd === 0 && physStart === 0 && physEnd === 0) {
			// Zero terminator.
			return count >= MIN_ENTRIES && count < MAX_ENTRIES;
		}
		if (count >= MAX_ENTRIES) return false;
		if (vromStart <= prevVromStart) return false;
		if (physStart !== DELETED && vromEnd < vromStart) return false;
		prevVromStart = vromStart;
		count++;
	}
	// Ran off the end of the ROM without hitting a terminator.
	return false;
}

/**
 * Scan `bytes` (a full ROM image) for the dmadata table.
 *
 * The scan looks — at 16-byte alignment — for the fixed "makerom"
 * signature `[0x00000000, 0x00001060, 0x00000000, 0x00000000]`
 * immediately followed by an entry whose `vromStart === 0x1060`, then
 * validates the candidate by walking it to its zero terminator.
 *
 * Returns the byte offset of the first (makerom) entry, or `null` if
 * no valid table was found.
 */
export function findDmadata(bytes: Uint8Array): number | null {
	// Need at least makerom + next entry's vromStart to match the
	// signature at a given offset.
	const limit = bytes.length - (ENTRY_SIZE + 4);
	for (let pos = 0; pos <= limit; pos += ENTRY_SIZE) {
		if (
			u32(bytes, pos) === 0 &&
			u32(bytes, pos + 4) === MAKEROM_VROM_END &&
			u32(bytes, pos + 8) === 0 &&
			u32(bytes, pos + 12) === 0 &&
			u32(bytes, pos + ENTRY_SIZE) === MAKEROM_VROM_END &&
			validateTable(bytes, pos)
		) {
			return pos;
		}
	}
	return null;
}

/**
 * Parse the dmadata table at `offset` into an array of
 * {@link DmaEntry} records. Parsing stops at the all-zero terminator
 * entry (or the end of `bytes`, whichever comes first).
 */
export function parseDmadata(bytes: Uint8Array, offset: number): DmaEntry[] {
	const entries: DmaEntry[] = [];
	for (let pos = offset; pos + ENTRY_SIZE <= bytes.length; pos += ENTRY_SIZE) {
		const vromStart = u32(bytes, pos);
		const vromEnd = u32(bytes, pos + 4);
		const physStart = u32(bytes, pos + 8);
		const physEnd = u32(bytes, pos + 12);
		if (vromStart === 0 && vromEnd === 0 && physStart === 0 && physEnd === 0) {
			break; // zero terminator
		}
		const index = entries.length;
		const size = vromEnd - vromStart;
		const deleted = physStart === DELETED;
		const compressed = !deleted && physEnd !== 0;
		entries.push({
			index,
			vromStart,
			vromEnd,
			physStart,
			physEnd,
			size,
			compressed,
			deleted,
			romStart: physStart,
			romEnd: compressed ? physEnd : physStart + size,
			name: dmaFileName(index, { vromStart }),
		});
	}
	return entries;
}

/**
 * Convenience wrapper: locate the dmadata table in a ROM image and
 * parse it. Returns `null` when no table can be found.
 */
export function parseZ64Fs(bytes: Uint8Array): Z64Fs | null {
	const dmadataOffset = findDmadata(bytes);
	if (dmadataOffset === null) return null;
	return {
		dmadataOffset,
		entries: parseDmadata(bytes, dmadataOffset),
	};
}

/**
 * Extract a single file from a ROM `Blob` given its dmadata entry.
 *
 * Uncompressed files are sliced straight out of the ROM; compressed
 * files are Yaz0-decompressed. Throws for deleted entries and when the
 * extracted payload size does not match the entry's virtual size.
 */
export async function extractDmaFile(
	rom: Blob,
	entry: DmaEntry,
): Promise<Blob> {
	if (entry.deleted) {
		throw new Error(
			`Cannot extract "${entry.name}" (index ${entry.index}): file is not present in this ROM (deleted entry)`,
		);
	}
	if (entry.compressed) {
		const compressed = rom.slice(entry.physStart, entry.physEnd);
		const decompressed = await decompressYaz0(compressed);
		if (decompressed.size !== entry.size) {
			throw new Error(
				`Decompressed size mismatch for "${entry.name}" (index ${entry.index}): expected ${entry.size} bytes, got ${decompressed.size}`,
			);
		}
		return decompressed;
	}
	const file = rom.slice(entry.physStart, entry.physStart + entry.size);
	if (file.size !== entry.size) {
		throw new Error(
			`Truncated ROM: "${entry.name}" (index ${entry.index}) expected ${entry.size} bytes at 0x${entry.physStart.toString(16)}, got ${file.size}`,
		);
	}
	return file;
}
