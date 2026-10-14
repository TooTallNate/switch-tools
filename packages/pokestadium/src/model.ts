/**
 * Pokémon Stadium 2 models: geo layouts + F3DEX2 display lists inside a
 * FRAGMENT module (see `fragment.ts`), flattened to bind-posed,
 * textured triangle primitives.
 *
 * ## Root
 * A Pokémon module's root struct is `u16 species, …, +0x08 → geo-layout
 * pointer list, +0x0C → animations, +0x10 → auxiliary (texture)
 * animations`; the first layout is the model. Arena modules return their
 * layout directly.
 *
 * ## Geo layout
 * A byte-coded command stream (sizes in {@link CMD_SIZES}):
 *
 *   00/03  call sub-layout          01/04  return      02  jump
 *   05     push joint               06     pop
 *   17     texture / TLUT tables (+ vertex count)
 *   1C     root scale (3 × s32 / 65536)
 *   1D     joint: id, channel, s16 translation, s16 binary-angle rotation,
 *          s32/65536 scale
 *   1F     static transform (arenas): degrees, percent scale
 *   22     draw display list            1E  draw for a named joint
 *   20/21  draw (pointer at +0x10 / +0x0C)
 *   23     select material: texture, TLUT, material DL, texture animation,
 *          node RGBA
 *
 * The joint a draw binds to is the entry *below* the top of the joint
 * stack (the importer's `curBone`). Joints compose as
 * `parent · [Rz·Ry·Rx | t · parentScale]` with scale accumulated
 * separately (`build.lua`'s `bindMatrices`).
 *
 * ## Display lists
 * F3DEX2: `G_VTX` loads 16-byte vertices into a 64-entry cache that
 * persists across lists and joints (later lists reuse vertices the
 * torso loaded), each tagged with the joint current at load time;
 * `G_GEOMETRYMODE` and `gSPTexture` state also persist. The last three
 * vertex bytes are signed normals in ordinary geometry and RGB in
 * pre-lit / effect geometry; `G_LIGHTING` doesn't tell them apart in
 * this game, so each primitive is classified by its normal lengths.
 *
 * Not modelled: fragment26 callback effects (flames, generated slime
 * materials, phase-5 arena state) and animation playback.
 *
 * Source: gen1recomp-mod-stadium2-importer (Deftones565), `lib/fragment.lua`,
 * `lib/build.lua`, `lib/sampler.lua`, `lib/vertex_semantics.lua`.
 */

import { findModelRoot, findStageRoot, isFragment, openFragment, type Fragment } from './fragment.js';
import { decodeStadiumTexture } from './texture.js';

export const CMD_SIZES: Readonly<Record<number, number>> = {
	0x00: 8, 0x01: 4, 0x02: 8, 0x03: 8, 0x04: 4, 0x05: 4, 0x06: 4, 0x07: 8,
	0x08: 12, 0x09: 4, 0x0a: 8, 0x0b: 0x18, 0x0c: 4, 0x0d: 4, 0x0e: 4, 0x0f: 4,
	0x10: 4, 0x11: 4, 0x12: 4, 0x13: 8, 0x14: 12, 0x15: 12, 0x16: 4, 0x17: 0x14,
	0x18: 8, 0x19: 8, 0x1a: 4, 0x1b: 0x10, 0x1c: 0x10, 0x1d: 0x1c, 0x1e: 8, 0x1f: 0x18,
	0x20: 0x14, 0x21: 0x10, 0x22: 8, 0x23: 0x10, 0x24: 4, 0x25: 4, 0x26: 0x14,
	0x28: 4, 0x29: 4,
};

export type StadiumWrap = 'repeat' | 'clamp' | 'mirror';

export interface StadiumBone {
	parent: number;
	id: number;
	translation: [number, number, number];
	/** s16 binary angles (65536 = full turn), applied Z·Y·X. */
	rotation: [number, number, number];
	scale: [number, number, number];
}

export interface StadiumTexture {
	width: number;
	height: number;
	/** RGBA8, rows top-down (V = 0 at the top). */
	rgba: Uint8Array;
	wrapS: StadiumWrap;
	wrapT: StadiumWrap;
	alpha: 'opaque' | 'cutout' | 'blend';
}

export interface StadiumPrimitive {
	/** Index into {@link StadiumModel.textures}, or -1 (untextured). */
	texture: number;
	/** Bind-posed positions (root scale applied). */
	positions: Float32Array;
	/** UVs in texture space (V = 0 at the top). */
	uvs: Float32Array;
	/** Unit normals when the vertices carry them. */
	normals: Float32Array | null;
	/** RGBA8 vertex colours when the vertices carry colour instead. */
	colors: Uint8Array | null;
	indices: Uint32Array;
	/** The joint each vertex is skinned to (-1: none). */
	joints: Int16Array;
}

export interface StadiumModel {
	kind: 'pokemon' | 'stage';
	/** The module's species / record id (0 for arenas). */
	species: number;
	bones: StadiumBone[];
	/** Joint origins in the bind pose (root scale applied), for print supports. */
	jointPositions: Float32Array;
	rootScale: [number, number, number];
	textures: StadiumTexture[];
	primitives: StadiumPrimitive[];
	/** Skeletal animations the module references. */
	animationCount: number;
	warnings: string[];
}

const u8 = (b: Uint8Array, o: number) => (o >= 0 && o < b.length ? b[o]! : 0);
const s8 = (b: Uint8Array, o: number) => (u8(b, o) << 24) >> 24;
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;
const s32 = (b: Uint8Array, o: number) => u32(b, o) | 0;

interface TexRec { fmt: number; siz: number; width: number; height: number; data: number | null }
interface TlutRec { data: number | null }
interface Vtx { x: number; y: number; z: number; s: number; t: number; n0: number; n1: number; n2: number; a: number; bone: number }
interface Prim {
	tex: number; tlut: number; mat: number | null; scaleS: number; scaleT: number;
	verts: Vtx[]; remap: Map<string, number>; tris: number[];
}

type Mat34 = number[]; // row-major 3×4

function rotationBasis(r: readonly number[]): number[] {
	const ang = (v: number) => (v / 32768) * Math.PI;
	const sx = Math.sin(ang(r[0]!)), cx = Math.cos(ang(r[0]!));
	const sy = Math.sin(ang(r[1]!)), cy = Math.cos(ang(r[1]!));
	const sz = Math.sin(ang(r[2]!)), cz = Math.cos(ang(r[2]!));
	return [
		cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
		cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
		-sy, sx * cy, cx * cy,
	];
}

function mul34(a: Mat34, b: Mat34): Mat34 {
	const o = new Array(12);
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 4; c++) {
			o[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]! + (c === 3 ? a[r * 4 + 3]! : 0);
		}
	}
	return o;
}

/** Bind-pose draw matrices (scale folded in) and pivots (rotation + translation) per joint. */
export function stadiumBindMatrices(bones: readonly StadiumBone[]): { draw: Mat34[]; pivot: Mat34[] } {
	const IDENT: Mat34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
	const pivot: Mat34[] = [], draw: Mat34[] = [], acc: number[][] = [];
	for (let i = 0; i < bones.length; i++) {
		const b = bones[i]!;
		const pa = b.parent >= 0 && acc[b.parent] ? acc[b.parent]! : [1, 1, 1];
		const pm = b.parent >= 0 && pivot[b.parent] ? pivot[b.parent]! : IDENT;
		const r = rotationBasis(b.rotation);
		const m = mul34(pm, [
			r[0]!, r[1]!, r[2]!, b.translation[0] * pa[0]!,
			r[3]!, r[4]!, r[5]!, b.translation[1] * pa[1]!,
			r[6]!, r[7]!, r[8]!, b.translation[2] * pa[2]!,
		]);
		const a = [pa[0]! * b.scale[0], pa[1]! * b.scale[1], pa[2]! * b.scale[2]];
		acc[i] = a;
		pivot[i] = m;
		draw[i] = [
			m[0]! * a[0]!, m[1]! * a[1]!, m[2]! * a[2]!, m[3]!,
			m[4]! * a[0]!, m[5]! * a[1]!, m[6]! * a[2]!, m[7]!,
			m[8]! * a[0]!, m[9]! * a[1]!, m[10]! * a[2]!, m[11]!,
		];
	}
	return { draw, pivot };
}

/** N64 tile shift: 1–10 divide by 2ⁿ, 11–15 multiply by 2^(16−n). */
const shiftFactor = (v: number) => ((v & 15) <= 10 ? 1 / 2 ** (v & 15) : 2 ** (16 - (v & 15)));

type WrapMode = 'repeat' | 'clamp' | 'mirror' | 'mirror-clamp';
const wrapOf = (cm: number): WrapMode => ((cm & 3) === 3 ? 'mirror-clamp' : cm & 2 ? 'clamp' : cm & 1 ? 'mirror' : 'repeat');

interface Sampler { wrapS: WrapMode; wrapT: WrapMode; shiftS: number; shiftT: number; palette: number }

class Builder {
	readonly d: Uint8Array;
	readonly base: number;
	readonly stage: boolean;
	textures: TexRec[] = [];
	tluts: TlutRec[] = [];
	bones: StadiumBone[] = [];
	boneById = new Map<number, number>();
	futureBoneById = new Map<number, number>();
	stack: number[] = [-1];
	vbuf: (Vtx | undefined)[] = new Array(64);
	geometryMode = 0x20400; // G_LIGHTING | G_CULL_BACK
	scaleS = 1;
	scaleT = 1;
	curTex = -1;
	curTlut = -1;
	curMat: number | null = null;
	rootScale: [number, number, number] = [1, 1, 1];
	prims = new Map<string, Prim>();
	order: Prim[] = [];
	warnings: string[] = [];
	steps = 0;

	constructor(f: Fragment, stage: boolean) {
		this.d = f.data;
		this.base = f.base;
		this.stage = stage;
	}

	off(ptr: number): number | null {
		if (ptr === 0) return null;
		const o = ptr - this.base;
		return o >= 0 && o < this.d.length ? o : null;
	}
	ptr(o: number): number | null {
		return this.off(u32(this.d, o));
	}
	curBone(): number {
		const n = this.stack.length;
		return n >= 2 ? this.stack[n - 2]! : -1;
	}

	readTextureTable(off: number | null, count: number): void {
		if (off === null) return;
		for (let i = 0; i < count && off + i * 12 + 12 <= this.d.length; i++) {
			const o = off + i * 12;
			this.textures.push({ fmt: u8(this.d, o), siz: u8(this.d, o + 1), width: s16(this.d, o + 2), height: u16(this.d, o + 4), data: this.ptr(o + 8) });
		}
	}
	readTlutTable(off: number | null, count: number): void {
		if (off === null) return;
		for (let i = 0; i < count && off + i * 12 + 12 <= this.d.length; i++) {
			const o = off + i * 12;
			let data = this.ptr(o + 4);
			let dl = this.ptr(o + 8);
			if (dl !== null) {
				for (let k = 0; k < 16; k++, dl += 8) {
					const op = u8(this.d, dl);
					if (op === 0xfd) data = this.off(u32(this.d, dl + 4));
					else if (op === 0xdf) break;
				}
			}
			this.tluts.push({ data });
		}
	}

	prescan(o: number | null, depth = 0): void {
		let count = 0;
		const scan = (at: number | null, dep: number) => {
			if (dep > 32 || at === null) return;
			for (let guard = 0; guard < 100000; guard++) {
				const cmd = u8(this.d, at);
				const size = CMD_SIZES[cmd];
				if (size === undefined || cmd === 0x01 || cmd === 0x04) return;
				if (cmd === 0x00 || cmd === 0x03) scan(this.ptr(at + 4), dep + 1);
				else if (cmd === 0x02) {
					at = this.ptr(at + 4);
					if (at === null) return;
					continue;
				} else if (cmd === 0x1d) {
					const id = u8(this.d, at + 1);
					if (!this.futureBoneById.has(id)) this.futureBoneById.set(id, count);
					count++;
				} else if (cmd === 0x1f && this.stage) count++;
				at += size;
			}
		};
		scan(o, depth);
	}

	walk(o: number | null, depth: number): void {
		if (depth > 32 || o === null) return;
		const d = this.d;
		for (let guard = 0; guard < 100000; guard++) {
			const cmd = u8(d, o);
			const size = CMD_SIZES[cmd];
			if (size === undefined) {
				this.warnings.push(`unknown geo command 0x${cmd.toString(16)} at 0x${o.toString(16)}`);
				return;
			}
			switch (cmd) {
				case 0x01:
				case 0x04:
					return;
				case 0x00:
				case 0x03:
					this.walk(this.ptr(o + 4), depth + 1);
					break;
				case 0x02: {
					const next = this.ptr(o + 4);
					if (next === null) return;
					o = next;
					continue;
				}
				case 0x05:
					this.stack.push(this.stack[this.stack.length - 1]!);
					break;
				case 0x06:
					this.stack.pop();
					break;
				case 0x17:
					this.readTextureTable(this.ptr(o + 8), s16(d, o + 2));
					this.readTlutTable(this.ptr(o + 0xc), s16(d, o + 4));
					break;
				case 0x1c:
					this.rootScale = [s32(d, o + 4) / 65536, s32(d, o + 8) / 65536, s32(d, o + 0xc) / 65536];
					break;
				case 0x1d: {
					const idx = this.bones.length;
					this.bones.push({
						parent: this.curBone(),
						id: u8(d, o + 1),
						translation: [s16(d, o + 4), s16(d, o + 6), s16(d, o + 8)],
						rotation: [s16(d, o + 0xa), s16(d, o + 0xc), s16(d, o + 0xe)],
						scale: [s32(d, o + 0x10) / 65536, s32(d, o + 0x14) / 65536, s32(d, o + 0x18) / 65536],
					});
					this.boneById.set(u8(d, o + 1), idx);
					this.stack[this.stack.length - 1] = idx;
					break;
				}
				case 0x1f:
					if (this.stage) {
						// Degrees (truncated to binary angles) and percent scale (geo_layout.c func_80018600).
						const angle = (deg: number) => (Math.trunc((deg * 65536) / 360) << 16) >> 16;
						const idx = this.bones.length;
						this.bones.push({
							parent: this.curBone(),
							id: 0x100 + idx,
							translation: [s16(d, o + 0xa), s16(d, o + 0xc), s16(d, o + 0xe)],
							rotation: [angle(s16(d, o + 4)), angle(s16(d, o + 6)), angle(s16(d, o + 8))],
							scale: [s16(d, o + 0x10) / 100, s16(d, o + 0x12) / 100, s16(d, o + 0x14) / 100],
						});
						this.stack[this.stack.length - 1] = idx;
					}
					break;
				case 0x23:
					this.curTex = s16(d, o + 8);
					this.curTlut = s16(d, o + 0xa);
					this.curMat = this.ptr(o + 4);
					break;
				case 0x22:
					this.runDL(this.ptr(o + 4), this.curBone(), 0);
					break;
				case 0x1e: {
					// The game builds the whole graph before drawing, so a named
					// draw can refer to a joint defined later in the layout.
					const id = s16(d, o + 2);
					const named = this.boneById.get(id) ?? this.futureBoneById.get(id);
					this.runDL(this.ptr(o + 4), named ?? this.curBone(), 0);
					break;
				}
				case 0x20:
				case 0x21:
					this.runDL(this.ptr(o + (cmd === 0x20 ? 0x10 : 0xc)), this.curBone(), 0);
					break;
			}
			o += size;
		}
	}

	prim(): Prim {
		const key = `${this.curTex},${this.curTlut},${this.curMat},${this.scaleS},${this.scaleT}`;
		let p = this.prims.get(key);
		if (!p) {
			p = { tex: this.curTex, tlut: this.curTlut, mat: this.curMat, scaleS: this.scaleS, scaleT: this.scaleT, verts: [], remap: new Map(), tris: [] };
			this.prims.set(key, p);
			this.order.push(p);
		}
		return p;
	}

	emit(p: Prim, flip: boolean, a: number, b: number, c: number): void {
		const tri: number[] = [];
		for (const i of [a, b, c]) {
			const v = this.vbuf[i];
			if (!v) return;
			const key = `${v.x},${v.y},${v.z},${v.s},${v.t},${v.n0},${v.n1},${v.n2},${v.a},${v.bone}`;
			let j = p.remap.get(key);
			if (j === undefined) {
				j = p.verts.length;
				p.remap.set(key, j);
				p.verts.push(v);
			}
			tri.push(j);
		}
		if (flip) p.tris.push(tri[2]!, tri[1]!, tri[0]!);
		else p.tris.push(tri[0]!, tri[1]!, tri[2]!);
	}

	runDL(o: number | null, bone: number, depth: number): void {
		if (o === null || depth > 8) return;
		const d = this.d;
		for (let steps = 0; steps < 4096 && o + 8 <= d.length; steps++) {
			if (++this.steps > 2_000_000) return;
			const w0 = u32(d, o), w1 = u32(d, o + 4);
			const op = w0 >>> 24;
			o += 8;
			if (op === 0xdf) return;
			if (op === 0xde) {
				this.runDL(this.off(w1), bone, depth + 1);
				if (((w0 >>> 16) & 0xff) !== 0) return; // branch, no return
			} else if (op === 0x01) {
				const n = (w0 >>> 12) & 0xff;
				const v0 = ((w0 & 0xfff) >> 1) - n;
				const a = this.off(w1);
				if (a === null) {
					this.warnings.push(`vertex pointer 0x${w1.toString(16)} is outside the module`);
					continue;
				}
				const count = Math.min(n, Math.floor((d.length - a) / 16));
				for (let i = 0; i < count; i++) {
					const p = a + i * 16, slot = v0 + i;
					if (slot < 0 || slot >= 64) continue;
					this.vbuf[slot] = { x: s16(d, p), y: s16(d, p + 2), z: s16(d, p + 4), s: s16(d, p + 8), t: s16(d, p + 10), n0: s8(d, p + 12), n1: s8(d, p + 13), n2: s8(d, p + 14), a: u8(d, p + 15), bone };
				}
			} else if (op === 0xd9) {
				this.geometryMode = ((this.geometryMode & (w0 & 0xffffff)) | (w1 & 0xffffff)) >>> 0;
			} else if (op === 0xd7) {
				this.scaleS = (w1 >>> 16) / 65536;
				this.scaleT = (w1 & 0xffff) / 65536;
			} else if (op === 0x05 || op === 0x06) {
				const gm = this.geometryMode;
				const flip = (gm & 0x200) !== 0 && (gm & 0x400) === 0; // cull front only
				const p = this.prim();
				this.emit(p, flip, ((w0 >>> 16) & 0xff) >> 1, ((w0 >>> 8) & 0xff) >> 1, (w0 & 0xff) >> 1);
				if (op === 0x06) this.emit(p, flip, ((w1 >>> 16) & 0xff) >> 1, ((w1 >>> 8) & 0xff) >> 1, (w1 & 0xff) >> 1);
			}
		}
	}

	/** Render-tile (tile 0) sampler from a material display list. */
	sampler(mat: number | null): Sampler {
		const s: Sampler = { wrapS: 'repeat', wrapT: 'repeat', shiftS: 0, shiftT: 0, palette: 0 };
		if (mat === null) return s;
		for (let k = 0, o = mat; k < 16 && o + 8 <= this.d.length; k++, o += 8) {
			const w0 = u32(this.d, o), w1 = u32(this.d, o + 4);
			const op = w0 >>> 24;
			if (op === 0xf5 && ((w1 >>> 24) & 7) === 0) {
				s.palette = (w1 >>> 20) & 15;
				s.wrapT = wrapOf((w1 >>> 18) & 3);
				s.wrapS = wrapOf((w1 >>> 8) & 3);
				s.shiftT = (w1 >>> 10) & 15;
				s.shiftS = w1 & 15;
			} else if (op === 0xdf) break;
		}
		return s;
	}
}

/** Normals when most of a primitive's vertices carry unit-length (≈119/127) vectors. */
function carriesNormals(verts: readonly Vtx[]): boolean {
	let hits = 0;
	for (const v of verts) {
		const len = Math.hypot(v.n0, v.n1, v.n2) / 127;
		if (len >= 0.85 && len <= 1.05) hits++;
	}
	return verts.length > 0 && hits / verts.length >= 0.5;
}

function alphaMode(rgba: Uint8Array): StadiumTexture['alpha'] {
	let cut = false;
	for (let i = 3; i < rgba.length; i += 4) {
		const a = rgba[i]!;
		if (a > 0 && a < 255) return 'blend';
		if (a === 0) cut = true;
	}
	return cut ? 'cutout' : 'opaque';
}

/** Append a mirrored copy along one axis (for mirror-then-clamp sampling). */
function mirrorExtend(rgba: Uint8Array, w: number, h: number, axis: 'x' | 'y'): { rgba: Uint8Array; w: number; h: number } {
	const W = axis === 'x' ? w * 2 : w, H = axis === 'y' ? h * 2 : h;
	const out = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const sx = axis === 'x' && x >= w ? 2 * w - 1 - x : x;
			const sy = axis === 'y' && y >= h ? 2 * h - 1 - y : y;
			out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * W + x) * 4);
		}
	}
	return { rgba: out, w: W, h: H };
}

export interface BuildStadiumModelOptions {
	/** Treat the module as an arena (root from the entry stub, static transforms). */
	stage?: boolean;
}

/**
 * Build a model from a decompressed FRAGMENT. Throws when the bytes
 * aren't a model module.
 */
export function buildStadiumModel(module: Uint8Array, options: BuildStadiumModelOptions = {}): StadiumModel {
	if (!isFragment(module)) throw new Error('Not a FRAGMENT module');
	const stage = !!options.stage;
	const rootAddr = stage ? findStageRoot(module) : findModelRoot(module);
	if (rootAddr === null) throw new Error(stage ? 'Unrecognised arena entry point' : 'Could not locate the model root');
	const frag = openFragment(module, rootAddr);
	const b = new Builder(frag, stage);
	const d = frag.data;
	const root = rootAddr - frag.base;
	if (root < 0 || root + 0x14 > d.length) throw new Error('Model root is outside the module');

	let layout: number | null;
	let species = 0;
	let animationCount = 0;
	if (stage) {
		layout = root;
	} else {
		species = u16(d, root);
		const list = b.ptr(root + 8);
		layout = list === null ? null : b.ptr(list);
		const anims = b.ptr(root + 0xc);
		if (anims !== null) while (animationCount < 4096 && b.ptr(anims + animationCount * 4) !== null) animationCount++;
	}
	if (layout === null) throw new Error('Model has no geo layout');
	b.prescan(layout);
	b.walk(layout, 0);

	const { draw, pivot } = stadiumBindMatrices(b.bones);
	const [rx, ry, rz] = b.rootScale;
	const textures: StadiumTexture[] = [];
	const texSlots = new Map<string, { slot: number; uMul: number; vMul: number }>();
	const textureFor = (p: Prim, smp: Sampler) => {
		const src = b.textures[p.tex];
		if (!src || src.width <= 0 || src.height <= 0) return null;
		const key = `${p.tex},${p.tlut},${smp.palette},${smp.wrapS},${smp.wrapT}`;
		const hit = texSlots.get(key);
		if (hit) return hit;
		const tlut = p.tlut >= 0 ? (b.tluts[p.tlut]?.data ?? null) : null;
		let rgba = decodeStadiumTexture(d, src, tlut, smp.palette);
		let w = src.width, h = src.height, uMul = 1, vMul = 1;
		if (smp.wrapS === 'mirror-clamp') {
			({ rgba, w, h } = mirrorExtend(rgba, w, h, 'x'));
			uMul = 0.5;
		}
		if (smp.wrapT === 'mirror-clamp') {
			({ rgba, w, h } = mirrorExtend(rgba, w, h, 'y'));
			vMul = 0.5;
		}
		const wrap = (m: WrapMode): StadiumWrap => (m === 'mirror-clamp' ? 'clamp' : m);
		const slot = textures.length;
		textures.push({ width: w, height: h, rgba, wrapS: wrap(smp.wrapS), wrapT: wrap(smp.wrapT), alpha: alphaMode(rgba) });
		const out = { slot, uMul, vMul };
		texSlots.set(key, out);
		return out;
	};

	const primitives: StadiumPrimitive[] = [];
	for (const p of b.order) {
		if (p.tris.length === 0) continue;
		const smp = b.sampler(p.mat);
		const tex = textureFor(p, smp);
		const src = b.textures[p.tex];
		const n = p.verts.length;
		const positions = new Float32Array(n * 3);
		const uvs = new Float32Array(n * 2);
		const lit = carriesNormals(p.verts);
		const normals = lit ? new Float32Array(n * 3) : null;
		const colors = lit ? null : new Uint8Array(n * 4);
		const joints = new Int16Array(n);
		const us = p.scaleS * shiftFactor(smp.shiftS) * (tex?.uMul ?? 1);
		const vs = p.scaleT * shiftFactor(smp.shiftT) * (tex?.vMul ?? 1);
		const tw = src?.width || 32, th = src?.height || 32;
		p.verts.forEach((v, i) => {
			const m = v.bone >= 0 ? draw[v.bone] : undefined;
			const x = m ? m[0]! * v.x + m[1]! * v.y + m[2]! * v.z + m[3]! : v.x;
			const y = m ? m[4]! * v.x + m[5]! * v.y + m[6]! * v.z + m[7]! : v.y;
			const z = m ? m[8]! * v.x + m[9]! * v.y + m[10]! * v.z + m[11]! : v.z;
			positions[i * 3] = x * rx;
			positions[i * 3 + 1] = y * ry;
			positions[i * 3 + 2] = z * rz;
			uvs[i * 2] = (v.s / 32 / tw) * us;
			uvs[i * 2 + 1] = (v.t / 32 / th) * vs;
			joints[i] = v.bone;
			if (normals) {
				const r = v.bone >= 0 ? pivot[v.bone] : undefined;
				const nx = v.n0 / 127, ny = v.n1 / 127, nz = v.n2 / 127;
				let ox = r ? r[0]! * nx + r[1]! * ny + r[2]! * nz : nx;
				let oy = r ? r[4]! * nx + r[5]! * ny + r[6]! * nz : ny;
				let oz = r ? r[8]! * nx + r[9]! * ny + r[10]! * nz : nz;
				const len = Math.hypot(ox, oy, oz) || 1;
				ox /= len;
				oy /= len;
				oz /= len;
				normals[i * 3] = ox;
				normals[i * 3 + 1] = oy;
				normals[i * 3 + 2] = oz;
			} else {
				colors![i * 4] = v.n0 & 0xff;
				colors![i * 4 + 1] = v.n1 & 0xff;
				colors![i * 4 + 2] = v.n2 & 0xff;
				colors![i * 4 + 3] = v.a;
			}
		});
		primitives.push({ texture: tex?.slot ?? -1, positions, uvs, normals, colors, indices: Uint32Array.from(p.tris), joints });
	}

	const jointPositions = new Float32Array(b.bones.length * 3);
	for (let i = 0; i < b.bones.length; i++) {
		jointPositions[i * 3] = draw[i]![3]! * rx;
		jointPositions[i * 3 + 1] = draw[i]![7]! * ry;
		jointPositions[i * 3 + 2] = draw[i]![11]! * rz;
	}
	return {
		kind: stage ? 'stage' : 'pokemon',
		species,
		bones: b.bones,
		jointPositions,
		rootScale: b.rootScale,
		textures,
		primitives,
		animationCount,
		warnings: b.warnings.slice(0, 50),
	};
}
