/**
 * Zelda 64 scenes and rooms (levels).
 *
 * A scene file (segment 2) and its room files (segment 3) start with a
 * list of 8-byte header commands ending in 0x14 (zeldaret
 * `z64scene.h`):
 *
 *   0x04  rooms      u8 count; u32 → { u32 vromStart, u32 vromEnd }[]
 *   0x0A  mesh       u32 → room shape (rooms only)
 *   0x18  alternate headers (not followed here)
 *
 * Room shapes (`RoomShapeType`):
 *
 *   0  normal   u8 type, u8 count, u32 start, u32 end → { u32 opa, u32 xlu }[]
 *   2  cullable same header → { s16 x, y, z, s16 radius, u32 opa, u32 xlu }[]
 *   1  image    pre-rendered background: u8 type, u8 amount (1 single /
 *               2 multi), u32 → { opa, xlu } entry, then the image(s):
 *               single = inline { u32 source (JPEG), u32 unk, u32 tlut,
 *               u16 width, u16 height, u8 fmt, u8 siz, u16 mode, u16 tlutCount };
 *               multi = u8 count, u32 → 0x1C-byte entries with a leading
 *               u16 unk, u8 bgCamIndex.
 *
 * Room display lists draw from segment 3 (the room), 2 (the scene's
 * shared textures) and 4 (`gameplay_keep`). `gSceneTable` (in `code`)
 * gives scene IDs: 0x14-byte entries in Ocarina of Time, 0x10 in
 * Majora's Mask, each starting with the scene file's vrom range.
 */

import { interpretDisplayList, mergeF3dexMeshes, type F3dexMesh } from '@tootallnate/f3dex';

export { mergeF3dexMeshes };

const u8 = (b: Uint8Array, o: number) => b[o] ?? 0;
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const u32 = (b: Uint8Array, o: number) => ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;

/** Walk a header command list; returns command offsets by id (first one wins). */
function headerCommands(b: Uint8Array): Map<number, number> | null {
	const cmds = new Map<number, number>();
	for (let o = 0; o + 8 <= b.length && o < 0x200; o += 8) {
		const id = u8(b, o);
		if (id === 0x14) return cmds;
		if (id > 0x1e) return null;
		if (!cmds.has(id)) cmds.set(id, o);
	}
	return null;
}

const inSeg = (b: Uint8Array, p: number, seg: number, size = 4) => p >>> 24 === seg && (p & 0xffffff) + size <= b.length;

/** The room files (vrom ranges) a scene lists, or null when it isn't a scene. */
export function parseZ64SceneRooms(scene: Uint8Array): { vromStart: number; vromEnd: number }[] | null {
	const cmds = headerCommands(scene);
	const at = cmds?.get(0x04);
	if (at === undefined) return null;
	const count = u8(scene, at + 1), list = u32(scene, at + 4);
	if (count === 0 || !inSeg(scene, list, 2, count * 8)) return null;
	const out: { vromStart: number; vromEnd: number }[] = [];
	for (let i = 0; i < count; i++) {
		const s = u32(scene, (list & 0xffffff) + i * 8), e = u32(scene, (list & 0xffffff) + i * 8 + 4);
		if (e <= s) return null;
		out.push({ vromStart: s, vromEnd: e });
	}
	return out;
}

export interface Z64RoomShape {
	type: number;
	/** Segmented (0x03) display lists, opaque then translucent. */
	displayLists: number[];
	/** Pre-rendered backgrounds (type 1): JPEG offsets in the room file. */
	backgrounds: { offset: number; width: number; height: number }[];
}

/** The room's shape (mesh header), or null when it has none. */
export function parseZ64RoomShape(room: Uint8Array): Z64RoomShape | null {
	const cmds = headerCommands(room);
	const at = cmds?.get(0x0a);
	if (at === undefined) return null;
	const p = u32(room, at + 4);
	if (!inSeg(room, p, 3, 12)) return null;
	const h = p & 0xffffff;
	const type = u8(room, h);
	const dls: number[] = [];
	const backgrounds: Z64RoomShape['backgrounds'] = [];
	const addDl = (v: number) => {
		if (v && inSeg(room, v, 3, 8)) dls.push(v);
	};
	if (type === 0 || type === 2) {
		const count = u8(room, h + 1), start = u32(room, h + 4);
		const stride = type === 0 ? 8 : 16, skip = type === 0 ? 0 : 8;
		if (!inSeg(room, start, 3, count * stride)) return null;
		for (let i = 0; i < count; i++) {
			const e = (start & 0xffffff) + i * stride + skip;
			addDl(u32(room, e));
			addDl(u32(room, e + 4));
		}
	} else if (type === 1) {
		const amount = u8(room, h + 1), entry = u32(room, h + 4);
		if (inSeg(room, entry, 3, 8)) {
			addDl(u32(room, entry & 0xffffff));
			addDl(u32(room, (entry & 0xffffff) + 4));
		}
		const image = (o: number) => {
			const src = u32(room, o), w = u16(room, o + 12), hgt = u16(room, o + 14);
			if (inSeg(room, src, 3, 4) && u16(room, src & 0xffffff) === 0xffd8) backgrounds.push({ offset: src & 0xffffff, width: w, height: hgt });
		};
		if (amount === 1) image(h + 8);
		else if (amount === 2) {
			const n = u8(room, h + 8), list = u32(room, h + 12);
			if (inSeg(room, list, 3, n * 0x1c)) for (let i = 0; i < n; i++) image((list & 0xffffff) + i * 0x1c + 4);
		}
	} else return null;
	return { type, displayLists: dls, backgrounds };
}

/** The bytes of a JPEG starting at `offset` (through its EOI marker). */
export function z64JpegAt(room: Uint8Array, offset: number): Uint8Array | null {
	if (u16(room, offset) !== 0xffd8) return null;
	for (let o = offset + 2; o + 1 < room.length; o++) if (room[o] === 0xff && room[o + 1] === 0xd9) return room.subarray(offset, o + 2);
	return null;
}

/**
 * `gSceneTable`: index = scene ID, each entry starting with the scene
 * file's vrom range (stride 0x14 in OoT, 0x10 in MM). Null slots are unset.
 */
export function findZ64SceneTable(code: Uint8Array, files: readonly { vromStart: number; vromEnd: number }[]): ({ vromStart: number; vromEnd: number } | null)[] | null {
	const ends = new Map(files.map((f) => [f.vromStart, f.vromEnd]));
	let best: ({ vromStart: number; vromEnd: number } | null)[] | null = null;
	for (const stride of [0x14, 0x10]) {
		for (let o = 0; o + stride * 32 <= code.length; o += 4) {
			const s0 = u32(code, o);
			if (ends.get(s0) !== u32(code, o + 4)) continue;
			const out: ({ vromStart: number; vromEnd: number } | null)[] = [];
			let hits = 0;
			for (let i = 0; o + i * stride + 8 <= code.length; i++) {
				const s = u32(code, o + i * stride), e = u32(code, o + i * stride + 4);
				if (s === 0 && e === 0) {
					out.push(null);
					continue;
				}
				if (ends.get(s) !== e) break;
				// OoT entries carry a second (title card) file pair, zero or
				// real; MM's tail is text ids and flags, never a file pair.
				// This keeps the stride-8 object table from matching.
				const t0 = u32(code, o + i * stride + 8), t1 = u32(code, o + i * stride + 12);
				const pair = t0 !== 0 && ends.get(t0) === t1;
				if (stride === 0x14 ? !(pair || (t0 === 0 && t1 === 0)) : pair) break;
				out.push({ vromStart: s, vromEnd: e });
				hits++;
			}
			if (hits >= 50 && (!best || out.length > best.length)) best = out;
			if (hits >= 50) break;
		}
	}
	return best;
}

export interface Z64LevelMesh extends Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'alphas' | 'uvs' | 'indices' | 'groups' | 'materials' | 'usesLighting'> {
	/** The buffer the materials' texture offsets index into. */
	data: Uint8Array;
}

/**
 * Draw every room of a scene into one mesh. Textures resolve from the
 * room (segment 3), the scene (2) and `gameplay_keep` (4).
 */
export function buildZ64LevelMesh(scene: Uint8Array, rooms: Uint8Array[], keep: Uint8Array = new Uint8Array(0)): Z64LevelMesh {
	const total = scene.length + keep.length + rooms.reduce((a, r) => a + r.length, 0);
	const data = new Uint8Array(total);
	data.set(scene);
	data.set(keep, scene.length);
	const parts: F3dexMesh[] = [];
	let roomBase = scene.length + keep.length;
	for (const room of rooms) {
		data.set(room, roomBase);
		const base = roomBase;
		const resolveSegment = (a: number) => {
			const seg = a >>> 24, o = a & 0xffffff;
			if (seg === 3) return o < room.length ? base + o : null;
			if (seg === 2) return o < scene.length ? o : null;
			if (seg === 4) return o < keep.length ? scene.length + o : null;
			return null;
		};
		const shape = parseZ64RoomShape(room);
		for (const dl of shape?.displayLists ?? []) {
			const m = interpretDisplayList(data, resolveSegment(dl) ?? -1, { microcode: 'f3dex2', resolveSegment, trustSegments: true, maxCommands: 200000 });
			if (m.indices.length) parts.push(m);
		}
		roomBase += room.length;
	}
	return { ...mergeF3dexMeshes(parts), data };
}

