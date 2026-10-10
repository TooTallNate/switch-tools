/**
 * Halo: Combat Evolved cache files (`.map`) as containers.
 *
 * A map is one big tag database; we surface the tags that hold
 * media, laid out by tag path:
 *
 *  - `bitm` → one `.png` per bitmap (mip 0, first face)
 *  - `snd!` → one `.wav` per permutation (Xbox ADPCM decoded)
 *  - `mode` → a model leaf (`meta.haloModel`) for the mesh viewer
 *
 * Xbox maps are zlib-compressed and inflate to 30–280 MiB, so the
 * parsed maps live in a small LRU instead of on the nodes: children
 * keep only small descriptors and re-acquire the map when decoded.
 */
import {
	decodeBitmap,
	decodeSoundClip,
	parseBitmapTag,
	parseHaloMap,
	parseModelTag,
	parseSoundTag,
	readHaloMap,
	SOUND_CLASS_MUSIC,
	type HaloMap,
} from '@tootallnate/halo-map';
import type { RenderableMesh, RenderableMeshLOD } from '~/components/mesh-viewer';
import type { Node } from './archive';
import { encodePng } from './png';
import type { DecodedTexture } from './uasset-material-chain';

/** Reference stored on model leaves. */
export interface HaloModelRef {
	/** Acquire the parsed map (shared LRU). */
	load: () => Promise<HaloMap>;
	tagIndex: number;
	path: string;
}

const MAX_CACHED_MAPS = 2;
const mapCache = new Map<string, Promise<HaloMap>>();

/** Parse (or reuse) the map for `key`, keeping at most two in memory. */
function acquireMap(key: string, blob: Blob): Promise<HaloMap> {
	let p = mapCache.get(key);
	if (p) {
		// Refresh LRU position.
		mapCache.delete(key);
		mapCache.set(key, p);
		return p;
	}
	p = readHaloMap(blob).then(parseHaloMap);
	p.catch(() => mapCache.delete(key));
	mapCache.set(key, p);
	while (mapCache.size > MAX_CACHED_MAPS) {
		mapCache.delete(mapCache.keys().next().value!);
	}
	return p;
}

const CLASS_LABEL: Record<string, string> = {
	bitm: 'Bitmap',
	'snd!': 'Sound',
	mode: 'Model',
};

type Leaf = Omit<Node, 'id'> & { path: string[] };

/** Build the child leaves for every media tag in the map. */
function mediaLeaves(map: HaloMap, load: () => Promise<HaloMap>, mapBlob: Blob): Leaf[] {
	const leaves: Leaf[] = [];
	for (const tag of map.tags) {
		if (!CLASS_LABEL[tag.tagClass] || !tag.path) continue;
		const segments = tag.path.split('\\').filter(Boolean);
		const base = segments.pop() ?? `tag_${tag.index}`;
		if (tag.tagClass === 'bitm') {
			const bitmaps = parseBitmapTag(map, tag).filter((b) => !b.external && b.width && b.height);
			for (const b of bitmaps) {
				const name = bitmaps.length === 1 ? `${base}.png` : `${base}_${String(b.index).padStart(2, '0')}.png`;
				const index = b.index;
				const tagIndex = tag.index;
				leaves.push({
					path: segments,
					name,
					kind: 'file',
					isContainer: false,
					size: b.width * b.height * 4,
					format: `${b.format.toUpperCase()} ${b.type}`,
					meta: { haloTag: tag.path, haloBitmap: index },
					blob: async () => {
						const m = await load();
						const bm = parseBitmapTag(m, m.tags[tagIndex])[index];
						const img = decodeBitmap(m, bm);
						return new Blob([(await encodePng(img.width, img.height, img.pixels)) as BlobPart], { type: 'image/png' });
					},
				});
			}
		} else if (tag.tagClass === 'snd!') {
			const sound = parseSoundTag(map, tag);
			if (!sound) continue;
			const clips = sound.clips.filter((c) => !c.external && c.pieces.length);
			const music = sound.soundClass === SOUND_CLASS_MUSIC;
			clips.forEach((clip, i) => {
				const name = clips.length === 1 ? `${base}.wav` : `${base}_${String(i).padStart(2, '0')}.wav`;
				const encoded = clip.pieces.reduce((n, p) => n + p.size, 0);
				const tagIndex = tag.index;
				const clipIndex = sound.clips.indexOf(clip);
				leaves.push({
					path: music ? ['music', ...segments] : segments,
					name,
					kind: 'file',
					isContainer: false,
					// Xbox ADPCM is 36 bytes → 65 samples (130 bytes) per channel block.
					size: 44 + Math.round((encoded / 36) * 130),
					format: `${clip.format.toUpperCase()} ${sound.channels === 2 ? 'stereo' : 'mono'} ${sound.sampleRate} Hz`,
					meta: { haloTag: tag.path, haloSoundClass: sound.soundClass },
					blob: async () => {
						const m = await load();
						const s = parseSoundTag(m, m.tags[tagIndex])!;
						return new Blob([decodeSoundClip(m, s, s.clips[clipIndex]) as BlobPart], { type: 'audio/wav' });
					},
				});
			});
		} else if (tag.tagClass === 'mode') {
			const model = parseModelTag(map, tag);
			if (!model?.parts.length) continue;
			const tris = model.parts.reduce((n, p) => n + p.indices.length / 3, 0);
			const ref: HaloModelRef = { load, tagIndex: tag.index, path: tag.path };
			leaves.push({
				path: segments,
				name: `${base}.model`,
				kind: 'file',
				isContainer: false,
				format: `Halo model · ${tris.toLocaleString()} tris`,
				meta: { haloModel: ref, haloTag: tag.path },
				// Geometry is decoded from the map; the blob is the map itself.
				blob: async () => mapBlob,
			});
		}
	}
	return leaves;
}

function compareNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Turn flat leaves with paths into a nested directory tree of nodes. */
function treeOf(id: string, leaves: Leaf[]): Node[] {
	type Dir = { dirs: Map<string, Dir>; files: Leaf[] };
	const root: Dir = { dirs: new Map(), files: [] };
	for (const leaf of leaves) {
		let d = root;
		for (const seg of leaf.path) {
			let next = d.dirs.get(seg);
			if (!next) d.dirs.set(seg, (next = { dirs: new Map(), files: [] }));
			d = next;
		}
		d.files.push(leaf);
	}
	const build = (dirId: string, d: Dir): Node[] => {
		const dirs = [...d.dirs.keys()].sort(compareNames).map((name): Node => {
			const childId = `${dirId}/${name}`;
			const sub = d.dirs.get(name)!;
			return {
				id: childId,
				name,
				kind: 'directory',
				isContainer: true,
				format: 'directory',
				getChildren: async () => build(childId, sub),
			};
		});
		const seen = new Set<string>();
		const files = d.files
			.sort((a, b) => compareNames(a.name, b.name))
			.map((leaf): Node => {
				// Tag paths can collide once the class extension is dropped.
				let name = leaf.name;
				for (let n = 2; seen.has(name); n++) name = leaf.name.replace(/(\.[^.]+)$/, `_${n}$1`);
				seen.add(name);
				const { path: _path, ...rest } = leaf;
				return { ...rest, name, id: `${dirId}/${name}` };
			});
		return [...dirs, ...files];
	};
	return build(id, root);
}

/** Container node for a Halo cache file. */
export function makeHaloMapNode(id: string, name: string, blob: Blob): Node {
	const load = () => acquireMap(id, blob);
	return {
		id,
		name,
		kind: 'halo-map',
		isContainer: true,
		size: blob.size,
		format: 'Halo map',
		blob: async () => blob,
		getChildren: async () => {
			const map = await load();
			return treeOf(id, mediaLeaves(map, load, blob));
		},
	};
}

const TRANSPARENT_SHADERS = new Set(['schi', 'scex', 'sotr', 'sgla', 'smet', 'spla']);

/** A Halo model, adapted for {@link MeshViewer}. */
export interface HaloModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	triangles: number;
	vertices: number;
	shaderCount: number;
	texturedShaders: number;
}

/** Decode a model tag plus the base maps of its shaders. */
export async function loadHaloModelView(ref: HaloModelRef): Promise<HaloModelView> {
	const map = await ref.load();
	const model = parseModelTag(map, map.tags[ref.tagIndex]);
	if (!model?.parts.length) throw new Error('Model has no geometry');

	let numVertices = 0;
	let numIndices = 0;
	for (const p of model.parts) {
		numVertices += p.positions.length / 3;
		numIndices += p.indices.length;
	}
	const positions = new Float32Array(numVertices * 3);
	const normals = new Float32Array(numVertices * 3);
	const uv = new Float32Array(numVertices * 2);
	const indices = new Uint32Array(numIndices);
	const sections: RenderableMeshLOD['sections'] = [];
	let vBase = 0;
	let iBase = 0;
	// Sections sorted by shader so each material is one contiguous range.
	const parts = [...model.parts].sort((a, b) => a.shaderIndex - b.shaderIndex);
	for (const p of parts) {
		positions.set(p.positions, vBase * 3);
		normals.set(p.normals, vBase * 3);
		uv.set(p.uvs, vBase * 2);
		for (let i = 0; i < p.indices.length; i++) indices[iBase + i] = p.indices[i] + vBase;
		const last = sections[sections.length - 1];
		if (last && last.materialIndex === p.shaderIndex && last.firstIndex + last.numTriangles * 3 === iBase) {
			last.numTriangles += p.indices.length / 3;
		} else {
			sections.push({ materialIndex: p.shaderIndex, firstIndex: iBase, numTriangles: p.indices.length / 3 });
		}
		vBase += p.positions.length / 3;
		iBase += p.indices.length;
	}

	const decoded = new Map<number, DecodedTexture | null>();
	const textures = model.shaders.map((s) => {
		const tag = s.baseMap;
		if (!tag) return null;
		if (decoded.has(tag.index)) return decoded.get(tag.index)!;
		let tex: DecodedTexture | null = null;
		try {
			const bm = parseBitmapTag(map, tag)[0];
			if (bm) {
				const img = decodeBitmap(map, bm);
				// Model / environment shaders keep a specular or detail mask
				// in the base map's alpha, not opacity; only the transparent
				// shader families use it for blending.
				if (!TRANSPARENT_SHADERS.has(s.shader?.tagClass ?? '')) {
					const px = img.pixels;
					for (let i = 3; i < px.length; i += 4) px[i] = 255;
				}
				tex = {
					packagePath: tag.path,
					width: img.width,
					height: img.height,
					pixels: img.pixels,
					pixelFormat: bm.format,
					normalReconstructed: false,
					// Halo is DirectX-style: top-down pixels, V=0 at the top.
					flipY: false,
				};
			}
		} catch {
			tex = null;
		}
		decoded.set(tag.index, tex);
		return tex;
	});

	const lod: RenderableMeshLOD = {
		numVertices,
		positions,
		normals,
		uv,
		indices,
		sections,
		label: `${numVertices.toLocaleString()} verts, ${(numIndices / 3).toLocaleString()} tris`,
	};
	return {
		mesh: { lods: [lod], upAxis: 'z-up' },
		textures,
		triangles: numIndices / 3,
		vertices: numVertices,
		shaderCount: model.shaders.length,
		texturedShaders: textures.filter(Boolean).length,
	};
}
