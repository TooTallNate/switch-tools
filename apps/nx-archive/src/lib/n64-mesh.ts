/**
 * Shared adapters from `@tootallnate/f3dex` meshes to viewer inputs:
 * per-material textures (CI formats through their TLUT) with the
 * combiner's constant colour (`f3dexMaterialTint`: PRIM / ENV) baked in,
 * and per-vertex colours that carry that tint for untextured materials.
 */

import { ImageSize, decodeN64Texture, f3dexMaterialTint, type F3dexMesh } from '@tootallnate/f3dex';
import type { RenderableMeshLOD } from '~/components/mesh-viewer';
import type { DecodedTexture } from './uasset-material-chain';

const n64Wrap = (w: 'wrap' | 'mirror' | 'clamp'): 'repeat' | 'mirror' | 'clamp' => (w === 'wrap' ? 'repeat' : w);

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
			for (let c = 0; c < 3; c++) colors[v * 3 + c] = (mat.lit ? 1 : mesh.colors[v * 3 + c]!) * (tint[c]! / 255);
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
