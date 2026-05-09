import { describe, expect, it } from 'vitest';
import {
	parseUasset,
	readExportProperties,
	UASSET_MAGIC,
	type UProperty,
	type UValue,
} from '../src/index.js';

/**
 * Synthetic .uasset+.uexp fixture builder. We compose two byte buffers
 * by hand:
 *
 *   - A `.uasset` containing a name table large enough to host every
 *     name we need at known indices, plus a single export pointing at
 *     a chosen serialOffset and serialSize.
 *   - A `.uexp` containing a property-tag stream we control byte-by-byte.
 *
 * The serialOffset on the export is `totalHeaderSize` (= the .uasset's
 * length), so the body starts at offset 0 within the .uexp.
 *
 * No commercial-game data — every byte is constructed here.
 */

const enc = new TextEncoder();

function fstring(s: string): Uint8Array {
	const bytes = enc.encode(s + '\0');
	const out = new Uint8Array(4 + bytes.length);
	new DataView(out.buffer).setInt32(0, bytes.length, true);
	out.set(bytes, 4);
	return out;
}

function nameEntry(name: string): Uint8Array {
	const s = fstring(name);
	const out = new Uint8Array(s.length + 4); // +2 hashes (each u16 = 2 bytes)
	out.set(s, 0);
	return out;
}

interface BuiltAsset {
	uasset: Uint8Array;
	totalHeaderSize: number;
	/** Helper for placing FName(idx, number) into a .uexp scratch buffer. */
	nameIndex(name: string): number;
}

/**
 * Build a minimal `.uasset` header containing the supplied names plus
 * a single export. The export's `serialOffset` is the .uasset length,
 * so the matching .uexp starts at body offset 0. `serialSize` is the
 * length of the future .uexp body.
 */
function buildHeader(names: string[], exportName: string, serialSize: number): BuiltAsset {
	const nameMap = new Map<string, number>();
	names.forEach((n, i) => nameMap.set(n, i));
	const exportIdx = nameMap.get(exportName);
	if (exportIdx === undefined) throw new Error(`exportName "${exportName}" not in names list`);

	const nameTableParts = names.map(nameEntry);
	let nameTableSize = 0;
	for (const p of nameTableParts) nameTableSize += p.length;
	const nameTable = new Uint8Array(nameTableSize);
	{
		let o = 0;
		for (const p of nameTableParts) {
			nameTable.set(p, o);
			o += p.length;
		}
	}

	// One export pointing at serialOffset = totalHeaderSize, serialSize as supplied.
	const exportTable = new Uint8Array(104);
	{
		const v = new DataView(exportTable.buffer);
		v.setInt32(0, 0, true); // classIndex (we don't care)
		v.setUint32(16, exportIdx, true); // objectName.nameIndex
	}
	// (We'll patch serialSize/Offset below once we know totalHeaderSize.)

	const folderName = fstring('None');
	const headerFixedSize =
		4 + 4 + 4 + 4 + 4 + 4 + 4 +
		folderName.length +
		4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 16 + 4 + 8;
	const nameOffset = headerFixedSize;
	const importOffset = nameOffset + nameTable.length;
	const exportOffset = importOffset; // no imports
	const totalSize = exportOffset + exportTable.length;

	// Patch the export entry now that totalSize is known.
	{
		const v = new DataView(exportTable.buffer);
		v.setBigInt64(28, BigInt(serialSize), true);
		v.setBigInt64(36, BigInt(totalSize), true);
	}

	const out = new Uint8Array(totalSize);
	const v = new DataView(out.buffer);
	let off = 0;
	v.setUint32(off, UASSET_MAGIC, true); off += 4;
	v.setInt32(off, -7, true); off += 4; // legacyFileVersion = UE 4.27
	v.setInt32(off, 0, true); off += 4; // legacyUE3
	v.setInt32(off, 0, true); off += 4; // fileVersionUE4
	v.setInt32(off, 0, true); off += 4; // fileVersionLicensee
	v.setUint32(off, 0, true); off += 4; // customVersionCount
	v.setUint32(off, totalSize, true); off += 4; // totalHeaderSize
	out.set(folderName, off); off += folderName.length;
	v.setUint32(off, 0, true); off += 4; // packageFlags
	v.setUint32(off, names.length, true); off += 4;
	v.setUint32(off, nameOffset, true); off += 4;
	v.setUint32(off, 0, true); off += 4; // gatherable count
	v.setUint32(off, 0, true); off += 4; // gatherable offset
	v.setUint32(off, 1, true); off += 4; // exportCount
	v.setUint32(off, exportOffset, true); off += 4;
	v.setUint32(off, 0, true); off += 4; // importCount
	v.setUint32(off, importOffset, true); off += 4;
	v.setUint32(off, 0, true); off += 4; // dependsOffset
	v.setUint32(off, 0, true); off += 4; // softPkg count
	v.setUint32(off, 0, true); off += 4; // softPkg offset
	v.setUint32(off, 0, true); off += 4; // searchableNamesOffset
	v.setUint32(off, 0, true); off += 4; // thumbnailTableOffset
	off += 16; // guid (zero)
	v.setUint32(off, 1, true); off += 4; // generationCount
	v.setUint32(off, 1, true); off += 4; // gen[0].exports
	v.setUint32(off, names.length, true); off += 4; // gen[0].names

	out.set(nameTable, nameOffset);
	out.set(exportTable, exportOffset);

	return {
		uasset: out,
		totalHeaderSize: totalSize,
		nameIndex: (n) => {
			const i = nameMap.get(n);
			if (i === undefined) throw new Error(`unknown name "${n}"`);
			return i;
		},
	};
}

/**
 * Tiny little-endian byte stream writer for property-tag bodies.
 */
class Writer {
	bytes: number[] = [];
	u8(v: number): this {
		this.bytes.push(v & 0xff);
		return this;
	}
	u16(v: number): this {
		this.bytes.push(v & 0xff, (v >> 8) & 0xff);
		return this;
	}
	u32(v: number): this {
		this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
		return this;
	}
	i32(v: number): this {
		return this.u32(v);
	}
	f32(v: number): this {
		const buf = new ArrayBuffer(4);
		new DataView(buf).setFloat32(0, v, true);
		const u8 = new Uint8Array(buf);
		this.bytes.push(u8[0]!, u8[1]!, u8[2]!, u8[3]!);
		return this;
	}
	fname(idx: number, number = 0): this {
		this.u32(idx); this.u32(number); return this;
	}
	guid(): this {
		for (let i = 0; i < 16; i++) this.bytes.push(0);
		return this;
	}
	fstring(s: string): this {
		const enc = new TextEncoder();
		const bytes = enc.encode(s + '\0');
		this.i32(bytes.length);
		for (const b of bytes) this.bytes.push(b);
		return this;
	}
	concat(other: Writer): this {
		for (const b of other.bytes) this.bytes.push(b);
		return this;
	}
	finish(): Uint8Array {
		return new Uint8Array(this.bytes);
	}
	get length(): number {
		return this.bytes.length;
	}
}

/**
 * Build a property tag with no per-type meta (used for Int/Float/Name/etc.).
 */
function tagNoMeta(
	header: BuiltAsset,
	propName: string,
	propType: string,
	value: Writer,
	hasGuid = 0,
): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex(propType));
	w.i32(value.length);
	w.i32(0); // arrayIndex
	w.u8(hasGuid);
	w.concat(value);
	return w;
}

function tagBool(header: BuiltAsset, propName: string, boolValue: boolean): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex('BoolProperty'));
	w.i32(0); // size = 0 (value lives in tag)
	w.i32(0); // arrayIndex
	w.u8(boolValue ? 1 : 0);
	w.u8(0); // hasGuid
	return w;
}

function tagStruct(
	header: BuiltAsset,
	propName: string,
	structName: string,
	body: Writer,
): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex('StructProperty'));
	w.i32(body.length);
	w.i32(0);
	w.fname(header.nameIndex(structName));
	w.guid(); // 16-byte struct guid
	w.u8(0); // hasGuid
	w.concat(body);
	return w;
}

function tagArrayOfPrimitives(
	header: BuiltAsset,
	propName: string,
	innerType: string,
	count: number,
	innerBytes: Writer,
): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex('ArrayProperty'));
	const body = new Writer();
	body.i32(count);
	body.concat(innerBytes);
	w.i32(body.length);
	w.i32(0);
	w.fname(header.nameIndex(innerType));
	w.u8(0); // hasGuid
	w.concat(body);
	return w;
}

function noneTag(header: BuiltAsset): Writer {
	const w = new Writer();
	w.fname(header.nameIndex('None'));
	return w;
}

// ---------------------------------------------------------------------------

describe('readExportProperties — primitives', () => {
	it('decodes BoolProperty (true and false) plus IntProperty / FloatProperty', () => {
		const names = [
			'None',
			'MyExport',
			'BoolProperty', 'IntProperty', 'FloatProperty', 'NameProperty',
			'IsAlive', 'Score', 'Multiplier', 'Tag',
			'Hello',
		];
		// Body: IsAlive=true, Score=42, Multiplier=3.5, Tag="Hello"
		const body = new Writer();
		body.concat(tagBool({ uasset: new Uint8Array(0), totalHeaderSize: 0, nameIndex: () => 0 } as never, 'IsAlive', true));
		// Easier: build header first to use its nameIndex helper
		const tmp = buildHeader(names, 'MyExport', 0);
		const bb = new Writer()
			.concat(tagBool(tmp, 'IsAlive', true))
			.concat(tagNoMeta(tmp, 'Score', 'IntProperty', new Writer().i32(42)))
			.concat(tagNoMeta(tmp, 'Multiplier', 'FloatProperty', new Writer().f32(3.5)))
			.concat(tagNoMeta(tmp, 'Tag', 'NameProperty', new Writer().fname(tmp.nameIndex('Hello'))))
			.concat(noneTag(tmp));
		void body;

		const header = buildHeader(names, 'MyExport', bb.length);
		const result = readExportProperties(parseUasset(header.uasset), bb.finish(), 0);
		expect(result.properties.map((p) => [p.name, p.type])).toEqual([
			['IsAlive', 'BoolProperty'],
			['Score', 'IntProperty'],
			['Multiplier', 'FloatProperty'],
			['Tag', 'NameProperty'],
		]);
		expect(result.properties[0]!.value).toEqual({ kind: 'bool', value: true });
		expect(result.properties[1]!.value).toEqual({ kind: 'int32', value: 42 });
		expect(result.properties[2]!.value).toEqual({ kind: 'float', value: 3.5 });
		expect(result.properties[3]!.value).toEqual({ kind: 'name', value: 'Hello' });
	});

	it('terminates the property loop on a `None` tag', () => {
		const names = ['None', 'MyExport', 'BoolProperty', 'IsAlive'];
		const tmp = buildHeader(names, 'MyExport', 0);
		const body = new Writer()
			.concat(tagBool(tmp, 'IsAlive', false))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		expect(result.properties).toHaveLength(1);
		// `consumed` should include the 8-byte None FName.
		expect(result.consumed).toBeGreaterThan(0);
		expect(result.tail.length).toBe(0);
	});

	it('exposes any tail bytes after the None terminator', () => {
		const names = ['None', 'MyExport', 'BoolProperty', 'IsAlive'];
		const tmp = buildHeader(names, 'MyExport', 0);
		const body = new Writer()
			.concat(tagBool(tmp, 'IsAlive', true))
			.concat(noneTag(tmp))
			.u32(0xdeadbeef); // 4 bytes of tail data
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		expect(result.tail.length).toBe(4);
		expect(Array.from(result.tail)).toEqual([0xef, 0xbe, 0xad, 0xde]);
	});
});

describe('readExportProperties — strings and text', () => {
	it('decodes StrProperty', () => {
		const names = ['None', 'MyExport', 'StrProperty', 'Greeting'];
		const tmp = buildHeader(names, 'MyExport', 0);
		const body = new Writer()
			.concat(tagNoMeta(tmp, 'Greeting', 'StrProperty', new Writer().fstring('hello world')))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		expect(result.properties[0]!.value).toEqual({ kind: 'string', value: 'hello world' });
	});

	it('decodes TextProperty (Base history)', () => {
		const names = ['None', 'MyExport', 'TextProperty', 'Title'];
		const tmp = buildHeader(names, 'MyExport', 0);
		// Value: u32 flags, u8 historyType=0 (Base), fstring namespace, fstring key, fstring source
		const value = new Writer()
			.u32(0)        // flags
			.u8(0)         // historyType = Base
			.fstring('ns')
			.fstring('k1')
			.fstring('Source string');
		const body = new Writer()
			.concat(tagNoMeta(tmp, 'Title', 'TextProperty', value))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		expect(result.properties[0]!.value).toMatchObject({ kind: 'text', value: 'Source string' });
	});
});

describe('readExportProperties — structs', () => {
	it('decodes a native Vector struct', () => {
		const names = ['None', 'MyExport', 'StructProperty', 'Vector', 'Position'];
		const tmp = buildHeader(names, 'MyExport', 0);
		const body = new Writer()
			.concat(tagStruct(tmp, 'Position', 'Vector',
				new Writer().f32(1.5).f32(-2.5).f32(7.25)))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		const value = result.properties[0]!.value as Extract<UValue, { kind: 'struct' }>;
		expect(value.kind).toBe('struct');
		expect(value.structName).toBe('Vector');
		expect(value.native).toEqual({ kind: 'Vector', x: 1.5, y: -2.5, z: 7.25 });
	});

	it('decodes a native LinearColor struct', () => {
		const names = ['None', 'MyExport', 'StructProperty', 'LinearColor', 'Tint'];
		const tmp = buildHeader(names, 'MyExport', 0);
		const body = new Writer()
			.concat(tagStruct(tmp, 'Tint', 'LinearColor',
				new Writer().f32(0.5).f32(0.6).f32(0.7).f32(1.0)))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		const value = result.properties[0]!.value as Extract<UValue, { kind: 'struct' }>;
		expect(value.native).toMatchObject({
			kind: 'LinearColor',
			r: 0.5,
			b: expect.closeTo(0.7, 6) as unknown as number,
			a: 1.0,
		});
	});

	it('falls back to a generic property tree for unknown structs', () => {
		const names = [
			'None', 'MyExport', 'StructProperty', 'BoolProperty',
			'CustomStruct', 'Wrapper', 'Inner',
		];
		const tmp = buildHeader(names, 'MyExport', 0);
		// Inside the struct: one Bool tag + None terminator.
		const inner = new Writer()
			.concat(tagBool(tmp, 'Inner', true))
			.concat(noneTag(tmp));
		const body = new Writer()
			.concat(tagStruct(tmp, 'Wrapper', 'CustomStruct', inner))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		const value = result.properties[0]!.value as Extract<UValue, { kind: 'struct' }>;
		expect(value.structName).toBe('CustomStruct');
		expect(value.properties).toBeDefined();
		expect(value.properties).toHaveLength(1);
		expect((value.properties as UProperty[])[0]).toMatchObject({
			name: 'Inner',
			value: { kind: 'bool', value: true },
		});
	});
});

describe('readExportProperties — arrays', () => {
	it('decodes an array of primitive ints', () => {
		const names = ['None', 'MyExport', 'ArrayProperty', 'IntProperty', 'Counts'];
		const tmp = buildHeader(names, 'MyExport', 0);
		const inner = new Writer().i32(10).i32(20).i32(30);
		const body = new Writer()
			.concat(tagArrayOfPrimitives(tmp, 'Counts', 'IntProperty', 3, inner))
			.concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		const value = result.properties[0]!.value as Extract<UValue, { kind: 'array' }>;
		expect(value.kind).toBe('array');
		expect(value.innerType).toBe('IntProperty');
		expect(value.values.map((v) => (v as Extract<UValue, { kind: 'int32' }>).value)).toEqual([10, 20, 30]);
	});

	it('decodes an array of structs (with the inline struct wrapper tag)', () => {
		// Layout for an array of N structs:
		//   ArrayProperty header + size + arrayIndex + innerType=StructProperty + hasGuid=0
		//   i32 count
		//   wrapper tag: outerName/StructProperty/size/idx/structName/16-byte-guid/hasGuid
		//   N struct bodies (each: native Vector = 12 bytes here)
		const names = [
			'None', 'MyExport', 'ArrayProperty', 'StructProperty',
			'Vector', 'Points',
		];
		const tmp = buildHeader(names, 'MyExport', 0);

		// Build the array body (count + wrapper tag + 2 inline Vector structs).
		const body = new Writer();
		body.fname(tmp.nameIndex('Points'));
		body.fname(tmp.nameIndex('ArrayProperty'));
		// The array's body size:
		const arrayBody = new Writer();
		arrayBody.i32(2); // count = 2
		// Wrapper tag for "Points":
		arrayBody.fname(tmp.nameIndex('Points'));
		arrayBody.fname(tmp.nameIndex('StructProperty'));
		arrayBody.i32(24); // total inline struct bytes (2 × Vector = 24)
		arrayBody.i32(0); // arrayIndex
		arrayBody.fname(tmp.nameIndex('Vector')); // structName
		arrayBody.guid(); // struct guid
		arrayBody.u8(0); // hasGuid
		// Inline vectors:
		arrayBody.f32(1).f32(2).f32(3);
		arrayBody.f32(4).f32(5).f32(6);

		body.i32(arrayBody.length);
		body.i32(0); // arrayIndex
		body.fname(tmp.nameIndex('StructProperty')); // innerType
		body.u8(0); // hasGuid
		body.concat(arrayBody);

		const finalBody = new Writer().concat(body).concat(noneTag(tmp));
		const header = buildHeader(names, 'MyExport', finalBody.length);
		const result = readExportProperties(parseUasset(header.uasset), finalBody.finish(), 0);
		const arr = result.properties[0]!.value as Extract<UValue, { kind: 'array' }>;
		expect(arr.values).toHaveLength(2);
		const v0 = arr.values[0]! as Extract<UValue, { kind: 'struct' }>;
		const v1 = arr.values[1]! as Extract<UValue, { kind: 'struct' }>;
		expect(v0.native).toEqual({ kind: 'Vector', x: 1, y: 2, z: 3 });
		expect(v1.native).toEqual({ kind: 'Vector', x: 4, y: 5, z: 6 });
	});
});

describe('readExportProperties — error handling', () => {
	it('surfaces unknown property types as raw bytes without desyncing', () => {
		const names = ['None', 'MyExport', 'WeirdoProperty', 'Mystery', 'BoolProperty', 'KnownGood'];
		const tmp = buildHeader(names, 'MyExport', 0);
		// First tag: declares type "WeirdoProperty" with a 4-byte value.
		const body = new Writer();
		body.fname(tmp.nameIndex('Mystery'));
		body.fname(tmp.nameIndex('WeirdoProperty'));
		body.i32(4); // size
		body.i32(0); // arrayIndex
		body.u8(0); // hasGuid
		body.u32(0x12345678);
		// Second tag must still parse correctly:
		body.concat(tagBool(tmp, 'KnownGood', true));
		body.concat(noneTag(tmp));

		const header = buildHeader(names, 'MyExport', body.length);
		const result = readExportProperties(parseUasset(header.uasset), body.finish(), 0);
		expect(result.properties).toHaveLength(2);
		expect(result.properties[0]!.value.kind).toBe('unknown');
		expect((result.properties[0]!.value as Extract<UValue, { kind: 'unknown' }>).rawBytes.length).toBe(4);
		expect(result.properties[1]!.value).toEqual({ kind: 'bool', value: true });
	});

	it('throws on out-of-range export index', () => {
		const names = ['None', 'MyExport'];
		const header = buildHeader(names, 'MyExport', 0);
		expect(() => readExportProperties(parseUasset(header.uasset), new Uint8Array(0), 5)).toThrow(/out of bounds/);
	});
});
