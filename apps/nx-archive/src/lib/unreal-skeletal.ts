/**
 * Unreal SkeletalMesh → viewer mesh: LOD 0 geometry from
 * `@tootallnate/uasset`'s `parseSkeletalMesh`, textured through the
 * same material → texture chain as static meshes, plus the reference
 * skeleton's joint positions for 3D-print supports.
 *
 * Cooked SkeletalMesh vertices are already in the bind pose, so no
 * skinning is needed to show the mesh.
 */
import {
	parseSkeletalMesh,
	resolveImportPackagePath,
	type LoadedSkeletalMesh,
	type ParsedUasset,
} from '@tootallnate/uasset';

import type { RenderableMeshLOD } from '~/components/mesh-viewer';
import type { Node } from './archive';
import { pickDiffuseTexture, resolveMaterialTextures, type DecodedTexture } from './uasset-material-chain';
import { createAssetResolver } from './uasset-resolver';

/** Index of the asset's SkeletalMesh export, or −1. */
export function skeletalMeshExportIndex(parsed: ParsedUasset): number {
	for (let i = 0; i < parsed.exports.length; i++) {
		const exp = parsed.exports[i]!;
		if (exp.classIndex >= 0) continue;
		const imp = parsed.imports[-exp.classIndex - 1];
		if (imp && parsed.names[imp.objectName.nameIndex]?.value === 'SkeletalMesh') return i;
	}
	return -1;
}

export interface UeSkeletalView {
	mesh: LoadedSkeletalMesh;
	lod: RenderableMeshLOD;
	textures: (DecodedTexture | null)[];
	texturesFound: number;
	slots: number;
}

/** World-space joint positions of the reference pose (UE: quaternion x, y, z, w; parent-relative). */
function jointPositions(mesh: LoadedSkeletalMesh): Float32Array {
	const n = mesh.bones.length;
	const rot: [number, number, number, number][] = [];
	const pos: [number, number, number][] = [];
	const out = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const b = mesh.bones[i]!;
		const p = b.parent >= 0 && b.parent < i ? b.parent : -1;
		if (p < 0) {
			rot[i] = b.rotation;
			pos[i] = b.translation;
		} else {
			const [qx, qy, qz, qw] = rot[p]!;
			const [x, y, z] = b.translation;
			// Rotate the child offset by the parent's world rotation.
			const ix = qw * x + qy * z - qz * y;
			const iy = qw * y + qz * x - qx * z;
			const iz = qw * z + qx * y - qy * x;
			const iw = -qx * x - qy * y - qz * z;
			const rx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
			const ry = iy * qw + iw * -qy + iz * -qx - ix * -qz;
			const rz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
			const pp = pos[p]!;
			pos[i] = [pp[0] + rx, pp[1] + ry, pp[2] + rz];
			const [bx, by, bz, bw] = b.rotation;
			rot[i] = [
				qw * bx + qx * bw + qy * bz - qz * by,
				qw * by - qx * bz + qy * bw + qz * bx,
				qw * bz + qx * by - qy * bx + qz * bw,
				qw * bw - qx * bx - qy * by - qz * bz,
			];
		}
		out.set(pos[i]!, i * 3);
	}
	return out;
}

export async function loadUeSkeletalView(
	parsed: ParsedUasset,
	uexp: Uint8Array,
	exportIdx: number,
	root: Node | null,
	scopeId: string,
): Promise<UeSkeletalView> {
	const mesh = parseSkeletalMesh(parsed, uexp, exportIdx);
	const l = mesh.lods[0];
	if (!l) throw new Error('SkeletalMesh has no inlined LODs');
	const paths = mesh.materials.map((m) => (m.material < 0 ? resolveImportPackagePath(m.material, parsed.imports, parsed.names) : null));
	let textures: (DecodedTexture | null)[] = [];
	try {
		const sets = await resolveMaterialTextures(paths, createAssetResolver(root, scopeId));
		textures = sets.map((set) => (set ? pickDiffuseTexture(set) : null));
	} catch {
		// untextured is still a model
	}
	// Dominant bone per vertex, for 3D-print supports.
	const vertexBone = new Uint16Array(l.numVertices);
	for (let v = 0; v < l.numVertices; v++) {
		let best = 0;
		for (let k = 1; k < l.influences; k++) if (l.boneWeights[v * l.influences + k]! > l.boneWeights[v * l.influences + best]!) best = k;
		vertexBone[v] = l.boneIndices[v * l.influences + best]!;
	}
	const parent = Int16Array.from(mesh.bones.map((b) => b.parent));
	const lod: RenderableMeshLOD = {
		numVertices: l.numVertices,
		positions: l.positions,
		normals: l.normals,
		uv: l.uvs[0],
		indices: l.indices,
		sections: l.sections.map((s) => ({ materialIndex: s.materialIndex, firstIndex: s.firstIndex, numTriangles: s.numTriangles })),
		label: `${l.numVertices.toLocaleString()} verts, ${(l.indices.length / 3).toLocaleString()} tris`,
		skeleton: { vertexBone, parent, joints: jointPositions(mesh) },
	};
	return {
		mesh,
		lod,
		textures,
		texturesFound: textures.filter(Boolean).length,
		slots: Math.max(0, ...l.sections.map((s) => s.materialIndex + 1)),
	};
}
