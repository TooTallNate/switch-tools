/**
 * Hedgehog Engine "mirage" file headers, after HedgeLib++
 * (`hl_hh_mirage.h`). Every model, material and skeleton starts with
 * one of two big-endian headers:
 *
 *  - **Standard** (Unleashed / Generations): fileSize, version,
 *    dataSize, data offset, offset-table offset, file-name offset
 *    (0x18 bytes). Offsets inside the data are relative to the data.
 *  - **Sample chunk** (Lost World onwards; `fileSize & 0x80000000`):
 *    fileSize | flags, magic `0x0133054A`, offset-table offset, offset
 *    count, then a tree of 16-byte nodes (flags | size, value, 8-char
 *    name). A node's flags say leaf (0x20000000), last child
 *    (0x40000000) and root (0x80000000). The payload is whatever follows
 *    the `Contexts` node, whose value is the payload's version; offsets
 *    are relative to the first node (header + 0x10).
 *
 * Sonic Frontiers' Needle models (`NEDMDLV5`) keep the big-endian
 * values but store offsets as little-endian, relative to the offset's
 * own position. {@link MirageData.off} detects which applies from the
 * first entry of the offset table.
 */

export interface SampleChunkNode {
	name: string;
	value: number;
	/** Byte offset of the node in the file. */
	offset: number;
	children: SampleChunkNode[];
}

export interface MirageData {
	bytes: Uint8Array;
	dv: DataView;
	/** Payload start. */
	data: number;
	/** Payload version (`Contexts` value or the standard header's). */
	version: number;
	/** Sample chunk nodes (empty for standard headers). */
	nodes: SampleChunkNode[];
	/** Base that standard offsets are relative to. */
	base: number;
	/** Offsets are self-relative little-endian (Frontiers Needle). */
	selfRelative: boolean;
	u32(o: number): number;
	/** Resolve the offset stored at `o` (0 stays 0). */
	off(o: number): number;
	str(o: number): string;
}

const textDecoder = new TextDecoder();

export function isSampleChunk(bytes: Uint8Array): boolean {
	return bytes.length >= 16 && (bytes[0]! & 0x80) !== 0 && bytes[4] === 0x01 && bytes[5] === 0x33 && bytes[6] === 0x05 && bytes[7] === 0x4a;
}

/** Is this a mirage file (either header) we can read? */
export function isMirage(bytes: Uint8Array): boolean {
	if (isSampleChunk(bytes)) return true;
	if (bytes.length < 0x18) return false;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = dv.getUint32(0, false), data = dv.getUint32(12, false);
	return size === bytes.length && data >= 0x18 && data < size;
}

function readNodes(dv: DataView, at: number, end: number, depth = 0): SampleChunkNode[] {
	const out: SampleChunkNode[] = [];
	let o = at;
	while (o + 16 <= end && depth < 32) {
		const flags = dv.getUint32(o, false);
		const size = flags & 0x1fffffff;
		let name = '';
		for (let i = 0; i < 8; i++) {
			const c = dv.getUint8(o + 8 + i);
			if (c) name += String.fromCharCode(c);
		}
		const node: SampleChunkNode = { name: name.trimEnd(), value: dv.getUint32(o + 4, false), offset: o, children: [] };
		if (!(flags & 0x20000000)) node.children = readNodes(dv, o + 16, o + size, depth + 1);
		out.push(node);
		if (flags & 0xc0000000 || size < 16) break;
		o += size;
	}
	return out;
}

export function findNode(nodes: SampleChunkNode[], name: string): SampleChunkNode | null {
	for (const n of nodes) {
		if (n.name === name) return n;
		const c = findNode(n.children, name);
		if (c) return c;
	}
	return null;
}

export function readMirage(bytes: Uint8Array): MirageData {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => dv.getUint32(o, false);
	const str = (o: number) => {
		let e = o;
		while (e < bytes.length && bytes[e] !== 0) e++;
		return textDecoder.decode(bytes.subarray(o, e));
	};
	let data: number, version: number, base: number, nodes: SampleChunkNode[] = [];
	// Offset-table entries (positions of offsets), to tell the offset encoding apart.
	const offsetSlots: number[] = [];
	if (isSampleChunk(bytes)) {
		const size = Math.min(bytes.length, u32(0) & 0x1fffffff);
		nodes = readNodes(dv, 16, size);
		const ctx = findNode(nodes, 'Contexts');
		if (!ctx) throw new Error('Mirage file has no Contexts node');
		data = ctx.offset + 16;
		version = ctx.value;
		base = 16;
		const table = u32(8) + 16, count = u32(12);
		for (let i = 0; i < Math.min(count, 64) && table + i * 4 + 4 <= bytes.length; i++) offsetSlots.push(u32(table + i * 4) + base);
	} else {
		if (!isMirage(bytes)) throw new Error('Not a Hedgehog Engine mirage file');
		version = u32(4);
		data = u32(12);
		base = data;
		const table = u32(16);
		const count = table && table + 4 <= bytes.length ? u32(table) : 0;
		for (let i = 0; i < Math.min(count, 64) && table + 8 + i * 4 <= bytes.length; i++) offsetSlots.push(u32(table + 4 + i * 4) + base);
	}
	// Vote: which reading keeps more of the offsets inside the file?
	let beOk = 0, leOk = 0;
	for (const at of offsetSlots) {
		if (at < 0 || at + 4 > bytes.length) continue;
		const v = u32(at);
		if (v === 0) continue;
		if (v + base < bytes.length) beOk++;
		const le = at + dv.getInt32(at, true);
		if (le >= 0 && le < bytes.length) leOk++;
	}
	const selfRelative = leOk > beOk;
	const off = selfRelative
		? (o: number) => {
				const v = dv.getInt32(o, true);
				return v === 0 ? 0 : o + v;
			}
		: (o: number) => {
				const v = u32(o);
				return v === 0 ? 0 : v + base;
			};
	return { bytes, dv, data, version, nodes, base, selfRelative, u32, off, str };
}
