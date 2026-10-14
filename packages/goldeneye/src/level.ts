/**
 * GoldenEye 007 level geometry (`bg/bg_*_all_p.seg`), n64decomp/007
 * `src/game/bg.c` / `bg.h`.
 *
 * The file is a small header (u32 0, then segment-0x0F pointers: room
 * table, portals, …) and per-room blocks. The room table holds
 * `{ pPointTableBin, pPriMappingBin, pSecMappingBin, coord3d pos }`
 * (24 bytes; entry 0 is empty; it ends at the first null primary list).
 * Each block is a rarezip (`0x1172` + DEFLATE) stream: the room's
 * 16-byte vertices, and its primary (opaque) and secondary
 * (translucent) display lists. Lists read vertices through segment
 * 0x0E, name textures like models do (`G_SETTEX`), and are drawn at the
 * room's position.
 */

import { RareListDrawer, type GoldeneyePrimitive } from './model.js';

const u32 = (b: Uint8Array, o: number) => (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getFloat32(o);

export interface GoldeneyeLevel {
	rooms: number;
	primitives: GoldeneyePrimitive[];
	textureIds: number[];
}

/** True when `bg` looks like a level file (header pointers in segment 0x0F). */
export function isGoldeneyeLevel(bg: Uint8Array): boolean {
	return bg.length > 0x40 && u32(bg, 0) === 0 && u32(bg, 4) >>> 24 === 0x0f && (u32(bg, 4) & 0xffffff) < bg.length;
}

/**
 * Build every room of a level. `inflate(buf, offset)` decompresses the
 * rarezip block at `offset` (e.g. `decompressRare1172`).
 */
export async function buildGoldeneyeLevel(bg: Uint8Array, inflate: (buf: Uint8Array, offset: number) => Promise<Uint8Array>): Promise<GoldeneyeLevel> {
	if (!isGoldeneyeLevel(bg)) throw new Error('Not a GoldenEye level file');
	const table = u32(bg, 4) & 0xffffff;
	const drawer = new RareListDrawer();
	const at = (p: number) => (p >>> 24 === 0x0f && (p & 0xffffff) < bg.length ? p & 0xffffff : null);
	let rooms = 0;
	for (let i = 1; i < 512; i++) {
		const e = table + i * 24;
		if (e + 24 > bg.length) break;
		const pt = at(u32(bg, e)), pri = at(u32(bg, e + 4)), sec = at(u32(bg, e + 8));
		if (u32(bg, e + 4) === 0) break;
		const pos: [number, number, number] = [f32(bg, e + 12), f32(bg, e + 16), f32(bg, e + 20)];
		let vtx: Uint8Array | null = null;
		try {
			vtx = pt === null ? null : await inflate(bg, pt);
		} catch {
			vtx = null;
		}
		if (!vtx) continue;
		rooms++;
		for (const list of [pri, sec]) {
			if (list === null) continue;
			let dl: Uint8Array;
			try {
				dl = await inflate(bg, list);
			} catch {
				continue;
			}
			drawer.draw(dl, 0, (addr) => {
				const seg = addr >>> 24, o = addr & 0xffffff;
				if (seg === 0x0e) return o < vtx!.length ? { buf: vtx!, o } : null;
				if (seg === 0x0f) return o < dl.length ? { buf: dl, o } : null;
				return null;
			}, () => pos);
		}
	}
	return { rooms, primitives: drawer.finish(), textureIds: [...drawer.textureIds].sort((a, b) => a - b) };
}
