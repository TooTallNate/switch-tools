/**
 * @tootallnate/hacbrewpack
 *
 * TypeScript reimplementation of hacbrewpack — generates Nintendo Switch
 * NSP files from ExeFS, RomFS, and control data using native Web APIs.
 *
 * This is a byte-for-byte compatible replacement for the C hacbrewpack tool
 * (excluding RSA-PSS signatures which use random salt).
 *
 * Reference: hacbrewpack/main.c
 */

import { encode as encodeRomfs, type RomFsEntry } from '@tootallnate/romfs';
import {
	build as buildCnmt,
	ContentType,
	type ContentRecord,
} from '@tootallnate/cnmt';
import {
	initializeKeySet,
	processNpdm,
	createProgramNca,
	createControlNca,
	createMetaNca,
	createManualNca,
	buildPfs0,
	sha256,
	type KeySet,
	type Pfs0File,
	type NcaResult,
	type AesXtsEncryptFn,
} from '@tootallnate/nca';

export { type KeySet, type AesXtsEncryptFn } from '@tootallnate/nca';
export { type RomFsEntry } from '@tootallnate/romfs';

export interface HacbrewpackOptions {
	/**
	 * Key material — either the contents of a prod.keys file (string)
	 * or a pre-parsed KeySet.
	 */
	keys: string | KeySet;

	/**
	 * ExeFS files (required).
	 * Must include at minimum "main" and "main.npdm".
	 */
	exefs: Map<string, Blob | Uint8Array>;

	/**
	 * Control files (required).
	 * Must include "control.nacp" and at least one icon file.
	 */
	control: Map<string, Blob | Uint8Array>;

	/**
	 * RomFS directory tree (optional).
	 * If provided, a RomFS section is added to the Program NCA.
	 */
	romfs?: RomFsEntry;

	/**
	 * Logo files (optional).
	 * Typically "NintendoLogo.png" and "StartupMovie.gif".
	 */
	logo?: Map<string, Blob | Uint8Array>;

	/**
	 * HtmlDocument directory (optional).
	 * If provided, a Manual (HtmlDoc) NCA is created.
	 */
	htmldoc?: RomFsEntry;

	/**
	 * LegalInformation directory (optional).
	 * If provided, a Manual (LegalInfo) NCA is created.
	 */
	legalinfo?: RomFsEntry;

	/** Override title ID (16-character hex string, e.g., "0100000000000001") */
	titleId?: string;

	/** Key generation (default: 1) */
	keyGeneration?: number;

	/** Key area key (16 bytes, default: all 0x04) */
	keyAreaKey?: Uint8Array;

	/** SDK version (default: 0x000C1100) */
	sdkVersion?: number;

	/** Skip encryption (use zero/plaintext crypto) */
	plaintext?: boolean;

	/** Skip logo NCA creation */
	noLogo?: boolean;

	/** Don't patch NACP logo handling */
	noPatchNacpLogo?: boolean;

	/** Don't patch ACID public key */
	noPatchAcidKey?: boolean;

	/** Don't sign NCA header with RSA-PSS */
	noSignNcaSig2?: boolean;

	/** Override title name in NACP */
	titleName?: string;

	/** Override publisher in NACP */
	titlePublisher?: string;

	/** Optional Crypto implementation */
	crypto?: Crypto;

	/**
	 * Optional AES-XTS encrypt implementation.
	 * On nx.js, you can pass a function that uses the native
	 * crypto.subtle.encrypt('AES-XTS') for significantly better performance.
	 */
	aesXtsEncrypt?: AesXtsEncryptFn;
}

export interface HacbrewpackResult {
	/** The final NSP file as a Blob */
	nsp: Blob;
	/** The title ID used */
	titleId: string;
	/** NCA IDs generated (program, control, meta, etc.) */
	ncaIds: string[];
	/** NSP filename (titleid.nsp) */
	filename: string;
}

/** IVFC block size for padding RomFS data */
const IVFC_BLOCK_SIZE = 0x4000;

/**
 * Convert a RomFS Blob (or Promise<Blob>) to a Uint8Array padded to the
 * IVFC block boundary. Avoids an extra copy compared to the naive approach
 * of `new Uint8Array(await blob.arrayBuffer())` followed by `set()`.
 */
async function blobToIvfcPadded(
	blobOrPromise: Blob | Promise<Blob>
): Promise<Uint8Array> {
	const blob = await blobOrPromise;
	const buffer = await blob.arrayBuffer();
	const paddedSize =
		buffer.byteLength +
		((IVFC_BLOCK_SIZE - (buffer.byteLength % IVFC_BLOCK_SIZE)) %
			IVFC_BLOCK_SIZE);
	if (paddedSize === buffer.byteLength) {
		// Already aligned — no padding needed, use the buffer directly
		return new Uint8Array(buffer);
	}
	const padded = new Uint8Array(paddedSize);
	padded.set(new Uint8Array(buffer));
	return padded;
}

/**
 * Convert a Map<string, Blob|Uint8Array> to Uint8Array entries.
 */
async function mapToUint8Arrays(
	map: Map<string, Blob | Uint8Array>
): Promise<Map<string, Uint8Array>> {
	const result = new Map<string, Uint8Array>();
	for (const [name, data] of map) {
		if (data instanceof Uint8Array) {
			result.set(name, data);
		} else {
			result.set(name, new Uint8Array(await data.arrayBuffer()));
		}
	}
	return result;
}

/**
 * Build an NSP (Nintendo Submission Package) from input files.
 *
 * This replicates the full hacbrewpack pipeline:
 * 1. Load/derive encryption keys
 * 2. Process NPDM (extract title ID, patch ACID key)
 * 3. Process NACP (optional patches)
 * 4. Create Program NCA (ExeFS + optional RomFS + optional Logo)
 * 5. Create Control NCA (control RomFS)
 * 6. Optionally create HtmlDoc/LegalInfo Manual NCAs
 * 7. Create CNMT from NCA hashes
 * 8. Create Meta NCA (CNMT in PFS0)
 * 9. Package all NCAs into PFS0 → NSP
 */
export async function buildNsp(
	options: HacbrewpackOptions
): Promise<HacbrewpackResult> {
	const {
		keyGeneration = 1,
		keyAreaKey = new Uint8Array(16).fill(0x04),
		sdkVersion = 0x000c1100,
		plaintext = false,
		noLogo = false,
		noPatchNacpLogo = false,
		noPatchAcidKey = false,
		noSignNcaSig2 = false,
		titleName,
		titlePublisher,
		crypto = globalThis.crypto,
		aesXtsEncrypt,
	} = options;

	// 1. Load/derive keys (pass keyGeneration to skip unnecessary derivation)
	let keys: KeySet;
	if (typeof options.keys === 'string') {
		keys = await initializeKeySet(options.keys, crypto, keyGeneration);
	} else {
		keys = options.keys;
	}

	// Convert input files to Uint8Arrays
	const exefsMap = await mapToUint8Arrays(options.exefs);
	const controlMap = await mapToUint8Arrays(options.control);

	// 2. Process NPDM
	const npdmData = exefsMap.get('main.npdm');
	if (!npdmData) {
		throw new Error('ExeFS must contain "main.npdm"');
	}

	const titleIdOverride = options.titleId
		? BigInt(`0x${options.titleId}`)
		: undefined;

	const { info: npdmInfo, data: patchedNpdm } = processNpdm(npdmData, {
		patchAcidKey: !noPatchAcidKey,
		titleIdOverride,
	});

	const titleId = titleIdOverride ?? npdmInfo.titleId;
	const titleIdHex = titleId.toString(16).padStart(16, '0');

	// Update the NPDM in the exefs map
	exefsMap.set('main.npdm', patchedNpdm);

	// 3. Process NACP
	const nacpData = controlMap.get('control.nacp');
	if (!nacpData) {
		throw new Error('Control must contain "control.nacp"');
	}

	// Optionally patch NACP fields
	const nacp = new Uint8Array(nacpData);
	const nacpView = new DataView(
		nacp.buffer,
		nacp.byteOffset,
		nacp.byteLength
	);

	if (!noPatchNacpLogo) {
		nacp[0x30f1] = 0x00; // LogoHandling = Auto
	}

	if (titleName) {
		const encoder = new TextEncoder();
		const nameBytes = encoder.encode(titleName);
		for (let i = 0; i < 12; i++) {
			const offset = i * 0x300;
			nacp.fill(0, offset, offset + 0x200);
			nacp.set(
				nameBytes.subarray(0, Math.min(nameBytes.length, 0x1ff)),
				offset
			);
		}
	}

	if (titlePublisher) {
		const encoder = new TextEncoder();
		const pubBytes = encoder.encode(titlePublisher);
		for (let i = 0; i < 12; i++) {
			const offset = i * 0x300 + 0x200;
			nacp.fill(0, offset, offset + 0x100);
			nacp.set(
				pubBytes.subarray(0, Math.min(pubBytes.length, 0xff)),
				offset
			);
		}
	}

	controlMap.set('control.nacp', nacp);

	// 4. Create Program NCA
	const exefsFiles: Pfs0File[] = [];
	for (const [name, data] of exefsMap) {
		exefsFiles.push({ name, data });
	}

	// Build RomFS data if provided
	let romfsData: Uint8Array | undefined;
	if (options.romfs) {
		romfsData = await blobToIvfcPadded(encodeRomfs(options.romfs));
	}

	// Build Logo PFS0 files if provided
	let logoFiles: Pfs0File[] | undefined;
	if (!noLogo && options.logo) {
		const logoMap = await mapToUint8Arrays(options.logo);
		logoFiles = [];
		for (const [name, data] of logoMap) {
			logoFiles.push({ name, data });
		}
	}

	const commonOpts = {
		titleId,
		keyGeneration,
		keyAreaKey,
		sdkVersion,
		plaintext,
		keys,
		crypto,
		aesXtsEncrypt,
	};

	const programNca = await createProgramNca({
		...commonOpts,
		exefsFiles,
		romfsData,
		logoFiles,
		sign: !noSignNcaSig2,
	});

	// 5. Create Control NCA
	// Build control RomFS from the control files
	const controlRomfsEntry: RomFsEntry = {};
	for (const [name, data] of controlMap) {
		controlRomfsEntry[name] = new Blob([data]);
	}
	const controlRomfsData = await blobToIvfcPadded(
		encodeRomfs(controlRomfsEntry)
	);

	const controlNca = await createControlNca({
		...commonOpts,
		romfsData: controlRomfsData,
	});

	// 6. Optional Manual NCAs
	const ncaResults: NcaResult[] = [programNca, controlNca];
	const ncaIds: string[] = [programNca.ncaId, controlNca.ncaId];

	let htmldocNca: NcaResult | undefined;
	if (options.htmldoc) {
		htmldocNca = await createManualNca({
			...commonOpts,
			romfsData: await blobToIvfcPadded(encodeRomfs(options.htmldoc)),
		});
		ncaIds.push(htmldocNca.ncaId);
	}

	let legalinfoNca: NcaResult | undefined;
	if (options.legalinfo) {
		legalinfoNca = await createManualNca({
			...commonOpts,
			romfsData: await blobToIvfcPadded(encodeRomfs(options.legalinfo)),
		});
		ncaIds.push(legalinfoNca.ncaId);
	}

	// 7. Create CNMT
	const contentRecords: ContentRecord[] = [
		{
			hash: programNca.hash,
			ncaId: programNca.hash.subarray(0, 16),
			size: programNca.size,
			type: ContentType.Program,
		},
		{
			hash: controlNca.hash,
			ncaId: controlNca.hash.subarray(0, 16),
			size: controlNca.size,
			type: ContentType.Control,
		},
	];

	if (htmldocNca) {
		contentRecords.push({
			hash: htmldocNca.hash,
			ncaId: htmldocNca.hash.subarray(0, 16),
			size: htmldocNca.size,
			type: ContentType.HtmlDocument,
		});
	}

	if (legalinfoNca) {
		contentRecords.push({
			hash: legalinfoNca.hash,
			ncaId: legalinfoNca.hash.subarray(0, 16),
			size: legalinfoNca.size,
			type: ContentType.LegalInformation,
		});
	}

	const cnmtData = new Uint8Array(
		buildCnmt({
			titleId,
			contentRecords,
		})
	);

	const cnmtFilename = `Application_${titleIdHex}.cnmt`;

	// 8. Create Meta NCA
	const metaNca = await createMetaNca({
		...commonOpts,
		cnmtData,
		cnmtFilename,
	});
	ncaIds.push(metaNca.ncaId);

	// 9. Build NSP (PFS0 wrapping all NCAs)
	// Build the list of NCA files for the NSP container
	const nspFiles: Pfs0File[] = [];

	nspFiles.push({
		name: `${programNca.ncaId}.nca`,
		data: programNca.data,
	});
	nspFiles.push({
		name: `${controlNca.ncaId}.nca`,
		data: controlNca.data,
	});
	if (htmldocNca) {
		nspFiles.push({
			name: `${htmldocNca.ncaId}.nca`,
			data: htmldocNca.data,
		});
	}
	if (legalinfoNca) {
		nspFiles.push({
			name: `${legalinfoNca.ncaId}.nca`,
			data: legalinfoNca.data,
		});
	}
	nspFiles.push({
		name: `${metaNca.ncaId}.cnmt.nca`,
		data: metaNca.data,
	});

	const nspData = buildPfs0(nspFiles);

	return {
		nsp: new Blob([nspData]),
		titleId: titleIdHex,
		ncaIds,
		filename: `${titleIdHex}.nsp`,
	};
}
