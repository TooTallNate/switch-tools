/**
 * NCA (Nintendo Content Archive) parser.
 *
 * Parses encrypted NCA files: decrypts the AES-XTS header, walks the FS
 * headers, decrypts the key area with the KAEK, and exposes each section
 * as a lazily-decrypted `Blob`-like object that can be passed to
 * `@tootallnate/pfs0`, `@tootallnate/nsp`, or `@tootallnate/romfs` for
 * further structured parsing without ever fully buffering the section.
 *
 * AES-128-CTR is used for section body encryption, which permits random
 * access — decrypting an arbitrary range only requires the encrypted
 * bytes from that range plus a small (up to 15-byte) head-alignment.
 *
 * Reference: hacbrewpack/nca.c, https://switchbrew.org/wiki/NCA
 */

import { decrypt as aesXtsDecrypt } from '@tootallnate/aes-xts';
import { aesCtrEncrypt, aesEcbDecrypt, buildNcaCtr } from './crypto.js';
import type { KeySet } from './keys.js';
import { NcaContentType } from './index.js';
import { BucketTreeReader } from './bucket-tree.js';
import {
	readCompressionInfo,
	type CompressionInfoFields,
} from './compression-info.js';
import {
	CompressedStorageReader,
	COMPRESSED_ENTRY_SIZE,
} from './compressed-storage.js';

/** NCA header total size: 0xC00 bytes */
const NCA_HEADER_SIZE = 0xc00;

/** Media unit size: 0x200 bytes */
const MEDIA_UNIT = 0x200;

/** NCA3 magic ("NCA3") */
const MAGIC_NCA3 = 0x3341434e;
/** NCA2 magic ("NCA2") — older format, mostly compatible for parsing */
const MAGIC_NCA2 = 0x3241434e;
/** NCA0 magic ("NCA0") — not commonly seen, included for completeness */
const MAGIC_NCA0 = 0x3041434e;

/** Section crypto types (from FS header) */
export const NCA_CRYPT_NONE = 1;
export const NCA_CRYPT_XTS = 2;
export const NCA_CRYPT_CTR = 3;
export const NCA_CRYPT_BKTR = 4;

/** Section FS types (from FS header) */
export const NCA_FS_TYPE_ROMFS = 0;
export const NCA_FS_TYPE_PFS0 = 1;

/** Hash types (from FS header) */
export const NCA_HASH_TYPE_NONE = 0;
export const NCA_HASH_TYPE_PFS0 = 2;
export const NCA_HASH_TYPE_ROMFS = 3;

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Decoded NCA section header (FS header) plus offsets into the source NCA.
 */
export interface NcaSection {
	/** Section index (0..3) */
	index: number;
	/** FS type: ROMFS (0) or PFS0 (1) */
	fsType: number;
	/** Hash type */
	hashType: number;
	/** Crypt type: NONE (1), XTS (2), CTR (3), or BKTR (4) */
	cryptType: number;
	/** Absolute byte offset of this section in the NCA */
	mediaStartOffset: number;
	/** Absolute byte end offset (exclusive) of this section in the NCA */
	mediaEndOffset: number;
	/** Section CTR (8 bytes) — used to build the AES-CTR initial counter */
	sectionCtr: Uint8Array;
	/**
	 * For PFS0 sections: byte offset (within the section) where the actual
	 * PFS0 data begins, after the SHA-256 hash table.
	 */
	pfs0Offset?: number;
	/** For PFS0 sections: size of the PFS0 data. */
	pfs0Size?: number;
	/** PFS0 hash block size. */
	pfs0HashBlockSize?: number;
	/**
	 * For RomFS sections: byte offset (within the section) of the IVFC level 6
	 * (= the actual RomFS data), as decoded from the IVFC header.
	 */
	romfsOffset?: number;
	/** For RomFS sections: size of the RomFS data. */
	romfsSize?: number;
	/**
	 * Decrypted FS header (0x200 bytes) for callers that need
	 * to inspect raw fields.
	 */
	fsHeader: Uint8Array;
	/**
	 * The data of this section, decrypted on demand. Calling `.slice()`
	 * on this returns another lazy `Blob`; calling `.arrayBuffer()`
	 * decrypts and reads the requested range. Backed by the original
	 * encrypted source so memory usage stays bounded.
	 *
	 * For PFS0/RomFS sections this is the *full* section (including the
	 * hash tree / hash table) — use `pfs0Offset` / `romfsOffset` to
	 * locate the actual filesystem data within it, or use the convenience
	 * `pfs0Data` / `romfsData` properties below.
	 */
	data: Blob;
	/**
	 * For PFS0 sections only: a lazy `Blob` containing only the inner
	 * PFS0 data (the section sliced from `pfs0Offset` for `pfs0Size`).
	 */
	pfs0Data?: Blob;
	/**
	 * For RomFS sections only: a lazy `Blob` containing only the inner
	 * RomFS data (the section sliced from `romfsOffset` for `romfsSize`).
	 */
	romfsData?: Blob;
	/**
	 * `true` when this section's `data` (and therefore `pfs0Data` /
	 * `romfsData`) is read through a CompressedStorage layer — i.e. the
	 * raw section bytes were both AES-CTR encrypted *and* compressed
	 * (typically LZ4) under a BucketTree index. Consumers don't normally
	 * need to look at this; it's exposed for diagnostics.
	 */
	compressed?: boolean;
}

export interface ParsedNca {
	/** Format magic ("NCA3", "NCA2", or "NCA0") */
	magic: string;
	/** Distribution type (0=Download, 1=GameCard) */
	distribution: number;
	/** Content type (Program=0, Meta=1, Control=2, Manual=3, ...) */
	contentType: NcaContentType;
	/** Key generation index used for the KAEK (1-indexed, matching builder) */
	keyGeneration: number;
	/** Key area encryption key index (0=Application, 1=Ocean, 2=System) */
	kaekIndex: number;
	/** Total size of the NCA, as recorded in the header */
	ncaSize: bigint;
	/** Title ID */
	titleId: bigint;
	/** SDK version */
	sdkVersion: number;
	/** Rights ID (16 bytes; all-zero when no titlekey crypto is in use) */
	rightsId: Uint8Array;
	/** Whether the rights ID is non-zero (titlekey crypto required) */
	hasRightsId: boolean;
	/**
	 * The decrypted key area (4 keys × 16 bytes). Index 2 is conventionally
	 * the section key used for AES-CTR.
	 */
	keyArea: Uint8Array[];
	/** Decrypted key used for AES-CTR section bodies (= keyArea[2]). */
	sectionKey: Uint8Array;
	/**
	 * Human-readable description of why we couldn't derive the key
	 * needed to decrypt section bodies (typically because the user's
	 * `prod.keys` is older than the NCA's firmware target). `null`
	 * when decryption is fully set up.
	 *
	 * The header is still fully parsed when this is set (so the
	 * caller can show NCA metadata), but reading from a section's
	 * `data` blob throws an {@link NcaKeyError} with the same
	 * message rather than silently producing garbage.
	 *
	 * Prefer {@link missingKeyDetail} for programmatic dispatch —
	 * callers that want to render their own message or pick a
	 * different UI affordance per cause should branch on the code,
	 * not parse this string.
	 */
	missingKey: string | null;
	/**
	 * Structured form of {@link missingKey}: a stable cause code
	 * plus the relevant context (key generation, KAEK index, …).
	 * `null` when `missingKey` is `null`.
	 */
	missingKeyDetail: NcaKeyErrorDetail | null;
	/** Sections present in this NCA (those whose entry start_media != 0). */
	sections: NcaSection[];
	/** SHA-256 hash of the entire NCA, hex-encoded (first 16 bytes used as NCA ID). */
	ncaId: string;
}

/**
 * Stable cause codes for NCA-key failures. Callers branch on
 * `code` to decide what UI to show; the structured `detail`
 * carries the supporting context for the (canonical) message.
 *
 *   - `outdated-keys`  KeySet present but no entry for this NCA's
 *                      key generation (the most common case — the
 *                      user's `prod.keys` predates the firmware
 *                      that produced this NCA).
 *   - `missing-ticket` NCA uses titlekey crypto but no `.tik`
 *                      file was supplied alongside.
 *
 * `no-keys` (no `KeySet` at all) is surfaced separately by
 * callers that have direct access to the keys — `parseNca`
 * itself requires a `KeySet` argument so it can't produce it.
 */
export type NcaKeyErrorCode = 'outdated-keys' | 'missing-ticket';

export interface NcaKeyErrorDetail {
	code: NcaKeyErrorCode;
	/** Key generation the NCA needs (1-indexed; matches `master_key_<n-1>`). */
	generation?: number;
	/**
	 * Which key area key index was missing. 0 = Application, 1 =
	 * Ocean, 2 = System. Only set for `outdated-keys` with the
	 * key-area path (not titlekek).
	 */
	kaekIndex?: number;
	/**
	 * Sub-cause within `outdated-keys`: which key did we fail to
	 * find? Lets the UI offer slightly different copy
	 * ("titlekek for gen N" vs "key area key for gen N").
	 */
	kind?: 'key-area-key' | 'titlekek';
}

/**
 * Error thrown by NCA section reads when keys are missing or
 * mismatched. Carries a stable `code` + structured `detail` so the
 * UI can render its own copy / actions.
 */
export class NcaKeyError extends Error {
	readonly code: NcaKeyErrorCode;
	readonly detail: NcaKeyErrorDetail;

	constructor(detail: NcaKeyErrorDetail) {
		super(formatNcaKeyMessage(detail));
		this.name = 'NcaKeyError';
		this.code = detail.code;
		this.detail = detail;
	}
}

/**
 * Canonical user-facing message for a given key error. Single
 * source of truth so the same cause never produces two different
 * texts at different call sites.
 *
 *   - Both `outdated-keys` sub-kinds collapse to one message
 *     ("Your prod.keys is older than this NCA…") with the
 *     specific generation appended for diagnostics. Tools can
 *     still branch on `detail.kind` if they want to differentiate.
 *   - `missing-ticket` is its own actionable case (the user
 *     should locate the matching `.tik`).
 */
export function formatNcaKeyMessage(detail: NcaKeyErrorDetail): string {
	switch (detail.code) {
		case 'outdated-keys': {
			const gen =
				detail.generation !== undefined
					? ` (needed key generation ${detail.generation})`
					: '';
			return `Your prod.keys file is older than this NCA${gen} — try updating it (e.g. with a recent Lockpick_RCM run).`;
		}
		case 'missing-ticket':
			return `This NCA uses titlekey crypto (RightsId set) but no matching .tik ticket file was supplied. Tickets ship alongside the NCA in the same NSP/XCI container.`;
	}
}

export interface ParseNcaOptions {
	keys: KeySet;
	crypto?: Crypto;
	/** When `true`, expects a plaintext (already-decrypted) NCA. */
	plaintext?: boolean;
	/**
	 * Optional 16-byte ENCRYPTED title key from a `.tik` file. Required for
	 * NCAs whose `RightsId` field is non-zero (typical retail NSPs). The
	 * decrypted title key is then used as the AES-CTR section key in place
	 * of the key-area-derived key.
	 *
	 * The caller can supply either the raw 16 bytes (after stripping the
	 * `.tik` envelope — bytes 0x180..0x190 of a Common ticket), or
	 * `undefined`. If `undefined` and the NCA has a RightsId, the section
	 * data will not decrypt correctly; the caller should detect this case
	 * and surface a "needs titlekey" error to the user.
	 */
	encryptedTitleKey?: Uint8Array;
}

/**
 * Parse an NCA `Blob`. Lazy: only the 0xC00 header is read up-front; section
 * bodies are decrypted on demand when reading from `section.data`.
 */
export async function parseNca(
	blob: Blob,
	options: ParseNcaOptions
): Promise<ParsedNca> {
	const { keys, crypto = globalThis.crypto, plaintext = false } = options;

	if (blob.size < NCA_HEADER_SIZE) {
		throw new Error(
			`Blob too small to be an NCA (${blob.size} < ${NCA_HEADER_SIZE})`
		);
	}

	// Read encrypted header
	const encHeader = new Uint8Array(
		await blob.slice(0, NCA_HEADER_SIZE).arrayBuffer()
	);

	// Decrypt header with AES-XTS (or pass through if plaintext)
	let header: Uint8Array;
	if (plaintext) {
		header = encHeader;
	} else {
		const decrypted = await aesXtsDecrypt(
			keys.headerKey,
			encHeader,
			0x200,
			0,
			crypto
		);
		header = new Uint8Array(decrypted);
	}

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

	// NCA header fields start at offset 0x200 (after two 0x100-byte signatures)
	const headerOffset = 0x200;
	const magic = view.getUint32(headerOffset + 0x00, true);

	let magicStr: string;
	if (magic === MAGIC_NCA3) magicStr = 'NCA3';
	else if (magic === MAGIC_NCA2) magicStr = 'NCA2';
	else if (magic === MAGIC_NCA0) magicStr = 'NCA0';
	else {
		throw new Error(
			`Not an NCA (bad magic 0x${magic.toString(16)} — wrong key, wrong file, or unsupported format)`
		);
	}

	const distribution = header[headerOffset + 0x04];
	const contentType = header[headerOffset + 0x05] as NcaContentType;
	const cryptoType1 = header[headerOffset + 0x06];
	const kaekIndex = header[headerOffset + 0x07];
	const ncaSize = view.getBigUint64(headerOffset + 0x08, true);
	const titleId = view.getBigUint64(headerOffset + 0x10, true);
	const sdkVersion = view.getUint32(headerOffset + 0x1c, true);
	const cryptoType2 = header[headerOffset + 0x20];

	// Key generation: cryptoType2 takes precedence if > 2, else cryptoType1.
	// Stored as a 0-indexed value where 0 means "generation 1" (firmware 1.0).
	let keyGenerationRaw = cryptoType2 > 2 ? cryptoType2 : cryptoType1;
	if (keyGenerationRaw > 0) keyGenerationRaw -= 1;
	const keyGeneration = keyGenerationRaw + 1; // 1-indexed for KeySet lookup

	// Rights ID at 0x230 (16 bytes)
	const rightsId = header.slice(headerOffset + 0x30, headerOffset + 0x40);
	const hasRightsId = rightsId.some((b) => b !== 0);

	// Decrypt key area at 0x300 (4 × 16 bytes) using the KAEK for this generation+index.
	// Generation lookup: KeySet uses 0-indexed generations.
	const kak = keys.keyAreaKeys[keyGeneration - 1]?.[kaekIndex];
	const keyAreaEncrypted = header.subarray(0x300, 0x340);
	let keyAreaDecrypted: Uint8Array;
	let missingKeyDetail: NcaKeyErrorDetail | null = null;
	if (plaintext) {
		keyAreaDecrypted = new Uint8Array(keyAreaEncrypted);
	} else if (!kak || kak.every((b) => b === 0)) {
		// We don't have the KAEK for this generation. This is most
		// often caused by an out-of-date `prod.keys` — for example,
		// opening a firmware-22 NCA with a key file that only goes
		// up to `master_key_0f`. The caller may still inspect
		// header metadata, but section reads will throw a clear
		// {@link NcaKeyError} carrying the structured detail.
		missingKeyDetail = {
			code: 'outdated-keys',
			generation: keyGeneration,
			kaekIndex,
			kind: 'key-area-key',
		};
		keyAreaDecrypted = new Uint8Array(keyAreaEncrypted);
	} else {
		keyAreaDecrypted = await aesEcbDecrypt(kak, keyAreaEncrypted, crypto);
	}

	const keyArea: Uint8Array[] = [];
	for (let i = 0; i < 4; i++) {
		keyArea.push(keyAreaDecrypted.slice(i * 16, (i + 1) * 16));
	}

	// Determine which key to use for AES-CTR section bodies.
	//
	// - If RightsId is zero, sections are encrypted with the key area key
	//   (conventionally `keyArea[2]`).
	// - If RightsId is non-zero, sections are encrypted with the *decrypted*
	//   titlekey: `AES-ECB-Decrypt(titlekek[keygen-1], encryptedTitleKey)`.
	//   The encrypted titlekey lives in the matching `.tik` ticket file
	//   that ships alongside the NCA in the NSP/XCI, and the caller passes
	//   it in via `options.encryptedTitleKey`.
	let sectionKey = keyArea[2];
	if (hasRightsId) {
		const titlekek = keys.titlekeks?.[keyGeneration - 1];
		if (!options.encryptedTitleKey) {
			missingKeyDetail = { code: 'missing-ticket' };
		} else if (!titlekek || titlekek.every((b) => b === 0)) {
			// Same root cause as the key-area-key path above: the
			// user's prod.keys doesn't cover this NCA's generation.
			// Reported with the same `outdated-keys` code so the UI
			// renders one consistent message regardless of which
			// crypto path the NCA uses.
			missingKeyDetail = {
				code: 'outdated-keys',
				generation: keyGeneration,
				kind: 'titlekek',
			};
		} else {
			sectionKey = await aesEcbDecrypt(
				titlekek,
				options.encryptedTitleKey,
				crypto,
			);
		}
	}
	const missingKey = missingKeyDetail
		? formatNcaKeyMessage(missingKeyDetail)
		: null;

	// Walk section entries (at 0x240, 4 × 0x10 bytes) and FS headers (at 0x400, 4 × 0x200 bytes).
	const sections: NcaSection[] = [];
	for (let i = 0; i < 4; i++) {
		const entryOffset = headerOffset + 0x40 + i * 0x10;
		const startMedia = view.getUint32(entryOffset + 0x00, true);
		const endMedia = view.getUint32(entryOffset + 0x04, true);
		// Skip empty entries
		if (startMedia === 0 && endMedia === 0) continue;

		const fsHeader = header.slice(0x400 + i * 0x200, 0x400 + (i + 1) * 0x200);
		const fsView = new DataView(
			fsHeader.buffer,
			fsHeader.byteOffset,
			fsHeader.byteLength
		);

		const fsType = fsHeader[0x02];
		const hashType = fsHeader[0x03];
		const cryptType = fsHeader[0x04];

		// section_ctr is at 0x140 within the FS header (8 bytes)
		const sectionCtr = fsHeader.slice(0x140, 0x148);

		// TODO: SparseInfo offset bug — switchbrew documents SparseInfo at
		// 0x148..0x178, but this parser currently isn't aware of SparseInfo
		// (no read/handling at all). When SparseInfo support is added, the
		// SparseInfo block must be read at 0x148, NOT 0x140 (the field at
		// 0x140 is `Generation + SecureValue` == section CTR, which we
		// correctly read above). Until then, sparse NCAs may decrypt to
		// garbage; only CompressionInfo (added below at the canonical 0x178)
		// is handled.

		const mediaStartOffset = startMedia * MEDIA_UNIT;
		const mediaEndOffset = endMedia * MEDIA_UNIT;

		// Compute inner FS data offset/size
		let pfs0Offset: number | undefined;
		let pfs0Size: number | undefined;
		let pfs0HashBlockSize: number | undefined;
		let romfsOffset: number | undefined;
		let romfsSize: number | undefined;

		if (hashType === NCA_HASH_TYPE_PFS0) {
			// PFS0 superblock at FS header offset 0x08:
			//   master_hash[0x20], block_size(u32), always_2(u32), hash_table_offset(u64),
			//   hash_table_size(u64), pfs0_offset(u64), pfs0_size(u64)
			const sb = 0x08;
			pfs0HashBlockSize = fsView.getUint32(sb + 0x20, true);
			pfs0Offset = Number(fsView.getBigUint64(sb + 0x38, true));
			pfs0Size = Number(fsView.getBigUint64(sb + 0x40, true));
		} else if (hashType === NCA_HASH_TYPE_ROMFS) {
			// IVFC header at FS header offset 0x08:
			//   magic(u32) "IVFC", version(u32), master_hash_size(u32), num_levels(u32)
			//   then LevelHeader[] { logical_offset(u64), hash_data_size(u64),
			//                        block_size(u32), reserved(u32) }
			//
			// The IVFC builder reports `num_levels = 7` but only writes 6 entries
			// (5 hash levels + 1 data level). The data level is the *last*
			// entry, at index `num_levels - 2`. Its `logical_offset` equals the
			// cumulative size of all preceding levels — and the IVFC level
			// data is concatenated linearly into the NCA section, so this
			// `logical_offset` is also the physical offset of the data within
			// the section.
			const sb = 0x08;
			const numLevels = fsView.getUint32(sb + 0x0c, true);
			if (numLevels >= 2) {
				const dataLevelIdx = numLevels - 2;
				const levelHeader = sb + 0x10 + dataLevelIdx * 0x18;
				romfsOffset = Number(fsView.getBigUint64(levelHeader + 0x00, true));
				romfsSize = Number(fsView.getBigUint64(levelHeader + 0x08, true));
			}
		}

		// Build the lazy section blob. If we don't have the right key,
		// reads from the section will throw with this message instead of
		// silently returning garbage.
		const sectionData = createLazySectionBlob({
			source: blob,
			start: mediaStartOffset,
			end: mediaEndOffset,
			cryptType,
			sectionCtr,
			sectionKey,
			plaintext,
			crypto,
			// Plaintext sections (e.g. the Logo PFS0) work fine without keys
			// — only fail on encrypted sections.
			missingKeyDetail:
				cryptType === NCA_CRYPT_NONE ? null : missingKeyDetail,
		});

		// If CompressionInfo is populated, the FS-data region (RomFS
		// for IVFC sections, PFS0 for PFS0 sections) is encoded as a
		// CompressedStorage layer on top of the AES-CTR-decrypted
		// bytes. Wrap it now so downstream consumers see the
		// decompressed view.
		//
		// The BKTR table lives inside the FS-data region — at offset
		// `tableOffset` of that region, not of the whole section —
		// per Atmosphere's `NcaBucketInfo` semantics. The 16-byte
		// BucketTree top-level header is embedded in
		// `compression_info.bucket.header[0x10]` (already parsed
		// by `readCompressionInfo`), not present at section bytes.
		let compressionInfo: CompressionInfoFields | null = null;
		try {
			compressionInfo = readCompressionInfo(fsHeader);
		} catch (err) {
			// A populated-but-malformed CompressionInfo block is a hard
			// failure: silently falling back to raw bytes would just
			// cause the downstream parser to die hundreds of MB later
			// with a cryptic message. Re-throw with context.
			throw new Error(
				`NCA section ${i}: malformed CompressionInfo: ${(err as Error).message}`,
			);
		}

		const section: NcaSection = {
			index: i,
			fsType,
			hashType,
			cryptType,
			mediaStartOffset,
			mediaEndOffset,
			sectionCtr,
			pfs0Offset,
			pfs0Size,
			pfs0HashBlockSize,
			romfsOffset,
			romfsSize,
			fsHeader,
			data: sectionData,
		};

		if (pfs0Offset !== undefined && pfs0Size !== undefined) {
			let pfs0Data = sectionData.slice(pfs0Offset, pfs0Offset + pfs0Size);
			if (compressionInfo) {
				pfs0Data = await wrapWithCompressedStorage(pfs0Data, compressionInfo);
				section.compressed = true;
			}
			section.pfs0Data = pfs0Data;
		}
		if (romfsOffset !== undefined && romfsSize !== undefined) {
			let romfsData = sectionData.slice(romfsOffset, romfsOffset + romfsSize);
			if (compressionInfo) {
				romfsData = await wrapWithCompressedStorage(romfsData, compressionInfo);
				section.compressed = true;
			}
			section.romfsData = romfsData;
		}

		sections.push(section);
	}

	const ncaId = bytesToHex(rightsId.subarray(0, 8)); // best-effort fallback
	// We don't compute the full SHA-256 of the NCA up-front (could be large).
	// Use the NCA header fields the caller already has if a real ID is needed.

	return {
		magic: magicStr,
		distribution,
		contentType,
		keyGeneration,
		kaekIndex,
		ncaSize,
		titleId,
		sdkVersion,
		rightsId,
		hasRightsId,
		keyArea,
		sectionKey,
		missingKey,
		missingKeyDetail,
		sections,
		ncaId,
	};
}

// -------------------- Compressed-storage Blob facade --------------------

/**
 * Wrap a `Blob` representing one decrypted region (typically the
 * RomFS / IVFC-L5 data layer of a section) with a CompressedStorage
 * decoding layer.
 *
 * `compressionInfo.tableOffset` and `tableSize` are offsets and
 * sizes **within `source`** — the BKTR L1 node + entry sets live
 * in `[tableOffset, tableOffset+tableSize)`, and the decompressed
 * (virtual) view's size is taken from the L1 NodeHeader's `offset`
 * field. The first physical byte of the compressed payload is at
 * `source[0]`; the BKTR table sits at the *end* of the physical
 * region.
 *
 * The 16-byte BucketTree top-level header is NOT present in
 * `source[tableOffset]` — it's embedded in the FS-header's
 * CompressionInfo struct (`bucket.header[0x10]`), already parsed
 * by `readCompressionInfo`. The reader uses `entryCount` from
 * that parsed header.
 */
function wrapWithCompressedStorage(
	source: Blob,
	info: CompressionInfoFields,
): Blob {
	// CompressedStorage uses 16 KiB nodes per Atmosphere.
	const NODE_SIZE = 16 * 1024;
	const tableOffset = Number(info.tableOffset);
	const tableSize = Number(info.tableSize);
	if (!Number.isSafeInteger(tableOffset) || !Number.isSafeInteger(tableSize)) {
		throw new Error(
			`CompressionInfo tableOffset/tableSize too large for Number: ${info.tableOffset}/${info.tableSize}`,
		);
	}
	const tableEnd = tableOffset + tableSize;
	// nodeStorage: the L1 NodeHeader + offsets array, within the
	// first `NODE_SIZE` bytes of the BKTR table region.
	const nodeStorage = source.slice(tableOffset, tableOffset + NODE_SIZE);
	// entryStorage: everything after the L1 node region, up to tableEnd.
	const entryStorage = source.slice(tableOffset + NODE_SIZE, tableEnd);

	const table = new BucketTreeReader({
		nodeStorage,
		entryStorage,
		nodeSize: NODE_SIZE,
		entrySize: COMPRESSED_ENTRY_SIZE,
		entryCount: info.bucketTreeHeader.entryCount,
	});

	// The logical (decompressed) size is the L1 NodeHeader's `offset`
	// field, exposed via `table.getOffsets().endOffset`. We CAN'T
	// resolve this eagerly: doing so forces a 16 KiB read from
	// `source`, which goes through AES-CTR decryption, which fails
	// for RightsId-keyed NCAs before the caller has had a chance to
	// supply a titlekey. (The two-phase `parseNca` flow in
	// `nx-archive` calls us once without the key just to read the
	// header.)
	//
	// Defer to the FIRST read: the facade exposes 0 as a placeholder
	// for `.size`, and the real logical size is fetched on demand at
	// first read. Real-world `Blob.size` consumers are limited to
	// RomFS / PFS0 decoders that don't actually depend on the wrapper-
	// blob's reported size (they read structured headers and seek by
	// offset).
	//
	// Critically: we kick off the lazy promise INSIDE the
	// CompressedStorageReader's `getLogicalSize`, which is only
	// awaited when an actual read happens. That way an aborted
	// first-pass `parseNca` (no titlekey) doesn't produce an
	// orphaned rejected promise.
	let logicalSizeCache: Promise<bigint> | null = null;
	const lazyLogicalSize = (): Promise<bigint> => {
		if (logicalSizeCache === null) {
			logicalSizeCache = table.getOffsets().then((o) => o.endOffset);
		}
		return logicalSizeCache;
	};

	const reader = new CompressedStorageReader({
		readSectionRange: async (start, end) => {
			// `source` is a Blob; sliced ranges are decrypted on demand.
			const startN = Number(start);
			const endN = Number(end);
			if (!Number.isSafeInteger(startN) || !Number.isSafeInteger(endN)) {
				throw new Error(`CompressedStorage range too large: [${start}, ${end})`);
			}
			const ab = await source.slice(startN, endN).arrayBuffer();
			return new Uint8Array(ab);
		},
		table,
		logicalSize: lazyLogicalSize,
	});

	return makeCompressedStorageBlob(reader, 0n, lazyLogicalSize);
}

/**
 * Build a `Blob`-shaped facade over a `CompressedStorageReader`
 * sub-range. `.slice()` returns another facade covering a
 * narrower logical range, so consumers can do the usual
 * `.slice().arrayBuffer()` dance without forcing a full read.
 *
 * `end` may be a thunk (`() => Promise<bigint>`) that resolves
 * to the absolute end offset. This lets the top-level wrapper
 * defer the logical-size lookup (which requires AES-CTR-decrypting
 * one block of the source) until the first actual read — see the
 * note in `wrapWithCompressedStorage` about two-phase `parseNca`.
 * Thunks are preferred over bare promises because they don't
 * produce orphaned rejections when nothing ever awaits the facade.
 */
function makeCompressedStorageBlob(
	reader: CompressedStorageReader,
	start: bigint,
	end: bigint | (() => Promise<bigint>),
): Blob {
	// When the end offset is unresolved, we expose `size` as 0
	// (Blob spec requires a `number`). Real consumers read via
	// `.slice().arrayBuffer()` or `.bytes()` which await `end`
	// internally; nothing in this codebase actually relies on
	// `.size` returning the true value for a compressed-storage
	// facade.
	let resolvedEnd: bigint | null = null;
	let resolvedSizeNum: number | null = null;
	if (typeof end === 'bigint') {
		resolvedEnd = end;
		const diff = end - start;
		if (diff < 0n) {
			throw new Error(`CompressedStorage slice has negative size: ${diff}`);
		}
		resolvedSizeNum =
			diff <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(diff) : NaN;
	}
	const resolveEnd = async (): Promise<bigint> => {
		if (resolvedEnd === null) {
			resolvedEnd = await (end as () => Promise<bigint>)();
			const diff = resolvedEnd - start;
			resolvedSizeNum =
				diff <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(diff) : NaN;
		}
		return resolvedEnd;
	};
	const facade: Blob = {
		get size() {
			// `0` when the size is still pending. This is incorrect
			// per the Blob spec but better than blocking or throwing;
			// every downstream consumer in this codebase either calls
			// `.arrayBuffer()` / `.bytes()` (which await internally),
			// or reads structured headers that don't iterate to the
			// end. The placeholder is replaced as soon as anything
			// triggers a read.
			return resolvedSizeNum !== null && Number.isFinite(resolvedSizeNum)
				? resolvedSizeNum
				: 0;
		},
		get type() {
			return '';
		},
		async arrayBuffer(): Promise<ArrayBuffer> {
			const e = await resolveEnd();
			const u8 = await reader.read(start, e);
			const ab = new ArrayBuffer(u8.byteLength);
			new Uint8Array(ab).set(u8);
			return ab;
		},
		async bytes(): Promise<Uint8Array> {
			const e = await resolveEnd();
			return reader.read(start, e);
		},
		async text(): Promise<string> {
			const e = await resolveEnd();
			const u8 = await reader.read(start, e);
			return new TextDecoder().decode(u8);
		},
		slice(s?: number, e?: number, _contentType?: string): Blob {
			// Clamp like the standard Blob.slice spec: negative values
			// are not supported here (we never produce them, and Blob
			// consumers in this codebase don't pass them).
			const localStart = s === undefined ? 0 : Math.max(0, s);
			// When the parent end is still pending, we can't honour
			// "slice to end of parent" synchronously. We pass the
			// pending promise through so the new facade also defers.
			if (e === undefined) {
				if (resolvedEnd !== null) {
					return makeCompressedStorageBlob(
						reader,
						start + BigInt(localStart),
						resolvedEnd,
					);
				}
				return makeCompressedStorageBlob(
					reader,
					start + BigInt(localStart),
					// Pass the thunk through so the child facade
					// also defers until a real read happens.
					resolveEnd,
				);
			}
			const localEnd = Math.max(localStart, e);
			if (resolvedEnd !== null && Number.isFinite(resolvedSizeNum!)) {
				const cappedEnd = Math.min(localEnd, resolvedSizeNum!);
				return makeCompressedStorageBlob(
					reader,
					start + BigInt(localStart),
					start + BigInt(cappedEnd),
				);
			}
			return makeCompressedStorageBlob(
				reader,
				start + BigInt(localStart),
				start + BigInt(localEnd),
			);
		},
		stream(): ReadableStream<Uint8Array> {
			const CHUNK = 64 * 1024;
			let pos = start;
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					const e = await resolveEnd();
					if (pos >= e) {
						controller.close();
						return;
					}
					const next = pos + BigInt(CHUNK) < e ? pos + BigInt(CHUNK) : e;
					try {
						const u8 = await reader.read(pos, next);
						controller.enqueue(u8);
						pos = next;
					} catch (err) {
						controller.error(err);
					}
				},
			});
		},
	} as unknown as Blob;
	return facade;
}

// -------------------- Lazy-decryption Blob facade --------------------

interface LazySectionParams {
	source: Blob;
	/** Absolute start of the section in `source` */
	start: number;
	/** Absolute end (exclusive) of the section in `source` */
	end: number;
	cryptType: number;
	sectionCtr: Uint8Array;
	sectionKey: Uint8Array;
	plaintext: boolean;
	crypto: Crypto;
	/**
	 * If non-null, the parser detected that the user's KeySet
	 * doesn't contain the right key to decrypt this section.
	 * Reading from the blob throws an {@link NcaKeyError} carrying
	 * the structured detail instead of silently returning garbage.
	 */
	missingKeyDetail: NcaKeyErrorDetail | null;
}

/**
 * Create a `Blob`-like object that decrypts AES-CTR section data on demand.
 *
 * AES-CTR is a streaming cipher: each 16-byte block is independently XOR'd
 * with `AES-Encrypt(counter)`, where the counter is derived from the section
 * CTR + the absolute byte offset within the NCA (offset >> 4, big-endian, in
 * the low 8 bytes). This means we can decrypt arbitrary sub-ranges by
 * round-aligning down to the previous 16-byte block.
 *
 * We expose a real `Blob` so callers can pass it to existing parsers
 * unchanged. Internally, when `arrayBuffer()` / `text()` / `stream()` is
 * called on the (sliced) blob, we read the encrypted bytes and run
 * `aesCtrEncrypt` to produce the plaintext.
 *
 * The implementation builds a real `Blob` by streaming: we use a
 * `ReadableStream` wired into `new Response().blob()`. This keeps memory
 * bounded because each chunk is decrypted, written, and then released.
 */
function createLazySectionBlob(params: LazySectionParams): Blob {
	const {
		source,
		start,
		end,
		cryptType,
		sectionCtr,
		sectionKey,
		plaintext,
		crypto,
		missingKeyDetail,
	} = params;

	const sectionSize = end - start;

	// If the parser already detected that we don't have the right key,
	// any read from this blob would silently return garbage. Surface a
	// real error instead so callers (PFS0/RomFS parsers, the UI) can
	// report it properly. The error carries the structured `detail`
	// so the UI can branch on `code` rather than parse the message.
	if (missingKeyDetail) {
		return makeFailingBlob(sectionSize, () => new NcaKeyError(missingKeyDetail));
	}

	// Plaintext / no-crypt sections: just slice the source — the resulting Blob
	// is naturally lazy and supports all Blob operations efficiently.
	if (plaintext || cryptType === NCA_CRYPT_NONE) {
		return source.slice(start, end);
	}

	// BKTR (4) is the patch-encoding scheme used by Update NCAs. It
	// uses an indirect bucket-tree at the end of the section to map
	// logical offsets to "look up in this section" vs "look up in the
	// base NCA", plus a separate AES-CTR-EX bucket-tree for per-region
	// counter overrides. Without the base NCA we can't reconstruct
	// the full content — and even the metadata is usually in the base
	// NCA (the patch just overlays a few files). So we surface a
	// clear error here instead of letting downstream parsers fail
	// with cryptic "DataView" errors on undecryptable bytes.
	if (cryptType === NCA_CRYPT_BKTR) {
		return makeFailingBlob(
			sectionSize,
			'BKTR patch section: this section is part of an Update NCA and references data in the base NCA, which would need to be supplied separately. Decoding patch sections standalone is not supported.',
		);
	}

	// Only AES-CTR is supported for lazy decryption. Anything else
	// (XTS sections, NCA0_XTS, …) falls through to handing back the
	// raw encrypted bytes — the caller sees garbled data but the
	// file is at least downloadable.
	if (cryptType !== NCA_CRYPT_CTR) {
		return source.slice(start, end);
	}

	const view = new LazyCtrSection(
		source,
		start,
		sectionSize,
		sectionCtr,
		sectionKey,
		crypto
	);
	return view.toBlob(0, sectionSize);
}

/**
 * Shared state for lazy decryption of a single NCA section.
 *
 * Provides `range(localStart, localEnd)` returning a `Promise<Uint8Array>` of
 * decrypted bytes for `[localStart, localEnd)` relative to the section's
 * start. Re-used across `Blob.slice()` chains.
 */
class LazyCtrSection {
	constructor(
		readonly source: Blob,
		readonly absStart: number,
		readonly size: number,
		readonly sectionCtr: Uint8Array,
		readonly sectionKey: Uint8Array,
		readonly crypto: Crypto
	) {}

	async range(localStart: number, localEnd: number): Promise<Uint8Array> {
		if (localEnd <= localStart) return new Uint8Array(0);
		const len = localEnd - localStart;
		// IMPORTANT: use arithmetic alignment, NOT bitwise (`& ~0xf`).
		// JS bitwise ops coerce to signed int32, which silently produces
		// negative results for values > 2^31 (~2.15 GB) — and NCA section
		// offsets in retail games routinely exceed that.
		const blockOffset = localStart - (localStart % 16);
		const skip = localStart - blockOffset;
		const blockEnd =
			localEnd % 16 === 0 ? localEnd : localEnd + (16 - (localEnd % 16));
		const padded = blockEnd - blockOffset;

		const absBlockStart = this.absStart + blockOffset;
		const absBlockEnd = absBlockStart + padded;

		const encBuf = await this.source
			.slice(absBlockStart, absBlockEnd)
			.arrayBuffer();
		const enc = new Uint8Array(encBuf);

		// Build CTR for this aligned offset.
		// `buildNcaCtr` expects the absolute offset within the NCA — relative to
		// the start of the *NCA*, not the section, since the byte_offset >> 4 is
		// the AES block index from the start of the NCA. The section CTR (high
		// 8 bytes) is what differentiates sections.
		//
		// The hacbrewpack reference uses byteOffset relative to the NCA — we
		// match that. The sectionCtr bytes go into ctr[0..8] reversed, and the
		// low 8 bytes are byteOffset >> 4 big-endian.
		const ctr = buildNcaCtr(this.sectionCtr, absBlockStart);

		const decrypted = await aesCtrEncrypt(this.sectionKey, enc, ctr, this.crypto);

		return decrypted.subarray(skip, skip + len);
	}

	toBlob(localStart: number, localEnd: number): Blob {
		const length = localEnd - localStart;

		// The minimal Blob facade we need:
		//   .size, .type, .arrayBuffer(), .text(), .slice(), .stream(), .bytes()
		// We build a real Blob via a ReadableStream so all native Blob methods
		// just work. To keep it lazy, we stream chunks through.
		//
		// However, building the Blob on construction would force a full read.
		// Instead we wrap with a custom object that implements the Blob shape
		// and only actually decrypts when a Blob method is called.
		// We type it as `Blob` since downstream parsers just call `.slice()`
		// and `.arrayBuffer()`.
		const self = this;

		const facade: Blob = {
			get size() {
				return length;
			},
			get type() {
				return '';
			},
			async arrayBuffer(): Promise<ArrayBuffer> {
				const u8 = await self.range(localStart, localEnd);
				// Always return a fresh ArrayBuffer (not a view). Some consumers
				// (DataView, etc.) will read past the byteOffset otherwise.
				const ab = new ArrayBuffer(u8.byteLength);
				new Uint8Array(ab).set(u8);
				return ab;
			},
			async bytes(): Promise<Uint8Array> {
				const u8 = await self.range(localStart, localEnd);
				return new Uint8Array(u8);
			},
			async text(): Promise<string> {
				const u8 = await self.range(localStart, localEnd);
				return new TextDecoder().decode(u8);
			},
			slice(start?: number, end?: number, _contentType?: string): Blob {
				const s = clamp(start ?? 0, 0, length);
				const e = clamp(end ?? length, s, length);
				return self.toBlob(localStart + s, localStart + e);
			},
			stream(): ReadableStream<Uint8Array> {
				// Stream in 64KB plaintext chunks.
				const CHUNK = 64 * 1024;
				let pos = localStart;
				return new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (pos >= localEnd) {
							controller.close();
							return;
						}
						const next = Math.min(pos + CHUNK, localEnd);
						try {
							const u8 = await self.range(pos, next);
							controller.enqueue(u8);
							pos = next;
						} catch (err) {
							controller.error(err);
						}
					},
				});
			},
		} as unknown as Blob;

		return facade;
	}
}

function clamp(v: number, lo: number, hi: number) {
	return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A `Blob`-shaped facade that throws a descriptive error from
 * every read method. Used when we know up-front we can't decrypt
 * this section, so we surface a clear error (typically an
 * {@link NcaKeyError}) instead of silently returning garbled
 * bytes.
 *
 * `makeError` is a thunk so callers can produce a fresh Error
 * instance per throw — important for stack traces and for
 * `instanceof` checks against subclasses like `NcaKeyError`.
 * A plain string is also accepted as a convenience for the
 * BKTR-patch-section case which doesn't need a structured type.
 */
function makeFailingBlob(
	size: number,
	makeError: string | (() => Error),
): Blob {
	const errorFactory: () => Error =
		typeof makeError === 'string'
			? () => new Error(makeError)
			: makeError;
	const fail = (): never => {
		throw errorFactory();
	};
	const facade: Blob = {
		get size() {
			return size;
		},
		get type() {
			return '';
		},
		arrayBuffer: fail,
		bytes: fail,
		text: fail,
		stream: fail,
		slice(start?: number, end?: number, _contentType?: string): Blob {
			const s = clamp(start ?? 0, 0, size);
			const e = clamp(end ?? size, s, size);
			return makeFailingBlob(e - s, errorFactory);
		},
	} as unknown as Blob;
	return facade;
}
