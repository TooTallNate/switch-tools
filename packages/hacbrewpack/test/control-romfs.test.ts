import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
	initializeKeySet,
	parseNca,
	createControlNca,
	NcaContentType,
} from '@tootallnate/nca';
import { encode as romfsEncode, decode as romfsDecode } from '@tootallnate/romfs';
import { NACP } from '../../nacp/src/index.js';

const KEYS_PATH = `${homedir()}/.switch/prod.keys`;
const HAS_KEYS = existsSync(KEYS_PATH);
const IVFC_BLOCK = 0x4000;

function padToIvfc(data: Uint8Array): { data: Uint8Array; originalSize: number } {
	const originalSize = data.length;
	const paddedSize =
		originalSize + ((IVFC_BLOCK - (originalSize % IVFC_BLOCK)) % IVFC_BLOCK);
	if (paddedSize === originalSize) return { data, originalSize };
	const padded = new Uint8Array(paddedSize);
	padded.set(data);
	return { data: padded, originalSize };
}

describe.skipIf(!HAS_KEYS)('createControlNca RomFS hash_data_size', () => {
	it('records the unpadded RomFS size and round-trips', async () => {
		const keys = await initializeKeySet(
			readFileSync(KEYS_PATH, 'utf8'),
			globalThis.crypto,
			1
		);

		const nacp = new NACP();
		nacp.id = '0123456789abcdef';
		nacp.title = 'Hash Data Size Test';
		nacp.author = 'switch-tools';
		nacp.version = '1.0.0';

		// Non-block-aligned icon → the control RomFS will NOT end on a 0x4000
		// boundary, exercising the previously-buggy padded-size code path.
		const icon = new Uint8Array(12345);
		for (let i = 0; i < icon.length; i++) icon[i] = (i * 13 + 7) & 0xff;

		const romfs = await romfsEncode({
			'control.nacp': new Blob([new Uint8Array(nacp.buffer)]),
			'icon_AmericanEnglish.dat': new Blob([icon]),
		});
		const romfsBytes = new Uint8Array(await romfs.arrayBuffer());
		const { data: padded, originalSize } = padToIvfc(romfsBytes);

		// Sanity: the fixture must be non-aligned to be meaningful.
		expect(originalSize % IVFC_BLOCK).not.toBe(0);
		expect(padded.length).toBeGreaterThan(originalSize);

		const control = await createControlNca({
			romfsData: padded,
			romfsOriginalSize: originalSize,
			titleId: BigInt('0x0123456789abcdef'),
			plaintext: true,
			keys,
		});

		const parsed = await parseNca(new Blob([control.data]), {
			keys,
		});
		expect(parsed.contentType).toBe(NcaContentType.Control);

		const sec = parsed.sections.find((s) => s.romfsData)!;
		expect(sec).toBeTruthy();

		// The fix: recorded RomFS size is the unpadded logical size, exactly
		// matching what hacbrewpack / the working forwarder produces.
		expect(sec.romfsSize).toBe(originalSize);
		expect(sec.romfsSize! % IVFC_BLOCK).not.toBe(0);

		// And it still decodes cleanly.
		const tree = await romfsDecode(sec.romfsData!);
		expect((tree['icon_AmericanEnglish.dat'] as Blob).size).toBe(icon.length);
		expect((tree['control.nacp'] as Blob).size).toBe(nacp.buffer.byteLength);
	});

	it('regression: without romfsOriginalSize it would record the padded size', async () => {
		// Documents the old (broken) behavior so the contract is explicit:
		// omitting romfsOriginalSize falls back to the padded buffer length.
		const keys = await initializeKeySet(
			readFileSync(KEYS_PATH, 'utf8'),
			globalThis.crypto,
			1
		);
		const raw = new Uint8Array(1000); // tiny, non-aligned
		const { data: padded } = padToIvfc(raw);

		const control = await createControlNca({
			romfsData: padded,
			// romfsOriginalSize intentionally omitted
			titleId: BigInt('0x0123456789abcdef'),
			plaintext: true,
			keys,
		});
		const parsed = await parseNca(new Blob([control.data]), {
			keys,
		});
		const sec = parsed.sections.find((s) => s.romfsData)!;
		// Falls back to padded length — this is the value that caused the
		// stuck-icon bug when callers forgot to pass the original size.
		expect(sec.romfsSize).toBe(padded.length);
		expect(sec.romfsSize! % IVFC_BLOCK).toBe(0);
	});
});
