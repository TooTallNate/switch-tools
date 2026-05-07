/**
 * BYAML / BYML — Nintendo's binary YAML format.
 *
 * Used pervasively in Wii U / Switch first-party games for game-
 * data tables: AI rivalry tables, course parameters, layout
 * configs, balloon-battle paths, item-spawn rules, and so on.
 * It's a tree of arrays / hash-maps / scalars laid out as
 * offset-pointered nodes that share a common string-deduplication
 * table at the front of the file.
 *
 * Wire layout:
 *
 *   0x00  char[2]   magic = "BY" (big-endian) or "YB" (little-endian)
 *   0x02  u16       version (1..7; v1 is the early Wii U variant)
 *   0x04  u32       hash-key string table offset (or 0 if none)
 *   0x08  u32       value string table offset (or 0 if none)
 *   0x0C  u32       root node offset
 *
 * The hash-key table holds dictionary keys; the value table holds
 * string scalar values; and the root node is either an array
 * (`0xC0`) or a hash (`0xC1`).
 *
 * Node types:
 *
 *   0xA0  STRING        u32 index into value-string-table
 *   0xA1  BINARY        offset → u32 size + raw bytes
 *   0xC0  ARRAY         offset → u24 count + N type-tag bytes + N value words
 *   0xC1  HASH          offset → u24 count + N (u24 key-index, u8 type, u32 value)
 *   0xC2  STRING_TABLE  internal — only at file-root tables
 *   0xD0  BOOL          u32 value (0/1)
 *   0xD1  INT (s32)     u32 value (sign-extended on read)
 *   0xD2  FLOAT         f32 value
 *   0xD3  UINT (u32)    u32 value
 *   0xD4  INT64 (s64)   offset → s64
 *   0xD5  UINT64 (u64)  offset → u64
 *   0xD6  DOUBLE (f64)  offset → f64
 *   0xFF  NULL          u32 padding
 *
 * For ARRAY: the type-tag byte block is padded with NUL to the
 * next 4-byte boundary, *then* the values follow inline (one u32
 * each — either the raw value for inline types, or an offset to a
 * sub-node).
 *
 * For HASH: each entry is exactly 8 bytes: 24-bit key index, 8-bit
 * type tag, 32-bit value.
 *
 * Reference (read line-by-line):
 *   - https://github.com/zeldamods/byml-v2/blob/master/byml/byml.py
 */

export const BYAML_MAGIC_BE = 'BY';
export const BYAML_MAGIC_LE = 'YB';

/**
 * Branded numeric wrappers for BYAML's typed scalars. Plain JS
 * numbers can't distinguish s32 / u32 / f32 / f64, so callers that
 * need to round-trip a BYAML have to know the original type. Most
 * callers only care about JSON-shaped output, in which case they
 * can ignore the brands and just use the raw `.value`.
 */
export class ByamlInt {
	readonly type = 'i32';
	constructor(public readonly value: number) {}
}
export class ByamlUInt {
	readonly type = 'u32';
	constructor(public readonly value: number) {}
}
export class ByamlInt64 {
	readonly type = 'i64';
	constructor(public readonly value: bigint) {}
}
export class ByamlUInt64 {
	readonly type = 'u64';
	constructor(public readonly value: bigint) {}
}
export class ByamlFloat {
	readonly type = 'f32';
	constructor(public readonly value: number) {}
}
export class ByamlDouble {
	readonly type = 'f64';
	constructor(public readonly value: number) {}
}

export type ByamlValue =
	| string
	| boolean
	| null
	| ByamlInt
	| ByamlUInt
	| ByamlInt64
	| ByamlUInt64
	| ByamlFloat
	| ByamlDouble
	| Uint8Array
	| ByamlValue[]
	| { [key: string]: ByamlValue };

const NODE_STRING = 0xa0;
const NODE_BINARY = 0xa1;
const NODE_ARRAY = 0xc0;
const NODE_HASH = 0xc1;
const NODE_STRING_TABLE = 0xc2;
const NODE_BOOL = 0xd0;
const NODE_INT = 0xd1;
const NODE_FLOAT = 0xd2;
const NODE_UINT = 0xd3;
const NODE_INT64 = 0xd4;
const NODE_UINT64 = 0xd5;
const NODE_DOUBLE = 0xd6;
const NODE_NULL = 0xff;

export type Endian = 'big' | 'little';

export interface ParsedByaml {
	endian: Endian;
	version: number;
	/** The root tree (array or hash). `null` if `root_node_offset` is 0. */
	root: ByamlValue;
	/** The hash-key table, if present. */
	hashKeys: string[];
	/** The value-string table, if present. */
	values: string[];
}

/** Cheap (2-byte) magic check — accepts both endians. */
export async function isByaml(blob: Blob): Promise<boolean> {
	if (blob.size < 2) return false;
	const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
	return (
		(head[0] === 0x42 && head[1] === 0x59) /* 'BY' */ ||
		(head[0] === 0x59 && head[1] === 0x42) /* 'YB' */
	);
}

export async function parseByaml(blob: Blob): Promise<ParsedByaml> {
	if (blob.size < 0x10) {
		throw new Error(
			`Blob too small to be a BYAML (${blob.size} bytes, need at least 0x10)`,
		);
	}
	const data = new Uint8Array(await blob.arrayBuffer());
	let endian: Endian;
	if (data[0] === 0x42 && data[1] === 0x59) endian = 'big';
	else if (data[0] === 0x59 && data[1] === 0x42) endian = 'little';
	else throw new Error(`Bad BYAML magic: ${String.fromCharCode(data[0], data[1])}`);
	const isLittle = endian === 'little';
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const version = v.getUint16(2, isLittle);
	if (version < 1 || version > 7) {
		throw new Error(`Unsupported BYAML version: ${version}`);
	}
	const hashKeyTableOffset = v.getUint32(4, isLittle);
	const stringTableOffset = v.getUint32(8, isLittle);
	// BYAML v ≥ 5 sometimes has a binary-data-table offset at 0x0C
	// (and pushes the root offset to 0x10). Some shipped v1 / v2
	// files in the wild also use that layout despite the lower
	// version field — heuristic: if the value at
	// 0x0C either is zero OR doesn't point at a valid array/hash
	// node, read the root offset from 0x10 instead.
	let rootOffset = v.getUint32(0x0c, isLittle);
	if (
		rootOffset === 0 ||
		rootOffset >= data.length ||
		(data[rootOffset] !== NODE_ARRAY && data[rootOffset] !== NODE_HASH)
	) {
		const alt = data.byteLength >= 0x14 ? v.getUint32(0x10, isLittle) : 0;
		if (
			alt !== 0 &&
			alt < data.length &&
			(data[alt] === NODE_ARRAY || data[alt] === NODE_HASH)
		) {
			rootOffset = alt;
		}
	}

	const hashKeys =
		hashKeyTableOffset !== 0
			? parseStringTable(data, v, hashKeyTableOffset, isLittle)
			: [];
	const values =
		stringTableOffset !== 0
			? parseStringTable(data, v, stringTableOffset, isLittle)
			: [];

	let root: ByamlValue = null;
	if (rootOffset !== 0) {
		const rootType = data[rootOffset];
		if (rootType !== NODE_ARRAY && rootType !== NODE_HASH) {
			throw new Error(
				`Root node type 0x${rootType.toString(16)} is not array/hash`,
			);
		}
		root =
			rootType === NODE_ARRAY
				? parseArray(data, v, isLittle, hashKeys, values, rootOffset)
				: parseHash(data, v, isLittle, hashKeys, values, rootOffset);
	}

	return { endian, version, root, hashKeys, values };
}

function parseStringTable(
	data: Uint8Array,
	v: DataView,
	offset: number,
	isLittle: boolean,
): string[] {
	if (data[offset] !== NODE_STRING_TABLE) {
		throw new Error(
			`Bad string-table magic: 0x${data[offset].toString(16)} at 0x${offset.toString(16)}`,
		);
	}
	const count = readU24(v, offset + 1, isLittle);
	const out: string[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const stringOffset = offset + v.getUint32(offset + 4 + i * 4, isLittle);
		out[i] = readNulString(data, stringOffset);
	}
	return out;
}

function parseNode(
	data: Uint8Array,
	v: DataView,
	isLittle: boolean,
	hashKeys: string[],
	values: string[],
	type: number,
	wordOffset: number,
): ByamlValue {
	switch (type) {
		case NODE_STRING:
			return values[v.getUint32(wordOffset, isLittle)] ?? '';
		case NODE_BINARY: {
			const off = v.getUint32(wordOffset, isLittle);
			const size = v.getUint32(off, isLittle);
			return data.slice(off + 4, off + 4 + size);
		}
		case NODE_ARRAY: {
			const off = v.getUint32(wordOffset, isLittle);
			return parseArray(data, v, isLittle, hashKeys, values, off);
		}
		case NODE_HASH: {
			const off = v.getUint32(wordOffset, isLittle);
			return parseHash(data, v, isLittle, hashKeys, values, off);
		}
		case NODE_BOOL:
			return v.getUint32(wordOffset, isLittle) !== 0;
		case NODE_INT:
			return new ByamlInt(v.getInt32(wordOffset, isLittle));
		case NODE_FLOAT:
			return new ByamlFloat(v.getFloat32(wordOffset, isLittle));
		case NODE_UINT:
			return new ByamlUInt(v.getUint32(wordOffset, isLittle));
		case NODE_INT64:
			return new ByamlInt64(v.getBigInt64(v.getUint32(wordOffset, isLittle), isLittle));
		case NODE_UINT64:
			return new ByamlUInt64(v.getBigUint64(v.getUint32(wordOffset, isLittle), isLittle));
		case NODE_DOUBLE:
			return new ByamlDouble(v.getFloat64(v.getUint32(wordOffset, isLittle), isLittle));
		case NODE_NULL:
			return null;
		default:
			throw new Error(`Unknown BYAML node type 0x${type.toString(16)}`);
	}
}

function parseArray(
	data: Uint8Array,
	v: DataView,
	isLittle: boolean,
	hashKeys: string[],
	values: string[],
	offset: number,
): ByamlValue[] {
	const count = readU24(v, offset + 1, isLittle);
	const valuesStart = offset + alignUp(count, 4) + 4;
	const out: ByamlValue[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const t = data[offset + 4 + i];
		out[i] = parseNode(data, v, isLittle, hashKeys, values, t, valuesStart + 4 * i);
	}
	return out;
}

function parseHash(
	data: Uint8Array,
	v: DataView,
	isLittle: boolean,
	hashKeys: string[],
	values: string[],
	offset: number,
): { [key: string]: ByamlValue } {
	const count = readU24(v, offset + 1, isLittle);
	const out: { [key: string]: ByamlValue } = Object.create(null);
	for (let i = 0; i < count; i++) {
		const entryOffset = offset + 4 + i * 8;
		const keyIndex = readU24(v, entryOffset, isLittle);
		const t = data[entryOffset + 3];
		const key = hashKeys[keyIndex] ?? `<missing key ${keyIndex}>`;
		out[key] = parseNode(data, v, isLittle, hashKeys, values, t, entryOffset + 4);
	}
	return out;
}

function readU24(v: DataView, offset: number, isLittle: boolean): number {
	if (isLittle) {
		return v.getUint8(offset) | (v.getUint8(offset + 1) << 8) | (v.getUint8(offset + 2) << 16);
	}
	return (v.getUint8(offset) << 16) | (v.getUint8(offset + 1) << 8) | v.getUint8(offset + 2);
}

function readNulString(data: Uint8Array, offset: number): string {
	let end = offset;
	while (end < data.length && data[end] !== 0) end++;
	return new TextDecoder('utf-8').decode(data.subarray(offset, end));
}

function alignUp(n: number, a: number): number {
	return n + ((a - (n % a)) % a);
}

/**
 * Convert a parsed BYAML value (with branded numeric wrappers) to
 * a plain JSON-serialisable structure: numeric brands collapse to
 * their `.value`, `Uint8Array` collapses to a hex-prefixed
 * `"0x…"` string. This is what the `nx-archive` JSON viewer
 * consumes.
 */
export function byamlToJson(value: ByamlValue): unknown {
	if (
		value instanceof ByamlInt ||
		value instanceof ByamlUInt ||
		value instanceof ByamlFloat ||
		value instanceof ByamlDouble
	) {
		return value.value;
	}
	if (value instanceof ByamlInt64 || value instanceof ByamlUInt64) {
		return value.value.toString();
	}
	if (value instanceof Uint8Array) {
		// Render binary blobs as hex-prefixed strings; full bytes are
		// available via the parsed tree if a caller needs them.
		const hex = Array.from(value)
			.slice(0, 32)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const more = value.length > 32 ? `…(+${value.length - 32} bytes)` : '';
		return `<binary 0x${hex}${more}>`;
	}
	if (Array.isArray(value)) return value.map(byamlToJson);
	if (value !== null && typeof value === 'object') {
		const out: { [key: string]: unknown } = {};
		for (const k of Object.keys(value)) out[k] = byamlToJson(value[k]);
		return out;
	}
	return value;
}
