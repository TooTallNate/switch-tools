/**
 * GBA ROM header parser + BIOS decompression formats.
 *
 * Game Boy Advance cartridges start with a 192-byte header at offset 0:
 *
 *   0x00..0x03 = ROM entry point (ARM branch instruction, u32 LE)
 *   0x04..0x9F = Nintendo logo (156-byte fixed compressed bitmap; the
 *                BIOS refuses to boot the cart unless it matches)
 *   0xA0..0xAB = game title (12 bytes ASCII, zero-padded)
 *   0xAC..0xAF = game code (4 ASCII, e.g. "AXVE"):
 *                  char 0 = type (A/B/C=game, F=Classic NES, K=accelerometer,
 *                           P=e-Reader, R=rumble+gyro, U=RTC, V=rumble)
 *                  chars 1-2 = short title
 *                  char 3 = language/region (J=Japan, E=USA, P=Europe,
 *                           D=Germany, F=France, I=Italy, S=Spain)
 *   0xB0..0xB1 = maker code (2 ASCII, "01" = Nintendo)
 *   0xB2       = fixed value, must be 0x96
 *   0xB3       = main unit code (0x00 for GBA)
 *   0xB4       = device type (bit7 = DACS/debug)
 *   0xB5..0xBB = reserved
 *   0xBC       = software version
 *   0xBD       = header checksum:
 *                  chk = 0
 *                  for (i = 0xA0; i <= 0xBC; i++) chk -= byte[i]
 *                  chk = (chk - 0x19) & 0xFF
 *   0xBE..0xBF = reserved
 *
 * Also implemented here are the GBA BIOS decompression formats used by
 * `LZ77UnCompWram`/`RLUnComp`/`HuffUnComp` (SWI 0x11/0x14/0x13). All
 * share a 4-byte header: byte 0 is a type identifier, bytes 1..3 are
 * the decompressed size as a little-endian 24-bit integer.
 *
 *   LZ77 (type 0x10):
 *     Stream of groups: 1 flag byte, bits consumed MSB-first.
 *       • bit = 0 → copy 1 literal byte.
 *       • bit = 1 → back-reference: read 2 bytes (b1, b2):
 *           length = ((b1 >> 4) & 0xF) + 3        (3..18)
 *           disp   = (((b1 & 0xF) << 8) | b2) + 1 (1..0x1000)
 *           Copy `length` bytes from output[outPos - disp], byte by
 *           byte (overlapping copies are intentional).
 *     Stop when the output is full.
 *
 *   RLE (type 0x30):
 *     Stream of: 1 flag byte.
 *       • bit7 = 1 → run: length = (flag & 0x7F) + 3, then 1 byte to
 *         repeat `length` times.
 *       • bit7 = 0 → literals: length = (flag & 0x7F) + 1 raw bytes.
 *     Stop when the output is full.
 *
 *   Huffman (type 0x24 = 4-bit symbols, 0x28 = 8-bit symbols):
 *     After the 4-byte header: 1 byte `treeSize` → the tree data
 *     occupies (treeSize + 1) * 2 - 1 bytes starting at the next byte
 *     (the root node). For a non-leaf node at address `a` (relative to
 *     the start of the compressed data) with value `v`, the children
 *     pair starts at (a & ~1) + ((v & 0x3F) + 1) * 2; left child at +0,
 *     right at +1. In the node value, bit7 = the left child is a data
 *     (leaf) node, bit6 = the right child is data. After the tree comes
 *     the bitstream: consecutive u32 little-endian words, bits consumed
 *     MSB-first within each word. Walk the tree per bit (0 = left,
 *     1 = right); on reaching a leaf emit the symbol (4-bit symbols
 *     pack low-nibble-first into output bytes). Stop when the output is
 *     full.
 *
 * All decompressors are strict: any read past the end of the input,
 * write past the end of the declared output size, or back-reference
 * displacement reaching before the start of the output throws a
 * `RangeError`. This strictness is what makes the heuristic
 * {@link scanGbaCompression} scanner reliable.
 *
 * References:
 *   - https://problemkaputt.de/gbatek.htm#gbacartridgeheader
 *   - https://problemkaputt.de/gbatek.htm#biosdecompressionfunctions
 */

const HEADER_SIZE = 0xc0;

/**
 * First 16 bytes of the fixed 156-byte Nintendo logo bitmap. Comparing
 * just these 16 bytes is sufficient for detection purposes (checking
 * all 156 would require embedding the full constant for no additional
 * discriminating power).
 */
const NINTENDO_LOGO_PREFIX = new Uint8Array([
	0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21, 0x3d, 0x84, 0x82, 0x0a,
	0x84, 0xe4, 0x09, 0xad,
]);

/** Map from game-code last character to a human-readable region. */
const REGIONS: Record<string, string> = {
	J: 'Japan',
	E: 'USA',
	P: 'Europe',
	D: 'Germany',
	F: 'France',
	I: 'Italy',
	S: 'Spain',
};

export interface GbaRomInfo {
	/** ROM entry point (raw ARM branch instruction, u32 LE at 0x00). */
	entryPoint: number;
	title: string;
	gameCode: string;
	makerCode: string;
	/** Derived from the game code's last character, when known. */
	region?: string;
	version: number;
	/** Byte 0xB2 === 0x96. */
	fixedValueValid: boolean;
	logoValid: boolean;
	headerChecksumValid: boolean;
	deviceType: number;
	mainUnitCode: number;
}

/** Decode zero-padded ASCII bytes into a string. */
function ascii(bytes: Uint8Array): string {
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) end--;
	let s = '';
	for (let i = 0; i < end; i++) {
		s += String.fromCharCode(bytes[i]);
	}
	return s;
}

/**
 * Parse a GBA cartridge header from the first 192 bytes of `bytes`.
 * Throws if `bytes` is too small to contain a full header.
 */
export function parseGbaHeader(bytes: Uint8Array): GbaRomInfo {
	if (bytes.length < HEADER_SIZE) {
		throw new Error(
			`Too small to be a GBA ROM (${bytes.length} bytes, need ${HEADER_SIZE})`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let logoValid = true;
	for (let i = 0; i < NINTENDO_LOGO_PREFIX.length; i++) {
		if (bytes[0x04 + i] !== NINTENDO_LOGO_PREFIX[i]) {
			logoValid = false;
			break;
		}
	}

	let chk = 0;
	for (let i = 0xa0; i <= 0xbc; i++) {
		chk -= bytes[i];
	}
	chk = (chk - 0x19) & 0xff;

	const gameCode = ascii(bytes.subarray(0xac, 0xb0));
	const region: string | undefined = REGIONS[gameCode.charAt(3)];

	const info: GbaRomInfo = {
		entryPoint: view.getUint32(0x00, true),
		title: ascii(bytes.subarray(0xa0, 0xac)),
		gameCode,
		makerCode: ascii(bytes.subarray(0xb0, 0xb2)),
		version: bytes[0xbc],
		fixedValueValid: bytes[0xb2] === 0x96,
		logoValid,
		headerChecksumValid: chk === bytes[0xbd],
		deviceType: bytes[0xb4],
		mainUnitCode: bytes[0xb3],
	};
	if (region !== undefined) {
		info.region = region;
	}
	return info;
}

/**
 * Cheap check for a GBA ROM: the blob must be at least header-sized,
 * have the fixed 0x96 byte, and have a valid logo or header checksum.
 */
export async function isGba(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_SIZE) return false;
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	const info = parseGbaHeader(head);
	return (
		info.fixedValueValid && (info.logoValid || info.headerChecksumValid)
	);
}

/** Parse the GBA cartridge header from a `Blob`. */
export async function parseGba(blob: Blob): Promise<GbaRomInfo> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a GBA ROM (${blob.size} bytes, need ${HEADER_SIZE})`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	return parseGbaHeader(head);
}

export type GbaCompressionType = 'lz77' | 'rle' | 'huffman';

interface DecompressResult {
	data: Uint8Array;
	/** Total input bytes consumed, starting at (and including) the header. */
	consumed: number;
}

/** Read the shared 4-byte BIOS header; returns the 24-bit LE size. */
function readBiosHeader(
	bytes: Uint8Array,
	offset: number,
	expectedType: string,
	typeOk: (b: number) => boolean,
): number {
	if (offset < 0 || offset + 4 > bytes.length) {
		throw new RangeError(
			`Input too small for ${expectedType} header at offset ${offset}`,
		);
	}
	if (!typeOk(bytes[offset])) {
		throw new RangeError(
			`Not a ${expectedType} stream (type byte 0x${bytes[offset].toString(16)} at offset ${offset})`,
		);
	}
	return bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16);
}

function lz77Decompress(bytes: Uint8Array, offset: number): DecompressResult {
	const size = readBiosHeader(bytes, offset, 'LZ77', (b) => b === 0x10);
	const out = new Uint8Array(size);
	let inPos = offset + 4;
	let outPos = 0;
	while (outPos < size) {
		if (inPos >= bytes.length) {
			throw new RangeError('Truncated LZ77 stream (missing flag byte)');
		}
		const flags = bytes[inPos++];
		for (let bit = 7; bit >= 0 && outPos < size; bit--) {
			if ((flags >> bit) & 1) {
				// Back-reference.
				if (inPos + 2 > bytes.length) {
					throw new RangeError('Truncated LZ77 back-reference');
				}
				const b1 = bytes[inPos++];
				const b2 = bytes[inPos++];
				const length = ((b1 >> 4) & 0xf) + 3;
				const disp = (((b1 & 0xf) << 8) | b2) + 1;
				const src = outPos - disp;
				if (src < 0) {
					throw new RangeError(
						`LZ77 back-reference points before start of output (outPos=${outPos}, disp=${disp})`,
					);
				}
				if (outPos + length > size) {
					throw new RangeError(
						`LZ77 back-reference writes past end of output (outPos=${outPos}, length=${length}, size=${size})`,
					);
				}
				// Byte-by-byte to allow overlapping (RLE-style) copies.
				for (let i = 0; i < length; i++) {
					out[outPos++] = out[src + i];
				}
			} else {
				// Literal byte.
				if (inPos >= bytes.length) {
					throw new RangeError('Truncated LZ77 literal');
				}
				out[outPos++] = bytes[inPos++];
			}
		}
	}
	return { data: out, consumed: inPos - offset };
}

function rleDecompress(bytes: Uint8Array, offset: number): DecompressResult {
	const size = readBiosHeader(bytes, offset, 'RLE', (b) => b === 0x30);
	const out = new Uint8Array(size);
	let inPos = offset + 4;
	let outPos = 0;
	while (outPos < size) {
		if (inPos >= bytes.length) {
			throw new RangeError('Truncated RLE stream (missing flag byte)');
		}
		const flag = bytes[inPos++];
		if (flag & 0x80) {
			// Run: 1 byte repeated.
			const length = (flag & 0x7f) + 3;
			if (inPos >= bytes.length) {
				throw new RangeError('Truncated RLE run');
			}
			if (outPos + length > size) {
				throw new RangeError(
					`RLE run writes past end of output (outPos=${outPos}, length=${length}, size=${size})`,
				);
			}
			const b = bytes[inPos++];
			for (let i = 0; i < length; i++) {
				out[outPos++] = b;
			}
		} else {
			// Literals: raw bytes follow.
			const length = (flag & 0x7f) + 1;
			if (inPos + length > bytes.length) {
				throw new RangeError('Truncated RLE literal run');
			}
			if (outPos + length > size) {
				throw new RangeError(
					`RLE literals write past end of output (outPos=${outPos}, length=${length}, size=${size})`,
				);
			}
			for (let i = 0; i < length; i++) {
				out[outPos++] = bytes[inPos++];
			}
		}
	}
	return { data: out, consumed: inPos - offset };
}

function huffmanDecompress(bytes: Uint8Array, offset: number): DecompressResult {
	const size = readBiosHeader(
		bytes,
		offset,
		'Huffman',
		(b) => b === 0x24 || b === 0x28,
	);
	const symbolBits = bytes[offset] & 0xf; // 4 or 8
	if (offset + 5 > bytes.length) {
		throw new RangeError('Truncated Huffman stream (missing tree size)');
	}
	const treeSize = bytes[offset + 4];
	// Tree data occupies (treeSize + 1) * 2 - 1 bytes starting at the
	// root node (offset + 5); the bitstream follows immediately after.
	const bitstreamRel = 4 + (treeSize + 1) * 2;
	if (offset + bitstreamRel > bytes.length) {
		throw new RangeError('Truncated Huffman tree');
	}

	const out = new Uint8Array(size);
	let outPos = 0;
	let inPos = offset + bitstreamRel;
	let word = 0;
	let bitsLeft = 0;
	// Node addresses are relative to `offset` (which stands in for the
	// word-aligned source address the BIOS operates on).
	const rootRel = 5;
	let nodeRel = rootRel;
	// 4-bit symbol packing state (low nibble first).
	let havePendingNibble = false;
	let pendingNibble = 0;

	while (outPos < size) {
		if (bitsLeft === 0) {
			if (inPos + 4 > bytes.length) {
				throw new RangeError('Truncated Huffman bitstream');
			}
			word =
				(bytes[inPos] |
					(bytes[inPos + 1] << 8) |
					(bytes[inPos + 2] << 16) |
					(bytes[inPos + 3] << 24)) >>>
				0;
			inPos += 4;
			bitsLeft = 32;
		}
		const bit = word >>> 31;
		word = (word << 1) >>> 0;
		bitsLeft--;

		const v = bytes[offset + nodeRel];
		const childBase = (nodeRel & ~1) + ((v & 0x3f) + 1) * 2;
		const childRel = childBase + bit;
		// Children must live inside the declared tree region.
		if (childBase + 1 >= bitstreamRel) {
			throw new RangeError(
				`Huffman node children outside tree region (node=${nodeRel}, children=${childBase})`,
			);
		}
		const childIsLeaf =
			bit === 0 ? (v & 0x80) !== 0 : (v & 0x40) !== 0;
		if (childIsLeaf) {
			const symbol = bytes[offset + childRel];
			if (symbolBits === 4) {
				if (havePendingNibble) {
					out[outPos++] = pendingNibble | ((symbol & 0xf) << 4);
					havePendingNibble = false;
				} else {
					pendingNibble = symbol & 0xf;
					havePendingNibble = true;
				}
			} else {
				out[outPos++] = symbol;
			}
			nodeRel = rootRel;
		} else {
			nodeRel = childRel;
		}
	}
	return { data: out, consumed: inPos - offset };
}

/**
 * Decompress a GBA BIOS LZ77 (type 0x10) stream starting at `offset`.
 * Throws a `RangeError` on malformed or truncated input.
 */
export function decompressLz77(bytes: Uint8Array, offset = 0): Uint8Array {
	return lz77Decompress(bytes, offset).data;
}

/**
 * Decompress a GBA BIOS RLE (type 0x30) stream starting at `offset`.
 * Throws a `RangeError` on malformed or truncated input.
 */
export function decompressRle(bytes: Uint8Array, offset = 0): Uint8Array {
	return rleDecompress(bytes, offset).data;
}

/**
 * Decompress a GBA BIOS Huffman (type 0x24 = 4-bit symbols, 0x28 =
 * 8-bit symbols) stream starting at `offset`. Throws a `RangeError` on
 * malformed or truncated input.
 */
export function decompressHuffman(bytes: Uint8Array, offset = 0): Uint8Array {
	return huffmanDecompress(bytes, offset).data;
}

/**
 * Decompress a GBA BIOS-compressed stream starting at `offset`,
 * dispatching on the type byte. Throws on unknown type bytes.
 */
export function decompressGba(bytes: Uint8Array, offset = 0): Uint8Array {
	if (offset < 0 || offset >= bytes.length) {
		throw new RangeError(`Offset ${offset} out of range`);
	}
	switch (bytes[offset]) {
		case 0x10:
			return decompressLz77(bytes, offset);
		case 0x30:
			return decompressRle(bytes, offset);
		case 0x24:
		case 0x28:
			return decompressHuffman(bytes, offset);
		default:
			throw new RangeError(
				`Unknown GBA compression type byte 0x${bytes[offset].toString(16)} at offset ${offset}`,
			);
	}
}

export interface GbaCompressedBlock {
	offset: number;
	type: GbaCompressionType;
	decompressedSize: number;
	/** Bytes consumed from `offset` (header included). */
	compressedSize: number;
}

export interface ScanGbaOptions {
	/** Only consider offsets aligned to this. Default: 4. */
	alignment?: number;
	/** Reject candidates whose declared size is below this. Default: 64. */
	minDecompressedSize?: number;
	/** Reject candidates whose declared size is above this. Default: 0x200000. */
	maxDecompressedSize?: number;
	/** Which formats to look for. Default: ['lz77']. */
	types?: GbaCompressionType[];
}

function typeForByte(b: number): GbaCompressionType | undefined {
	switch (b) {
		case 0x10:
			return 'lz77';
		case 0x30:
			return 'rle';
		case 0x24:
		case 0x28:
			return 'huffman';
		default:
			return undefined;
	}
}

const DECOMPRESSORS: Record<
	GbaCompressionType,
	(bytes: Uint8Array, offset: number) => DecompressResult
> = {
	lz77: lz77Decompress,
	rle: rleDecompress,
	huffman: huffmanDecompress,
};

/**
 * Heuristically scan `bytes` for embedded GBA BIOS-compressed blocks.
 *
 * Every `alignment`-aligned offset whose type byte matches one of the
 * requested formats and whose 24-bit declared size falls within
 * [minDecompressedSize, maxDecompressedSize] is attempted with a full
 * strict decompression. A candidate is accepted only when it
 * decompresses cleanly, actually compresses (compressedSize <
 * decompressedSize), and is non-trivial (compressedSize > 8). On
 * acceptance the scan position skips past the consumed bytes.
 */
export function scanGbaCompression(
	bytes: Uint8Array,
	opts: ScanGbaOptions = {},
): GbaCompressedBlock[] {
	const alignment = opts.alignment ?? 4;
	const minSize = opts.minDecompressedSize ?? 64;
	const maxSize = opts.maxDecompressedSize ?? 0x200000;
	const types = opts.types ?? ['lz77'];
	const results: GbaCompressedBlock[] = [];

	let pos = 0;
	while (pos + 4 <= bytes.length) {
		const type = typeForByte(bytes[pos]);
		if (type !== undefined && types.includes(type)) {
			const size =
				bytes[pos + 1] | (bytes[pos + 2] << 8) | (bytes[pos + 3] << 16);
			if (size >= minSize && size <= maxSize) {
				try {
					const { data, consumed } = DECOMPRESSORS[type](bytes, pos);
					if (consumed > 8 && consumed < data.length) {
						results.push({
							offset: pos,
							type,
							decompressedSize: data.length,
							compressedSize: consumed,
						});
						// Skip past the consumed bytes, aligned up.
						pos = Math.ceil((pos + consumed) / alignment) * alignment;
						continue;
					}
				} catch {
					// Not a valid block; keep scanning.
				}
			}
		}
		pos += alignment;
	}
	return results;
}
