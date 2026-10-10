/**
 * Final Fantasy VII PlayStation models on PSX discs: battle models
 * (`.LZS` in the ENEMY / MAGIC folders, including the party) and
 * field characters (`FIELD/*.BCX`). Both are LZS-compressed; files
 * are recognised by parsing them, so other games' `.LZS` files are
 * left alone.
 */
import {
	BattleAnimator,
	buildBattleMesh,
	buildFieldMesh,
	decompressLzs,
	FIELD_CHARACTER_FACES,
	FieldAnimator,
	parseBattleModel,
	parseBcx,
	type PsxAnimator,
	type PsxMesh,
} from '@tootallnate/ff7-psx-model';
import { findNodeById } from './unity-external';
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

/** Kind of a model node: from the disc probe, or `.BCX` by name for standalone files. */
export function ff7PsxModelKind(node: Pick<Node, 'name' | 'meta'>): Ff7PsxModelKind | null {
	const kind = node.meta?.ff7PsxModel as Ff7PsxModelKind | undefined;
	if (kind) return kind;
	return /\.bcx$/i.test(node.name) ? 'field' : null;
}

/** The FIELD.TDB face bank next to a field model, decompressed (null when absent). */
async function siblingTdb(node: Node, root: Node | null): Promise<Uint8Array | null> {
	if (!root) return null;
	const slash = node.id.lastIndexOf('/');
	if (slash < 0) return null;
	const tdb = await findNodeById(root, `${node.id.slice(0, slash)}/FIELD.TDB`).catch(() => null);
	if (!tdb?.blob) return null;
	try {
		return decompressLzs(new Uint8Array(await (await tdb.blob()).arrayBuffer()));
	} catch {
		return null;
	}
}

export function buildFf7PsxMesh(
	kind: Ff7PsxModelKind,
	compressed: Uint8Array,
	face?: { tdb: Uint8Array; face: number },
): { mesh: PsxMesh; animator: PsxAnimator } {
	const raw = decompressLzs(compressed);
	if (kind === 'field') {
		const model = parseBcx(raw);
		return { mesh: buildFieldMesh(raw, model, face), animator: new FieldAnimator(raw, model) };
	}
	const model = parseBattleModel(raw);
	return { mesh: buildBattleMesh(raw, model), animator: new BattleAnimator(raw, model) };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface Ff7PsxModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	triangles: number;
	vertices: number;
	bones: number;
	kind: Ff7PsxModelKind;
	mesh_: PsxMesh;
	animator: PsxAnimator;
	/** True when the face textures (FIELD.TDB) were applied. */
	faces: boolean;
}

/** Decode a model leaf for {@link MeshViewer} / the library. */
export async function loadFf7PsxModelView(node: Node, root: Node | null = null): Promise<Ff7PsxModelView> {
	const kind = ff7PsxModelKind(node);
	if (!kind) throw new Error('Not an FF7 PSX model');
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const faceId = FIELD_CHARACTER_FACES[node.name.replace(/\.[^.]+$/, '').toUpperCase()];
	const tdb = kind === 'field' && faceId !== undefined ? await siblingTdb(node, root) : null;
	const { mesh: m, animator } = buildFf7PsxMesh(kind, bytes, tdb ? { tdb, face: faceId } : undefined);
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
		kind,
		mesh_: m,
		animator,
		faces: !!tdb,
	};
}
