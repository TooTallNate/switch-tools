import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
	LZ4_FRAME_MAGIC,
	LZ4_LEGACY_MAGIC,
	decodeBlock,
	decompressLz4,
	decompressLz4Frame,
	decompressLz4Legacy,
	decompressLz4Switch,
	detectLz4,
	isLz4Frame,
	isLz4Legacy,
	isLz4Switch,
} from '../src/index.js';

/**
 * Build a *minimal* valid LZ4 block by encoding the entire input as
 * one long literal run. This is the worst-possible compression
 * ratio (slightly expands the data) but it's a guaranteed-valid
 * block that exercises both literal-length encoding paths.
 *
 * Encoding:
 *   - One sequence: token byte + literals.
 *   - Token high nibble = literal length (0..14, or 15 + extension).
 *   - Token low nibble = 0 (no match — but this would imply
 *     match-length=4 which the spec says only the *last* sequence
 *     can avoid). Since this IS the last sequence, the low nibble
 *     is don't-care and we use 0.
 */
function encodeAsLiterals(payload: Uint8Array): Uint8Array {
	const len = payload.length;
	if (len < 15) {
		// Single token byte + literals.
		const out = new Uint8Array(1 + len);
		out[0] = (len << 4) & 0xf0;
		out.set(payload, 1);
		return out;
	}
	// Token + extension bytes + literals.
	const extra = len - 15;
	const numExtBytes = Math.floor(extra / 255) + 1;
	const out = new Uint8Array(1 + numExtBytes + len);
	out[0] = 0xf0;
	let pos = 1;
	let remaining = extra;
	while (remaining >= 255) {
		out[pos++] = 0xff;
		remaining -= 255;
	}
	out[pos++] = remaining;
	out.set(payload, pos);
	return out;
}

describe('decodeBlock', () => {
	it('decodes a literal-only block', () => {
		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const block = encodeAsLiterals(payload);
		const out = decodeBlock(block, payload.length);
		expect(out).toEqual(payload);
	});

	it('decodes a literal-only block with length extension', () => {
		const payload = new Uint8Array(300);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const block = encodeAsLiterals(payload);
		const out = decodeBlock(block, payload.length);
		expect(out).toEqual(payload);
	});

	it('decodes a back-reference (offset=4 length=4)', () => {
		// "ABCDEFG" then back-ref offset=4 length=4 → "ABCDEFGDEFG".
		// Token: literal_len=7 (high nibble), match_len=0 (= +4 minmatch = 4 bytes).
		// Sequence: 0x70, 'A','B','C','D','E','F','G', offset_lo=0x04, offset_hi=0x00, [no extra match-len since low nibble != 0xF].
		// But that's not the last sequence — we need a final literal-only
		// sequence after, even if zero-length. LZ4 spec: last 5 bytes
		// are always literals; a strict decoder might reject otherwise.
		// Our decoder just stops at end-of-input, so a single sequence
		// works for testing.
		const block = new Uint8Array([
			0x70, // token: 7 literals, match-length nibble = 0
			0x41,
			0x42,
			0x43,
			0x44,
			0x45,
			0x46,
			0x47, // ABCDEFG
			0x04,
			0x00, // offset = 4 LE
		]);
		const out = decodeBlock(block, 11);
		expect(Array.from(out)).toEqual([
			0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x44, 0x45, 0x46,
			0x47,
		]);
	});

	it('decodes overlapping (RLE-style) back-references', () => {
		// Emit 'Z', then back-ref offset=1 length=10. Result: 'Z' × 11.
		const block = new Uint8Array([
			0x16, // 1 literal, match-length nibble = 6 (= +4 = 10 bytes)
			0x5a,
			0x01,
			0x00, // offset = 1
		]);
		const out = decodeBlock(block, 11);
		expect(out.every((b) => b === 0x5a)).toBe(true);
	});

	it('throws on offset == 0', () => {
		const block = new Uint8Array([
			0x10, // 1 literal, match-length nibble = 0
			0x42,
			0x00,
			0x00, // offset = 0 (invalid)
		]);
		expect(() => decodeBlock(block, 5)).toThrow(/invalid match offset 0/);
	});

	it('throws when output size mismatches in strict mode', () => {
		const block = encodeAsLiterals(new Uint8Array([1, 2, 3]));
		expect(() => decodeBlock(block, 10)).toThrow(/decoded 3 bytes/);
	});

	it('shrinks output when allowShorter is set', () => {
		const block = encodeAsLiterals(new Uint8Array([1, 2, 3]));
		const out = decodeBlock(block, 100, { allowShorter: true });
		expect(out.length).toBe(3);
		expect(Array.from(out)).toEqual([1, 2, 3]);
	});
});

describe('Switch firmware wrapper', () => {
	function makeSwitchLz4(payload: Uint8Array): Uint8Array {
		const block = encodeAsLiterals(payload);
		const out = new Uint8Array(4 + block.length);
		new DataView(out.buffer).setUint32(0, payload.length, true);
		out.set(block, 4);
		return out;
	}

	it('decompresses a small payload', async () => {
		const payload = new TextEncoder().encode('Hello, Switch firmware!');
		const wrapped = makeSwitchLz4(payload);
		const blob = new Blob([wrapped as BlobPart]);
		const out = await decompressLz4Switch(blob);
		expect(out.size).toBe(payload.length);
		expect(new Uint8Array(await out.arrayBuffer())).toEqual(payload);
	});

	it('isLz4Switch accepts plausible blobs', async () => {
		const wrapped = makeSwitchLz4(new Uint8Array(100));
		expect(await isLz4Switch(new Blob([wrapped as BlobPart]))).toBe(true);
	});

	it('isLz4Switch rejects obviously-bogus declared sizes', async () => {
		// declared size = 0xFFFFFFFF, payload = 1 byte → ratio 4 billion
		const buf = new Uint8Array(5);
		buf[0] = buf[1] = buf[2] = buf[3] = 0xff;
		expect(await isLz4Switch(new Blob([buf as BlobPart]))).toBe(false);
	});

	it('isLz4Switch rejects too-small blobs', async () => {
		expect(await isLz4Switch(new Blob([new Uint8Array(3) as BlobPart]))).toBe(
			false,
		);
	});
});

describe('Standard frame format', () => {
	/**
	 * Build a minimal LZ4 frame: magic + flg (version 01, no flags) +
	 * bd (max-size enum 4 = 64K) + hc (header checksum byte, ignored
	 * by our decoder) + one block + EndMark.
	 */
	function makeFrame(payload: Uint8Array): Uint8Array {
		const block = encodeAsLiterals(payload);
		const out = new Uint8Array(4 + 3 + 4 + block.length + 4);
		const view = new DataView(out.buffer);
		view.setUint32(0, LZ4_FRAME_MAGIC, true);
		out[4] = 0x40; // FLG: version=01, all other flags off
		out[5] = 0x40; // BD: block max size enum = 4 (64K)
		out[6] = 0x00; // HC: ignored
		view.setUint32(7, block.length, true); // block size, high bit clear = compressed
		out.set(block, 11);
		view.setUint32(11 + block.length, 0, true); // EndMark
		return out;
	}

	it('decompresses a single-block frame', async () => {
		const payload = new TextEncoder().encode('frame format test');
		const frame = makeFrame(payload);
		const blob = new Blob([frame as BlobPart]);
		expect(await isLz4Frame(blob)).toBe(true);
		const out = await decompressLz4Frame(blob);
		expect(new Uint8Array(await out.arrayBuffer())).toEqual(payload);
	});

	it('handles uncompressed (high-bit-set) blocks', async () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		// Pretend it's "uncompressed" — same bytes, high bit set.
		const out = new Uint8Array(4 + 3 + 4 + payload.length + 4);
		const view = new DataView(out.buffer);
		view.setUint32(0, LZ4_FRAME_MAGIC, true);
		out[4] = 0x40;
		out[5] = 0x40;
		out[6] = 0x00;
		view.setUint32(7, payload.length | 0x80000000, true);
		out.set(payload, 11);
		view.setUint32(11 + payload.length, 0, true);
		const decoded = await decompressLz4Frame(new Blob([out as BlobPart]));
		expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(payload);
	});

	it('throws on bad magic', async () => {
		const buf = new Uint8Array(20);
		await expect(
			decompressLz4Frame(new Blob([buf as BlobPart])),
		).rejects.toThrow(/magic/);
	});
});

describe('Legacy frame format', () => {
	function makeLegacy(payload: Uint8Array): Uint8Array {
		const block = encodeAsLiterals(payload);
		const out = new Uint8Array(4 + 4 + block.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, LZ4_LEGACY_MAGIC, true);
		view.setUint32(4, block.length, true);
		out.set(block, 8);
		return out;
	}

	it('decompresses a single-block legacy frame', async () => {
		const payload = new TextEncoder().encode('legacy frame');
		const frame = makeLegacy(payload);
		const blob = new Blob([frame as BlobPart]);
		expect(await isLz4Legacy(blob)).toBe(true);
		const out = await decompressLz4Legacy(blob);
		expect(new Uint8Array(await out.arrayBuffer())).toEqual(payload);
	});

	it('throws on bad magic', async () => {
		const buf = new Uint8Array(20);
		await expect(
			decompressLz4Legacy(new Blob([buf as BlobPart])),
		).rejects.toThrow(/magic/);
	});
});

describe('detectLz4 / decompressLz4 (auto-detect)', () => {
	function makeSwitchLz4(payload: Uint8Array): Uint8Array {
		const block = encodeAsLiterals(payload);
		const out = new Uint8Array(4 + block.length);
		new DataView(out.buffer).setUint32(0, payload.length, true);
		out.set(block, 4);
		return out;
	}

	it('detects standard frame magic', async () => {
		const buf = new Uint8Array(8);
		new DataView(buf.buffer).setUint32(0, LZ4_FRAME_MAGIC, true);
		const det = await detectLz4(new Blob([buf as BlobPart]));
		expect(det.variant).toBe('frame');
	});

	it('detects legacy frame magic', async () => {
		const buf = new Uint8Array(8);
		new DataView(buf.buffer).setUint32(0, LZ4_LEGACY_MAGIC, true);
		const det = await detectLz4(new Blob([buf as BlobPart]));
		expect(det.variant).toBe('legacy');
	});

	it('falls back to switch wrapper when no magic matches', async () => {
		const wrapped = makeSwitchLz4(new TextEncoder().encode('hello'));
		const det = await detectLz4(new Blob([wrapped as BlobPart]));
		expect(det.variant).toBe('switch');
	});

	it('round-trips a switch wrapper through auto-detect', async () => {
		const payload = new TextEncoder().encode('auto-detected switch');
		const wrapped = makeSwitchLz4(payload);
		const { data, variant } = await decompressLz4(
			new Blob([wrapped as BlobPart]),
		);
		expect(variant).toBe('switch');
		expect(new Uint8Array(await data.arrayBuffer())).toEqual(payload);
	});
});

// Real-data test: only run if a sample is present on disk. The
// extraction script in the repo's history (run once locally) writes
// firmware-NCA samples to /tmp/lz4-samples/.
const REAL_SAMPLE =
	'/tmp/lz4-samples/section0_nro_netfront_core_0_default_cfi_disabled_libfont.nro.lz4';
describe.runIf(existsSync(REAL_SAMPLE))(
	'real-world Switch firmware sample',
	() => {
		it('decompresses libfont.nro.lz4 to a valid NRO0 file', async () => {
			const bytes = readFileSync(REAL_SAMPLE);
			const blob = new Blob([new Uint8Array(bytes) as BlobPart]);
			const { data, variant } = await decompressLz4(blob);
			expect(variant).toBe('switch');
			// First 0x10 bytes are the BrS_ start stub (zeros), then "NRO0".
			const head = new Uint8Array(await data.slice(0, 0x14).arrayBuffer());
			expect(String.fromCharCode(head[0x10], head[0x11], head[0x12], head[0x13])).toBe(
				'NRO0',
			);
			// Decompressed size should match the u32 LE size prefix.
			const declaredSize = new DataView(
				new Uint8Array(bytes).buffer,
			).getUint32(0, true);
			expect(data.size).toBe(declaredSize);
		});
	},
);
