import { describe, it, expect } from 'vitest';
import {
	Codec,
	SAMPLE_HEADER_SIZE,
	Z64_NOMINAL_SAMPLE_RATE,
	decodeZ64Sample,
	encodeWav,
	parseZ64Loop,
	scanZ64Samples,
} from '../src/index.js';

/**
 * Build a synthetic Audiobank / Audiotable pair.
 *
 * Layout inside the bank:
 *   0x0000  padding
 *   0x0100  sample headers
 *   0x0400  codebooks
 *   0x0800  loop descriptors
 *
 * No commercial ROM data: the codebooks are zero-filled (which makes
 * decoded output exactly `residual << scale`, so the decode path is
 * checkable) and the frames are generated.
 */
function build(opts: {
	count?: number;
	loopCount?: number;
	codec?: number;
	size?: number;
} = {}) {
	const count = opts.count ?? 3;
	const size = opts.size ?? 9 * 4; // 4 frames
	const bank = new Uint8Array(0x1000);
	const table = new Uint8Array(count * size + 0x100);

	const w32 = (buf: Uint8Array, o: number, v: number) => {
		buf[o] = (v >>> 24) & 0xff;
		buf[o + 1] = (v >>> 16) & 0xff;
		buf[o + 2] = (v >>> 8) & 0xff;
		buf[o + 3] = v & 0xff;
	};

	const dataOffsets: number[] = [];
	for (let i = 0; i < count; i++) {
		const headerOffset = 0x100 + i * SAMPLE_HEADER_SIZE;
		const bookOffset = 0x400 + i * 0x40;
		const loopOffset = 0x800 + i * 0x40;
		const dataOffset = 0x40 + i * size;
		dataOffsets.push(dataOffset);

		// Header: codec in the high nibble-ish byte, size in low 24.
		w32(bank, headerOffset, ((opts.codec ?? Codec.ADPCM) << 24) | size);
		w32(bank, headerOffset + 4, dataOffset);
		w32(bank, headerOffset + 8, loopOffset);
		w32(bank, headerOffset + 12, bookOffset);

		// Codebook: order 2, 1 predictor, all-zero coefficients.
		w32(bank, bookOffset, 2);
		w32(bank, bookOffset + 4, 1);

		// Loop descriptor.
		w32(bank, loopOffset, 0);
		w32(bank, loopOffset + 4, (size / 9) * 16);
		w32(bank, loopOffset + 8, opts.loopCount ?? 0);

		// Frames: scale 1, predictor 0, residual 2 in every nibble →
		// every decoded sample is 2 << 1 = 4.
		for (let f = 0; f < size / 9; f++) {
			const base = dataOffset + f * 9;
			table[base] = 0x10; // scale 1, predictor 0
			for (let b = 1; b < 9; b++) table[base + b] = 0x22;
		}
	}
	return { bank, table, dataOffsets, size };
}

describe('scanZ64Samples', () => {
	it('finds sample headers and their codebooks', () => {
		const { bank, table, dataOffsets } = build({ count: 3 });
		const samples = scanZ64Samples(bank, table);
		expect(samples.length).toBe(3);
		expect(samples.map((s) => s.dataOffset)).toEqual(dataOffsets);
		for (const s of samples) {
			expect(s.book.order).toBe(2);
			expect(s.book.npredictors).toBe(1);
			expect(s.codec).toBe(Codec.ADPCM);
			expect(s.sampleCount).toBe(64); // 4 frames * 16
		}
	});

	it('rejects a header whose data would overrun Audiotable', () => {
		const { bank } = build({ count: 1 });
		// Claim an Audiotable far smaller than the sample needs.
		expect(scanZ64Samples(bank, new Uint8Array(8))).toEqual([]);
	});

	it('rejects a header whose codebook offset is not a codebook', () => {
		const { bank, table } = build({ count: 1 });
		// Zero the codebook's order/npredictors so it fails validation.
		bank.fill(0, 0x400, 0x408);
		expect(scanZ64Samples(bank, table)).toEqual([]);
	});

	it('rejects null loop and book pointers', () => {
		for (const field of [8, 12]) {
			const { bank, table } = build({ count: 1 });
			bank.fill(0, 0x100 + field, 0x100 + field + 4);
			expect(scanZ64Samples(bank, table)).toEqual([]);
		}
	});

	it('filters non-VADPCM codecs by default', () => {
		const { bank, table } = build({ count: 2, codec: Codec.S16 });
		expect(scanZ64Samples(bank, table)).toEqual([]);
		expect(
			scanZ64Samples(bank, table, { adpcmOnly: false }).length,
		).toBe(2);
	});

	it('honours size bounds', () => {
		const { bank, table, size } = build({ count: 2 });
		expect(scanZ64Samples(bank, table, { minSize: size + 1 })).toEqual([]);
		expect(scanZ64Samples(bank, table, { maxSize: size - 1 })).toEqual([]);
	});

	it('de-duplicates samples that share waveform data', () => {
		const { bank, table } = build({ count: 3 });
		// Point header 1 at header 0's data, as two instruments
		// sharing one waveform would.
		bank[0x100 + SAMPLE_HEADER_SIZE + 7] = bank[0x107];
		bank[0x100 + SAMPLE_HEADER_SIZE + 6] = bank[0x106];
		const samples = scanZ64Samples(bank, table);
		const offsets = samples.map((s) => s.dataOffset);
		expect(new Set(offsets).size).toBe(offsets.length);
	});

	it('finds nothing in an empty or tiny bank', () => {
		expect(scanZ64Samples(new Uint8Array(0), new Uint8Array(1024))).toEqual([]);
		expect(scanZ64Samples(new Uint8Array(8), new Uint8Array(1024))).toEqual([]);
	});
});

describe('parseZ64Loop', () => {
	it('reads a one-shot descriptor without state', () => {
		const { bank } = build({ count: 1, loopCount: 0 });
		const loop = parseZ64Loop(bank, 0x800)!;
		expect(loop.count).toBe(0);
		expect(loop.state).toBeNull();
	});

	it('reads loop state when the sample loops', () => {
		const { bank } = build({ count: 1, loopCount: 2 });
		// Plant a recognisable state value.
		bank[0x800 + 16] = 0x12;
		bank[0x800 + 17] = 0x34;
		const loop = parseZ64Loop(bank, 0x800)!;
		expect(loop.count).toBe(2);
		expect(loop.state).not.toBeNull();
		expect(loop.state!.length).toBe(16);
		expect(loop.state![0]).toBe(0x1234);
	});

	it('returns null when out of range', () => {
		expect(parseZ64Loop(new Uint8Array(8), 0)).toBeNull();
		expect(parseZ64Loop(new Uint8Array(64), 100)).toBeNull();
	});
});

describe('decodeZ64Sample', () => {
	it('decodes frames through the sample codebook', () => {
		const { bank, table } = build({ count: 1 });
		const sample = scanZ64Samples(bank, table)[0];
		const result = decodeZ64Sample(table, sample);
		expect(result.samples.length).toBe(64);
		// Zero codebook, scale 1, residual 2 → every sample is 4.
		expect(Array.from(result.samples.subarray(0, 8))).toEqual(
			new Array(8).fill(4),
		);
		// A correct pairing barely clamps; here, not at all.
		expect(result.clamped).toBe(0);
	});

	it('is bounded by the Audiotable length', () => {
		const { bank, table } = build({ count: 1 });
		const sample = scanZ64Samples(bank, table)[0];
		// Truncating the table must shorten the output, not overrun.
		const short = table.subarray(0, sample.dataOffset + 9);
		expect(decodeZ64Sample(short, sample).samples.length).toBe(16);
	});
});

describe('encodeWav', () => {
	it('writes a RIFF/WAVE header and payload', () => {
		const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
		const wav = encodeWav(pcm);
		const text = (o: number, n: number) =>
			String.fromCharCode(...wav.subarray(o, o + n));
		expect(text(0, 4)).toBe('RIFF');
		expect(text(8, 4)).toBe('WAVE');
		expect(text(12, 4)).toBe('fmt ');
		expect(text(36, 4)).toBe('data');
		expect(wav.length).toBe(44 + pcm.length * 2);
		const view = new DataView(wav.buffer);
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(Z64_NOMINAL_SAMPLE_RATE);
		expect(view.getUint16(34, true)).toBe(16); // bit depth
		expect(view.getInt16(44, true)).toBe(0);
		expect(view.getInt16(46, true)).toBe(1000);
		expect(view.getInt16(48, true)).toBe(-1000);
		expect(view.getInt16(50, true)).toBe(32767);
		expect(view.getInt16(52, true)).toBe(-32768);
	});

	it('honours a custom sample rate', () => {
		const wav = encodeWav(Int16Array.from([1]), 22050);
		expect(new DataView(wav.buffer).getUint32(24, true)).toBe(22050);
	});
});
