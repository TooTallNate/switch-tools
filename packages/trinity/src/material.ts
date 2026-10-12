/**
 * Flatten a Trinity material's colour for previews / exports.
 *
 * Legends: Arceus colours Pokémon with layers: `BaseColorMap` (`_alb`)
 * is mostly white with painted detail, `LayerMaskMap` (`_lym`) holds
 * one mask per channel, and `BaseColorLayer1`–`4` (linear RGB) tint
 * the albedo where each mask is set. Pikachu, for instance, is a white
 * albedo (red cheeks painted in) with R = body → yellow layer 1 and
 * G = mouth lines → dark layer 2. We composite on the CPU:
 *
 *   c = albedo;  for i in 1…4:  c = lerp(c, albedo · Layerᵢ, maskᵢ)
 *
 * in linear space, at the larger of the two textures' resolutions
 * (both are sampled with the same UVs). Lighting-dependent terms
 * (emission, AO, roughness) are left out.
 */

import type { TrinityMaterial } from './model.js';

export interface RgbaImage {
	width: number;
	height: number;
	/** RGBA8, rows top-down. */
	pixels: Uint8Array;
}

const toLinear = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb8 = (l: number) => {
	const c = l <= 0 ? 0 : l >= 1 ? 1 : l;
	return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

/** The `BaseColorLayer1`–`4` colours (linear RGB) a material defines. */
export function materialLayers(mat: TrinityMaterial): ([number, number, number] | null)[] {
	return [1, 2, 3, 4].map((i) => {
		const c = mat.float4s[`BaseColorLayer${i}`];
		return c ? [c[0], c[1], c[2]] : null;
	});
}

function sample(img: RgbaImage, u: number, v: number, out: number[]): void {
	const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
	const y = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)));
	const o = (y * img.width + x) * 4;
	out[0] = img.pixels[o]!;
	out[1] = img.pixels[o + 1]!;
	out[2] = img.pixels[o + 2]!;
	out[3] = img.pixels[o + 3]!;
}

/**
 * Albedo with the layer colours applied. Returns `albedo` unchanged
 * when there's no mask or the material defines no layers. Alpha comes
 * from the albedo.
 */
export function bakeLayeredAlbedo(mat: TrinityMaterial, albedo: RgbaImage | null, mask: RgbaImage | null): RgbaImage | null {
	const layers = materialLayers(mat);
	if (!mask || layers.every((l) => !l)) return albedo;
	const width = Math.max(albedo?.width ?? 0, mask.width);
	const height = Math.max(albedo?.height ?? 0, mask.height);
	const pixels = new Uint8Array(width * height * 4);
	const a: number[] = [255, 255, 255, 255];
	const m: number[] = [0, 0, 0, 0];
	const lut = new Float64Array(256);
	for (let i = 0; i < 256; i++) lut[i] = toLinear(i);
	for (let y = 0; y < height; y++) {
		const v = (y + 0.5) / height;
		for (let x = 0; x < width; x++) {
			const u = (x + 0.5) / width;
			if (albedo) sample(albedo, u, v, a);
			sample(mask, u, v, m);
			const base = [lut[a[0]!]!, lut[a[1]!]!, lut[a[2]!]!];
			const c = base.slice();
			for (let i = 0; i < 4; i++) {
				const layer = layers[i];
				const w = m[i]! / 255;
				if (!layer || w <= 0) continue;
				for (let k = 0; k < 3; k++) c[k] = c[k]! + (base[k]! * layer[k]! - c[k]!) * w;
			}
			const o = (y * width + x) * 4;
			pixels[o] = toSrgb8(c[0]!);
			pixels[o + 1] = toSrgb8(c[1]!);
			pixels[o + 2] = toSrgb8(c[2]!);
			pixels[o + 3] = a[3]!;
		}
	}
	return { width, height, pixels };
}

/** `UVScaleOffset` (scale u, scale v, offset u, offset v); identity when absent. */
export function uvScaleOffset(mat: TrinityMaterial): [number, number, number, number] {
	return mat.float4s.UVScaleOffset ?? [1, 1, 0, 0];
}
