/**
 * Title RomFS lookup, for files that refer to other files of the same
 * game by path.
 *
 * Example: a BFSTP inside a BARS sound archive is only a prefetch, the
 * opening fraction of a second of a stream. The game plays the rest from
 * a `.bfstm` of the same name elsewhere in its RomFS (BotW:
 * `Sound/Resource/Stream/`).
 *
 * Every RomFS node registers itself here when it's built. A nested file
 * finds its title's RomFS by node id (the RomFS id is a prefix of every
 * node under it) and walks the path from there, reusing children that are
 * already listed. Nothing has to walk the tree from the root, the same
 * approach as `./title-exefs`.
 */
import type { Node } from './archive';

const romfsRoots = new Map<string, Node>();

/** Register the RomFS node `node`. */
export function registerRomfs(node: Node): void {
	romfsRoots.set(node.id, node);
}

/**
 * The RomFS a node belongs to: the registered RomFS whose id is the
 * longest prefix of `nodeId`. Failing that, a RomFS in the same package,
 * e.g. an update's patched RomFS.
 */
export function romfsFor(nodeId: string): Node | null {
	let best: Node | null = null;
	for (const [id, node] of romfsRoots) {
		if (nodeId.startsWith(`${id}/`) && (!best || id.length > best.id.length)) best = node;
	}
	if (best) return best;
	const pkg = nodeId.split('/').slice(0, 2).join('/');
	for (const [id, node] of romfsRoots) if (id.startsWith(`${pkg}/`)) return node;
	return null;
}

async function childrenOf(node: Node): Promise<Node[]> {
	if (node._children) return node._children;
	if (!node.getChildren) return [];
	const kids = await node.getChildren();
	node._children = kids;
	return kids;
}

/**
 * The file at `path` (`/`-separated, relative to the RomFS root) in the
 * RomFS that `nodeId` belongs to, or null.
 */
export async function romfsFileFor(nodeId: string, path: string): Promise<Node | null> {
	let node = romfsFor(nodeId);
	for (const part of path.split('/').filter(Boolean)) {
		if (!node) return null;
		node = (await childrenOf(node).catch(() => [])).find((k) => k.name === part) ?? null;
	}
	return node;
}
