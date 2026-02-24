import { describe, it, expect } from 'vitest';
import { processNpdm, RSA_PUBLIC_KEY_MODULUS } from '../src/index.js';

/**
 * Create a minimal valid NPDM for testing.
 */
function createTestNpdm(titleId: bigint): Uint8Array {
	// Minimal NPDM: META header + ACI0 + ACID
	// ACID starts at 0x200, magic is at acidOffset + 0x200 = 0x400
	// Modulus is at acidOffset + 0x100 = 0x300
	// Need at least 0x404 bytes to fit the ACID magic + 4 bytes
	const size = 0x500;
	const data = new Uint8Array(size);
	const view = new DataView(data.buffer);

	// NPDM header at 0x00
	view.setUint32(0x00, 0x4154454d, true); // "META"
	view.setUint32(0x70, 0x100, true); // aci0_offset = 0x100
	view.setUint32(0x74, 0x100, true); // aci0_size
	view.setUint32(0x78, 0x200, true); // acid_offset = 0x200
	view.setUint32(0x7c, 0x200, true); // acid_size

	// ACI0 at 0x100
	view.setUint32(0x100, 0x30494341, true); // "ACI0"
	view.setBigUint64(0x110, titleId, true); // title_id

	// ACID at 0x200 (signature at +0x000, modulus at +0x100, magic at +0x200)
	view.setUint32(0x200 + 0x200, 0x44494341, true); // "ACID"

	return data;
}

describe('NPDM processor', () => {
	it('should extract title ID from ACI0', () => {
		const titleId = 0x0100000000001234n;
		const npdm = createTestNpdm(titleId);
		const { info } = processNpdm(npdm);
		expect(info.titleId).toBe(titleId);
	});

	it('should patch ACID public key by default', () => {
		const npdm = createTestNpdm(0x0100000000001000n);
		const { data } = processNpdm(npdm);

		// ACID modulus is at acidOffset + 0x100 = 0x200 + 0x100 = 0x300
		const modulus = data.subarray(0x300, 0x300 + 0x100);
		expect(Array.from(modulus)).toEqual(Array.from(RSA_PUBLIC_KEY_MODULUS));
	});

	it('should not patch ACID key when disabled', () => {
		const npdm = createTestNpdm(0x0100000000001000n);
		const original = new Uint8Array(npdm);
		const { data } = processNpdm(npdm, { patchAcidKey: false });

		// Modulus should remain unchanged (all zeros)
		const modulus = data.subarray(0x300, 0x300 + 0x100);
		expect(modulus.every((b) => b === 0)).toBe(true);
	});

	it('should override title ID when requested', () => {
		const originalTitleId = 0x0100000000001000n;
		const overrideTitleId = 0x0100000000002000n;
		const npdm = createTestNpdm(originalTitleId);

		const { info } = processNpdm(npdm, {
			titleIdOverride: overrideTitleId,
		});
		expect(info.titleId).toBe(overrideTitleId);
	});

	it('should reject invalid NPDM magic', () => {
		const data = new Uint8Array(0x400);
		expect(() => processNpdm(data)).toThrow('Invalid NPDM magic');
	});

	it('should reject title IDs outside valid range', () => {
		const npdm = createTestNpdm(0x0000000000001000n);
		expect(() => processNpdm(npdm)).toThrow('outside valid range');
	});
});
