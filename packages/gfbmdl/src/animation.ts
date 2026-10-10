/**
 * GFBANM animation parser + sampler (GFLX schema).
 *
 *   Animation { Config{unk, frameCount, fps}, BoneList{Bones[], Defaults},
 *               MaterialList, GroupList, TriggerList }
 *
 * Bone tracks are FlatBuffers unions: a `u8` type tag slot followed by
 * the value table slot. Tag 1 = fixed (one value), 2 = dynamic (one
 * value per frame), 3 = framed (u16 key frames + values). Rotations
 * are 48-bit "smallest three" packed quaternions.
 *
 * Correction to Switch-Toolbox's schema: in Let's Go files
 * `Trigger.Parameter` is a *vector* of parameters, not a single table.
 */

import { FlatBuffer, type Table } from './flatbuffers.js';
import { slerp, type Quat, type Vec3 } from './math.js';

export type GfbanmTrackKind = 'fixed' | 'dynamic' | 'framed';

export interface GfbanmTrack<T> {
	kind: GfbanmTrackKind;
	/** Key frame numbers (framed tracks only). */
	frames: Uint16Array | null;
	values: T[];
}

export interface GfbanmBoneTrack {
	name: string;
	scale: GfbanmTrack<Vec3> | null;
	rotation: GfbanmTrack<Quat> | null;
	translation: GfbanmTrack<Vec3> | null;
}

export interface GfbanmMaterialTrack {
	name: string;
	/** Float parameter tracks, e.g. `ColorUVTranslateU`. */
	values: { name: string; track: GfbanmTrack<number> }[];
	/** Boolean switch tracks (values are 0 / 1). */
	switches: { name: string; track: GfbanmTrack<number> }[];
	/** Vector (colour) tracks. */
	vectors: { name: string; track: GfbanmTrack<Vec3> }[];
}

export interface GfbanmVisibilityTrack {
	/** Group bone name, e.g. `pm0025_00_BodySkin`. */
	name: string;
	/** 0 = hidden, nonzero = visible. */
	track: GfbanmTrack<number>;
}

export interface GfbanmTrigger {
	name: string;
	start: number;
	end: number;
	params: { name: string; value: number | string | null }[];
}

export interface GfbanmAnimation {
	frameCount: number;
	fps: number;
	bones: GfbanmBoneTrack[];
	materials: GfbanmMaterialTrack[];
	visibility: GfbanmVisibilityTrack[];
	triggers: GfbanmTrigger[];
}

const KINDS: (GfbanmTrackKind | null)[] = [null, 'fixed', 'dynamic', 'framed'];

// ---- packed quaternion (port of Switch-Toolbox `PackedToQuat`) ----
const QUAT_SWIZZLE = [
	[0, 3, 2, 1],
	[3, 0, 2, 1],
	[3, 2, 0, 1],
	[3, 2, 1, 0],
];
const QUAT_SCALE = 1 / (0x399e * Math.SQRT2);

function unpackS15(u: number): number {
	const sign = (u >> 14) & 1;
	u &= 0x3fff;
	if (sign === 0) u -= 0x4000;
	return u;
}

/** Decode a 48-bit packed quaternion from its three stored u16s. */
export function unpackQuaternion(a: number, b: number, c: number): Quat {
	// 48-bit value = c:b:a. Split into a 45-bit payload and a 3-bit tag
	// without BigInt: low 3 bits of `a` are the tag.
	const extra = a & 7;
	// payload bits 0..44 = (c << 29) | (b << 13) | (a >> 3)
	const lo = (a >>> 3) | ((b & 0x3) << 13); // bits 0..14
	const mid = (b >>> 2) | ((c & 0x1) << 14); // bits 15..29
	const hi = c >>> 1; // bits 30..44
	const x = unpackS15(hi & 0x7fff) * QUAT_SCALE;
	const y = unpackS15(mid & 0x7fff) * QUAT_SCALE;
	const z = unpackS15(lo & 0x7fff) * QUAT_SCALE;
	const q = [Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)), x, y, z];
	const s = QUAT_SWIZZLE[extra & 3];
	const r: Quat = [q[s[0]], q[s[1]], q[s[2]], q[s[3]]];
	if (extra >> 2) {
		r[0] = -r[0];
		r[1] = -r[1];
		r[2] = -r[2];
		r[3] = -r[3];
	}
	return r;
}

function readVec3At(view: DataView, p: number): Vec3 {
	return [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)];
}

function readQuatAt(view: DataView, p: number): Quat {
	return unpackQuaternion(view.getUint16(p, true), view.getUint16(p + 2, true), view.getUint16(p + 4, true));
}

/** Read a vector of inline structs of `size` bytes. */
function structVector<T>(t: Table, slot: number, size: number, read: (p: number) => T): T[] {
	const v = t.vector(slot);
	if (!v) return [];
	const out: T[] = new Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = read(v.start + i * size);
	return out;
}

/**
 * Read a union track. `fixed` reads one value from slot 0, `dynamic`
 * a vector from slot 0, `framed` frames from slot 0 and values from
 * slot 1.
 */
function readTrack<T>(
	owner: Table,
	typeSlot: number,
	valueSlot: number,
	readFixed: (t: Table) => T | null,
	readVec: (t: Table, slot: number) => T[],
): GfbanmTrack<T> | null {
	const kind = KINDS[owner.u8(typeSlot)] ?? null;
	const t = owner.table(valueSlot);
	if (!kind || !t) return null;
	if (kind === 'fixed') {
		const v = readFixed(t);
		return v === null ? null : { kind, frames: null, values: [v] };
	}
	if (kind === 'dynamic') {
		const values = readVec(t, 0);
		return values.length ? { kind, frames: null, values } : null;
	}
	const frames = t.u16s(0);
	const values = readVec(t, 1);
	if (!frames || !values.length) return null;
	return { kind, frames, values };
}

function vecTrack(owner: Table, typeSlot: number, valueSlot: number): GfbanmTrack<Vec3> | null {
	const view = owner.view;
	return readTrack(
		owner,
		typeSlot,
		valueSlot,
		(t) => {
			const p = t.struct(0);
			return p < 0 ? null : readVec3At(view, p);
		},
		(t, slot) => structVector(t, slot, 12, (p) => readVec3At(view, p)),
	);
}

function quatTrack(owner: Table, typeSlot: number, valueSlot: number): GfbanmTrack<Quat> | null {
	const view = owner.view;
	return readTrack(
		owner,
		typeSlot,
		valueSlot,
		(t) => {
			const p = t.struct(0);
			return p < 0 ? [0, 0, 0, 1] : readQuatAt(view, p);
		},
		(t, slot) => structVector(t, slot, 6, (p) => readQuatAt(view, p)),
	);
}

function floatTrack(owner: Table, typeSlot: number, valueSlot: number): GfbanmTrack<number> | null {
	return readTrack(
		owner,
		typeSlot,
		valueSlot,
		(t) => t.f32(0),
		(t, slot) => Array.from(t.f32s(slot) ?? []),
	);
}

/** Boolean tracks: fixed = byte, dynamic / framed values = u16. */
function boolTrack(owner: Table, typeSlot: number, valueSlot: number): GfbanmTrack<number> | null {
	return readTrack(
		owner,
		typeSlot,
		valueSlot,
		(t) => t.u8(0),
		(t, slot) => Array.from(t.u16s(slot) ?? []),
	);
}

export function parseGfbanm(bytes: Uint8Array): GfbanmAnimation {
	if (bytes.length < 8) throw new Error('Buffer too small to be a GFBANM');
	const r = new FlatBuffer(bytes).root();
	if (!r.isSane()) throw new Error('Not a GFBANM (invalid FlatBuffers root table)');
	const cfg = r.table(0);
	const bones = (r.table(1)?.tables(0) ?? []).map(
		(b): GfbanmBoneTrack => ({
			name: b.str(0) ?? '',
			scale: vecTrack(b, 1, 2),
			rotation: quatTrack(b, 3, 4),
			translation: vecTrack(b, 5, 6),
		}),
	);
	const materials = (r.table(2)?.tables(0) ?? []).map(
		(m): GfbanmMaterialTrack => ({
			name: m.str(0) ?? '',
			switches: m
				.tables(1)
				.map((s) => ({ name: s.str(0) ?? '', track: boolTrack(s, 1, 2) }))
				.filter((x): x is { name: string; track: GfbanmTrack<number> } => x.track !== null),
			values: m
				.tables(2)
				.map((s) => ({ name: s.str(0) ?? '', track: floatTrack(s, 1, 2) }))
				.filter((x): x is { name: string; track: GfbanmTrack<number> } => x.track !== null),
			vectors: m
				.tables(3)
				.map((s) => ({ name: s.str(0) ?? '', track: vecTrack(s, 1, 2) }))
				.filter((x): x is { name: string; track: GfbanmTrack<Vec3> } => x.track !== null),
		}),
	);
	const visibility = (r.table(3)?.tables(0) ?? [])
		.map((g) => ({ name: g.str(0) ?? '', track: boolTrack(g, 1, 2) }))
		.filter((x): x is GfbanmVisibilityTrack => x.track !== null);
	const triggers = (r.table(4)?.tables(0) ?? []).map(
		(t): GfbanmTrigger => ({
			name: t.str(0) ?? '',
			start: t.i32(1),
			end: t.i32(2),
			params: safeTriggerParams(t),
		}),
	);
	return {
		frameCount: cfg?.u32(1) ?? 0,
		fps: cfg?.u32(2) || 30,
		bones,
		materials,
		visibility,
		triggers,
	};
}

function safeTriggerParams(t: Table): GfbanmTrigger['params'] {
	try {
		return t.tables(3).map((p) => {
			const type = p.u8(1);
			const v = p.table(2);
			let value: number | string | null = null;
			if (v) {
				if (type === 1) value = v.i32(0);
				else if (type === 2) value = v.f32(0);
				else if (type === 3) value = v.i8(0);
				else if (type === 4) value = v.str(0);
			}
			return { name: p.str(0) ?? '', value };
		});
	} catch {
		return [];
	}
}

// ---- sampling ----

function bracket(frames: Uint16Array, frame: number): [number, number, number] {
	const n = frames.length;
	if (frame <= frames[0]) return [0, 0, 0];
	if (frame >= frames[n - 1]) return [n - 1, n - 1, 0];
	let lo = 0, hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (frames[mid] <= frame) lo = mid;
		else hi = mid;
	}
	const span = frames[hi] - frames[lo];
	return [lo, hi, span > 0 ? (frame - frames[lo]) / span : 0];
}

function sampleWith<T>(track: GfbanmTrack<T>, frame: number, lerp: (a: T, b: T, t: number) => T): T {
	const { values } = track;
	if (track.kind === 'fixed' || values.length === 1) return values[0];
	if (track.kind === 'dynamic') {
		const f = Math.max(0, Math.min(values.length - 1, frame));
		const i = Math.floor(f);
		const j = Math.min(values.length - 1, i + 1);
		return i === j ? values[i] : lerp(values[i], values[j], f - i);
	}
	const [i, j, t] = bracket(track.frames!, frame);
	const a = values[Math.min(i, values.length - 1)];
	const b = values[Math.min(j, values.length - 1)];
	return i === j ? a : lerp(a, b, t);
}

const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
	a[2] + (b[2] - a[2]) * t,
];
const lerpNum = (a: number, b: number, t: number) => a + (b - a) * t;
const stepNum = (a: number) => a;

export function sampleVec3(track: GfbanmTrack<Vec3>, frame: number): Vec3 {
	return sampleWith(track, frame, lerpVec);
}

export function sampleQuat(track: GfbanmTrack<Quat>, frame: number): Quat {
	return sampleWith(track, frame, slerp);
}

export function sampleFloat(track: GfbanmTrack<number>, frame: number): number {
	return sampleWith(track, frame, lerpNum);
}

/** Boolean / stepped tracks: no interpolation. */
export function sampleStep(track: GfbanmTrack<number>, frame: number): number {
	return sampleWith(track, Math.floor(frame), stepNum);
}
