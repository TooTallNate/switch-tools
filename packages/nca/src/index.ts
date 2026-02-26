/**
 * NCA (Nintendo Content Archive) builder.
 *
 * Creates encrypted NCA files for Nintendo Switch packages.
 * Supports Program, Control, Meta, and Manual NCA types.
 *
 * Reference: hacbrewpack/nca.c, hacbrewpack/nca.h
 */

export { type KeySet, initializeKeySet, parseKeyFile } from './keys.js';
export { processNpdm, type NpdmInfo } from './npdm.js';
export { rsaSign, RSA_PUBLIC_KEY_MODULUS } from './rsa.js';
export {
	sha256,
	aesEcbEncrypt,
	aesEcbDecrypt,
	aesCtrEncrypt,
	buildNcaCtr,
	updateNcaCtr,
} from './crypto.js';
export {
	buildPfs0,
	createPfs0HashTable,
	calculatePfs0MasterHash,
	type Pfs0File,
} from './pfs0.js';

import { encrypt as aesXtsEncryptDefault } from '@tootallnate/aes-xts';
import { build as ivfcBuild, IVFC_HEADER_SIZE } from '@tootallnate/ivfc';

import {
	sha256,
	aesEcbEncrypt,
	aesCtrEncrypt,
	buildNcaCtr,
	updateNcaCtr,
} from './crypto.js';
import { rsaSign } from './rsa.js';
import type { KeySet } from './keys.js';
import {
	buildPfs0,
	createPfs0HashTable,
	calculatePfs0MasterHash,
	type Pfs0File,
} from './pfs0.js';

/**
 * Function that encrypts data using AES-128-XTS.
 * The key is already bound — the caller only provides the data and
 * sector parameters. This allows the key to be imported once
 * (via `crypto.subtle.importKey`) and reused across multiple NCA builds.
 *
 * On nx.js, you can create one using the native AES-XTS support:
 * ```ts
 * const cryptoKey = await crypto.subtle.importKey(
 *   'raw', headerKey, 'AES-XTS', false, ['encrypt']
 * );
 * const aesXtsEncrypt: AesXtsEncryptFn = (data, sectorSize, startSector) =>
 *   crypto.subtle.encrypt(
 *     { name: 'AES-XTS', sectorSize, startSector, nintendoTweak: true },
 *     cryptoKey,
 *     data
 *   );
 * ```
 */
export type AesXtsEncryptFn = (
	data: ArrayBuffer | Uint8Array,
	sectorSize: number,
	startSector: number
) => Promise<ArrayBuffer>;

/** NCA header total size: 0xC00 bytes */
const NCA_HEADER_SIZE = 0xc00;

/** Media unit size: 0x200 bytes */
const MEDIA_UNIT = 0x200;

/** NCA3 magic: 0x3341434E */
const MAGIC_NCA3 = 0x3341434e;

/** Hash block sizes for different PFS0 types */
const PFS0_EXEFS_HASH_BLOCK_SIZE = 0x10000; // 64KB
const PFS0_LOGO_HASH_BLOCK_SIZE = 0x1000; // 4KB
const PFS0_META_HASH_BLOCK_SIZE = 0x1000; // 4KB

/** Section crypto types */
const CRYPT_NONE = 1;
const CRYPT_CTR = 3;

/** Section hash types */
const HASH_TYPE_PFS0 = 2;
const HASH_TYPE_ROMFS = 3;

/** Section FS types */
const FS_TYPE_ROMFS = 0;
const FS_TYPE_PFS0 = 1;

/** NCA content types */
export enum NcaContentType {
	Program = 0,
	Meta = 1,
	Control = 2,
	Manual = 3,
}

function align(value: number, alignment: number): number {
	const mask = alignment - 1;
	return (value + mask) & ~mask;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Result of building an NCA.
 */
export interface NcaResult {
	/** The complete NCA binary data */
	data: Uint8Array;
	/** SHA-256 hash of the entire NCA */
	hash: Uint8Array;
	/** NCA ID (first 16 bytes of hash as hex) */
	ncaId: string;
	/** NCA file size */
	size: number;
}

interface NcaBuildOptions {
	titleId: bigint;
	contentType: NcaContentType;
	keyGeneration: number;
	keyAreaKey: Uint8Array;
	sdkVersion: number;
	plaintext: boolean;
	keys: KeySet;
	/** Sign the NCA header with RSA-PSS (only for Program NCA) */
	sign?: boolean;
	crypto?: Crypto;
	/** Optional AES-XTS encrypt implementation (defaults to software fallback) */
	aesXtsEncrypt?: AesXtsEncryptFn;
}

/**
 * Build a PFS0-based NCA section (ExeFS, Logo, or Meta).
 */
async function buildPfs0Section(
	pfs0Data: Uint8Array,
	hashBlockSize: number,
	crypto: Crypto
): Promise<{ sectionData: Uint8Array; fsHeader: Uint8Array }> {
	// Create hash table
	const { hashTable, hashTableSize, pfs0Offset } = await createPfs0HashTable(
		pfs0Data,
		hashBlockSize,
		crypto
	);

	// Calculate master hash
	const masterHash = await calculatePfs0MasterHash(
		hashTable,
		hashTableSize,
		crypto
	);

	// Build section data: hash table + PFS0
	const sectionData = new Uint8Array(hashTable.length + pfs0Data.length);
	sectionData.set(hashTable, 0);
	sectionData.set(pfs0Data, hashTable.length);

	// Build FS header (0x200 bytes)
	const fsHeader = new Uint8Array(0x200);
	const fsView = new DataView(
		fsHeader.buffer,
		fsHeader.byteOffset,
		fsHeader.byteLength
	);

	fsView.setUint16(0x00, 2, true); // version = 2
	fsHeader[0x02] = FS_TYPE_PFS0; // fs_type
	fsHeader[0x03] = HASH_TYPE_PFS0; // hash_type
	// crypt_type set by caller

	// PFS0 superblock (starts at offset 0x08 within the FS header)
	const sbOffset = 0x08;
	// master_hash (0x20 bytes)
	fsHeader.set(masterHash, sbOffset + 0x00);
	// block_size (4 bytes)
	fsView.setUint32(sbOffset + 0x20, hashBlockSize, true);
	// always_2 (4 bytes)
	fsView.setUint32(sbOffset + 0x24, 2, true);
	// hash_table_offset (8 bytes) — always 0
	// hash_table_size (8 bytes)
	fsView.setBigUint64(sbOffset + 0x28, BigInt(0), true);
	fsView.setBigUint64(sbOffset + 0x30, BigInt(hashTableSize), true);
	// pfs0_offset (8 bytes)
	fsView.setBigUint64(sbOffset + 0x38, BigInt(pfs0Offset), true);
	// pfs0_size (8 bytes)
	fsView.setBigUint64(sbOffset + 0x40, BigInt(pfs0Data.length), true);

	return { sectionData, fsHeader };
}

/**
 * Build a RomFS-based NCA section (Control RomFS, Program RomFS, Manual).
 */
async function buildRomfsSection(
	romfsData: Uint8Array,
	crypto: Crypto
): Promise<{ sectionData: Uint8Array; fsHeader: Uint8Array }> {
	// Build IVFC hash tree
	const ivfc = await ivfcBuild(romfsData, crypto);

	// Section data: level1..level5 + data (level6)
	// The IVFC levels are stored as: level1, level2, ..., level5, then data (level6)
	let sectionSize = 0;
	for (const level of ivfc.levels) {
		sectionSize += level.length;
	}
	sectionSize += romfsData.length;

	const sectionData = new Uint8Array(sectionSize);
	let offset = 0;
	for (const level of ivfc.levels) {
		sectionData.set(level, offset);
		offset += level.length;
	}
	sectionData.set(romfsData, offset);

	// Build FS header (0x200 bytes) — embed the IVFC header directly
	const fsHeader = new Uint8Array(0x200);
	const fsView = new DataView(
		fsHeader.buffer,
		fsHeader.byteOffset,
		fsHeader.byteLength
	);

	fsView.setUint16(0x00, 2, true); // version = 2
	fsHeader[0x02] = FS_TYPE_ROMFS; // fs_type
	fsHeader[0x03] = HASH_TYPE_ROMFS; // hash_type
	// crypt_type set by caller

	// RomFS superblock = IVFC header (0xE0 bytes) at offset 0x08
	new Uint8Array(fsHeader.buffer, 0x08, IVFC_HEADER_SIZE).set(
		new Uint8Array(ivfc.header)
	);

	return { sectionData, fsHeader };
}

/**
 * Assemble a complete NCA from sections.
 */
async function assembleNca(
	sections: Array<{
		sectionData: Uint8Array;
		fsHeader: Uint8Array;
		cryptType: number;
	}>,
	options: NcaBuildOptions
): Promise<NcaResult> {
	const {
		titleId,
		contentType,
		keyGeneration,
		keyAreaKey,
		sdkVersion,
		plaintext,
		keys,
		sign = false,
		crypto = globalThis.crypto,
	} = options;

	// Build the AES-XTS encrypt function — either caller-provided or default
	const aesXtsEncrypt: AesXtsEncryptFn =
		options.aesXtsEncrypt ??
		((data, sectorSize, startSector) =>
			aesXtsEncryptDefault(
				keys.headerKey,
				data,
				sectorSize,
				startSector,
				crypto
			));

	// Calculate total NCA size
	let totalBodySize = 0;
	const sectionOffsets: number[] = [];
	for (const section of sections) {
		sectionOffsets.push(NCA_HEADER_SIZE + totalBodySize);
		const paddedSize = align(section.sectionData.length, MEDIA_UNIT);
		totalBodySize += paddedSize;
	}

	const totalSize = NCA_HEADER_SIZE + totalBodySize;

	// Allocate the entire NCA
	const nca = new Uint8Array(totalSize);
	const ncaView = new DataView(nca.buffer);

	// Write section data
	for (let i = 0; i < sections.length; i++) {
		nca.set(sections[i].sectionData, sectionOffsets[i]);
	}

	// Build NCA header at offset 0
	const headerOffset = 0x200; // Header fields start at 0x200 (after two RSA signatures)

	// Magic
	ncaView.setUint32(headerOffset + 0x00, MAGIC_NCA3, true);
	// Distribution (0 = system download)
	nca[headerOffset + 0x04] = 0;
	// Content type
	nca[headerOffset + 0x05] = contentType;
	// Crypto type (keygeneration field 1)
	if (keyGeneration === 1) {
		nca[headerOffset + 0x06] = 0;
	} else {
		nca[headerOffset + 0x06] = 2;
	}
	// KAEK index (0 = application)
	nca[headerOffset + 0x07] = 0;
	// NCA size (8 bytes)
	ncaView.setBigUint64(headerOffset + 0x08, BigInt(totalSize), true);
	// Title ID (8 bytes)
	ncaView.setBigUint64(headerOffset + 0x10, titleId, true);
	// Padding (4 bytes at 0x218) — already zero
	// SDK version (4 bytes)
	ncaView.setUint32(headerOffset + 0x1c, sdkVersion, true);
	// Crypto type 2 (keygeneration field 2)
	if (keyGeneration > 2) {
		nca[headerOffset + 0x20] = keyGeneration;
	}
	// Rights ID (16 bytes at 0x230) — all zero (no titlekey crypto)

	// Section entries (at header offset 0x40 = absolute 0x240)
	for (let i = 0; i < sections.length; i++) {
		const entryOffset = headerOffset + 0x40 + i * 0x10;
		const startMedia = Math.floor(sectionOffsets[i] / MEDIA_UNIT);
		const endMedia = Math.floor(
			(sectionOffsets[i] +
				align(sections[i].sectionData.length, MEDIA_UNIT)) /
				MEDIA_UNIT
		);
		ncaView.setUint32(entryOffset + 0x00, startMedia, true);
		ncaView.setUint32(entryOffset + 0x04, endMedia, true);
		nca[entryOffset + 0x08] = 1; // Always 1
	}

	// Set crypt type in each FS header and calculate section hashes
	for (let i = 0; i < sections.length; i++) {
		sections[i].fsHeader[0x04] = sections[i].cryptType;
	}

	// SHA-256 section hashes (at header offset 0x80 = absolute 0x280)
	for (let i = 0; i < sections.length; i++) {
		const sectionHash = await sha256(sections[i].fsHeader, crypto);
		nca.set(sectionHash, headerOffset + 0x80 + i * 0x20);
	}

	// Encrypted key area (at header offset 0x100 = absolute 0x300)
	// Key slot 2 = the key area key for section encryption
	nca.set(keyAreaKey, headerOffset + 0x100 + 2 * 0x10);

	// FS headers (at offset 0x400, each 0x200 bytes)
	for (let i = 0; i < sections.length; i++) {
		nca.set(sections[i].fsHeader, 0x400 + i * 0x200);
	}

	// Set section CTR in each FS header
	for (let i = 0; i < sections.length; i++) {
		const fsHeaderAbsOffset = 0x400 + i * 0x200;
		// section_ctr is at offset 0x140 within the FS header (8 bytes)
		// The high 4 bytes of the CTR are the generation counter (set based on section index)
		ncaView.setUint32(fsHeaderAbsOffset + 0x140, i, true);
	}

	// Recalculate section hashes after setting CTR
	for (let i = 0; i < sections.length; i++) {
		const fsHeaderData = nca.subarray(
			0x400 + i * 0x200,
			0x400 + (i + 1) * 0x200
		);
		const sectionHash = await sha256(fsHeaderData, crypto);
		nca.set(sectionHash, headerOffset + 0x80 + i * 0x20);
	}

	// --- Encryption ---

	// Encrypt section bodies with AES-128-CTR (if not plaintext)
	if (!plaintext) {
		for (let i = 0; i < sections.length; i++) {
			if (sections[i].cryptType === CRYPT_NONE) continue;

			const startOffset = sectionOffsets[i];
			const endOffset =
				sectionOffsets[i] +
				align(sections[i].sectionData.length, MEDIA_UNIT);
			const sectionSize = endOffset - startOffset;

			// Get section CTR from FS header
			const sectionCtr = nca.subarray(
				0x400 + i * 0x200 + 0x140,
				0x400 + i * 0x200 + 0x148
			);

			// Build initial CTR
			const ctr = buildNcaCtr(sectionCtr, startOffset);

			// Encrypt the section in chunks (Web Crypto handles the CTR incrementing)
			const encrypted = await aesCtrEncrypt(
				keyAreaKey,
				nca.subarray(startOffset, endOffset),
				ctr,
				crypto
			);
			nca.set(encrypted, startOffset);
		}
	}

	// Encrypt key area with AES-128-ECB
	const encryptedKeyArea = await aesEcbEncrypt(
		keys.keyAreaKeys[keyGeneration - 1][0],
		nca.subarray(0x300, 0x340),
		crypto
	);
	nca.set(encryptedKeyArea, 0x300);

	// Sign NCA header with RSA-PSS (only Program NCA)
	if (sign) {
		// Sign bytes 0x200-0x400 (the header fields + section entries + hashes + key area)
		const signature = await rsaSign(nca.subarray(0x200, 0x400), crypto);
		nca.set(signature, 0x100); // npdm_key_sig at offset 0x100
	}

	// Encrypt header with AES-128-XTS
	const encryptedHeader = await aesXtsEncrypt(
		nca.subarray(0, NCA_HEADER_SIZE),
		0x200, // sector size
		0 // start sector
	);
	nca.set(new Uint8Array(encryptedHeader), 0);

	// Calculate NCA hash and ID
	const hash = await sha256(nca, crypto);
	const ncaId = bytesToHex(hash.subarray(0, 16));

	return {
		data: nca,
		hash,
		ncaId,
		size: totalSize,
	};
}

// --- Public NCA creation functions ---

export interface CreateProgramNcaOptions {
	/** ExeFS files (e.g., {"main": data, "main.npdm": data}) */
	exefsFiles: Pfs0File[];
	/** Optional RomFS binary data (pre-encoded) */
	romfsData?: Uint8Array;
	/** Optional Logo PFS0 files */
	logoFiles?: Pfs0File[];
	/** NCA construction options */
	titleId: bigint;
	keyGeneration?: number;
	keyAreaKey?: Uint8Array;
	sdkVersion?: number;
	plaintext?: boolean;
	keys: KeySet;
	sign?: boolean;
	crypto?: Crypto;
	/** Optional AES-XTS encrypt implementation (defaults to software fallback) */
	aesXtsEncrypt?: AesXtsEncryptFn;
}

/**
 * Create a Program NCA (content_type = 0).
 *
 * Section 0: ExeFS (PFS0 with SHA-256 hash table)
 * Section 1 (optional): RomFS (IVFC hash tree)
 * Section 2 (optional): Logo (PFS0, always plaintext)
 */
export async function createProgramNca(
	options: CreateProgramNcaOptions
): Promise<NcaResult> {
	const {
		exefsFiles,
		romfsData,
		logoFiles,
		titleId,
		keyGeneration = 1,
		keyAreaKey = new Uint8Array(16).fill(0x04),
		sdkVersion = 0x000c1100,
		plaintext = false,
		keys,
		sign = true,
		crypto = globalThis.crypto,
		aesXtsEncrypt,
	} = options;

	const sections: Array<{
		sectionData: Uint8Array;
		fsHeader: Uint8Array;
		cryptType: number;
	}> = [];

	// Section 0: ExeFS
	const exefsPfs0 = buildPfs0(exefsFiles);
	const exefsSection = await buildPfs0Section(
		exefsPfs0,
		PFS0_EXEFS_HASH_BLOCK_SIZE,
		crypto
	);
	sections.push({
		...exefsSection,
		cryptType: plaintext ? CRYPT_NONE : CRYPT_CTR,
	});

	// Section 1: RomFS (optional)
	if (romfsData) {
		const romfsSection = await buildRomfsSection(romfsData, crypto);
		sections.push({
			...romfsSection,
			cryptType: plaintext ? CRYPT_NONE : CRYPT_CTR,
		});
	}

	// Section 2: Logo (optional, always plaintext)
	if (logoFiles && logoFiles.length > 0) {
		const logoPfs0 = buildPfs0(logoFiles);
		const logoSection = await buildPfs0Section(
			logoPfs0,
			PFS0_LOGO_HASH_BLOCK_SIZE,
			crypto
		);
		sections.push({
			...logoSection,
			cryptType: CRYPT_NONE, // Logo is always plaintext
		});
	}

	return assembleNca(sections, {
		titleId,
		contentType: NcaContentType.Program,
		keyGeneration,
		keyAreaKey,
		sdkVersion,
		plaintext,
		keys,
		sign,
		crypto,
		aesXtsEncrypt,
	});
}

export interface CreateControlNcaOptions {
	/** Pre-encoded RomFS binary data for the control section */
	romfsData: Uint8Array;
	titleId: bigint;
	keyGeneration?: number;
	keyAreaKey?: Uint8Array;
	sdkVersion?: number;
	plaintext?: boolean;
	keys: KeySet;
	crypto?: Crypto;
	/** Optional AES-XTS encrypt implementation (defaults to software fallback) */
	aesXtsEncrypt?: AesXtsEncryptFn;
}

/**
 * Create a Control NCA (content_type = 2).
 * Section 0: RomFS (IVFC hash tree) containing control.nacp and icons.
 */
export async function createControlNca(
	options: CreateControlNcaOptions
): Promise<NcaResult> {
	const {
		romfsData,
		titleId,
		keyGeneration = 1,
		keyAreaKey = new Uint8Array(16).fill(0x04),
		sdkVersion = 0x000c1100,
		plaintext = false,
		keys,
		crypto = globalThis.crypto,
		aesXtsEncrypt,
	} = options;

	const romfsSection = await buildRomfsSection(romfsData, crypto);

	return assembleNca(
		[
			{
				...romfsSection,
				cryptType: plaintext ? CRYPT_NONE : CRYPT_CTR,
			},
		],
		{
			titleId,
			contentType: NcaContentType.Control,
			keyGeneration,
			keyAreaKey,
			sdkVersion,
			plaintext,
			keys,
			sign: false,
			crypto,
			aesXtsEncrypt,
		}
	);
}

export interface CreateMetaNcaOptions {
	/** CNMT binary data */
	cnmtData: Uint8Array;
	/** CNMT filename (e.g., "Application_0100000000000001.cnmt") */
	cnmtFilename: string;
	titleId: bigint;
	keyGeneration?: number;
	keyAreaKey?: Uint8Array;
	sdkVersion?: number;
	plaintext?: boolean;
	keys: KeySet;
	crypto?: Crypto;
	/** Optional AES-XTS encrypt implementation (defaults to software fallback) */
	aesXtsEncrypt?: AesXtsEncryptFn;
}

/**
 * Create a Meta NCA (content_type = 1).
 * Section 0: PFS0 containing the CNMT file.
 */
export async function createMetaNca(
	options: CreateMetaNcaOptions
): Promise<NcaResult> {
	const {
		cnmtData,
		cnmtFilename,
		titleId,
		keyGeneration = 1,
		keyAreaKey = new Uint8Array(16).fill(0x04),
		sdkVersion = 0x000c1100,
		plaintext = false,
		keys,
		crypto = globalThis.crypto,
		aesXtsEncrypt,
	} = options;

	const metaPfs0 = buildPfs0([{ name: cnmtFilename, data: cnmtData }]);
	const metaSection = await buildPfs0Section(
		metaPfs0,
		PFS0_META_HASH_BLOCK_SIZE,
		crypto
	);

	return assembleNca(
		[
			{
				...metaSection,
				cryptType: plaintext ? CRYPT_NONE : CRYPT_CTR,
			},
		],
		{
			titleId,
			contentType: NcaContentType.Meta,
			keyGeneration,
			keyAreaKey,
			sdkVersion,
			plaintext,
			keys,
			sign: false,
			crypto,
			aesXtsEncrypt,
		}
	);
}

export interface CreateManualNcaOptions {
	/** Pre-encoded RomFS binary data */
	romfsData: Uint8Array;
	titleId: bigint;
	keyGeneration?: number;
	keyAreaKey?: Uint8Array;
	sdkVersion?: number;
	plaintext?: boolean;
	keys: KeySet;
	crypto?: Crypto;
	/** Optional AES-XTS encrypt implementation (defaults to software fallback) */
	aesXtsEncrypt?: AesXtsEncryptFn;
}

/**
 * Create a Manual NCA (content_type = 3).
 * Used for HtmlDocument and LegalInformation.
 * Section 0: RomFS (IVFC hash tree).
 */
export async function createManualNca(
	options: CreateManualNcaOptions
): Promise<NcaResult> {
	const {
		romfsData,
		titleId,
		keyGeneration = 1,
		keyAreaKey = new Uint8Array(16).fill(0x04),
		sdkVersion = 0x000c1100,
		plaintext = false,
		keys,
		crypto = globalThis.crypto,
		aesXtsEncrypt,
	} = options;

	const romfsSection = await buildRomfsSection(romfsData, crypto);

	return assembleNca(
		[
			{
				...romfsSection,
				cryptType: plaintext ? CRYPT_NONE : CRYPT_CTR,
			},
		],
		{
			titleId,
			contentType: NcaContentType.Manual,
			keyGeneration,
			keyAreaKey,
			sdkVersion,
			plaintext,
			keys,
			sign: false,
			crypto,
			aesXtsEncrypt,
		}
	);
}
