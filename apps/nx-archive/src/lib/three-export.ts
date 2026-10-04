/**
 * Convert a rendered Three.js mesh into the viewer-agnostic
 * {@link ExportMesh} consumed by the STL / painted-3MF exporters.
 *
 * Colour information is read back from what's *actually on screen*
 * (the material's current `map`, its `vertexColors` flag, geometry
 * groups → material slots), so whatever a viewer renders — including
 * texture swaps from material animations — is what gets exported,
 * without each viewer re-deriving it from its source format.
 */
import * as THREE from 'three';

import type {
	ExportMaterial,
	ExportMesh,
	ExportTexture,
	ExportTextureWrap,
} from './mesh-export';

function wrapOf(w: THREE.Wrapping): ExportTextureWrap {
	if (w === THREE.ClampToEdgeWrapping) return 'clamp';
	if (w === THREE.MirroredRepeatWrapping) return 'mirror';
	return 'repeat';
}

/** CPU-readable RGBA8 pixels of a texture, or null (e.g. image-backed). */
function exportTextureOf(tex: THREE.Texture | null | undefined): ExportTexture | null {
	if (!tex) return null;
	const img = tex.image as
		| { data?: ArrayLike<number>; width?: number; height?: number }
		| undefined;
	if (!img?.data || !img.width || !img.height) return null;
	if (img.data.length < img.width * img.height * 4) return null;
	return {
		pixels: img.data,
		width: img.width,
		height: img.height,
		wrapS: wrapOf(tex.wrapS),
		wrapT: wrapOf(tex.wrapT),
		flipY: tex.flipY,
	};
}

function exportMaterialOf(m: THREE.Material | undefined): ExportMaterial {
	if (!m) return { texture: null };
	const any = m as THREE.Material & {
		map?: THREE.Texture | null;
		color?: THREE.Color;
	};
	const texture = exportTextureOf(any.map);
	// `MeshNormalMaterial` (the "no colour data" fallback) carries no
	// meaningful colour; leave baseColor unset → exporter default grey.
	let baseColor: [number, number, number] | undefined;
	if (any.color && !(m instanceof THREE.MeshNormalMaterial)) {
		const hex = any.color.getHex(); // sRGB-encoded
		baseColor = [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
	}
	return { texture, useVertexColors: Boolean(m.vertexColors), baseColor };
}

/**
 * Build an {@link ExportMesh} from a mounted mesh.
 *
 * @param positions World-space positions to use (e.g. already
 *   skinned). Defaults to the geometry's `position` attribute
 *   transformed by `matrixWorld` — correct for unskinned meshes and
 *   for CPU-skinned ones that write poses into the attribute.
 */
export function exportMeshFromThree(
	obj: THREE.Mesh,
	positions?: Float32Array,
): ExportMesh | null {
	const geom = obj.geometry;
	const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
	if (!pos) return null;
	const vertexCount = pos.count;

	if (!positions) {
		positions = new Float32Array(vertexCount * 3);
		const tmp = new THREE.Vector3();
		for (let v = 0; v < vertexCount; v++) {
			tmp.fromBufferAttribute(pos, v).applyMatrix4(obj.matrixWorld);
			positions[v * 3] = tmp.x;
			positions[v * 3 + 1] = tmp.y;
			positions[v * 3 + 2] = tmp.z;
		}
	}

	const idx = geom.getIndex();
	let indices: Uint32Array;
	if (idx) {
		const arr = idx.array as ArrayLike<number>;
		indices = new Uint32Array(arr.length);
		for (let i = 0; i < arr.length; i++) indices[i] = arr[i]!;
	} else {
		indices = new Uint32Array(vertexCount - (vertexCount % 3));
		for (let i = 0; i < indices.length; i++) indices[i] = i;
	}

	const uvAttr = geom.getAttribute('uv') as THREE.BufferAttribute | undefined;
	const uvs = uvAttr && uvAttr.itemSize === 2 ? copyAttr(uvAttr) : null;
	const colorAttr = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
	const colors =
		colorAttr && (colorAttr.itemSize === 3 || colorAttr.itemSize === 4)
			? copyAttr(colorAttr)
			: null;

	const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
	const materials = mats.map(exportMaterialOf);

	// Geometry groups only select materials when the mesh has a
	// material array (Three.js ignores them for a single material).
	let triangleMaterials: Int32Array | null = null;
	if (Array.isArray(obj.material) && geom.groups.length > 0) {
		triangleMaterials = new Int32Array(indices.length / 3);
		for (const g of geom.groups) {
			const first = Math.floor(g.start / 3);
			const end = Math.min(triangleMaterials.length, Math.floor((g.start + g.count) / 3));
			triangleMaterials.fill(g.materialIndex ?? 0, first, end);
		}
	}

	return {
		positions,
		indices,
		uvs,
		colors,
		colorStride: colorAttr?.itemSize === 4 ? 4 : 3,
		colorSpace: 'linear',
		materials,
		triangleMaterials,
	};
}

function copyAttr(attr: THREE.BufferAttribute): Float32Array {
	// Normalised integer attributes (e.g. Uint8 colours) need scaling.
	const out = new Float32Array(attr.count * attr.itemSize);
	for (let i = 0; i < attr.count; i++) {
		for (let c = 0; c < attr.itemSize; c++) {
			out[i * attr.itemSize + c] = attr.getComponent(i, c);
		}
	}
	return out;
}

/**
 * Bake every visible mesh in a scene (the default export path).
 * Skips helpers (line overlays aren't `THREE.Mesh`) and meshes hidden
 * directly or via an ancestor.
 */
export function exportMeshesFromScene(scene: THREE.Scene): ExportMesh[] {
	scene.updateMatrixWorld(true);
	const out: ExportMesh[] = [];
	scene.traverseVisible((obj) => {
		if (!(obj instanceof THREE.Mesh)) return;
		const m = exportMeshFromThree(obj);
		if (m) out.push(m);
	});
	return out;
}
