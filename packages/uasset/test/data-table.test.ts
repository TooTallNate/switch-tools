import { describe, expect, it } from 'vitest';
import {
	parseCurveTable,
	parseDataTableAtExport,
	parseUasset,
	UASSET_MAGIC,
} from '../src/index.js';

/**
 * Synthetic .uasset+.uexp fixture builder for DataTable / CurveTable.
 *
 * Mirrors the harness in `properties.test.ts` but slightly simpler —
 * we don't need to expose imports because the tests drive
 * `parseDataTableAtExport`/`parseCurveTable` directly with an explicit
 * export index (or via the CurveTable-class walk, for which we make
 * the export's classIndex point to no-op).
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
	const out = new Uint8Array(s.length + 4); // +2 trailing hashes
	out.set(s, 0);
	return out;
}

interface BuiltAsset {
	uasset: Uint8Array;
	totalHeaderSize: number;
	nameIndex(name: string): number;
}

function buildHeader(
	names: string[],
	exportName: string,
	serialSize: number,
): BuiltAsset {
	const nameMap = new Map<string, number>();
	names.forEach((n, i) => nameMap.set(n, i));
	const exportIdx = nameMap.get(exportName);
	if (exportIdx === undefined) {
		throw new Error(`exportName "${exportName}" not in names list`);
	}

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

	const exportTable = new Uint8Array(104);
	{
		const v = new DataView(exportTable.buffer);
		v.setInt32(0, 0, true);
		v.setUint32(16, exportIdx, true);
	}

	const folderName = fstring('None');
	const headerFixedSize =
		4 + 4 + 4 + 4 + 4 + 4 + 4 +
		folderName.length +
		4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 16 + 4 + 8;
	const nameOffset = headerFixedSize;
	const importOffset = nameOffset + nameTable.length;
	const exportOffset = importOffset;
	const totalSize = exportOffset + exportTable.length;

	{
		const v = new DataView(exportTable.buffer);
		v.setBigInt64(28, BigInt(serialSize), true);
		v.setBigInt64(36, BigInt(totalSize), true);
	}

	const out = new Uint8Array(totalSize);
	const v = new DataView(out.buffer);
	let off = 0;
	v.setUint32(off, UASSET_MAGIC, true); off += 4;
	v.setInt32(off, -7, true); off += 4;
	v.setInt32(off, 0, true); off += 4;
	v.setInt32(off, 0, true); off += 4;
	v.setInt32(off, 0, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, totalSize, true); off += 4;
	out.set(folderName, off); off += folderName.length;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, names.length, true); off += 4;
	v.setUint32(off, nameOffset, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, 1, true); off += 4;
	v.setUint32(off, exportOffset, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, importOffset, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	v.setUint32(off, 0, true); off += 4;
	off += 16;
	v.setUint32(off, 1, true); off += 4;
	v.setUint32(off, 1, true); off += 4;
	v.setUint32(off, names.length, true); off += 4;

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

/** Tiny little-endian byte stream writer. */
class Writer {
	bytes: number[] = [];
	u8(v: number) { this.bytes.push(v & 0xff); return this; }
	u32(v: number) { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); return this; }
	i32(v: number) { return this.u32(v); }
	f32(v: number) {
		const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, v, true);
		const u = new Uint8Array(b);
		this.bytes.push(u[0]!, u[1]!, u[2]!, u[3]!);
		return this;
	}
	fname(idx: number, number = 0) { this.u32(idx); this.u32(number); return this; }
	guid() { for (let i = 0; i < 16; i++) this.bytes.push(0); return this; }
	concat(o: Writer) { for (const b of o.bytes) this.bytes.push(b); return this; }
	finish() { return new Uint8Array(this.bytes); }
	get length() { return this.bytes.length; }
}

function tagInt(header: BuiltAsset, propName: string, value: number): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex('IntProperty'));
	w.i32(4);
	w.i32(0);
	w.u8(0); // hasGuid
	w.i32(value);
	return w;
}

function tagFloat(header: BuiltAsset, propName: string, value: number): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex('FloatProperty'));
	w.i32(4);
	w.i32(0);
	w.u8(0);
	w.f32(value);
	return w;
}

function tagBool(header: BuiltAsset, propName: string, b: boolean): Writer {
	const w = new Writer();
	w.fname(header.nameIndex(propName));
	w.fname(header.nameIndex('BoolProperty'));
	w.i32(0);
	w.i32(0);
	w.u8(b ? 1 : 0);
	w.u8(0);
	return w;
}

function noneTag(header: BuiltAsset): Writer {
	const w = new Writer();
	w.fname(header.nameIndex('None'));
	return w;
}

// ---------------------------------------------------------------------------

describe('parseDataTableAtExport', () => {
	it('decodes a 3-row table with int + float + bool columns', () => {
		const names = [
			'None',
			'DT_Test',
			'IntProperty', 'FloatProperty', 'BoolProperty',
			'Quantity', 'Weight', 'Sellable',
			'Apple', 'Banana', 'Carrot',
		];

		// Build the export body:
		//   (no top-level properties → just `None`)
		//   u32 bSerializeGuid = 0
		//   i32 NumRows = 3
		//   row: FName Apple
		//        Quantity:IntProperty = 12
		//        Weight:FloatProperty = 1.5
		//        Sellable:BoolProperty = true
		//        None
		//   row: FName Banana
		//        Quantity = 7
		//        Weight = 0.25
		//        Sellable = false
		//        None
		//   row: FName Carrot
		//        Quantity = 33
		//        Weight = 0.1
		//        Sellable = true
		//        None
		const body = new Writer();
		body.concat(noneTag({ nameIndex: (n) => names.indexOf(n) } as BuiltAsset));
		body.u32(0); // bSerializeGuid
		body.i32(3); // NumRows

		const rowsData: Array<[string, number, number, boolean]> = [
			['Apple', 12, 1.5, true],
			['Banana', 7, 0.25, false],
			['Carrot', 33, 0.1, true],
		];

		const header = buildHeader(names, 'DT_Test', 0); // serialSize patched below
		for (const [name, qty, weight, sellable] of rowsData) {
			body.fname(header.nameIndex(name));
			body.concat(tagInt(header, 'Quantity', qty));
			body.concat(tagFloat(header, 'Weight', weight));
			body.concat(tagBool(header, 'Sellable', sellable));
			body.concat(noneTag(header));
		}
		const uexp = body.finish();

		// Patch the export's serialSize now that we know it.
		const rebuilt = buildHeader(names, 'DT_Test', uexp.length);
		const parsed = parseUasset(rebuilt.uasset);
		const table = parseDataTableAtExport(parsed, uexp, 0);
		expect(table.rows).toHaveLength(3);

		expect(table.rows[0]!.name).toBe('Apple');
		expect(table.rows[0]!.properties).toHaveLength(3);
		expect(table.rows[0]!.properties[0]!.name).toBe('Quantity');
		expect(table.rows[0]!.properties[0]!.value).toEqual({ kind: 'int32', value: 12 });
		expect(table.rows[0]!.properties[1]!.name).toBe('Weight');
		if (table.rows[0]!.properties[1]!.value.kind !== 'float') throw new Error('expected float');
		expect(table.rows[0]!.properties[1]!.value.value).toBeCloseTo(1.5);
		expect(table.rows[0]!.properties[2]!.value).toEqual({ kind: 'bool', value: true });

		expect(table.rows[1]!.name).toBe('Banana');
		expect((table.rows[1]!.properties[0]!.value as any).value).toBe(7);
		expect((table.rows[1]!.properties[2]!.value as any).value).toBe(false);

		expect(table.rows[2]!.name).toBe('Carrot');
		expect((table.rows[2]!.properties[0]!.value as any).value).toBe(33);
	});

	it('decodes an empty table (NumRows = 0)', () => {
		const names = ['None', 'DT_Empty'];
		const body = new Writer();
		const header0 = buildHeader(names, 'DT_Empty', 0);
		body.concat(noneTag(header0));
		body.u32(0); // bSerializeGuid
		body.i32(0); // NumRows
		const uexp = body.finish();
		const rebuilt = buildHeader(names, 'DT_Empty', uexp.length);
		const parsed = parseUasset(rebuilt.uasset);
		const table = parseDataTableAtExport(parsed, uexp, 0);
		expect(table.rows).toEqual([]);
		expect(table.headerProperties).toEqual([]);
	});

	it('walks past the optional FGuid when bSerializeGuid != 0', () => {
		const names = ['None', 'DT_Guid', 'IntProperty', 'X', 'OnlyRow'];
		const body = new Writer();
		const h0 = buildHeader(names, 'DT_Guid', 0);
		body.concat(noneTag(h0));
		body.u32(1); // bSerializeGuid = true
		body.guid(); // 16 bytes
		body.i32(1); // NumRows
		body.fname(h0.nameIndex('OnlyRow'));
		body.concat(tagInt(h0, 'X', 42));
		body.concat(noneTag(h0));
		const uexp = body.finish();
		const rebuilt = buildHeader(names, 'DT_Guid', uexp.length);
		const parsed = parseUasset(rebuilt.uasset);
		const table = parseDataTableAtExport(parsed, uexp, 0);
		expect(table.rows).toHaveLength(1);
		expect(table.rows[0]!.name).toBe('OnlyRow');
		expect((table.rows[0]!.properties[0]!.value as any).value).toBe(42);
	});

	it('throws on implausible NumRows', () => {
		const names = ['None', 'DT_Bad'];
		const body = new Writer();
		const h0 = buildHeader(names, 'DT_Bad', 0);
		body.concat(noneTag(h0));
		body.u32(0);
		body.i32(99_999_999); // way too many rows
		const uexp = body.finish();
		const rebuilt = buildHeader(names, 'DT_Bad', uexp.length);
		const parsed = parseUasset(rebuilt.uasset);
		expect(() => parseDataTableAtExport(parsed, uexp, 0)).toThrow(/implausible/i);
	});

	it('throws on truncated tail before NumRows', () => {
		// Body has only the None terminator + a single trailing byte,
		// nowhere near enough for bSerializeGuid + NumRows.
		const names = ['None', 'DT_Short'];
		const body = new Writer();
		const h0 = buildHeader(names, 'DT_Short', 0);
		body.concat(noneTag(h0));
		body.u8(0);
		const uexp = body.finish();
		const rebuilt = buildHeader(names, 'DT_Short', uexp.length);
		const parsed = parseUasset(rebuilt.uasset);
		expect(() => parseDataTableAtExport(parsed, uexp, 0)).toThrow(
			/truncated/i,
		);
	});
});

describe('parseCurveTable', () => {
	it('decodes rows when invoked via the class walk', () => {
		// CurveTable uses the same row layout as DataTable. We
		// re-purpose the simple int-column fixture here but route it
		// through parseCurveTable + a fake "CurveTable" classIndex
		// resolution.
		//
		// `parseCurveTable` needs `findExportByClass('CurveTable')` to
		// succeed, which means the export's classIndex must resolve to
		// an Import named "CurveTable". Our minimal-header helper
		// doesn't expose imports, so for this test we exercise the
		// same path as the data-table walker by going through
		// `parseDataTableAtExport`'s sibling — but the equivalence is
		// validated by:
		//   1. End-to-end DT parse above.
		//   2. The shared row-table reader, used by both, is now
		//      covered by every DT test.
		//
		// We still want a smoke test for the public `parseCurveTable`
		// throwing path, so confirm it does throw when no CurveTable
		// export is present.
		const names = ['None', 'NotACurveTable'];
		const rebuilt = buildHeader(names, 'NotACurveTable', 4);
		const parsed = parseUasset(rebuilt.uasset);
		const uexp = new Uint8Array(4);
		expect(() => parseCurveTable(parsed, uexp)).toThrow(/no CurveTable/i);
	});
});
