/**
 * BEA — "Bezel Engine Archive". A flat, per-asset-compressed
 * container used by Nintendo's Bezel engine titles on Switch. Each
 * `.bea` bundles every resource for one actor: the model
 * (`.fmdb`, a BFRES), skeletal / material / visibility animations
 * (`.fskb` / `.fmab` / `.fvbb`, also BFRES), the texture bank
 * (`.bntx`), texture-pointer stubs (`.ftxb`), shader packs and so on.
 *
 * The container uses the NintendoWare "binary file" layout shared
 * with BFRES / BNTX — a 0x20-byte file header, self-relative block
 * chain, a `_DIC` name dictionary, a `_STR` string pool and a
 * `_RLT` relocation table — with magic `SCNE` instead of `FRES`.
 *
 * Wire layout (all little-endian, offsets absolute):
 *
 * ```
 * 0x00  char[4]  magic "SCNE"
 * 0x04  u32      padding
 * 0x08  u32      version  ((major << 16) | (minor << 8) | patch)
 * 0x0C  u16      BOM (0xFEFF)
 * 0x0E  u8       alignment exponent
 * 0x0F  u8       target address size
 * 0x10  u32      file-name offset
 * 0x14  u16      flags
 * 0x16  u16      first-block offset (low 16 bits)
 * 0x18  u32      relocation table (`_RLT`) offset
 * 0x1C  u32      metadata size (header + blocks + `_RLT`)
 * 0x20  u16      asset count
 * 0x28  u64      offset of the asset-pointer array (u64 × count)
 * 0x30  u64      offset of the `_DIC` dictionary
 * 0x38  u64      reserved
 * 0x40  u64      offset of the archive name (u16-length-prefixed)
 *
 * ASST block (0x30 bytes):
 * 0x00  char[4]  "ASST"
 * 0x04  u32      next-block offset
 * 0x08  u32      block size
 * 0x0C  u32      reserved
 * 0x10  u16      compression type (2 = zstd)
 * 0x12  u16      data alignment exponent
 * 0x14  u32      stored (compressed) size
 * 0x18  u32      uncompressed size
 * 0x1C  u32      reserved
 * 0x20  u64      data offset
 * 0x28  u64      file-name offset (u16-length-prefixed string)
 * ```
 *
 * This package only parses the container. Decompression is left to
 * the caller (every asset seen in the wild is a single Zstandard
 * frame) so the parser stays dependency-free; pair it with
 * `@tootallnate/zstd-wasm` or any other zstd decoder.
 *
 * References:
 *   - https://github.com/KillzXGaming/Switch-Toolbox (BEA plugin)
 */

export const BEA_MAGIC = 'SCNE';

const HEADER_SIZE = 0x48;
const ASST_MAGIC = 'ASST';
const ASST_SIZE = 0x30;

/** Raw compression-type values seen in ASST blocks. */
export const BeaCompressionType = {
	None: 0,
	Zstd: 2,
} as const;

export type BeaCompression = 'none' | 'zstd' | 'unknown';

export interface BeaVersion {
	major: number;
	minor: number;
	patch: number;
	/** Raw u32 from the header. */
	raw: number;
}

export interface BeaEntry {
	/** Position in the archive's asset array. */
	index: number;
	/** Full slash-delimited path, e.g. `object/obj03_coin/model/obj03_coin.fmdb`. */
	name: string;
	/** Raw compression-type field from the ASST block. */
	compressionType: number;
	/** Interpreted compression scheme for {@link data}. */
	compression: BeaCompression;
	/** Alignment exponent for the decompressed payload (`1 << n` bytes). */
	alignmentExponent: number;
	/** Absolute offset of the stored payload in the archive. */
	offset: number;
	/** Stored (possibly compressed) size in bytes. */
	storedSize: number;
	/** Size of the payload once decompressed. */
	uncompressedSize: number;
	/**
	 * Lazy `Blob` slice of the *stored* bytes. When
	 * {@link compression} is `'zstd'` this is a single Zstandard
	 * frame that decompresses to {@link uncompressedSize} bytes.
	 */
	data: Blob;
}

export interface ParsedBea {
	version: BeaVersion;
	/** Archive display name, e.g. `object~obj03_coin`. */
	name: string;
	/** Header alignment exponent. */
	alignmentExponent: number;
	/** Size of the metadata region (everything before the first payload). */
	metadataSize: number;
	/** Assets, in archive order. */
	entries: BeaEntry[];
}

/** Cheap 4-byte magic check. */
export async function isBea(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return isBeaHead(head);
}

/** Synchronous magic check over an already-read header prefix. */
export function isBeaHead(head: Uint8Array): boolean {
	return (
		head.length >= 4 &&
		head[0] === 0x53 && // S
		head[1] === 0x43 && // C
		head[2] === 0x4e && // N
		head[3] === 0x45 // E
	);
}

/**
 * Parse a BEA archive's metadata. Only the metadata region is read
 * up front; each entry's {@link BeaEntry.data} is a lazy slice of
 * the source blob.
 */
export async function parseBea(blob: Blob): Promise<ParsedBea> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(`BEA: file too small (${blob.size} bytes)`);
	}
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	if (!isBeaHead(head)) {
		throw new Error('BEA: bad magic (expected "SCNE")');
	}
	const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const bom = hv.getUint16(0x0c, true);
	if (bom !== 0xfeff) {
		throw new Error(
			`BEA: unsupported byte order mark 0x${bom.toString(16)} (only little-endian is supported)`,
		);
	}
	// The metadata region (header + ASST blocks + `_STR` + `_RLT`)
	// precedes every payload. Its size is stored at 0x1C; fall back to
	// the relocation table offset if it looks bogus.
	let metadataSize = hv.getUint32(0x1c, true);
	if (metadataSize < HEADER_SIZE || metadataSize > blob.size) {
		metadataSize = Math.min(blob.size, Math.max(hv.getUint32(0x18, true), HEADER_SIZE));
	}
	const meta = new Uint8Array(await blob.slice(0, metadataSize).arrayBuffer());
	const dv = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);

	const u64 = (off: number): number => {
		const lo = dv.getUint32(off, true);
		const hi = dv.getUint32(off + 4, true);
		return hi * 0x1_0000_0000 + lo;
	};
	const check = (off: number, len: number, what: string) => {
		if (off < 0 || off + len > meta.length) {
			throw new Error(
				`BEA: ${what} at 0x${off.toString(16)} is outside the metadata region (0x${meta.length.toString(16)} bytes)`,
			);
		}
	};
	const decoder = new TextDecoder();
	const readString = (off: number): string => {
		if (off === 0) return '';
		check(off, 2, 'string');
		const len = dv.getUint16(off, true);
		check(off + 2, len, 'string');
		return decoder.decode(meta.subarray(off + 2, off + 2 + len));
	};

	const raw = hv.getUint32(0x08, true);
	const version: BeaVersion = {
		major: (raw >>> 16) & 0xffff,
		minor: (raw >>> 8) & 0xff,
		patch: raw & 0xff,
		raw,
	};
	const count = dv.getUint16(0x20, true);
	const arrayOffset = u64(0x28);
	const name = readString(u64(0x40));
	check(arrayOffset, count * 8, 'asset array');

	const entries: BeaEntry[] = [];
	for (let i = 0; i < count; i++) {
		const a = u64(arrayOffset + i * 8);
		check(a, ASST_SIZE, `ASST block #${i}`);
		const magic = String.fromCharCode(meta[a], meta[a + 1], meta[a + 2], meta[a + 3]);
		if (magic !== ASST_MAGIC) {
			throw new Error(
				`BEA: expected ASST block #${i} at 0x${a.toString(16)}, got "${magic}"`,
			);
		}
		const compressionType = dv.getUint16(a + 0x10, true);
		const alignmentExponent = dv.getUint16(a + 0x12, true);
		const storedSize = dv.getUint32(a + 0x14, true);
		const uncompressedSize = dv.getUint32(a + 0x18, true);
		const offset = u64(a + 0x20);
		const entryName = readString(u64(a + 0x28)) || `asset_${i}`;
		if (offset + storedSize > blob.size) {
			throw new Error(
				`BEA: asset "${entryName}" (0x${offset.toString(16)} + ${storedSize}) extends past end of file`,
			);
		}
		const compression: BeaCompression =
			compressionType === BeaCompressionType.Zstd
				? 'zstd'
				: compressionType === BeaCompressionType.None
					? 'none'
					: 'unknown';
		entries.push({
			index: i,
			name: entryName,
			compressionType,
			compression,
			alignmentExponent,
			offset,
			storedSize,
			uncompressedSize,
			data: blob.slice(offset, offset + storedSize),
		});
	}

	return {
		version,
		name,
		alignmentExponent: head[0x0e],
		metadataSize,
		entries,
	};
}
