import { UtfStorage, UtfType } from '../src/utf.js';

/**
 * Shared synthetic @UTF table builder for tests.
 *
 * `columns` describes the schema. `rows` is `[{ colName: value }, …]`.
 * Nested ParsedUtf-like inputs (raw Uint8Array of an inner @UTF table)
 * can be used as cell values for `Bytes`-typed columns; the builder
 * just packs them into the data section verbatim, and the parser
 * recursively decodes them.
 *
 * Storage mode is always `PerRow` — simplest layout, exercises the
 * common path. Tests targeting `InlinedConstant` / `SharedConstant`
 * would need a separate fixture path.
 */
export function buildUtfForTesting(
	tableName: string,
	columns: Array<{ name: string; type: UtfType; storage: UtfStorage }>,
	rows: Array<Record<string, number | bigint | string | Uint8Array>>,
): Uint8Array {
	const enc = new TextEncoder();
	const stringTable: Uint8Array[] = [];
	const stringOffsets = new Map<string, number>();
	let stringCursor = 0;
	const addString = (s: string): number => {
		if (stringOffsets.has(s)) return stringOffsets.get(s)!;
		const bytes = enc.encode(s + '\0');
		stringOffsets.set(s, stringCursor);
		stringTable.push(bytes);
		stringCursor += bytes.length;
		return stringOffsets.get(s)!;
	};
	const nameOffset = addString(tableName);
	for (const col of columns) addString(col.name);
	for (const row of rows) {
		for (const col of columns) {
			if (col.type === UtfType.String) {
				const v = row[col.name];
				if (typeof v === 'string') addString(v);
			}
		}
	}
	const stringSection = concat(stringTable);

	const dataChunks: Array<{ start: number; bytes: Uint8Array }> = [];
	let dataCursor = 0;
	const blobOffsetByRowCol = new Map<string, { off: number; len: number }>();
	for (let r = 0; r < rows.length; r++) {
		for (const col of columns) {
			if (col.type === UtfType.Bytes) {
				const v = rows[r]![col.name];
				if (v instanceof Uint8Array) {
					blobOffsetByRowCol.set(`${r}|${col.name}`, {
						off: dataCursor,
						len: v.length,
					});
					dataChunks.push({ start: dataCursor, bytes: v });
					dataCursor += v.length;
				}
			}
		}
	}
	const dataSection = new Uint8Array(dataCursor);
	for (const { start, bytes } of dataChunks) dataSection.set(bytes, start);

	const writeValue = (
		buf: number[],
		col: { name: string; type: UtfType },
		v: number | bigint | string | Uint8Array | undefined,
		rowIndex: number,
	) => {
		switch (col.type) {
			case UtfType.U8:
			case UtfType.S8:
				buf.push((Number(v) ?? 0) & 0xff);
				break;
			case UtfType.U16:
			case UtfType.S16: {
				const n = Number(v) ?? 0;
				buf.push((n >>> 8) & 0xff, n & 0xff);
				break;
			}
			case UtfType.U32:
			case UtfType.S32: {
				const n = Number(v) ?? 0;
				buf.push(
					(n >>> 24) & 0xff,
					(n >>> 16) & 0xff,
					(n >>> 8) & 0xff,
					n & 0xff,
				);
				break;
			}
			case UtfType.String: {
				const off = typeof v === 'string' ? stringOffsets.get(v)! : 0;
				buf.push(
					(off >>> 24) & 0xff,
					(off >>> 16) & 0xff,
					(off >>> 8) & 0xff,
					off & 0xff,
				);
				break;
			}
			case UtfType.Bytes: {
				const slot = blobOffsetByRowCol.get(`${rowIndex}|${col.name}`);
				const off = slot?.off ?? 0;
				const len = slot?.len ?? 0;
				buf.push(
					(off >>> 24) & 0xff,
					(off >>> 16) & 0xff,
					(off >>> 8) & 0xff,
					off & 0xff,
					(len >>> 24) & 0xff,
					(len >>> 16) & 0xff,
					(len >>> 8) & 0xff,
					len & 0xff,
				);
				break;
			}
			default:
				throw new Error(`buildUtfForTesting: unsupported type ${col.type}`);
		}
	};

	let valueSize = 0;
	for (const col of columns) {
		switch (col.type) {
			case UtfType.U8:
			case UtfType.S8:
				valueSize += 1;
				break;
			case UtfType.U16:
			case UtfType.S16:
				valueSize += 2;
				break;
			case UtfType.U32:
			case UtfType.S32:
			case UtfType.F32:
			case UtfType.String:
				valueSize += 4;
				break;
			case UtfType.U64:
			case UtfType.S64:
			case UtfType.F64:
			case UtfType.Bytes:
				valueSize += 8;
				break;
		}
	}

	const valuesBytes: number[] = [];
	for (let r = 0; r < rows.length; r++) {
		for (const col of columns) {
			writeValue(valuesBytes, col, rows[r]![col.name], r);
		}
	}

	const descriptorBytes: number[] = [];
	for (const col of columns) {
		const typeByte = ((UtfStorage.PerRow & 0x07) << 5) | (col.type & 0x1f);
		descriptorBytes.push(typeByte);
		const nOff = stringOffsets.get(col.name)!;
		descriptorBytes.push(
			(nOff >>> 24) & 0xff,
			(nOff >>> 16) & 0xff,
			(nOff >>> 8) & 0xff,
			nOff & 0xff,
		);
	}

	const valueOffset = 24 + descriptorBytes.length;
	const stringSectionStart = valueOffset + valuesBytes.length;
	const dataSectionStart = stringSectionStart + stringSection.length;
	const bodySize = dataSectionStart + dataSection.length;
	const body = new Uint8Array(bodySize);
	const dv = new DataView(body.buffer);
	dv.setUint16(0, 0, false);
	dv.setUint16(2, valueOffset, false);
	dv.setUint32(4, stringSectionStart, false);
	dv.setUint32(8, dataSectionStart, false);
	dv.setUint32(12, nameOffset, false);
	dv.setUint16(16, columns.length, false);
	dv.setUint16(18, valueSize, false);
	dv.setUint32(20, rows.length, false);
	body.set(descriptorBytes, 24);
	body.set(valuesBytes, valueOffset);
	body.set(stringSection, stringSectionStart);
	body.set(dataSection, dataSectionStart);

	const out = new Uint8Array(8 + bodySize);
	out[0] = 0x40;
	out[1] = 0x55;
	out[2] = 0x54;
	out[3] = 0x46;
	new DataView(out.buffer).setUint32(4, bodySize, false);
	out.set(body, 8);
	return out;
}

function concat(arrs: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const a of arrs) total += a.length;
	const out = new Uint8Array(total);
	let o = 0;
	for (const a of arrs) {
		out.set(a, o);
		o += a.length;
	}
	return out;
}
