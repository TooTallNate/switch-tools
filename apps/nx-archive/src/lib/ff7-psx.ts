/**
 * Final Fantasy VII PlayStation models on PSX discs: battle models
 * (`.LZS` in the ENEMY / MAGIC folders, including the party) and
 * field characters (`FIELD/*.BCX`). Both are LZS-compressed; files
 * are recognised by parsing them, so other games' `.LZS` files are
 * left alone.
 */
import { buildBattleMesh, buildFieldMesh, decompressLzs, parseBattleModel, parseBcx, type PsxMesh } from '@tootallnate/ff7-psx-model';
import type { RenderableMesh, RenderableMeshLOD } from '~/components/mesh-viewer';
import type { Node } from './archive';
import type { DecodedTexture } from './uasset-material-chain';

export type Ff7PsxModelKind = 'battle' | 'field';

/** Largest compressed file worth probing (FF7's biggest models are ~150 KB). */
const MAX_PROBE = 2 * 1024 * 1024;

/** Which kind of FF7 PSX model `bytes` (compressed) holds, or null. */
export function detectFf7PsxModel(name: string, bytes: Uint8Array): Ff7PsxModelKind | null {
	const bcx = /\.bcx$/i.test(name);
	if (!bcx && !/\.lzs$/i.test(name)) return null;
	if (bytes.length < 16 || bytes.length > MAX_PROBE) return null;
	// u32 compressed length that matches the file.
	const len = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
	if (len + 4 > bytes.length || len + 4 < bytes.length - 2048) return null;
	try {
		const raw = decompressLzs(bytes);
		if (bcx) {
			const m = parseBcx(raw);
			return m.parts.length ? 'field' : null;
		}
		const m = parseBattleModel(raw);
		return m.bones.some((b) => b.mesh >= 0) || m.rootMesh >= 0 ? 'battle' : null;
	} catch {
		return null;
	}
}

export function buildFf7PsxMesh(kind: Ff7PsxModelKind, compressed: Uint8Array): PsxMesh {
	const raw = decompressLzs(compressed);
	return kind === 'field' ? buildFieldMesh(raw, parseBcx(raw)) : buildBattleMesh(raw);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface Ff7PsxModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	triangles: number;
	vertices: number;
	bones: number;
}

/** Decode a model leaf for {@link MeshViewer} / the library. */
export async function loadFf7PsxModelView(node: Node): Promise<Ff7PsxModelView> {
	const kind = node.meta?.ff7PsxModel as Ff7PsxModelKind;
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const m = buildFf7PsxMesh(kind, bytes);
	if (!m.indices.length) throw new Error('Model has no polygons');
	const untextured = m.textures.length;
	const textures: (DecodedTexture | null)[] = m.textures.map((t, i) => ({
		packagePath: `${node.name}#${i}`,
		width: t.width,
		height: t.height,
		pixels: t.pixels,
		pixelFormat: 'TIM',
		normalReconstructed: false,
		flipY: false,
		wrapS: 'clamp',
		wrapT: 'clamp',
	}));
	textures.push(null); // material for vertex-coloured polygons
	const colors = m.colors.map(toLinear);
	const lod: RenderableMeshLOD = {
		numVertices: m.positions.length / 3,
		positions: m.positions,
		uv: m.uvs,
		colors,
		indices: m.indices,
		sections: m.groups.map((g) => ({
			materialIndex: g.texture >= 0 ? g.texture : untextured,
			firstIndex: g.firstIndex,
			numTriangles: g.indexCount / 3,
		})),
		label: `${(m.positions.length / 3).toLocaleString()} verts, ${(m.indices.length / 3).toLocaleString()} tris`,
	};
	return {
		mesh: { lods: [lod], upAxis: 'y-up' },
		textures,
		triangles: m.indices.length / 3,
		vertices: m.positions.length / 3,
		bones: m.bones,
	};
}
