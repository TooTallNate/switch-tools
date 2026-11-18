/**
 * Binary FBX node tree (Autodesk's container, documented by Blender's
 * `io_import_fbx` and the "FBX binary file format specification" notes
 * at https://code.blender.org/2013/08/fbx-binary-file-format-specification/).
 *
 * Header: `Kaydara FBX Binary  \0`, 0x1A 0x00, u32 version. Then node
 * records until an empty one:
 *
 *   endOffset, numProperties, propertyListLen   u32 (u64 from 7500)
 *   nameLen u8, name
 *   properties, then nested records, then a null record
 *
 * Property types: `Y` i16, `C` bool, `I` i32, `F` f32, `D` f64, `L` i64,
 * `S` string, `R` raw bytes (both u32 length-prefixed), and arrays
 * `f d l i b` (u32 count, u32 encoding, u32 byte length; encoding 1 is
 * zlib).
 */

import { unzlibSync } from 'fflate';

export type FbxValue = number | bigint | boolean | string | Uint8Array | Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array;

export interface FbxNode {
	name: string;
	props: FbxValue[];
	children: FbxNode[];
}

const MAGIC = 'Kaydara FBX Binary  \0';

export function isBinaryFbx(bytes: Uint8Array): boolean {
	if (bytes.length < 27) return false;
	for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
	return true;
}

/** Parse a binary FBX into its top-level nodes. */
export function parseFbxNodes(bytes: Uint8Array): { version: number; nodes: FbxNode[] } {
	if (!isBinaryFbx(bytes)) {
		const head = new TextDecoder().decode(bytes.subarray(0, 64));
		if (/FBXHeaderExtension|; FBX/.test(head)) throw new Error('ASCII FBX files are not supported yet');
		throw new Error('Not a binary FBX file');
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint32(23, true);
	const wide = version >= 7500;
	const text = new TextDecoder();
	let o = 27;

	const u = (at: number) => (wide ? Number(dv.getBigUint64(at, true)) : dv.getUint32(at, true));
	const headerSize = wide ? 25 : 13;

	const readArray = (type: string): FbxValue => {
		const count = dv.getUint32(o, true), encoding = dv.getUint32(o + 4, true), len = dv.getUint32(o + 8, true);
		o += 12;
		let raw = bytes.subarray(o, o + len);
		o += len;
		if (encoding === 1) raw = unzlibSync(raw);
		const copy = raw.slice(); // aligned
		const buf = copy.buffer;
		switch (type) {
			case 'f':
				return new Float32Array(buf, 0, count);
			case 'd':
				return new Float64Array(buf, 0, count);
			case 'i':
				return new Int32Array(buf, 0, count);
			case 'l':
				return new BigInt64Array(buf, 0, count);
			default:
				return copy.subarray(0, count);
		}
	};

	const readProp = (): FbxValue => {
		const type = String.fromCharCode(bytes[o]!);
		o++;
		switch (type) {
			case 'Y': {
				const v = dv.getInt16(o, true);
				o += 2;
				return v;
			}
			case 'C': {
				const v = bytes[o] !== 0;
				o += 1;
				return v;
			}
			case 'I': {
				const v = dv.getInt32(o, true);
				o += 4;
				return v;
			}
			case 'F': {
				const v = dv.getFloat32(o, true);
				o += 4;
				return v;
			}
			case 'D': {
				const v = dv.getFloat64(o, true);
				o += 8;
				return v;
			}
			case 'L': {
				const v = dv.getBigInt64(o, true);
				o += 8;
				return v;
			}
			case 'S': {
				const len = dv.getUint32(o, true);
				const v = text.decode(bytes.subarray(o + 4, o + 4 + len));
				o += 4 + len;
				return v;
			}
			case 'R': {
				const len = dv.getUint32(o, true);
				const v = bytes.slice(o + 4, o + 4 + len);
				o += 4 + len;
				return v;
			}
			case 'f':
			case 'd':
			case 'l':
			case 'i':
			case 'b':
				return readArray(type);
			default:
				throw new Error(`FBX: unknown property type '${type}' at 0x${(o - 1).toString(16)}`);
		}
	};

	const readNode = (): FbxNode | null => {
		const end = u(o);
		const numProps = u(o + (wide ? 8 : 4));
		const nameLen = bytes[o + headerSize - 1]!;
		if (end === 0) {
			o += headerSize;
			return null;
		}
		const name = text.decode(bytes.subarray(o + headerSize, o + headerSize + nameLen));
		o += headerSize + nameLen;
		const props: FbxValue[] = [];
		for (let i = 0; i < numProps; i++) props.push(readProp());
		const children: FbxNode[] = [];
		while (o < end) {
			const c = readNode();
			if (!c) break;
			children.push(c);
		}
		o = end;
		return { name, props, children };
	};

	const nodes: FbxNode[] = [];
	while (o + headerSize <= bytes.length) {
		const n = readNode();
		if (!n) break;
		nodes.push(n);
	}
	return { version, nodes };
}

export const child = (n: FbxNode | undefined, name: string): FbxNode | undefined => n?.children.find((c) => c.name === name);
export const children = (n: FbxNode | undefined, name: string): FbxNode[] => n?.children.filter((c) => c.name === name) ?? [];
