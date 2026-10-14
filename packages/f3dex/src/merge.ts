import type { F3dexMaterial, F3dexMesh } from './interpret.js';

/** Concatenate meshes, de-duplicating identical materials. */
export function mergeF3dexMeshes(parts: F3dexMesh[]): Pick<F3dexMesh, 'positions' | 'normals' | 'colors' | 'alphas' | 'uvs' | 'indices' | 'groups' | 'materials' | 'usesLighting'> {
	let nv = 0, ni = 0;
	for (const m of parts) {
		nv += m.positions.length / 3;
		ni += m.indices.length;
	}
	const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), colors = new Float32Array(nv * 3);
	const alphas = new Float32Array(nv), uvs = new Float32Array(nv * 2), indices = new Uint32Array(ni);
	const materials: F3dexMaterial[] = [];
	const key = new Map<string, number>();
	const byMaterial = new Map<number, number[]>();
	let vo = 0, usesLighting = false;
	for (const m of parts) {
		positions.set(m.positions, vo * 3);
		normals.set(m.normals, vo * 3);
		colors.set(m.colors, vo * 3);
		alphas.set(m.alphas, vo);
		uvs.set(m.uvs, vo * 2);
		usesLighting ||= m.usesLighting;
		for (const g of m.groups) {
			const mat = m.materials[g.materialIndex]!;
			const k = [mat.textureOffset, mat.format, mat.size, mat.width, mat.height, mat.tlutOffset, mat.wrapS, mat.wrapT, mat.lit, mat.primColor, mat.envColor, mat.combine].join('|');
			let mi = key.get(k);
			if (mi === undefined) {
				mi = materials.length;
				materials.push(mat);
				key.set(k, mi);
			}
			const list = byMaterial.get(mi) ?? byMaterial.set(mi, []).get(mi)!;
			for (let i = 0; i < g.numTriangles * 3; i++) list.push(m.indices[g.firstIndex + i]! + vo);
		}
		vo += m.positions.length / 3;
	}
	const groups: F3dexMesh['groups'] = [];
	let io = 0;
	for (const [materialIndex, list] of byMaterial) {
		indices.set(list, io);
		groups.push({ materialIndex, firstIndex: io, numTriangles: list.length / 3 });
		io += list.length;
	}
	return { positions, normals, colors, alphas, uvs, indices: indices.subarray(0, io), groups, materials, usesLighting };
}
