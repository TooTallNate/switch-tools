/**
 * Decode the base mip of an idTech BFG `.bimage` (DOOM 3 BFG / RAGE)
 * to RGBA8, for the image preview, thumbnails and model textures.
 *
 * YCoCg-DXT5 colour (`CFM_YCOCG_DXT5`, used for many DOOM 3 diffuse
 * maps) is converted back to RGB with BFG's `ConvertYCoCgToRGB`
 * (`base/renderprogs/global.inc`): the DXT5 texel holds Co in red,
 * Cg in green, a scale in blue and Y in alpha.
 */
import { decodeBC1, decodeBC3 } from '@tootallnate/bcn';
import { BimageColorFormat, BimageFormat, type ParsedBimage } from '@tootallnate/bimage';

export async function decodeBimageMip0(info: ParsedBimage): Promise<{ width: number; height: number; pixels: Uint8Array }> {
	const mip0 = info.mips[0]!;
	const bytes = new Uint8Array(await mip0.data.arrayBuffer());
	const w = mip0.width;
	const h = mip0.height;
	let out: { width: number; height: number; pixels: Uint8Array };
	if (info.format === BimageFormat.DXT1) {
		out = decodeBC1(bytes, w, h);
	} else if (info.format === BimageFormat.DXT5) {
		out = decodeBC3(bytes, w, h);
	} else if (info.format === BimageFormat.RGBA8) {
		out = { width: w, height: h, pixels: bytes.slice(0, w * h * 4) };
	} else if (info.format === BimageFormat.Alpha) {
		const px = new Uint8Array(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255;
			px[i * 4 + 3] = bytes[i]!;
		}
		out = { width: w, height: h, pixels: px };
	} else if (info.format === BimageFormat.LUM8 || info.format === BimageFormat.INT8) {
		const px = new Uint8Array(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			const v = bytes[i]!;
			px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
			px[i * 4 + 3] = info.format === BimageFormat.INT8 ? v : 255;
		}
		out = { width: w, height: h, pixels: px };
	} else {
		throw new Error(`Unsupported bimage format ${BimageFormat[info.format] ?? info.format}`);
	}
	if (info.colorFormat === BimageColorFormat.YCoCgDXT5) ycocgToRgb(out.pixels);
	return out;
}

/** In-place YCoCg (Co, Cg, scale, Y) → RGB, opaque. */
export function ycocgToRgb(px: Uint8Array): void {
	const clamp = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
	for (let i = 0; i < px.length; i += 4) {
		const z = 1 / ((px[i + 2]! / 255) * 31.875 + 1);
		const x = (px[i]! / 255) * z;
		const y = (px[i + 1]! / 255) * z;
		const Y = px[i + 3]! / 255;
		px[i] = clamp(x - y + Y);
		px[i + 1] = clamp(y - 0.50196078 * z + Y);
		px[i + 2] = clamp(-x - y + 1.00392156 * z + Y);
		px[i + 3] = 255;
	}
}
