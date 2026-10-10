/**
 * FF7 PSX battle models: the `.LZS` files in the ENEMY1–6 and MAGIC
 * folders (enemies, party characters, summons).
 *
 * After LZS decompression the file is `u32 n; u32 offsets[n]`:
 * offsets[0] is the skeleton + meshes, offsets[1] settings,
 * then animations, weapon meshes and a TIM texture.
 *
 * Skeleton (at S): `u32 boneCount`, then a root record and one
 * 8-byte record per bone: `u16 parent (0 = root, k = bone k, 1-based),
 * s16 length, u32 mesh offset (relative to S, 0 = no mesh)`. A bone
 * sits at its parent's length along the parent's Z axis.
 *
 * Mesh: `u32 vertexBytes`, vertices `{s16 x, y, z, pad}`, then four
 * polygon groups `{u16 count, u16 tpage}` + records: textured
 * triangles, textured quads, coloured triangles, coloured quads.
 * Vertex indices are byte offsets into the vertex pool.
 *
 * Animations are a delta-coded bitstream; frame 0 of the first one
 * gives the rest pose. Layout per Akari's q-gears_reverse notes and
 * the Q-Gears battle model exporter.
 */
import { decodeTim, timLayout, pixelWidth, type TimLayout } from '@tootallnate/psx-tim';
import { apply, IDENTITY, MeshBuilder, mul, rgb, rotationYXZ, WHITE, type Mat3, type PsxMesh } from './mesh.js';

interface BattleBone {
	parent: number; // 0 = root, else 1-based bone index
	length: number;
	mesh: number; // offset of mesh data in the file, or -1
}

export interface BattleModel {
	bones: BattleBone[];
	/** Mesh on the root record (single-mesh models have no bones), or -1. */
	rootMesh: number;
	/** Offset of the skeleton section. */
	skeleton: number;
	/** Section offsets from the file header. */
	sections: number[];
	/** Offset of the TIM texture, or -1. */
	tim: number;
	/** Offsets of sections that hold a non-empty animation. */
	animations: number[];
}

const TEX_TRI = 0x10;
const TEX_QUAD = 0x14;
const COL_TRI = 0x14;
const COL_QUAD = 0x18;

/** Parse the layout of a decompressed battle model. Throws when it doesn't look like one. */
export function parseBattleModel(bytes: Uint8Array): BattleModel {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 16) throw new Error('Battle model too short');
	const n = dv.getUint32(0, true);
	if (n < 2 || n > 512 || 4 + n * 4 > bytes.length) throw new Error('Not an FF7 battle model');
	const sections: number[] = [];
	for (let i = 0; i < n; i++) {
		const off = dv.getUint32(4 + i * 4, true);
		if (off >= bytes.length || (sections.length && off < sections[sections.length - 1])) throw new Error('Not an FF7 battle model');
		sections.push(off);
	}
	const S = sections[0];
	const nb = dv.getUint32(S, true);
	if (nb > 128 || S + 0xc + nb * 8 > bytes.length) throw new Error('Battle model has no skeleton');
	const rootMeshOff = dv.getUint32(S + 8, true) & 0x7fffffff;
	const rootMesh = rootMeshOff ? S + rootMeshOff : -1;
	if (!nb && rootMesh < 0) throw new Error('Battle model has no skeleton');
	const bones: BattleBone[] = [];
	for (let i = 0; i < nb; i++) {
		const o = S + 0xc + i * 8;
		const parent = dv.getUint16(o, true);
		const meshOff = dv.getUint32(o + 4, true) & 0x7fffffff;
		if (parent > nb) throw new Error('Battle model bone parent out of range');
		bones.push({ parent, length: dv.getInt16(o + 2, true), mesh: meshOff ? S + meshOff : -1 });
	}
	let tim = -1;
	for (let i = sections.length - 1; i > 0; i--) {
		if (timLayout(bytes, sections[i])) {
			tim = sections[i];
			break;
		}
	}
	const animations: number[] = [];
	for (let i = 2; i < sections.length; i++) {
		const o = sections[i];
		if (o === tim || o + 5 > bytes.length) continue;
		const frames = dv.getUint16(o, true);
		const size = dv.getUint16(o + 2, true);
		const c = bytes[o + 4];
		if (frames > 0 && frames < 4096 && size > 6 && c < 12 && o + 5 + size <= bytes.length) animations.push(o);
	}
	return { bones, rootMesh, skeleton: S, sections, tim, animations };
}

/** MSB-first bit reader. */
class Bits {
	private pos = 0;
	constructor(
		private readonly bytes: Uint8Array,
		private readonly start: number,
	) {}
	read(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) {
			const p = this.pos++;
			const byte = this.bytes[this.start + (p >> 3)] ?? 0;
			v = (v << 1) | ((byte >> (7 - (p & 7))) & 1);
		}
		return v;
	}
	signed(n: number): number {
		const v = this.read(n);
		return v & (1 << (n - 1)) ? v - (1 << n) : v;
	}
}

/** Root translation and per-bone (root + bones) rotations of frame 0, in radians. */
function firstFrame(bytes: Uint8Array, anim: number, boneCount: number): { root: [number, number, number]; rot: [number, number, number][] } {
	const c = bytes[anim + 4];
	const bits = new Bits(bytes, anim + 5);
	const root: [number, number, number] = [bits.signed(16), bits.signed(16), bits.signed(16)];
	const rot: [number, number, number][] = [];
	const toRad = (v: number) => ((v & 0xfff) / 4096) * Math.PI * 2;
	for (let i = 0; i <= boneCount; i++) {
		const rx = bits.read(12 - c) << c;
		const ry = bits.read(12 - c) << c;
		const rz = bits.read(12 - c) << c;
		rot.push([toRad(rx), toRad(ry), toRad(rz)]);
	}
	return { root, rot };
}

/** Pose (frame 0 of the first animation) and triangulate a battle model. */
export function buildBattleMesh(bytes: Uint8Array, model = parseBattleModel(bytes)): PsxMesh {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const { bones } = model;
	const pose = model.animations.length ? firstFrame(bytes, model.animations[0], bones.length) : null;

	// World transforms: index 0 = root, 1..n = bones.
	const R: Mat3[] = [];
	const T: [number, number, number][] = [];
	const lengths = [0, ...bones.map((b) => b.length)];
	R[0] = pose ? rotationYXZ(...pose.rot[0]) : IDENTITY;
	T[0] = [0, 0, 0];
	bones.forEach((b, i) => {
		const idx = i + 1;
		const p = b.parent < idx ? b.parent : 0;
		const local = pose ? rotationYXZ(...pose.rot[idx]) : IDENTITY;
		const off = apply(R[p], 0, 0, lengths[p]);
		T[idx] = [T[p][0] + off[0], T[p][1] + off[1], T[p][2] + off[2]];
		R[idx] = mul(R[p], local);
	});

	// Texture: one decoded image per CLUT row the polygons use.
	const builder = new MeshBuilder();
	const tim: TimLayout | null = model.tim >= 0 ? timLayout(bytes, model.tim) : null;
	const timWidth = tim ? pixelWidth(tim.bpp, tim.image.width) : 0;
	const paletteTextures = new Map<number, number>();
	const textureFor = (clut: number): number => {
		if (!tim) return -1;
		let palette = 0;
		if (tim.clut) {
			const colors = tim.bpp === 4 ? 16 : 256;
			const perRow = Math.max(1, Math.floor(tim.clut.width / colors));
			const row = Math.max(0, (clut >> 6) - tim.clut.y);
			const col = Math.max(0, Math.floor(((clut & 0x3f) * 16 - tim.clut.x) / colors));
			palette = row * perRow + col;
		}
		let t = paletteTextures.get(palette);
		if (t === undefined) {
			const img = decodeTim(bytes, model.tim, palette);
			if (!img) return -1;
			t = builder.textures.length;
			builder.textures.push({ width: img.width, height: img.height, pixels: img.pixels });
			paletteTextures.set(palette, t);
		}
		return t;
	};
	const uvFor = (tpage: number, u: number, v: number): [number, number] => {
		if (!tim) return [0, 0];
		const perHalfword = 16 / tim.bpp;
		const px = ((tpage & 0xf) * 64 - tim.image.x) * perHalfword + u + 0.5;
		const py = ((tpage >> 4) & 1) * 256 - tim.image.y + v + 0.5;
		return [px / timWidth, py / tim.image.height];
	};

	const meshes: [number, number][] = [];
	if (model.rootMesh >= 0) meshes.push([model.rootMesh, 0]);
	bones.forEach((b, i) => {
		if (b.mesh >= 0) meshes.push([b.mesh, i + 1]);
	});
	for (const [m, bone] of meshes) {
		const rot = R[bone];
		const tr = T[bone];
		const vbytes = dv.getUint32(m, true);
		const vcount = vbytes >> 3;
		if (m + 4 + vbytes > bytes.length) continue;
		const verts: [number, number, number][] = [];
		for (let k = 0; k < vcount; k++) {
			const o = m + 4 + k * 8;
			const w = apply(rot, dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getInt16(o + 4, true));
			verts.push([w[0] + tr[0], w[1] + tr[1], w[2] + tr[2]]);
		}
		const vtx = (byteOff: number) => verts[byteOff >> 3] ?? [0, 0, 0];
		let p = m + 4 + vbytes;
		for (let group = 0; group < 4; group++) {
			if (p + 4 > bytes.length) break;
			const count = dv.getUint16(p, true);
			const tpage = dv.getUint16(p + 2, true);
			p += 4;
			const size = [TEX_TRI, TEX_QUAD, COL_TRI, COL_QUAD][group];
			if (p + count * size > bytes.length) break;
			for (let k = 0; k < count; k++, p += size) {
				const a = vtx(dv.getUint16(p, true));
				const bb = vtx(dv.getUint16(p + 2, true));
				const c = vtx(dv.getUint16(p + 4, true));
				if (group === 0) {
					const tex = textureFor(dv.getUint16(p + 10, true));
					builder.tri(tex,
						{ p: a, c: WHITE, uv: uvFor(tpage, bytes[p + 8], bytes[p + 9]) },
						{ p: bb, c: WHITE, uv: uvFor(tpage, bytes[p + 12], bytes[p + 13]) },
						{ p: c, c: WHITE, uv: uvFor(tpage, bytes[p + 14], bytes[p + 15]) });
				} else if (group === 1) {
					const d = vtx(dv.getUint16(p + 6, true));
					const tex = textureFor(dv.getUint16(p + 10, true));
					builder.quad(tex,
						{ p: a, c: WHITE, uv: uvFor(tpage, bytes[p + 8], bytes[p + 9]) },
						{ p: bb, c: WHITE, uv: uvFor(tpage, bytes[p + 12], bytes[p + 13]) },
						{ p: c, c: WHITE, uv: uvFor(tpage, bytes[p + 14], bytes[p + 15]) },
						{ p: d, c: WHITE, uv: uvFor(tpage, bytes[p + 16], bytes[p + 17]) });
				} else if (group === 2) {
					builder.tri(-1,
						{ p: a, c: rgb(bytes, p + 8), uv: [0, 0] },
						{ p: bb, c: rgb(bytes, p + 12), uv: [0, 0] },
						{ p: c, c: rgb(bytes, p + 16), uv: [0, 0] });
				} else {
					const d = vtx(dv.getUint16(p + 6, true));
					builder.quad(-1,
						{ p: a, c: rgb(bytes, p + 8), uv: [0, 0] },
						{ p: bb, c: rgb(bytes, p + 12), uv: [0, 0] },
						{ p: c, c: rgb(bytes, p + 16), uv: [0, 0] },
						{ p: d, c: rgb(bytes, p + 20), uv: [0, 0] });
				}
			}
		}
	}
	return builder.build(bones.length);
}
