/**
 * Trinity animation companions. A Legends: Arceus clip is a pair of
 * files sharing a stem (`pm0094_00_00_00000_defaultwait01_loop`):
 *
 *   .tranm  bone tracks — a GFBANM clip (parse with
 *           `parseGfbanm` from `@tootallnate/gfbmdl`)
 *   .tracm  per mesh shape: visibility, and per material: curves for
 *           float4 parameters (four channels) plus one-off initial
 *           values — eye expressions slide `UVScaleOffset`, highlights
 *           `UVScaleOffset1`, cutscenes tint `BaseColorLayer*`
 *
 * Visibility matters for models that ship alternative meshes: Gengar
 * has both `normaltongue` and `longtongue` shapes, and all but its
 * tongue attacks hide the long one.
 *
 * Schema: pkZukan/PokeDocs `LA/Flatbuffers/Animation/tracm.fbs`.
 */

import { FlatBuffer, type Table } from '@tootallnate/gfbmdl';

/** One curve: `(time in frames, value)` keys, sorted by time. */
export type TracmCurve = { time: number; value: number }[];

export interface TracmClip {
	/** Clip length in frames. */
	frameCount: number;
	fps: number;
	/** Mesh shape name → visible, for shapes with a visibility track. */
	visibility: Map<string, boolean>;
	/** Material name → parameter name → RGBA channel curves (float4 params). */
	curves: Map<string, Map<string, [TracmCurve, TracmCurve, TracmCurve, TracmCurve]>>;
	/** Material name → parameter name → value set when the clip starts (float params). */
	initial: Map<string, Map<string, number>>;
}

export function parseTracm(bytes: Uint8Array): TracmClip {
	const t = new FlatBuffer(bytes).root();
	if (!t.isSane()) throw new Error('Not a FlatBuffer');
	const config = t.table(0);
	const visibility = new Map<string, boolean>();
	const curves: TracmClip['curves'] = new Map();
	const initial: TracmClip['initial'] = new Map();
	const keys = (list: Table | null): TracmCurve =>
		(list?.tables(0) ?? []).map((v) => ({ time: v.f32(0), value: v.f32(1) })).sort((a, b) => a.time - b.time);
	for (const track of t.tables(1)) {
		// material_animation → material_track[] (name, init_values, anim_values).
		for (const m of track.table(4)?.tables(2) ?? []) {
			const name = m.str(0);
			if (!name) continue;
			for (const iv of m.tables(1)) {
				const param = iv.str(0);
				const first = keys(iv.table(1))[0];
				if (!param || !first) continue;
				if (!initial.has(name)) initial.set(name, new Map());
				initial.get(name)!.set(param, first.value);
			}
			for (const av of m.tables(2)) {
				const param = av.str(0);
				const ch = av.table(1);
				if (!param || !ch) continue;
				if (!curves.has(name)) curves.set(name, new Map());
				curves.get(name)!.set(param, [keys(ch.table(0)), keys(ch.table(1)), keys(ch.table(2)), keys(ch.table(3))]);
			}
		}
		const path = track.str(0);
		// material_flags → info → union { type (u8), TrackFlag_Bool { value } }.
		const info = track.table(5)?.table(2);
		if (!path || !info || info.u8(0) === 0) continue;
		visibility.set(path, info.table(1)?.bool(0, false) ?? false);
	}
	return { frameCount: config?.u32(1) ?? 0, fps: config?.u32(2) ?? 0, visibility, curves, initial };
}

function sampleCurve(c: TracmCurve, frame: number, def: number): number {
	if (!c.length) return def;
	if (frame <= c[0]!.time) return c[0]!.value;
	for (let i = 1; i < c.length; i++) {
		const b = c[i]!;
		if (frame <= b.time) {
			const a = c[i - 1]!;
			const span = b.time - a.time;
			return span > 0 ? a.value + ((b.value - a.value) * (frame - a.time)) / span : b.value;
		}
	}
	return c[c.length - 1]!.value;
}

/**
 * The clip's float4 parameter values at `frame`, per material
 * (channels without keys keep `defaults[param]`).
 */
export function sampleTracmMaterials(
	clip: TracmClip,
	frame: number,
	defaults: (material: string, param: string) => readonly number[] | undefined = () => undefined,
): Map<string, Record<string, [number, number, number, number]>> {
	const out = new Map<string, Record<string, [number, number, number, number]>>();
	for (const [mat, params] of clip.curves) {
		const rec: Record<string, [number, number, number, number]> = {};
		for (const [param, ch] of params) {
			const d = defaults(mat, param) ?? [0, 0, 0, 0];
			rec[param] = [0, 1, 2, 3].map((i) => sampleCurve(ch[i]!, frame, d[i] ?? 0)) as [number, number, number, number];
		}
		out.set(mat, rec);
	}
	return out;
}
