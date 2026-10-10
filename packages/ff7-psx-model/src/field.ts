/**
 * FF7 PSX field models: global characters (`FIELD/*.BCX`) and the
 * per-field model sets (`FIELD/*.BSX`).
 *
 * Skeleton: 4-byte bones `{s16 length, s8 parent (-1 = root), u8 hasPart}`.
 * Parts: 0x20-byte headers naming their bone, vertex / polygon counts
 * and offsets into the part data (`{s16 x, y, z, pad}` vertices, then
 * eight polygon record types in a fixed order). Animations: 0x10-byte
 * headers with per-bone rotation / translation sources (u8 angles,
 * 256 = 360°).
 *
 * A bone is placed at its own length along its parent's Z axis, plus
 * the animation's translation; rotations compose as Ry · Rx · Rz.
 * Layout per Akari's q-gears_reverse notes (BCX.txt, BSX.txt) and the
 * Q-Gears field model exporter.
 *
 * Faces are textured polygons that sample eye and mouth images the
 * engine uploads from FIELD.TDB (32×32, 4 bpp, 8 images + 1 palette
 * per character). Pass the decompressed TDB and the character's face
 * id to apply them; otherwise those polygons keep their vertex colours.
 */
import { apply, IDENTITY, MeshBuilder, mul, rgb, rotationYXZ, type Mat3, type Pose, type PsxAnimator, type PsxClip, type PsxMesh, type Vec3 } from './mesh.js';

interface FieldBone {
	length: number;
	parent: number;
}

interface FieldPart {
	bone: number;
	texCoords: number; // absolute offset of u8 u, v pairs
	settings: number; // absolute offset of u32 texture settings words
	control: number; // absolute offset of the per-textured-polygon control bytes
	vertexCount: number;
	counts: number[]; // 8 polygon groups
	polygons: number; // absolute offset
	data: number; // absolute offset of part data (vertices at +4)
}

interface FieldAnimation {
	frames: number;
	bones: number;
	frameTrans: number;
	staticTrans: number;
	frameRot: number;
	data: number;
}

export interface FieldModel {
	bones: FieldBone[];
	parts: FieldPart[];
	animations: FieldAnimation[];
}

// Polygon record sizes for the 8 count fields, in order.
const SIZES = [0x18, 0x14, 0x0c, 0x0c, 0x08, 0x08, 0x10, 0x14];
// Quads among them: 0x3C, 0x2C, 0x28, 0x38.
const QUAD = [true, false, true, false, false, true, false, true];
// Per-vertex (gouraud) colours vs one flat colour.
const GOURAUD = [true, true, false, false, false, false, true, true];

const ptr = (v: number) => v & 0x7fffffff;

function readBones(dv: DataView, at: number, count: number): FieldBone[] {
	const bones: FieldBone[] = [];
	for (let i = 0; i < count; i++) {
		bones.push({ length: dv.getInt16(at + i * 4, true), parent: dv.getInt8(at + i * 4 + 2) });
	}
	return bones;
}

function readParts(dv: DataView, at: number, count: number): FieldPart[] {
	const parts: FieldPart[] = [];
	for (let i = 0; i < count; i++) {
		const o = at + i * 0x20;
		const data = ptr(dv.getUint32(o + 0x18, true));
		const counts: number[] = [];
		for (let k = 0; k < 8; k++) counts.push(dv.getUint8(o + 4 + k));
		parts.push({
			bone: dv.getUint8(o + 1),
			vertexCount: dv.getUint8(o + 2),
			counts,
			polygons: data + dv.getUint16(o + 0x0e, true),
			texCoords: data + dv.getUint16(o + 0x10, true),
			settings: data + dv.getUint16(o + 0x12, true),
			control: data + dv.getUint16(o + 0x14, true),
			data,
		});
	}
	return parts;
}

function readAnimations(dv: DataView, at: number, count: number): FieldAnimation[] {
	const out: FieldAnimation[] = [];
	for (let i = 0; i < count; i++) {
		const o = at + i * 0x10;
		const data = ptr(dv.getUint32(o + 0x0c, true));
		out.push({
			frames: dv.getUint16(o, true),
			bones: dv.getUint8(o + 2),
			frameTrans: data + dv.getUint16(o + 6, true),
			staticTrans: data + dv.getUint16(o + 8, true),
			frameRot: data + dv.getUint16(o + 0x0a, true),
			data,
		});
	}
	return out;
}

/** Parse a decompressed BCX (global field character). */
export function parseBcx(bytes: Uint8Array): FieldModel {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 0x30) throw new Error('BCX too short');
	const H = dv.getUint32(4, true);
	if (H + 0x20 > bytes.length) throw new Error('Not an FF7 BCX model');
	const nb = dv.getUint8(H + 2);
	const np = dv.getUint8(H + 3);
	const na = dv.getUint8(H + 4);
	const bonesAt = ptr(dv.getUint32(H + 0x1c, true));
	if (!nb || bonesAt + nb * 4 > bytes.length) throw new Error('BCX bone table is outside the file');
	const partsAt = bonesAt + dv.getUint16(H + 0x18, true);
	const animsAt = bonesAt + dv.getUint16(H + 0x1a, true);
	if (partsAt + np * 0x20 > bytes.length || animsAt + na * 0x10 > bytes.length) throw new Error('BCX tables are outside the file');
	return { bones: readBones(dv, bonesAt, nb), parts: readParts(dv, partsAt, np), animations: readAnimations(dv, animsAt, na) };
}

/** Local NPC models of a decompressed BSX (global characters have no geometry here). */
export function parseBsx(bytes: Uint8Array): FieldModel[] {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 0x20) throw new Error('BSX too short');
	const H = dv.getUint32(4, true);
	if (H + 0x10 > bytes.length) throw new Error('Not an FF7 BSX file');
	const count = dv.getUint32(H + 4, true);
	if (count > 64 || H + 0x10 + count * 0x30 > bytes.length) throw new Error('Not an FF7 BSX file');
	const models: FieldModel[] = [];
	for (let i = 0; i < count; i++) {
		const E = H + 0x10 + i * 0x30;
		const at = E + dv.getUint32(E + 4, true);
		const nb = dv.getUint8(E + 0x17);
		const np = dv.getUint8(E + 0x23);
		const na = dv.getUint8(E + 0x2f);
		if (!nb || !np || at + nb * 4 + np * 0x20 + na * 0x10 > bytes.length) continue;
		const partsAt = at + nb * 4;
		const animsAt = partsAt + np * 0x20;
		models.push({ bones: readBones(dv, at, nb), parts: readParts(dv, partsAt, np), animations: readAnimations(dv, animsAt, na) });
	}
	return models;
}

/** Frame `f` of `anim`: per-bone rotations (radians) and translations. */
function frame(dv: DataView, anim: FieldAnimation, f: number, boneCount: number) {
	const rot: [number, number, number][] = [];
	const trans: [number, number, number][] = [];
	const angle = (b: number) => (b / 256) * Math.PI * 2;
	for (let i = 0; i < boneCount; i++) {
		const o = anim.data + 4 + i * 8;
		if (i >= anim.bones || o + 8 > dv.byteLength) {
			rot.push([0, 0, 0]);
			trans.push([0, 0, 0]);
			continue;
		}
		const flags = dv.getUint8(o);
		const r: number[] = [];
		for (let k = 0; k < 3; k++) {
			const b = dv.getUint8(o + 1 + k);
			r.push(angle(flags & (1 << k) ? dv.getUint8(anim.frameRot + b * anim.frames + f) : b));
		}
		const t: number[] = [];
		for (let k = 0; k < 3; k++) {
			const idx = dv.getUint8(o + 4 + k);
			if (flags & (0x10 << k)) t.push(dv.getInt16(anim.frameTrans + (idx * anim.frames + f) * 2, true));
			else if (idx !== 0xff) t.push(dv.getInt16(anim.staticTrans + idx * 2, true));
			else t.push(0);
		}
		rot.push(r as [number, number, number]);
		trans.push(t as [number, number, number]);
	}
	return { rot, trans };
}

/** Samples field animations (u8 angles, keyframe tables) into bone transforms. */
export class FieldAnimator implements PsxAnimator {
	readonly clips: PsxClip[];
	private readonly dv: DataView;
	constructor(
		bytes: Uint8Array,
		private readonly model: FieldModel,
	) {
		this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		// Global characters (BCX) carry stand / walk / run; field scripts add the rest.
		const names = model.animations.length === 3 ? ['Stand', 'Walk', 'Run'] : [];
		this.clips = model.animations.map((a, i) => ({ name: names[i] ?? `Animation ${i}`, frames: a.frames }));
	}

	pose(clip: number, f: number): Pose {
		const nb = this.model.bones.length;
		const anim = clip >= 0 ? this.model.animations[clip] : undefined;
		const fr = anim ? frame(this.dv, anim, Math.max(0, Math.min(anim.frames - 1, Math.floor(f))), nb) : null;
		const R: Mat3[] = [];
		const T: Vec3[] = [];
		this.model.bones.forEach((b, i) => {
			const p = b.parent >= 0 && b.parent < i ? b.parent : -1;
			const Rp = p >= 0 ? R[p] : IDENTITY;
			const Tp = p >= 0 ? T[p] : [0, 0, 0];
			const [tx, ty, tz] = fr ? fr.trans[i] : [0, 0, 0];
			const off = apply(Rp, tx, ty, b.length + tz);
			T[i] = [Tp[0] + off[0], Tp[1] + off[1], Tp[2] + off[2]];
			R[i] = mul(Rp, fr ? rotationYXZ(...fr.rot[i]) : IDENTITY);
		});
		return { R, T };
	}
}

/** Face ids (FIELD.TDB palette / image group) of the global characters, by BCX name. */
export const FIELD_CHARACTER_FACES: Record<string, number> = {
	CLOUD: 0,
	EARITH: 1,
	BALLET: 2,
	TIFA: 3,
	RED: 4,
	CID: 5,
	YUFI: 6,
	KETCY: 7,
	VINCENT: 8,
};

export interface FieldFaceOptions {
	/** Decompressed FIELD.TDB. */
	tdb: Uint8Array;
	/** Face id (0 = Cloud, …; see {@link FIELD_CHARACTER_FACES}). */
	face: number;
}

const ATLAS = 64;

/**
 * Build the face atlas the polygons sample: both eye slots (each the
 * open-eye image, `face * 8`) side by side on top, the mouth
 * (`face * 8 + 5`) below. Colour 0x0000 is transparent.
 */
function faceAtlas(tdb: Uint8Array, face: number): Uint8Array | null {
	const dv = new DataView(tdb.buffer, tdb.byteOffset, tdb.byteLength);
	if (tdb.length < 16) return null;
	const images = dv.getUint16(4, true);
	const palettes = dv.getUint16(6, true);
	const imageAt = dv.getUint32(8, true);
	const paletteAt = dv.getUint32(12, true);
	if (face >= palettes || face * 8 + 5 >= images) return null;
	const out = new Uint8Array(ATLAS * ATLAS * 4);
	const blit = (image: number, ox: number, oy: number) => {
		for (let y = 0; y < 32; y++) {
			for (let x = 0; x < 32; x++) {
				const b = tdb[imageAt + image * 0x200 + y * 16 + (x >> 1)];
				const idx = x & 1 ? b >> 4 : b & 15;
				const c = dv.getUint16(paletteAt + face * 0x20 + idx * 2, true);
				const o = ((oy + y) * ATLAS + ox + x) * 4;
				out[o] = ((c & 31) * 255) / 31;
				out[o + 1] = (((c >> 5) & 31) * 255) / 31;
				out[o + 2] = (((c >> 10) & 31) * 255) / 31;
				out[o + 3] = c === 0 ? 0 : 255;
			}
		}
	};
	blit(face * 8, 0, 0);
	blit(face * 8, 32, 0);
	blit(face * 8 + 5, 0, 32);
	return out;
}

/** Pose (frame 0 of animation 0) and triangulate a field model. */
export function buildFieldMesh(bytes: Uint8Array, model: FieldModel, faceOptions?: FieldFaceOptions): PsxMesh {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const nb = model.bones.length;
	const { R, T } = new FieldAnimator(bytes, model).pose(model.animations.length ? 0 : -1, 0);

	const builder = new MeshBuilder();
	const atlas = faceOptions ? faceAtlas(faceOptions.tdb, faceOptions.face) : null;
	if (atlas) builder.textures.push({ width: ATLAS, height: ATLAS, pixels: atlas });
	for (const part of model.parts) {
		const rot = R[part.bone] ?? IDENTITY;
		const tr = T[part.bone] ?? [0, 0, 0];
		const locals: Vec3[] = [];
		for (let k = 0; k < part.vertexCount; k++) {
			const o = part.data + 4 + k * 8;
			if (o + 6 > bytes.length) break;
			locals.push([dv.getInt16(o, true), dv.getInt16(o + 2, true), dv.getInt16(o + 4, true)]);
		}
		const centroid = [0, 0, 0];
		for (const v of locals) for (let k = 0; k < 3; k++) centroid[k] += v[k] / Math.max(1, locals.length);
		const world = (l: Vec3): Vec3 => {
			const w = apply(rot, l[0], l[1], l[2]);
			return [w[0] + tr[0], w[1] + tr[1], w[2] + tr[2]];
		};
		let p = part.polygons;
		let textured = 0;
		for (let g = 0; g < 8; g++) {
			const size = SIZES[g];
			for (let k = 0; k < part.counts[g]; k++, p += size) {
				if (p + size > bytes.length) break;
				const n = QUAD[g] ? 4 : 3;
				// Groups 0–3 are textured: their last 4 bytes index the texcoords.
				let texture = -1;
				let uvs: [number, number][] | null = null;
				if (g < 4) {
					const ctl = bytes[part.control + textured++] ?? 0;
					const settings = part.settings + (ctl & 0x0f) * 4;
					const mode = settings + 4 <= bytes.length ? dv.getUint32(settings, true) & 0x3f : -1;
					if (atlas && (mode === 0 || mode === 1)) {
						texture = 0;
						uvs = [];
						for (let v = 0; v < n; v++) {
							const t = part.texCoords + bytes[p + size - 4 + v] * 2;
							const u = bytes[t];
							// Mouth texcoords include the 0xA0 offset of its VRAM row.
							const vv = mode === 1 ? bytes[t + 1] - 0xa0 + 32 : bytes[t + 1];
							uvs.push([(u + 0.5) / ATLAS, (vv + 0.5) / ATLAS]);
						}
					}
				}
				const corners = [];
				for (let v = 0; v < n; v++) {
					const c = GOURAUD[g] ? rgb(bytes, p + 4 + v * 4) : rgb(bytes, p + 4);
					let l: Vec3 = locals[bytes[p + v]] ?? [0, 0, 0];
					// Face decals sit on top of coplanar skin polygons (the PSX
					// draws them later); nudge them outward to avoid z-fighting.
					if (texture >= 0) l = [l[0] + (l[0] - centroid[0]) * 0.02, l[1] + (l[1] - centroid[1]) * 0.02, l[2] + (l[2] - centroid[2]) * 0.02];
					corners.push({ p: world(l), l, b: part.bone, c, uv: uvs ? uvs[v] : ([0, 0] as [number, number]) });
				}
				if (n === 4) builder.quad(texture, corners[0], corners[1], corners[2], corners[3]);
				else builder.tri(texture, corners[0], corners[1], corners[2]);
			}
		}
	}
	return builder.build(nb);
}
