/**
 * Media scan: walk an opened file's tree once, classify every node into
 * media / known / unknown, merge multi-file assets, and collect what
 * couldn't be interpreted. Streams snapshots so the library fills in
 * while it runs. DOM-free (runs under Bun for `scripts/media-scan.ts`).
 *
 * # Merging ("parts")
 *
 * Some assets span many files. Providers mark the files an asset uses
 * as *parts* of it, which the library hides by default:
 *
 *  - FF7 field characters: an `.hrc` skeleton's RSD → `.p` meshes and
 *    `.tex` textures (resolved by parsing the HRC + RSD text).
 *  - FF7 battle models: every `<id>xx` sibling of a `battle.lgp`
 *    `<id>aa` skeleton.
 *  - Model containers (GFPAK, BFRES, BEA, HSD archives): images inside
 *    the same container as a model are that model's textures.
 *  - Texture names: images whose name matches a texture a model
 *    references (Game Freak field maps keep these in a separate pak).
 *
 * # Cost control
 *
 * Expansion uses the tree's own lazy `getChildren` + `_children` cache,
 * so anything scanned is instant to open later. Containers that would
 * mean multi-GB work for an automatic scan (NCZ / XCZ decompression)
 * are skipped and reported; the caller can rescan with them included.
 */

import { inferAssetClassName, isUasset, parseUasset } from '@tootallnate/uasset';
import { parseGfbmdl, sniffGflx } from '@tootallnate/gfbmdl';

import type { Node } from '../archive';
import { parseFf7HrcForView, parseFf7RsdForView } from '../preview';
import { audioKindFor, classifyNode, titleFor } from './classify';
import {
	MEDIA_INDEX_VERSION,
	type MediaIndex,
	type MediaItem,
	type MediaKind,
	type ScanProblem,
	type UnknownGroup,
} from './types';

export interface ScanOptions {
	signal?: AbortSignal;
	/** Ids of normally-skipped containers to expand anyway. */
	include?: ReadonlySet<string>;
	/** Expand every container regardless of cost. */
	deep?: boolean;
	/** Called with a fresh snapshot at most every `updateIntervalMs`. */
	onUpdate?: (index: MediaIndex) => void;
	updateIntervalMs?: number;
	/** Called as nodes are visited. */
	onProgress?: (visited: number, currentPath: string) => void;
	/** Read the first bytes of a few unknown files per extension. Default true. */
	sampleMagic?: boolean;
	/** Fold identical copies into one item (reads candidate files). Default true. */
	dedupe?: boolean;
}

export interface ScanBase {
	fileName: string;
	fileSize: number;
	platform: string;
}

/** Containers whose expansion is too expensive for an automatic scan. */
function skipReason(node: Node): string | null {
	const fmt = (node.format ?? '').toUpperCase();
	if (fmt === 'NCZ') return 'NCZ: expanding decompresses the whole NCA (zstd, often several GB)';
	if (fmt === 'XCZ') return 'XCZ: compressed cartridge image (zstd NCZ contents)';
	return null;
}

/** Container kinds/formats whose images are textures of the model inside. */
function isModelContainer(node: Node): boolean {
	const fmt = (node.format ?? '').toUpperCase();
	return node.kind === 'gfpak' || node.kind === 'bfres' || node.kind === 'bea' || fmt === 'HSD' || fmt === 'GFPAK';
}

/** BFRES files that are texture / animation companions rather than models. */
const BFRES_COMPANION = /(\.tex\d*|\.texture|_animation|_anim|\.animation)(\.s?bfres)?(\.zs)?$|\.(fskb|fmab|fvbb|fsab|fshb)$/i;

const MAGIC_SAMPLES = 3;

interface Frame {
	node: Node;
	pathNames: string[];
	/** Nearest model-container ancestor id, if any. */
	modelContainer: string | null;
}

export async function scanMedia(root: Node, base: ScanBase, opts: ScanOptions = {}): Promise<MediaIndex> {
	const started = Date.now();
	const { signal, include, deep = false, sampleMagic = true } = opts;
	const updateIntervalMs = opts.updateIntervalMs ?? 400;

	const items = new Map<string, MediaItem>();
	/** part node id → owner item id. */
	const partOwner = new Map<string, string>();
	/** owner item id → part ids. */
	const ownerParts = new Map<string, Set<string>>();
	/** model-container id → model item ids inside it. */
	const containerModels = new Map<string, string[]>();
	/** image item id → its model-container id. */
	const imageContainer = new Map<string, string>();
	/** lower-case texture stem → model item id that references it. */
	const textureRefs = new Map<string, string>();
	const unknown = new Map<string, UnknownGroup & { sampled: number }>();
	const errors: ScanProblem[] = [];
	const skipped: MediaIndex['skipped'] = [];
	let visited = 0;
	let containers = 0;
	let leaves = 0;

	const rootPrefix = root.id.endsWith('/') ? root.id : `${root.id}/`;
	// Display path: relative to the opened file, without the
	// `<content-id>.nca/section1 (RomFS)/` noise of Switch dumps.
	const pathOf = (id: string) =>
		(id.startsWith(rootPrefix) ? id.slice(rootPrefix.length) : id).replace(/^(?:[^/]*\/)*?[0-9a-f]{32}\.nc[az]\/section\d+ \([^)]*\)\//i, '');

	const claim = (owner: string, part: string) => {
		if (owner === part || partOwner.has(part)) return;
		partOwner.set(part, owner);
		let set = ownerParts.get(owner);
		if (!set) ownerParts.set(owner, (set = new Set()));
		set.add(part);
	};

	/** Item id → node, for the duplicate pass. */
	const nodes = new Map<string, Node>();
	const addItem = (node: Node, frame: Frame, kind: MediaKind, previewKind: string, format: string): MediaItem => {
		nodes.set(node.id, node);
		const item: MediaItem = {
			id: node.id,
			kind,
			title: titleFor(node, frame.pathNames),
			path: pathOf(node.id),
			format,
			size: node.size,
			previewKind,
			status: 'ok',
		};
		items.set(item.id, item);
		if (frame.modelContainer) {
			if (kind === 'model') {
				const list = containerModels.get(frame.modelContainer) ?? [];
				list.push(item.id);
				containerModels.set(frame.modelContainer, list);
			} else if (kind === 'image') {
				imageContainer.set(item.id, frame.modelContainer);
			}
		}
		return item;
	};

	const recordUnknown = async (node: Node, path: string) => {
		const size = node.size ?? 0;
		if (size === 0) return; // metadata placeholders, not data
		const dot = node.name.lastIndexOf('.');
		const ext = dot > 0 ? node.name.slice(dot + 1).toLowerCase() : '(none)';
		let g = unknown.get(ext);
		if (!g) unknown.set(ext, (g = { ext, count: 0, totalSize: 0, magics: [], examples: [], sampled: 0 }));
		g.count++;
		g.totalSize += size;
		if (g.examples.length < 5) g.examples.push(path);
		if (sampleMagic && g.sampled < MAGIC_SAMPLES && node.blob) {
			g.sampled++;
			try {
				const head = new Uint8Array(await (await node.blob()).slice(0, 16).arrayBuffer());
				const hex = Array.from(head, (b) => b.toString(16).padStart(2, '0')).join(' ');
				if (hex && !g.magics.includes(hex)) g.magics.push(hex);
			} catch {
				// unreadable sample — skip
			}
		}
	};

	let lastUpdate = 0;
	let sliceStart = Date.now();
	const snapshot = (complete: boolean): MediaIndex =>
		finalize(base, items, partOwner, ownerParts, containerModels, imageContainer, textureRefs, unknown, errors, skipped, {
			visited,
			containers,
			leaves,
			durationMs: Date.now() - started,
		}, complete);

	const stack: Frame[] = [{ node: root, pathNames: [root.name], modelContainer: null }];
	while (stack.length > 0) {
		if (signal?.aborted) break;
		const frame = stack.pop()!;
		const { node } = frame;
		visited++;
		const path = pathOf(node.id);
		opts.onProgress?.(visited, path);

		// Keep the UI responsive: yield every ~12 ms of work.
		if (Date.now() - sliceStart > 12) {
			await new Promise((r) => setTimeout(r, 0));
			sliceStart = Date.now();
		}
		if (opts.onUpdate && Date.now() - lastUpdate > updateIntervalMs) {
			lastUpdate = Date.now();
			opts.onUpdate(snapshot(false));
		}

		if (node.isContainer && node.getChildren) {
			containers++;
			// Containers that are themselves media.
			if (node.kind === 'bfres' && !BFRES_COMPANION.test(node.name)) {
				const item = addItem(node, frame, 'model', 'bfres', 'BFRES');
				// The BFRES is its own model container: its embedded /
				// external texture banks are this model's textures.
				containerModels.set(node.id, [item.id]);
			}
			const reason = skipReason(node);
			if (reason && !deep && !include?.has(node.id) && !node._children) {
				skipped.push({ id: node.id, path, message: reason, size: node.size });
				continue;
			}
			let children: Node[];
			try {
				children = node._children ?? (node._children = await node.getChildren());
			} catch (err) {
				node._childrenError = err instanceof Error ? err : new Error(String(err));
				errors.push({ path, message: node._childrenError.message });
				continue;
			}
			try {
				await containerHooks(node, children, { claim, items, frame });
			} catch {
				// merging is best-effort
			}
			const modelContainer = isModelContainer(node) ? node.id : frame.modelContainer;
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				stack.push({ node: child, pathNames: [...frame.pathNames, child.name], modelContainer });
			}
			continue;
		}

		leaves++;
		let c = classifyNode(node, path);
		// Unreal: the asset class lives in the package header.
		if (c.type === 'known' && c.previewKind === 'uasset-info' && node.blob) {
			c = await classifyUasset(node, path, c.previewKind);
		}
		if (c.type === 'media') {
			const item = addItem(node, frame, c.kind, c.previewKind, c.format);
			if (c.format === 'UE SkeletalMesh') {
				item.status = 'error';
				item.note = 'SkeletalMesh geometry is not decoded yet (only StaticMesh)';
			}
			if (c.previewKind === 'gfbmdl-model') await noteModelTextures(node, item, textureRefs);
		} else if (c.type === 'unknown') {
			await recordUnknown(node, path);
		}
	}

	let index = snapshot(!signal?.aborted);
	if (!signal?.aborted && opts.dedupe !== false) {
		opts.onProgress?.(visited, 'Looking for duplicate files…');
		index = await foldDuplicates(index, nodes, signal);
	}
	opts.onUpdate?.(index);
	return index;
}

/** Whole files up to this size are hashed; larger ones by sampled windows. */
const FULL_HASH_MAX = 4 * 1024 * 1024;
const WINDOW = 256 * 1024;

/** Stop hashing after this long; whatever was found so far is still folded. */
const DEDUPE_BUDGET_MS = 20_000;

/**
 * Content identity of a node. Containers whose leaves are decoded on
 * demand (Halo bitmaps, XA channels, …) either provide a cheap
 * `meta.contentKey` or mark the leaf `meta.decoded` so it's never
 * decoded just to be hashed.
 */
async function fingerprint(node: Node): Promise<string | null> {
	const key = node.meta?.contentKey;
	if (typeof key === 'string') return `key:${key}`;
	if (node.meta?.decoded || !node.blob) return null;
	try {
		const blob = await node.blob();
		let bytes: Uint8Array;
		if (blob.size <= FULL_HASH_MAX) {
			bytes = new Uint8Array(await blob.arrayBuffer());
		} else {
			// Start, middle and end windows (plus the size, below).
			const mid = Math.floor(blob.size / 2 - WINDOW / 2);
			const parts = await Promise.all(
				[0, mid, blob.size - WINDOW].map(async (o) => new Uint8Array(await blob.slice(o, o + WINDOW).arrayBuffer())),
			);
			bytes = new Uint8Array(WINDOW * 3);
			parts.forEach((p, i) => bytes.set(p, i * WINDOW));
		}
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
		return `${blob.size}:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
	} catch {
		return null;
	}
}

/**
 * Fold identical copies (same kind, name, format, size and content)
 * into one item that lists every location. Only top-level items are
 * considered; parts follow their owner.
 */
async function foldDuplicates(index: MediaIndex, nodes: Map<string, Node>, signal?: AbortSignal): Promise<MediaIndex> {
	const groups = new Map<string, MediaItem[]>();
	for (const item of index.items) {
		if (item.partOf) continue;
		const node = nodes.get(item.id);
		const key = `${item.kind}|${item.previewKind}|${item.format}|${item.title.toLowerCase()}|${node?.name.toLowerCase() ?? ''}|${item.size ?? ''}`;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = []));
		g.push(item);
	}
	const hidden = new Set<string>();
	const dupes = new Map<string, { id: string; path: string }[]>();
	let lastYield = Date.now();
	const deadline = Date.now() + DEDUPE_BUDGET_MS;
	let partial = false;
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		if (signal?.aborted) break;
		// Keyed nodes are free; only hashing counts against the budget.
		const needsHash = group.some((i) => typeof nodes.get(i.id)?.meta?.contentKey !== 'string');
		if (needsHash && Date.now() > deadline) {
			partial = true;
			continue;
		}
		const byPrint = new Map<string, MediaItem[]>();
		for (const item of group) {
			const node = nodes.get(item.id);
			const print = node ? await fingerprint(node) : null;
			if (!print) continue;
			let list = byPrint.get(print);
			if (!list) byPrint.set(print, (list = []));
			list.push(item);
			if (Date.now() - lastYield > 12) {
				await new Promise((r) => setTimeout(r, 0));
				lastYield = Date.now();
			}
		}
		for (const same of byPrint.values()) {
			if (same.length < 2) continue;
			const [keep, ...rest] = same;
			dupes.set(keep.id, rest.map((r) => ({ id: r.id, path: r.path })));
			for (const r of rest) hidden.add(r.id);
		}
	}
	if (!hidden.size) return partial ? { ...index, stats: { ...index.stats, duplicatesPartial: true } } : index;
	const items = index.items
		.filter((i) => !hidden.has(i.id) && !(i.partOf && hidden.has(i.partOf)))
		.map((i) => (dupes.has(i.id) ? { ...i, duplicates: dupes.get(i.id) } : i));
	return { ...index, items, stats: { ...index.stats, duplicates: hidden.size, ...(partial && { duplicatesPartial: true }) } };
}

async function classifyUasset(
	node: Node,
	path: string,
	previewKind: string,
): Promise<ReturnType<typeof classifyNode>> {
	try {
		const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
		if (!isUasset(bytes)) return { type: 'known', previewKind };
		const cls = inferAssetClassName(parseUasset(bytes)) ?? '';
		const fmt = `UE ${cls}`;
		if (cls === 'StaticMesh' || cls === 'SkeletalMesh') return { type: 'media', kind: 'model', previewKind, format: fmt };
		if (/^Texture(2D|Cube|2DArray)?$/.test(cls)) return { type: 'media', kind: 'image', previewKind, format: fmt };
		if (cls === 'SoundWave') return { type: 'media', kind: audioKindFor('audio', node, path), previewKind, format: fmt };
		if (cls === 'Font' || cls === 'FontFace') return { type: 'media', kind: 'font', previewKind, format: fmt };
	} catch {
		// header unreadable — treat as non-media
	}
	return { type: 'known', previewKind };
}

/** Remember the textures a Game Freak model references (for the texture-name merge). */
async function noteModelTextures(node: Node, item: MediaItem, refs: Map<string, string>): Promise<void> {
	try {
		const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
		if (sniffGflx(bytes) !== 'gfbmdl') return;
		const model = parseGfbmdl(bytes);
		for (const t of model.textureNames) {
			const k = t.toLowerCase();
			if (!/^dummy/.test(k) && !refs.has(k)) refs.set(k, item.id);
		}
		item.info = { ...item.info, textures: [0, model.textureNames.length] };
	} catch {
		// not fatal — the model is still listed
	}
}

interface HookCtx {
	claim: (owner: string, part: string) => void;
	items: Map<string, MediaItem>;
	frame: Frame;
}

/** Per-container merge rules that need the container's full child list. */
async function containerHooks(container: Node, children: Node[], ctx: HookCtx): Promise<void> {
	const byLower = new Map<string, Node>();
	for (const c of children) byLower.set(c.name.toLowerCase(), c);

	// FF7 battle models: `<id>aa` skeleton owns every `<id>xx` sibling.
	for (const c of children) {
		if (!c.meta?.ff7BattleSkeleton) continue;
		const prefix = c.name.slice(0, 2).toLowerCase();
		for (const s of children) {
			if (s !== c && s.name.length === 4 && s.name.slice(0, 2).toLowerCase() === prefix) ctx.claim(c.id, s.id);
		}
	}

	// FF7 field characters: `.hrc` → RSD → `.p` / `.tex`.
	const hrcs = children.filter((c) => /\.hrc$/i.test(c.name) && c.blob);
	for (const hrcNode of hrcs) {
		// Isolate failures: one unreadable skeleton or RSD mustn't stop
		// the rest of the archive from merging.
		let hrc;
		try {
			hrc = await parseFf7HrcForView(await hrcNode.blob!());
		} catch {
			continue;
		}
		for (const bone of hrc.bones) {
			for (const rsdName of bone.rsds) {
				const rsdNode = byLower.get(`${rsdName.toLowerCase()}.rsd`);
				if (!rsdNode?.blob) continue;
				ctx.claim(hrcNode.id, rsdNode.id);
				try {
					const rsd = await parseFf7RsdForView(await rsdNode.blob());
					const p = byLower.get(`${rsd.ply.toLowerCase()}.p`);
					if (p) ctx.claim(hrcNode.id, p.id);
					for (const t of rsd.textures) {
						const tex = t ? byLower.get(`${t.toLowerCase()}.tex`) : undefined;
						if (tex) ctx.claim(hrcNode.id, tex.id);
					}
				} catch {
					// skip this RSD
				}
			}
		}
	}

	// BFRES companions: `Foo.Tex.sbfres` / `Foo_Animation.sbfres` belong to `Foo.sbfres`.
	for (const c of children) {
		if (c.kind !== 'bfres' || BFRES_COMPANION.test(c.name)) continue;
		const stem = c.name.replace(/(\.s?bfres)?(\.zs)?$/i, '').toLowerCase();
		for (const s of children) {
			if (s === c) continue;
			const lower = s.name.toLowerCase();
			if (lower.startsWith(stem) && BFRES_COMPANION.test(lower)) ctx.claim(c.id, s.id);
		}
	}
}

function finalize(
	base: ScanBase,
	items: Map<string, MediaItem>,
	partOwner: Map<string, string>,
	ownerParts: Map<string, Set<string>>,
	containerModels: Map<string, string[]>,
	imageContainer: Map<string, string>,
	textureRefs: Map<string, string>,
	unknown: Map<string, UnknownGroup & { sampled: number }>,
	errors: ScanProblem[],
	skipped: MediaIndex['skipped'],
	stats: MediaIndex['stats'],
	complete: boolean,
): MediaIndex {
	const owner = new Map(partOwner);
	const parts = new Map<string, Set<string>>();
	for (const [o, set] of ownerParts) parts.set(o, new Set(set));
	const add = (o: string, p: string) => {
		if (o === p || owner.has(p)) return;
		owner.set(p, o);
		let s = parts.get(o);
		if (!s) parts.set(o, (s = new Set()));
		s.add(p);
	};
	for (const item of items.values()) {
		if (item.kind !== 'image' || owner.has(item.id)) continue;
		const container = imageContainer.get(item.id);
		const models = container ? containerModels.get(container) : undefined;
		if (models?.length) {
			add(models[0], item.id);
			continue;
		}
		const stem = item.title.toLowerCase();
		const ref = textureRefs.get(stem);
		if (ref && items.has(ref)) add(ref, item.id);
	}
	const out: MediaItem[] = [];
	for (const item of items.values()) {
		const o = owner.get(item.id);
		const p = parts.get(item.id);
		out.push({
			...item,
			partOf: o && items.has(o) ? o : undefined,
			parts: p && p.size ? [...p] : undefined,
		});
	}
	return {
		version: MEDIA_INDEX_VERSION,
		fileName: base.fileName,
		fileSize: base.fileSize,
		platform: base.platform,
		items: out,
		unknown: [...unknown.values()]
			.map(({ sampled: _, ...g }) => g)
			.sort((a, b) => b.totalSize - a.totalSize),
		errors: [...errors],
		skipped: [...skipped],
		failures: [],
		stats,
		complete,
		scannedAt: Date.now(),
	};
}
