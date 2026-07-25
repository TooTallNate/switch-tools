/**
 * Nintendo 64 ROM parser.
 *
 * N64 ROM dumps circulate in three byte orders, distinguished by the
 * first 4 bytes of the file (the PI BSD DOM1 configuration word,
 * 0x80371240 in the console's native big-endian order):
 *
 *   • z64 → 80 37 12 40  (big-endian, native)
 *   • v64 → 37 80 40 12  (16-bit byteswapped — Doctor V64 dumps)
 *   • n64 → 40 12 37 80  (32-bit little-endian)
 *
 * After normalizing to big-endian, the 0x40-byte ROM header is:
 *
 *   0x00  u32  PI BSD DOM1 config ("magic")
 *   0x04  u32  clock rate
 *   0x08  u32  boot address
 *   0x0C  u32  libultra version (byte 0x0E = version digits,
 *              byte 0x0F = ASCII revision letter, e.g. 0x0000144B → "2.0K")
 *   0x10  u32  CRC1 ("check code" word 1)
 *   0x14  u32  CRC2
 *   0x18  8    reserved
 *   0x20  20   image name (ASCII, space/NUL padded)
 *   0x3B  1    media format char ('N' cart, 'D' 64DD disk, 'C' cart +
 *              expandable, 'E' 64DD expansion, 'Z' Aleck64)
 *   0x3C  2    cartridge ID (ASCII)
 *   0x3E  1    region char
 *   0x3F  1    version byte
 *
 * Bytes 0x40..0xFFF hold the CIC bootcode; its CRC32 identifies which
 * CIC lockout chip the cart used, which in turn selects the seed for
 * the classic n64crc checksum algorithm (public domain, from
 * n64crc.c) that the IPL3 bootcode uses to verify CRC1/CRC2 over
 * bytes 0x1000..0x100FFF.
 *
 * This package also includes a scanner for compression blocks
 * (MIO0 / Yay0 / Yaz0 magics) embedded in the ROM image. It only
 * inspects magics and header sanity — it does not decode, so it has
 * no dependency on the decompressor packages.
 *
 * References:
 *   - https://n64brew.dev/wiki/ROM_Header
 *   - https://n64brew.dev/wiki/CIC-NUS
 *   - n64crc.c (public domain CRC recalculation tool)
 */

export type N64ByteOrder = 'z64' | 'v64' | 'n64';

const Z64_MAGIC = [0x80, 0x37, 0x12, 0x40];
const V64_MAGIC = [0x37, 0x80, 0x40, 0x12];
const N64_MAGIC = [0x40, 0x12, 0x37, 0x80];

function matches(bytes: Uint8Array, magic: number[]): boolean {
	return (
		bytes[0] === magic[0] &&
		bytes[1] === magic[1] &&
		bytes[2] === magic[2] &&
		bytes[3] === magic[3]
	);
}

/**
 * Detect the byte order of an N64 ROM dump from its first 4 bytes.
 * Returns `null` when the bytes don't match any known order.
 */
export function detectN64ByteOrder(bytes: Uint8Array): N64ByteOrder | null {
	if (bytes.length < 4) return null;
	if (matches(bytes, Z64_MAGIC)) return 'z64';
	if (matches(bytes, V64_MAGIC)) return 'v64';
	if (matches(bytes, N64_MAGIC)) return 'n64';
	return null;
}

/**
 * Return a big-endian (z64) copy of the given ROM image.
 *
 * • v64 input → every byte pair is swapped.
 * • n64 input → every 4-byte group is reversed.
 * • z64 input → **the same array is returned as-is** (no copy is
 *   made), since it is already in native order. Callers that intend
 *   to mutate the result should copy it themselves.
 *
 * Throws if the byte order cannot be detected.
 */
export function normalizeN64(bytes: Uint8Array): Uint8Array {
	const order = detectN64ByteOrder(bytes);
	if (order === null) {
		throw new Error('Unknown N64 ROM byte order (bad magic)');
	}
	if (order === 'z64') return bytes;
	const out = new Uint8Array(bytes.length);
	if (order === 'v64') {
		// Swap every byte pair.
		const pairs = bytes.length & ~1;
		for (let i = 0; i < pairs; i += 2) {
			out[i] = bytes[i + 1];
			out[i + 1] = bytes[i];
		}
		// Odd trailing byte (shouldn't happen in real dumps): copy as-is.
		if (bytes.length & 1) out[bytes.length - 1] = bytes[bytes.length - 1];
	} else {
		// n64: reverse every 4-byte group.
		const groups = bytes.length & ~3;
		for (let i = 0; i < groups; i += 4) {
			out[i] = bytes[i + 3];
			out[i + 1] = bytes[i + 2];
			out[i + 2] = bytes[i + 1];
			out[i + 3] = bytes[i];
		}
		// Trailing partial group: copy as-is.
		for (let i = groups; i < bytes.length; i++) out[i] = bytes[i];
	}
	return out;
}

const REGION_NAMES: Record<string, string> = {
	A: 'Asia (NTSC)',
	B: 'Brazil',
	C: 'China',
	D: 'Germany',
	E: 'North America',
	F: 'France',
	G: 'Gateway 64 (NTSC)',
	H: 'Netherlands',
	I: 'Italy',
	J: 'Japan',
	K: 'Korea',
	L: 'Gateway 64 (PAL)',
	N: 'Canada',
	P: 'Europe',
	S: 'Spain',
	U: 'Australia',
	W: 'Scandinavia',
	X: 'Europe',
	Y: 'Europe',
};

const MEDIA_FORMAT_NAMES: Record<string, string> = {
	N: 'Cartridge',
	D: '64DD Disk',
	C: 'Cartridge (64DD Expandable)',
	E: '64DD Expansion',
	Z: 'Aleck64 Cartridge',
};

/* -------------------------------------------------------------------------- */
/* CRC32 (standard zlib polynomial) — used for CIC bootcode identification.   */
/* -------------------------------------------------------------------------- */

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

/** Standard CRC-32 (zlib polynomial 0xEDB88320). */
export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = (CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
	}
	return (c ^ 0xffffffff) >>> 0;
}

const BOOTCODE_START = 0x40;
const BOOTCODE_END = 0x1000;

/** Known CIC bootcode CRC32s → CIC variant name. */
const CIC_BY_BOOTCODE_CRC: Record<number, string> = {
	0x6170a4a1: '6101',
	0x009e9ea3: '7102',
	0x90bb6cb5: '6102', // aka 7101; most common
	0x0b050ee0: '6103', // aka 7103
	0x98bc2c86: '6105', // aka 7105
	0xacc8580a: '6106', // aka 7106
	0x0e018159: '8303', // 64DD IPL
};

/**
 * Identify the CIC variant from the bootcode (bytes 0x40..0xFFF of a
 * normalized big-endian ROM). Returns `undefined` when the ROM is too
 * small or the bootcode CRC32 is not a known value.
 */
function detectCic(rom: Uint8Array): string | undefined {
	if (rom.length < BOOTCODE_END) return undefined;
	const crc = crc32(rom.subarray(BOOTCODE_START, BOOTCODE_END));
	return CIC_BY_BOOTCODE_CRC[crc];
}

/* -------------------------------------------------------------------------- */
/* CRC1/CRC2 — the classic n64crc algorithm (public domain, n64crc.c).        */
/* -------------------------------------------------------------------------- */

const CRC_SEEDS: Record<string, number> = {
	'6101': 0xf8ca4ddc,
	'6102': 0xf8ca4ddc,
	'7102': 0xf8ca4ddc,
	'6103': 0xa3886759,
	'6105': 0xdf26f436,
	'6106': 0x1fea617a,
};

const CRC_START = 0x1000;
const CRC_LENGTH = 0x100000;

function rol(x: number, n: number): number {
	if (n === 0) return x >>> 0;
	return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/**
 * Compute the CRC1/CRC2 "check code" words for a normalized
 * (big-endian) ROM image, per the IPL3 bootcode algorithm. Returns
 * `null` when the ROM is smaller than 0x101000 bytes (the checksum
 * covers bytes 0x1000..0x100FFF). An unknown/omitted `cic` falls back
 * to the 6102 seed and formula (the most common variant).
 */
export function computeN64Crc(
	bytes: Uint8Array,
	cic?: string,
): { crc1: number; crc2: number } | null {
	if (bytes.length < CRC_START + CRC_LENGTH) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const seed = (cic !== undefined && CRC_SEEDS[cic]) || CRC_SEEDS['6102'];

	let t1 = seed;
	let t2 = seed;
	let t3 = seed;
	let t4 = seed;
	let t5 = seed;
	let t6 = seed;

	for (let i = CRC_START; i < CRC_START + CRC_LENGTH; i += 4) {
		const d = view.getUint32(i, false);
		if (((t6 + d) >>> 0) < t6) t4 = (t4 + 1) >>> 0;
		t6 = (t6 + d) >>> 0;
		t3 = (t3 ^ d) >>> 0;
		const r = rol(d, d & 0x1f);
		t5 = (t5 + r) >>> 0;
		if (t2 > d) t2 = (t2 ^ r) >>> 0;
		else t2 = (t2 ^ t6 ^ d) >>> 0;
		if (cic === '6105') {
			const b = view.getUint32(BOOTCODE_START + 0x0710 + (i & 0xff), false);
			t1 = (t1 + ((b ^ d) >>> 0)) >>> 0;
		} else {
			t1 = (t1 + ((t5 ^ d) >>> 0)) >>> 0;
		}
	}

	let crc1: number;
	let crc2: number;
	if (cic === '6103') {
		crc1 = (((t6 ^ t4) >>> 0) + t3) >>> 0;
		crc2 = (((t5 ^ t2) >>> 0) + t1) >>> 0;
	} else if (cic === '6106') {
		crc1 = (Math.imul(t6, t2) + t3) >>> 0;
		crc2 = (Math.imul(t5, t1) + t2) >>> 0;
	} else {
		crc1 = (t6 ^ t4 ^ t3) >>> 0;
		crc2 = (t5 ^ t2 ^ t1) >>> 0;
	}
	return { crc1, crc2 };
}

/* -------------------------------------------------------------------------- */
/* Compression-block scanner.                                                 */
/* -------------------------------------------------------------------------- */

export interface N64CompressedBlockRef {
	/** Byte offset of the compression header within the scanned bytes. */
	offset: number;
	type: 'MIO0' | 'Yay0' | 'Yaz0';
	/** Decompressed size declared in the block header. */
	decompressedSize: number;
}

export interface ScanN64Options {
	/** Only consider offsets that are a multiple of this. Default: 4. */
	alignment?: number;
	/** Reject blocks declaring a larger decompressed size. Default: 8 MiB. */
	maxDecompressedSize?: number;
}

const BLOCK_HEADER_SIZE = 16;

/**
 * Scan a (normalized, big-endian) ROM image for embedded MIO0 / Yay0 /
 * Yaz0 compression blocks at aligned offsets.
 *
 * Only the 16-byte headers are sanity-checked — blocks are *not*
 * decoded, so the exact compressed length of each block is unknown
 * and false positives are possible (though rare with the header
 * checks applied). Scanning resumes immediately after each accepted
 * block's 16-byte header.
 */
export function scanN64Compression(
	bytes: Uint8Array,
	opts: ScanN64Options = {},
): N64CompressedBlockRef[] {
	const alignment = opts.alignment ?? 4;
	const maxDecompressedSize = opts.maxDecompressedSize ?? 0x800000;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const found: N64CompressedBlockRef[] = [];

	let i = 0;
	while (i + BLOCK_HEADER_SIZE <= bytes.length) {
		let type: N64CompressedBlockRef['type'] | null = null;
		const b0 = bytes[i];
		if (b0 === 0x4d /* M */) {
			if (
				bytes[i + 1] === 0x49 /* I */ &&
				bytes[i + 2] === 0x4f /* O */ &&
				bytes[i + 3] === 0x30 /* 0 */
			) {
				type = 'MIO0';
			}
		} else if (b0 === 0x59 /* Y */ && bytes[i + 1] === 0x61 /* a */) {
			if (bytes[i + 2] === 0x79 /* y */ && bytes[i + 3] === 0x30) {
				type = 'Yay0';
			} else if (bytes[i + 2] === 0x7a /* z */ && bytes[i + 3] === 0x30) {
				type = 'Yaz0';
			}
		}

		if (type !== null) {
			const decompressedSize = view.getUint32(i + 4, false);
			let ok = decompressedSize > 0 && decompressedSize <= maxDecompressedSize;
			if (ok && type !== 'Yaz0') {
				// MIO0/Yay0: the two stream offsets must land past the
				// header and within the remaining bytes. (Either ordering
				// of the two streams occurs in the wild — don't require
				// one before the other.)
				const o1 = view.getUint32(i + 8, false);
				const o2 = view.getUint32(i + 12, false);
				const remaining = bytes.length - i;
				ok =
					o1 > 0x10 && o2 > 0x10 && o1 < remaining && o2 < remaining;
			}
			if (ok) {
				found.push({ offset: i, type, decompressedSize });
				// Blocks can't overlap their own header — resume after it
				// (rounded up to the next aligned offset).
				const next = i + BLOCK_HEADER_SIZE;
				i = Math.ceil(next / alignment) * alignment;
				continue;
			}
		}
		i += alignment;
	}
	return found;
}

/* -------------------------------------------------------------------------- */
/* Top-level Blob API.                                                        */
/* -------------------------------------------------------------------------- */

export interface N64RomInfo {
	byteOrder: N64ByteOrder;
	/** Image name from the header, trailing space/NUL padding stripped. */
	name: string;
	/** Media + cartridge ID + region, e.g. "NSME". */
	gameCode: string;
	/** Decoded media format name, e.g. "Cartridge". */
	mediaFormat: string;
	/** 2-character cartridge ID, e.g. "SM". */
	cartId: string;
	/** Raw region character, e.g. 'E'. */
	region: string;
	/** Decoded region name, e.g. "North America". */
	regionName: string;
	/** Version byte (0x00 = 1.0, 0x01 = 1.1, …). */
	version: number;
	crc1: number;
	crc2: number;
	/** CIC variant detected from the bootcode CRC32, if known. */
	cic?: string;
	/**
	 * Whether the header CRC1/CRC2 match the recomputed checksum.
	 * `undefined` when the ROM is too small to compute (< 0x101000 bytes).
	 */
	crcValid?: boolean;
	clockRate: number;
	bootAddress: number;
	/** e.g. "2.0K" (from the libultra version word at 0x0C). */
	libultraVersion: string;
}

const HEADER_SIZE = 0x40;

/**
 * Cheap (4-byte) check: does this `Blob` start with a recognized N64
 * ROM byte-order magic?
 */
export async function isN64(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return detectN64ByteOrder(head) !== null;
}

/**
 * Parse an N64 ROM image. Reads the whole `Blob` up front (N64 ROMs
 * are at most 64 MB), normalizes it to big-endian, and parses the
 * header. The CRC1/CRC2 verification is only performed when the ROM
 * is large enough (≥ 0x101000 bytes); otherwise `crcValid` is
 * `undefined`.
 */
export async function parseN64(blob: Blob): Promise<N64RomInfo> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be an N64 ROM (${blob.size} bytes, need ${HEADER_SIZE})`,
		);
	}
	const raw = new Uint8Array(await blob.arrayBuffer());
	const byteOrder = detectN64ByteOrder(raw);
	if (byteOrder === null) {
		throw new Error('Not an N64 ROM (unrecognized byte-order magic)');
	}
	const rom = normalizeN64(raw);
	const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);

	const clockRate = view.getUint32(0x04, false);
	const bootAddress = view.getUint32(0x08, false);

	// libultra version word, e.g. 0x0000144B → "2.0K".
	const versionDigits = rom[0x0e];
	const revisionChar = rom[0x0f];
	let libultraVersion = `${Math.floor(versionDigits / 10)}.${versionDigits % 10}`;
	if (revisionChar >= 0x21 && revisionChar <= 0x7e) {
		libultraVersion += String.fromCharCode(revisionChar);
	}

	const crc1 = view.getUint32(0x10, false);
	const crc2 = view.getUint32(0x14, false);

	// Image name: 20 ASCII bytes, space/NUL padded.
	let name = '';
	for (let i = 0x20; i < 0x34; i++) {
		name += String.fromCharCode(rom[i]);
	}
	name = name.replace(/[\s\0]+$/, '');

	const mediaChar = String.fromCharCode(rom[0x3b]);
	const cartId = String.fromCharCode(rom[0x3c], rom[0x3d]);
	const region = String.fromCharCode(rom[0x3e]);
	const version = rom[0x3f];

	const cic = detectCic(rom);
	const computed = computeN64Crc(rom, cic);
	const crcValid = computed
		? computed.crc1 === crc1 && computed.crc2 === crc2
		: undefined;

	return {
		byteOrder,
		name,
		gameCode: mediaChar + cartId + region,
		mediaFormat: MEDIA_FORMAT_NAMES[mediaChar] ?? 'Unknown',
		cartId,
		region,
		regionName: REGION_NAMES[region] ?? 'Unknown',
		version,
		crc1,
		crc2,
		cic,
		crcValid,
		clockRate,
		bootAddress,
		libultraVersion,
	};
}
