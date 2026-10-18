/**
 * Constant colours for Breath of the Wild (`uking_mat`) materials that
 * have no albedo texture.
 *
 * BotW's uber-shader picks where each channel comes from with `uking_*_color`
 * selector options. Comparing materials in the game's own models shows
 * the encoding: `0` is a texture (textured materials), `1xx` is
 * the `const_color<xx>` shader param, and `4xx` is the scalar
 * `const_value<xx>`. Glossiness, for example, is `uking_grossy_color = 402`,
 * which is `const_value2 = 1`. Other ranges (such as `200`, which the Korok
 * body uses together with its texture) are left alone.
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

/** Resolve a `1xx` / `4xx` selector to a colour (`4xx` scalars become grey). */
function selector(mat: BfresMaterial, value: string | undefined): [number, number, number] | null {
	const n = Number(value);
	if (!Number.isInteger(n)) return null;
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
	const opts = assign.options;
	const albedo = selector(mat, opts.uking_albedo_color);
	if (!albedo) return null;
	if (opts.uking_enable_ao === '1') {
		const ao = selector(mat, opts.uking_ao_color);
		if (ao) for (let k = 0; k < 3; k++) albedo[k]! *= ao[k]!;
	}
	return albedo;
}
