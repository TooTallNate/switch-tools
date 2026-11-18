/**
 * Hedgehog Engine materials (`.material`), after HedgeLib++
 * `hl_hh_material.h`. Version 3 (Lost World onwards):
 *
 *   shader name, sub-shader name, texture-entry names, texture entries
 *   alpha threshold, no-backface-culling, additive, flag
 *   float4 / int4 / bool4 parameter counts, texture entry count
 *   float4 / int4 / bool4 parameter tables
 *
 * A texture entry is (texture name, texcoord index, wrap U, wrap V,
 * padding, type), the type being `diffuse`, `specular`, `normal`, … A
 * name can repeat a type: Frontiers' second `diffuse` (`…_cyb_abd`) is
 * the Cyber Space look. Parameters are (flags, value count, name,
 * values). Version 1 names a `.texset` instead, which we don't follow.
 */

import { readMirage } from './mirage.js';

export interface HhTextureEntry {
	texture: string;
	type: string;
	texcoord: number;
	/** 0 repeat, 1 mirror, 2 clamp (as in the game's sampler enum). */
	wrapU: number;
	wrapV: number;
}

export interface HhMaterial {
	version: number;
	shader: string;
	subShader: string;
	alphaThreshold: number;
	doubleSided: boolean;
	additive: boolean;
	textures: HhTextureEntry[];
	/** float4 parameters by name. */
	params: Record<string, number[]>;
}

export function parseHhMaterial(bytes: Uint8Array): HhMaterial {
	const m = readMirage(bytes);
	const { dv, off, str, data: d } = m;
	const s = (o: number) => {
		const p = off(o);
		return p ? str(p) : '';
	};
	const params: Record<string, number[]> = {};
	const textures: HhTextureEntry[] = [];
	const u8 = (o: number) => dv.getUint8(o);
	const f4count = u8(d + 0x14);
	const f4 = off(d + 0x18);
	for (let i = 0; i < f4count && f4; i++) {
		const p = off(f4 + i * 4);
		const n = u8(p + 2), name = s(p + 4), vals = off(p + 8);
		const v: number[] = [];
		for (let k = 0; k < n * 4; k++) v.push(dv.getFloat32(vals + k * 4, false));
		params[name] = v;
	}
	if (m.version >= 3) {
		const count = u8(d + 0x17);
		const entries = off(d + 0x0c);
		for (let i = 0; i < count && entries; i++) {
			const e = off(entries + i * 4);
			textures.push({ texture: s(e), texcoord: u8(e + 4), wrapU: u8(e + 5), wrapV: u8(e + 6), type: s(e + 8) });
		}
	}
	return {
		version: m.version,
		shader: s(d),
		subShader: s(d + 4),
		alphaThreshold: u8(d + 0x10),
		doubleSided: u8(d + 0x11) !== 0,
		additive: u8(d + 0x12) !== 0,
		textures,
		params,
	};
}
