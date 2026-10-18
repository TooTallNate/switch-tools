/**
 * Mip 0 of a GX2 (Wii U) or NVN (Switch SDK) texture leaf, for library
 * thumbnails. The previews live in `components/data-previews.tsx`.
 */
import { decodeGx2Surface, parseGx2 } from '@tootallnate/gx2';
import { decodeNvnTexture, parseNvnTexture } from '@tootallnate/nvn-texture';

import type { Node } from './archive';

export async function decodeDataTexture(
	node: Node,
): Promise<{ width: number; height: number; pixels: Uint8Array; count?: number }> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	if (node.meta?.leafFormat === 'nvn-texture') {
		const t = parseNvnTexture(bytes);
		return { width: t.width, height: t.height, pixels: decodeNvnTexture(bytes, t, 0), count: t.layers > 1 ? t.layers : undefined };
	}
	const g = parseGx2(bytes);
	const s = g.surfaces[0];
	if (!s) throw new Error('GX2 file has no texture');
	return { ...decodeGx2Surface(s), count: g.surfaces.length > 1 ? g.surfaces.length : undefined };
}
