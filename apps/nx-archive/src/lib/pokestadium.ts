/**
 * Pokémon Stadium 2 glue: the ROM's Pokémon and arena model archives
 * as tree folders, and model views for the viewer, thumbnails and
 * exports. Format logic lives in `@tootallnate/pokestadium`.
 *
 * Leaves carry `meta.stadiumModel` ({@link StadiumModelRef}); their
 * `blob()` is the record's raw (PERS-SZP) bytes, so downloads give the
 * original asset. Decoded models sit in a small LRU because battle
 * models decode in tens of milliseconds and the Library asks for them
 * twice (thumbnail, then detail).
 */

import {
	buildStadiumModel,
	decodeStadiumAsset,
	findStadiumTables,
	stadium2ModelName,
	stadiumRecordBytes,
	type StadiumArchive,
	type StadiumModel,
} from '@tootallnate/pokestadium';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';
import type { DecodedTexture } from './uasset-material-chain';

export interface StadiumModelRef {
	table: 'pokemon' | 'arena';
	index: number;
}

const modelCache = new Map<string, StadiumModel>();
const MODEL_CACHE_SIZE = 8;

function cached(key: string, build: () => StadiumModel): StadiumModel {
	const hit = modelCache.get(key);
	if (hit) {
		modelCache.delete(key);
		modelCache.set(key, hit);
		return hit;
	}
	const m = build();
	modelCache.set(key, m);
	while (modelCache.size > MODEL_CACHE_SIZE) modelCache.delete(modelCache.keys().next().value!);
	return m;
}

function modelLeaves(dirId: string, rom: Uint8Array, archive: StadiumArchive, table: StadiumModelRef['table']): Node[] {
	const out: Node[] = [];
	for (const rec of archive.records) {
		if (rec.size === 0) continue;
		const label = table === 'pokemon' ? stadium2ModelName(rec.index) : `Arena ${String(rec.index + 1).padStart(2, '0')}`;
		if (!label) continue;
		const name = table === 'pokemon' ? `${String(rec.index).padStart(3, '0')} ${label}.ps2mdl` : `arena_${String(rec.index + 1).padStart(2, '0')}.ps2mdl`;
		const bytes = stadiumRecordBytes(rom, rec);
		const ref: StadiumModelRef = { table, index: rec.index };
		out.push({
			id: `${dirId}/${name}`,
			name,
			kind: 'file',
			isContainer: false,
			size: rec.size,
			format: table === 'pokemon' ? 'Stadium model' : 'Stadium arena',
			meta: {
				stadiumModel: ref,
				// Cheap stable identity: the duplicate pass must not decode models to hash them.
				contentKey: `ps2:${table}:${rec.start}:${rec.size}`,
			},
			blob: async () => new Blob([bytes as BlobPart]),
		});
	}
	return out;
}

/**
 * The model folders of a Pokémon Stadium 2 ROM (big-endian bytes), or
 * an empty list when its tables aren't where the US release has them.
 */
export function makeStadium2ModelDirs(id: string, rom: Uint8Array): Node[] {
	const tables = findStadiumTables(rom);
	const dirs: Node[] = [];
	const dir = (name: string, archive: StadiumArchive, table: StadiumModelRef['table']): Node => {
		const dirId = `${id}/${name}`;
		return {
			id: dirId,
			name,
			kind: 'directory',
			isContainer: true,
			format: 'directory',
			getChildren: async () => modelLeaves(dirId, rom, archive, table),
		};
	};
	if (tables.models) dirs.push(dir('pokemon', tables.models, 'pokemon'));
	if (tables.arenas) dirs.push(dir('arenas', tables.arenas, 'arena'));
	return dirs;
}

export interface StadiumModelView {
	model: StadiumModel;
	mesh: RenderableMesh;
	/** One per material slot (= primitive); null for untextured slots. */
	textures: (DecodedTexture | null)[];
	triangles: number;
	vertices: number;
}

/** Decode a `meta.stadiumModel` leaf into viewer / export inputs. */
export async function loadStadiumModelView(node: Node): Promise<StadiumModelView> {
	const ref = node.meta?.stadiumModel as StadiumModelRef | undefined;
	if (!ref) throw new Error('Missing stadiumModel metadata on this node');
	const raw = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const model = cached(node.id, () => buildStadiumModel(decodeStadiumAsset(raw), { stage: ref.table === 'arena' }));
	return stadiumModelToView(model, node.name);
}

export function stadiumModelToView(model: StadiumModel, name: string): StadiumModelView {
	let nv = 0, ni = 0;
	for (const p of model.primitives) {
		nv += p.positions.length / 3;
		ni += p.indices.length;
	}
	const positions = new Float32Array(nv * 3);
	const normals = new Float32Array(nv * 3);
	const colors = new Float32Array(nv * 3);
	const uv = new Float32Array(nv * 2);
	const indices = new Uint32Array(ni);
	const vertexBone = new Uint16Array(nv);
	const decoded = model.textures.map(
		(t, i): DecodedTexture => ({
			packagePath: `${name}#${i}`,
			width: t.width,
			height: t.height,
			pixels: t.rgba,
			pixelFormat: 'RGBA8',
			normalReconstructed: false,
			flipY: false,
			wrapS: t.wrapS,
			wrapT: t.wrapT,
		}),
	);
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	const textures: (DecodedTexture | null)[] = [];
	let vo = 0, io = 0;
	model.primitives.forEach((p, slot) => {
		const n = p.positions.length / 3;
		positions.set(p.positions, vo * 3);
		uv.set(p.uvs, vo * 2);
		for (let i = 0; i < n; i++) {
			if (p.normals) {
				normals[(vo + i) * 3] = p.normals[i * 3]!;
				normals[(vo + i) * 3 + 1] = p.normals[i * 3 + 1]!;
				normals[(vo + i) * 3 + 2] = p.normals[i * 3 + 2]!;
			}
			// Pre-lit geometry carries colour; lit geometry renders white under its texture.
			for (let k = 0; k < 3; k++) colors[(vo + i) * 3 + k] = p.colors ? p.colors[i * 4 + k]! / 255 : 1;
			vertexBone[vo + i] = Math.max(0, p.joints[i]!);
		}
		for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + vo;
		sections.push({ materialIndex: slot, firstIndex: io, numTriangles: p.indices.length / 3 });
		textures.push(p.texture >= 0 ? decoded[p.texture]! : null);
		vo += n;
		io += p.indices.length;
	});
	// Prims without normals (pre-lit) get flat ones derived by the viewer
	// only when the whole mesh lacks them, so fill theirs from faces.
	fillMissingNormals(model, positions, normals, indices);
	const parent = Int16Array.from(model.bones.map((b) => b.parent));
	return {
		model,
		mesh: {
			lods: [
				{
					numVertices: nv,
					positions,
					normals,
					colors,
					uv,
					indices,
					sections,
					...(model.bones.length > 0 && { skeleton: { vertexBone, parent, joints: model.jointPositions } }),
				},
			],
			upAxis: 'y-up',
		},
		textures,
		triangles: ni / 3,
		vertices: nv,
	};
}

/** Face normals for the vertices of primitives that carry colours instead. */
function fillMissingNormals(model: StadiumModel, positions: Float32Array, normals: Float32Array, indices: Uint32Array): void {
	let vo = 0, io = 0;
	for (const p of model.primitives) {
		const n = p.positions.length / 3;
		if (!p.normals) {
			for (let t = io; t < io + p.indices.length; t += 3) {
				const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
				const ux = positions[b * 3]! - positions[a * 3]!, uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!, uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
				const vx = positions[c * 3]! - positions[a * 3]!, vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!, vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
				const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
				for (const v of [a, b, c]) {
					normals[v * 3] += nx;
					normals[v * 3 + 1] += ny;
					normals[v * 3 + 2] += nz;
				}
			}
			for (let v = vo; v < vo + n; v++) {
				const len = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!) || 1;
				normals[v * 3] /= len;
				normals[v * 3 + 1] /= len;
				normals[v * 3 + 2] /= len;
			}
		}
		vo += n;
		io += p.indices.length;
	}
}
