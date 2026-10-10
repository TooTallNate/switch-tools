import { describe, expect, it } from 'vitest';
import {
	cookedStrToRaw,
	decodeMdecFrame,
	decodeXaStream,
	isCookedStr,
	mdecHeaderOffset,
	pcm16ToWav,
	probeStr,
	scanXaStreams,
	StrDecoder,
	XaDecoder,
} from '../src/index.js';

const RAW = 2352;

/** Pack bits MSB-first into 16-bit little-endian words after an 8-byte MDEC header. */
function mdecFrame(bits: string, version = 2, qscale = 1): Uint8Array {
	const padded = bits.padEnd(Math.ceil(bits.length / 16) * 16 + 32, '0');
	const out = new Uint8Array(8 + padded.length / 8);
	const dv = new DataView(out.buffer);
	dv.setUint16(0, 0, true);
	dv.setUint16(2, 0x3800, true);
	dv.setUint16(4, qscale, true);
	dv.setUint16(6, version, true);
	for (let w = 0; w < padded.length / 16; w++) dv.setUint16(8 + w * 2, parseInt(padded.slice(w * 16, w * 16 + 16), 2), true);
	return out;
}

const dc = (v: number) => (v & 0x3ff).toString(2).padStart(10, '0');
const EOB = '10';

describe('MDEC', () => {
	it('decodes v2 DC levels and AC codes', () => {
		// Macroblock order: Cr, Cb, Y0, Y1, Y2, Y3. Y0 gets one AC (run 0, level 1: "11" + sign).
		const bits = dc(0) + EOB + dc(0) + EOB + dc(64) + '110' + EOB + dc(64) + EOB + dc(64) + EOB + dc(-64) + EOB;
		// qscale 16 so the AC (level 1 · 16 · matrix 16 >> 3 = 32) is visible.
		const f = decodeMdecFrame(mdecFrame(bits, 2, 16), 16, 16);
		expect([f.codedWidth, f.codedHeight]).toEqual([16, 16]);
		expect(f.u.every((v) => v === 128)).toBe(true);
		expect(f.v.every((v) => v === 128)).toBe(true);
		// Y1 (top-right) and Y2 (bottom-left): DC 64 → 2·64 + 1024 = 1152 → 144.
		expect(f.y[0 * 16 + 8]).toBe(144);
		expect(f.y[8 * 16 + 0]).toBe(144);
		// Y3: DC −64 → 896 → 112.
		expect(f.y[15 * 16 + 15]).toBe(112);
		// Y0: the horizontal AC makes the left edge brighter than the right.
		expect(f.y[0]).toBeGreaterThan(f.y[7]);
	});

	it('finds the header after Final Fantasy VII camera data', () => {
		const frame = mdecFrame(dc(0) + EOB, 1);
		const ff7 = new Uint8Array(40 + frame.length);
		ff7.set(frame, 40);
		expect(mdecHeaderOffset(frame)).toBe(0);
		expect(mdecHeaderOffset(ff7)).toBe(40);
	});
});

/** One raw XA audio sector: stereo 37.8 kHz, filter 0, range 12, every nibble pair (L=+1, R=−1). */
function xaSector(file: number, channel: number): Uint8Array {
	const s = new Uint8Array(RAW);
	s[15] = 2;
	s[16] = s[20] = file;
	s[17] = s[21] = channel;
	s[18] = s[22] = 0x64; // real-time + form 2 + audio
	s[19] = s[23] = 0x01; // stereo
	for (let g = 0; g < 18; g++) {
		const o = 24 + g * 128;
		for (let u = 0; u < 8; u++) s[o + 4 + u] = 0x0c; // filter 0, range 12 → shift 0
		s.fill(0xf1, o + 16, o + 128);
	}
	return s;
}

describe('XA ADPCM', () => {
	it('decodes and interleaves stereo sound units', () => {
		const pcm = new XaDecoder(2).decodeSector(xaSector(1, 0).subarray(24));
		expect(pcm.length).toBe(18 * 224);
		expect([pcm[0], pcm[1], pcm[2], pcm[3]]).toEqual([1, -1, 1, -1]);
	});

	it('separates interleaved channels', () => {
		const raw = new Uint8Array(3 * RAW);
		raw.set(xaSector(1, 0), 0);
		raw.set(xaSector(1, 3), RAW);
		raw.set(xaSector(1, 0), 2 * RAW);
		const streams = scanXaStreams(raw);
		expect(streams.map((s) => [s.channel, s.channels, s.sampleRate, s.sectors, s.sampleFrames])).toEqual([
			[0, 2, 37800, 2, 2016 * 2],
			[3, 2, 37800, 1, 2016],
		]);
		const ch0 = decodeXaStream(raw, 1, 0);
		expect(ch0.samples.length).toBe(2016 * 2 * 2);
		const wav = pcm16ToWav(ch0.samples, ch0.channels, ch0.sampleRate);
		expect(new DataView(wav.buffer).getUint32(24, true)).toBe(37800);
	});
});

describe('STR', () => {
	/** A cooked one-frame, one-chunk 16×16 STR. */
	function cookedStr(): Uint8Array {
		const frame = mdecFrame(dc(0) + EOB + dc(0) + EOB + (dc(32) + EOB).repeat(4));
		const sector = new Uint8Array(2048);
		const dv = new DataView(sector.buffer);
		sector.set([0x60, 0x01, 0x01, 0x80]);
		dv.setUint16(4, 0, true);
		dv.setUint16(6, 1, true);
		dv.setUint32(8, 1, true);
		dv.setUint32(12, frame.length, true);
		dv.setUint16(16, 16, true);
		dv.setUint16(18, 16, true);
		sector.set(frame, 32);
		return sector;
	}

	it('demuxes and decodes cooked STR frames', () => {
		const cooked = cookedStr();
		expect(isCookedStr(cooked)).toBe(true);
		const raw = cookedStrToRaw(cooked);
		expect(probeStr(raw)).toMatchObject({ width: 16, height: 16, frameCount: 1, version: 2, audio: null });
		const dec = new StrDecoder(raw);
		const f = dec.nextFrame()!;
		expect(f.y.every((v) => v === 136)).toBe(true);
		expect(dec.nextFrame()).toBeNull();
	});
});
