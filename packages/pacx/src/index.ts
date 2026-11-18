/**
 * Hedgehog Engine "PACx" packfiles (`.pac`), as used by Sonic Forces
 * (v3, `PACx301L`/`PACx302L`) and Sonic Frontiers (v4, `PACx403L`
 * around `PACx402L` pacs). Layout from HedgeLib++ (Radfordhound/HedgeLib,
 * `hl_pacx.h` / `hl_pacx.cpp`).
 *
 * v4 wrapper (0x20 bytes): `PACx`, version "403", endian 'L', uid,
 * fileSize, root offset, root compressed / uncompressed size, flagsV4
 * (0x80 metadata, 0x2 parents), flagsV3 (0x200 LZ4, 0x100 Deflate).
 * With metadata a block follows: parentsSize, chunkTableSize,
 * strTableSize, offTableSize, then the parent table (arr64 of name
 * offsets) and the LZ4 chunk table (u32 count, then compressed /
 * uncompressed u32 pairs). Each LZ4 chunk is an independent block;
 * equal sizes mean stored.
 *
 * The root is a v3 pac (0x30 header: sizes of the type tree, dependency
 * table, data entries, strings, file data, offset table; type, flags,
 * depCount). All offsets are 64-bit and relative to that header. The
 * type tree's data nodes ("ResModel", "ResTexture", …) each own a file
 * tree: a radix tree whose nodes carry a name fragment, children, and
 * `bufStartIndex`, where its fragment goes in the path. Data nodes
 * point at a 0x30-byte data entry (uid, size, data, extension, flags;
 * flag 1 = "not here", a streamed proxy).
 *
 * Big files live in "splits": in a v4 root, the dependency table lists
 * them (name, compressed / uncompressed size, file offset in the v4
 * pac, and for LZ4 the chunk list), each another v3 pac.
 */

import { decodeBlock } from '@tootallnate/lz4';

export interface PacxEntry {
	/** File name with extension (`chr_amy.model`). */
	name: string;
	/** Extension without the dot. */
	ext: string;
	size: number;
	/** Streamed elsewhere (no data in this pac). */
	proxy: boolean;
	/** Bytes (a view into the decompressed pac). */
	data: Uint8Array;
}

export interface PacxArchive {
	version: string;
	uid: number;
	entries: PacxEntry[];
	/** Parent pacs named in the metadata (v4). */
	parents: string[];
	/** Split pac names (v3 roots that list their dependencies). */
	splits: string[];
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function isPacx(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && ascii(bytes, 0, 4) === 'PACx';
}

/** `PACx` version string ("403", "402", …). */
export function pacxVersion(bytes: Uint8Array): string {
	return ascii(bytes, 4, 3);
}

function cstr(b: Uint8Array, o: number): string {
	let e = o;
	while (e < b.length && b[e] !== 0) e++;
	return new TextDecoder().decode(b.subarray(o, e));
}

function decompressChunks(src: Uint8Array, chunks: [number, number][], outSize: number): Uint8Array {
	if (src.length === outSize) return src;
	const out = new Uint8Array(outSize);
	let s = 0, d = 0;
	for (const [c, u] of chunks) {
		const part = src.subarray(s, s + c);
		out.set(c === u ? part : decodeBlock(part, u), d);
		s += c;
		d += u;
	}
	return out;
}

/** Read a v3 pac (Forces, or the root / splits of a Frontiers v4 pac). */
export function readPacxV3(b: Uint8Array): { uid: number; entries: PacxEntry[]; depTable: number; depCount: number; flags: number } {
	if (b[7] !== 0x4c) throw new Error('Big-endian PACx is not supported');
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const u32 = (o: number) => dv.getUint32(o, true);
	const off = (o: number) => Number(dv.getBigUint64(o, true));
	const treesSize = u32(0x10);
	const flags = dv.getUint16(0x2a, true);
	const depCount = u32(0x2c);
	const entries: PacxEntry[] = [];

	const readTree = (at: number) => ({ count: u32(at), dataCount: u32(at + 4), nodes: off(at + 8), dataIndices: off(at + 16) });
	const NODE = 0x28;
	const node = (base: number, i: number) => {
		const o = base + i * NODE;
		return {
			name: off(o) ? cstr(b, off(o)) : null,
			data: off(o + 8),
			children: off(o + 16),
			childCount: dv.getUint16(o + 0x24, true),
			hasData: b[o + 0x26] !== 0,
			bufStart: b[o + 0x27]!,
		};
	};

	const types = readTree(0x30);
	for (let i = 0; i < types.dataCount; i++) {
		const t = node(types.nodes, dv.getInt32(types.dataIndices + i * 4, true));
		if (!t.data) continue;
		const files = readTree(t.data);
		let path = '';
		const walk = (idx: number, depth: number) => {
			if (depth > 512) return;
			const n = node(files.nodes, idx);
			if (n.hasData && n.data) {
				const name = path.slice(0, n.bufStart);
				const e = n.data;
				const size = u32(e + 4);
				const ext = off(e + 0x20) ? cstr(b, off(e + 0x20)) : '';
				const proxy = (dv.getUint16(e + 0x28, true) & 1) !== 0;
				const data = off(e + 0x10);
				entries.push({
					name: ext ? `${name}.${ext}` : name,
					ext,
					size,
					proxy,
					data: proxy ? new Uint8Array(0) : b.subarray(data, data + size),
				});
			} else if (n.name !== null) {
				path = path.slice(0, n.bufStart) + n.name;
			}
			for (let c = 0; c < n.childCount; c++) walk(dv.getInt32(n.children + c * 4, true), depth + 1);
		};
		if (files.count) walk(0, 0);
	}
	return { uid: u32(8), entries, depTable: 0x30 + treesSize, depCount, flags };
}

/** Read a PACx archive: v4 (root plus its splits) or v3. */
export function readPacx(bytes: Uint8Array): PacxArchive {
	if (!isPacx(bytes)) throw new Error('Not a PACx archive');
	const version = pacxVersion(bytes);
	if (bytes[7] !== 0x4c) throw new Error('Big-endian PACx is not supported');
	// 402 is the v3 layout that Frontiers wraps (its splits stand alone too).
	if (version[0] === '3' || version === '402') {
		const r = readPacxV3(bytes);
		return { version, uid: r.uid, entries: r.entries, parents: [], splits: [] };
	}
	if (version[0] !== '4') throw new Error(`PACx version ${version} is not supported`);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => dv.getUint32(o, true);
	const off = (o: number) => Number(dv.getBigUint64(o, true));
	const uid = u32(8);
	const rootOff = u32(0x10), rootC = u32(0x14), rootU = u32(0x18);
	const flagsV4 = dv.getUint16(0x1c, true), flagsV3 = dv.getUint16(0x1e, true);
	const lz4 = (flagsV3 & 0x200) !== 0;
	if (!lz4 && rootC !== rootU) throw new Error('Deflate-compressed PACx v4 is not supported yet');

	const parents: string[] = [];
	let rootChunks: [number, number][] = [];
	if (flagsV4 & 0x80) {
		const parentsSize = u32(0x20), chunkTableSize = u32(0x24);
		const parentsAt = 0x30;
		if (flagsV4 & 0x2 && parentsSize >= 16) {
			const n = Number(dv.getBigUint64(parentsAt, true)), list = off(parentsAt + 8);
			for (let i = 0; i < n; i++) parents.push(cstr(bytes, off(list + i * 8)));
		}
		const ct = parentsAt + parentsSize;
		if (chunkTableSize >= 4) {
			const n = u32(ct);
			for (let i = 0; i < n; i++) rootChunks.push([u32(ct + 4 + i * 8), u32(ct + 8 + i * 8)]);
		}
	}
	if (lz4 && rootC !== rootU && !rootChunks.length) rootChunks = [[rootC, rootU]];
	const root = decompressChunks(bytes.subarray(rootOff, rootOff + rootC), rootChunks, rootU);
	const r = readPacxV3(root);
	const entries = [...r.entries];
	const splits: string[] = [];
	if (r.depCount) {
		const rdv = new DataView(root.buffer, root.byteOffset, root.byteLength);
		const roff = (o: number) => Number(rdv.getBigUint64(o, true));
		const count = roff(r.depTable), list = roff(r.depTable + 8);
		const stride = lz4 ? 0x20 : 0x18;
		for (let i = 0; i < count; i++) {
			const d = list + i * stride;
			const name = cstr(root, roff(d));
			const c = rdv.getUint32(d + 8, true), u = rdv.getUint32(d + 12, true), pos = rdv.getUint32(d + 16, true);
			const chunks: [number, number][] = [];
			if (lz4) {
				const n = rdv.getUint32(d + 20, true), at = roff(d + 24);
				for (let k = 0; k < n; k++) chunks.push([rdv.getUint32(at + k * 8, true), rdv.getUint32(at + k * 8 + 4, true)]);
			}
			if (!lz4 && c !== u) throw new Error('Deflate-compressed PACx splits are not supported yet');
			splits.push(name);
			const split = decompressChunks(bytes.subarray(pos, pos + c), chunks.length ? chunks : [[c, u]], u);
			entries.push(...readPacxV3(split).entries);
		}
	}
	return { version, uid, entries, parents, splits };
}
