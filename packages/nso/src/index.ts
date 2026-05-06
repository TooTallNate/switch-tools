/**
 * NSO ("Nintendo Switch Object") parser.
 *
 * NSO is the executable container format used inside a Program NCA's
 * ExeFS. Files like `main`, `rtld`, `sdk`, and `subsdk0..9` are NSOs.
 * Structurally it's a small ELF-like wrapper around three segments
 * (`.text`, `.rodata`, `.data`) plus a `.bss` size, with optional per-
 * segment compression (LZ4 by default; zstd on firmware 22.0.0+) and
 * SHA-256 integrity checks.
 *
 * This module is parser-only and decompresses nothing: it surfaces the
 * 0x100-byte header as structured data, suitable for previewing NSO
 * metadata without touching the (potentially many MB) compressed
 * segment payloads.
 *
 * Reference: https://switchbrew.org/wiki/NSO
 */

const NSO_MAGIC = 0x304f534e; // "NSO0" little-endian
const NSO_HEADER_SIZE = 0x100;

const decoder = new TextDecoder();

/**
 * Bit positions within the `flags` field at offset 0x0C of the header.
 */
export const NsoFlag = {
	TextCompress: 1 << 0,
	RoCompress: 1 << 1,
	DataCompress: 1 << 2,
	TextHash: 1 << 3,
	RoHash: 1 << 4,
	DataHash: 1 << 5,
	/** [20.0.0+] segment is loaded into execute-only memory */
	ExecuteOnlyMemory: 1 << 6,
	/** [22.0.0+] segments use zstd-based compression instead of LZ4 */
	UseZbicCompression: 1 << 7,
} as const;

export interface NsoSegment {
	/** Byte offset of the (possibly compressed) segment within the NSO file */
	fileOffset: number;
	/** Virtual memory offset where the decompressed segment is loaded */
	memoryOffset: number;
	/**
	 * Decompressed segment size in bytes. This is the canonical size used
	 * for the SHA-256 hash check and for memory mapping.
	 */
	size: number;
	/** On-disk (potentially compressed) segment size in bytes */
	fileSize: number;
	/** True iff this segment is compressed (LZ4 or zstd, see flags) */
	compressed: boolean;
	/** True iff this segment carries a hash that loaders must verify */
	hashed: boolean;
	/** SHA-256 hash of the decompressed segment (32 bytes) */
	hash: Uint8Array;
}

export interface ParsedNsoHeader {
	/** Format magic; always `"NSO0"` */
	magic: string;
	/** Header version; always 0 in known firmware */
	version: number;
	/** Raw flags word; see {@link NsoFlag} for bit meanings */
	flags: number;
	/** Whether segments are compressed using zstd (firmware 22.0.0+) */
	usesZstd: boolean;
	/** Whether segments are loaded into execute-only memory (firmware 20.0.0+) */
	executeOnlyMemory: boolean;

	/** Module name (read from `.rodata` via the embedded module name slot) */
	moduleName: string;
	/** GNU build-id of the linked binary (up to 32 bytes) */
	moduleId: Uint8Array;

	textSegment: NsoSegment;
	rodataSegment: NsoSegment;
	dataSegment: NsoSegment;
	/** Uninitialised data segment size; not present on disk */
	bssSize: number;

	/**
	 * Position of the embedded `.dynstr` table within `.rodata`. Combined
	 * with `dynSymOffset` / `dynSymSize` this is enough to walk the NSO's
	 * dynamic symbol table without reconstructing an ELF.
	 */
	embeddedOffset: number;
	embeddedSize: number;
	dynStrOffset: number;
	dynStrSize: number;
	dynSymOffset: number;
	dynSymSize: number;
}

/**
 * Returns `true` iff the given `Blob` looks like a valid NSO0 file
 * (large enough for a header and starting with the `NSO0` magic).
 */
export async function isNso(blob: Blob): Promise<boolean> {
	if (blob.size < NSO_HEADER_SIZE) return false;
	const buf = await blob.slice(0, 4).arrayBuffer();
	return new DataView(buf).getUint32(0, true) === NSO_MAGIC;
}

/**
 * Parse the header of an NSO file from a `Blob`. The (possibly
 * compressed) segment payloads are NOT read; only the 0x100-byte header
 * plus a small slice of `.rodata` for the module name. Total bytes read
 * is O(header) ≈ 0x140.
 *
 * Throws if the magic is wrong or the blob is too small.
 */
export async function parseHeader(blob: Blob): Promise<ParsedNsoHeader> {
	if (blob.size < NSO_HEADER_SIZE) {
		throw new Error(
			`Blob too small to be an NSO (${blob.size} < ${NSO_HEADER_SIZE})`,
		);
	}
	const headerBuf = await blob.slice(0, NSO_HEADER_SIZE).arrayBuffer();
	const view = new DataView(headerBuf);
	const magic = view.getUint32(0x00, true);
	if (magic !== NSO_MAGIC) {
		throw new Error(
			`Not an NSO file (expected magic 0x${NSO_MAGIC.toString(16)} ("NSO0"), got 0x${magic.toString(16)})`,
		);
	}

	const version = view.getUint32(0x04, true);
	const flags = view.getUint32(0x0c, true);

	const moduleNameOffset = view.getUint32(0x1c, true);
	const moduleNameSize = view.getUint32(0x2c, true);

	const textSegment: NsoSegment = {
		fileOffset: view.getUint32(0x10, true),
		memoryOffset: view.getUint32(0x14, true),
		size: view.getUint32(0x18, true),
		fileSize: view.getUint32(0x60, true),
		compressed: !!(flags & NsoFlag.TextCompress),
		hashed: !!(flags & NsoFlag.TextHash),
		hash: new Uint8Array(headerBuf.slice(0xa0, 0xc0)),
	};
	const rodataSegment: NsoSegment = {
		fileOffset: view.getUint32(0x20, true),
		memoryOffset: view.getUint32(0x24, true),
		size: view.getUint32(0x28, true),
		fileSize: view.getUint32(0x64, true),
		compressed: !!(flags & NsoFlag.RoCompress),
		hashed: !!(flags & NsoFlag.RoHash),
		hash: new Uint8Array(headerBuf.slice(0xc0, 0xe0)),
	};
	const dataSegment: NsoSegment = {
		fileOffset: view.getUint32(0x30, true),
		memoryOffset: view.getUint32(0x34, true),
		size: view.getUint32(0x38, true),
		fileSize: view.getUint32(0x68, true),
		compressed: !!(flags & NsoFlag.DataCompress),
		hashed: !!(flags & NsoFlag.DataHash),
		hash: new Uint8Array(headerBuf.slice(0xe0, 0x100)),
	};

	const moduleId = new Uint8Array(headerBuf.slice(0x40, 0x60));

	// Read the module name. It lives at `moduleNameOffset` from the start
	// of the file (NOT from the rodata section). The size includes the
	// trailing NUL when present.
	let moduleName = '';
	if (moduleNameSize > 0 && moduleNameOffset + moduleNameSize <= blob.size) {
		const nameBuf = await blob
			.slice(moduleNameOffset, moduleNameOffset + moduleNameSize)
			.arrayBuffer();
		const bytes = new Uint8Array(nameBuf);
		// Trim at the first NUL, if any
		let end = bytes.length;
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) {
				end = i;
				break;
			}
		}
		moduleName = decoder.decode(bytes.subarray(0, end));
	}

	return {
		magic: 'NSO0',
		version,
		flags,
		usesZstd: !!(flags & NsoFlag.UseZbicCompression),
		executeOnlyMemory: !!(flags & NsoFlag.ExecuteOnlyMemory),
		moduleName,
		moduleId,
		textSegment,
		rodataSegment,
		dataSegment,
		bssSize: view.getUint32(0x3c, true),
		embeddedOffset: view.getUint32(0x88, true),
		embeddedSize: view.getUint32(0x8c, true),
		dynStrOffset: view.getUint32(0x90, true),
		dynStrSize: view.getUint32(0x94, true),
		dynSymOffset: view.getUint32(0x98, true),
		dynSymSize: view.getUint32(0x9c, true),
	};
}

/**
 * Hex-encode a `Uint8Array` into the form `"00112233..."`. Useful for
 * displaying ModuleId / segment hashes.
 */
export function hex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i].toString(16).padStart(2, '0');
	}
	return s;
}
