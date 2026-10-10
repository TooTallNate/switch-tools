import { describe, expect, it } from 'vitest';
import { fnv1a64, isAhtb, isGfMessage, isGfMessageHeader, parseAhtb, parseGfMessage } from '../src/index.js';

/** Encode lines (arrays of UTF-16 code units) into an encrypted message file. */
function buildMessage(lines: number[][]): Uint8Array {
	const tableSize = 4 + lines.length * 8;
	const body = lines.map((l) => [...l, 0]);
	const dataSize = body.reduce((s, l) => s + l.length * 2 + (l.length % 2 ? 2 : 0), 0);
	const sectionSize = tableSize + dataSize;
	const out = new Uint8Array(0x10 + sectionSize);
	const dv = new DataView(out.buffer);
	dv.setUint16(0, 1, true);
	dv.setUint16(2, lines.length, true);
	dv.setUint32(4, sectionSize, true);
	dv.setUint32(8, 0, true);
	dv.setUint32(12, 0x10, true);
	dv.setUint32(0x10, sectionSize, true);
	let off = tableSize;
	body.forEach((chars, i) => {
		dv.setInt32(0x10 + 4 + i * 8, off, true);
		dv.setUint16(0x10 + 8 + i * 8, chars.length, true);
		let key = (0x7c89 + i * 0x2983) & 0xffff;
		chars.forEach((c, j) => {
			dv.setUint16(0x10 + off + j * 2, c ^ key, true);
			key = ((key << 3) | (key >>> 13)) & 0xffff;
		});
		off += chars.length * 2 + (chars.length % 2 ? 2 : 0);
	});
	return out;
}

const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function buildAhtb(names: string[]): Uint8Array {
	const enc = new TextEncoder();
	const parts = names.map((n) => enc.encode(n + '\0'));
	const out = new Uint8Array(8 + parts.reduce((s, p) => s + 10 + p.length, 0));
	const dv = new DataView(out.buffer);
	out.set([0x41, 0x48, 0x54, 0x42]);
	dv.setUint32(4, names.length, true);
	let o = 8;
	parts.forEach((p, i) => {
		dv.setBigUint64(o, fnv1a64(names[i]), true);
		dv.setUint16(o + 8, p.length, true);
		out.set(p, o + 10);
		o += 10 + p.length;
	});
	return out;
}

describe('parseGfMessage', () => {
	const file = buildMessage([
		text('Lv. ').concat([0x10, 2, 0x0202, 0]),
		text('You got ').concat([0xe300, 0x10, 3, 0x0207, 1, 44], text('.')),
		[0x10, 1, 0x1001],
		text('Hello'),
	]);

	it('detects the header', () => {
		expect(isGfMessage(file)).toBe(true);
		expect(isGfMessageHeader(file.subarray(0, 0x20), file.length)).toBe(true);
		expect(isGfMessageHeader(file.subarray(0, 0x20), file.length + 2)).toBe(false);
	});

	it('decrypts lines and renders variables', () => {
		const lines = parseGfMessage(file).lines.map((l) => l.text);
		expect(lines).toEqual(['Lv. [NUM3(0)]', 'You got ₽[NUM8(1,44)].', '[VAR 0x1001]', 'Hello']);
	});

	it('exposes variable tokens', () => {
		const tok = parseGfMessage(file).lines[0].tokens[1];
		expect(tok).toEqual({ variable: { code: 0x0202, name: 'NUM3', args: [0] } });
	});

	it('rejects garbage', () => {
		expect(() => parseGfMessage(new Uint8Array(4))).toThrow();
	});
});

describe('parseAhtb', () => {
	it('reads hashes and names', () => {
		const t = parseAhtb(buildAhtb(['msg_bag_01_01', 'msg_bag_max']));
		expect(t.map((e) => e.name)).toEqual(['msg_bag_01_01', 'msg_bag_max']);
		expect(t[0].hash).toBe(fnv1a64('msg_bag_01_01'));
	});

	it('checks the magic', () => {
		expect(isAhtb(new Uint8Array(8))).toBe(false);
		expect(() => parseAhtb(new Uint8Array(8))).toThrow(/AHTB/);
	});
});
