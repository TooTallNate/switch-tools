/**
 * PlayStation TIM images.
 *
 *   u32 0x10 magic
 *   u32 flags: bits 0–2 pixel mode (0 = 4 bpp, 1 = 8 bpp, 2 = 16 bpp,
 *              3 = 24 bpp), bit 3 = has CLUT
 *   CLUT block (when flagged): u32 length, u16 x, y, width, height,
 *              then width × height 16-bit colours (one palette per row)
 *   image block: u32 length, u16 x, y, width (in 16-bit units), height,
 *              then the pixels
 *
 * Colours are ABGR1555. The PlayStation draws 0x0000 as transparent;
 * the top (STP) bit only selects semi-transparency, so it's ignored.
 */

export interface TimImage {
	bpp: 4 | 8 | 16 | 24;
	width: number;
	height: number;
	/** Palettes (16 or 256 colours each) for 4 / 8 bpp images. */
	paletteCount: number;
	/** Byte length of the whole TIM. */
	byteLength: number;
	/** RGBA8 pixels, using `palette` (default 0) for indexed images. */
	pixels: Uint8Array;
}

const MODES = [4, 8, 16, 24] as const;

function color1555(v: number, out: Uint8Array, o: number): void {
	out[o] = ((v & 31) * 255) / 31;
	out[o + 1] = (((v >> 5) & 31) * 255) / 31;
	out[o + 2] = (((v >> 10) & 31) * 255) / 31;
	out[o + 3] = v === 0 ? 0 : 255;
}

export interface TimLayout {
	bpp: 4 | 8 | 16 | 24;
	/** CLUT block: data offset, VRAM position and size (in 16-bit entries). */
	clut: { offset: number; x: number; y: number; width: number; height: number } | null;
	/** Image block: data offset, VRAM position and size (width in 16-bit units). */
	image: { offset: number; x: number; y: number; width: number; height: number };
	byteLength: number;
}

/** Validate a TIM header at `offset`; null when it isn't one. */
export function timLayout(bytes: Uint8Array, offset = 0): TimLayout | null {
	if (offset + 20 > bytes.length) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(offset, true) !== 0x10) return null;
	const flags = dv.getUint32(offset + 4, true);
	if (flags & ~0xf) return null;
	const mode = flags & 7;
	if (mode > 3) return null;
	const bpp = MODES[mode];
	const hasClut = (flags & 8) !== 0;
	if ((bpp <= 8) !== hasClut) return null;
	let p = offset + 8;
	let clut: TimLayout['clut'] = null;
	if (hasClut) {
		if (p + 12 > bytes.length) return null;
		const len = dv.getUint32(p, true);
		const w = dv.getUint16(p + 8, true);
		const h = dv.getUint16(p + 10, true);
		if (!w || !h || len !== 12 + w * h * 2 || w > 1024 || h > 512) return null;
		clut = { offset: p + 12, x: dv.getUint16(p + 4, true), y: dv.getUint16(p + 6, true), width: w, height: h };
		p += len;
	}
	if (p + 12 > bytes.length) return null;
	const len = dv.getUint32(p, true);
	const w = dv.getUint16(p + 8, true);
	const h = dv.getUint16(p + 10, true);
	if (!w || !h || w > 1024 || h > 512 || len !== 12 + w * h * 2) return null;
	if (p + len > bytes.length) return null;
	return {
		bpp,
		clut,
		image: { offset: p + 12, x: dv.getUint16(p + 4, true), y: dv.getUint16(p + 6, true), width: w, height: h },
		byteLength: p + len - offset,
	};
}

/** Pixel width of an image block `w` 16-bit units wide. */
export function pixelWidth(bpp: number, w: number): number {
	return bpp === 4 ? w * 4 : bpp === 8 ? w * 2 : bpp === 16 ? w : Math.floor((w * 2) / 3);
}

/** Decode the TIM at `offset` (null when there's no valid TIM there). */
export function decodeTim(bytes: Uint8Array, offset = 0, palette = 0): TimImage | null {
	const layout = timLayout(bytes, offset);
	if (!layout) return null;
	const { bpp, clut, image } = layout;
	const width = pixelWidth(bpp, image.width);
	const height = image.height;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const pixels = new Uint8Array(width * height * 4);
	const stride = image.width * 2;
	if (bpp <= 8) {
		const colors = bpp === 4 ? 16 : 256;
		const pal = new Uint8Array(colors * 4);
		// A CLUT row can hold several palettes side by side.
		const perRow = Math.max(1, Math.floor(clut!.width / colors));
		const count = perRow * clut!.height;
		const pi = Math.min(palette, count - 1);
		const base = clut!.offset + (Math.floor(pi / perRow) * clut!.width + (pi % perRow) * colors) * 2;
		for (let i = 0; i < colors; i++) {
			const o = base + i * 2;
			color1555(o + 1 < bytes.length ? dv.getUint16(o, true) : 0, pal, i * 4);
		}
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const b = bytes[image.offset + y * stride + (bpp === 4 ? x >> 1 : x)];
				const idx = bpp === 4 ? (x & 1 ? b >> 4 : b & 15) : b;
				pixels.set(pal.subarray(idx * 4, idx * 4 + 4), (y * width + x) * 4);
			}
		}
		return { bpp, width, height, paletteCount: count, byteLength: layout.byteLength, pixels };
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			if (bpp === 16) {
				color1555(dv.getUint16(image.offset + y * stride + x * 2, true), pixels, o);
			} else {
				const s = image.offset + y * stride + x * 3;
				pixels[o] = bytes[s];
				pixels[o + 1] = bytes[s + 1];
				pixels[o + 2] = bytes[s + 2];
				pixels[o + 3] = 255;
			}
		}
	}
	return { bpp, width, height, paletteCount: 0, byteLength: layout.byteLength, pixels };
}

/** Offsets of valid TIMs embedded in `bytes` (4-byte aligned scan). */
export function findTims(bytes: Uint8Array, limit = 4096): { offset: number; byteLength: number; width: number; height: number; bpp: number }[] {
	const out: { offset: number; byteLength: number; width: number; height: number; bpp: number }[] = [];
	for (let o = 0; o + 20 <= bytes.length && out.length < limit; o += 4) {
		if (bytes[o] !== 0x10 || bytes[o + 1] || bytes[o + 2] || bytes[o + 3]) continue;
		const l = timLayout(bytes, o);
		if (!l) continue;
		out.push({ offset: o, byteLength: l.byteLength, width: pixelWidth(l.bpp, l.image.width), height: l.image.height, bpp: l.bpp });
		o += l.byteLength - 4;
	}
	return out;
}
