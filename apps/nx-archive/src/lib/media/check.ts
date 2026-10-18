/**
 * Headless media check: run the decoders behind library thumbnails
 * without rendering anything, so `scripts/media-scan.ts --check` reports
 * the same partial / failed items the browser's thumbnail pass finds:
 *
 *   - models: the headless loader; missing textures make an item partial
 *   - sounds and music: decode to WAV
 *   - images: decode to RGBA (plain browser images are skipped)
 *
 * Items that turn out not to be models (texture- or animation-only BFRES)
 * are dropped, and their parts promoted to items, as in the library.
 *
 * Fonts and videos need a canvas or WebCodecs, so they're left unchecked.
 */
import type { Node } from '../archive';
import { findNodeById } from '../unity-external';
import { decodeAudioBlob } from './audio';
import { canLoadModelHeadless, loadModelAsset } from './model-assets';
import { decodeImage } from './thumbnails';
import { dropItems } from './orphans';
import type { MediaIndex, MediaItem } from './types';

export interface CheckOptions {
	onProgress?: (done: number, total: number, item: MediaItem) => void;
	/** Only check these kinds (default: models, sounds, music, images). */
	kinds?: Set<MediaItem['kind']>;
}

/** Check one item. Returns its status patch, `drop` for non-models, or null if fine. */
export async function checkMediaItem(
	item: MediaItem,
	node: Node,
	root: Node,
): Promise<{ status: 'partial' | 'error'; note: string } | { drop: true } | null> {
	try {
		switch (item.kind) {
			case 'model': {
				if (!canLoadModelHeadless(item.previewKind)) return null;
				const asset = await loadModelAsset(node, item.previewKind, root);
				const [found, wanted] = asset.texturesFound ?? [0, 0];
				return found < wanted ? { status: 'partial', note: `${wanted - found} of ${wanted} textures not found` } : null;
			}
			case 'sound':
			case 'music':
				await decodeAudioBlob(node, item.previewKind);
				return null;
			case 'image':
				if (item.previewKind !== 'image') await decodeImage(node, item.previewKind);
				return null;
		}
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/no extractable geometry|no BufferInfo block/i.test(message)) return { drop: true };
		return { status: 'error', note: message };
	}
}

/** Check every primary item of an index in place (sets `status` / `note`, removes dropped items). */
export async function checkMedia(index: MediaIndex, root: Node, opts: CheckOptions = {}): Promise<void> {
	const kinds = opts.kinds ?? new Set(['model', 'sound', 'music', 'image']);
	const checkAll = async (todo: MediaItem[]) => {
		const dropped = new Set<string>();
		let done = 0;
		for (const item of todo) {
			const node = await findNodeById(root, item.id);
			const r = node?.blob ? await checkMediaItem(item, node, root) : { status: 'error' as const, note: 'File not found in the tree' };
			if (r && 'drop' in r) dropped.add(item.id);
			else if (r) {
				item.status = r.status;
				item.note = r.note;
			}
			opts.onProgress?.(++done, todo.length, item);
		}
		return dropped;
	};
	const dropped = await checkAll(index.items.filter((i) => !i.partOf && kinds.has(i.kind)));
	if (dropped.size) {
		// Parts of dropped owners become items (as in the library); check them too.
		const promoted = index.items.filter((i) => i.partOf && dropped.has(i.partOf));
		index.items = dropItems(index.items, (id) => dropped.has(id));
		const again = await checkAll(index.items.filter((i) => promoted.some((p) => p.id === i.id) && kinds.has(i.kind)));
		if (again.size) index.items = dropItems(index.items, (id) => again.has(id));
	}
}
