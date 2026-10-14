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
 * Actor data is laid out values, index, then the header, so the gap between
 * index and header gives the part count, which is how
 * {@link findSm64Animations} matches animations to a geo layout.
 *
 * Mario's animations are separate: a DMA table (`struct DmaTable`:
 * u32 count, u32 srcAddr, then (offset, size) pairs relative to the
 * table) whose entries each start with a header whose pointers are
 * offsets into that entry, laid out header, index, values
 * ({@link findSm64MarioAnimation}).
 */

const u16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u16(b, o) << 16) | u16(b, o + 2)) >>> 0;

export interface Sm64Animation {
	/** Header offset in its segment (or DMA entry). */
	offset: number;
	flags: number;
	/** Root translation channels then 3 rotations per part, at the sampled frame. */
	channels: Int16Array;
}

/** Sample frame `frame` of an animation whose header is at `header` in `buf`. */
function sample(buf: Uint8Array, header: number, values: number, index: number, parts: number, frame: number): Sm64Animation | null {
	const n = (parts + 1) * 3;
	const channels = new Int16Array(n);
	for (let k = 0; k < n; k++) {
		const max = u16(buf, index + k * 4), off = u16(buf, index + k * 4 + 2);
		const i = off + (frame < max ? frame : Math.max(0, max - 1));
		const at = values + i * 2;
		// Values precede the index in actor banks and follow it in Mario's entries.
		if (at + 2 > (values < index ? index : buf.length)) return null;
		channels[k] = s16(buf, at);
	}
	return { offset: header, flags: s16(buf, header), channels };
}

/**
 * Animations in segment `seg`'s bytes with exactly `parts` animated
 * parts, sampled at `frame` (default 0). An actor's geo layout, display
 * lists and animations sit together in its group bank, so callers
 * should prefer the one nearest the geo layout ({@link nearestSm64Animation}).
 */
export function findSm64Animations(buf: Uint8Array, seg: number, parts: number, frame = 0): Sm64Animation[] {
	const out: Sm64Animation[] = [];
	const tableBytes = (parts + 1) * 12;
	for (let o = 0; o + 0x18 <= buf.length; o += 4) {
		const values = u32(buf, o + 0x0c), index = u32(buf, o + 0x10);
		if (values >>> 24 !== seg || index >>> 24 !== seg) continue;
		const vo = values & 0xffffff, io = index & 0xffffff;
		if (vo >= io || io >= o) continue;
		const gap = o - io - tableBytes;
		if (gap < 0 || gap > 15) continue;
		const a = sample(buf, o, vo, io, parts, frame);
		if (a) out.push(a);
	}
	return out;
}

/** Mario's animation DMA table: sampled animation `id` (default the head-left idle, 0xC3). */
export function findSm64MarioAnimation(rom: Uint8Array, parts: number, id = 0xc3, frame = 0): Sm64Animation | null {
	for (let t = 0; t + 16 <= rom.length; t += 4) {
		const count = u32(rom, t);
		if (count < 150 || count > 400 || id >= count) continue;
		const first = u32(rom, t + 8);
		if (first !== 8 + count * 8) continue;
		let ok = true;
		for (let i = 1; i < 8 && ok; i++) if (u32(rom, t + 8 + i * 8) <= u32(rom, t + 8 + (i - 1) * 8)) ok = false;
		if (!ok) continue;
		const off = u32(rom, t + 8 + id * 8), size = u32(rom, t + 12 + id * 8);
		const base = t + off;
		if (size < 0x18 || base + size > rom.length) continue;
		const entry = rom.subarray(base, base + size);
		const values = u32(entry, 0x0c), index = u32(entry, 0x10);
		if (values >= size || index >= size || values === index) continue;
		const a = sample(entry, 0, values, index, parts, frame);
		if (a) return a;
	}
	return null;
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

/** The animation whose header is nearest `offset` (an actor's geo layout). */
export function nearestSm64Animation(anims: Sm64Animation[], offset: number): Sm64Animation | null {
	let best: Sm64Animation | null = null;
	for (const a of anims) if (!best || Math.abs(a.offset - offset) < Math.abs(best.offset - offset)) best = a;
	return best;
}
