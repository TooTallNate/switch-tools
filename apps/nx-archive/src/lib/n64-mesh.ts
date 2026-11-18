/**
 * Shared adapters from `@tootallnate/f3dex` meshes to viewer inputs:
 * per-material textures (CI formats through their TLUT) with the
 * combiner's constant colour (`f3dexMaterialTint`: PRIM / ENV) baked in,
 * and per-vertex colours that carry that tint for untextured materials.
 *
 * Two combiner shapes change what a texture's alpha means:
 *  - (TEXEL0 − SHADE) · TEXEL0_ALPHA + SHADE (`G_CC_BLENDRGBA`,
 *    `G_CC_BLENDRGBFADEA`) paints the texture over the shade colour, so
 *    lit materials get their light colour baked under the texture
 *    (Super Mario 64's cap logo, buttons and eyes).
 *  - An alpha combiner that reads no texel (`G_CC_MODULATERGB`, …)
 *    draws the texture opaque whatever its alpha says.
 *
 * With `combiner` (Super Mario 64: one-cycle combiners, flat light
 * colours), lit materials run cycle 1 of the colour combiner for real
 * with their light colour as SHADE: textured ones get the result baked
 * into their pixels, untextured ones a flat colour
 * ({@link f3dexMaterialColors}) the viewer lights like any other
 * material. The viewer draws textures without vertex colours, so without
 * this Yoshi's nose texture comes out white instead of green.
 */

import { ImageSize, decodeN64Texture, f3dexMaterialTint, type F3dexMaterial, type F3dexMesh } from '@tootallnate/f3dex';
import type { RenderableMeshLOD } from '~/components/mesh-viewer';
import type { DecodedTexture } from './uasset-material-chain';

const n64Wrap = (w: 'wrap' | 'mirror' | 'clamp'): 'repeat' | 'mirror' | 'clamp' => (w === 'wrap' ? 'repeat' : w);

const isTexel = (v: number) => v === 1 || v === 2;

/** Lit material whose combiner paints the texture over its light colour. */
function blendsOverShade(mat: F3dexMaterial): boolean {
	if (!mat.combine || !mat.lit || !mat.lightColor) return false;
	const [w0, w1] = mat.combine;
	return ((w0 >>> 20) & 0xf) === 1 && ((w1 >>> 28) & 0xf) === 4 && ((w0 >>> 15) & 0x1f) === 8 && ((w1 >>> 15) & 0x7) === 4;
}

/** Whether cycle 1's alpha combiner reads a texel at all. */
function alphaUsesTexel(mat: F3dexMaterial): boolean {
	if (!mat.combine) return true;
	const [w0, w1] = mat.combine;
	const a = (w0 >>> 12) & 0x7, c = (w0 >>> 9) & 0x7, b = (w1 >>> 12) & 0x7, d = (w1 >>> 9) & 0x7;
	return ((isTexel(a) || isTexel(b)) && c !== 7) || isTexel(c) || isTexel(d);
}

type Rgba = [number, number, number, number];

/**
 * Cycle 1 of `G_SETCOMBINE`, (a − b) · c + d per channel, with TEXEL1
 * read as TEXEL0 and COMBINED as 0. Inputs and output are 0-255.
 */
function combine(mat: F3dexMaterial, texel: Rgba | null, shade: Rgba): Rgba {
	const [w0, w1] = mat.combine!;
	const t: Rgba = texel ?? [255, 255, 255, 255];
	const prim: Rgba = mat.primColor ?? [255, 255, 255, 255];
	const env: Rgba = mat.envColor ?? [255, 255, 255, 255];
	const one = 255;
	const src = (v: number, k: number): number =>
		v === 1 || v === 2 ? t[k]! : v === 3 ? prim[k]! : v === 4 ? shade[k]! : v === 5 ? env[k]! : v === 6 ? one : 0;
	const a = (w0 >>> 20) & 0xf, b = (w1 >>> 28) & 0xf, c = (w0 >>> 15) & 0x1f, d = (w1 >>> 15) & 0x7;
	const cc = (k: number): number =>
		c === 1 || c === 2 ? t[k]! : c === 3 ? prim[k]! : c === 4 ? shade[k]! : c === 5 ? env[k]! : c === 8 || c === 9 ? t[3] : c === 10 ? prim[3] : c === 11 ? shade[3] : c === 12 ? env[3] : 0;
	const aa = (w0 >>> 12) & 0x7, ab = (w1 >>> 12) & 0x7, ac = (w0 >>> 9) & 0x7, ad = (w1 >>> 9) & 0x7;
	const alphaSrc = (v: number) => (v === 1 || v === 2 ? t[3] : v === 3 ? prim[3] : v === 4 ? shade[3] : v === 5 ? env[3] : v === 6 ? one : 0);
	const clamp = (v: number) => Math.max(0, Math.min(255, v));
	const out: Rgba = [0, 0, 0, 0];
	for (let k = 0; k < 3; k++) out[k] = clamp(((src(a > 7 ? 15 : a, k) - (b === 6 || b === 7 || b > 7 ? 0 : src(b, k))) * cc(k)) / 255 + (d === 7 ? 0 : src(d, k)));
	const acv = ac === 0 || ac === 6 || ac === 7 ? (ac === 7 ? 0 : 255) : alphaSrc(ac);
	out[3] = clamp(((alphaSrc(aa) - alphaSrc(ab)) * acv) / 255 + alphaSrc(ad));
	return out;
}

/** Materials {@link combine} applies to: lit, with a known light colour and combiner. */
const combinable = (mat: F3dexMaterial) => mat.lit && !!mat.lightColor && !!mat.combine;
const shadeOf = (mat: F3dexMaterial): Rgba => [...mat.lightColor!, 255];

/**
 * Flat colours (0-1) for untextured lit materials under `combiner`, for
 * the viewer's `materialBaseColors`; null elsewhere.
 */
export function f3dexMaterialColors(mesh: Pick<F3dexMesh, 'materials'>, textures: readonly (DecodedTexture | null)[]): ([number, number, number] | null)[] {
	return mesh.materials.map((mat, i) => {
		if (textures[i] || !combinable(mat)) return null;
		const c = combine(mat, null, shadeOf(mat));
		return [c[0] / 255, c[1] / 255, c[2] / 255];
	});
}

/** Decode each material's texture from `bytes` (null when external / unknown). */
export function decodeF3dexTextures(bytes: Uint8Array, mesh: Pick<F3dexMesh, 'materials'>, options: { tint?: boolean; combiner?: boolean } = {}): (DecodedTexture | null)[] {
	return mesh.materials.map((mat) => {
		if (mat.textureOffset === null || mat.width === null || mat.height === null) return null;
		let tlut: Uint8Array | undefined;
		if (mat.tlutOffset !== null) {
			const entries = mat.size === ImageSize.BITS_4 ? 16 : 256;
			const end = Math.min(bytes.length, mat.tlutOffset + entries * 2);
			if (end > mat.tlutOffset) tlut = bytes.subarray(mat.tlutOffset, end);
		}
		let pixels = decodeN64Texture(bytes, mat.textureOffset, mat.width, mat.height, mat.format, mat.size, { tlut });
		if (!pixels) return null;
		if (options.combiner && combinable(mat)) {
			const out = new Uint8Array(pixels.length);
			const shade = shadeOf(mat);
			for (let i = 0; i < pixels.length; i += 4) {
				const c = combine(mat, [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!], shade);
				out.set(c, i);
			}
			pixels = out;
		} else if (options.tint && blendsOverShade(mat)) {
			pixels = pixels.slice();
			const [r, g, b] = mat.lightColor!;
			for (let i = 0; i < pixels.length; i += 4) {
				const a = pixels[i + 3]! / 255;
				pixels[i] = pixels[i]! * a + r * (1 - a);
				pixels[i + 1] = pixels[i + 1]! * a + g * (1 - a);
				pixels[i + 2] = pixels[i + 2]! * a + b * (1 - a);
				pixels[i + 3] = 255;
			}
		} else if (options.tint && !alphaUsesTexel(mat)) {
			pixels = pixels.slice();
			for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
		}
		const tint = options.tint && !(options.combiner && combinable(mat)) ? f3dexMaterialTint(mat) : null;
		if (tint && (tint[0] < 255 || tint[1] < 255 || tint[2] < 255)) {
			pixels = pixels.slice();
			for (let i = 0; i < pixels.length; i += 4) {
				pixels[i] = (pixels[i]! * tint[0]) / 255;
				pixels[i + 1] = (pixels[i + 1]! * tint[1]) / 255;
				pixels[i + 2] = (pixels[i + 2]! * tint[2]) / 255;
			}
		}
		return {
			packagePath: `${mat.formatName} ${mat.width}x${mat.height} @0x${mat.textureOffset.toString(16)}`,
			width: mat.width,
			height: mat.height,
			pixels,
			pixelFormat: mat.formatName,
			normalReconstructed: false,
			// N64 textures are top-down and UVs put V=0 at the top.
			flipY: false,
			wrapS: n64Wrap(mat.wrapS),
			wrapT: n64Wrap(mat.wrapT),
		};
	});
}

/**
 * A viewer LOD for meshes that mix lit and unlit materials: normals
 * everywhere, and colours = (lit ? white : vertex colour) × the
 * material's combiner tint (used by untextured sections).
 */
export function f3dexTintedLod(mesh: Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'uvs' | 'indices' | 'groups' | 'materials'>, options: { combiner?: boolean } = {}): RenderableMeshLOD {
	const colors = new Float32Array(mesh.colors.length);
	for (const g of mesh.groups) {
		const mat = mesh.materials[g.materialIndex]!;
		const tint = f3dexMaterialTint(mat) ?? [255, 255, 255, 255];
		if (options.combiner && combinable(mat)) {
			// Textured: the result is in the pixels. Untextured: the flat colour.
			const c = mat.textureOffset !== null ? [255, 255, 255] : combine(mat, null, shadeOf(mat));
			for (let k = g.firstIndex; k < g.firstIndex + g.numTriangles * 3; k++) {
				const v = mesh.indices[k]!;
				for (let j = 0; j < 3; j++) colors[v * 3 + j] = c[j]! / 255;
			}
			continue;
		}
		for (let k = g.firstIndex; k < g.firstIndex + g.numTriangles * 3; k++) {
			const v = mesh.indices[k]!;
			for (let c = 0; c < 3; c++) {
				// Shade blended under the texture is already in its pixels.
				const shade = mat.textureOffset !== null && blendsOverShade(mat) ? 1 : mat.lit ? (mat.lightColor ? mat.lightColor[c]! / 255 : 1) : mesh.colors[v * 3 + c]!;
				colors[v * 3 + c] = shade * (tint[c]! / 255);
			}
		}
	}
	return {
		numVertices: mesh.positions.length / 3,
		positions: mesh.positions,
		normals: mesh.normals,
		colors,
		uv: mesh.uvs.length > 0 ? mesh.uvs : undefined,
		indices: mesh.indices,
		sections: mesh.groups.map((g) => ({ materialIndex: g.materialIndex, firstIndex: g.firstIndex, numTriangles: g.numTriangles })),
	};
}
