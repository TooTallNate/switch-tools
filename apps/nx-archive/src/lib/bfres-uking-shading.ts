/**
 * Constant colours for Breath of the Wild (`uking_mat`) materials that
 * have no albedo texture.
 *
 * BotW's uber-shader picks where each channel comes from with `uking_*_color`
 * selector options. Comparing materials in the game's own models shows
 * the encoding: `0` is a texture (textured materials), `1xx` is
 * the `const_color<xx>` shader param, and `4xx` is the scalar
 * `const_value<xx>`. Glossiness, for example, is `uking_grossy_color = 402`,
 * which is `const_value2 = 1`. `2xx` is a calc-colour node (see
 * `selector`), approximated for untextured materials only.
 *
 * Some materials sample nothing at all. The Korok's `Mt_Korogu_Face_Shadow`,
 * the void behind the leaf mask, has `uking_albedo_color = 104` (white
 * `const_color4`). It also has `uking_enable_ao = 1` with
 * `uking_ao_color = 400` (`const_value0 = 0.01`), so in game it renders
 * almost black. Without this, these shapes fell back to the normal-vector
 * preview and the library reported them as missing a texture.
 */
import type { BfresMaterial } from '@tootallnate/bfres';

function param(mat: BfresMaterial, name: string): number[] | null {
	const p = mat.shaderParams?.[name];
	return p && p.values.length > 0 ? (p.values as number[]) : null;
}

/**
 * Resolve a `1xx` / `4xx` selector to a colour (`4xx` scalars become grey).
 *
 * `2xx` is the result of calc-colour node `xx`, a small per-material
 * expression (`uking_color<xx>_A..D` operands combined by
 * `uking_color<xx>_calc_type`) that procedural materials such as water
 * use. We don't know the calc types, so we approximate a node by its
 * first operand and follow it down to a constant. Village water
 * (`Mt_TerraWater01`): node 9 → node 6 → `const_color1`, its deep teal.
 */
function selector(mat: BfresMaterial, value: string | undefined, depth = 0): [number, number, number] | null {
	const n = Number(value);
	if (!Number.isInteger(n)) return null;
	if (n >= 200 && n < 300 && depth < 8) {
		const opts = mat.shaderAssign?.options ?? {};
		if (opts[`uking_enable_calc_color${n - 200}`] !== '1') return null;
		return selector(mat, opts[`uking_color${n - 200}_A`], depth + 1);
	}
	if (n >= 100 && n < 200) {
		const c = param(mat, `const_color${n - 100}`);
		return c && c.length >= 3 ? [c[0]!, c[1]!, c[2]!] : null;
	}
	if (n >= 400 && n < 500) {
		const v = param(mat, `const_value${n - 400}`);
		return v ? [v[0]!, v[0]!, v[0]!] : null;
	}
	return null;
}

/**
 * Where BotW keeps shared texture arrays that models bind by name. The
 * terrain-material objects (rocks, soil, the Korok stake) sample the
 * same array as the terrain itself, which lives in
 * `Pack/TitleBG.pack/Model/Terrain.Tex.sbfres`.
 */
export const UKING_SHARED_TEXTURE_ARCHIVES: Record<string, string> = {
	MaterialAlb: 'Terrain',
	MaterialCmb: 'Terrain',
};

/**
 * The albedo of a `uking_mat` material whose texture isn't bound to the
 * classic `_a0` sampler.
 *
 * The shader assign's `samplerAssign` routes the shader's `_a0` to one of
 * the material's own samplers. Terrain-material objects name theirs
 * `tma` / `tmc`, bound to the terrain arrays `MaterialAlb` / `MaterialCmb`.
 * When `uking_sampler_use_array` is on, `uking_texture_array_texture0`
 * names the `texture_array_index<n>` param holding the array layer. The
 * Korok stake's `Mt_Rock`, for example, uses `MaterialAlb` layer 18.
 */
export function ukingAlbedoTexture(mat: BfresMaterial | undefined): { textureName: string; layer: number } | null {
	const assign = mat?.shaderAssign;
	if (!mat || !assign || !assign.shadingModel.startsWith('uking')) return null;
	const sampler = assign.samplerAssign?._a0;
	if (!sampler) return null;
	const binding = mat.bindings.find((b) => b.samplerName === sampler);
	if (!binding) return null;
	let layer = 0;
	const opts = assign.options;
	const slot = Number(opts.uking_texture_array_texture0);
	if (opts.uking_sampler_use_array === '1' && Number.isInteger(slot) && slot >= 0) {
		const index = param(mat, `texture_array_index${slot}`);
		if (index) layer = Math.max(0, Math.round(index[0]!));
	}
	return { textureName: binding.textureName, layer };
}

/**
 * Flat colour for an untextured `uking_mat` material (albedo × ambient
 * occlusion), or null when the material samples a texture, isn't BotW's
 * shader, or uses a selector we don't understand.
 */
export function ukingBaseColor(
	mat: BfresMaterial | undefined,
	albedoSamplers: readonly string[],
): [number, number, number] | null {
	const assign = mat?.shaderAssign;
	if (!mat || !assign || assign.shadingModel !== 'uking_mat') return null;
	if (mat.bindings.some((b) => albedoSamplers.includes(b.samplerName))) return null;
	if (ukingAlbedoTexture(mat)) return null;
	const opts = assign.options;
	const albedo = selector(mat, opts.uking_albedo_color);
	if (!albedo) return null;
	if (opts.uking_enable_ao === '1') {
		const ao = selector(mat, opts.uking_ao_color);
		if (ao) for (let k = 0; k < 3; k++) albedo[k]! *= ao[k]!;
	}
	return albedo;
}
