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
	 * Set when the KeySet doesn't have the right key to decrypt section
	 * bodies (typically because the user's `prod.keys` is older than the
	 * NCA's firmware target — e.g. a firmware-22 NCA opened with a key
	 * file that only goes up to master_key_0f).
	 *
	 * The header is still fully parsed when this is set (so the caller
	 * can show NCA metadata), but reading from a section's `data` blob
	 * will throw with this same message rather than silently producing
	 * garbage.
	 */
	missingKey: string | null;
	/** Sections present in this NCA (those whose entry start_media != 0). */
	sections: NcaSection[];
	/** SHA-256 hash of the entire NCA, hex-encoded (first 16 bytes used as NCA ID). */
	ncaId: string;
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
	let missingKey: string | null = null;
	const kaekIndexName = ['Application', 'Ocean', 'System'][kaekIndex] ?? `index ${kaekIndex}`;
	if (plaintext) {
		keyAreaDecrypted = new Uint8Array(keyAreaEncrypted);
	} else if (!kak || kak.every((b) => b === 0)) {
		// We don't have the KAEK for this generation. This is most often
		// caused by an out-of-date `prod.keys` — for example, opening a
		// firmware-22 NCA with a key file that only goes up to
		// `master_key_0f`. The caller may still inspect header metadata,
		// but section reads will throw a clear error.
		missingKey = `Missing key area key for generation ${keyGeneration} (${kaekIndexName}). Your prod.keys is likely older than this NCA — try updating it (e.g. with a recent Lockpick_RCM run).`;
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
			missingKey =
				`This NCA uses titlekey crypto (RightsId set) but no .tik file ` +
				`was supplied. The matching ticket should ship alongside the ` +
				`NCA in the NSP/XCI container.`;
		} else if (!titlekek || titlekek.every((b) => b === 0)) {
			missingKey = `Missing titlekek for generation ${keyGeneration}. Your prod.keys is likely older than this NCA.`;
		} else {
			sectionKey = await aesEcbDecrypt(
				titlekek,
				options.encryptedTitleKey,
				crypto,
			);
		}
	}

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
			missingKey: cryptType === NCA_CRYPT_NONE ? null : missingKey,
		});

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
			section.pfs0Data = sectionData.slice(pfs0Offset, pfs0Offset + pfs0Size);
		}
		if (romfsOffset !== undefined && romfsSize !== undefined) {
			section.romfsData = sectionData.slice(romfsOffset, romfsOffset + romfsSize);
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
		sections,
		ncaId,
	};
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
	 * If non-null, the parser detected that the user's KeySet doesn't
	 * contain the right key to decrypt this section. Reading the blob
	 * throws this message instead of silently returning garbage.
	 */
	missingKey: string | null;
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
		missingKey,
	} = params;

	const sectionSize = end - start;

	// If the parser already detected that we don't have the right key,
	// any read from this blob would silently return garbage. Surface a
	// real error instead so callers (PFS0/RomFS parsers, the UI) can
	// report it properly.
	if (missingKey) {
		return makeFailingBlob(sectionSize, missingKey);
	}

	// Plaintext / no-crypt sections: just slice the source — the resulting Blob
	// is naturally lazy and supports all Blob operations efficiently.
	if (plaintext || cryptType === NCA_CRYPT_NONE) {
		return source.slice(start, end);
	}

	// Only AES-CTR is supported for lazy decryption. BKTR sections are
	// patches that require a base NCA, which we don't model here.
	if (cryptType !== NCA_CRYPT_CTR) {
		// Fallback: return the encrypted slice. The caller will see garbled data,
		// but at least the file is downloadable.
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
 * A `Blob`-shaped facade that throws a descriptive error from every
 * read method. Used when we know up-front we can't decrypt this
 * section so we surface a clear "missing key" message instead of
 * silently returning garbled bytes.
 */
function makeFailingBlob(size: number, message: string): Blob {
	const fail = (): never => {
		throw new Error(message);
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
			return makeFailingBlob(e - s, message);
		},
	} as unknown as Blob;
	return facade;
}
