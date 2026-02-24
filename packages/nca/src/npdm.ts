/**
 * NPDM (Nintendo Process Definition Metadata) parser and patcher.
 *
 * Reference: hacbrewpack/npdm.c, hacbrewpack/npdm.h
 */

import { RSA_PUBLIC_KEY_MODULUS } from './rsa.js';

const MAGIC_META = 0x4154454d; // "META"
const MAGIC_ACID = 0x44494341; // "ACID"
const MAGIC_ACI0 = 0x30494341; // "ACI0"

export interface NpdmInfo {
	/** Title ID extracted from ACI0 */
	titleId: bigint;
}

/**
 * Parse an NPDM binary, extract the title ID, and optionally patch
 * the ACID public key and title ID.
 *
 * @param npdmData - The raw main.npdm binary
 * @param options - Patch options
 * @returns Parsed NPDM info and (potentially modified) data
 */
export function processNpdm(
	npdmData: Uint8Array,
	options: {
		patchAcidKey?: boolean;
		titleIdOverride?: bigint;
	} = {}
): { info: NpdmInfo; data: Uint8Array } {
	const { patchAcidKey = true, titleIdOverride } = options;

	// Make a mutable copy
	const data = new Uint8Array(npdmData);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	// Validate NPDM header magic
	const npdmMagic = view.getUint32(0, true);
	if (npdmMagic !== MAGIC_META) {
		throw new Error(
			`Invalid NPDM magic: 0x${npdmMagic.toString(
				16
			)}, expected 0x${MAGIC_META.toString(16)} ("META")`
		);
	}

	// Get ACID and ACI0 offsets
	const aci0Offset = view.getUint32(0x70, true);
	const acidOffset = view.getUint32(0x78, true);

	// Validate ACI0 magic
	const aci0Magic = view.getUint32(aci0Offset, true);
	if (aci0Magic !== MAGIC_ACI0) {
		throw new Error(
			`Invalid ACI0 magic: 0x${aci0Magic.toString(
				16
			)}, expected 0x${MAGIC_ACI0.toString(16)}`
		);
	}

	// Validate ACID magic
	const acidMagic = view.getUint32(acidOffset + 0x200, true);
	if (acidMagic !== MAGIC_ACID) {
		throw new Error(
			`Invalid ACID magic: 0x${acidMagic.toString(
				16
			)}, expected 0x${MAGIC_ACID.toString(16)}`
		);
	}

	// Extract title ID from ACI0
	let titleId = view.getBigUint64(aci0Offset + 0x10, true);

	// Override title ID if requested
	if (titleIdOverride !== undefined) {
		titleId = titleIdOverride;
		view.setBigUint64(aci0Offset + 0x10, titleId, true);
	}

	// Validate title ID range
	if (titleId < 0x0100000000000000n || titleId > 0x0fffffffffffffffn) {
		throw new Error(
			`Title ID 0x${titleId.toString(
				16
			)} is outside valid range (0x0100000000000000 - 0x0fffffffffffffff)`
		);
	}

	// Patch ACID public key with our self-generated key
	if (patchAcidKey) {
		data.set(RSA_PUBLIC_KEY_MODULUS, acidOffset + 0x100);
	}

	return {
		info: { titleId },
		data,
	};
}
