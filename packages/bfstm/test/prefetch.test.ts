import { describe, it, expect } from 'vitest';
import { parseBfstm, decodeBfstmToPcm16, BfstmCodec } from '../src/index.js';

/**
 * Build a minimal little-endian PCM16 BFSTP: header, INFO and a PDAT
 * holding the first `prefetchBlocks` interleave blocks. The layout
 * mirrors the real files (PDAT entry reference points 0x34 past the
 * entry, i.e. PDAT+0x40).
 */
function buildBfstp(opts: {
	channels: number;
	samplesPerBlock: number;
	blockCount: number;
	lastBlockSamples: number;
	prefetchBlocks: number;
	sample: (c: number, i: number) => number;
}): Uint8Array {
	const { channels, samplesPerBlock, blockCount, lastBlockSamples, prefetchBlocks } = opts;
	const blockSize = samplesPerBlock * 2;
	const lastPadded = Math.ceil((lastBlockSamples * 2) / 0x20) * 0x20;
	const total = (blockCount - 1) * samplesPerBlock + lastBlockSamples;
	const infoOff = 0x40;
	const infoSize = 0x100;
	const pdatOff = infoOff + infoSize;
	const blocks: number[] = [];
	for (let b = 0; b < Math.min(prefetchBlocks, blockCount); b++) blocks.push(b);
	const sizeOf = (b: number) => (b === blockCount - 1 ? lastPadded : blockSize);
	const payload = blocks.reduce((n, b) => n + sizeOf(b) * channels, 0);
	const pdatSize = 0x40 + payload;
	const out = new Uint8Array(pdatOff + pdatSize);
	const v = new DataView(out.buffer);
	out.set([0x46, 0x53, 0x54, 0x50, 0xff, 0xfe]); // FSTP, LE BOM
	v.setUint32(0x0c, out.length, true);
	v.setUint16(0x10, 2, true);
	v.setUint16(0x14, 0x4000, true);
	v.setInt32(0x18, infoOff, true);
	v.setUint32(0x1c, infoSize, true);
	v.setUint16(0x20, 0x4004, true);
	v.setInt32(0x24, pdatOff, true);
	v.setUint32(0x28, pdatSize, true);
	// INFO
	const I = infoOff;
	out.set([0x49, 0x4e, 0x46, 0x4f], I);
	v.setUint32(I + 4, infoSize, true);
	v.setInt32(I + 0x1c, 0x70, true); // channel table at INFO+0x78
	out[I + 0x20] = BfstmCodec.Pcm16;
	out[I + 0x22] = channels;
	v.setUint32(I + 0x24, 48000, true);
	v.setUint32(I + 0x2c, total, true);
	v.setUint32(I + 0x30, blockCount, true);
	v.setUint32(I + 0x34, blockSize, true);
	v.setUint32(I + 0x38, samplesPerBlock, true);
	v.setUint32(I + 0x3c, lastBlockSamples * 2, true);
	v.setUint32(I + 0x40, lastBlockSamples, true);
	v.setUint32(I + 0x44, lastPadded, true);
	const T = I + 0x78;
	v.setUint32(T, channels, true);
	for (let c = 0; c < channels; c++) {
		v.setUint16(T + 4 + c * 8, 0x4102, true);
		v.setInt32(T + 8 + c * 8, 0x40 + c * 8, true);
		v.setUint16(T + 0x40 + c * 8, 0x0300, true);
		v.setInt32(T + 0x44 + c * 8, -1, true);
	}
	// PDAT
	const P = pdatOff;
	out.set([0x50, 0x44, 0x41, 0x54], P);
	v.setUint32(P + 4, pdatSize, true);
	v.setUint32(P + 8, 1, true);
	v.setUint32(P + 0x10, payload, true);
	v.setInt32(P + 0x1c, 0x34, true);
	let o = P + 0x40;
	for (const b of blocks) {
		const n = b === blockCount - 1 ? lastBlockSamples : samplesPerBlock;
		for (let c = 0; c < channels; c++) {
			for (let i = 0; i < n; i++) v.setInt16(o + i * 2, opts.sample(c, b * samplesPerBlock + i), true);
			o += sizeOf(b);
		}
	}
	return out;
}

const sample = (c: number, i: number) => ((i * 7 + c * 1000) % 30000) - 15000;

describe('BFSTP prefetch (PDAT)', () => {
	it('decodes the prefetched opening blocks of a longer stream', async () => {
		const file = buildBfstp({ channels: 2, samplesPerBlock: 256, blockCount: 5, lastBlockSamples: 100, prefetchBlocks: 2, sample });
		const p = await parseBfstm(new Blob([file]));
		expect(p.magic).toBe('FSTP');
		expect(p.prefetchOnly).toBe(true);
		expect(p.streamTotalSamples).toBe(4 * 256 + 100);
		expect(p.totalSamples).toBe(512);
		const { samples, numChannels } = await decodeBfstmToPcm16(p);
		expect(numChannels).toBe(2);
		expect(samples.length).toBe(512 * 2);
		for (let i = 0; i < 512; i++) {
			expect(samples[i * 2]).toBe(sample(0, i));
			expect(samples[i * 2 + 1]).toBe(sample(1, i));
		}
	});

	it('keeps the full geometry when the prefetch covers the whole stream', async () => {
		const file = buildBfstp({ channels: 1, samplesPerBlock: 256, blockCount: 2, lastBlockSamples: 40, prefetchBlocks: 2, sample });
		const p = await parseBfstm(new Blob([file]));
		expect(p.prefetchOnly).toBe(false);
		expect(p.totalSamples).toBe(296);
		const { samples } = await decodeBfstmToPcm16(p);
		for (let i = 0; i < 296; i++) expect(samples[i]).toBe(sample(0, i));
	});
});
