/**
 * Super Mario 64 glue: every model the level scripts register (grouped
 * by level, named by actor group / level / model ID from the
 * decompilation) and every area's level geometry. Actors come posed and
 * animated with the animation table stored next to their display lists;
 * Mario with his DMA table, in each of his looks (cap, wing cap, metal).
 * Format logic lives in `@tootallnate/sm64` and `@tootallnate/f3dex`.
 */

import {
	SM64_LEVEL_NAMES,
	SM64_MARIO_ANIMATION_NAMES,
	SM64_MARIO_VARIANTS,
	Sm64SegmentCache,
	buildSm64Geo,
	findSm64ActorAnimations,
	findSm64MarioAnimationTable,
	readSm64MarioAnimation,
	sm64GeoHasDisplayLists,
	sm64MarioPoseOptions,
	sm64ModelName,
	walkSm64Scripts,
	type Sm64Animation,
	type Sm64GeoAnimator,
	type Sm64GeoRef,
	type Sm64MarioVariant,
	type Sm64ModelRef as Sm64ScriptModel,
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
	/** Mario's look, for MODEL_MARIO. */
	variant?: Sm64MarioVariant;
}

/** MODEL_MARIO as the entry script loads it. */
const isMario = (m: Sm64ScriptModel) => m.modelId === 0x01 && m.level === 0 && !m.displayList;

/** True when the ROM has Super Mario 64's level scripts. */
export function sm64Scripts(rom: Uint8Array): Sm64Scripts | null {
	const s = walkSm64Scripts(rom);
	return s && (s.models.length > 0 || s.areas.length > 0) ? s : null;
}

/** File name of a script-registered model: `<name>_0x<id>.sm64mdl`. */
export function sm64ModelFileName(m: Sm64ScriptModel): string {
	return `${sm64ModelName(m) ?? 'model'}_0x${m.modelId.toString(16).padStart(2, '0')}.sm64mdl`;
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
		meta: { sm64Model: ref, contentKey: `sm64:${ref.kind}:${it.geo}:${it.segments.get(it.geo >>> 24)?.romStart}${ref.variant ? `:${ref.variant}` : ''}` },
		blob: async () => {
			const s = it.segments.get(it.geo >>> 24);
			const b = s ? ctx.cache.get(s) : null;
			return new Blob([(b ?? new Uint8Array(0)) as BlobPart]);
		},
	});
	// Layouts with no display list at all are drawn by code (the ending
	// cake, Rainbow Ride's carpet, shadows): nothing to show.
	const draws = (it: Sm64GeoRef & { displayList?: boolean }) => it.displayList || sm64GeoHasDisplayLists(ctx.cache, it.segments, it.geo);
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
						byLevel.get(lvl)!.flatMap((i) => {
							const m = scripts.models[i]!;
							if (!draws(m)) return [];
							if (!isMario(m)) return [leaf(dirId, sm64ModelFileName(m), { kind: 'model', index: i }, m)];
							// Every look of Mario, each a whole model.
							return SM64_MARIO_VARIANTS.map(({ variant, label }) =>
								leaf(dirId, `${label}.sm64mdl`, { kind: 'model', index: i, variant }, m),
							);
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
				.flatMap((a, i) => (a.level === 0 || !draws(a) ? [] : [leaf(`${id}/levels`, `${safe(levelName(a.level))} area ${a.area}.sm64area`, { kind: 'area', index: i }, a)])),
	};
	return [levelsDir, modelsDir];
}

export interface Sm64AnimationClip {
	name: string;
	animation: Sm64Animation;
}

export interface Sm64ModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	texturedMaterials: number;
	triangles: number;
	vertices: number;
	posed: boolean;
	animatedParts: number;
	/** Animations that fit, and the one it was posed with. */
	animations: Sm64AnimationClip[];
	defaultAnimation: number;
	animator: Sm64GeoAnimator;
}

/** Mario's idle (`MARIO_ANIM_IDLE_HEAD_LEFT`), what he does standing still. */
const MARIO_IDLE = 0xc3;

/** Build a `meta.sm64Model` leaf. */
export async function loadSm64ModelView(node: Node): Promise<Sm64ModelView> {
	const ref = node.meta?.sm64Model as Sm64ModelRef | undefined;
	const ctx = contextFor(node.id);
	if (!ref || !ctx) throw new Error('Missing SM64 context');
	const it = ref.kind === 'area' ? ctx.scripts.areas[ref.index] : ctx.scripts.models[ref.index];
	if (!it) throw new Error('Unknown SM64 model');
	const mario = 'modelId' in it && isMario(it);
	let animations: Sm64AnimationClip[] = [];
	let defaultAnimation = -1;
	const m = buildSm64Geo(ctx.rom, it.segments, it.geo, {
		cache: ctx.cache,
		displayList: 'displayList' in it ? it.displayList : false,
		...(mario ? sm64MarioPoseOptions(ref.variant) : {}),
		findAnimation: (parts, segBytes, dls) => {
			if (mario) {
				const table = findSm64MarioAnimationTable(ctx.rom);
				animations = (table?.entries ?? []).flatMap((_, id) => {
					const animation = readSm64MarioAnimation(ctx.rom, table!, id, parts);
					return animation ? [{ name: SM64_MARIO_ANIMATION_NAMES[id] ?? `animation_${id}`, animation }] : [];
				});
				defaultAnimation = Math.max(0, animations.findIndex((a) => a.name === SM64_MARIO_ANIMATION_NAMES[MARIO_IDLE]));
			} else {
				animations = findSm64ActorAnimations(segBytes, dls, parts).map(({ index, animation }) => ({ name: `Animation ${index}`, animation }));
				defaultAnimation = animations.length ? 0 : -1;
			}
			return animations[defaultAnimation]?.animation ?? null;
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
		animations,
		defaultAnimation,
		animator: m.animator,
	};
}
