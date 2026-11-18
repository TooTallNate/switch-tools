import { describe, expect, it } from 'vitest';
import { isPacx, readPacx } from '../src/index.js';

/**
 * A v3 pac with one type ("ResText") holding two files under a shared
 * radix prefix: `abc.txt` (file tree: "ab" → "c" data, "d" data → `abd.txt`).
 */
function v3Pac(files: { name: string; data: Uint8Array }[], version = '402'): Uint8Array {
	// Layout: header 0x30 | type tree 0x18 | type node 0x28 | file tree 0x18 | file nodes | data indices | child arrays | data entries | strings | data
	const out = new Uint8Array(0x1000);
	const dv = new DataView(out.buffer);
	const enc = new TextEncoder();
	out.set(enc.encode(`PACx${version}L`), 0);
	let strAt = 0x600;
	const str = (s: string) => {
		const at = strAt;
		out.set(enc.encode(s), at);
		strAt += s.length + 1;
		return at;
	};
	const u64 = (o: number, v: number) => dv.setBigUint64(o, BigInt(v), true);
	const node = (o: number, name: number, data: number, children: number, childCount: number, hasData: boolean, bufStart: number) => {
		u64(o, name);
		u64(o + 8, data);
		u64(o + 16, children);
		dv.setUint16(o + 0x24, childCount, true);
		out[o + 0x26] = hasData ? 1 : 0;
		out[o + 0x27] = bufStart;
	};
	// Type tree with one data node.
	dv.setUint32(0x30, 1, true);
	dv.setUint32(0x34, 1, true);
	u64(0x38, 0x48);
	u64(0x40, 0x70);
	dv.setInt32(0x70, 0, true);
	node(0x48, str('txt:ResText'), 0x80, 0, 0, true, 0);
	// File tree: root(0) → "ab"(1) → "c"(2) → data(3); "ab" → "d"(4) → data(5)
	const nodes = 0xa0;
	dv.setUint32(0x80, 6, true);
	dv.setUint32(0x84, 2, true);
	u64(0x88, nodes);
	const kids = 0x300;
	const kid = (i: number, list: number[]) => {
		const at = kids + i * 16;
		list.forEach((x, k) => dv.setInt32(at + k * 4, x, true));
		return at;
	};
	const entries = 0x400;
	const dataAt = 0x800;
	let dOff = dataAt;
	const entry = (i: number, f: { data: Uint8Array }) => {
		const e = entries + i * 0x30;
		dv.setUint32(e + 4, f.data.length, true);
		u64(e + 0x10, dOff);
		u64(e + 0x20, str('txt'));
		out.set(f.data, dOff);
		dOff += f.data.length;
		return e;
	};
	node(nodes + 0 * 0x28, 0, 0, kid(0, [1]), 1, false, 0);
	node(nodes + 1 * 0x28, str('ab'), 0, kid(1, [2, 4]), 2, false, 0);
	node(nodes + 2 * 0x28, str('c'), 0, kid(2, [3]), 1, false, 2);
	node(nodes + 3 * 0x28, 0, entry(0, files[0]!), 0, 0, true, 3);
	node(nodes + 4 * 0x28, str('d'), 0, kid(4, [5]), 1, false, 2);
	node(nodes + 5 * 0x28, 0, entry(1, files[1]!), 0, 0, true, 3);
	dv.setUint32(0x10, 0x80 - 0x30, true); // treesSize
	return out.subarray(0, dOff);
}

/** An LZ4 block holding `data` as one literal run. */
function lz4Literal(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	if (data.length < 15) out.push(data.length << 4);
	else {
		out.push(0xf0);
		let n = data.length - 15;
		while (n >= 255) {
			out.push(255);
			n -= 255;
		}
		out.push(n);
	}
	out.push(...data);
	return Uint8Array.from(out);
}

describe('PACx', () => {
	const a = new TextEncoder().encode('hello');
	const b = new TextEncoder().encode('world!');

	it('reads a v3 pac through its radix file tree', () => {
		const pac = v3Pac([{ name: 'abc', data: a }, { name: 'abd', data: b }]);
		expect(isPacx(pac)).toBe(true);
		const r = readPacx(pac);
		expect(r.entries.map((e) => [e.name, e.ext, new TextDecoder().decode(e.data)])).toEqual([
			['abc.txt', 'txt', 'hello'],
			['abd.txt', 'txt', 'world!'],
		]);
	});

	it('reads a v4 wrapper around an uncompressed root', () => {
		const root = v3Pac([{ name: 'abc', data: a }, { name: 'abd', data: b }]);
		const out = new Uint8Array(0x20 + root.length);
		const dv = new DataView(out.buffer);
		out.set(new TextEncoder().encode('PACx403L'), 0);
		dv.setUint32(0x10, 0x20, true);
		dv.setUint32(0x14, root.length, true);
		dv.setUint32(0x18, root.length, true);
		out.set(root, 0x20);
		const r = readPacx(out);
		expect(r.version).toBe('403');
		expect(r.entries.map((e) => e.name)).toEqual(['abc.txt', 'abd.txt']);
	});

	it('decompresses an LZ4-chunked v4 root', () => {
		const root = v3Pac([{ name: 'abc', data: a }, { name: 'abd', data: b }]);
		const half = 0x400;
		const c0 = lz4Literal(root.subarray(0, half)), c1 = lz4Literal(root.subarray(half));
		// header 0x20, metadata 0x10, parents 0, chunk table 4 + 2 * 8
		const chunkAt = 0x30, rootAt = chunkAt + 20;
		const out = new Uint8Array(rootAt + c0.length + c1.length);
		const dv = new DataView(out.buffer);
		out.set(new TextEncoder().encode('PACx403L'), 0);
		dv.setUint32(0x10, rootAt, true);
		dv.setUint32(0x14, c0.length + c1.length, true);
		dv.setUint32(0x18, root.length, true);
		dv.setUint16(0x1c, 0x81, true);
		dv.setUint16(0x1e, 0x208, true);
		dv.setUint32(0x24, 20, true);
		dv.setUint32(chunkAt, 2, true);
		dv.setUint32(chunkAt + 4, c0.length, true);
		dv.setUint32(chunkAt + 8, half, true);
		dv.setUint32(chunkAt + 12, c1.length, true);
		dv.setUint32(chunkAt + 16, root.length - half, true);
		out.set(c0, rootAt);
		out.set(c1, rootAt + c0.length);
		const r = readPacx(out);
		expect(r.entries.map((e) => new TextDecoder().decode(e.data))).toEqual(['hello', 'world!']);
	});
});
