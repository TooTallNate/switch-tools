/**
 * Super Mario 64 level scripts, walked statically to find every model.
 *
 * The game has no file table: level scripts (n64decomp/sm64
 * `include/level_commands.h`) load ROM ranges into RSP segments and
 * register models, and each command carries its own length in byte 1:
 *
 *   00/01  EXECUTE seg, romStart, romEnd, entry   load raw, then run entry
 *   05     JUMP target          06  JUMP_LINK target     07  RETURN   02  EXIT
 *   0C/0D  JUMP_IF / JUMP_LINK_IF op, arg, target (followed both ways)
 *   17     LOAD_RAW seg, start, end        18/1A  LOAD_MIO0(_TEXTURE)
 *   1F     AREA index, geo                 22     LOAD_MODEL_FROM_GEO id, geo
 *   21     LOAD_MODEL_FROM_DL id|layer, dl
 *
 * {@link walkSm64Scripts} starts at `level_script_entry` (found by its
 * fixed opening commands, so no per-version offsets), follows every
 * branch with a copy of the segment map, and records each model / area
 * geo layout with the segments loaded at that point. A level is the
 * target of `JUMP_IF(OP_EQ, level)` / `JUMP_LINK_IF` in the main scripts.
 */

import { decompressMio0Bytes } from '@tootallnate/mio0';

export interface Sm64Segment {
	romStart: number;
	romEnd: number;
	mio0: boolean;
}

export type Sm64SegmentMap = ReadonlyMap<number, Sm64Segment>;

export interface Sm64GeoRef {
	/** Segmented address of the geo layout. */
	geo: number;
	segments: Sm64SegmentMap;
	/** Level number (1-based, `level_defines.h`), or 0 outside levels. */
	level: number;
}

export interface Sm64ModelRef extends Sm64GeoRef {
	modelId: number;
	/** True for LOAD_MODEL_FROM_DL (a bare display list, no geo layout). */
	displayList: boolean;
}

export interface Sm64AreaRef extends Sm64GeoRef {
	area: number;
}

export interface Sm64Scripts {
	entry: number;
	models: Sm64ModelRef[];
	areas: Sm64AreaRef[];
}

const u8 = (b: Uint8Array, o: number) => b[o] ?? 0;
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const u32 = (b: Uint8Array, o: number) => ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;

/** INIT_LEVEL; SLEEP(2); BLACKOUT(FALSE); SET_REG(0); EXECUTE(0x14, …) */
const ENTRY = [0x1b, 0x04, 0x00, 0x00, 0x03, 0x04, 0x00, 0x02, 0x34, 0x04, 0x00, 0x00, 0x13, 0x04, 0x00, 0x00, 0x00, 0x10, 0x00, 0x14];

/** ROM offset of `level_script_entry`, or null. */
export function findSm64Entry(rom: Uint8Array): number | null {
	outer: for (let o = 0; o + ENTRY.length <= rom.length; o += 4) {
		for (let i = 0; i < ENTRY.length; i++) if (rom[o + i] !== ENTRY[i]) continue outer;
		return o;
	}
	return null;
}

/** Bytes of a loaded segment (MIO0 decompressed), cached by ROM range. */
export class Sm64SegmentCache {
	private cache = new Map<string, Uint8Array>();
	constructor(private readonly rom: Uint8Array) {}
	get(seg: Sm64Segment): Uint8Array | null {
		const key = `${seg.romStart}:${seg.romEnd}:${seg.mio0}`;
		let b = this.cache.get(key);
		if (!b) {
			if (seg.romEnd <= seg.romStart || seg.romEnd > this.rom.length) return null;
			try {
				b = seg.mio0 ? decompressMio0Bytes(this.rom, seg.romStart) : this.rom.subarray(seg.romStart, seg.romEnd);
			} catch {
				return null;
			}
			this.cache.set(key, b);
		}
		return b;
	}
}

/** Walk every level script reachable from the entry script. */
export function walkSm64Scripts(rom: Uint8Array, options: { entry?: number; maxSteps?: number } = {}): Sm64Scripts | null {
	const entry = options.entry ?? findSm64Entry(rom);
	if (entry === null) return null;
	const cache = new Sm64SegmentCache(rom);
	const maxSteps = options.maxSteps ?? 400_000;
	const models: Sm64ModelRef[] = [];
	const areas: Sm64AreaRef[] = [];
	const seen = new Set<string>();
	const modelSeen = new Set<string>();
	let steps = 0;
	const sig = (segs: Sm64SegmentMap) => [...segs].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v.romStart}`).join(',');

	/** Run a script at segmented `addr`; returns when it returns / exits / jumps away. */
	const run = (addr: number, segs: Map<number, Sm64Segment>, level: number, depth: number): void => {
		if (depth > 48) return;
		for (;;) {
			const key = `${addr}|${sig(segs)}|${level}`;
			if (seen.has(key)) return;
			seen.add(key);
			const seg = segs.get(addr >>> 24);
			const buf = seg ? cache.get(seg) : null;
			if (!buf) return;
			let o = addr & 0xffffff;
			for (;;) {
				if (++steps > maxSteps || o + 4 > buf.length) return;
				const cmd = u8(buf, o), len = u8(buf, o + 1);
				if (len < 4 || len % 2 || o + len > buf.length) return;
				const next = addr - (addr & 0xffffff) + o + len;
				switch (cmd) {
					case 0x00:
					case 0x01: {
						const s = u16(buf, o + 2);
						const child = new Map(segs);
						child.set(s, { romStart: u32(buf, o + 4), romEnd: u32(buf, o + 8), mio0: false });
						run(u32(buf, o + 12), child, level, depth + 1);
						if (cmd === 0x01) return;
						break;
					}
					case 0x02:
					case 0x07:
						return;
					case 0x05:
						addr = u32(buf, o + 4);
						break;
					case 0x06:
						run(u32(buf, o + 4), new Map(segs), level, depth + 1);
						break;
					case 0x0c:
					case 0x0d: {
						// JUMP_IF(OP_EQ, n): the main scripts' per-level dispatch.
						const lvl = u8(buf, o + 2) === 2 && u32(buf, o + 4) < 64 ? u32(buf, o + 4) : level;
						run(u32(buf, o + 8), new Map(segs), lvl, depth + 1);
						break;
					}
					case 0x17:
					case 0x18:
					case 0x1a:
						segs.set(u16(buf, o + 2), { romStart: u32(buf, o + 4), romEnd: u32(buf, o + 8), mio0: cmd !== 0x17 });
						break;
					case 0x1f: {
						const geo = u32(buf, o + 4), s = segs.get(geo >>> 24);
						const k = `area|${geo}|${s?.romStart}`;
						if (s && !modelSeen.has(k)) {
							modelSeen.add(k);
							areas.push({ area: u8(buf, o + 2), geo, segments: new Map(segs), level });
						}
						break;
					}
					case 0x21:
					case 0x22: {
						const id = cmd === 0x21 ? u16(buf, o + 2) & 0xfff : u16(buf, o + 2);
						const geo = u32(buf, o + 4);
						const s = segs.get(geo >>> 24);
						const k = `${geo}|${s?.romStart}`;
						if (s && !modelSeen.has(k)) {
							modelSeen.add(k);
							models.push({ modelId: id, geo, segments: new Map(segs), level, displayList: cmd === 0x21 });
						}
						break;
					}
				}
				if (cmd === 0x05) break; // continue at the jump target
				o += len;
				void next;
			}
		}
	};
	// The entry script sits in segment 0x10, loaded from its own ROM range.
	run(0x10000000, new Map([[0x10, { romStart: entry, romEnd: Math.min(rom.length, entry + 0x10000), mio0: false }]]), 0, 0);
	return { entry, models, areas };
}
