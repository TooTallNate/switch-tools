/**
 * Resolve UE asset references inside a loaded archive tree.
 *
 * UE assets refer to one another by **package path** — strings like
 * `/Game/Foo/Bar/T_Baz` that map to on-disk `.uasset` files via the
 * project's mount-point convention. Inside a `.pak` archive that
 * mapping is:
 *
 *   /Game/Foo/Bar/T_Baz   →  <Project>/Content/Foo/Bar/T_Baz.uasset
 *   /Engine/X/Y/T_Z       →  Engine/Content/X/Y/T_Z.uasset
 *
 * Where `<Project>` is the project name encoded as the PAK's top-level
 * directory (e.g. `Richard` for `Richard-Switch.pak`). We auto-detect
 * the project name by sniffing the root node's children — anything
 * that isn't `Engine` and contains a `Content/` subdir is treated as
 * a project mount.
 *
 * This module is intentionally lightweight: it knows how to turn an
 * UE-style path into an archive `Node` id and find that node, with
 * a small in-memory cache so repeat lookups for the same asset
 * (common when traversing a mesh's material chain) don't re-walk the
 * tree.
 */

import type { Node } from './archive.js';

export interface AssetTriplet {
	uasset: Node;
	uexp: Node | null;
	ubulk: Node | null;
}

/**
 * Cache of resolved asset triplets keyed by package path. Created
 * per-preview so it doesn't leak across asset switches; consumers
 * call {@link createAssetResolver} once and pass the resolver to
 * every chained load.
 */
export interface AssetResolver {
	resolve(packagePath: string): Promise<AssetTriplet | null>;
}

/**
 * Build a resolver scoped to an archive root. The first lookup
 * walks the tree to discover the project-name → top-level-dir
 * mapping; subsequent lookups hit the cache.
 */
export function createAssetResolver(root: Node | null): AssetResolver {
	if (!root) {
		return { resolve: async () => null };
	}
	const cache = new Map<string, Promise<AssetTriplet | null>>();
	let mounts: Promise<MountMap> | null = null;

	const getMounts = (): Promise<MountMap> => {
		if (!mounts) mounts = discoverMounts(root);
		return mounts;
	};

	return {
		async resolve(packagePath: string): Promise<AssetTriplet | null> {
			const cached = cache.get(packagePath);
			if (cached) return cached;
			const promise = (async () => {
				const mountMap = await getMounts();
				const archivePath = mapPackagePath(packagePath, mountMap);
				if (!archivePath) return null;
				const uassetNode = await findNodeByPath(root, archivePath + '.uasset');
				if (!uassetNode) return null;
				const uexpNode = await findNodeByPath(root, archivePath + '.uexp');
				const ubulkNode = await findNodeByPath(root, archivePath + '.ubulk');
				return { uasset: uassetNode, uexp: uexpNode, ubulk: ubulkNode };
			})();
			cache.set(packagePath, promise);
			return promise;
		},
	};
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Map of UE mount-point prefix (e.g. `Game`, `Engine`) to its
 * archive-relative root directory (e.g. `Richard/Content`,
 * `Engine/Content`). Built once per resolver.
 */
interface MountMap {
	[mountName: string]: string;
}

/**
 * Walk the immediate children of `root` to find the project mount
 * point. We expect exactly:
 *   - One project directory (e.g. `Richard/`) containing `Content/`
 *   - An `Engine/` directory containing `Content/` (optional)
 *
 * Some PAKs nest these under a sub-archive (e.g. an NSP whose data
 * NCA contains a romfs whose pak is the actual UE PAK); we descend
 * one level if needed.
 */
async function discoverMounts(root: Node): Promise<MountMap> {
	const out: MountMap = {};
	const queue: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
	while (queue.length > 0) {
		const { node, depth } = queue.shift()!;
		if (depth > 3) continue;
		if (!node.getChildren) continue;
		const kids = node._children ?? (node._children = await node.getChildren());
		for (const kid of kids) {
			if (kid.name === 'Engine') {
				// `Engine/Content/...` is the canonical engine mount.
				out['Engine'] = `${kid.id}/Content`;
			} else if (kid.isContainer && kid.getChildren) {
				// Project directory candidate: has a `Content/` subdir.
				const kidKids = kid._children ?? (kid._children = await kid.getChildren());
				const projContent = kidKids.find((n) => n.name === 'Content' && n.isContainer);
				if (projContent) {
					out['Game'] = projContent.id;
				} else if (depth < 2) {
					// Could be an outer container (NSP → NCA → RomFS → PAK).
					queue.push({ node: kid, depth: depth + 1 });
				}
			}
		}
		// Stop scanning as soon as we have at least the project mount.
		if (out['Game']) break;
	}
	return out;
}

/**
 * Map a UE package path (`/Game/Foo/Bar/T_Baz`) to an archive node
 * id minus the file extension (`Richard/Content/Foo/Bar/T_Baz`).
 *
 * Returns `null` when the mount prefix isn't recognised.
 */
function mapPackagePath(packagePath: string, mounts: MountMap): string | null {
	const match = /^\/([^/]+)\/(.+)$/.exec(packagePath);
	if (!match) return null;
	const mount = match[1]!;
	const tail = match[2]!;
	const base = mounts[mount];
	if (!base) return null;
	return `${base}/${tail}`;
}

/**
 * Locate a node by absolute id string. Mirrors `findNodeById` in
 * preview-pane.tsx but takes a slash-separated path string we
 * construct from the package mapping above.
 *
 * The archive root's id is the empty string; child ids are
 * `<parent.id>/<name>`. We walk segment-by-segment and rely on
 * each container's cached `_children` for repeat lookups.
 */
async function findNodeByPath(root: Node, path: string): Promise<Node | null> {
	const segments = path.split('/').filter((s) => s.length > 0);
	let cur: Node = root;
	for (const seg of segments) {
		if (!cur.getChildren) return null;
		const kids = cur._children ?? (cur._children = await cur.getChildren());
		const next = kids.find((n) => n.name === seg);
		if (!next) return null;
		cur = next;
	}
	return cur;
}
