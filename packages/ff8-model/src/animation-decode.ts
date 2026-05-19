/**
 * FFVIII MCH bone-rotation packing.
 *
 * Each per-bone rotation in an animation frame is stored as 4
 * bytes — `b0..b3` — encoding three signed 12-bit values
 * (rotX, rotY, rotZ). `b0..b2` provide the low 10 bits (well,
 * upper 10 bits after a `<<2` shift — see below) of each axis;
 * `b3` packs the remaining 2 bits per axis.
 *
 * IMPORTANT: deling's reference implementation has a long-
 * standing bug where it multiplies `b3 >> 0/1/2` instead of
 * shifting; OpenVIII (Reloaded) fixed it by reading 2-bit fields
 * at bit offsets 0/2/4. We follow the OpenVIII formula:
 *
 *     x = (b0 << 2) | (((b3 >> 0) & 0b11) << 10)
 *     y = (b1 << 2) | (((b3 >> 2) & 0b11) << 10)
 *     z = (b2 << 2) | (((b3 >> 4) & 0b11) << 10)
 *
 * The result is a 12-bit unsigned value in [0, 4095]; values
 * ≥ 2048 represent negative rotations and are sign-extended:
 *
 *     signed = value < 2048 ? value : value - 4096
 *
 * Final angle in degrees = `signed / 4096 * 360` (a full turn
 * is 4096 units).
 *
 * The high 2 bits of `b3` (mask `0xC0`) are unused/reserved.
 */

/**
 * Decode a single packed 4-byte bone rotation into an unsigned
 * 12-bit triplet. Each component is in `[0, 4095]`; callers
 * typically want the signed / degrees form via {@link unpackRotationSigned}
 * or {@link unpackRotationDegrees}.
 */
export function unpackRotationRaw(
	b0: number,
	b1: number,
	b2: number,
	b3: number,
): [number, number, number] {
	const x = ((b0 & 0xff) << 2) | (((b3 >> 0) & 0b11) << 10);
	const y = ((b1 & 0xff) << 2) | (((b3 >> 2) & 0b11) << 10);
	const z = ((b2 & 0xff) << 2) | (((b3 >> 4) & 0b11) << 10);
	return [x & 0xfff, y & 0xfff, z & 0xfff];
}

/** Sign-extend a 12-bit value. */
function sext12(v: number): number {
	return v < 0x800 ? v : v - 0x1000;
}

/**
 * Decode a packed rotation to three signed 12-bit values in
 * `[-2048, 2047]`. A full rotation is 4096 units.
 */
export function unpackRotationSigned(
	b0: number,
	b1: number,
	b2: number,
	b3: number,
): [number, number, number] {
	const [x, y, z] = unpackRotationRaw(b0, b1, b2, b3);
	return [sext12(x), sext12(y), sext12(z)];
}

/**
 * Decode a packed rotation to three angles in DEGREES.
 * `(rawSigned / 4096) * 360`.
 */
export function unpackRotationDegrees(
	b0: number,
	b1: number,
	b2: number,
	b3: number,
): [number, number, number] {
	const [x, y, z] = unpackRotationSigned(b0, b1, b2, b3);
	const k = 360 / 4096;
	return [x * k, y * k, z * k];
}
