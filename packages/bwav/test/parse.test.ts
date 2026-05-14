/**
 * Tests for `@tootallnate/bwav`'s parser. Uses synthetic fixtures only
 * — no commercial game data — to exercise:
 *
 *   - Magic / BOM / channel-count validation paths.
 *   - All three codec id branches' header fields read through.
 *   - The channel byte-range helper.
 */

import { describe, expect, it } from 'vitest';

import {
	BWAV_CHANNEL_HEADER_SIZE,
	BWAV_CODEC_DSP_ADPCM,
	BWAV_CODEC_NX_OPUS,
	BWAV_CODEC_PCM16LE,
	BWAV_HEADER_SIZE,
	BwavParseError,
	bwavChannelByteRanges,
	isBwavMagic,
	parseBwav,
} from '../src/index.js';

function makeBwav(channels: Array<{
	codec: number;
	layout: number;
	sampleRate: number;
	numSamples: number;
	payloadOffset: number;
	coefs?: Int16Array;
	loopEnd?: number;
	loopStart?: number;
	startPredictor?: number;
	startHist1?: number;
	startHist2?: number;
}>, opts: { isPrefetch?: boolean; crc32?: number } = {}): Uint8Array {
	const size = BWAV_HEADER_SIZE + channels.length * BWAV_CHANNEL_HEADER_SIZE;
	const out = new Uint8Array(size);
	const dv = new DataView(out.buffer);
	out[0] = 0x42;
	out[1] = 0x57;
	out[2] = 0x41;
	out[3] = 0x56;
	dv.setUint16(0x04, 0xfeff, true);
	dv.setUint16(0x06, 0x0001, true);
	dv.setUint32(0x08, opts.crc32 ?? 0xdeadbeef, true);
	dv.setUint16(0x0c, opts.isPrefetch ? 1 : 0, true);
	dv.setUint16(0x0e, channels.length, true);
	for (let i = 0; i < channels.length; i++) {
		const base = BWAV_HEADER_SIZE + i * BWAV_CHANNEL_HEADER_SIZE;
		const ch = channels[i];
		dv.setUint16(base + 0x00, ch.codec, true);
		dv.setUint16(base + 0x02, ch.layout, true);
		dv.setInt32(base + 0x04, ch.sampleRate, true);
		dv.setInt32(base + 0x08, ch.numSamples, true);
		dv.setInt32(base + 0x0c, ch.numSamples, true);
		const coefs = ch.coefs ?? new Int16Array(16);
		for (let c = 0; c < 16; c++) dv.setInt16(base + 0x10 + c * 2, coefs[c] ?? 0, true);
		dv.setUint32(base + 0x30, ch.payloadOffset, true);
		dv.setUint32(base + 0x34, ch.payloadOffset, true);
		dv.setUint32(base + 0x38, 1, true);
		dv.setInt32(base + 0x3c, ch.loopEnd ?? -1, true);
		dv.setInt32(base + 0x40, ch.loopStart ?? 0, true);
		dv.setUint16(base + 0x44, ch.startPredictor ?? 0, true);
		dv.setInt16(base + 0x46, ch.startHist1 ?? 0, true);
		dv.setInt16(base + 0x48, ch.startHist2 ?? 0, true);
	}
	return out;
}

describe('isBwavMagic', () => {
	it('accepts BWAV', () => {
		const bytes = new Uint8Array([0x42, 0x57, 0x41, 0x56, 0xfe, 0xff]);
		expect(isBwavMagic(bytes)).toBe(true);
	});

	it('rejects other magics', () => {
		expect(isBwavMagic(new Uint8Array([0x42, 0x57, 0x41, 0x52]))).toBe(false); // BWAR
		expect(isBwavMagic(new Uint8Array([0x46, 0x57, 0x41, 0x56]))).toBe(false); // FWAV
		expect(isBwavMagic(new Uint8Array([0x00]))).toBe(false);
	});
});

describe('parseBwav', () => {
	it('parses a mono DSP-ADPCM BWAV', () => {
		const bytes = makeBwav([
			{
				codec: BWAV_CODEC_DSP_ADPCM,
				layout: 2,
				sampleRate: 48000,
				numSamples: 100_000,
				payloadOffset: 0x80,
				startPredictor: 1,
				startHist1: -50,
				startHist2: 25,
				coefs: new Int16Array([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600]),
			},
		]);
		const parsed = parseBwav(bytes);
		expect(parsed.crc32).toBe(0xdeadbeef);
		expect(parsed.isPrefetch).toBe(false);
		expect(parsed.channels).toHaveLength(1);
		const c = parsed.channels[0];
		expect(c.codec).toBe(BWAV_CODEC_DSP_ADPCM);
		expect(c.layout).toBe(2);
		expect(c.sampleRate).toBe(48000);
		expect(c.numSamples).toBe(100_000);
		expect(c.numSamplesFull).toBe(100_000);
		expect(c.payloadOffset).toBe(0x80);
		expect(c.loopEnd).toBe(-1);
		expect(c.loopStart).toBe(0);
		expect(c.startPredictor).toBe(1);
		expect(c.startHist1).toBe(-50);
		expect(c.startHist2).toBe(25);
		expect(c.coefs[0]).toBe(100);
		expect(c.coefs[15]).toBe(1600);
	});

	it('parses a stereo NX-Opus BWAV', () => {
		const bytes = makeBwav([
			{ codec: BWAV_CODEC_NX_OPUS, layout: 0, sampleRate: 48000, numSamples: 200_000, payloadOffset: 0x100 },
			{ codec: BWAV_CODEC_NX_OPUS, layout: 1, sampleRate: 48000, numSamples: 200_000, payloadOffset: 0x800 },
		]);
		const parsed = parseBwav(bytes);
		expect(parsed.channels).toHaveLength(2);
		expect(parsed.channels[0].codec).toBe(BWAV_CODEC_NX_OPUS);
		expect(parsed.channels[1].codec).toBe(BWAV_CODEC_NX_OPUS);
		expect(parsed.channels[0].layout).toBe(0);
		expect(parsed.channels[1].layout).toBe(1);
		expect(parsed.channels[0].payloadOffset).toBe(0x100);
		expect(parsed.channels[1].payloadOffset).toBe(0x800);
	});

	it('parses a PCM16 BWAV with prefetch flag set', () => {
		const bytes = makeBwav(
			[{ codec: BWAV_CODEC_PCM16LE, layout: 2, sampleRate: 44100, numSamples: 50_000, payloadOffset: 0x80 }],
			{ isPrefetch: true },
		);
		const parsed = parseBwav(bytes);
		expect(parsed.isPrefetch).toBe(true);
		expect(parsed.channels[0].codec).toBe(BWAV_CODEC_PCM16LE);
		expect(parsed.channels[0].sampleRate).toBe(44100);
	});

	it('throws on missing magic', () => {
		expect(() => parseBwav(new Uint8Array([0x46, 0x57, 0x41, 0x56]))).toThrowError(BwavParseError);
	});

	it('throws on truncated header', () => {
		const short = new Uint8Array([0x42, 0x57, 0x41, 0x56, 0xfe, 0xff]);
		expect(() => parseBwav(short)).toThrowError(/header truncated/);
	});

	it('throws on bad BOM', () => {
		const bytes = makeBwav([{ codec: 0, layout: 0, sampleRate: 0, numSamples: 0, payloadOffset: 0 }]);
		// Flip the BOM to something invalid.
		bytes[4] = 0x00;
		bytes[5] = 0x00;
		expect(() => parseBwav(bytes)).toThrowError(/BOM/);
	});

	it('throws on zero channels', () => {
		const bytes = new Uint8Array(BWAV_HEADER_SIZE);
		bytes[0] = 0x42;
		bytes[1] = 0x57;
		bytes[2] = 0x41;
		bytes[3] = 0x56;
		const dv = new DataView(bytes.buffer);
		dv.setUint16(0x04, 0xfeff, true);
		dv.setUint16(0x0e, 0, true);
		expect(() => parseBwav(bytes)).toThrowError(/0 channels/);
	});

	it('rejects implausible channel counts (likely misidentification)', () => {
		const bytes = new Uint8Array(BWAV_HEADER_SIZE);
		bytes[0] = 0x42;
		bytes[1] = 0x57;
		bytes[2] = 0x41;
		bytes[3] = 0x56;
		const dv = new DataView(bytes.buffer);
		dv.setUint16(0x04, 0xfeff, true);
		dv.setUint16(0x0e, 9999, true);
		expect(() => parseBwav(bytes)).toThrowError(/implausible/);
	});
});

describe('bwavChannelByteRanges', () => {
	it('infers per-channel byte ranges from payload offsets', () => {
		const bytes = makeBwav([
			{ codec: BWAV_CODEC_NX_OPUS, layout: 0, sampleRate: 48000, numSamples: 1000, payloadOffset: 0x80 },
			{ codec: BWAV_CODEC_NX_OPUS, layout: 1, sampleRate: 48000, numSamples: 1000, payloadOffset: 0x200 },
		]);
		const parsed = parseBwav(bytes);
		const ranges = bwavChannelByteRanges(parsed, /* totalBytes */ 0x400);
		expect(ranges).toEqual([
			{ start: 0x80, end: 0x200 },
			{ start: 0x200, end: 0x400 },
		]);
	});

	it('handles out-of-order payload offsets', () => {
		const bytes = makeBwav([
			{ codec: BWAV_CODEC_NX_OPUS, layout: 0, sampleRate: 48000, numSamples: 1000, payloadOffset: 0x800 },
			{ codec: BWAV_CODEC_NX_OPUS, layout: 1, sampleRate: 48000, numSamples: 1000, payloadOffset: 0x80 },
		]);
		const parsed = parseBwav(bytes);
		const ranges = bwavChannelByteRanges(parsed, /* totalBytes */ 0x1000);
		// Sorted order: channel 1 first (0x80 → 0x800), channel 0 next (0x800 → 0x1000).
		expect(ranges[0]).toEqual({ start: 0x800, end: 0x1000 });
		expect(ranges[1]).toEqual({ start: 0x80, end: 0x800 });
	});
});
