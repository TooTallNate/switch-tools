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

import type { TrinityMaterial, TrinityWrap } from './model.js';

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

/**
 * The `UVScaleOffset` (scale u, scale v, offset u, offset v) a material's
 * shader applies; identity when absent. `value` overrides the stored
 * parameter (an animated value).
 *
 * Eye materials with `UVTransformMode` `T` (translate) apply only the
 * offset, which steps between the cells of an expression atlas; their
 * stored scale is ignored. Magnemite's eye is (2, 4) and Magikarp's is
 * (1, 0): taken literally, they would clamp the mask to an empty edge
 * or collapse it to one row.
 */
export function uvScaleOffset(mat: TrinityMaterial, value?: readonly number[]): [number, number, number, number] {
	const [su = 1, sv = 1, ou = 0, ov = 0] = value ?? mat.float4s.UVScaleOffset ?? [];
	return mat.shaderValues.UVTransformMode === 'T' ? [1, 1, ou, ov] : [su, sv, ou, ov];
}

// ---------------------------------------------------------------------------
// Surface bake in raw UV space
// ---------------------------------------------------------------------------

/**
 * A rectangle of the mesh's *raw* (stored) UV space to bake, plus the
 * tile shift for clamped axes (materials sit in their own UV tiles but
 * the game ignores the tile number; see the app's view module).
 */
export interface TrinityBakeRegion {
	u0: number;
	v0: number;
	u1: number;
	v1: number;
	width: number;
	height: number;
	/** Subtracted from the transformed albedo UV on clamped axes. */
	tileU?: number;
	tileV?: number;
}

function wrapCoord(x: number, mode: TrinityWrap): number {
	switch (mode) {
		case 'clamp':
			return x < 0 ? 0 : x > 1 ? 1 : x;
		case 'mirror': {
			const f = ((x % 2) + 2) % 2;
			return f > 1 ? 2 - f : f;
		}
		case 'mirror-once': {
			const a = Math.abs(x);
			return a > 1 ? 1 : a;
		}
		default:
			return x - Math.floor(x);
	}
}

/** Nearest texel at game UV (u, v); V points up, so row 0 is v = 1. */
function fetch(img: RgbaImage, u: number, v: number, wu: TrinityWrap, wv: TrinityWrap, out: number[]): void {
	const x = Math.min(img.width - 1, Math.floor(wrapCoord(u, wu) * img.width));
	const y = Math.min(img.height - 1, Math.floor((1 - wrapCoord(v, wv)) * img.height));
	const o = (y * img.width + x) * 4;
	out[0] = img.pixels[o]!;
	out[1] = img.pixels[o + 1]!;
	out[2] = img.pixels[o + 2]!;
	out[3] = img.pixels[o + 3]!;
}

/**
 * Bake a material's visible colour over `region` of raw UV space:
 * the layered albedo (see {@link bakeLayeredAlbedo}) sampled through
 * `UVScaleOffset`, plus the eye highlight (`HighlightMaskMap` through
 * `UVScaleOffset1`, when `EnableHighlight`). Each map uses its own
 * sampler wrap. `params` overrides float4 parameters (animated
 * values). The result's row 0 is the region's top (v = v1), matching
 * textures uploaded with `flipY`.
 */
export function bakeTrinitySurface(
	mat: TrinityMaterial,
	images: Partial<Record<string, RgbaImage | null>>,
	region: TrinityBakeRegion,
	params: Record<string, readonly number[]> = {},
): RgbaImage {
	const param = (k: string) => params[k] ?? mat.float4s[k];
	const tex = (binding: string) => {
		const ref = mat.textures.find((t) => t.binding === binding);
		const img = ref ? images[binding] : null;
		if (!ref || !img) return null;
		const smp = mat.samplers[ref.slot];
		return { img, wu: smp?.wrapU ?? ('repeat' as TrinityWrap), wv: smp?.wrapV ?? ('repeat' as TrinityWrap) };
	};
	const alb = tex('BaseColorMap');
	const lym = tex('LayerMaskMap');
	const hl = mat.shaderValues.EnableHighlight === 'True' ? tex('HighlightMaskMap') : null;
	const layers = [1, 2, 3, 4].map((i) => {
		const c = param(`BaseColorLayer${i}`);
		return c ? [c[0]!, c[1]!, c[2]!] : null;
	});
	const [s0u, s0v, o0u, o0v] = uvScaleOffset(mat, param('UVScaleOffset'));
	const [s1u, s1v, o1u, o1v] = (param('UVScaleOffset1') ?? [1, 1, 0, 0]) as number[];
	const highlightColor = (param('EmissionColorLayer5') ?? [1, 1, 1]).slice(0, 3);
	const { width, height } = region;
	const pixels = new Uint8Array(width * height * 4);
	const a: number[] = [255, 255, 255, 255];
	const m: number[] = [0, 0, 0, 0];
	const h: number[] = [0, 0, 0, 0];
	const lut = new Float64Array(256);
	for (let i = 0; i < 256; i++) lut[i] = toLinear(i);
	const tu = region.tileU ?? 0, tv = region.tileV ?? 0;
	for (let y = 0; y < height; y++) {
		const rv = region.v0 + (1 - (y + 0.5) / height) * (region.v1 - region.v0);
		for (let x = 0; x < width; x++) {
			const ru = region.u0 + ((x + 0.5) / width) * (region.u1 - region.u0);
			const bu = ru * s0u! + o0u! - tu;
			const bv = rv * s0v! + o0v! - tv;
			if (alb) fetch(alb.img, bu, bv, alb.wu, alb.wv, a);
			else a[0] = a[1] = a[2] = a[3] = 255;
			const base = [lut[a[0]!]!, lut[a[1]!]!, lut[a[2]!]!];
			const c = base.slice();
			if (lym) {
				fetch(lym.img, bu, bv, lym.wu, lym.wv, m);
				for (let i = 0; i < 4; i++) {
					const layer = layers[i];
					const w = m[i]! / 255;
					if (!layer || w <= 0) continue;
					for (let k = 0; k < 3; k++) c[k] = c[k]! + (base[k]! * layer[k]! - c[k]!) * w;
				}
			}
			if (hl) {
				fetch(hl.img, ru * s1u! + o1u!, rv * s1v! + o1v!, hl.wu, hl.wv, h);
				const w = h[0]! / 255;
				for (let k = 0; k < 3; k++) c[k] = c[k]! + (highlightColor[k]! - c[k]!) * w;
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
