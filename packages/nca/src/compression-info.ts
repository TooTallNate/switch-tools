/**
 * @license MIT
 *
 * Decoder for the NCA FS-header `CompressionInfo` block (0x178..0x1A0
 * in canonical FS-header layout, 0x28 bytes). When present, this
 * block describes a BucketTree-encoded compressed-storage layer that
 * sits above AES-CTR decryption — i.e. the section bytes you get
 * after AES-CTR must be fed through CompressedStorage decoding before
 * the inner filesystem becomes readable.
 *
 * Struct layout, little-endian, total 0x28 bytes:
 *
 *   off 0x00  u64  table_offset    — start of the BKTR table within the section
 *   off 0x08  u64  table_size      — bytes occupied by the BKTR table
 *   off 0x10  u32  magic           — "BKTR"
 *   off 0x14  u32  version         — must be 1
 *   off 0x18  s32  entry_count     — number of entries in the tree
 *   off 0x1C  u32  reserved
 *   off 0x20  u64  reserved
 *
 * Reference: https://switchbrew.org/wiki/NCA#NcaCompressionInfo
 */

import { parseBucketTreeHeader, type BucketTreeHeader } from './bucket-tree.js';

/** Offset of CompressionInfo within the FS header (0x200 bytes total). */
export const COMPRESSION_INFO_OFFSET = 0x178;
/** Size of the CompressionInfo struct. */
export const COMPRESSION_INFO_SIZE = 0x28;

export interface CompressionInfoFields {
	/** Start of the BKTR table within the section (logical-data end). */
	tableOffset: bigint;
	/** Total bytes occupied by the BKTR table. */
	tableSize: bigint;
	/** Parsed BucketTree top-level header (embedded inside the struct). */
	bucketTreeHeader: BucketTreeHeader;
	/** Trailing reserved u64. */
	reservedTail: bigint;
}

/**
 * Parse the `CompressionInfo` block from a 0x200-byte FS header.
 *
 * Returns `null` when the block is empty (`tableSize === 0`) —
 * the common case for sections without compression.
 *
 * Throws when `tableSize > 0` but the embedded BucketTree header
 * is malformed (bad magic / version). We deliberately don't try
 * to recover here: silently falling back to "raw bytes" produces
 * downstream parsers that fail with cryptic "out of bounds"
 * errors hundreds of MB later — much harder to diagnose than an
 * upfront throw.
 */
export function readCompressionInfo(fsHeader: Uint8Array): CompressionInfoFields | null {
	if (fsHeader.byteLength < COMPRESSION_INFO_OFFSET + COMPRESSION_INFO_SIZE) {
		throw new Error(
			`FS header too small: ${fsHeader.byteLength} < ${COMPRESSION_INFO_OFFSET + COMPRESSION_INFO_SIZE}`,
		);
	}
	const dv = new DataView(
		fsHeader.buffer,
		fsHeader.byteOffset + COMPRESSION_INFO_OFFSET,
		COMPRESSION_INFO_SIZE,
	);
	const tableOffset = dv.getBigInt64(0x00, true);
	const tableSize = dv.getBigInt64(0x08, true);
	if (tableSize === 0n) return null;

	const bucketTreeHeader = parseBucketTreeHeader(
		new Uint8Array(
			fsHeader.buffer,
			fsHeader.byteOffset + COMPRESSION_INFO_OFFSET + 0x10,
			0x10,
		),
	);
	const reservedTail = dv.getBigUint64(0x20, true);
	return {
		tableOffset,
		tableSize,
		bucketTreeHeader,
		reservedTail,
	};
}
