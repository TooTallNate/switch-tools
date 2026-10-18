/**
 * Dropping an item (a BFRES that turns out to hold no model) must not
 * lose its parts. The textures of a texture-only BFRES, such as BotW's
 * item icons and map tiles, become items of their own.
 */
import type { MediaItem } from './types';

export function dropItems<T extends Pick<MediaItem, 'id' | 'partOf'>>(items: T[], dropped: (id: string) => boolean): T[] {
	return items
		.filter((i) => !dropped(i.id))
		.map((i) => (i.partOf && dropped(i.partOf) ? { ...i, partOf: undefined } : i));
}
