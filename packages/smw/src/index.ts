/**
 * Super Mario World ROM graphics + palettes.
 *
 * SMW stores its tile graphics as 50 LC_LZ2-compressed "GFX files"
 * (GFX00-GFX31), located through three parallel single-byte pointer
 * tables in bank $00 — one each for the low, high, and bank byte of
 * a 24-bit SNES address:
 *
 *   low   $00B992   (PC 0x3992)
 *   high  $00B9C4   (PC 0x39C4)
 *   bank  $00B9F6   (PC 0x39F6)
 *
 * SMW is a LoROM cartridge, so a SNES address maps to a file offset
 * as `((bank & 0x7F) * 0x8000) + (addr & 0x7FFF)`.
 *
 * Decompressed GFX files hold raw SNES planar tiles. SMW mixes bit
 * depths, which is recoverable from the decompressed size: files
 * whose length is a multiple of 24 are 3bpp (24 bytes/tile), the
 * rest are 2bpp (16 bytes/tile). Verified against the US 1.0 ROM:
 *
 *   3072 bytes → 3bpp, 128 tiles   (43 files — sprites, BG, FG)
 *   1536 bytes → 3bpp,  64 tiles   (GFX30, GFX31 — cast portraits)
 *   2048 bytes → 2bpp, 128 tiles   (GFX28-GFX2B — layer 3 / status
 *                                   bar font, message boxes)
 *   1024 bytes → 2bpp,  64 tiles   (GFX2F)
 *
 * Palettes live in a large block of BGR555 colour entries at
 * $00B0A0 (PC 0x30A0). This module exposes it as a flat array of
 * 16-colour slots; SMW selects among them per level through
 * separate index tables, so the slots have no single fixed meaning.
 * {@link SMW_DEFAULT_SPRITE_PALETTE} is a slot that renders the
 * common sprite GFX correctly and makes a good default.
 *
 * Everything here is offset-verified against Super Mario World
 * (USA), the 512 KiB headerless dump. Copier-headered dumps (513
 * KiB) are handled by {@link stripCopierHeader}.
 */

import { decompressLz2, type Lz2Result } from '@tootallnate/lc-lz2';

/** Number of GFX files in an unmodified SMW ROM (GFX00-GFX31). */
export const SMW_GFX_COUNT = 0x32;

/** PC offset of the GFX pointer low-byte table (SNES $00B992). */
export const SMW_GFX_PTR_LOW = 0x3992;
/** PC offset of the GFX pointer high-byte table (SNES $00B9C4). */
export const SMW_GFX_PTR_HIGH = 0x39c4;
/** PC offset of the GFX pointer bank-byte table (SNES $00B9F6). */
export const SMW_GFX_PTR_BANK = 0x39f6;

/** PC offset of the BGR555 palette block (SNES $00B0A0). */
export const SMW_PALETTE_BLOCK = 0x30a0;
/** Number of 16-colour palette slots exposed from the block. */
export const SMW_PALETTE_COUNT = 60;
/**
 * Palette slot that renders the common sprite GFX (GFX00 etc.) in
 * their familiar colours — red mushroom, orange ? block, white
 * score text. SMW picks palettes per level at runtime, so this is a
 * sensible default rather than "the" palette.
 */
export const SMW_DEFAULT_SPRITE_PALETTE = 10;

/** Expected internal-header title of an unmodified SMW ROM. */
export const SMW_TITLE = 'SUPER MARIOWORLD';

/** Size of the copier header found on 513 KiB dumps. */
const COPIER_HEADER_SIZE = 512;

/** Internal (LoROM) header offset, relative to the ROM start. */
const HEADER_OFFSET = 0x7fc0;

/**
 * Drop a 512-byte copier header if present, so all offsets in this
 * module line up. Returns the input unchanged when there is none.
 */
export function stripCopierHeader(rom: Uint8Array): Uint8Array {
	if (rom.length % 1024 === COPIER_HEADER_SIZE) {
		return rom.subarray(COPIER_HEADER_SIZE);
	}
	return rom;
}

/** Read the 21-byte internal header title (copier header stripped). */
export function readTitle(rom: Uint8Array): string {
	const bytes = stripCopierHeader(rom);
	if (bytes.length < HEADER_OFFSET + 21) return '';
	let s = '';
	for (let i = 0; i < 21; i++) {
		const b = bytes[HEADER_OFFSET + i];
		s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
	}
	return s.trimEnd();
}

/**
 * Is this a Super Mario World ROM? Matches on the internal header
 * title, which Lunar Magic and most hacks preserve — so SMW hacks
 * are recognised too (their GFX tables stay in the same place,
 * though hacks may repoint individual entries, which is fine since
 * we follow the pointers rather than assume fixed data offsets).
 */
export function isSmw(rom: Uint8Array): boolean {
	const bytes = stripCopierHeader(rom);
	// Need at least the pointer tables and the header.
	if (bytes.length < 0x80000) return false;
	return readTitle(bytes).startsWith(SMW_TITLE);
}

/** LoROM SNES address → PC file offset. */
export function loromToPc(bank: number, addr: number): number {
	return ((bank & 0x7f) * 0x8000) + (addr & 0x7fff);
}

/** A GFX file entry located through the pointer tables. */
export interface SmwGfxEntry {
	/** GFX file number (0x00-0x31). */
	index: number;
	/** Conventional name, e.g. `GFX0A`. */
	name: string;
	/** 24-bit SNES address of the compressed data. */
	snesAddress: number;
	/** PC file offset of the compressed data. */
	romOffset: number;
}

/**
 * List the GFX files by reading the pointer tables. Does not
 * decompress — use {@link readSmwGfx} for that.
 */
export function listSmwGfx(rom: Uint8Array): SmwGfxEntry[] {
	const bytes = stripCopierHeader(rom);
	const out: SmwGfxEntry[] = [];
	for (let i = 0; i < SMW_GFX_COUNT; i++) {
		const lo = bytes[SMW_GFX_PTR_LOW + i];
		const hi = bytes[SMW_GFX_PTR_HIGH + i];
		const bank = bytes[SMW_GFX_PTR_BANK + i];
		const addr = (hi << 8) | lo;
		out.push({
			index: i,
			name: `GFX${i.toString(16).toUpperCase().padStart(2, '0')}`,
			snesAddress: (bank << 16) | addr,
			romOffset: loromToPc(bank, addr),
		});
	}
	return out;
}

/** Bit depth of a decompressed GFX file. */
export type SmwBpp = 2 | 3;

/**
 * Infer bit depth from a decompressed GFX file's size: multiples of
 * 24 are 3bpp, everything else is 2bpp. See the module doc comment
 * for the verification data behind this rule.
 */
export function bppForSize(size: number): SmwBpp {
	return size % 24 === 0 ? 3 : 2;
}

/** Bytes per 8x8 tile at a given bit depth. */
export function bytesPerTile(bpp: SmwBpp): number {
	return bpp === 3 ? 24 : 16;
}

/** A decompressed GFX file. */
export interface SmwGfxFile extends SmwGfxEntry {
	/** Decompressed tile data. */
	bytes: Uint8Array;
	/** Compressed size in the ROM, including the LC_LZ2 terminator. */
	compressedSize: number;
	/** Inferred bit depth. */
	bpp: SmwBpp;
	/** Number of 8x8 tiles. */
	tiles: number;
}

/**
 * Decompress a single GFX file by index (0x00-0x31).
 *
 * Throws if the index is out of range or the LC_LZ2 stream is
 * malformed (which, for a real SMW ROM, means the pointer tables
 * have been relocated by a hack).
 */
export function readSmwGfx(rom: Uint8Array, index: number): SmwGfxFile {
	if (index < 0 || index >= SMW_GFX_COUNT) {
		throw new RangeError(
			`SMW: GFX index ${index} out of range (0..${SMW_GFX_COUNT - 1})`,
		);
	}
	const bytes = stripCopierHeader(rom);
	const entry = listSmwGfx(bytes)[index];
	let result: Lz2Result;
	try {
		result = decompressLz2(bytes, entry.romOffset);
	} catch (err) {
		throw new Error(
			`SMW: ${entry.name} at 0x${entry.romOffset.toString(16)} is not valid LC_LZ2 data: ${
				(err as Error).message
			}`,
		);
	}
	const bpp = bppForSize(result.bytes.length);
	return {
		...entry,
		bytes: result.bytes,
		compressedSize: result.consumed,
		bpp,
		tiles: Math.floor(result.bytes.length / bytesPerTile(bpp)),
	};
}

/**
 * Decompress every GFX file. Entries that fail to decompress are
 * skipped rather than aborting the whole listing, so partially
 * repointed hacks still yield their intact files.
 */
export function readAllSmwGfx(rom: Uint8Array): SmwGfxFile[] {
	const bytes = stripCopierHeader(rom);
	const out: SmwGfxFile[] = [];
	for (let i = 0; i < SMW_GFX_COUNT; i++) {
		try {
			out.push(readSmwGfx(bytes, i));
		} catch {
			// Skip unreadable entries.
		}
	}
	return out;
}

/** An RGB triple, 0-255 per channel. */
export type Rgb = [number, number, number];

/**
 * Read one 16-colour palette slot from the palette block.
 *
 * SNES colours are BGR555 stored little-endian: `0bbbbbgg gggrrrrr`.
 * Each 5-bit channel is expanded to 8 bits by bit replication.
 */
export function readSmwPalette(rom: Uint8Array, slot: number): Rgb[] {
	const bytes = stripCopierHeader(rom);
	const base = SMW_PALETTE_BLOCK + slot * 32;
	const out: Rgb[] = [];
	for (let i = 0; i < 16; i++) {
		const o = base + i * 2;
		const v = (bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8);
		const r = v & 31;
		const g = (v >> 5) & 31;
		const b = (v >> 10) & 31;
		out.push([(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)]);
	}
	return out;
}

/** Read all exposed palette slots. */
export function readSmwPalettes(rom: Uint8Array): Rgb[][] {
	const out: Rgb[][] = [];
	for (let i = 0; i < SMW_PALETTE_COUNT; i++) {
		out.push(readSmwPalette(rom, i));
	}
	return out;
}
