import { describe, it, expect } from 'vitest';
import {
	BnvibType,
	isBnvib,
	parseBnvib,
	freqCodeToHz,
	renderBnvibToPcm16,
} from '../src/index.js';

/**
 * Hand-crafted minimal BNVIB samples, byte-for-byte matching the
 * format the spec requires:
 *
 *   - Type 0x04 with 1 sample (4 bytes of data) at 200 Hz
 *   - Type 0x0C (loop) with 2 samples
 *   - Type 0x10 (loop + wait) with 1 sample
 *
 * Real-world BNVIB samples are too long to inline here, but the
 * format is mechanical enough
 * that we test the parser's headers + sample decoding against
 * synthesised inputs and rely on integration via the nx-archive
 * preview to validate against real shipped files.
 */

function buildNormal(low: number, high: number) {
	const buf = new Uint8Array(0x0c + 4);
	const v = new DataView(buf.buffer);
	v.setUint32(0x00, 0x04, true); // type Normal
	buf[0x04] = 0x03; // magic
	v.setUint16(0x06, 200, true); // sample rate
	v.setUint32(0x08, 4, true); // vib_size = 4 bytes (1 sample)
	v.setUint16(0x0c, low, false); // big-endian!
	v.setUint16(0x0e, high, false);
	return buf;
}

function buildLoop(samples: { lo: number; hi: number }[], loopStart: number, loopEnd: number) {
	const dataBytes = samples.length * 4;
	const buf = new Uint8Array(0x14 + dataBytes);
	const v = new DataView(buf.buffer);
	v.setUint32(0x00, 0x0c, true);
	buf[0x04] = 0x03;
	v.setUint16(0x06, 200, true);
	v.setUint32(0x08, loopStart, true);
	v.setUint32(0x0c, loopEnd, true);
	v.setUint32(0x10, dataBytes, true);
	for (let i = 0; i < samples.length; i++) {
		v.setUint16(0x14 + i * 4, samples[i].lo, false);
		v.setUint16(0x14 + i * 4 + 2, samples[i].hi, false);
	}
	return buf;
}

function buildLoopWait(loopWait: number) {
	const buf = new Uint8Array(0x18 + 4);
	const v = new DataView(buf.buffer);
	v.setUint32(0x00, 0x10, true);
	buf[0x04] = 0x03;
	v.setUint16(0x06, 200, true);
	v.setUint32(0x08, 0, true);
	v.setUint32(0x0c, 0, true);
	v.setUint32(0x10, loopWait, true);
	v.setUint32(0x14, 4, true);
	v.setUint16(0x18, 0xabcd, false);
	v.setUint16(0x1a, 0x1234, false);
	return buf;
}

describe('isBnvib', () => {
	it('detects the type+magic pattern', async () => {
		const buf = buildNormal(0xabcd, 0x1234);
		expect(await isBnvib(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects unrelated blobs', async () => {
		expect(await isBnvib(new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x00])]))).toBe(false);
		expect(await isBnvib(new Blob([new Uint8Array(8)]))).toBe(false);
		expect(await isBnvib(new Blob([]))).toBe(false);
	});
	it('requires the 0x03 format magic', async () => {
		const buf = buildNormal(0, 0);
		buf[0x04] = 0x05; // wrong magic
		expect(await isBnvib(new Blob([buf as BlobPart]))).toBe(false);
	});
});

describe('parseBnvib — Normal', () => {
	it('decodes a 1-sample Normal file', async () => {
		// low: amp=64 (≈0.504), freq=0x100; high: amp=127 (=1.0), freq=0x055
		const lo = (64 << 9) | 0x100;
		const hi = (127 << 9) | 0x055;
		const buf = buildNormal(lo, hi);
		const parsed = await parseBnvib(new Blob([buf as BlobPart]));
		expect(parsed.type).toBe(BnvibType.Normal);
		expect(parsed.typeName).toBe('Normal');
		expect(parsed.formatMagic).toBe(0x03);
		expect(parsed.sampleRate).toBe(200);
		expect(parsed.vibSize).toBe(4);
		expect(parsed.sampleCount).toBe(1);
		expect(parsed.loopStart).toBeNull();
		expect(parsed.loopEnd).toBeNull();
		expect(parsed.loopWait).toBeNull();
		expect(parsed.samples).toHaveLength(1);
		expect(parsed.samples[0].ampLow).toBeCloseTo(64 / 127, 5);
		expect(parsed.samples[0].freqLow).toBe(0x100);
		expect(parsed.samples[0].ampHigh).toBe(1);
		expect(parsed.samples[0].freqHigh).toBe(0x055);
		expect(parsed.durationSeconds).toBeCloseTo(1 / 200, 5);
	});
});

describe('parseBnvib — Loop', () => {
	it('decodes loop_start / loop_end', async () => {
		const buf = buildLoop(
			[
				{ lo: 0x0000, hi: 0xffff },
				{ lo: 0xfffe, hi: 0x0001 },
			],
			0,
			1,
		);
		const parsed = await parseBnvib(new Blob([buf as BlobPart]));
		expect(parsed.type).toBe(BnvibType.Loop);
		expect(parsed.loopStart).toBe(0);
		expect(parsed.loopEnd).toBe(1);
		expect(parsed.loopWait).toBeNull();
		expect(parsed.samples).toHaveLength(2);
		// 0x0000 → amp=0, freq=0; 0xFFFF → amp=127, freq=0x1FF
		expect(parsed.samples[0].ampLow).toBe(0);
		expect(parsed.samples[0].ampHigh).toBe(1);
		expect(parsed.samples[0].freqHigh).toBe(0x1ff);
		// 0xFFFE → amp=127 (top 7 bits), freq=0x1FE
		expect(parsed.samples[1].ampLow).toBe(1);
		expect(parsed.samples[1].freqLow).toBe(0x1fe);
	});
});

describe('parseBnvib — Loop+Wait', () => {
	it('reads the extra loop_wait field', async () => {
		const buf = buildLoopWait(123);
		const parsed = await parseBnvib(new Blob([buf as BlobPart]));
		expect(parsed.type).toBe(BnvibType.LoopAndWait);
		expect(parsed.typeName).toBe('Loop+Wait');
		expect(parsed.loopWait).toBe(123);
	});
});

describe('parseBnvib — error paths', () => {
	it('rejects unsupported types', async () => {
		const buf = new Uint8Array(0x20);
		buf[0] = 0x99;
		await expect(parseBnvib(new Blob([buf as BlobPart]))).rejects.toThrow(
			/Unsupported BNVIB type/,
		);
	});
	it('rejects unsupported format magic', async () => {
		const buf = buildNormal(0, 0);
		buf[0x04] = 0x05;
		await expect(parseBnvib(new Blob([buf as BlobPart]))).rejects.toThrow(
			/format magic/,
		);
	});
	it('rejects misaligned vib_size', async () => {
		const buf = buildNormal(0, 0);
		const v = new DataView(buf.buffer);
		v.setUint32(0x08, 5, true); // not multiple of 4
		await expect(parseBnvib(new Blob([buf as BlobPart]))).rejects.toThrow(
			/multiple of 4/,
		);
	});
});

describe('freqCodeToHz', () => {
	it('matches the nominal high-band base of 320 Hz at code 0x100', () => {
		expect(freqCodeToHz(0x100, 'high')).toBeCloseTo(320, 1);
		expect(freqCodeToHz(0x100, 'low')).toBeCloseTo(160, 1);
	});
	it('moves up an octave per 96 codes', () => {
		expect(freqCodeToHz(0x100 + 96, 'high')).toBeCloseTo(640, 1);
		expect(freqCodeToHz(0x100 - 96, 'high')).toBeCloseTo(160, 1);
	});
});

describe('renderBnvibToPcm16', () => {
	it('produces a non-zero stereo waveform for a non-zero input', async () => {
		const lo = (64 << 9) | 0x100; // amp 64/127, freq 0x100 (320 Hz low band → 160 Hz)
		const hi = (64 << 9) | 0x100;
		const buf = buildNormal(lo, hi);
		const parsed = await parseBnvib(new Blob([buf as BlobPart]));
		const out = renderBnvibToPcm16(parsed, 8000);
		expect(out.numChannels).toBe(2);
		expect(out.sampleRate).toBe(8000);
		// 1 sample × (8000/200) upsample = 40 stereo frames = 80 s16
		expect(out.samples.length).toBe(40 * 2);
		// Some non-zero amplitude is present.
		const peak = Math.max(...Array.from(out.samples).map(Math.abs));
		expect(peak).toBeGreaterThan(0);
	});
	it('returns an empty buffer for a zero-length file', () => {
		const fake = {
			type: BnvibType.Normal,
			typeName: 'Normal',
			formatMagic: 0x03,
			sampleRate: 200,
			vibSize: 0,
			sampleCount: 0,
			durationSeconds: 0,
			loopStart: null,
			loopEnd: null,
			loopWait: null,
			samples: [],
		};
		const out = renderBnvibToPcm16(fake);
		expect(out.samples.length).toBe(0);
	});
});
