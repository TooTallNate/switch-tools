/**
 * AAMP — Nintendo's binary "ParameterIO" format (`sead::aamp`).
 *
 * Breath of the Wild stores most actor configuration as AAMP under
 * dozens of extensions: `.bxml` actor links, `.bphysics`, `.bas` /
 * `.baslist` animation sequences, `.baiprog` AI programs, `.bdmgparam`,
 * `.bgparamlist`, `.bmodellist`, `.batcl`, `.brgconfig`, and so on.
 *
 * Layout (version 2, little-endian), after zeldamods' `oead` (`aamp.cpp`)
 * and the ZeldaMods wiki:
 *
 *   0x00  "AAMP"
 *   0x04  u32 version (2)
 *   0x08  u32 flags (bit 0 little-endian, bit 1 UTF-8)
 *   0x0C  u32 file size
 *   0x10  u32 ParameterIO version
 *   0x14  u32 offset of the root list, relative to 0x30
 *   0x18  u32 list count, 0x1C object count, 0x20 parameter count
 *   0x24  u32 data section size, 0x28 string section size, 0x2C unknown
 *   0x30  NUL-terminated data type ("xml")
 *
 *   list   { u32 crc, u16 lists_off, u16 lists_n, u16 objs_off, u16 objs_n }
 *   object { u32 crc, u16 params_off, u16 params_n }
 *   param  { u32 crc, u24 data_off, u8 type }
 *
 * Every offset is in 4-byte units, relative to the start of the record
 * holding it. Buffer parameters store a u32 element count just before
 * their data.
 *
 * Names are CRC32 hashes of the original strings. {@link parseAamp}
 * resolves them against a small set of structural names, every string
 * value in the file, and any names the caller supplies. Unresolved names
 * come back as `0x########`. No game-derived name list is shipped.
 */

export const AAMP_MAGIC = 'AAMP';

export enum AampParamType {
	Bool = 0,
	F32 = 1,
	Int = 2,
	Vec2 = 3,
	Vec3 = 4,
	Vec4 = 5,
	Color = 6,
	String32 = 7,
	String64 = 8,
	Curve1 = 9,
	Curve2 = 10,
	Curve3 = 11,
	Curve4 = 12,
	BufferInt = 13,
	BufferF32 = 14,
	String256 = 15,
	Quat = 16,
	U32 = 17,
	BufferU32 = 18,
	BufferBinary = 19,
	StringRef = 20,
}

export type AampValue = boolean | number | string | number[] | Uint8Array;

export interface AampParam {
	name: string;
	hash: number;
	type: AampParamType;
	typeName: string;
	value: AampValue;
}

export interface AampObject {
	name: string;
	hash: number;
	params: AampParam[];
}

export interface AampList {
	name: string;
	hash: number;
	lists: AampList[];
	objects: AampObject[];
}

export interface ParsedAamp {
	version: number;
	pioVersion: number;
	dataType: string;
	root: AampList;
	counts: { lists: number; objects: number; params: number };
}

/** Standard CRC-32 (IEEE), as AAMP uses for names. */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(s: string): number {
	const bytes = new TextEncoder().encode(s);
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * Structural names shared by every ParameterIO file, plus generic field
 * names. Numbered children (`Child0`, `Param12`, …) are generated.
 */
const BASE_NAMES = [
	'param_root', 'Elements', 'Element', 'Children', 'Child', 'Params', 'Param', 'Name', 'Type', 'Value',
	'Enable', 'Enabled', 'Index', 'Count', 'Num', 'Id', 'ID', 'Version', 'Data', 'Info', 'Header', 'Body',
	'List', 'Object', 'Objects', 'Lists', 'Node', 'Nodes', 'Key', 'Keys', 'Root', 'File', 'FileName',
	'Path', 'Bone', 'BoneName', 'Model', 'ModelName', 'UnitName', 'Unit', 'Scale', 'Rotate', 'Translate',
	'Position', 'Rotation', 'Offset', 'Size', 'Radius', 'Height', 'Width', 'Length', 'Weight', 'Speed',
	'Time', 'Frame', 'Rate', 'Ratio', 'Color', 'Flag', 'Flags', 'Tag', 'Tags', 'Group', 'Groups',
];

function nameTable(extra: Iterable<string>): Map<number, string> {
	const names = new Map<number, string>();
	const add = (s: string) => {
		if (s && !names.has(crc32(s))) names.set(crc32(s), s);
	};
	for (const s of BASE_NAMES) add(s);
	for (const s of extra) add(s);
	for (const base of ['Child', 'Param', 'Element', 'Elements', 'Object', 'List', 'Node', 'Bone', 'Item']) {
		for (let i = 0; i < 100; i++) {
			add(`${base}${i}`);
			add(`${base}_${i}`);
		}
	}
	return names;
}

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
	Object.entries(AampParamType).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]),
);

export function isAamp(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0x41 && bytes[1] === 0x41 && bytes[2] === 0x4d && bytes[3] === 0x50;
}

/**
 * Parse an AAMP file. `names` adds candidate strings for resolving name
 * hashes.
 */
export function parseAamp(bytes: Uint8Array, names: Iterable<string> = []): ParsedAamp {
	if (!isAamp(bytes)) throw new Error('Not an AAMP file (bad magic)');
	if (bytes.length < 0x34) throw new Error('AAMP file too small');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = v.getUint32(0x04, true);
	const flags = v.getUint32(0x08, true);
	if (version !== 2) throw new Error(`Unsupported AAMP version ${version}`);
	if (!(flags & 1)) throw new Error('Big-endian AAMP is not supported');
	const pioVersion = v.getUint32(0x10, true);
	const rootOff = 0x30 + v.getUint32(0x14, true);
	const counts = { lists: v.getUint32(0x18, true), objects: v.getUint32(0x1c, true), params: v.getUint32(0x20, true) };
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(flags & 2 ? 'utf-8' : 'shift_jis');
	} catch {
		decoder = new TextDecoder('utf-8');
	}
	const cstr = (off: number, max = bytes.length - off): string => {
		let end = off;
		const limit = Math.min(bytes.length, off + max);
		while (end < limit && bytes[end] !== 0) end++;
		return decoder.decode(bytes.subarray(off, end));
	};
	const dataType = cstr(0x30, rootOff - 0x30);
	const check = (off: number, len: number) => {
		if (off < 0 || off + len > bytes.length) throw new Error(`AAMP offset 0x${off.toString(16)} out of range`);
	};

	// First pass: raw tree with hashes, collecting string values so they
	// can resolve names too.
	const strings: string[] = [];
	const f32 = (o: number, n: number) => Array.from({ length: n }, (_, i) => v.getFloat32(o + i * 4, true));
	const readParam = (off: number): AampParam => {
		check(off, 8);
		const hash = v.getUint32(off, true);
		const word = v.getUint32(off + 4, true);
		const type = (word >>> 24) as AampParamType;
		const data = off + (word & 0xffffff) * 4;
		let value: AampValue;
		switch (type) {
			case AampParamType.Bool: check(data, 4); value = v.getUint32(data, true) !== 0; break;
			case AampParamType.F32: check(data, 4); value = v.getFloat32(data, true); break;
			case AampParamType.Int: check(data, 4); value = v.getInt32(data, true); break;
			case AampParamType.U32: check(data, 4); value = v.getUint32(data, true); break;
			case AampParamType.Vec2: check(data, 8); value = f32(data, 2); break;
			case AampParamType.Vec3: check(data, 12); value = f32(data, 3); break;
			case AampParamType.Vec4:
			case AampParamType.Color:
			case AampParamType.Quat: check(data, 16); value = f32(data, 4); break;
			case AampParamType.String32: value = cstr(data, 32); strings.push(value); break;
			case AampParamType.String64: value = cstr(data, 64); strings.push(value); break;
			case AampParamType.String256: value = cstr(data, 256); strings.push(value); break;
			case AampParamType.StringRef: value = cstr(data); strings.push(value); break;
			case AampParamType.Curve1:
			case AampParamType.Curve2:
			case AampParamType.Curve3:
			case AampParamType.Curve4: {
				// Each curve: u32 a, u32 b, then 30 floats.
				const n = (type - AampParamType.Curve1 + 1) * 32;
				check(data, n * 4);
				value = f32(data, n);
				break;
			}
			case AampParamType.BufferInt:
			case AampParamType.BufferF32:
			case AampParamType.BufferU32:
			case AampParamType.BufferBinary: {
				check(data - 4, 4);
				const n = v.getUint32(data - 4, true);
				if (type === AampParamType.BufferBinary) {
					check(data, n);
					value = bytes.slice(data, data + n);
				} else {
					check(data, n * 4);
					value = Array.from({ length: n }, (_, i) =>
						type === AampParamType.BufferF32
							? v.getFloat32(data + i * 4, true)
							: type === AampParamType.BufferInt
								? v.getInt32(data + i * 4, true)
								: v.getUint32(data + i * 4, true),
					);
				}
				break;
			}
			default:
				throw new Error(`Unknown AAMP parameter type ${type}`);
		}
		return { name: '', hash, type, typeName: TYPE_NAMES[type] ?? String(type), value };
	};
	const readObject = (off: number): AampObject => {
		check(off, 8);
		const hash = v.getUint32(off, true);
		const pOff = off + v.getUint16(off + 4, true) * 4;
		const n = v.getUint16(off + 6, true);
		const params: AampParam[] = [];
		for (let i = 0; i < n; i++) params.push(readParam(pOff + i * 8));
		return { name: '', hash, params };
	};
	let depth = 0;
	const readList = (off: number): AampList => {
		check(off, 12);
		if (++depth > 64) throw new Error('AAMP list nesting too deep');
		const hash = v.getUint32(off, true);
		const lOff = off + v.getUint16(off + 4, true) * 4;
		const ln = v.getUint16(off + 6, true);
		const oOff = off + v.getUint16(off + 8, true) * 4;
		const on = v.getUint16(off + 10, true);
		const lists: AampList[] = [];
		for (let i = 0; i < ln; i++) lists.push(readList(lOff + i * 12));
		const objects: AampObject[] = [];
		for (let i = 0; i < on; i++) objects.push(readObject(oOff + i * 8));
		depth--;
		return { name: '', hash, lists, objects };
	};
	const root = readList(rootOff);

	const table = nameTable([...names, ...strings]);
	const nameOf = (hash: number) => table.get(hash) ?? `0x${hash.toString(16).padStart(8, '0')}`;
	const label = (list: AampList) => {
		list.name = nameOf(list.hash);
		for (const l of list.lists) label(l);
		for (const o of list.objects) {
			o.name = nameOf(o.hash);
			for (const p of o.params) p.name = nameOf(p.hash);
		}
	};
	label(root);
	return { version, pioVersion, dataType, root, counts };
}

/** Render a parsed file as YAML-like text (the layout `oead` uses). */
export function aampToText(parsed: ParsedAamp): string {
	const out: string[] = [`!io`, `version: ${parsed.pioVersion}`, `type: ${parsed.dataType}`];
	const fmt = (p: AampParam): string => {
		const val = p.value;
		if (val instanceof Uint8Array) return `!binary ${val.length} bytes`;
		if (Array.isArray(val)) {
			const nums = val.map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(6).replace(/\.?0+$/, '')));
			return `!${p.typeName.toLowerCase()} [${nums.join(', ')}]`;
		}
		if (typeof val === 'string') return JSON.stringify(val);
		if (typeof val === 'number' && !Number.isInteger(val)) return val.toPrecision(6).replace(/\.?0+$/, '');
		return String(val);
	};
	const walk = (list: AampList, indent: string) => {
		out.push(`${indent}${list.name}: !list`);
		for (const o of list.objects) {
			out.push(`${indent}  ${o.name}: !obj`);
			for (const p of o.params) out.push(`${indent}    ${p.name}: ${fmt(p)}`);
		}
		for (const l of list.lists) walk(l, indent + '  ');
	};
	walk(parsed.root, '');
	return out.join('\n');
}
