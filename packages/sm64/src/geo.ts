/**
 * Super Mario 64 geo layouts (n64decomp/sm64 `include/geo_commands.h`,
 * `src/engine/geo_layout.c`), flattened to one mesh.
 *
 * A geo layout is a command stream that builds a scene graph: transform
 * nodes (translate / rotate / scale / animated part / billboard) may
 * carry a display list, `0x04` / `0x05` open and close the last node's
 * children, `0x00` / `0x02` / `0x03` / `0x01` branch, link, return and
 * end. Rotations are in degrees (`read_vec3s_angle`); animated parts
 * are drawn at rest (no animation). Switch nodes draw their first case.
 * Display lists are Fast3D (`f3d`); segments resolve through the
 * segment map the level script built.
 */

import { interpretDisplayList, mergeF3dexMeshes, type F3dexMesh } from '@tootallnate/f3dex';
import { sm64RotateTranslate, type Sm64Animation } from './anim.js';
import { Sm64SegmentCache, type Sm64SegmentMap } from './script.js';

const u8 = (b: Uint8Array, o: number) => b[o] ?? 0;
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;

type M = Float32Array;
const ident = (): M => {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
};
function mul(a: M, b: M): M {
	const o = new Float32Array(16);
	for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
		let v = 0;
		for (let k = 0; k < 4; k++) v += a[i * 4 + k]! * b[k * 4 + j]!;
		o[i * 4 + j] = v;
	}
	return o;
}
const translate = (x: number, y: number, z: number): M => {
	const m = ident();
	m[12] = x;
	m[13] = y;
	m[14] = z;
	return m;
};
const scale = (s: number): M => {
	const m = ident();
	m[0] = m[5] = m[10] = s;
	return m;
};
/** Row-vector rotation by degrees: `mtxf_rotate_zxy_and_translate` order (Z, then X, then Y). */
function rotate(rx: number, ry: number, rz: number): M {
	const r = (d: number, axis: 0 | 1 | 2) => {
		const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), m = ident();
		if (axis === 0) { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; }
		else if (axis === 1) { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; }
		else { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
		return m;
	};
	return mul(mul(r(rz, 2), r(rx, 0)), r(ry, 1));
}

export interface Sm64GeoMesh extends Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'alphas' | 'uvs' | 'indices' | 'groups' | 'materials' | 'usesLighting'> {
	/** Buffer the materials' texture offsets index into (all segments, concatenated). */
	data: Uint8Array;
	displayLists: number;
	/** Animated parts the layout processed. */
	animatedParts: number;
	/** Whether an animation posed them. */
	posed: boolean;
}

/** Lay every loaded segment out in one buffer; resolve segmented addresses into it. */
export function sm64SegmentBuffer(cache: Sm64SegmentCache, segments: Sm64SegmentMap): { data: Uint8Array; resolve: (addr: number) => number | null } {
	const bases = new Map<number, { base: number; len: number }>();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (const [seg, s] of segments) {
		const b = cache.get(s);
		if (!b) continue;
		bases.set(seg, { base: total, len: b.length });
		parts.push(b);
		total += b.length;
	}
	const data = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		data.set(p, o);
		o += p.length;
	}
	return {
		data,
		resolve: (addr) => {
			const b = bases.get(addr >>> 24);
			const off = addr & 0xffffff;
			return b && off < b.len ? b.base + off : null;
		},
	};
}

/** Build a geo layout (or, with `displayList`, a bare display list) into a mesh. */
export interface BuildSm64GeoOptions {
	cache?: Sm64SegmentCache;
	displayList?: boolean;
	/** Pose for the animated parts, given how many there are. */
	findAnimation?: (parts: number, segmentBytes: (seg: number) => Uint8Array | null) => Sm64Animation | null;
}

export function buildSm64Geo(rom: Uint8Array, segments: Sm64SegmentMap, geo: number, options: BuildSm64GeoOptions = {}): Sm64GeoMesh {
	const cache = options.cache ?? new Sm64SegmentCache(rom);
	const { data, resolve } = sm64SegmentBuffer(cache, segments);
	const parts: F3dexMesh[] = [];
	const draw = (dl: number, m: M) => {
		const start = resolve(dl);
		if (start === null) return;
		const mesh = interpretDisplayList(data, start, {
			microcode: 'f3d',
			resolveSegment: resolve,
			trustSegments: true,
			baseMatrix: m,
			maxCommands: 100000,
			// init_rsp: G_SHADE | G_SHADING_SMOOTH | G_CULL_BACK | G_LIGHTING.
			initialGeometryMode: 0x00022204,
		});
		if (mesh.indices.length) parts.push(mesh);
	};
	if (options.displayList) {
		draw(geo, ident());
		return { ...mergeF3dexMeshes(parts), data, displayLists: parts.length, animatedParts: 0, posed: false };
	}
	const segBytes = (seg: number) => {
		const s = segments.get(seg);
		return s ? cache.get(s) : null;
	};
	// Pass 1 counts animated parts; pass 2 draws, posed if an animation fits.
	const count = walk(null, null);
	const anim = count > 0 && options.findAnimation ? options.findAnimation(count, segBytes) : null;
	walk(draw, anim);
	return { ...mergeF3dexMeshes(parts), data, displayLists: parts.length, animatedParts: count, posed: anim !== null };

	function walk(drawFn: ((dl: number, m: M) => void) | null, animation: Sm64Animation | null): number {
	const draw = drawFn ?? (() => {});
	let animCursor = 3; // skip the root translation channels
	let animatedParts = 0;

	interface Frame { m: M; isSwitch: boolean; children: number; skip: boolean }
	const stack: Frame[] = [{ m: ident(), isSwitch: false, children: 0, skip: false }];
	let last: { m: M; isSwitch: boolean; skip: boolean } = { m: ident(), isSwitch: false, skip: false };
	const calls: number[] = [];
	let addr = geo, steps = 0;
	const top = () => stack[stack.length - 1]!;
	const node = (local: M | null, opts: { isSwitch?: boolean } = {}) => {
		const f = top();
		const idx = f.children++;
		const skip = f.skip || (f.isSwitch && idx > 0);
		const m = local ? mul(local, f.m) : f.m;
		last = { m, isSwitch: !!opts.isSwitch, skip };
		return last;
	};
	outer: for (;;) {
		const pos = resolve(addr);
		if (pos === null) break;
		let o = pos;
		for (;;) {
			if (++steps > 200000 || o + 4 > data.length) break outer;
			const cmd = u8(data, o), p = u8(data, o + 1);
			const at = (k: number) => o + k;
			switch (cmd) {
				case 0x00: // branch and link
					calls.push(addr + (o - pos) + 8);
					addr = u32(data, at(4));
					continue outer;
				case 0x01:
				case 0x03: {
					const ret = calls.pop();
					if (ret === undefined) break outer;
					addr = ret;
					continue outer;
				}
				case 0x02:
					if (p === 1) calls.push(addr + (o - pos) + 8);
					addr = u32(data, at(4));
					continue outer;
				case 0x04:
					stack.push({ m: last.m, isSwitch: last.isSwitch, children: 0, skip: last.skip });
					o += 4;
					continue;
				case 0x05:
					if (stack.length > 1) stack.pop();
					o += 4;
					continue;
				case 0x08: node(null); o += 12; continue;
				case 0x0a: node(null); o += p ? 12 : 8; continue;
				case 0x0b: case 0x0c: case 0x06: case 0x07: case 0x09: case 0x17: case 0x1b: case 0x20:
					if (cmd !== 0x06 && cmd !== 0x07 && cmd !== 0x1b) node(null);
					o += 4;
					continue;
				case 0x0d: case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1e:
					node(null);
					o += 8;
					continue;
				case 0x0e: node(null, { isSwitch: true }); o += 8; continue;
				case 0x0f: node(null); o += 20; continue;
				case 0x1c: node(translate(s16(data, at(2)), s16(data, at(4)), s16(data, at(6)))); o += 12; continue;
				case 0x1f: node(null); o += 16; continue;
				case 0x10: {
					const type = (p >> 4) & 7, hasDl = (p & 0x80) !== 0;
					let local: M, size: number;
					if (type === 0) {
						local = mul(rotate(s16(data, at(10)), s16(data, at(12)), s16(data, at(14))), translate(s16(data, at(4)), s16(data, at(6)), s16(data, at(8))));
						size = 16;
					} else if (type === 1) {
						local = translate(s16(data, at(2)), s16(data, at(4)), s16(data, at(6)));
						size = 8;
					} else if (type === 2) {
						local = rotate(s16(data, at(2)), s16(data, at(4)), s16(data, at(6)));
						size = 8;
					} else {
						local = rotate(0, s16(data, at(2)), 0);
						size = 4;
					}
					const n = node(local);
					if (hasDl && !n.skip) draw(u32(data, at(size)), n.m);
					o += size + (hasDl ? 4 : 0);
					continue;
				}
				case 0x11: case 0x12: case 0x14: {
					const hasDl = (p & 0x80) !== 0;
					const local = cmd === 0x12 ? rotate(s16(data, at(2)), s16(data, at(4)), s16(data, at(6))) : translate(s16(data, at(2)), s16(data, at(4)), s16(data, at(6)));
					const n = node(local);
					if (hasDl && !n.skip) draw(u32(data, at(8)), n.m);
					o += hasDl ? 12 : 8;
					continue;
				}
				case 0x13: {
					const tx = s16(data, at(2)), ty = s16(data, at(4)), tz = s16(data, at(6));
					let local = translate(tx, ty, tz);
					if (!top().skip && !(top().isSwitch && top().children > 0)) animatedParts++;
					if (animation && !top().skip) {
						const c = animation.channels;
						local = sm64RotateTranslate(c[animCursor] ?? 0, c[animCursor + 1] ?? 0, c[animCursor + 2] ?? 0, tx, ty, tz);
						animCursor += 3;
					}
					const n = node(local);
					const dl = u32(data, at(8));
					if (dl && !n.skip) draw(dl, n.m);
					o += 12;
					continue;
				}
				case 0x15: {
					const n = node(null);
					if (!n.skip) draw(u32(data, at(4)), n.m);
					o += 8;
					continue;
				}
				case 0x1d: {
					const hasDl = (p & 0x80) !== 0;
					const n = node(scale(u32(data, at(4)) / 65536));
					if (hasDl && !n.skip) draw(u32(data, at(8)), n.m);
					o += hasDl ? 12 : 8;
					continue;
				}
				default:
					break outer;
			}
		}
	}
	return animatedParts;
	}
}
