/**
 * CNMT (Content Meta) builder for Nintendo Switch.
 *
 * Builds CNMT binary data used inside Meta NCAs to describe
 * the contents (NCAs) of an application package.
 *
 * Reference: hacbrewpack/cnmt.c, hacbrewpack/cnmt.h
 */

/** CNMT content types */
export enum ContentType {
	Meta = 0,
	Program = 1,
	Data = 2,
	Control = 3,
	HtmlDocument = 4,
	LegalInformation = 5,
	DeltaFragment = 6,
}

/** CNMT meta type */
export enum MetaType {
	SystemProgram = 0x01,
	SystemData = 0x02,
	SystemUpdate = 0x03,
	BootImagePackage = 0x04,
	BootImagePackageSafe = 0x05,
	Application = 0x80,
	Patch = 0x81,
	AddOnContent = 0x82,
	Delta = 0x83,
}

/** CNMT header size: 0x20 bytes */
const HEADER_SIZE = 0x20;

/** Extended application header size: 0x10 bytes */
const EXTENDED_APP_HEADER_SIZE = 0x10;

/** Content record size: 0x38 bytes */
const CONTENT_RECORD_SIZE = 0x38;

/** Digest size: 0x20 bytes */
const DIGEST_SIZE = 0x20;

/**
 * A content record describing one NCA.
 */
export interface ContentRecord {
	/** SHA-256 hash of the entire NCA file (32 bytes) */
	hash: Uint8Array;
	/** NCA ID: first 16 bytes of the hash */
	ncaId: Uint8Array;
	/** NCA file size (up to 6 bytes / 48 bits) */
	size: number;
	/** Content type */
	type: ContentType;
	/** ID offset (usually 0) */
	idOffset?: number;
}

export interface CnmtOptions {
	/** Application title ID */
	titleId: bigint;
	/** Title version (default: 0) */
	titleVersion?: number;
	/** Content records for the NCAs in this package */
	contentRecords: ContentRecord[];
}

/**
 * Build a CNMT binary blob.
 *
 * @param options - CNMT configuration
 * @returns CNMT binary data as ArrayBuffer
 */
export function build(options: CnmtOptions): ArrayBuffer {
	const { titleId, titleVersion = 0, contentRecords } = options;

	// Total size = header + extended header + content records + digest
	const totalSize =
		HEADER_SIZE +
		EXTENDED_APP_HEADER_SIZE +
		contentRecords.length * CONTENT_RECORD_SIZE +
		DIGEST_SIZE;

	const buffer = new ArrayBuffer(totalSize);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);

	let offset = 0;

	// --- CNMT Header (0x20 bytes) ---
	// title_id (8 bytes)
	view.setBigUint64(offset + 0x00, titleId, true);
	// title_version (4 bytes)
	view.setUint32(offset + 0x08, titleVersion, true);
	// type (1 byte)
	view.setUint8(offset + 0x0c, MetaType.Application);
	// padding (1 byte) — already zero
	// extended_header_size (2 bytes)
	view.setUint16(offset + 0x0e, EXTENDED_APP_HEADER_SIZE, true);
	// content_entry_count (2 bytes)
	view.setUint16(offset + 0x10, contentRecords.length, true);
	// meta_entry_count (2 bytes) — 0
	// padding (remaining bytes of header) — already zero

	offset += HEADER_SIZE;

	// --- Extended Application Header (0x10 bytes) ---
	// patch_title_id = title_id + 0x800
	view.setBigUint64(offset + 0x00, titleId + 0x800n, true);
	// required_system_version (4 bytes) — 0
	// padding (4 bytes) — already zero

	offset += EXTENDED_APP_HEADER_SIZE;

	// --- Content Records (0x38 bytes each) ---
	for (const record of contentRecords) {
		// hash (0x20 bytes)
		bytes.set(record.hash.subarray(0, 0x20), offset + 0x00);
		// ncaid (0x10 bytes)
		bytes.set(record.ncaId.subarray(0, 0x10), offset + 0x20);
		// size (6 bytes, little-endian)
		const size = record.size;
		view.setUint32(offset + 0x30, size & 0xffffffff, true);
		view.setUint16(
			offset + 0x34,
			Math.floor(size / 0x100000000) & 0xffff,
			true
		);
		// type (1 byte)
		view.setUint8(offset + 0x36, record.type);
		// id_offset (1 byte)
		view.setUint8(offset + 0x37, record.idOffset ?? 0);

		offset += CONTENT_RECORD_SIZE;
	}

	// --- Digest (0x20 bytes) ---
	// All zeros (already zeroed from ArrayBuffer allocation)

	return buffer;
}
