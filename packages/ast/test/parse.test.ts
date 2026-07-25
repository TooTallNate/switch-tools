import { describe, expect, it } from 'vitest';

import {
	AST_BLOCK_HEADER_SIZE,
	AST_HEADER_SIZE,
	AstCodec,
	astChannelDataOffset,
	decodeAst,
	isAst,
	parseAst,
} from '../src/index.js';

/**
 * Synthetic AST builder. Blocks get deliberately different sizes so the walk is
 * exercised rather than inferred from a constant stride.
 */
interface BuildSpec {
	channelCount?: number;
	sampleRate?: number;
	codec?: number;
	/** Samples per channel in each block. */
	blocks: number[];
	/** Declared total; defaults to the sum. */
	sampleCount?: number;
	loopStart?: number;
	loopEnd?: number;
	/** Sample value generator, so channels can be told apart. */
	sample?: (channel: number, index: number) => number;
	magic?: string;
	trailing?: number;
}

function buildAst(spec: BuildSpec): Uint8Array {
	const ch = spec.channelCount ?? 2;
	const codec = spec.codec ?? AstCodec.PCM16;
	const total = spec.sampleCount ?? spec.blocks.reduce((a, b) => a + b, 0);
	const body = spec.blocks.reduce(
		(a, n) => a + AST_BLOCK_HEADER_SIZE + n * 2 * ch,
		0,
	);
	const out = new Uint8Array(AST_HEADER_SIZE + body + (spec.trailing ?? 0));
	const v = new DataView(out.buffer);
	const magic = spec.magic ?? 'STRM';
	for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
	v.setUint32(0x04, body, false);
	v.setUint16(0x08, codec, false);
	v.setUint16(0x0a, 16, false);
	v.setUint16(0x0c, ch, false);
	v.setUint16(0x0e, 0xffff, false);
	v.setUint32(0x10, spec.sampleRate ?? 32000, false);
	v.setUint32(0x14, total, false);
	v.setUint32(0x18, spec.loopStart ?? 0, false);
	v.setUint32(0x1c, spec.loopEnd ?? total, false);
	v.setUint32(0x20, spec.blocks[0] * 2, false);

	let at = AST_HEADER_SIZE;
	let sampleBase = 0;
	for (const n of spec.blocks) {
		out.set([0x42, 0x4c, 0x43, 0x4b], at); // 'BLCK'
		v.setUint32(at + 4, n * 2, false); // blockSize is PER CHANNEL
		const data = at + AST_BLOCK_HEADER_SIZE;
		for (let c = 0; c < ch; c++) {
			for (let i = 0; i < n; i++) {
				const val = spec.sample ? spec.sample(c, sampleBase + i) : 0;
				v.setInt16(data + c * n * 2 + i * 2, val, false);
			}
		}
		at = data + n * 2 * ch;
		sampleBase += n;
	}
	return out;
}

const THREE: BuildSpec = { blocks: [8, 4, 6] };

describe('isAst', () => {
	it('accepts STRM and rejects others', () => {
		expect(isAst(buildAst(THREE))).toBe(true);
		expect(isAst(buildAst({ ...THREE, magic: 'RARC' }))).toBe(false);
		expect(isAst(new Uint8Array(4))).toBe(false);
		expect(isAst(buildAst(THREE), -1)).toBe(false);
	});
});

describe('parseAst', () => {
	it('reads the header', () => {
		const f = parseAst(buildAst(THREE))!;
		expect(f).not.toBeNull();
		expect(f.codec).toBe(AstCodec.PCM16);
		expect(f.bitDepth).toBe(16);
		expect(f.channelCount).toBe(2);
		expect(f.sampleRate).toBe(32000);
		expect(f.sampleCount).toBe(18);
		expect(f.durationSeconds).toBeCloseTo(18 / 32000, 8);
	});

	it('treats blockSize as per-channel, not total', () => {
		// The trap: a block occupies 0x20 + blockSize * channels. Reading the
		// field as a total advances at half speed and desyncs on block two.
		const f = parseAst(buildAst(THREE))!;
		expect(f.blocks).toHaveLength(3);
		expect(f.blocks.map((b) => b.blockSize)).toEqual([16, 8, 12]);
		let at = AST_HEADER_SIZE;
		for (const b of f.blocks) {
			expect(b.offset).toBe(at);
			expect(b.dataOffset).toBe(at + AST_BLOCK_HEADER_SIZE);
			at = b.dataOffset + b.blockSize * f.channelCount;
		}
	});

	it('places channels as contiguous halves', () => {
		const f = parseAst(buildAst(THREE))!;
		const b = f.blocks[0];
		expect(astChannelDataOffset(b, 0)).toBe(b.dataOffset);
		expect(astChannelDataOffset(b, 1)).toBe(b.dataOffset + b.blockSize);
		// Not the interleaved reading, which would put channel 1 two bytes in.
		expect(astChannelDataOffset(b, 1)).not.toBe(b.dataOffset + 2);
	});

	it('stops cleanly at trailing padding rather than misreading it', () => {
		const f = parseAst(buildAst({ ...THREE, trailing: 64 }))!;
		expect(f.blocks).toHaveLength(3);
	});

	it('caps decodable samples at the declared count', () => {
		// Real files pad the last block, so the blocks supply a few more samples
		// than the header declares.
		const f = parseAst(buildAst({ blocks: [8, 8], sampleCount: 12 }))!;
		expect(f.decodableSamples).toBe(12);
	});

	it('reports looping only for a real subrange', () => {
		expect(parseAst(buildAst({ ...THREE, loopStart: 4, loopEnd: 18 }))!.looped).toBe(true);
		// loopStart 0 with loopEnd == length is the "no loop" encoding.
		expect(parseAst(buildAst({ ...THREE, loopStart: 0, loopEnd: 18 }))!.looped).toBe(false);
	});

	it('rejects malformed headers', () => {
		expect(parseAst(new Uint8Array(AST_HEADER_SIZE))).toBeNull();
		const badCh = buildAst(THREE);
		new DataView(badCh.buffer).setUint16(0x0c, 0, false);
		expect(parseAst(badCh)).toBeNull();
		const badRate = buildAst(THREE);
		new DataView(badRate.buffer).setUint32(0x10, 10, false);
		expect(parseAst(badRate)).toBeNull();
		const noSamples = buildAst(THREE);
		new DataView(noSamples.buffer).setUint32(0x14, 0, false);
		expect(parseAst(noSamples)).toBeNull();
	});

	it('describes an ADPCM file but marks nothing decodable', () => {
		// We recognise codec 0 without pretending to decode it.
		const f = parseAst(buildAst({ ...THREE, codec: AstCodec.ADPCM }))!;
		expect(f.codec).toBe(AstCodec.ADPCM);
		expect(f.decodableSamples).toBe(0);
	});
});

describe('decodeAst', () => {
	it('decodes to interleaved PCM keeping channels distinct', () => {
		const bytes = buildAst({
			blocks: [4],
			sample: (c, i) => (c === 0 ? 100 + i : -(100 + i)),
		});
		const d = decodeAst(bytes, parseAst(bytes)!)!;
		expect(d.channelCount).toBe(2);
		expect(d.sampleCount).toBe(4);
		expect([...d.samples]).toEqual([100, -100, 101, -101, 102, -102, 103, -103]);
	});

	it('joins blocks in order and stays continuous across the seam', () => {
		// A wrong channel layout shows up as a discontinuity exactly here.
		const bytes = buildAst({
			blocks: [4, 4],
			sample: (c, i) => (c === 0 ? i : 1000 + i),
		});
		const d = decodeAst(bytes, parseAst(bytes)!)!;
		expect(d.sampleCount).toBe(8);
		const left = [...d.samples].filter((_, i) => i % 2 === 0);
		expect(left).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('reads samples as big-endian', () => {
		const bytes = buildAst({ blocks: [1], channelCount: 1, sample: () => 0x0102 });
		const d = decodeAst(bytes, parseAst(bytes)!)!;
		expect(d.samples[0]).toBe(0x0102);
	});

	it('refuses a codec it cannot decode', () => {
		const bytes = buildAst({ ...THREE, codec: AstCodec.ADPCM });
		expect(decodeAst(bytes, parseAst(bytes)!)).toBeNull();
	});

	it('keeps the buffer divisible by the channel count', () => {
		const bytes = buildAst(THREE);
		const d = decodeAst(bytes, parseAst(bytes)!)!;
		expect(d.samples.length % d.channelCount).toBe(0);
		expect(d.samples.length).toBe(d.sampleCount * d.channelCount);
	});
});
