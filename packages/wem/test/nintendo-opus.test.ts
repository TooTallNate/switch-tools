import { describe, expect, it } from 'vitest';
import { isNintendoOpus, nintendoOpusToOggOpus, parseNintendoOpus } from '../src/index.js';

/** Build a Nintendo Opus stream (Super Mario RPG AWB layout) with the given packets. */
function buildNxOpus(packets: Uint8Array[], channels = 2): Uint8Array {
	const framed = packets.flatMap((p) => [
		...[p.length >>> 24, (p.length >>> 16) & 0xff, (p.length >>> 8) & 0xff, p.length & 0xff],
		0, 0, 0, 0, // final range (ignored)
		...p,
	]);
	const header = 0x20;
	const out = new Uint8Array(header + 8 + framed.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0x00, 0x80000001, true);
	dv.setUint32(0x04, 0x18, true);
	out[0x09] = channels;
	dv.setUint32(0x0c, 48000, true);
	dv.setUint32(0x10, header, true);
	dv.setUint16(0x1c, 0x78, true); // pre-skip 120
	dv.setUint32(header, 0x80000004, true);
	dv.setUint32(header + 4, framed.length, true);
	out.set(framed, header + 8);
	return out;
}

describe('Nintendo Opus', () => {
	// TOC 0xFC: CELT fullband, 20 ms, one frame (960 samples).
	const pkt = (n: number) => new Uint8Array([0xfc, ...Array(n).fill(n)]);

	it('parses the header', () => {
		const bytes = buildNxOpus([pkt(10), pkt(20)]);
		expect(isNintendoOpus(bytes)).toBe(true);
		expect(parseNintendoOpus(bytes)).toEqual({
			channels: 2,
			sampleRate: 48000,
			preSkip: 120,
			dataOffset: 0x28,
			dataSize: 2 * 8 + 11 + 21,
		});
	});

	it('remuxes packets into an Ogg-Opus stream', async () => {
		const bytes = buildNxOpus([pkt(10), pkt(20), pkt(30)]);
		const { ogg } = nintendoOpusToOggOpus(bytes);
		const b = new Uint8Array(await ogg.arrayBuffer());
		const text = new TextDecoder('latin1').decode(b);
		expect(text.startsWith('OggS')).toBe(true);
		const head = text.indexOf('OpusHead');
		expect(head).toBeGreaterThan(0);
		expect(b[head + 9]).toBe(2); // channel count
		expect(text).toContain('OpusTags');
		// All three packets' payloads made it through.
		for (const n of [10, 20, 30]) {
			expect(b.some((_, i) => b[i] === 0xfc && b.subarray(i + 1, i + 1 + n).every((x) => x === n))).toBe(true);
		}
	});

	it('rejects non-Opus input', () => {
		expect(isNintendoOpus(new Uint8Array([0x48, 0x43, 0x41, 0]))).toBe(false);
		expect(() => parseNintendoOpus(new Uint8Array(0x40))).toThrow(/0x80000001/);
	});
});
