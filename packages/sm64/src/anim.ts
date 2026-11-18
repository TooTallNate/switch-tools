/**
 * Super Mario 64 animations (n64decomp/sm64 `include/types.h`
 * `struct Animation`, `src/engine/graph_node.c`):
 *
 *   s16 flags, s16 animYTransDivisor, s16 startFrame, s16 loopStart,
 *   s16 loopEnd, s16 unusedBoneCount, s16 *values, u16 *index, u32 length
 *
 * `index` holds one (maxFrame, offset) u16 pair per channel: three root
 * translation channels, then three rotation channels (binary angles) per
 * animated part. Channel k at frame f reads
 * `values[offset + min(f, maxFrame − 1)]` (`retrieve_animation_index`).
 * `unusedBoneCount` is the part count (`ANIMINDEX_NUMPARTS`), and actor
 * data is laid out values, index, then the header, so either identifies
 * the animations that fit a geo layout ({@link findSm64Animations}).
 * An actor's animations are listed by a pointer table (`*_anims[]`,
 * `actors/<name>/anims/table.inc.c`) that follows them
 * ({@link findSm64AnimationTables}).
 *
 * Mario's animations are separate: a DMA table (`struct DmaTable`:
 * u32 count, u32 srcAddr, then (offset, size) pairs relative to the
 * table) whose entries each start with a header whose pointers are
 * offsets into that entry, laid out header, index, values
 * ({@link findSm64MarioAnimations}).
 */

const u16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u16(b, o) << 16) | u16(b, o + 2)) >>> 0;

export const SM64_ANIM_FLAG_NOLOOP = 0x01;
const ANIM_FLAG_HOR_TRANS = 0x08;
const ANIM_FLAG_VERT_TRANS = 0x10;
const ANIM_FLAG_6 = 0x40;

export interface Sm64Animation {
	/** Header offset in its segment (or DMA entry). */
	offset: number;
	flags: number;
	animYTransDivisor: number;
	startFrame: number;
	loopStart: number;
	/** Frames in the clip (`loopEnd`). */
	frames: number;
	/** Animated parts the index table covers. */
	parts: number;
	/** Root translation channels then 3 rotations per part, at frame 0 (or the frame asked for). */
	channels: Int16Array;
	/** Every value the channels index into. */
	values: Int16Array;
	/** (maxFrame, offset) per channel. */
	index: Uint16Array;
}

/** Channel values at `frame`, clamped per channel like `retrieve_animation_index`. */
export function sampleSm64Animation(a: Pick<Sm64Animation, 'values' | 'index'>, frame: number): Int16Array {
	const n = a.index.length >> 1;
	const out = new Int16Array(n);
	const f = Math.max(0, Math.floor(frame));
	for (let k = 0; k < n; k++) {
		const max = a.index[k * 2]!, off = a.index[k * 2 + 1]!;
		out[k] = a.values[off + (f < max ? f : Math.max(0, max - 1))] ?? 0;
	}
	return out;
}

/**
 * How the first animated part reads the root channels
 * (`geo_set_animation_globals`): which translation axes it adds, scaled
 * like Mario's (`animYTrans` 189 over the clip's divisor).
 */
export function sm64RootTranslation(a: Pick<Sm64Animation, 'flags' | 'animYTransDivisor'>, c: ArrayLike<number>): [number, number, number] {
	const k = a.animYTransDivisor ? 189 / a.animYTransDivisor : 1;
	if (a.flags & ANIM_FLAG_HOR_TRANS) return [0, (c[1] ?? 0) * k, 0];
	if (a.flags & ANIM_FLAG_VERT_TRANS) return [(c[0] ?? 0) * k, 0, (c[2] ?? 0) * k];
	if (a.flags & ANIM_FLAG_6) return [0, 0, 0];
	return [(c[0] ?? 0) * k, (c[1] ?? 0) * k, (c[2] ?? 0) * k];
}

/** Read the animation whose header is at `header`; pointers resolve through `ptr` (null = invalid). */
function readAnimation(buf: Uint8Array, header: number, parts: number, ptr: (p: number) => number | null, frame: number): Sm64Animation | null {
	if (header < 0 || header + 0x18 > buf.length) return null;
	const vo = ptr(u32(buf, header + 0x0c)), io = ptr(u32(buf, header + 0x10));
	if (vo === null || io === null) return null;
	const n = (parts + 1) * 3;
	if (io + n * 4 > buf.length) return null;
	const index = new Uint16Array(n * 2);
	let maxValue = 0;
	for (let k = 0; k < n * 2; k++) index[k] = u16(buf, io + k * 2);
	for (let k = 0; k < n; k++) maxValue = Math.max(maxValue, index[k * 2 + 1]! + Math.max(1, index[k * 2]!));
	// Values precede the index in actor banks and follow it in Mario's entries.
	const limit = vo < io ? io : buf.length;
	if (vo + maxValue * 2 > limit) return null;
	const values = new Int16Array(maxValue);
	for (let i = 0; i < maxValue; i++) values[i] = s16(buf, vo + i * 2);
	const frames = s16(buf, header + 0x08);
	const a: Sm64Animation = {
		offset: header,
		flags: s16(buf, header),
		animYTransDivisor: s16(buf, header + 0x02),
		startFrame: s16(buf, header + 0x04),
		loopStart: s16(buf, header + 0x06),
		frames: frames > 0 ? frames : 1,
		parts,
		channels: new Int16Array(0),
		values,
		index,
	};
	a.channels = sampleSm64Animation(a, frame);
	return a;
}

/**
 * Animations in segment `seg`'s bytes with exactly `parts` animated
 * parts, sampled at `frame` (default 0). An actor's geo layout, display
 * lists and animations sit together in its group bank, so callers
 * should prefer the one nearest the actor's display lists.
 */
export function findSm64Animations(buf: Uint8Array, seg: number, parts: number, frame = 0): Sm64Animation[] {
	const out: Sm64Animation[] = [];
	const tableBytes = (parts + 1) * 12;
	const ptr = (p: number) => (p >>> 24 === seg && (p & 0xffffff) < buf.length ? p & 0xffffff : null);
	for (let o = 0; o + 0x18 <= buf.length; o += 4) {
		const values = u32(buf, o + 0x0c), index = u32(buf, o + 0x10);
		if (values >>> 24 !== seg || index >>> 24 !== seg) continue;
		const vo = values & 0xffffff, io = index & 0xffffff;
		if (vo >= io || io >= o) continue;
		const gap = o - io - tableBytes;
		if (!(s16(buf, o + 0x0a) === parts && gap >= 0) && (gap < 0 || gap > 15)) continue;
		const a = readAnimation(buf, o, parts, ptr, frame);
		if (a) out.push(a);
	}
	return out;
}

export interface Sm64AnimationTable {
	/** Offset of the pointer table in the segment. */
	offset: number;
	/** Entries in table order (null where the table has a hole or a clip that doesn't fit). */
	animations: (Sm64Animation | null)[];
}

/**
 * Pointer tables (`*_anims[]`) over `anims`: runs of segmented pointers
 * to their headers, NULL entries allowed inside a run.
 */
export function findSm64AnimationTables(buf: Uint8Array, seg: number, anims: Sm64Animation[]): Sm64AnimationTable[] {
	const byOffset = new Map(anims.map((a) => [a.offset, a]));
	const out: Sm64AnimationTable[] = [];
	// Entries for clips with another part count (Bowser's table has a
	// one-part stub) become holes rather than ending the table.
	const at = (o: number): Sm64Animation | null | undefined => {
		const p = u32(buf, o);
		if (p === 0) return null;
		if (p >>> 24 !== seg) return undefined;
		const h = p & 0xffffff;
		const a = byOffset.get(h);
		if (a) return a;
		const header = h + 0x18 <= buf.length && u32(buf, h + 0x0c) >>> 24 === seg && u32(buf, h + 0x10) >>> 24 === seg;
		return header ? null : undefined;
	};
	for (let o = 0; o + 4 <= buf.length; o += 4) {
		if (!at(o)) continue;
		const animations: (Sm64Animation | null)[] = [];
		let e = o;
		for (; e + 4 <= buf.length; e += 4) {
			const a = at(e);
			if (a === undefined) break;
			animations.push(a);
		}
		while (animations.length && animations[animations.length - 1] === null) animations.pop();
		out.push({ offset: o, animations });
		o = e - 4;
	}
	return out;
}

/**
 * An actor's animations: those with its part count in the segment most
 * of its display lists come from, from the pointer table nearest after
 * its display lists (group banks lay each actor out as model, then
 * animations, then their table). `index` is the position in that table
 * (`obj_init_animation` indices). Falls back to the nearest lone
 * animation when there's no table.
 */
export function findSm64ActorAnimations(segmentBytes: (seg: number) => Uint8Array | null, displayLists: number[], parts: number): { index: number; animation: Sm64Animation }[] {
	const counts = new Map<number, number>();
	for (const dl of displayLists) counts.set(dl >>> 24, (counts.get(dl >>> 24) ?? 0) + 1);
	const seg = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (seg === undefined) return [];
	const buf = segmentBytes(seg);
	if (!buf) return [];
	const offs = displayLists.filter((d) => d >>> 24 === seg).map((d) => d & 0xffffff);
	const lo = Math.min(...offs), hi = Math.max(...offs);
	const anims = findSm64Animations(buf, seg, parts);
	if (!anims.length) return [];
	// Past the display lists is where the table should be; before them only as a last resort.
	const distance = (o: number) => (o > hi ? o - hi : o < lo ? (lo - o) * 4 : 0);
	const tables = findSm64AnimationTables(buf, seg, anims);
	let best: Sm64AnimationTable | null = null;
	for (const t of tables) if (!best || distance(t.offset) < distance(best.offset)) best = t;
	if (best) return best.animations.flatMap((animation, index) => (animation ? [{ index, animation }] : []));
	const a = anims.reduce((x, y) => (distance(y.offset) < distance(x.offset) ? y : x));
	return [{ index: 0, animation: a }];
}

/** Mario's animation DMA table: ROM offset of the table and its entries. */
export interface Sm64MarioAnimationTable {
	offset: number;
	entries: { offset: number; size: number }[];
}

let marioTableCache: WeakMap<Uint8Array, Sm64MarioAnimationTable | null> | undefined;

export function findSm64MarioAnimationTable(rom: Uint8Array): Sm64MarioAnimationTable | null {
	marioTableCache ??= new WeakMap();
	if (marioTableCache.has(rom)) return marioTableCache.get(rom)!;
	let found: Sm64MarioAnimationTable | null = null;
	for (let t = 0; t + 16 <= rom.length && !found; t += 4) {
		const count = u32(rom, t);
		if (count < 150 || count > 400) continue;
		if (u32(rom, t + 8) !== 8 + count * 8) continue;
		let ok = true;
		for (let i = 1; i < 8 && ok; i++) if (u32(rom, t + 8 + i * 8) <= u32(rom, t + 8 + (i - 1) * 8)) ok = false;
		if (!ok) continue;
		const entries: { offset: number; size: number }[] = [];
		for (let i = 0; i < count; i++) entries.push({ offset: t + u32(rom, t + 8 + i * 8), size: u32(rom, t + 12 + i * 8) });
		if (entries.every((e) => e.offset + e.size <= rom.length)) found = { offset: t, entries };
	}
	marioTableCache.set(rom, found);
	return found;
}

/** Entry `id` of Mario's animation table (`mario_animation_ids.h`), or null. */
export function readSm64MarioAnimation(rom: Uint8Array, table: Sm64MarioAnimationTable, id: number, parts: number, frame = 0): Sm64Animation | null {
	const e = table.entries[id];
	if (!e || e.size < 0x18) return null;
	const entry = rom.subarray(e.offset, e.offset + e.size);
	return readAnimation(entry, 0, parts, (p) => (p < e.size ? p : null), frame);
}

/** Mario's animation DMA table: sampled animation `id` (default the head-left idle, 0xC3). */
export function findSm64MarioAnimation(rom: Uint8Array, parts: number, id = 0xc3, frame = 0): Sm64Animation | null {
	const table = findSm64MarioAnimationTable(rom);
	return table ? readSm64MarioAnimation(rom, table, id, parts, frame) : null;
}

/** mtxf_rotate_xyz_and_translate (row-vector, translation in row 3). */
export function sm64RotateTranslate(rx: number, ry: number, rz: number, tx: number, ty: number, tz: number): Float32Array {
	const a = (v: number) => (v / 32768) * Math.PI;
	const sx = Math.sin(a(rx)), cx = Math.cos(a(rx)), sy = Math.sin(a(ry)), cy = Math.cos(a(ry)), sz = Math.sin(a(rz)), cz = Math.cos(a(rz));
	return Float32Array.from([
		cy * cz, cy * sz, -sy, 0,
		sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy, 0,
		cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy, 0,
		tx, ty, tz, 1,
	]);
}

/** The animation whose header is nearest `offset`. */
export function nearestSm64Animation(anims: Sm64Animation[], offset: number): Sm64Animation | null {
	let best: Sm64Animation | null = null;
	for (const a of anims) if (!best || Math.abs(a.offset - offset) < Math.abs(best.offset - offset)) best = a;
	return best;
}
