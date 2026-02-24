import { describe, it, expect } from 'vitest';
import { parseKeyFile, initializeKeySet } from '../src/keys.js';

describe('Key file parser', () => {
	it('should parse key=value pairs', () => {
		const content = `
header_key = aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb
key_area_key_application_00 = 00112233445566778899aabbccddeeff
`;
		const keys = parseKeyFile(content);
		expect(keys.get('header_key')).toBe(
			'aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb'
		);
		expect(keys.get('key_area_key_application_00')).toBe(
			'00112233445566778899aabbccddeeff'
		);
	});

	it('should ignore comments and empty lines', () => {
		const content = `
# This is a comment
; Also a comment

header_key = aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb
`;
		const keys = parseKeyFile(content);
		expect(keys.size).toBe(1);
	});

	it('should be case-insensitive for key names', () => {
		const content = `Header_Key = aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb`;
		const keys = parseKeyFile(content);
		expect(keys.has('header_key')).toBe(true);
	});
});

describe('Key derivation', () => {
	it('should load directly-provided header_key', async () => {
		const headerKeyHex =
			'aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb';
		const kakHex = '00112233445566778899aabbccddeeff';
		const content = `
header_key = ${headerKeyHex}
key_area_key_application_00 = ${kakHex}
`;
		const ks = await initializeKeySet(content);

		// Header key should be loaded directly
		const actualHex = Array.from(ks.headerKey)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(actualHex).toBe(headerKeyHex);

		// KAK should be loaded
		const kakActual = Array.from(ks.keyAreaKeys[0][0])
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(kakActual).toBe(kakHex);
	});
});
