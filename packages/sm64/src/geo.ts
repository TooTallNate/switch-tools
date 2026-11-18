/**
 * Super Mario 64 geo layouts (n64decomp/sm64 `include/geo_commands.h`,
 * `src/engine/geo_layout.c`, `src/game/rendering_graph_node.c`).
 *
 * A geo layout is a command stream that builds a scene graph: transform
 * nodes (translate / rotate / scale / animated part / billboard) may
 * carry a display list, `0x04` / `0x05` open and close the last node's
 * children, `0x00` / `0x02` / `0x03` / `0x01` branch, link, return and
 * end. {@link parseSm64Geo} builds that graph once; {@link poseSm64Geo}
 * walks it the way `geo_process_node_and_siblings` does and lists the
 * display lists drawn with their matrices:
 *
 *  - Rotations in layout commands are degrees (`read_vec3s_angle`).
 *  - Animated parts (0x13) read one rotation per part from the animation,
 *    and the first also the root translation (`geo_process_animated_part`).
 *    Only parts that are drawn consume channels.
 *  - Switch nodes draw one case: 0 unless a caller picks another (the game
 *    picks at runtime from Mario's cap state, blinking, and so on).
 *  - Of sibling render ranges (level of detail) only the nearest draws,
 *    skipping ones drawn by code.
 *  - Billboards keep only the translation (`mtxf_billboard`): they face
 *    the camera, which for a still model means facing +Z, at scale 1
 *    whatever the scale nodes above them say.
 *
 * Display lists are Fast3D (`f3d`); segments resolve through the
 * segment map the level script built. {@link buildSm64Geo} interprets
 * each display list once in its node's space and places it, so
 * {@link Sm64GeoMesh.animator} can re-pose the same vertices per frame.
 */

import { interpretDisplayList, mergeF3dexMeshes, type F3dexMesh, type F3dexState } from '@tootallnate/f3dex';
import { sampleSm64Animation, sm64RootTranslation, sm64RotateTranslate, type Sm64Animation } from './anim.js';
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

/** Lay every loaded segment out in one buffer; resolve segmented addresses into it. */
export function sm64SegmentBuffer(cache: Sm64SegmentCache, segments: Sm64SegmentMap): { data: Uint8Array; resolve: (addr: number) => number | null } {
	return cache.buffer(segments);
}

/** One scene graph node. */
export interface Sm64GeoNode {
	/** Geo command (`geo_commands.h`), or -1 for the root that holds the top-level nodes. */
	cmd: number;
	/** Segmented address of the command. */
	addr: number;
	/** Render layer (`LAYER_*`) for nodes that draw. */
	layer: number;
	/** Display list drawn at this node. */
	dl: number | null;
	/** 0x10 / 0x11 / 0x13 / 0x14 / 0x1C translation. */
	translation: [number, number, number] | null;
	/** 0x10 / 0x12 rotation in degrees. */
	rotation: [number, number, number] | null;
	/** 0x1D scale. */
	scale: number | null;
	/** 0x0E switch / 0x18 ASM: the C function and its parameter. */
	fn: number | null;
	param: number;
	/** 0x0D render range (min, max distance). */
	range: [number, number] | null;
	children: Sm64GeoNode[];
}

const hasDisplayList = (n: Sm64GeoNode): boolean => n.dl !== null || n.children.some(hasDisplayList);

const newNode = (cmd: number, addr: number): Sm64GeoNode => ({ cmd, addr, layer: 0, dl: null, translation: null, rotation: null, scale: null, fn: null, param: 0, range: null, children: [] });

/** Parse the geo layout at segmented `geo` into its scene graph. */
export function parseSm64Geo(data: Uint8Array, resolve: (addr: number) => number | null, geo: number): Sm64GeoNode {
	const root = newNode(-1, geo);
	// `gCurGraphNodeList`: parents[i] is where level i's nodes go; `last` the
	// newest node at the current level (what an open node opens).
	const parents: Sm64GeoNode[] = [root];
	let last: Sm64GeoNode = root;
	const calls: { ret: number; depth?: number }[] = [];
	let addr = geo, steps = 0;
	const add = (n: Sm64GeoNode) => {
		parents[parents.length - 1]!.children.push(n);
		last = n;
		return n;
	};
	outer: for (;;) {
		const pos = resolve(addr);
		if (pos === null) break;
		let o = pos;
		for (;;) {
			if (++steps > 200000 || o + 4 > data.length) break outer;
			const cmd = u8(data, o), p = u8(data, o + 1);
			const at = (k: number) => o + k;
			const here = addr + (o - pos);
			const node = () => add(newNode(cmd, here));
			const vec = (k: number): [number, number, number] => [s16(data, at(k)), s16(data, at(k + 2)), s16(data, at(k + 4))];
			switch (cmd) {
				case 0x00: // branch and link
					calls.push({ ret: here + 8, depth: parents.length });
					addr = u32(data, at(4));
					continue outer;
				case 0x01:
				case 0x03: {
					const c = calls.pop();
					if (!c) break outer;
					if (cmd === 0x01 && c.depth !== undefined) parents.length = Math.max(1, Math.min(parents.length, c.depth));
					addr = c.ret;
					continue outer;
				}
				case 0x02:
					if (p === 1) calls.push({ ret: here + 8 });
					addr = u32(data, at(4));
					continue outer;
				case 0x04:
					parents.push(last);
					o += 4;
					continue;
				case 0x05:
					if (parents.length > 1) last = parents.pop()!;
					o += 4;
					continue;
				case 0x08: node(); o += 12; continue;
				case 0x0a: node(); o += p ? 12 : 8; continue;
				case 0x06: case 0x07: case 0x1b:
					o += 4;
					continue;
				case 0x09: case 0x0b: case 0x0c: case 0x17: case 0x20:
					node();
					o += 4;
					continue;
				case 0x0d: {
					const n = node();
					n.range = [s16(data, at(4)), s16(data, at(6))];
					o += 8;
					continue;
				}
				case 0x0e: case 0x18: {
					const n = node();
					n.param = s16(data, at(2));
					n.fn = u32(data, at(4));
					o += 8;
					continue;
				}
				case 0x16: case 0x19: case 0x1a: case 0x1e:
					node();
					o += 8;
					continue;
				case 0x0f: node(); o += 20; continue;
				case 0x1c: {
					const n = node();
					n.translation = vec(2);
					n.fn = u32(data, at(8));
					o += 12;
					continue;
				}
				case 0x1f: node(); o += 16; continue;
				case 0x10: {
					const type = (p >> 4) & 7, hasDl = (p & 0x80) !== 0;
					const n = node();
					n.layer = p & 0x0f;
					let size: number;
					if (type === 0) {
						n.translation = vec(4);
						n.rotation = vec(10);
						size = 16;
					} else if (type === 1) {
						n.translation = vec(2);
						size = 8;
					} else if (type === 2) {
						n.rotation = vec(2);
						size = 8;
					} else {
						n.rotation = [0, s16(data, at(2)), 0];
						size = 4;
					}
					if (hasDl) n.dl = u32(data, at(size));
					o += size + (hasDl ? 4 : 0);
					continue;
				}
				case 0x11: case 0x12: case 0x14: {
					const hasDl = (p & 0x80) !== 0;
					const n = node();
					n.layer = p & 0x0f;
					if (cmd === 0x12) n.rotation = vec(2);
					else n.translation = vec(2);
					if (hasDl) n.dl = u32(data, at(8));
					o += hasDl ? 12 : 8;
					continue;
				}
				case 0x13: {
					const n = node();
					n.layer = p;
					n.translation = vec(2);
					n.dl = u32(data, at(8)) || null;
					o += 12;
					continue;
				}
				case 0x15: {
					const n = node();
					n.layer = p;
					n.dl = u32(data, at(4)) || null;
					o += 8;
					continue;
				}
				case 0x1d: {
					const hasDl = (p & 0x80) !== 0;
					const n = node();
					n.layer = p & 0x0f;
					n.scale = u32(data, at(4)) / 65536;
					if (hasDl) n.dl = u32(data, at(8));
					o += hasDl ? 12 : 8;
					continue;
				}
				default:
					break outer;
			}
		}
	}
	return root;
}

export interface Sm64PoseOptions {
	/** Pose for the animated parts. */
	animation?: Sm64Animation | null;
	frame?: number;
	/** Which case a switch node draws (default 0). */
	selectCase?: (node: Sm64GeoNode, parents: readonly Sm64GeoNode[]) => number;
	/** Leave a node and everything under it out. */
	hide?: (node: Sm64GeoNode, parents: readonly Sm64GeoNode[]) => boolean;
}

export interface Sm64GeoDraw {
	dl: number;
	layer: number;
	/** Row-vector matrix placing the display list in model space. */
	matrix: Float32Array;
	node: Sm64GeoNode;
}

/** Walk the scene graph like `geo_process_node_and_siblings`: what draws, and where. */
export function poseSm64Geo(root: Sm64GeoNode, options: Sm64PoseOptions = {}): { draws: Sm64GeoDraw[]; animatedParts: number } {
	const draws: Sm64GeoDraw[] = [];
	const anim = options.animation ?? null;
	const channels = anim ? sampleSm64Animation(anim, options.frame ?? 0) : null;
	let part = 0;
	const parents: Sm64GeoNode[] = [];
	const visit = (n: Sm64GeoNode, parent: M) => {
		if (options.hide?.(n, parents)) return;
		let m = parent;
		const t = n.translation ?? [0, 0, 0];
		switch (n.cmd) {
			case 0x10:
				m = mul(mul(n.rotation ? rotate(...n.rotation) : ident(), translate(...t)), parent);
				break;
			case 0x11:
				m = mul(translate(...t), parent);
				break;
			case 0x12:
				m = mul(rotate(...n.rotation!), parent);
				break;
			case 0x13: {
				let [x, y, z] = t, r: [number, number, number] = [0, 0, 0];
				if (anim && channels) {
					if (part === 0) {
						const d = sm64RootTranslation(anim, channels);
						x += d[0];
						y += d[1];
						z += d[2];
					}
					const c = 3 + part * 3;
					r = [channels[c] ?? 0, channels[c + 1] ?? 0, channels[c + 2] ?? 0];
				}
				part++;
				m = mul(sm64RotateTranslate(r[0], r[1], r[2], x, y, z), parent);
				break;
			}
			case 0x14: {
				// mtxf_billboard: camera-facing rotation, parent-space position, no scale.
				m = ident();
				m[12] = t[0] * parent[0]! + t[1] * parent[4]! + t[2] * parent[8]! + parent[12]!;
				m[13] = t[0] * parent[1]! + t[1] * parent[5]! + t[2] * parent[9]! + parent[13]!;
				m[14] = t[0] * parent[2]! + t[1] * parent[6]! + t[2] * parent[10]! + parent[14]!;
				break;
			}
			case 0x1c:
				return; // held object: drawn by the object holding it
			case 0x1d:
				m = mul(scale(n.scale ?? 1), parent);
				break;
		}
		if (n.dl) draws.push({ dl: n.dl, layer: n.layer, matrix: m, node: n });
		if (!n.children.length) return;
		parents.push(n);
		if (n.cmd === 0x0e) {
			const k = options.selectCase?.(n, parents.slice(0, -1)) ?? 0;
			const c = n.children[Math.max(0, Math.min(n.children.length - 1, k))];
			if (c) visit(c, m);
		} else {
			// Only the nearest of sibling render ranges that draws a display
			// list (some near ranges are drawn by code instead).
			let near = Infinity, nearDrawn = Infinity;
			for (const c of n.children) {
				if (!c.range) continue;
				near = Math.min(near, c.range[0]);
				if (hasDisplayList(c)) nearDrawn = Math.min(nearDrawn, c.range[0]);
			}
			if (nearDrawn !== Infinity) near = nearDrawn;
			for (const c of n.children) if (!c.range || c.range[0] === near) visit(c, m);
		}
		parents.pop();
	};
	visit(root, ident());
	return { draws, animatedParts: part };
}

export interface Sm64GeoMesh extends Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'alphas' | 'uvs' | 'indices' | 'groups' | 'materials' | 'usesLighting'> {
	/** Buffer the materials' texture offsets index into (all segments, concatenated). */
	data: Uint8Array;
	displayLists: number;
	/** Animated parts the layout drew. */
	animatedParts: number;
	/** Whether an animation posed them. */
	posed: boolean;
	/** The animation it was posed with. */
	animation: Sm64Animation | null;
	/** Display lists drawn, in vertex order. */
	draws: Sm64GeoDraw[];
	/** Re-pose the same vertices: rewrites `positions` / `normals` in place for another frame or animation. */
	animator: Sm64GeoAnimator;
}

export interface Sm64GeoAnimator {
	pose(animation: Sm64Animation | null, frame: number, positions: Float32Array, normals?: Float32Array): void;
}

/**
 * Whether a geo layout draws any display list in any switch case. Ones
 * that don't are drawn by code (`GEO_ASM`: the ending cake, Rainbow
 * Ride's carpet, shadows), so there's no model to show.
 */
export function sm64GeoHasDisplayLists(cache: Sm64SegmentCache, segments: Sm64SegmentMap, geo: number): boolean {
	const { data, resolve } = cache.buffer(segments);
	return hasDisplayList(parseSm64Geo(data, resolve, geo));
}

/** Build a geo layout (or, with `displayList`, a bare display list) into a mesh. */
export interface BuildSm64GeoOptions extends Omit<Sm64PoseOptions, 'animation'> {
	cache?: Sm64SegmentCache;
	displayList?: boolean;
	/**
	 * Pose for the animated parts, given how many there are and the
	 * display lists drawn (so callers can find the animations stored
	 * next to them).
	 */
	findAnimation?: (parts: number, segmentBytes: (seg: number) => Uint8Array | null, displayLists: number[]) => Sm64Animation | null;
	/** Pose with this animation instead of looking one up. */
	animation?: Sm64Animation | null;
}

function place(local: F3dexMesh, m: M, positions: Float32Array, normals: Float32Array | undefined, at: number) {
	const p = local.positions, nm = local.normals;
	for (let i = 0; i < p.length; i += 3) {
		const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
		positions[at + i] = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
		positions[at + i + 1] = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
		positions[at + i + 2] = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
		if (!normals) continue;
		const nx = nm[i]!, ny = nm[i + 1]!, nz = nm[i + 2]!;
		const a = nx * m[0]! + ny * m[4]! + nz * m[8]!, b = nx * m[1]! + ny * m[5]! + nz * m[9]!, c = nx * m[2]! + ny * m[6]! + nz * m[10]!;
		const len = Math.hypot(a, b, c) || 1;
		normals[at + i] = a / len;
		normals[at + i + 1] = b / len;
		normals[at + i + 2] = c / len;
	}
}

/**
 * `G_TEXTURE_GEN` texture coordinates: the RSP maps the eye-space normal
 * onto the part of the texture `gSPTexture`'s scale covers (Metal Mario,
 * the power star). A still model has no eye, so map the model-space
 * normal as seen from the front.
 */
function sphereMap(normals: Float32Array, texGen: Float32Array, uvs: Float32Array) {
	for (let v = 0; v < texGen.length / 2; v++) {
		const su = texGen[v * 2]!, sv = texGen[v * 2 + 1]!;
		if (!su && !sv) continue;
		uvs[v * 2] = (0.5 + normals[v * 3]! * 0.5) * su;
		uvs[v * 2 + 1] = (0.5 - normals[v * 3 + 1]! * 0.5) * sv;
	}
}

export function buildSm64Geo(rom: Uint8Array, segments: Sm64SegmentMap, geo: number, options: BuildSm64GeoOptions = {}): Sm64GeoMesh {
	const cache = options.cache ?? new Sm64SegmentCache(rom);
	const { data, resolve } = sm64SegmentBuffer(cache, segments);
	const locals = new Map<string, F3dexMesh | null>();
	const local = (dl: number, state: F3dexState | undefined): F3dexMesh | null => {
		const key = `${dl}|${JSON.stringify(state ?? null)}`;
		if (locals.has(key)) return locals.get(key)!;
		const start = resolve(dl);
		const mesh = start === null ? null : interpretDisplayList(data, start, {
			microcode: 'f3d',
			resolveSegment: resolve,
			trustSegments: true,
			maxCommands: 100000,
			// init_rsp: G_SHADE | G_SHADING_SMOOTH | G_CULL_BACK | G_LIGHTING.
			initialGeometryMode: 0x00022204,
			initialState: state,
		});
		locals.set(key, mesh);
		return mesh;
	};
	/**
	 * Interpret each draw in the order the game runs them (layer by layer,
	 * `geo_process_master_list_sub`) so render state (lights, the loaded
	 * texture) carries over from one display list to the next; null where
	 * a draw has no triangles.
	 */
	const meshesFor = (list: Sm64GeoDraw[]): (F3dexMesh | null)[] => {
		const out: (F3dexMesh | null)[] = new Array(list.length).fill(null);
		const order = list.map((d, i) => i).sort((a, b) => list[a]!.layer - list[b]!.layer || a - b);
		let state: F3dexState | undefined;
		for (const i of order) {
			const mesh = local(list[i]!.dl, state);
			if (!mesh) continue;
			state = mesh.state;
			if (mesh.indices.length) out[i] = mesh;
		}
		return out;
	};
	let draws: Sm64GeoDraw[];
	let animatedParts = 0;
	let animation: Sm64Animation | null = null;
	let root: Sm64GeoNode | null = null;
	if (options.displayList) {
		draws = [{ dl: geo, layer: 1, matrix: ident(), node: { ...newNode(0x15, geo), dl: geo } }];
	} else {
		root = parseSm64Geo(data, resolve, geo);
		const rest = poseSm64Geo(root, options);
		animatedParts = rest.animatedParts;
		draws = rest.draws;
		if (options.animation !== undefined) animation = options.animation;
		else if (animatedParts > 0 && options.findAnimation) {
			const segBytes = (seg: number) => {
				const s = segments.get(seg);
				return s ? cache.get(s) : null;
			};
			animation = options.findAnimation(animatedParts, segBytes, draws.map((d) => d.dl));
		}
		if (animation) draws = poseSm64Geo(root, { ...options, animation }).draws;
	}
	const all = meshesFor(draws);
	const meshes = all.filter((m): m is F3dexMesh => m !== null);
	draws = draws.filter((_, i) => all[i]);
	const parts = draws.map((d, i) => {
		const l = meshes[i]!;
		const positions = new Float32Array(l.positions.length), normals = new Float32Array(l.normals.length);
		place(l, d.matrix, positions, normals, 0);
		return { ...l, positions, normals };
	});
	const merged = mergeF3dexMeshes(parts);
	if (merged.texGen) sphereMap(merged.normals, merged.texGen, merged.uvs);
	const animator: Sm64GeoAnimator = {
		pose(anim, frame, positions, normals) {
			if (!root) return;
			const posed = poseSm64Geo(root, { ...options, animation: anim, frame }).draws.filter((_, i) => all[i]);
			let at = 0;
			for (let i = 0; i < posed.length && i < meshes.length; i++) {
				const l = meshes[i]!;
				place(l, posed[i]!.matrix, positions, normals, at);
				at += l.positions.length;
			}
		},
	};
	return { ...merged, data, displayLists: parts.length, animatedParts, posed: animation !== null, animation, draws, animator };
}
