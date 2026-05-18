import { describe, it, expect } from 'vitest';
import { parseWd, decodeWaveToWav, WdParseError } from '../src/index.js';
import { encodeWav } from '@tootallnate/ps-adpcm';

/**
 * Build a minimal synthetic WD bank with the given parameters.
 * Always little-endian; one wave consisting of a single 16-byte
 * PS-ADPCM frame (silent, since coef=0, shift=0, nibbles=0).
 */
function makeMinimalWdLe(): Uint8Array {
	const waveCount = 1;
	const instrumentCount = 1;
	const entrySize = 0x20;
	const wavesOffset = 0x60; // standard layout
	// dataOffset = wavesOffset + waves*entrySize = 0x60 + 0x20 = 0x80
	const dataOffset = wavesOffset + waveCount * entrySize;
	const adpcmFrameBytes = 16;
	const totalSize = dataOffset + adpcmFrameBytes;

	const out = new Uint8Array(totalSize);
	const v = new DataView(out.buffer);
	// Magic: 'WD\0\0' (always big-endian byte pattern)
	out[0] = 0x57;
	out[1] = 0x44;
	out[2] = 0x00;
	out[3] = 0x00;
	v.setUint32(0x04, adpcmFrameBytes, true); // data_size
	v.setInt32(0x08, instrumentCount, true);
	v.setInt32(0x0c, waveCount, true);
	// 0x10-0x1f: zero (already initialized)
	v.setUint32(0x20, wavesOffset, true);
	// Wave entry at 0x60:
	//   0x00: flags
	//   0x04: stream_offset within data (0 = right at dataOffset)
	//   0x08: loop_start
	//   0x10: key (0 = base rate, 48000 Hz)
	v.setUint32(wavesOffset + 0x04, 0, true);
	v.setUint32(wavesOffset + 0x08, 0, true);
	v.setInt32(wavesOffset + 0x10, 0, true);
	// PS-ADPCM frame at dataOffset: all-zero is a valid silent frame
	// (coef_index=0, shift_factor=0, flag=0, nibbles=0 → 28 zeros)
	return out;
}

describe('parseWd — minimal synthetic bank', () => {
	it('parses LE WD with one silent wave', () => {
		const buf = makeMinimalWdLe();
		const bank = parseWd(buf);
		expect(bank.bigEndian).toBe(false);
		expect(bank.codec).toBe('ps-adpcm');
		expect(bank.instrumentCount).toBe(1);
		expect(bank.waves).toHaveLength(1);
		const w = bank.waves[0];
		expect(w.index).toBe(0);
		expect(w.sampleRate).toBe(48000);
		expect(w.loopStart).toBe(0);
		expect(w.data.byteLength).toBe(16);
	});

	it('decodes the silent wave to 28 zero samples', async () => {
		const bank = parseWd(makeMinimalWdLe());
		const wav = await decodeWaveToWav(bank.waves[0], bank);
		// WAV header is 44 bytes, then 28 samples × 2 bytes = 56
		expect(wav.length).toBe(44 + 56);
		// All sample bytes are zero
		for (let i = 44; i < wav.length; i++) {
			expect(wav[i]).toBe(0);
		}
		// Header declares the correct sample rate
		const v = new DataView(wav.buffer, wav.byteOffset);
		expect(v.getUint32(24, true)).toBe(48000);
	});

	it('produces a valid WAV that the encodeWav helper would build directly', async () => {
		const bank = parseWd(makeMinimalWdLe());
		const wav = await decodeWaveToWav(bank.waves[0], bank);
		const direct = encodeWav(new Int16Array(28), 48000, 1);
		expect(wav).toEqual(direct);
	});
});

describe('parseWd — error handling', () => {
	it('throws on file too small', () => {
		expect(() => parseWd(new Uint8Array(10))).toThrow(WdParseError);
	});

	it('throws on bad magic', () => {
		const buf = new Uint8Array(100);
		buf[0] = 0x57;
		buf[1] = 0x45; // 'E' not 'D'
		expect(() => parseWd(buf)).toThrow(/bad magic/);
	});

	it('throws on implausible wave count (caught by endian sniff)', () => {
		const buf = makeMinimalWdLe();
		const v = new DataView(buf.buffer);
		v.setInt32(0x0c, 0x500, true); // > 0x200, both endians invalid
		// Caught at the endian-sniff stage since neither
		// interpretation produces a plausible count.
		expect(() => parseWd(buf)).toThrow(/endianness|implausible/);
	});

	it('throws on non-zero reserved bytes', () => {
		const buf = makeMinimalWdLe();
		const v = new DataView(buf.buffer);
		v.setUint32(0x14, 0x12345678, true);
		expect(() => parseWd(buf)).toThrow(/reserved bytes/);
	});
});

describe('parseWd — FFXI streamOffset alignment quirk', () => {
	it('rounds down a non-16-byte-aligned streamOffset', () => {
		const buf = makeMinimalWdLe();
		const v = new DataView(buf.buffer);
		// Make the wave's streamOffset = 0x108 (alignment 8 within
		// a 16-byte frame). The parser should treat it as 0x100.
		// We need a bigger data section: let's extend the buffer.
		const bigger = new Uint8Array(0x80 + 0x200);
		bigger.set(buf);
		const bv = new DataView(bigger.buffer);
		bv.setUint32(0x60 + 0x04, 0x108, true);
		// data_size doesn't strictly matter for parseWd's sanity
		// checks, leave it.
		const bank = parseWd(bigger);
		expect(bank.waves[0].data.byteOffset - 0x80).toBe(0x100);
	});

	it('does NOT round a 16-byte-aligned streamOffset', () => {
		const buf = new Uint8Array(0x80 + 0x200);
		buf.set(makeMinimalWdLe());
		const v = new DataView(buf.buffer);
		v.setUint32(0x60 + 0x04, 0x110, true); // already aligned
		const bank = parseWd(buf);
		expect(bank.waves[0].data.byteOffset - 0x80).toBe(0x110);
	});
});
