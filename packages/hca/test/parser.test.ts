import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
	parseHca,
	decodeHca,
	encodeToWav,
	isHca,
	HcaParseError,
} from '../src/index.js';

/**
 * Build a tiny "looks-like-HCA" buffer with just the bare-minimum
 * `HCA\0` + `fmt\0` + `comp` headers, plus an explicit 0-block-count
 * so the decoder runs immediately to completion. Returns the
 * Uint8Array — useful for synthetic parser tests.
 */
function makeSyntheticHca(opts: {
	channelCount: number;
	samplingRate: number;
	blockCount: number;
}): Uint8Array {
	// 4 (HCA) + 4 (vers+dataOffset) + 4 (fmt) + 8 (ch/rate/blockCount/mute)
	// + 4 (comp tag) + 2 (blockSize) + 2 (r01/r02) + 8 (r03..reserve2)
	// + 4 (pad) = 40 header bytes; dataOffset = 0x40 padded with extras.
	const dataOffset = 0x40;
	const blockSize = 0x80;
	const out = new Uint8Array(dataOffset + opts.blockCount * blockSize);
	const dv = new DataView(out.buffer);
	let p = 0;
	// HCA\0
	out[p++] = 0x48;
	out[p++] = 0x43;
	out[p++] = 0x41;
	out[p++] = 0x00;
	dv.setUint16(p, 0x0200, false);
	p += 2; // version
	dv.setUint16(p, dataOffset, false);
	p += 2;
	// fmt\0
	out[p++] = 0x66;
	out[p++] = 0x6d;
	out[p++] = 0x74;
	out[p++] = 0x00;
	out[p] = opts.channelCount; // channel u8
	// samplingRate is u32 BE with top byte = channelCount overlapping; so
	// the u32 BE at this position is `(channelCount << 24) | samplingRate`.
	// We need samplingRate < 0x1000000 — the parser masks with 0xFFFFFF.
	dv.setUint32(p, ((opts.channelCount & 0xff) << 24) | opts.samplingRate, false);
	p += 4;
	dv.setUint32(p, opts.blockCount, false);
	p += 4;
	dv.setUint16(p, 0, false);
	p += 2; // muteHeader
	dv.setUint16(p, 0, false);
	p += 2; // muteFooter
	// comp
	out[p++] = 0x63;
	out[p++] = 0x6f;
	out[p++] = 0x6d;
	out[p++] = 0x70;
	dv.setUint16(p, blockSize, false);
	p += 2;
	out[p++] = 1; // r01
	out[p++] = 15; // r02
	out[p++] = 1; // r03
	out[p++] = 0; // r04
	out[p++] = 7; // r05
	out[p++] = 1; // r06
	out[p++] = 0; // r07
	out[p++] = 0; // r08
	out[p++] = 0; // reserve1
	out[p++] = 0; // reserve2
	// pad\0 marker (optional; here we just fill the rest with NULs)
	return out;
}

describe('isHca', () => {
	it('returns true for a buffer starting with HCA\\0', () => {
		const buf = new Uint8Array([0x48, 0x43, 0x41, 0x00, 0, 0, 0, 0]);
		expect(isHca(buf)).toBe(true);
	});

	it('accepts the obfuscated (top-bit-set) variant', () => {
		// Square's XOR-flipped header bytes.
		const buf = new Uint8Array([0xc8, 0xc3, 0xc1, 0x80, 0, 0, 0, 0]);
		expect(isHca(buf)).toBe(true);
	});

	it('returns false for non-HCA inputs', () => {
		expect(isHca(new Uint8Array(0))).toBe(false);
		expect(isHca(new TextEncoder().encode('NOPE'))).toBe(false);
		expect(isHca(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe(false);
	});
});

describe('parseHca', () => {
	it('parses a synthetic header', () => {
		const bytes = makeSyntheticHca({
			channelCount: 2,
			samplingRate: 44100,
			blockCount: 0,
		});
		const h = parseHca(bytes);
		expect(h.channelCount).toBe(2);
		expect(h.samplingRate).toBe(44100);
		expect(h.blockCount).toBe(0);
		expect(h.blockSize).toBe(0x80);
		expect(h.compdec).toBe('comp');
		expect(h.ciphType).toBe(0);
		expect(h.volume).toBe(1);
	});

	it('throws HcaParseError for a non-HCA buffer', () => {
		expect(() => parseHca(new Uint8Array(64))).toThrowError(HcaParseError);
	});

	it('throws HcaParseError for a tiny buffer', () => {
		expect(() => parseHca(new Uint8Array(2))).toThrowError(HcaParseError);
	});
});

describe('encodeToWav', () => {
	it('emits a RIFF/WAVE header with the right magic and chunk sizes', () => {
		const pcm = new Float32Array([0, 0.1, -0.1, 0]); // stereo, 2 frames
		const wav = encodeToWav(2, 44100, pcm);
		// 44 byte header + 4 samples × 2 bytes = 52 bytes total.
		expect(wav.length).toBe(44 + 4 * 2);
		const ascii = (off: number, n: number) =>
			String.fromCharCode(...wav.subarray(off, off + n));
		expect(ascii(0, 4)).toBe('RIFF');
		expect(ascii(8, 4)).toBe('WAVE');
		expect(ascii(12, 4)).toBe('fmt ');
		expect(ascii(36, 4)).toBe('data');
		const dv = new DataView(wav.buffer);
		expect(dv.getUint16(20, true)).toBe(1); // PCM fmtType
		expect(dv.getUint16(22, true)).toBe(2); // channels
		expect(dv.getUint32(24, true)).toBe(44100);
		expect(dv.getUint16(34, true)).toBe(16); // bitsPerSample
	});

	it('produces a correctly-sized 24-bit output', () => {
		const pcm = new Float32Array(10);
		const wav = encodeToWav(1, 44100, pcm, { bitDepth: 24 });
		expect(wav.length).toBe(44 + 10 * 3);
	});

	it('handles float (bitDepth = 0)', () => {
		const pcm = new Float32Array([0.5, -0.5]);
		const wav = encodeToWav(1, 44100, pcm, { bitDepth: 0 });
		const dv = new DataView(wav.buffer);
		expect(dv.getUint16(20, true)).toBe(3); // IEEE float fmtType
		expect(dv.getUint16(34, true)).toBe(32); // bitsPerSample
		expect(dv.getFloat32(44, true)).toBeCloseTo(0.5);
		expect(dv.getFloat32(48, true)).toBeCloseTo(-0.5);
	});

	it('rejects mismatched lengths', () => {
		expect(() => encodeToWav(2, 44100, new Float32Array(5))).toThrow();
	});

	it('rejects bad channelCount / samplingRate', () => {
		expect(() => encodeToWav(0, 44100, new Float32Array(0))).toThrow();
		expect(() => encodeToWav(1, 0, new Float32Array(0))).toThrow();
	});
});

// Real-data round-trip — gated, since the fixture isn't checked in.
const REAL_FIXTURE = '/tmp/ff1-bgm-out.hca';

describe.skipIf(!existsSync(REAL_FIXTURE))('real-data round-trip', () => {
	it('parses, decodes, and encodes the FF1 fixture', () => {
		const bytes = new Uint8Array(readFileSync(REAL_FIXTURE));
		const header = parseHca(bytes);
		expect(header.channelCount).toBeGreaterThanOrEqual(1);
		expect(header.samplingRate).toBeGreaterThan(0);
		expect(header.blockCount).toBeGreaterThan(0);

		const decoded = decodeHca(bytes);
		expect(decoded.channelCount).toBe(header.channelCount);
		expect(decoded.samplingRate).toBe(header.samplingRate);
		expect(decoded.samplesPerChannel).toBe(header.blockCount * 1024);
		expect(decoded.pcm.length).toBe(
			decoded.samplesPerChannel * decoded.channelCount,
		);

		// At least some samples should be non-zero.
		let nonZero = 0;
		for (let i = 0; i < Math.min(decoded.pcm.length, 1_000_000); i++) {
			if (decoded.pcm[i] !== 0) nonZero++;
		}
		expect(nonZero).toBeGreaterThan(1000);

		const wav = encodeToWav(
			decoded.channelCount,
			decoded.samplingRate,
			decoded.pcm,
		);
		expect(wav.length).toBe(
			44 + decoded.pcm.length * 2,
		);
		expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
	});
});
