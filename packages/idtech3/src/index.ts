/**
 * id Tech 3-family model and level formats, as used by Quake III and
 * Raven's Star Wars Jedi Knight II: Jedi Outcast / Jedi Academy:
 *
 * - {@link parseMd3}: `IDP3` vertex-animated models (frame 0 / any frame).
 * - {@link parseGlm}: Ghoul2 `2LGM` skinned meshes (bind pose), with the
 *   surface hierarchy and per-surface shaders.
 * - {@link parseBsp}: `IBSP` (Quake III, v46) and `RBSP` (Raven, v1)
 *   levels: planar / triangle-soup surfaces and tessellated Bézier patches.
 * - {@link parseSkin}: `.skin` surface → texture tables.
 *
 * Layouts from id's GPL Quake III Arena source (`qcommon/qfiles.h`) and
 * Raven's GPL Jedi Outcast / Jedi Academy source (`rd-common/mdx_format.h`,
 * `qcommon/qfiles.h`). All little-endian.
 */

export interface Q3Surface {
	name: string;
	/** Shader (texture path without extension, usually). */
	shader: string;
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
	/** Per-vertex RGBA 0..1 (BSP only). */
	colors?: Float32Array;
}

const dec = new TextDecoder();
function cstr(b: Uint8Array, o: number, n: number): string {
	const s = b.subarray(o, o + n);
	const z = s.indexOf(0);
	return dec.decode(z >= 0 ? s.subarray(0, z) : s);
}

// ----- MD3 -----

export interface Md3 {
	name: string;
	numFrames: number;
	frameNames: string[];
	tags: string[];
	surfaces: Q3Surface[];
}

export function isMd3(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x50 && head[3] === 0x33;
}

/**
 * MD3 (`qfiles.h` md3Header_t / md3Surface_t): positions are int16 ×
 * 1/64, normals a latitude / longitude byte pair, per frame.
 */
export function parseMd3(bytes: Uint8Array, frame = 0): Md3 {
	if (!isMd3(bytes)) throw new Error('Not an MD3 (missing "IDP3")');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const i32 = (o: number) => dv.getInt32(o, true);
	const name = cstr(bytes, 8, 64);
	const numFrames = i32(76);
	const numTags = i32(80);
	const numSurfaces = i32(84);
	const ofsFrames = i32(92);
	const ofsTags = i32(96);
	const ofsSurfaces = i32(100);
	const frameNames: string[] = [];
	for (let f = 0; f < numFrames; f++) frameNames.push(cstr(bytes, ofsFrames + f * 56 + 40, 16));
	const tags: string[] = [];
	for (let t = 0; t < numTags; t++) tags.push(cstr(bytes, ofsTags + t * 112, 64));
	const fr = Math.max(0, Math.min(numFrames - 1, frame));
	const surfaces: Q3Surface[] = [];
	let s = ofsSurfaces;
	for (let k = 0; k < numSurfaces && s + 108 <= bytes.length; k++) {
		const sname = cstr(bytes, s + 4, 64);
		const nShaders = i32(s + 76);
		const nVerts = i32(s + 80);
		const nTris = i32(s + 84);
		const ofsTris = i32(s + 88);
		const ofsShaders = i32(s + 92);
		const ofsSt = i32(s + 96);
		const ofsXyz = i32(s + 100);
		const ofsEnd = i32(s + 104);
		const shader = nShaders > 0 ? cstr(bytes, s + ofsShaders, 64) : '';
		const indices = new Uint32Array(nTris * 3);
		for (let i = 0; i < nTris * 3; i++) indices[i] = i32(s + ofsTris + i * 4);
		const positions = new Float32Array(nVerts * 3);
		const normals = new Float32Array(nVerts * 3);
		const uvs = new Float32Array(nVerts * 2);
		const base = s + ofsXyz + fr * nVerts * 8;
		for (let v = 0; v < nVerts; v++) {
			const o = base + v * 8;
			positions[v * 3] = dv.getInt16(o, true) / 64;
			positions[v * 3 + 1] = dv.getInt16(o + 2, true) / 64;
			positions[v * 3 + 2] = dv.getInt16(o + 4, true) / 64;
			const lat = (bytes[o + 6]! * Math.PI * 2) / 255;
			const lng = (bytes[o + 7]! * Math.PI * 2) / 255;
			normals[v * 3] = Math.cos(lng) * Math.sin(lat);
			normals[v * 3 + 1] = Math.sin(lng) * Math.sin(lat);
			normals[v * 3 + 2] = Math.cos(lat);
			uvs[v * 2] = dv.getFloat32(s + ofsSt + v * 8, true);
			uvs[v * 2 + 1] = dv.getFloat32(s + ofsSt + v * 8 + 4, true);
		}
		surfaces.push({ name: sname, shader, positions, normals, uvs, indices });
		if (ofsEnd <= 0) break;
		s += ofsEnd;
	}
	return { name, numFrames, frameNames, tags, surfaces };
}

// ----- Ghoul2 GLM -----

export interface GlmSurface extends Q3Surface {
	/** Surface flags (bit 0: tag / "off" helper). */
	flags: number;
	parent: number;
	/** Bone indices (into the GLA skeleton) and weights, 4 per vertex. */
	boneIndices: Uint16Array;
	boneWeights: Float32Array;
}

export interface Glm {
	name: string;
	/** Animation file the mesh skins to (`models/players/_humanoid/_humanoid`). */
	animName: string;
	numBones: number;
	numLods: number;
	surfaces: GlmSurface[];
}

export function isGlm(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x32 && head[1] === 0x4c && head[2] === 0x47 && head[3] === 0x4d;
}

/**
 * Ghoul2 mesh (`mdx_format.h`): header, surface hierarchy (name, flags,
 * shader, parent), then per-LOD surfaces. A vertex is normal + position
 * (floats) + a packed word: bits 30–31 = weight count − 1, 5-bit bone
 * reference indices from bit 0, and the top two bits of each 10-bit
 * weight from bit 20; the low eight bits are in `BoneWeightings[4]`.
 * Texture coordinates follow the vertices. Bone references map to the
 * GLA's bones. Vertices are in the bind pose.
 */
export function parseGlm(bytes: Uint8Array, lod = 0): Glm {
	if (!isGlm(bytes)) throw new Error('Not a Ghoul2 GLM (missing "2LGM")');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const i32 = (o: number) => dv.getInt32(o, true);
	const f32 = (o: number) => dv.getFloat32(o, true);
	const name = cstr(bytes, 8, 64);
	const animName = cstr(bytes, 72, 64);
	const numBones = i32(140);
	const numLods = i32(144);
	const ofsLods = i32(148);
	const numSurfaces = i32(152);
	const HDR = 164;
	// Surface hierarchy: offsets table right after the header.
	const hier: { name: string; flags: number; shader: string; parent: number }[] = [];
	for (let k = 0; k < numSurfaces; k++) {
		const h = HDR + i32(HDR + k * 4);
		hier.push({ name: cstr(bytes, h, 64), flags: dv.getUint32(h + 64, true), shader: cstr(bytes, h + 68, 64), parent: i32(h + 136) });
	}
	// Walk to the requested LOD.
	let l = ofsLods;
	const want = Math.max(0, Math.min(numLods - 1, lod));
	for (let k = 0; k < want; k++) l += i32(l);
	const surfTable = l + 4;
	const surfaces: GlmSurface[] = [];
	for (let k = 0; k < numSurfaces; k++) {
		const s = surfTable + i32(surfTable + k * 4);
		const idx = i32(s + 4);
		const nVerts = i32(s + 12);
		const ofsVerts = i32(s + 16);
		const nTris = i32(s + 20);
		const ofsTris = i32(s + 24);
		const nRefs = i32(s + 28);
		const ofsRefs = i32(s + 32);
		const refs: number[] = [];
		for (let r = 0; r < nRefs; r++) refs.push(i32(s + ofsRefs + r * 4));
		const positions = new Float32Array(nVerts * 3);
		const normals = new Float32Array(nVerts * 3);
		const uvs = new Float32Array(nVerts * 2);
		const boneIndices = new Uint16Array(nVerts * 4);
		const boneWeights = new Float32Array(nVerts * 4);
		for (let v = 0; v < nVerts; v++) {
			const o = s + ofsVerts + v * 32;
			normals.set([f32(o), f32(o + 4), f32(o + 8)], v * 3);
			positions.set([f32(o + 12), f32(o + 16), f32(o + 20)], v * 3);
			const packed = dv.getUint32(o + 24, true);
			const n = (packed >>> 30) + 1;
			let total = 0;
			for (let w = 0; w < n; w++) {
				const ref = (packed >>> (5 * w)) & 31;
				boneIndices[v * 4 + w] = refs[ref] ?? 0;
				if (w < n - 1) {
					const weight = (bytes[o + 28 + w]! | ((packed >>> (12 + w * 2)) & 0x300)) / 1023;
					boneWeights[v * 4 + w] = weight;
					total += weight;
				} else {
					boneWeights[v * 4 + w] = Math.max(0, 1 - total);
				}
			}
		}
		const st = s + ofsVerts + nVerts * 32;
		for (let v = 0; v < nVerts; v++) {
			uvs[v * 2] = f32(st + v * 8);
			uvs[v * 2 + 1] = f32(st + v * 8 + 4);
		}
		const indices = new Uint32Array(nTris * 3);
		for (let i = 0; i < nTris * 3; i++) indices[i] = i32(s + ofsTris + i * 4);
		const h = hier[idx] ?? hier[k] ?? { name: `surface_${k}`, flags: 0, shader: '', parent: -1 };
		surfaces.push({ name: h.name, shader: h.shader, flags: h.flags, parent: h.parent, positions, normals, uvs, indices, boneIndices, boneWeights });
	}
	return { name, animName, numBones, numLods, surfaces };
}

/** Ghoul2 helper surfaces that never render: tags (`*name`), caps and `_off` pieces. */
export function isGlmHelperSurface(s: { name: string; flags: number }): boolean {
	return s.name.startsWith('*') || (s.flags & 1) !== 0 || /_off$/i.test(s.name);
}

// ----- .skin -----

/** `surface,texture` lines (texture `*off` hides the surface). */
export function parseSkin(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*([^,\s]+)\s*,\s*"?([^"\s]+)"?/.exec(line);
		if (m) out.set(m[1]!.toLowerCase(), m[2]!);
	}
	return out;
}

// ----- BSP -----

export interface Bsp {
	variant: 'IBSP' | 'RBSP';
	shaders: string[];
	/** Surfaces grouped by shader (patches tessellated). */
	surfaces: Q3Surface[];
}

export function isBsp(head: Uint8Array): boolean {
	return head.length >= 8 && ((head[0] === 0x49 || head[0] === 0x52) && head[1] === 0x42 && head[2] === 0x53 && head[3] === 0x50);
}

/**
 * Quake III `IBSP` v46 / Raven `RBSP` v1. Lumps (offset, length pairs
 * from byte 8): 1 shaders (64-byte name + 2 ints), 10 draw verts,
 * 11 draw indexes, 13 surfaces. Raven's vertices carry four lightmap
 * UVs and colours (80 bytes vs 44) and its surfaces four lightmap
 * styles (148 bytes vs 104). Surface types: 1 planar, 2 patch, 3 triangle
 * soup, 4 flare. Patches are 3×3 Bézier blocks over a control grid,
 * tessellated here at `patchLevel` subdivisions per block.
 */
export function parseBsp(bytes: Uint8Array, patchLevel = 6): Bsp {
	if (!isBsp(bytes)) throw new Error('Not a Quake III BSP');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const i32 = (o: number) => dv.getInt32(o, true);
	const f32 = (o: number) => dv.getFloat32(o, true);
	const raven = bytes[0] === 0x52;
	const lump = (i: number) => ({ ofs: i32(8 + i * 8), len: i32(12 + i * 8) });
	const shLump = lump(1);
	const shaders: string[] = [];
	for (let o = shLump.ofs; o + 72 <= shLump.ofs + shLump.len; o += 72) shaders.push(cstr(bytes, o, 64));
	const VSZ = raven ? 80 : 44;
	const vLump = lump(10);
	const iLump = lump(11);
	const sLump = lump(13);
	const SSZ = raven ? 148 : 104;
	const vert = (i: number) => {
		const o = vLump.ofs + i * VSZ;
		const nOff = raven ? 52 : 28;
		const cOff = raven ? 64 : 40;
		return {
			p: [f32(o), f32(o + 4), f32(o + 8)],
			uv: [f32(o + 12), f32(o + 16)],
			n: [f32(o + nOff), f32(o + nOff + 4), f32(o + nOff + 8)],
			c: [bytes[o + cOff]! / 255, bytes[o + cOff + 1]! / 255, bytes[o + cOff + 2]! / 255, bytes[o + cOff + 3]! / 255],
		};
	};
	type V = ReturnType<typeof vert>;
	const byShader = new Map<number, { v: V[]; idx: number[] }>();
	const group = (sh: number) => {
		let g = byShader.get(sh);
		if (!g) byShader.set(sh, (g = { v: [], idx: [] }));
		return g;
	};
	for (let so = sLump.ofs; so + SSZ <= sLump.ofs + sLump.len; so += SSZ) {
		const shader = i32(so);
		const type = i32(so + 8);
		const firstVert = i32(so + 12);
		const numVerts = i32(so + 16);
		const firstIndex = i32(so + 20);
		const numIndexes = i32(so + 24);
		const g = group(shader);
		const base = g.v.length;
		if (type === 1 || type === 3) {
			for (let k = 0; k < numVerts; k++) g.v.push(vert(firstVert + k));
			for (let k = 0; k < numIndexes; k++) g.idx.push(base + i32(iLump.ofs + (firstIndex + k) * 4));
		} else if (type === 2) {
			const pw = i32(so + SSZ - 8);
			const ph = i32(so + SSZ - 4);
			if (pw < 3 || ph < 3) continue;
			const ctrl: V[] = [];
			for (let k = 0; k < pw * ph; k++) ctrl.push(vert(firstVert + k));
			tessellatePatch(ctrl, pw, ph, patchLevel, g);
		}
	}
	const surfaces: Q3Surface[] = [];
	for (const [sh, g] of byShader) {
		if (g.idx.length === 0) continue;
		const n = g.v.length;
		const positions = new Float32Array(n * 3);
		const normals = new Float32Array(n * 3);
		const uvs = new Float32Array(n * 2);
		const colors = new Float32Array(n * 4);
		g.v.forEach((v, i) => {
			positions.set(v.p, i * 3);
			normals.set(v.n, i * 3);
			uvs.set(v.uv, i * 2);
			colors.set(v.c, i * 4);
		});
		surfaces.push({ name: shaders[sh] ?? `shader_${sh}`, shader: shaders[sh] ?? '', positions, normals, uvs, colors, indices: Uint32Array.from(g.idx) });
	}
	return { variant: raven ? 'RBSP' : 'IBSP', shaders, surfaces };
}

type PV = { p: number[]; uv: number[]; n: number[]; c: number[] };

/** Biquadratic Bézier tessellation of a patch control grid (3×3 blocks sharing edges). */
function tessellatePatch(ctrl: PV[], w: number, h: number, level: number, out: { v: PV[]; idx: number[] }): void {
	const lerp3 = (a: PV, b: PV, c: PV, t: number): PV => {
		const k0 = (1 - t) * (1 - t);
		const k1 = 2 * t * (1 - t);
		const k2 = t * t;
		const mix = (x: number[], y: number[], z: number[]) => x.map((v, i) => v * k0 + y[i]! * k1 + z[i]! * k2);
		return { p: mix(a.p, b.p, c.p), uv: mix(a.uv, b.uv, c.uv), n: mix(a.n, b.n, c.n), c: mix(a.c, b.c, c.c) };
	};
	for (let by = 0; by + 2 < h; by += 2) {
		for (let bx = 0; bx + 2 < w; bx += 2) {
			const at = (x: number, y: number) => ctrl[(by + y) * w + bx + x]!;
			const base = out.v.length;
			for (let j = 0; j <= level; j++) {
				const tv = j / level;
				const col = [0, 1, 2].map((x) => lerp3(at(x, 0), at(x, 1), at(x, 2), tv));
				for (let i = 0; i <= level; i++) {
					const v = lerp3(col[0]!, col[1]!, col[2]!, i / level);
					const l = Math.hypot(v.n[0]!, v.n[1]!, v.n[2]!) || 1;
					v.n = v.n.map((x) => x / l);
					out.v.push(v);
				}
			}
			const row = level + 1;
			for (let j = 0; j < level; j++) {
				for (let i = 0; i < level; i++) {
					const a = base + j * row + i;
					out.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
				}
			}
		}
	}
}
