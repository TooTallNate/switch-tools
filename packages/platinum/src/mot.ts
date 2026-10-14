/**
 * PlatinumGames MOT animation (Bayonetta 2 / 3, NieR:Automata, Astral
 * Chain): per-bone, per-channel curves.
 *
 * From Kerilk's `Nier Automata mot.bt` and `mot.rb` (bayonetta_tools):
 *
 *   header: 'mot\0', u32 version (0x20120405 on Bayonetta 2 / 3),
 *   u16 flags, u16 frame count, u32 records offset, u32 record count,
 *   4 unknown bytes, name (NUL-padded).
 *
 *   record (12 bytes): i16 bone id (−1: the model root), i8 channel
 *   (0–2 translation, 3–5 Euler rotation in radians, 7–9 scale),
 *   i8 interpolation type, i16 key count, i16 unknown, u32 value — a
 *   constant float for type 0, else the offset of the curve data
 *   *relative to the record*. A record with type −1 terminates.
 *
 * Interpolation types:
 *   1: one f32 per frame.
 *   2: f32 base + f32 step, then one u16 per frame (base + step·k).
 *   3: as 2 with pghalf base / step and u8 steps.
 *   4: Hermite keys {u16 frame, u16 pad, f32 value, f32 in, f32 out}.
 *   5: quantized Hermite: 6 × f32 (value, in, out as base + step) then
 *      keys {u16 frame, u16 value, u16 in, u16 out}.
 *   6: as 5 with 6 × pghalf and u8 key fields.
 *   7: as 6 with each key's frame relative to the previous key.
 *   8: as 6 with a big-endian u16 absolute frame (5-byte keys).
 *
 * Between keys k0 and k1 the curve is cubic Hermite with k0's out
 * tangent and k1's in tangent, t in [0, 1] across the gap; outside the
 * keys it holds the end values.
 *
 * "pghalf" is Platinum's 16-bit float: 1 sign bit, 6 exponent bits
 * (bias 47), 9 mantissa bits.
 */

export interface MotCurve {
	/** Bone id (resolve with `Wmb.boneIndexForId`); −1 for the model root. */
	boneId: number;
	/** 0–2 translation, 3–5 rotation (radians), 7–9 scale. */
	channel: number;
	/** Value at a (fractional) frame. */
	sample(frame: number): number;
}

export interface Mot {
	name: string;
	version: number;
	flags: number;
	frameCount: number;
	curves: MotCurve[];
}

export function isMot(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x6d && head[1] === 0x6f && head[2] === 0x74 && head[3] === 0x00;
}

export function pghalf(h: number): number {
	const sign = h & 0x8000 ? -1 : 1;
	const e = (h >> 9) & 0x3f;
	const m = h & 0x1ff;
	if (e === 0x3f) return m ? NaN : sign * Infinity;
	if (e === 0) return sign * (m / 512) * 2 ** -46;
	return sign * (1 + m / 512) * 2 ** (e - 47);
}

interface Key {
	frame: number;
	p: number;
	m0: number;
	m1: number;
}

function hermite(keys: Key[], frame: number): number {
	if (keys.length === 0) return 0;
	if (frame <= keys[0]!.frame) return keys[0]!.p;
	const last = keys[keys.length - 1]!;
	if (frame >= last.frame) return last.p;
	let lo = 0;
	let hi = keys.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (keys[mid]!.frame <= frame) lo = mid;
		else hi = mid;
	}
	const a = keys[lo]!;
	const b = keys[hi]!;
	const span = b.frame - a.frame;
	if (span <= 0) return b.p;
	const t = (frame - a.frame) / span;
	const t2 = t * t;
	const t3 = t2 * t;
	return (2 * t3 - 3 * t2 + 1) * a.p + (t3 - 2 * t2 + t) * a.m1 + (-2 * t3 + 3 * t2) * b.p + (t3 - t2) * b.m0;
}

function linear(values: number[], frame: number): number {
	if (values.length === 0) return 0;
	if (frame <= 0) return values[0]!;
	if (frame >= values.length - 1) return values[values.length - 1]!;
	const i = Math.floor(frame);
	const f = frame - i;
	return values[i]! * (1 - f) + values[i + 1]! * f;
}

export function parseMot(bytes: Uint8Array): Mot {
	if (!isMot(bytes)) throw new Error('Not a MOT animation');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint32(4, true);
	const flags = dv.getUint16(8, true);
	const frameCount = dv.getUint16(0x0a, true);
	const recOff = dv.getUint32(0x0c, true);
	const recN = dv.getUint32(0x10, true);
	let nameEnd = 0x18;
	while (nameEnd < Math.min(bytes.length, 0x28) && bytes[nameEnd] !== 0) nameEnd++;
	const name = new TextDecoder().decode(bytes.subarray(0x18, nameEnd));
	const f32 = (o: number) => dv.getFloat32(o, true);
	const u16 = (o: number) => dv.getUint16(o, true);
	const ph = (o: number) => pghalf(u16(o));
	const curves: MotCurve[] = [];
	for (let i = 0; i < recN; i++) {
		const r = recOff + i * 12;
		if (r + 12 > bytes.length) break;
		const boneId = dv.getInt16(r, true);
		const channel = dv.getInt8(r + 2);
		const type = dv.getInt8(r + 3);
		const n = dv.getInt16(r + 4, true);
		if (type === -1 || boneId === 0x7fff) break;
		if (type === 0) {
			const v = f32(r + 8);
			curves.push({ boneId, channel, sample: () => v });
			continue;
		}
		const d = r + dv.getUint32(r + 8, true);
		try {
			switch (type) {
				case 1: {
					const vals = Array.from({ length: n }, (_, k) => f32(d + k * 4));
					curves.push({ boneId, channel, sample: (f) => linear(vals, f) });
					break;
				}
				case 2: {
					const p = f32(d);
					const dp = f32(d + 4);
					const vals = Array.from({ length: n }, (_, k) => p + dp * u16(d + 8 + k * 2));
					curves.push({ boneId, channel, sample: (f) => linear(vals, f) });
					break;
				}
				case 3: {
					const p = ph(d);
					const dp = ph(d + 2);
					const vals = Array.from({ length: n }, (_, k) => p + dp * bytes[d + 4 + k]!);
					curves.push({ boneId, channel, sample: (f) => linear(vals, f) });
					break;
				}
				case 4: {
					const keys = Array.from({ length: n }, (_, k) => {
						const o = d + k * 16;
						return { frame: u16(o), p: f32(o + 4), m0: f32(o + 8), m1: f32(o + 12) };
					});
					curves.push({ boneId, channel, sample: (f) => hermite(keys, f) });
					break;
				}
				case 5: {
					const [p, dp, m0, dm0, m1, dm1] = [0, 1, 2, 3, 4, 5].map((k) => f32(d + k * 4)) as [number, number, number, number, number, number];
					const keys = Array.from({ length: n }, (_, k) => {
						const o = d + 24 + k * 8;
						return { frame: u16(o), p: p + dp * u16(o + 2), m0: m0 + dm0 * u16(o + 4), m1: m1 + dm1 * u16(o + 6) };
					});
					curves.push({ boneId, channel, sample: (f) => hermite(keys, f) });
					break;
				}
				case 6:
				case 7:
				case 8: {
					const [p, dp, m0, dm0, m1, dm1] = [0, 1, 2, 3, 4, 5].map((k) => ph(d + k * 2)) as [number, number, number, number, number, number];
					const keys: Key[] = [];
					let frame = 0;
					for (let k = 0; k < n; k++) {
						if (type === 8) {
							const o = d + 12 + k * 5;
							frame = dv.getUint16(o, false);
							keys.push({ frame, p: p + dp * bytes[o + 2]!, m0: m0 + dm0 * bytes[o + 3]!, m1: m1 + dm1 * bytes[o + 4]! });
						} else {
							const o = d + 12 + k * 4;
							frame = type === 7 ? frame + bytes[o]! : bytes[o]!;
							keys.push({ frame, p: p + dp * bytes[o + 1]!, m0: m0 + dm0 * bytes[o + 2]!, m1: m1 + dm1 * bytes[o + 3]! });
						}
					}
					curves.push({ boneId, channel, sample: (f) => hermite(keys, f) });
					break;
				}
				default:
					break;
			}
		} catch {
			// A curve pointing out of bounds is dropped; the rest still play.
		}
	}
	return { name, version, flags, frameCount, curves };
}
