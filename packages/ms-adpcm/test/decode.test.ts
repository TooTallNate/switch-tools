import { describe, it, expect } from 'vitest';
import {
	parseMsAdpcmWav,
	decodeMsAdpcm,
	encodeWav,
	isMsAdpcmWav,
	transcodeMsAdpcmToPcmWav,
	STANDARD_COEFS,
	MsAdpcmParseError,
} from '../src/index.js';

/**
 * Hand-build a minimal MS-ADPCM WAV with one block of mono
 * silent samples. Used to exercise the parser + decoder without
 * any external fixture.
 */
function makeMinimalMonoSilent(): Uint8Array {
	const samplesPerBlock = 4; // 2 header seed + 2 nibbles
	const blockAlign = 7 + 1; // mono: 1 byte of nibbles = 2 samples
	const dataSize = blockAlign;
	const numCoef = 7;
	const fmtChunkSize = 18 + 4 + numCoef * 4; // 18 base + 2 (samplesPerBlock) + 2 (numCoef) + 7×4 coefs = 50
	const factChunkSize = 4;
	const headerSize = 12 + (8 + fmtChunkSize) + (8 + factChunkSize) + 8;
	const out = new Uint8Array(headerSize + dataSize);
	const v = new DataView(out.buffer);
	const enc = new TextEncoder();

	out.set(enc.encode('RIFF'), 0);
	v.setUint32(4, headerSize - 8 + dataSize, true);
	out.set(enc.encode('WAVE'), 8);

	// fmt chunk
	out.set(enc.encode('fmt '), 12);
	v.setUint32(16, fmtChunkSize, true);
	v.setUint16(20, 0x0002, true); // ADPCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, 22050, true); // sample rate
	v.setUint32(28, 22050 * 1 * 1, true); // byte rate (approx)
	v.setUint16(32, blockAlign, true);
	v.setUint16(34, 4, true); // bits per sample
	v.setUint16(36, fmtChunkSize - 18, true); // cbSize
	v.setUint16(38, samplesPerBlock, true);
	v.setUint16(40, numCoef, true);
	for (let i = 0; i < numCoef; i++) {
		v.setInt16(42 + i * 4 + 0, STANDARD_COEFS[i]![0], true);
		v.setInt16(42 + i * 4 + 2, STANDARD_COEFS[i]![1], true);
	}
	let cursor = 42 + numCoef * 4;

	// fact chunk
	out.set(enc.encode('fact'), cursor);
	v.setUint32(cursor + 4, factChunkSize, true);
	v.setUint32(cursor + 8, samplesPerBlock, true);
	cursor += 8 + factChunkSize;

	// data chunk
	out.set(enc.encode('data'), cursor);
	v.setUint32(cursor + 4, dataSize, true);
	cursor += 8;

	// Block: predictor=0, delta=16 (minimum), sample1=0, sample2=0, then
	// one byte of nibbles = two samples that should each decode to 0
	// (predicted = 0, error = 0*delta = 0).
	out[cursor + 0] = 0; // predictor
	v.setInt16(cursor + 1, 16, true); // delta
	v.setInt16(cursor + 3, 0, true); // sample1
	v.setInt16(cursor + 5, 0, true); // sample2
	out[cursor + 7] = 0x00; // two zero nibbles = zero samples

	return out;
}

describe('isMsAdpcmWav', () => {
	it('returns true for a valid MS-ADPCM WAV', () => {
		const bytes = makeMinimalMonoSilent();
		expect(isMsAdpcmWav(bytes)).toBe(true);
	});

	it('returns false for non-WAV inputs', () => {
		expect(isMsAdpcmWav(new Uint8Array(0))).toBe(false);
		expect(isMsAdpcmWav(new Uint8Array(50))).toBe(false);
		expect(
			isMsAdpcmWav(new TextEncoder().encode('hello world')),
		).toBe(false);
	});

	it('returns false for a PCM WAV (codec 0x0001)', () => {
		const pcm = encodeWav(new Int16Array(10), 44100, 1);
		expect(isMsAdpcmWav(pcm)).toBe(false);
	});
});

describe('parseMsAdpcmWav', () => {
	it('parses the minimal mono fixture', () => {
		const bytes = makeMinimalMonoSilent();
		const parsed = parseMsAdpcmWav(bytes);
		expect(parsed.formatTag).toBe(0x0002);
		expect(parsed.channels).toBe(1);
		expect(parsed.sampleRate).toBe(22050);
		expect(parsed.samplesPerBlock).toBe(4);
		expect(parsed.blockAlign).toBe(8);
		expect(parsed.coefs).toEqual(STANDARD_COEFS);
		expect(parsed.totalFrames).toBe(4);
	});

	it('throws MsAdpcmParseError for a PCM WAV', () => {
		const pcm = encodeWav(new Int16Array(10), 44100, 1);
		expect(() => parseMsAdpcmWav(pcm)).toThrowError(MsAdpcmParseError);
	});

	it('throws for tiny buffers', () => {
		expect(() => parseMsAdpcmWav(new Uint8Array(10))).toThrowError(
			MsAdpcmParseError,
		);
	});
});

describe('decodeMsAdpcm', () => {
	it('decodes a silent block to all zeros', () => {
		const bytes = makeMinimalMonoSilent();
		const parsed = parseMsAdpcmWav(bytes);
		const samples = decodeMsAdpcm(bytes, parsed);
		expect(samples.length).toBe(4);
		for (let i = 0; i < samples.length; i++) {
			expect(samples[i]).toBe(0);
		}
	});

	it('emits the header sample2 then sample1 as the first two frames', () => {
		// Hand-modify the fixture to set sample1=100, sample2=-50.
		const bytes = makeMinimalMonoSilent();
		const v = new DataView(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		);
		// data chunk body is at the last 8 bytes (header 7 + 1 nibble).
		const dataStart = bytes.byteLength - 8;
		v.setInt16(dataStart + 3, 100, true); // sample1
		v.setInt16(dataStart + 5, -50, true); // sample2

		const parsed = parseMsAdpcmWav(bytes);
		const samples = decodeMsAdpcm(bytes, parsed);
		// First emitted = sample2, second = sample1.
		expect(samples[0]).toBe(-50);
		expect(samples[1]).toBe(100);
	});
});

describe('encodeWav', () => {
	it('round-trips through parse with the right format', () => {
		const samples = new Int16Array([100, -100, 200, -200, 300, -300]);
		const wav = encodeWav(samples, 44100, 2);
		// Spot-check the WAV header tags.
		const ascii = (off: number, n: number) =>
			String.fromCharCode(...wav.subarray(off, off + n));
		expect(ascii(0, 4)).toBe('RIFF');
		expect(ascii(8, 4)).toBe('WAVE');
		expect(ascii(12, 4)).toBe('fmt ');
		expect(ascii(36, 4)).toBe('data');
		const v = new DataView(wav.buffer);
		expect(v.getUint16(20, true)).toBe(1); // PCM
		expect(v.getUint16(22, true)).toBe(2); // channels
		expect(v.getUint32(24, true)).toBe(44100);
		// Sample data
		expect(v.getInt16(44, true)).toBe(100);
		expect(v.getInt16(46, true)).toBe(-100);
	});

	it('rejects mismatched channel counts', () => {
		expect(() => encodeWav(new Int16Array(5), 44100, 2)).toThrow();
	});
});

describe('transcodeMsAdpcmToPcmWav', () => {
	it('produces a PCM WAV Blob', () => {
		const bytes = makeMinimalMonoSilent();
		const blob = transcodeMsAdpcmToPcmWav(bytes);
		expect(blob.type).toBe('audio/wav');
		expect(blob.size).toBeGreaterThan(44); // header + at least some samples
	});
});
