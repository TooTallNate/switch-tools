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

/** Decode each material's texture from `bytes` (null when external / unknown). */
export function decodeF3dexTextures(bytes: Uint8Array, mesh: Pick<F3dexMesh, 'materials'>, options: { tint?: boolean } = {}): (DecodedTexture | null)[] {
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
		if (options.tint && blendsOverShade(mat)) {
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
		const tint = options.tint ? f3dexMaterialTint(mat) : null;
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
export function f3dexTintedLod(mesh: Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'uvs' | 'indices' | 'groups' | 'materials'>): RenderableMeshLOD {
	const colors = new Float32Array(mesh.colors.length);
	for (const g of mesh.groups) {
		const mat = mesh.materials[g.materialIndex]!;
		const tint = f3dexMaterialTint(mat) ?? [255, 255, 255, 255];
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
