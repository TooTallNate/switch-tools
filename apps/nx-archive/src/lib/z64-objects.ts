/**
 * Zelda 64 (Ocarina of Time / Majora's Mask) objects: the ROM's object
 * table (`gObjectTable`, located in the `code` file) as an `objects/`
 * folder named from the zeldaret decomps, with each object's skeletons
 * as posed, textured models. Format logic lives in
 * `@tootallnate/z64-object` and `@tootallnate/f3dex`.
 *
 * Models draw against a buffer of the object (segment 6) followed by
 * `gameplay_keep` (segment 4, shared textures). The pose is frame 0 of
 * the first animation in the object that fits the skeleton; skeletons
 * without one (Link, whose animations live elsewhere) show their bind
 * pose. Objects without skeletons fall back to the display-list scan.
 */

import {
	MM_OBJECT_NAMES,
	MM_SCENE_NAMES,
	OOT_OBJECT_NAMES,
	OOT_SCENE_NAMES,
	buildZ64LevelMesh,
	findZ64SceneTable,
	parseZ64RoomShape,
	parseZ64SceneRooms,
	z64JpegAt,
	buildZ64SkeletonMesh,
	findZ64Animations,
	findZ64ObjectTable,
	findZ64Skeletons,
	z64AnimationFrame,
	type Z64SkeletonRef,
} from '@tootallnate/z64-object';
import { extractDmaFile, type DmaEntry, type Z64Fs } from '@tootallnate/z64-fs';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';
import { decodeF3dexTextures, f3dexTintedLod } from './n64-mesh';
import type { DecodedTexture } from './uasset-material-chain';

export interface Z64ObjectRef {
	/** dmadata vromStart of the object file. */
	vrom: number;
	skeleton: number;
}

interface RomContext {
	romBlob: Blob;
	byVrom: Map<number, DmaEntry>;
	keepVrom: number | null;
	cache: Map<number, Promise<Uint8Array>>;
}

const contexts = new Map<string, RomContext>();

function contextFor(nodeId: string): RomContext | null {
	for (const [prefix, ctx] of contexts) if (nodeId.startsWith(`${prefix}/`)) return ctx;
	return null;
}

function fileBytes(ctx: RomContext, vrom: number): Promise<Uint8Array> {
	let p = ctx.cache.get(vrom);
	if (!p) {
		const e = ctx.byVrom.get(vrom);
		if (!e) return Promise.reject(new Error(`No file at vrom 0x${vrom.toString(16)}`));
		p = extractDmaFile(ctx.romBlob, e).then(async (b) => new Uint8Array(await b.arrayBuffer()));
		ctx.cache.set(vrom, p);
		// Bounded: object files are small, but there are hundreds.
		if (ctx.cache.size > 24) {
			for (const k of ctx.cache.keys()) {
				if (k !== ctx.keepVrom && k !== vrom) {
					ctx.cache.delete(k);
					break;
				}
			}
		}
	}
	return p;
}

/**
 * The object table, from the `code` file (the largest of the first
 * dmadata entries). Null when the ROM doesn't have one we recognise.
 */
export interface Z64Tables {
	objects: { id: number; name: string; entry: DmaEntry }[];
	scenes: { id: number; name: string; entry: DmaEntry }[];
	/** The `code` file the tables came from. */
	code: DmaEntry;
	/** Majora's Mask (vs Ocarina of Time), by object table size. */
	mm: boolean;
}

export async function findZ64Objects(romBlob: Blob, fs: Z64Fs): Promise<Z64Tables | null> {
	const candidates = fs.entries.slice(0, 48).filter((e) => !e.deleted && e.size > 0x40000).sort((a, b) => b.size - a.size);
	for (const e of candidates.slice(0, 3)) {
		const code = new Uint8Array(await (await extractDmaFile(romBlob, e)).arrayBuffer());
		const table = findZ64ObjectTable(code, fs.entries);
		if (!table) continue;
		const byVrom = new Map(fs.entries.map((x) => [x.vromStart, x]));
		const names = table.length > 500 ? MM_OBJECT_NAMES : OOT_OBJECT_NAMES;
		const out: { id: number; name: string; entry: DmaEntry }[] = [];
		table.forEach((t, id) => {
			const entry = t ? byVrom.get(t.vromStart) : undefined;
			if (entry && !entry.deleted) out.push({ id, name: names[id] ?? `object_${id.toString(16)}`, entry });
		});
		const sceneTable = findZ64SceneTable(code, fs.entries);
		const sceneNames = table.length > 500 ? MM_SCENE_NAMES : OOT_SCENE_NAMES;
		const scenes: Z64Tables['scenes'] = [];
		sceneTable?.forEach((t, id) => {
			const entry = t ? byVrom.get(t.vromStart) : undefined;
			if (entry && !entry.deleted) scenes.push({ id, name: sceneNames[id] ?? `scene_${id.toString(16)}`, entry });
		});
		return { objects: out, scenes, code: e, mm: table.length > 500 };
	}
	return null;
}

/**
 * The `objects/` folder. `scanChildren` lists display-list models for
 * objects without skeletons (the generic N64 scan).
 */
export function makeZ64ObjectsDir(
	id: string,
	romBlob: Blob,
	fs: Z64Fs,
	objects: { id: number; name: string; entry: DmaEntry }[],
	scanChildren: (nodeId: string, getBytes: () => Promise<Uint8Array>) => () => Promise<Node[]>,
): Node {
	const keep = objects.find((o) => o.name === 'gameplay_keep');
	const ctx: RomContext = { romBlob, byVrom: new Map(fs.entries.map((e) => [e.vromStart, e])), keepVrom: keep?.entry.vromStart ?? null, cache: new Map() };
	contexts.set(id, ctx);
	return {
		id,
		name: 'objects',
		kind: 'directory',
		isContainer: true,
		format: 'Z64 objects',
		getChildren: async () =>
			objects.map((o): Node => {
				const nodeId = `${id}/${o.name}`;
				const getBytes = () => fileBytes(ctx, o.entry.vromStart);
				return {
					id: nodeId,
					name: o.name,
					kind: 'n64-blob',
					isContainer: true,
					size: o.entry.size,
					format: 'Z64 object',
					meta: { tileData: 'n64-rgba16', z64ObjectId: o.id },
					blob: async () => new Blob([(await getBytes()) as BlobPart]),
					getChildren: async () => {
						const bytes = await getBytes();
						const skeletons = findZ64Skeletons(bytes);
						if (skeletons.length === 0) return scanChildren(nodeId, getBytes)();
						return skeletons.map((sk, i): Node => {
							const name = `${o.name}${skeletons.length > 1 ? `_${i}` : ''}.z64mdl`;
							return {
								id: `${nodeId}/${name}`,
								name,
								kind: 'file',
								isContainer: false,
								format: `${sk.limbCount} limbs${sk.flexDListCount ? ' · skinned' : ''}`,
								meta: {
									z64Object: { vrom: o.entry.vromStart, skeleton: sk.offset } satisfies Z64ObjectRef,
									contentKey: `z64obj:${o.entry.vromStart}:${sk.offset}`,
								},
								blob: async () => new Blob([(await getBytes()) as BlobPart]),
							};
						});
					},
				};
			}),
	};
}

export interface Z64ObjectModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	texturedMaterials: number;
	triangles: number;
	vertices: number;
	limbs: number;
	skinned: boolean;
	posed: boolean;
}

/** Build a `meta.z64Object` leaf's model. */
export async function loadZ64ObjectModelView(node: Node): Promise<Z64ObjectModelView> {
	const ref = node.meta?.z64Object as Z64ObjectRef | undefined;
	if (!ref) throw new Error('Missing z64Object metadata on this node');
	const ctx = contextFor(node.id);
	const obj = ctx ? await fileBytes(ctx, ref.vrom) : new Uint8Array(await (await node.blob!()).arrayBuffer());
	const keep = ctx && ctx.keepVrom !== null && ctx.keepVrom !== ref.vrom ? await fileBytes(ctx, ctx.keepVrom) : new Uint8Array(0);
	const sk: Z64SkeletonRef | undefined = findZ64Skeletons(obj).find((s) => s.offset === ref.skeleton);
	if (!sk) throw new Error('Skeleton not found in this object');
	const data = new Uint8Array(obj.length + keep.length);
	data.set(obj);
	data.set(keep, obj.length);
	const resolveSegment = (a: number) => {
		const seg = a >>> 24, o = a & 0xffffff;
		if (seg === 6) return o < obj.length ? o : null;
		if (seg === 4) return o < keep.length ? obj.length + o : null;
		return null;
	};
	const anims = findZ64Animations(obj, sk.limbCount);
	const frame = anims.length ? z64AnimationFrame(obj, anims[0]!, sk.limbCount, 0) : null;
	const m = buildZ64SkeletonMesh(data, obj, sk, { resolveSegment, frame });
	if (m.indices.length === 0) throw new Error('This skeleton draws no triangles');
	const textures = decodeF3dexTextures(data, m, { tint: true });
	const lod = f3dexTintedLod(m);
	// Rigid hints for print supports: nearest joint per vertex.
	const vertexBone = new Uint16Array(lod.numVertices);
	for (let v = 0; v < lod.numVertices; v++) {
		let best = 0, bd = Infinity;
		for (let j = 0; j < sk.limbCount; j++) {
			const d = (m.positions[v * 3]! - m.jointPositions[j * 3]!) ** 2 + (m.positions[v * 3 + 1]! - m.jointPositions[j * 3 + 1]!) ** 2 + (m.positions[v * 3 + 2]! - m.jointPositions[j * 3 + 2]!) ** 2;
			if (d < bd) {
				bd = d;
				best = j;
			}
		}
		vertexBone[v] = best;
	}
	return {
		mesh: { lods: [{ ...lod, skeleton: { vertexBone, parent: m.parents, joints: m.jointPositions } }], upAxis: 'y-up' },
		textures,
		texturedMaterials: textures.filter(Boolean).length,
		triangles: m.indices.length / 3,
		vertices: lod.numVertices,
		limbs: sk.limbCount,
		skinned: sk.flexDListCount !== null,
		posed: frame !== null,
	};
}

export interface Z64SceneRef {
	vrom: number;
}

/**
 * The `scenes/` folder: one model per scene (every room drawn together),
 * plus `backgrounds/` with the pre-rendered rooms' JPEGs.
 */
export function makeZ64SceneDirs(id: string, romBlob: Blob, fs: Z64Fs, scenes: Z64Tables['scenes']): Node[] {
	const ctx = contexts.get(id.slice(0, id.lastIndexOf('/')) + '/objects') ?? null;
	const local: RomContext = ctx ?? { romBlob, byVrom: new Map(fs.entries.map((e) => [e.vromStart, e])), keepVrom: null, cache: new Map() };
	contexts.set(`${id}/scenes`, local);
	contexts.set(`${id}/backgrounds`, local);
	const fileName = (s: { id: number; name: string }) => `${String(s.id).padStart(3, '0')} ${s.name}`;
	const scenesDir: Node = {
		id: `${id}/scenes`,
		name: 'scenes',
		kind: 'directory',
		isContainer: true,
		format: 'Z64 scenes',
		getChildren: async () =>
			scenes.map((sc): Node => {
				const name = `${fileName(sc)}.z64scene`;
				return {
					id: `${id}/scenes/${name}`,
					name,
					kind: 'file',
					isContainer: false,
					size: sc.entry.size,
					format: 'Z64 scene',
					meta: { z64Scene: { vrom: sc.entry.vromStart } satisfies Z64SceneRef, contentKey: `z64scene:${sc.entry.vromStart}` },
					blob: async () => new Blob([(await fileBytes(local, sc.entry.vromStart)) as BlobPart]),
				};
			}),
	};
	const backgroundsDir: Node = {
		id: `${id}/backgrounds`,
		name: 'backgrounds',
		kind: 'directory',
		isContainer: true,
		format: 'Z64 backgrounds',
		getChildren: async () => {
			const out: Node[] = [];
			for (const sc of scenes) {
				const rooms = parseZ64SceneRooms(await fileBytes(local, sc.entry.vromStart)) ?? [];
				for (const [ri, r] of rooms.entries()) {
					const room = await fileBytes(local, r.vromStart).catch(() => null);
					const shape = room ? parseZ64RoomShape(room) : null;
					shape?.backgrounds.forEach((bg, bi) => {
						const jpeg = z64JpegAt(room!, bg.offset);
						if (!jpeg) return;
						const name = `${fileName(sc)} room${ri}${shape.backgrounds.length > 1 ? `_${bi}` : ''}.jpg`;
						const bytes = jpeg.slice();
						out.push({
							id: `${id}/backgrounds/${name}`,
							name,
							kind: 'file',
							isContainer: false,
							size: bytes.length,
							format: 'JPEG',
							meta: { contentKey: `z64bg:${r.vromStart}:${bg.offset}` },
							blob: async () => new Blob([bytes as BlobPart], { type: 'image/jpeg' }),
						});
					});
				}
			}
			return out;
		},
	};
	return [scenesDir, backgroundsDir];
}

export interface Z64SceneView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	texturedMaterials: number;
	triangles: number;
	vertices: number;
	rooms: number;
}

/** Build a `meta.z64Scene` leaf: all of its rooms. */
export async function loadZ64SceneView(node: Node): Promise<Z64SceneView> {
	const ref = node.meta?.z64Scene as Z64SceneRef | undefined;
	const ctx = contextFor(node.id);
	if (!ref || !ctx) throw new Error('Missing scene context');
	const scene = await fileBytes(ctx, ref.vrom);
	const list = parseZ64SceneRooms(scene);
	if (!list) throw new Error('This scene has no room list');
	const rooms = await Promise.all(list.map((r) => fileBytes(ctx, r.vromStart)));
	const keep = ctx.keepVrom !== null ? await fileBytes(ctx, ctx.keepVrom) : new Uint8Array(0);
	const m = buildZ64LevelMesh(scene, rooms, keep);
	if (m.indices.length === 0) throw new Error('This scene draws no geometry (pre-rendered rooms are under backgrounds/)');
	const textures = decodeF3dexTextures(m.data, m, { tint: true });
	return {
		mesh: { lods: [f3dexTintedLod(m)], upAxis: 'y-up' },
		textures,
		texturedMaterials: textures.filter(Boolean).length,
		triangles: m.indices.length / 3,
		vertices: m.positions.length / 3,
		rooms: rooms.length,
	};
}
