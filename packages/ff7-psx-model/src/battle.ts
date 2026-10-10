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
import { apply, IDENTITY, MeshBuilder, mul, rgb, rotationYXZ, WHITE, type Mat3, type Pose, type PsxAnimator, type PsxClip, type PsxMesh, type Vec3 } from './mesh.js';

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
	pos = 0;
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
		return v >>> 0;
	}
	signed(n: number): number {
		const v = this.read(n);
		return n && v & (1 << (n - 1)) ? v - 2 ** n : v;
	}
}

/** Per-frame root translation + (root + bones) × 3 angles in 1/4096 turns. */
interface DecodedClip {
	frames: number;
	trans: Int32Array; // frames × 3
	rot: Int32Array; // frames × (bones + 1) × 3
}

/** Decode a battle animation's delta-coded bitstream (per Q-Gears' AnimationExtractor). */
function decodeClip(bytes: Uint8Array, anim: number, boneCount: number): DecodedClip {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const frames = dv.getUint16(anim, true);
	const c = bytes[anim + 4];
	const bits = new Bits(bytes, anim + 5);
	const limit = dv.getUint16(anim + 2, true) * 8;
	const n = boneCount + 1;
	const trans = new Int32Array(frames * 3);
	const rot = new Int32Array(frames * n * 3);
	const t = [0, 0, 0];
	const r = new Int32Array(n * 3);
	const rotDelta = (): number => {
		if (!bits.read(1)) return 0;
		const k = bits.read(3);
		if (k === 0) return -(1 << c);
		if (k === 7) return bits.signed(12 - c) * (1 << c);
		let v = bits.signed(k);
		v += v >= 0 ? 1 << (k - 1) : -(1 << (k - 1));
		return ((v << c) << 16) >> 16;
	};
	const transDelta = (): number => (bits.read(1) ? bits.signed(16) : bits.signed(7));
	for (let f = 0; f < frames; f++) {
		if (bits.pos > limit) {
			// Truncated stream: hold the last pose.
			trans.copyWithin(f * 3, (f - 1) * 3, f * 3);
			rot.copyWithin(f * n * 3, (f - 1) * n * 3, f * n * 3);
			continue;
		}
		if (f === 0) {
			for (let k = 0; k < 3; k++) t[k] = bits.signed(16);
			for (let k = 0; k < n * 3; k++) r[k] = bits.signed(12 - c) * (1 << c);
		} else {
			for (let k = 0; k < 3; k++) t[k] += transDelta();
			for (let k = 0; k < n * 3; k++) r[k] += rotDelta();
		}
		trans.set(t, f * 3);
		rot.set(r, f * n * 3);
	}
	return { frames, trans, rot };
}

const TURN = (Math.PI * 2) / 4096;

/** Samples battle animations into bone transforms (index 0 = root, i = bone i). */
export class BattleAnimator implements PsxAnimator {
	readonly clips: PsxClip[];
	private cache = new Map<number, DecodedClip>();
	constructor(
		private readonly bytes: Uint8Array,
		private readonly model: BattleModel,
	) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.clips = model.animations.map((o, i) => ({ name: `Animation ${i}`, frames: dv.getUint16(o, true) }));
	}

	private clip(i: number): DecodedClip {
		let c = this.cache.get(i);
		if (!c) this.cache.set(i, (c = decodeClip(this.bytes, this.model.animations[i], this.model.bones.length)));
		return c;
	}

	pose(clip: number, frame: number): Pose {
		const { bones } = this.model;
		const n = bones.length + 1;
		const R: Mat3[] = [];
		const T: Vec3[] = [];
		let rot: (k: number) => Mat3 = () => IDENTITY;
		let root: Vec3 = [0, 0, 0];
		if (clip >= 0 && clip < this.clips.length) {
			const c = this.clip(clip);
			const f = Math.max(0, Math.min(c.frames - 1, Math.floor(frame)));
			const base = f * n * 3;
			rot = (k) => rotationYXZ(c.rot[base + k * 3] * TURN, c.rot[base + k * 3 + 1] * TURN, c.rot[base + k * 3 + 2] * TURN);
			// Root motion relative to frame 0, so the model stays where it was framed.
			root = [c.trans[f * 3] - c.trans[0], c.trans[f * 3 + 1] - c.trans[1], c.trans[f * 3 + 2] - c.trans[2]];
		}
		const lengths = [0, ...bones.map((b) => b.length)];
		R[0] = rot(0);
		T[0] = root;
		bones.forEach((b, i) => {
			const idx = i + 1;
			const p = b.parent < idx ? b.parent : 0;
			const off = apply(R[p], 0, 0, lengths[p]);
			T[idx] = [T[p][0] + off[0], T[p][1] + off[1], T[p][2] + off[2]];
			R[idx] = mul(R[p], rot(idx));
		});
		return { R, T };
	}
}

/** Pose (frame 0 of the first animation) and triangulate a battle model. */
export function buildBattleMesh(bytes: Uint8Array, model = parseBattleModel(bytes)): PsxMesh {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const { bones } = model;
	const { R, T } = new BattleAnimator(bytes, model).pose(model.animations.length ? 0 : -1, 0);

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
		const locals: Vec3[] = [];
		for (let k = 0; k < vcount; k++) {
			const o = m + 4 + k * 8;
			const l: Vec3 = [dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getInt16(o + 4, true)];
			const w = apply(rot, ...l);
			locals.push(l);
			verts.push([w[0] + tr[0], w[1] + tr[1], w[2] + tr[2]]);
		}
		const vtx = (byteOff: number) => verts[byteOff >> 3] ?? [0, 0, 0];
		const loc = (byteOff: number) => locals[byteOff >> 3] ?? [0, 0, 0];
		let p = m + 4 + vbytes;
		for (let group = 0; group < 4; group++) {
			if (p + 4 > bytes.length) break;
			const count = dv.getUint16(p, true);
			const tpage = dv.getUint16(p + 2, true);
			p += 4;
			const size = [TEX_TRI, TEX_QUAD, COL_TRI, COL_QUAD][group];
			if (p + count * size > bytes.length) break;
			for (let k = 0; k < count; k++, p += size) {
				const corner = (at: number, c: Vec3, uv: [number, number]) => {
					const off = dv.getUint16(at, true);
					return { p: vtx(off), l: loc(off), b: bone, c, uv };
				};
				if (group === 0) {
					const tex = textureFor(dv.getUint16(p + 10, true));
					builder.tri(tex,
						corner(p, WHITE, uvFor(tpage, bytes[p + 8], bytes[p + 9])),
						corner(p + 2, WHITE, uvFor(tpage, bytes[p + 12], bytes[p + 13])),
						corner(p + 4, WHITE, uvFor(tpage, bytes[p + 14], bytes[p + 15])));
				} else if (group === 1) {
					const tex = textureFor(dv.getUint16(p + 10, true));
					builder.quad(tex,
						corner(p, WHITE, uvFor(tpage, bytes[p + 8], bytes[p + 9])),
						corner(p + 2, WHITE, uvFor(tpage, bytes[p + 12], bytes[p + 13])),
						corner(p + 4, WHITE, uvFor(tpage, bytes[p + 14], bytes[p + 15])),
						corner(p + 6, WHITE, uvFor(tpage, bytes[p + 16], bytes[p + 17])));
				} else if (group === 2) {
					builder.tri(-1, corner(p, rgb(bytes, p + 8), [0, 0]), corner(p + 2, rgb(bytes, p + 12), [0, 0]), corner(p + 4, rgb(bytes, p + 16), [0, 0]));
				} else {
					builder.quad(-1,
						corner(p, rgb(bytes, p + 8), [0, 0]),
						corner(p + 2, rgb(bytes, p + 12), [0, 0]),
						corner(p + 4, rgb(bytes, p + 16), [0, 0]),
						corner(p + 6, rgb(bytes, p + 20), [0, 0]));
				}
			}
		}
	}
	return builder.build(bones.length);
}
