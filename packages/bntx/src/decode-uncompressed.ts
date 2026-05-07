/**
 * Uncompressed-format decoders. All formats produce row-major
 * RGBA8 output suitable for `<canvas>` / `ImageData`.
 *
 * Reference: AboodXD's `formConv.py` from BNTX-Editor.
 */

/** sRGB → linear conversion lookup, 8-bit precision. */
const SRGB_TO_LINEAR = (() => {
	const t = new Uint8Array(256);
	for (let i = 0; i < 256; i++) {
		const c = i / 255;
		const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		t[i] = Math.round(Math.max(0, Math.min(1, lin)) * 255);
	}
	return t;
})();

/**
 * Linear → sRGB conversion lookup. We only use this if a caller
 * explicitly asks to render in linear-light space; by default we
 * leave SRGB-encoded values as-is so the browser does the right
 * thing when it composites them onto a (sRGB) canvas.
 */
void SRGB_TO_LINEAR;

/**
 * Decode `R8_G8_B8_A8_UNORM` (0x0b01) or `R8_G8_B8_A8_SRGB` (0x0b06).
 * No-op copy — the bytes are already RGBA8 in source order.
 */
export function decodeRgba8(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	const n = Math.min(bytes.length, out.length);
	out.set(bytes.subarray(0, n));
	// If the source was shorter than expected (truncated mip), the
	// rest stays at zero (alpha 0). That way browsers render the
	// missing region as transparent rather than as undefined garbage.
	return out;
}

/** Decode `B8_G8_R8_A8_UNORM` (0x0c01) — swap B/R per pixel. */
export function decodeBgra8(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const sb = bytes[i * 4 + 0] ?? 0;
		const sg = bytes[i * 4 + 1] ?? 0;
		const sr = bytes[i * 4 + 2] ?? 0;
		const sa = bytes[i * 4 + 3] ?? 0;
		out[i * 4 + 0] = sr;
		out[i * 4 + 1] = sg;
		out[i * 4 + 2] = sb;
		out[i * 4 + 3] = sa;
	}
	return out;
}

/** Decode `R8_UNORM` (0x0201) — single-channel as opaque grayscale. */
export function decodeR8(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const v = bytes[i] ?? 0;
		out[i * 4 + 0] = v;
		out[i * 4 + 1] = v;
		out[i * 4 + 2] = v;
		out[i * 4 + 3] = 255;
	}
	return out;
}

/** Decode `R8_G8_UNORM` (0x0901) — two channels: R = red, G = green, B=0. */
export function decodeRg8(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		out[i * 4 + 0] = bytes[i * 2] ?? 0;
		out[i * 4 + 1] = bytes[i * 2 + 1] ?? 0;
		out[i * 4 + 2] = 0;
		out[i * 4 + 3] = 255;
	}
	return out;
}

/** Decode `R4_G4_UNORM` (0x0101) — 4-bit nibbles in a byte. */
export function decodeR4G4(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const b = bytes[i] ?? 0;
		// Top nibble = R, bottom = G.
		const r = (b >> 4) * 17; // expand 4-bit to 8-bit (n*17 = round(n/15*255))
		const g = (b & 0x0f) * 17;
		out[i * 4 + 0] = r;
		out[i * 4 + 1] = g;
		out[i * 4 + 2] = 0;
		out[i * 4 + 3] = 255;
	}
	return out;
}

/** Decode `R5_G6_B5_UNORM` (0x0701) — 16-bit packed RGB. */
export function decodeR5G6B5(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const lo = bytes[i * 2] ?? 0;
		const hi = bytes[i * 2 + 1] ?? 0;
		const word = (hi << 8) | lo;
		const r5 = (word >> 11) & 0x1f;
		const g6 = (word >> 5) & 0x3f;
		const b5 = word & 0x1f;
		// Round (n / max) * 255 with a `<< | >>` trick.
		out[i * 4 + 0] = (r5 << 3) | (r5 >> 2);
		out[i * 4 + 1] = (g6 << 2) | (g6 >> 4);
		out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
		out[i * 4 + 3] = 255;
	}
	return out;
}

/** Decode `B5_G6_R5_UNORM` (0x0801) — 16-bit packed BGR. */
export function decodeB5G6R5(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const lo = bytes[i * 2] ?? 0;
		const hi = bytes[i * 2 + 1] ?? 0;
		const word = (hi << 8) | lo;
		const b5 = (word >> 11) & 0x1f;
		const g6 = (word >> 5) & 0x3f;
		const r5 = word & 0x1f;
		out[i * 4 + 0] = (r5 << 3) | (r5 >> 2);
		out[i * 4 + 1] = (g6 << 2) | (g6 >> 4);
		out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
		out[i * 4 + 3] = 255;
	}
	return out;
}

/** Decode `R4_G4_B4_A4_UNORM` (0x0301) — 16-bit packed RGBA, 4-bit channels. */
export function decodeR4G4B4A4(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const lo = bytes[i * 2] ?? 0;
		const hi = bytes[i * 2 + 1] ?? 0;
		// Layout (LE): low byte = (R<<4)|G, high byte = (B<<4)|A
		const r = (lo >> 4) * 17;
		const g = (lo & 0x0f) * 17;
		const b = (hi >> 4) * 17;
		const a = (hi & 0x0f) * 17;
		out[i * 4 + 0] = r;
		out[i * 4 + 1] = g;
		out[i * 4 + 2] = b;
		out[i * 4 + 3] = a;
	}
	return out;
}

/** Decode `R5_G5_B5_A1_UNORM` (0x0501). */
export function decodeR5G5B5A1(bytes: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const lo = bytes[i * 2] ?? 0;
		const hi = bytes[i * 2 + 1] ?? 0;
		const word = (hi << 8) | lo;
		const r5 = (word >> 11) & 0x1f;
		const g5 = (word >> 6) & 0x1f;
		const b5 = (word >> 1) & 0x1f;
		const a1 = word & 0x01;
		out[i * 4 + 0] = (r5 << 3) | (r5 >> 2);
		out[i * 4 + 1] = (g5 << 3) | (g5 >> 2);
		out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
		out[i * 4 + 3] = a1 ? 255 : 0;
	}
	return out;
}
