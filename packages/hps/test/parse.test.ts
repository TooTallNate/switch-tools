import { describe, expect, it } from 'vitest';

import {
	HPS_CHANNEL_INFO_OFFSET,
	HPS_CHANNEL_INFO_SIZE,
	HPS_NO_NEXT_BLOCK,
	decodeHps,
	hpsChannelDataOffset,
	isHps,
	parseHps,
} from '../src/index.js';

/**
 * Synthetic HPS builder.
 *
 * Blocks are given distinct sizes and explicit `nextOffset` values so the chain
 * walk is genuinely exercised rather than inferred from a fixed stride.
 */

interface BlockSpec {
	/** Payload bytes per channel. Rounded up to whole 8-byte DSP frames. */
	bytesPerChannel: number;
	/** Per-channel `[yn1, yn2]`. */
	history?: [number, number][];
	/**
	 * Per-channel frame bytes. Each channel's frames are concatenated
	 * contiguously, matching the real layout.
	 */
	frames?: (channel: number) => Uint8Array;
	/** Override the chain link: 'next' (default), 'end', or a block index to loop to. */
	link?: 'next' | 'end' | number;
}

interface BuildSpec {
	sampleRate?: number;
	channelCount?: number;
	blocks: BlockSpec[];
	/** Coefficients per channel; defaults to a distinguishable ramp. */
	coefficients?: (channel: number) => Int16Array;
	magic?: string;
}

/** A DSP-ADPCM frame selecting coefficient pair 0 with scale 0. */
function flatFrame(nibbles: number[]): Uint8Array {
	const out = new Uint8Array(8);
	out[0] = 0x00;
	for (let i = 0; i < 14; i += 2) {
		out[1 + i / 2] = ((nibbles[i] & 0x0f) << 4) | (nibbles[i + 1] & 0x0f);
	}
	return out;
}

function buildHps(spec: BuildSpec): Uint8Array {
	const channelCount = spec.channelCount ?? 2;
	const sampleRate = spec.sampleRate ?? 32000;
	const blockHeaderSize = (0x0c + channelCount * 8 + 31) & ~31;
	const headerEnd = HPS_CHANNEL_INFO_OFFSET + channelCount * HPS_CHANNEL_INFO_SIZE;

	// Lay blocks out sequentially so offsets are known before writing links.
	const laid = spec.blocks.map((blk) => {
		const perCh = Math.ceil(blk.bytesPerChannel / 8) * 8;
		return { spec: blk, perCh, size: perCh * channelCount, offset: 0 };
	});
	let cursor = headerEnd;
	for (const l of laid) {
		l.offset = cursor;
		cursor += blockHeaderSize + l.size;
	}

	const out = new Uint8Array(cursor);
	const view = new DataView(out.buffer);
	const magic = spec.magic ?? ' HALPST\0';
	for (let i = 0; i < 8; i++) out[i] = magic.charCodeAt(i) & 0xff;
	view.setUint32(0x08, sampleRate, false);
	view.setUint32(0x0c, channelCount, false);

	for (let c = 0; c < channelCount; c++) {
		const at = HPS_CHANNEL_INFO_OFFSET + c * HPS_CHANNEL_INFO_SIZE;
		view.setUint32(at + 0x00, Math.max(...laid.map((l) => l.size)), false);
		view.setUint32(at + 0x04, 2, false); // DSP-ADPCM
		view.setUint32(at + 0x08, 0, false);
		view.setUint32(at + 0x0c, 2, false);
		const coefs =
			spec.coefficients?.(c) ??
			Int16Array.from({ length: 16 }, (_, k) => c * 1000 + k);
		for (let k = 0; k < 16; k++) {
			view.setInt16(at + 0x10 + k * 2, coefs[k], false);
		}
		view.setUint32(at + 0x30, 0x34 + c, false);
		view.setUint32(at + 0x34, 0, false);
	}

	laid.forEach((l, i) => {
		const at = l.offset;
		view.setUint32(at + 0x00, l.size, false);
		view.setUint32(at + 0x04, (l.perCh * 2) / channelCount - 1, false);
		const link = l.spec.link ?? 'next';
		let next: number;
		if (link === 'end') next = HPS_NO_NEXT_BLOCK;
		else if (typeof link === 'number') next = laid[link].offset;
		else next = i + 1 < laid.length ? laid[i + 1].offset : HPS_NO_NEXT_BLOCK;
		view.setUint32(at + 0x08, next, false);

		const dataAt = at + blockHeaderSize;
		for (let c = 0; c < channelCount; c++) {
			const o = at + 0x0c + c * 8;
			const h = l.spec.history?.[c] ?? [0, 0];
			// ps must match the first byte of this channel's first frame.
			const chunk = l.spec.frames?.(c);
			const firstByte = chunk ? chunk[0] : 0;
			view.setUint16(o, firstByte, false);
			view.setInt16(o + 2, h[0], false);
			view.setInt16(o + 4, h[1], false);
			if (chunk) {
				out.set(chunk.subarray(0, l.perCh), dataAt + c * l.perCh);
			}
		}
	});

	return out;
}

const TWO_BLOCKS: BuildSpec = {
	blocks: [{ bytesPerChannel: 16 }, { bytesPerChannel: 8 }],
};

describe('isHps', () => {
	it('requires the leading space in the magic', () => {
		expect(isHps(buildHps(TWO_BLOCKS))).toBe(true);
		// `HALPST\0\0` without the leading space is the classic mistake.
		expect(isHps(buildHps({ ...TWO_BLOCKS, magic: 'HALPST\0\0' }))).toBe(false);
	});

	it('rejects other containers and short buffers', () => {
		const rarc = new Uint8Array(64);
		rarc.set([0x52, 0x41, 0x52, 0x43], 0);
		expect(isHps(rarc)).toBe(false);
		expect(isHps(new Uint8Array(4))).toBe(false);
		expect(isHps(buildHps(TWO_BLOCKS), -1)).toBe(false);
	});
});

describe('parseHps', () => {
	it('reads the header and per-channel descriptors', () => {
		const f = parseHps(buildHps(TWO_BLOCKS))!;
		expect(f).not.toBeNull();
		expect(f.sampleRate).toBe(32000);
		expect(f.channelCount).toBe(2);
		expect(f.channels).toHaveLength(2);
		expect(f.channels[0].format).toBe(2);
		// Coefficients live at +0x10 in a 0x38-byte descriptor; a wrong stride
		// would read channel 1's from the wrong place.
		expect([...f.channels[0].coefficients].slice(0, 3)).toEqual([0, 1, 2]);
		expect([...f.channels[1].coefficients].slice(0, 3)).toEqual([1000, 1001, 1002]);
		expect(f.channels[1].coefficientsOffset).toBe(
			HPS_CHANNEL_INFO_OFFSET + HPS_CHANNEL_INFO_SIZE + 0x10,
		);
	});

	it('walks the chain via nextOffset and pads block headers to 32 bytes', () => {
		const f = parseHps(buildHps(TWO_BLOCKS))!;
		expect(f.blocks).toHaveLength(2);
		// For 2 channels the header is 0x0C + 16 = 0x1C, padded to 0x20.
		expect(f.blocks[0].dataOffset - f.blocks[0].offset).toBe(0x20);
		expect(f.blocks[0].size).toBe(32);
		expect(f.blocks[1].size).toBe(16);
		expect(f.blocks[1].offset).toBe(f.blocks[0].nextOffset);
	});

	it('treats a backwards nextOffset as a loop rather than recursing forever', () => {
		// The real format expresses looping this way: the last block points back
		// at an earlier one instead of using a terminator.
		const f = parseHps(
			buildHps({
				blocks: [
					{ bytesPerChannel: 8 },
					{ bytesPerChannel: 8 },
					{ bytesPerChannel: 8, link: 1 },
				],
			}),
		)!;
		expect(f.blocks).toHaveLength(3);
		expect(f.looped).toBe(true);
		expect(f.loopBlockIndex).toBe(1);
		expect(f.blocks[2].nextOffset).toBe(f.blocks[1].offset);
	});

	it('reports a terminated chain as not looping', () => {
		const f = parseHps(
			buildHps({ blocks: [{ bytesPerChannel: 8 }, { bytesPerChannel: 8, link: 'end' }] }),
		)!;
		expect(f.looped).toBe(false);
		expect(f.loopBlockIndex).toBe(-1);
		expect(f.blocks).toHaveLength(2);
	});

	it('derives sample count and duration from the blocks', () => {
		// 32 bytes per channel = 4 frames = 56 samples; plus 8 bytes = 14. 70 total.
		const f = parseHps(
			buildHps({ blocks: [{ bytesPerChannel: 32 }, { bytesPerChannel: 8 }] }),
		)!;
		expect(f.sampleCount).toBe(56 + 14);
		expect(f.durationSeconds).toBeCloseTo(70 / 32000, 6);
	});

	it('rejects malformed headers', () => {
		expect(parseHps(new Uint8Array(0x80))).toBeNull();
		const badRate = buildHps(TWO_BLOCKS);
		new DataView(badRate.buffer).setUint32(0x08, 10, false);
		expect(parseHps(badRate)).toBeNull();
		const badCh = buildHps(TWO_BLOCKS);
		new DataView(badCh.buffer).setUint32(0x0c, 99, false);
		expect(parseHps(badCh)).toBeNull();
	});

	it('stops on a block whose payload escapes the buffer', () => {
		const bytes = buildHps(TWO_BLOCKS);
		const f0 = parseHps(bytes)!.blocks[0];
		const broken = bytes.slice();
		new DataView(broken.buffer).setUint32(f0.offset, 0x7fff0000, false);
		// Either no blocks (so null) or a truncated chain — never a read past EOF.
		const f = parseHps(broken);
		if (f) expect(f.blocks.length).toBeLessThan(2);
		else expect(f).toBeNull();
	});

	it('stops on a block size not divisible by the channel count', () => {
		const bytes = buildHps(TWO_BLOCKS);
		const f0 = parseHps(bytes)!.blocks[0];
		const broken = bytes.slice();
		new DataView(broken.buffer).setUint32(f0.offset, 17, false);
		expect(parseHps(broken)).toBeNull();
	});
});

describe('hpsChannelDataOffset', () => {
	it('places channels as contiguous halves, not interleaved frames', () => {
		// This is the layout question that statistics could not settle: an
		// interleaved reading also produces audio-like output. Channel 1 starts
		// halfway through the payload, not 8 bytes in.
		const f = parseHps(buildHps({ blocks: [{ bytesPerChannel: 64 }] }))!;
		const blk = f.blocks[0];
		expect(hpsChannelDataOffset(blk, 0, 2)).toBe(blk.dataOffset);
		expect(hpsChannelDataOffset(blk, 1, 2)).toBe(blk.dataOffset + 64);
		expect(hpsChannelDataOffset(blk, 1, 2)).not.toBe(blk.dataOffset + 8);
	});

	it('agrees with each block header ps, which is what pins the layout down', () => {
		// The header records every channel's first predictor/scale byte, so a
		// wrong layout is detectable without listening to anything.
		const frames = (c: number) => {
			const out = new Uint8Array(8);
			out.set(flatFrame(new Array(14).fill(1)));
			out[0] = 0x40 + c; // distinct ps per channel
			return out;
		};
		const bytes = buildHps({ blocks: [{ bytesPerChannel: 8, frames }] });
		const f = parseHps(bytes)!;
		for (let c = 0; c < f.channelCount; c++) {
			const at = hpsChannelDataOffset(f.blocks[0], c, f.channelCount);
			expect(bytes[at]).toBe(f.blocks[0].states[c].ps & 0xff);
		}
	});
});

describe('decodeHps', () => {
	const zeroCoefs = () => new Int16Array(16);

	it('decodes to interleaved PCM and keeps channels distinct', () => {
		// With a zeroed coefficient table and scale 0 the predictor contributes
		// nothing, so each output sample is the sign-extended nibble.
		const bytes = buildHps({
			coefficients: zeroCoefs,
			blocks: [
				{
					bytesPerChannel: 8,
					frames: (c) =>
						flatFrame(
							c === 0
								? [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]
								: [7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1],
						),
				},
			],
		});
		const f = parseHps(bytes)!;
		const d = decodeHps(bytes, f)!;
		expect(d.sampleRate).toBe(32000);
		expect(d.channelCount).toBe(2);
		expect(d.sampleCount).toBe(14);
		expect(d.samples).toHaveLength(28);
		// Left ascends, right descends: proves the halves weren't swapped or
		// concatenated instead of interleaved on output.
		expect(d.samples[0]).toBe(1);
		expect(d.samples[1]).toBe(7);
		expect(d.samples[2]).toBe(2);
		expect(d.samples[3]).toBe(6);
	});

	it('resets history per block from the block header', () => {
		// Each block restates yn1/yn2, which is what makes blocks independently
		// decodable. A non-zero history must be honoured.
		const bytes = buildHps({
			coefficients: () => Int16Array.from({ length: 16 }, (_, k) => (k === 0 ? 2048 : 0)),
			blocks: [
				{ bytesPerChannel: 8, history: [[100, 0], [100, 0]], frames: () => flatFrame(new Array(14).fill(0)) },
			],
		});
		const f = parseHps(bytes)!;
		expect(f.blocks[0].states[0].yn1).toBe(100);
		const d = decodeHps(bytes, f)!;
		// Coefficient pair 0 is [2048, 0] = 1.0 * yn1, and the nibbles are 0, so
		// the output holds at the seeded history value.
		expect(d.samples[0]).toBe(100);
	});

	it('concatenates multiple blocks', () => {
		const f = parseHps(buildHps({ blocks: [{ bytesPerChannel: 8 }, { bytesPerChannel: 8 }] }))!;
		const bytes = buildHps({ blocks: [{ bytesPerChannel: 8 }, { bytesPerChannel: 8 }] });
		const d = decodeHps(bytes, f)!;
		expect(d.sampleCount).toBe(28);
		expect(d.samples).toHaveLength(56);
	});

	it('returns a mono buffer without interleaving', () => {
		const bytes = buildHps({ channelCount: 1, blocks: [{ bytesPerChannel: 8 }] });
		const f = parseHps(bytes)!;
		const d = decodeHps(bytes, f)!;
		expect(d.channelCount).toBe(1);
		expect(d.samples).toHaveLength(d.sampleCount);
	});

	it('keeps the sample buffer divisible by the channel count', () => {
		// The invariant `encodeWav` enforces.
		const bytes = buildHps(TWO_BLOCKS);
		const d = decodeHps(bytes, parseHps(bytes)!)!;
		expect(d.samples.length % d.channelCount).toBe(0);
		expect(d.samples.length).toBe(d.sampleCount * d.channelCount);
	});
});
