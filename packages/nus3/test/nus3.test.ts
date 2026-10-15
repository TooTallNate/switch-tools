import { describe, it, expect } from 'vitest';
import { decodeIdsp, isNus3Bank, nus3HeaderSize, parseNus3Bank, readIdspInfo } from '../src/index.js';

/**
 * A 2-channel IDSP: zero coefficients, so each sample is just
 * `nibble << scale`. Channel 0's nibbles are all +1, channel 1's all -1,
 * with 0x10-byte (two-frame) interleave.
 */
function buildIdsp(frames: number): Uint8Array {
	const perChannel = frames * 8;
	const data = 0x100;
	const out = new Uint8Array(data + perChannel * 2);
	const dv = new DataView(out.buffer);
	out.set([0x49, 0x44, 0x53, 0x50]);
	dv.setUint32(0x08, 2, false);
	dv.setUint32(0x0c, 47999, false);
	dv.setUint32(0x10, frames * 14, false);
	dv.setUint32(0x14, 14, false);
	dv.setUint32(0x18, frames * 14 - 1, false);
	dv.setUint32(0x1c, 0x10, false);
	dv.setUint32(0x20, 0x40, false);
	dv.setUint32(0x24, 0x60, false);
	dv.setUint32(0x28, data, false);
	dv.setUint32(0x2c, perChannel, false);
	for (const h of [0x40, 0xa0]) dv.setUint16(h + 0x0c, 1, false);
	let src = data;
	for (let pos = 0; pos < perChannel; pos += 0x10) {
		const n = Math.min(0x10, perChannel - pos);
		for (const nibble of [0x11, 0xff]) {
			for (let f = 0; f * 8 < n; f++) {
				out[src + f * 8] = 0x02; // predictor 0, scale 2^2
				out.fill(nibble, src + f * 8 + 1, src + f * 8 + 8);
			}
			src += n;
		}
	}
	return out;
}

function buildBank(stream: Uint8Array): Uint8Array {
	const name = new TextEncoder().encode('SE_TEST\0');
	const tone = new Uint8Array(0x0c + 0x10 + 0x10 + 0x40);
	const tv = new DataView(tone.buffer);
	tv.setUint32(0, 2, true); // two tones: a container (0x7F) and a stream
	tv.setUint32(4, 0x14, true);
	tv.setUint32(8, 0x10, true);
	tv.setUint32(12, 0x24, true);
	tv.setUint32(16, 0x30, true);
	tv.setUint16(0x14 + 4, 0x7f, true);
	tv.setUint16(0x24 + 4, 0xffff, true);
	tone[0x24 + 0x0c] = name.byteLength;
	tone.set(name, 0x24 + 0x0d);
	const q = 0x24 + ((0x0d + name.byteLength + 3) & ~3);
	tv.setUint32(q + 4, 8, true);
	tv.setUint32(q + 8, 0, true);
	tv.setUint32(q + 12, stream.byteLength, true);
	const chunks: [string, Uint8Array][] = [
		['TONE', tone],
		['PACK', stream],
	];
	const toc = 0x18 + chunks.length * 8;
	const total = toc + chunks.reduce((s, [, d]) => s + 8 + d.byteLength, 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	out.set(new TextEncoder().encode('NUS3'));
	dv.setUint32(4, total - 8, true);
	out.set(new TextEncoder().encode('BANKTOC '), 8);
	dv.setUint32(0x10, 4 + chunks.length * 8, true);
	dv.setUint32(0x14, chunks.length, true);
	let o = toc;
	chunks.forEach(([m, d], i) => {
		out.set(new TextEncoder().encode(m), 0x18 + i * 8);
		dv.setUint32(0x1c + i * 8, d.byteLength, true);
		out.set(new TextEncoder().encode(m), o);
		dv.setUint32(o + 4, d.byteLength, true);
		out.set(d, o + 8);
		o += 8 + d.byteLength;
	});
	return out;
}

describe('NUS3BANK', () => {
	it('lists playable tones and skips containers', () => {
		const stream = buildIdsp(5);
		const bank = buildBank(stream);
		expect(isNus3Bank(bank)).toBe(true);
		expect(nus3HeaderSize(bank)).toBe(bank.byteLength - stream.byteLength);
		const parsed = parseNus3Bank(bank);
		expect(parsed.tones).toHaveLength(1);
		const [t] = parsed.tones;
		expect(t).toMatchObject({ index: 1, name: 'SE_TEST', size: stream.byteLength, codec: 'IDSP' });
		expect(bank.subarray(t!.offset, t!.offset + t!.size)).toEqual(stream);
	});

	it('decodes interleaved IDSP', () => {
		const stream = buildIdsp(5);
		expect(readIdspInfo(stream)).toEqual({ channels: 2, sampleRate: 48000, numSamples: 70, loop: { start: 14, end: 70 } });
		const d = decodeIdsp(stream);
		expect(d.samples).toHaveLength(140);
		expect(Array.from(d.samples.subarray(0, 8))).toEqual([4, -4, 4, -4, 4, -4, 4, -4]);
		for (let i = 0; i < 70; i++) {
			expect(d.samples[i * 2]).toBe(4);
			expect(d.samples[i * 2 + 1]).toBe(-4);
		}
	});
});
