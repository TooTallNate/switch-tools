/**
 * Super Mario 64 glue: every model the level scripts register (grouped
 * by level, named where the model ID means one thing everywhere) and
 * every area's level geometry, posed from animations found next to the
 * geo layout (Mario's from his DMA table). Format logic lives in
 * `@tootallnate/sm64` and `@tootallnate/f3dex`.
 */

import {
	SM64_LEVEL_NAMES,
	SM64_MODEL_NAMES,
	Sm64SegmentCache,
	buildSm64Geo,
	findSm64Animations,
	findSm64MarioAnimation,
	nearestSm64Animation,
	walkSm64Scripts,
	type Sm64GeoRef,
	type Sm64Scripts,
} from '@tootallnate/sm64';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';
import { decodeF3dexTextures, f3dexTintedLod } from './n64-mesh';
import type { DecodedTexture } from './uasset-material-chain';

interface RomContext {
	rom: Uint8Array;
	scripts: Sm64Scripts;
	cache: Sm64SegmentCache;
}

const contexts = new Map<string, RomContext>();

function contextFor(nodeId: string): RomContext | null {
	for (const [prefix, ctx] of contexts) if (nodeId.startsWith(`${prefix}/`)) return ctx;
	return null;
}

const levelName = (n: number) => (n === 0 ? 'Common' : (SM64_LEVEL_NAMES[n] ?? `Level ${n}`));
const safe = (s: string) => s.replace(/[/\\]/g, '-');

export interface Sm64ModelRef {
	kind: 'model' | 'area';
	index: number;
}

/** True when the ROM has Super Mario 64's level scripts. */
export function sm64Scripts(rom: Uint8Array): Sm64Scripts | null {
	const s = walkSm64Scripts(rom);
	return s && (s.models.length > 0 || s.areas.length > 0) ? s : null;
}

/** `models/` (per level) and `levels/` (per area). */
export function makeSm64Dirs(id: string, rom: Uint8Array, scripts: Sm64Scripts): Node[] {
	const ctx: RomContext = { rom, scripts, cache: new Sm64SegmentCache(rom) };
	contexts.set(id, ctx);
	const leaf = (dirId: string, name: string, ref: Sm64ModelRef, it: Sm64GeoRef): Node => ({
		id: `${dirId}/${name}`,
		name,
		kind: 'file',
		isContainer: false,
		format: ref.kind === 'area' ? 'SM64 area' : 'SM64 model',
		meta: { sm64Model: ref, contentKey: `sm64:${ref.kind}:${it.geo}:${it.segments.get(it.geo >>> 24)?.romStart}` },
		blob: async () => {
			const s = it.segments.get(it.geo >>> 24);
			const b = s ? ctx.cache.get(s) : null;
			return new Blob([(b ?? new Uint8Array(0)) as BlobPart]);
		},
	});
	const byLevel = new Map<number, number[]>();
	scripts.models.forEach((m, i) => (byLevel.get(m.level) ?? byLevel.set(m.level, []).get(m.level)!).push(i));
	const modelsDir: Node = {
		id: `${id}/models`,
		name: 'models',
		kind: 'directory',
		isContainer: true,
		format: 'SM64 models',
		getChildren: async () =>
			[...byLevel.keys()].sort((a, b) => a - b).map((lvl): Node => {
				const dirId = `${id}/models/${safe(levelName(lvl))}`;
				return {
					id: dirId,
					name: safe(levelName(lvl)),
					kind: 'directory',
					isContainer: true,
					format: 'directory',
					getChildren: async () =>
						byLevel.get(lvl)!.map((i) => {
							const m = scripts.models[i]!;
							const base = SM64_MODEL_NAMES[m.modelId] ?? 'model';
							return leaf(dirId, `${base}_0x${m.modelId.toString(16).padStart(2, '0')}.sm64mdl`, { kind: 'model', index: i }, m);
						}),
				};
			}),
	};
	const levelsDir: Node = {
		id: `${id}/levels`,
		name: 'levels',
		kind: 'directory',
		isContainer: true,
		format: 'SM64 levels',
		getChildren: async () =>
			scripts.areas
				// Level 0 areas are the title / file-select screens, drawn by code.
				.flatMap((a, i) => (a.level === 0 ? [] : [leaf(`${id}/levels`, `${safe(levelName(a.level))} area ${a.area}.sm64area`, { kind: 'area', index: i }, a)])),
	};
	return [levelsDir, modelsDir];
}

export interface Sm64ModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	texturedMaterials: number;
	triangles: number;
	vertices: number;
	posed: boolean;
	animatedParts: number;
}

/** Build a `meta.sm64Model` leaf. */
export async function loadSm64ModelView(node: Node): Promise<Sm64ModelView> {
	const ref = node.meta?.sm64Model as Sm64ModelRef | undefined;
	const ctx = contextFor(node.id);
	if (!ref || !ctx) throw new Error('Missing SM64 context');
	const it = ref.kind === 'area' ? ctx.scripts.areas[ref.index] : ctx.scripts.models[ref.index];
	if (!it) throw new Error('Unknown SM64 model');
	const m = buildSm64Geo(ctx.rom, it.segments, it.geo, {
		cache: ctx.cache,
		displayList: 'displayList' in it ? it.displayList : false,
		findAnimation: (parts, segBytes) => {
			const home = it.geo >>> 24;
			for (const seg of [home, ...[...it.segments.keys()].filter((s) => s !== home)]) {
				const b = segBytes(seg);
				if (!b) continue;
				const a = nearestSm64Animation(findSm64Animations(b, seg, parts), seg === home ? it.geo & 0xffffff : 0);
				if (a) return a;
			}
			return findSm64MarioAnimation(ctx.rom, parts);
		},
	});
	if (m.indices.length === 0) throw new Error('This model draws no geometry');
	const textures = decodeF3dexTextures(m.data, m, { tint: true });
	return {
		mesh: { lods: [f3dexTintedLod(m)], upAxis: 'y-up' },
		textures,
		texturedMaterials: textures.filter(Boolean).length,
		triangles: m.indices.length / 3,
		vertices: m.positions.length / 3,
		posed: m.posed,
		animatedParts: m.animatedParts,
	};
}
