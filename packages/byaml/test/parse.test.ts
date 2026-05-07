import { describe, it, expect } from 'vitest';
import {
	isByaml,
	parseByaml,
	byamlToJson,
	ByamlInt,
	ByamlUInt,
	ByamlFloat,
	BYAML_MAGIC_LE,
	BYAML_MAGIC_BE,
} from '../src/index.js';

describe('isByaml', () => {
	it('detects "BY" (BE) magic', async () => {
		const buf = new Uint8Array([0x42, 0x59, 0x00, 0x02]);
		expect(await isByaml(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('detects "YB" (LE) magic', async () => {
		const buf = new Uint8Array([0x59, 0x42, 0x01, 0x00]);
		expect(await isByaml(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects unrelated blobs', async () => {
		expect(await isByaml(new Blob([new Uint8Array([0x42, 0x41])]))).toBe(false);
		expect(await isByaml(new Blob([]))).toBe(false);
	});
});

describe('parseByaml — empty root', () => {
	it('handles a root_offset = 0 file', async () => {
		// Header only, with all three offsets zero → empty document.
		const buf = new Uint8Array(0x10);
		buf[0] = 0x59;
		buf[1] = 0x42;
		buf[2] = 0x02; // version 2
		buf[3] = 0x00;
		const parsed = await parseByaml(new Blob([buf as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.version).toBe(2);
		expect(parsed.root).toBeNull();
	});
});

describe('parseByaml — minimal hash', () => {
	it('decodes a hash with a single int entry', async () => {
		// Build by hand:
		//   header (16) | hash-key-table | string-table=0 | root-hash
		// Hash key table at 0x10: STRING_TABLE (0xC2) + count u24 + offsets[N] + last-offset + strings
		// Single key "foo" → 1 entry.
		// Hash root at e.g. 0x24:
		//   0xC1 + u24=1 + entry { u24 keyIdx=0, u8 type=INT(0xD1), s32 value=42 }

		const enc = new TextEncoder();
		const out = new Uint8Array(0x40);
		const v = new DataView(out.buffer);
		// Header (LE, v2)
		out[0] = 0x59; out[1] = 0x42;
		v.setUint16(2, 2, true);
		v.setUint32(4, 0x10, true);  // hash-key-table at 0x10
		v.setUint32(8, 0, true);     // no string table
		v.setUint32(0x0c, 0x24, true); // root at 0x24

		// Hash key table at 0x10:
		//   0x10: 0xC2 (STRING_TABLE), 0x11..0x13: count = 1
		//   0x14: u32 offset0 (relative to 0x10) = 0x0C (where "foo" starts)
		//   0x18: u32 last-offset = 0x10 (1 byte past "foo\0")
		//   0x1C: "foo\0"  (then 1 byte pad to 0x20)
		out[0x10] = 0xc2;
		out[0x11] = 1; out[0x12] = 0; out[0x13] = 0;
		v.setUint32(0x14, 0x0c, true);   // offset 0x10 + 0x0C = 0x1C
		v.setUint32(0x18, 0x10, true);   // end past "foo\0" at 0x10+0x10=0x20
		out.set(enc.encode('foo\0'), 0x1c);

		// Root hash at 0x24:
		//   0xC1, count u24 = 1
		//   entry: u24 keyIdx=0, u8 type=0xD1, s32 value=42
		out[0x24] = 0xc1;
		out[0x25] = 1; out[0x26] = 0; out[0x27] = 0;
		// entry at 0x28: keyIdx=0 (3 bytes), type=0xD1 (1 byte), then s32 value
		out[0x28] = 0; out[0x29] = 0; out[0x2a] = 0;
		out[0x2b] = 0xd1;
		v.setInt32(0x2c, 42, true);

		const parsed = await parseByaml(new Blob([out as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.version).toBe(2);
		expect(parsed.hashKeys).toEqual(['foo']);
		expect(parsed.root).toBeDefined();
		const root = parsed.root as { foo: ByamlInt };
		expect(root.foo).toBeInstanceOf(ByamlInt);
		expect(root.foo.value).toBe(42);
	});
});

describe('parseByaml — minimal array', () => {
	it('decodes an array with mixed scalar types', async () => {
		// Root is an array containing [bool true, float 3.5, uint 99].
		// Layout:
		//   header (16) | (no hash keys) | (no string table) | array root
		const out = new Uint8Array(0x40);
		const v = new DataView(out.buffer);
		out[0] = 0x59; out[1] = 0x42;
		v.setUint16(2, 2, true);
		v.setUint32(4, 0, true);
		v.setUint32(8, 0, true);
		v.setUint32(0x0c, 0x10, true); // root at 0x10

		// Array at 0x10: 0xC0, count u24 = 3, then 3 type bytes + 1 pad to align,
		// then 3 × u32 inline values.
		out[0x10] = 0xc0;
		out[0x11] = 3; out[0x12] = 0; out[0x13] = 0;
		out[0x14] = 0xd0; // BOOL
		out[0x15] = 0xd2; // FLOAT
		out[0x16] = 0xd3; // UINT
		out[0x17] = 0; // pad to 4-byte align
		v.setUint32(0x18, 1, true); // bool=true
		v.setFloat32(0x1c, 3.5, true);
		v.setUint32(0x20, 99, true);

		const parsed = await parseByaml(new Blob([out as BlobPart]));
		expect(Array.isArray(parsed.root)).toBe(true);
		const arr = parsed.root as [boolean, ByamlFloat, ByamlUInt];
		expect(arr).toHaveLength(3);
		expect(arr[0]).toBe(true);
		expect((arr[1] as ByamlFloat).value).toBeCloseTo(3.5, 5);
		expect((arr[2] as ByamlUInt).value).toBe(99);
	});
});

describe('byamlToJson', () => {
	it('strips numeric brands and stringifies bigints', () => {
		const v = {
			a: new ByamlInt(-7),
			b: new ByamlUInt(0xdeadbeef >>> 0),
			c: new ByamlFloat(1.5),
			d: [new ByamlInt(1), new ByamlInt(2)],
			e: true,
			f: 'hello',
			g: null,
		};
		const json = byamlToJson(v);
		expect(json).toEqual({
			a: -7,
			b: 0xdeadbeef,
			c: 1.5,
			d: [1, 2],
			e: true,
			f: 'hello',
			g: null,
		});
	});
});

describe('exported magic constants', () => {
	it('match the on-disk values', () => {
		expect(BYAML_MAGIC_BE).toBe('BY');
		expect(BYAML_MAGIC_LE).toBe('YB');
	});
});
