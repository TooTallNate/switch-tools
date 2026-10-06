/**
 * Unity `AnimationClip` (class 74) decoder for Mecanim ("muscle")
 * clips.
 *
 * Built games store clip keys in `m_MuscleClip.m_Clip`, not in the
 * editor-style `m_RotationCurves` / `m_PositionCurves` arrays (those
 * are empty unless the clip is `m_Legacy`). The keys are split three
 * ways:
 *
 *   - **Streamed clip**: a `uint[]` blob of frames, each `f32 time,
 *     i32 keyCount, keyCount × (i32 curveIndex, f32 coeff[4])`. A key's
 *     coefficients are the cubic polynomial for the segment that starts
 *     there: `v(t) = ((c0·dt + c1)·dt + c2)·dt + c3`, with `dt` measured
 *     from the key. The first frame sits at −FLT_MAX and carries every
 *     curve's initial value.
 *   - **Dense clip**: `m_FrameCount × m_CurveCount` samples at
 *     `m_SampleRate`, linearly interpolated.
 *   - **Constant clip**: one value per curve.
 *
 * Curve indices run streamed → dense → constant. `m_ClipBindingConstant
 * .genericBindings` assigns them, in order, to properties: a Transform
 * binding (`typeID` 4) consumes 3 curves for position (attribute 1),
 * scale (3) and Euler rotation (4), or 4 for a quaternion rotation (2).
 * Every other binding consumes 1. Bindings name their target by the
 * CRC32 of its transform path relative to the animated root (see
 * {@link unityPathHash}).
 *
 * Values are in Unity's left-handed space. Humanoid muscle curves
 * (which drive an Avatar rather than Transforms directly) are not
 * interpreted.
 *
 * Layout reference: AssetStudio `AnimationClipConverter.cs` (MIT).
 */

/** Transform property a track animates. */
export type UnityTransformProperty = 'position' | 'rotation' | 'scale' | 'euler';

export interface UnityTransformTrack {
	/** CRC32 of the transform path (see {@link unityPathHash}). */
	pathHash: number;
	property: UnityTransformProperty;
	/** Curve indices for each component (x, y, z[, w]). */
	curves: number[];
}

export interface UnityAnimationClip {
	name: string;
	/** Clip length in seconds. */
	duration: number;
	/** Authoring sample rate (frames per second). */
	sampleRate: number;
	loop: boolean;
	/** Transform tracks, one per animated property. */
	tracks: UnityTransformTrack[];
	/** Total number of curves (streamed + dense + constant). */
	curveCount: number;
	/** Evaluate every curve at `time` seconds (clamped to the clip). */
	sample(time: number, out?: Float32Array): Float32Array;
}

interface StreamedKey {
	time: number;
	c0: number;
	c1: number;
	c2: number;
	c3: number;
}

const num = (v: unknown): number =>
	typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0);

function floatsOf(v: unknown): Float32Array {
	if (v instanceof Float32Array) return v;
	if (Array.isArray(v)) return Float32Array.from(v as number[]);
	return new Float32Array(0);
}

/** Reinterpret a `uint[]` (as decoded numbers) as little-endian bytes. */
function uintArrayBytes(v: unknown): DataView {
	if (v instanceof Uint8Array) return new DataView(v.buffer, v.byteOffset, v.byteLength);
	const words = Array.isArray(v) ? (v as number[]) : [];
	const dv = new DataView(new ArrayBuffer(words.length * 4));
	words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
	return dv;
}

/** Decode the streamed clip into per-curve key lists (sorted by time). */
function decodeStreamed(streamed: Record<string, unknown> | undefined): StreamedKey[][] {
	const curveCount = num(streamed?.curveCount);
	const curves: StreamedKey[][] = Array.from({ length: curveCount }, () => []);
	if (!streamed || curveCount === 0) return curves;
	const dv = uintArrayBytes(streamed.data);
	let pos = 0;
	while (pos + 8 <= dv.byteLength) {
		const time = dv.getFloat32(pos, true);
		const keyCount = dv.getInt32(pos + 4, true);
		pos += 8;
		if (keyCount < 0 || pos + keyCount * 20 > dv.byteLength) break;
		for (let k = 0; k < keyCount; k++) {
			const index = dv.getInt32(pos, true);
			const key = {
				time,
				c0: dv.getFloat32(pos + 4, true),
				c1: dv.getFloat32(pos + 8, true),
				c2: dv.getFloat32(pos + 12, true),
				c3: dv.getFloat32(pos + 16, true),
			};
			pos += 20;
			if (index >= 0 && index < curveCount) curves[index]!.push(key);
		}
	}
	return curves;
}

function evalStreamed(keys: StreamedKey[], t: number): number {
	if (keys.length === 0) return 0;
	// Last key at or before `t`.
	let lo = 0;
	let hi = keys.length - 1;
	if (t < keys[0]!.time) return keys[0]!.c3;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (keys[mid]!.time <= t) lo = mid;
		else hi = mid - 1;
	}
	const k = keys[lo]!;
	// The −FLT_MAX lead-in key (and any +FLT_MAX terminator) is a constant.
	if (!(Math.abs(k.time) < 1e30)) return k.c3;
	const dt = t - k.time;
	return ((k.c0 * dt + k.c1) * dt + k.c2) * dt + k.c3;
}

/** Number of curves a binding consumes. */
function bindingCurveCount(b: Record<string, unknown>): number {
	if (num(b.typeID) === 4) {
		const attr = num(b.attribute);
		if (attr === 2) return 4;
		if (attr === 1 || attr === 3 || attr === 4) return 3;
	}
	return 1;
}

const TRANSFORM_PROPERTY: Record<number, UnityTransformProperty> = {
	1: 'position',
	2: 'rotation',
	3: 'scale',
	4: 'euler',
};

/** Decode a TypeTree-parsed `AnimationClip`. */
export function decodeUnityAnimationClip(clip: Record<string, unknown>): UnityAnimationClip {
	const name = String(clip.m_Name ?? '');
	const muscle = clip.m_MuscleClip as Record<string, unknown> | undefined;
	const data = ((muscle?.m_Clip as Record<string, unknown> | undefined)?.data ?? {}) as Record<
		string,
		unknown
	>;
	const streamed = decodeStreamed(data.m_StreamedClip as Record<string, unknown> | undefined);
	const dense = (data.m_DenseClip ?? {}) as Record<string, unknown>;
	const denseCount = num(dense.m_CurveCount);
	const denseFrames = num(dense.m_FrameCount);
	const denseRate = num(dense.m_SampleRate) || 30;
	const denseBegin = num(dense.m_BeginTime);
	const denseSamples = floatsOf(dense.m_SampleArray);
	const constants = floatsOf((data.m_ConstantClip as Record<string, unknown> | undefined)?.data);
	const curveCount = streamed.length + denseCount + constants.length;

	const tracks: UnityTransformTrack[] = [];
	const bindings =
		((clip.m_ClipBindingConstant as Record<string, unknown> | undefined)?.genericBindings as
			| unknown[]
			| undefined) ?? [];
	let cursor = 0;
	for (const raw of bindings) {
		const b = raw as Record<string, unknown>;
		const n = bindingCurveCount(b);
		const property = num(b.typeID) === 4 ? TRANSFORM_PROPERTY[num(b.attribute)] : undefined;
		if (property && cursor + n <= curveCount) {
			tracks.push({
				pathHash: num(b.path) >>> 0,
				property,
				curves: Array.from({ length: n }, (_, k) => cursor + k),
			});
		}
		cursor += n;
	}

	const start = num(muscle?.m_StartTime);
	const stop = num(muscle?.m_StopTime);
	const duration = Math.max(0, stop - start);
	const sampleRate = num(clip.m_SampleRate) || 30;

	const sample = (time: number, out = new Float32Array(curveCount)): Float32Array => {
		const t = start + Math.min(Math.max(time, 0), duration);
		let i = 0;
		for (; i < streamed.length; i++) out[i] = evalStreamed(streamed[i]!, t);
		if (denseCount > 0 && denseFrames > 0) {
			const f = Math.min(Math.max((t - denseBegin) * denseRate, 0), denseFrames - 1);
			const f0 = Math.floor(f);
			const f1 = Math.min(f0 + 1, denseFrames - 1);
			const a = f - f0;
			for (let k = 0; k < denseCount; k++) {
				const v0 = denseSamples[f0 * denseCount + k] ?? 0;
				const v1 = denseSamples[f1 * denseCount + k] ?? 0;
				out[i + k] = v0 + (v1 - v0) * a;
			}
		}
		i += denseCount;
		out.set(constants, i);
		return out;
	};

	return {
		name,
		duration,
		sampleRate,
		loop: Boolean((muscle as Record<string, unknown> | undefined)?.m_LoopTime),
		tracks,
		curveCount,
		sample,
	};
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/**
 * Unity's binding path hash: CRC32 (zlib polynomial) of the UTF-8
 * transform path relative to the animated root, `/`-separated (e.g.
 * `"Hips/Spine/Head"`). The root itself is the empty path.
 */
export function unityPathHash(path: string): number {
	const bytes = new TextEncoder().encode(path);
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
