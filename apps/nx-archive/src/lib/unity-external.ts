/**
 * Cross-bundle reference resolution for Unity AssetBundles.
 *
 * A SerializedFile names the other files it references in
 * `externals` (e.g. `archive:/CAB-e1af…/CAB-e1af…`), and a PPtr with
 * `m_FileID = n` points into `externals[n - 1]`. In Addressables
 * builds, shared materials and textures routinely live in other
 * bundles. Super Mario RPG's map and character meshes are an example.
 *
 * The CAB name isn't derivable from the bundle's file name, so we
 * index it. Each `.bundle` near the referencing one is read with
 * `parseUnityFs`, which reads only the header and block-info table
 * (a few KB, no payload decompression). The index is built once per
 * search scope and cached. Only the bundle that actually holds a
 * referenced CAB is expanded.
 */
import type { Node } from './archive';
import { parseUnityFs } from './unityfs';

/** Resolve a node by id, expanding (and caching) children along the way. */
export async function findNodeById(root: Node, targetId: string): Promise<Node | null> {
	if (root.id === targetId) return root;
	if (!targetId.startsWith(root.id + '/') && root.id !== '') return null;
	let cur: Node = root;
	while (cur.id !== targetId) {
		if (!cur.getChildren) return null;
		let kids = cur._children;
		if (!kids) {
			try {
				kids = await cur.getChildren();
				cur._children = kids;
			} catch {
				return null;
			}
		}
		let next: Node | null = null;
		for (const k of kids) {
			if (k.id === targetId || targetId.startsWith(k.id + '/')) {
				if (!next || k.id.length > next.id.length) next = k;
			}
		}
		if (!next) return null;
		cur = next;
	}
	return cur;
}

async function childrenOf(node: Node): Promise<Node[]> {
	if (!node.getChildren) return [];
	if (node._children) return node._children;
	try {
		node._children = await node.getChildren();
		return node._children;
	} catch {
		return [];
	}
}

const parentIdOf = (id: string) => {
	const slash = id.lastIndexOf('/');
	return slash > 0 ? id.slice(0, slash) : null;
};

/** `archive:/CAB-abc/CAB-abc` → `cab-abc` (the SerializedFile's node name, lower-cased). */
export function externalCabName(pathName: string): string {
	const m = /([^/\\]+)$/.exec(pathName.replace(/\0+$/, ''));
	return (m ? m[1]! : pathName).toLowerCase();
}

/** How many directory levels above a bundle's own directory to search. */
const SEARCH_LEVELS_UP = 3;

type CabIndex = Map<string, Node>;
const indexCache = new WeakMap<Node, Map<string, Promise<CabIndex>>>();

/**
 * Directory to scan for sibling bundles: up to {@link SEARCH_LEVELS_UP}
 * directory levels above the bundle, stopping at the first
 * non-directory ancestor (the RomFS / NCA / archive root).
 */
async function searchScope(root: Node, bundleId: string): Promise<Node | null> {
	let scope: Node | null = null;
	let id = parentIdOf(bundleId);
	for (let level = 0; id && level <= SEARCH_LEVELS_UP; level++) {
		const node = await findNodeById(root, id);
		if (!node || node.kind !== 'directory') break;
		scope = node;
		id = parentIdOf(id);
	}
	return scope;
}

async function buildCabIndex(scope: Node): Promise<CabIndex> {
	const bundles: Node[] = [];
	const walk = async (dir: Node): Promise<void> => {
		for (const k of await childrenOf(dir)) {
			if (k.kind === 'directory') await walk(k);
			else if (k.kind === 'unityfs' && k.blob) bundles.push(k);
		}
	};
	await walk(scope);
	const index: CabIndex = new Map();
	// Bounded concurrency keeps the underlying reads (often AES-CTR
	// over an NCA) from all landing at once.
	const queue = [...bundles];
	const worker = async () => {
		for (let b = queue.shift(); b; b = queue.shift()) {
			try {
				const fs = await parseUnityFs(await b.blob!());
				for (const n of fs.nodes) {
					const name = externalCabName(n.path);
					if (!name.endsWith('.ress') && !name.endsWith('.resource') && !index.has(name)) {
						index.set(name, b);
					}
				}
			} catch {
				// Not a readable UnityFS bundle; skip.
			}
		}
	};
	await Promise.all(Array.from({ length: 8 }, worker));
	return index;
}

/**
 * Find the SerializedFile node for `cabName` (lower-cased, e.g.
 * `cab-e1af…`), searching bundles near the one containing
 * `fromCabId`. Returns `null` if it can't be located.
 */
export async function findExternalCab(
	root: Node,
	fromCabId: string,
	cabName: string,
): Promise<Node | null> {
	// Same bundle first (multi-CAB bundles, scene bundles).
	const bundleId = parentIdOf(fromCabId);
	if (!bundleId) return null;
	const bundle = await findNodeById(root, bundleId);
	if (bundle) {
		const hit = (await childrenOf(bundle)).find((k) => k.name.toLowerCase() === cabName);
		if (hit) return hit;
	}
	const scope = await searchScope(root, bundleId);
	if (!scope) return null;
	let perRoot = indexCache.get(root);
	if (!perRoot) indexCache.set(root, (perRoot = new Map()));
	let index = perRoot.get(scope.id);
	if (!index) perRoot.set(scope.id, (index = buildCabIndex(scope)));
	const owner = (await index).get(cabName);
	if (!owner) return null;
	return (await childrenOf(owner)).find((k) => k.name.toLowerCase() === cabName) ?? null;
}
