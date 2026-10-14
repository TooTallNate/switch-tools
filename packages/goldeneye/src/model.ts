/**
 * GoldenEye 007 model files (characters `C…Z`, guns `G…Z`, props
 * `P…Z`), flattened to bind-posed triangle primitives.
 *
 * A model file is linked at a virtual base (segment 5, `0x05000000`):
 * the header's first word points at the root node, and every node /
 * record pointer is `base + file offset`. Nodes are
 *
 *   u16 opcode, u16 pad, data*, parent*, next*, prev*, child*   (0x18)
 *
 * The node kinds that matter for geometry (n64decomp/007 `bondtypes.h`,
 * `model.c`):
 *
 *   01 header        MatrixIndex at +2 (s16)
 *   02 group         f32 origin, MatrixID0 at +0xE
 *   15 group (simple) f32 origin, matrix index (Group1) at +0xC
 *   04 display list  primary*, secondary*, base, vertices*, u16 count
 *   16 display list  s32 count, vertices*, primary*
 *   18 display list  primary*, secondary*, vertices*, s16 count, …
 *   08 LOD           min / max distance, affected child
 *
 * The game computes `matrix[id] = parentMatrix · translate(origin)` for
 * each group (`process_15_subposition` and friends); animation adds
 * rotations, so the bind pose is pure translation. Display lists are
 * Rare's F3D variant: `G_MTX` selects a matrix through segment 3
 * (`id × 0x40`), `G_VTX` reads 16-byte vertices from segment 4 (the
 * node's vertex table) or 5 (the file), `G_TRI4` (0xB1) packs four
 * triangles of 4-bit indices, `G_SETTEX` (0xC0) names a texture from
 * the global image bank. Textures are not decoded here (they use
 * Rare's own image compression); UVs are kept for when they are.
 *
 * For LOD sets, only the nearest-range branch is drawn.
 */

export type GoldeneyeWrap = 'repeat' | 'clamp' | 'mirror';

export interface GoldeneyePrimitive {
	/** Global texture number from `G_SETTEX`, or -1. */
	textureId: number;
	/** `G_SETTEX` s/t modes (1 clamp, 2 mirror, else wrap; `texModeToGbiMode`). */
	wrapS: GoldeneyeWrap;
	wrapT: GoldeneyeWrap;
	positions: Float32Array;
	/** s/t in texels (10.5 fixed point divided out, `G_TEXTURE` scale applied). */
	texels: Float32Array;
	normals: Float32Array | null;
	/** RGBA8 vertex colours (unlit geometry). */
	colors: Uint8Array | null;
	indices: Uint32Array;
}

export interface GoldeneyeModel {
	primitives: GoldeneyePrimitive[];
	nodeCount: number;
	textureIds: number[];
	warnings: string[];
}

const u8 = (b: Uint8Array, o: number) => (o >= 0 && o < b.length ? b[o]! : 0);
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u8(b, o) << 24) | (u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3)) >>> 0;
const f32 = (b: Uint8Array, o: number) => {
	const dv = new DataView(new ArrayBuffer(4));
	dv.setUint32(0, u32(b, o));
	return dv.getFloat32(0);
};

const OP = { HEADER: 1, GROUP: 2, OP03: 3, DL: 4, LOD: 8, GROUPSIMPLE: 0x15, DLPRIMARY: 0x16, DLCOLLISION: 0x18 } as const;
const G_LIGHTING = 0x00020000;
const G_CULL_FRONT = 0x00001000;
const G_CULL_BACK = 0x00002000;

interface Vtx { x: number; y: number; z: number; s: number; t: number; c: [number, number, number, number]; lit: boolean }
interface Prim { tex: number; lit: boolean; ws: GoldeneyeWrap; wt: GoldeneyeWrap; verts: Vtx[]; remap: Map<string, number>; tris: number[] }

const wrapOf = (mode: number): GoldeneyeWrap => (mode === 1 ? 'clamp' : mode === 2 ? 'mirror' : 'repeat');

const MODEL_BASE = 0x05000000;

/** A plausible node at `o`: known opcode, in-file data, and in-file (or null) links. */
function isNodeAt(d: Uint8Array, o: number): boolean {
	if (o < 0 || o % 4 !== 0 || o + 0x18 > d.length) return false;
	const op = u16(d, o) & 0xff;
	if (op === 0 || op >= 0x19 || (u16(d, o) & 0xfc00) !== 0 || u16(d, o + 2) !== 0) return false;
	const inFile = (p: number, nullable: boolean) => (p === 0 ? nullable : p >>> 24 === 0x05 && (p & 0xffffff) < d.length && (p & 3) === 0);
	return inFile(u32(d, o + 4), false) && [8, 0xc, 0x10, 0x14].every((k) => inFile(u32(d, o + k), true));
}

/**
 * The model's top node. Files that start with a header point at it
 * (`RootNode`); others keep their header in the game's code tables,
 * so the top node is found structurally: the first node with no
 * parent and no previous sibling whose subtree reaches a display list.
 */
export function findGoldeneyeRoot(d: Uint8Array): number | null {
	const header = u32(d, 0);
	if (header >>> 24 === 0x05 && isNodeAt(d, header & 0xffffff)) {
		let top = header & 0xffffff;
		for (let g = 0; g < 1000 && u32(d, top + 8); g++) {
			const p = u32(d, top + 8) & 0xffffff;
			if (!isNodeAt(d, p)) break;
			top = p;
		}
		return top;
	}
	let best: number | null = null, bestCount = 0;
	for (let o = 0; o + 0x18 <= d.length; o += 4) {
		if (!isNodeAt(d, o) || u32(d, o + 8) !== 0 || u32(d, o + 0x10) !== 0) continue;
		// Count the subtree; it must be well-formed and draw something.
		let count = 0, draws = 0, ok = true;
		const stack = [o];
		const seen = new Set<number>();
		while (stack.length && ok && count < 4096) {
			const n = stack.pop()!;
			if (seen.has(n)) continue;
			seen.add(n);
			if (!isNodeAt(d, n)) {
				ok = false;
				break;
			}
			count++;
			const op = u16(d, n) & 0xff;
			if (op === 4 || op === 0x16 || op === 0x18) draws++;
			for (const k of [0xc, 0x14]) if (u32(d, n + k)) stack.push(u32(d, n + k) & 0xffffff);
		}
		if (ok && draws > 0 && count > bestCount) {
			best = o;
			bestCount = count;
		}
	}
	return best;
}

/** True when `bytes` holds a model node graph. */
export function isGoldeneyeModel(bytes: Uint8Array): boolean {
	return bytes.length >= 0x40 && findGoldeneyeRoot(bytes) !== null;
}

/** Build a model file's bind pose. Throws when the bytes aren't one. */
export function buildGoldeneyeModel(bytes: Uint8Array): GoldeneyeModel {
	const d = bytes;
	const root = findGoldeneyeRoot(d);
	if (root === null) throw new Error('Not a GoldenEye model file');
	const base = MODEL_BASE;
	const off = (p: number): number | null => {
		if (p === 0 || (p & 0xff000000) !== base) return null;
		const o = p - base;
		return o >= 0 && o < d.length ? o : null;
	};
	const warnings: string[] = [];

	const top = root;

	const matrices = new Map<number, [number, number, number]>();
	const nodeMatrix = new Map<number, number>();
	let nodeCount = 0;

	const ownMatrixIndex = (node: number): number | null => {
		const op = u16(d, node) & 0xff;
		const data = off(u32(d, node + 4));
		if (data === null) return null;
		if (op === OP.HEADER) return s16(d, data + 2);
		if (op === OP.GROUP || op === OP.OP03) return s16(d, data + 0xe);
		if (op === OP.GROUPSIMPLE) return s16(d, data + 0xc);
		return null;
	};
	/** modelFindNodeMtxIndex: the nearest ancestor-or-self that owns a matrix. */
	const findMatrixIndex = (node: number | null): number => {
		for (let n = node, g = 0; n !== null && g < 1000; n = off(u32(d, n + 8)), g++) {
			const idx = ownMatrixIndex(n);
			if (idx !== null) return idx;
		}
		return -1;
	};
	const translation = (idx: number): [number, number, number] => matrices.get(idx) ?? [0, 0, 0];

	const drawer = new RareListDrawer();
	const runDL = (dlAddr: number, vtxTable: number | null, nodeMtx: number) => {
		const start = off(dlAddr);
		if (start === null) return;
		drawer.draw(d, start, (addr) => {
			const seg = addr >>> 24;
			if (seg === 4) return vtxTable === null ? null : { buf: d, o: vtxTable + (addr & 0xffffff) };
			if (seg === 5) {
				const o = off(addr);
				return o === null ? null : { buf: d, o };
			}
			return null;
		}, (mtx) => translation(mtx < 0 ? nodeMtx : mtx), nodeMtx);
	};

	// Depth-first walk (child, then next), computing group matrices on the way down.
	const visit = (node: number | null, depth: number) => {
		for (let n = node, g = 0; n !== null && g < 4096; n = off(u32(d, n + 0xc)), g++) {
			if (depth > 64 || ++nodeCount > 20000) return;
			const op = u16(d, n) & 0xff;
			const data = off(u32(d, n + 4));
			const parent = off(u32(d, n + 8));
			if (data !== null && (op === OP.HEADER || op === OP.GROUP || op === OP.OP03 || op === OP.GROUPSIMPLE)) {
				const idx = ownMatrixIndex(n)!;
				const pIdx = parent === null ? -1 : findMatrixIndex(parent);
				const [px, py, pz] = pIdx >= 0 ? translation(pIdx) : [0, 0, 0];
				const origin: [number, number, number] = op === OP.HEADER ? [0, 0, 0] : [f32(d, data), f32(d, data + 4), f32(d, data + 8)];
				const at: [number, number, number] = [px + origin[0], py + origin[1], pz + origin[2]];
				if (idx >= 0 && !matrices.has(idx)) matrices.set(idx, at);
				// Joint groups flagged 0x100 / 0x200 also fill MatrixID1 / MatrixID2
				// (blend matrices for skinned joints); at rest they equal the joint's own.
				if (op === OP.GROUP || op === OP.OP03) {
					const flags = u16(d, n);
					for (const [bit, k] of [[0x100, 1], [0x200, 2]] as const) {
						const extra = s16(d, data + 0xe + k * 2);
						if (flags & bit && extra >= 0 && !matrices.has(extra)) matrices.set(extra, at);
					}
				}
				nodeMatrix.set(n, idx);
			}
			if (data !== null && (op === OP.DL || op === OP.DLPRIMARY || op === OP.DLCOLLISION)) {
				const m = findMatrixIndex(n);
				if (op === OP.DL) {
					const vtx = off(u32(d, data + 0xc));
					runDL(u32(d, data), vtx, m);
					if (u32(d, data + 4)) runDL(u32(d, data + 4), vtx, m);
				} else if (op === OP.DLCOLLISION) {
					const vtx = off(u32(d, data + 8));
					runDL(u32(d, data), vtx, m);
					if (u32(d, data + 4)) runDL(u32(d, data + 4), vtx, m);
				} else {
					runDL(u32(d, data + 8), off(u32(d, data + 4)), m);
				}
			}
			let child = off(u32(d, n + 0x14));
			if (op === OP.LOD && data !== null) {
				// Draw only the nearest LOD (switch-in distance 0) of a set.
				if (f32(d, data) > 0) child = null;
				else child = off(u32(d, data + 8)) ?? child;
			}
			if (child !== null) visit(child, depth + 1);
		}
	};
	visit(top, 0);

	const primitives = drawer.finish();
	return { primitives, nodeCount, textureIds: [...drawer.textureIds].sort((a, b) => a - b), warnings };
}

/**
 * Runs Rare F3D display lists (GoldenEye models and level rooms) into
 * de-duplicated primitives. `resolve` maps a segmented address to a
 * buffer and offset; `translate` gives the translation for a matrix
 * index (`G_MTX` through segment 3), or the default (`-1`).
 */
export class RareListDrawer {
	readonly textureIds = new Set<number>();
	private prims = new Map<string, Prim>();
	private order: Prim[] = [];

	private prim(tex: number, lit: boolean, ws: GoldeneyeWrap, wt: GoldeneyeWrap): Prim {
		const key = `${tex},${lit},${ws},${wt}`;
		let p = this.prims.get(key);
		if (!p) {
			p = { tex, lit, ws, wt, verts: [], remap: new Map(), tris: [] };
			this.prims.set(key, p);
			this.order.push(p);
		}
		return p;
	}

	draw(dl: Uint8Array, start: number, resolve: (addr: number) => { buf: Uint8Array; o: number } | null, translate: (mtx: number) => [number, number, number], initialMtx = -1): void {
		const cache: (Vtx | undefined)[] = new Array(16);
		let mtx = initialMtx;
		let geometryMode = 0;
		let tex = -1;
		let ws: GoldeneyeWrap = 'repeat', wt: GoldeneyeWrap = 'repeat';
		let scaleS = 1, scaleT = 1;
		const emit = (a: number, b: number, c: number) => {
			const vs = [cache[a], cache[b], cache[c]];
			if (!vs[0] || !vs[1] || !vs[2]) return;
			const p = this.prim(tex, vs[0].lit, ws, wt);
			const ids: number[] = [];
			for (const v of vs as Vtx[]) {
				const key = `${v.x},${v.y},${v.z},${v.s},${v.t},${v.c.join(',')}`;
				let j = p.remap.get(key);
				if (j === undefined) {
					j = p.verts.length;
					p.remap.set(key, j);
					p.verts.push(v);
				}
				ids.push(j);
			}
			if ((geometryMode & G_CULL_FRONT) && !(geometryMode & G_CULL_BACK)) p.tris.push(ids[2]!, ids[1]!, ids[0]!);
			else p.tris.push(ids[0]!, ids[1]!, ids[2]!);
		};
		const run = (d: Uint8Array, start: number, depth: number) => {
			if (depth > 10) return;
			for (let o = start, steps = 0; o + 8 <= d.length && steps < 16384; o += 8, steps++) {
				const w0 = u32(d, o), w1 = u32(d, o + 4);
				switch (w0 >>> 24) {
					case 0xb8: // G_ENDDL
						return;
					case 0x06: { // G_DL
						const r = resolve(w1);
						if (r) run(r.buf, r.o, depth + 1);
						if ((w0 >>> 16) & 0xff) return; // branch
						break;
					}
					case 0x01: // G_MTX: segment 3 holds the runtime matrix array
						if (w1 >>> 24 === 3) mtx = (w1 & 0xffffff) >> 6;
						break;
					case 0x04: {
						// G_VTX (F3D): byte 1 = (n-1)<<4 | v0
						const n = ((w0 >>> 20) & 0xf) + 1;
						const v0 = (w0 >>> 16) & 0xf;
						const r = resolve(w1);
						if (!r) break;
						const [tx, ty, tz] = translate(mtx);
						const lit = (geometryMode & G_LIGHTING) !== 0;
						const vb = r.buf;
						for (let i = 0; i < n && v0 + i < 16; i++) {
							const p = r.o + i * 16;
							if (p + 16 > vb.length) break;
							cache[v0 + i] = {
								x: s16(vb, p) + tx, y: s16(vb, p + 2) + ty, z: s16(vb, p + 4) + tz,
								s: s16(vb, p + 8) * scaleS, t: s16(vb, p + 10) * scaleT,
								c: [u8(vb, p + 12), u8(vb, p + 13), u8(vb, p + 14), u8(vb, p + 15)],
								lit,
							};
						}
						break;
					}
					case 0xbf: // G_TRI1: indices ×10
						emit(((w1 >>> 16) & 0xff) / 10, ((w1 >>> 8) & 0xff) / 10, (w1 & 0xff) / 10);
						break;
					case 0xb1: // G_TRI4
						for (let i = 0; i < 4; i++) {
							const x = (w1 >>> (i * 8)) & 0xf, y = (w1 >>> (i * 8 + 4)) & 0xf, z = (w0 >>> (i * 4)) & 0xf;
							if (x === 0 && y === 0 && z === 0) continue;
							emit(x, y, z);
						}
						break;
					case 0xb7: // G_SETGEOMETRYMODE
						geometryMode = (geometryMode | w1) >>> 0;
						break;
					case 0xb6: // G_CLEARGEOMETRYMODE
						geometryMode = (geometryMode & ~w1) >>> 0;
						break;
					case 0xc0: // G_SETTEX: global texture number + tile modes
						tex = w1 & 0xfff;
						ws = wrapOf((w0 >>> 22) & 3);
						wt = wrapOf((w0 >>> 20) & 3);
						this.textureIds.add(tex);
						break;
					case 0xbb: {
						// G_TEXTURE: 0.16 s/t scale (0xFFFF ≈ 1)
						const ss = w1 >>> 16, st = w1 & 0xffff;
						scaleS = ss === 0xffff ? 1 : ss / 65536;
						scaleT = st === 0xffff ? 1 : st / 65536;
						break;
					}
				}
			}
		};
		run(dl, start, 0);
	}

	finish(): GoldeneyePrimitive[] {
		const primitives: GoldeneyePrimitive[] = [];
		for (const p of this.order) {
			if (p.tris.length === 0) continue;
			const n = p.verts.length;
			const positions = new Float32Array(n * 3);
			const texels = new Float32Array(n * 2);
			const normals = p.lit ? new Float32Array(n * 3) : null;
			const colors = p.lit ? null : new Uint8Array(n * 4);
			p.verts.forEach((v, i) => {
				positions.set([v.x, v.y, v.z], i * 3);
				texels.set([v.s / 32, v.t / 32], i * 2);
				if (normals) {
					const nx = (v.c[0] << 24) >> 24, ny = (v.c[1] << 24) >> 24, nz = (v.c[2] << 24) >> 24;
					const len = Math.hypot(nx, ny, nz) || 1;
					normals.set([nx / len, ny / len, nz / len], i * 3);
				} else colors!.set(v.c, i * 4);
			});
			primitives.push({ textureId: p.tex, wrapS: p.ws, wrapT: p.wt, positions, texels, normals, colors, indices: Uint32Array.from(p.tris) });
		}
		return primitives;
	}
}
