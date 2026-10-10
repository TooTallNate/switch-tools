/**
 * Media library — the high-level, platform-agnostic view of an opened
 * game file: just its 3D models, music, sound effects, videos, fonts
 * and images, with multi-file assets (an FF7 character's skeleton +
 * meshes + textures, a Game Freak model + its texture pak) merged into
 * single items.
 */

export type MediaKind = 'model' | 'music' | 'sound' | 'video' | 'font' | 'image';

export const MEDIA_KINDS: readonly MediaKind[] = ['model', 'music', 'sound', 'video', 'font', 'image'];

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
	model: '3D models',
	music: 'Music',
	sound: 'Sound effects',
	video: 'Videos',
	font: 'Fonts',
	image: 'Images',
};

export type MediaStatus = 'ok' | 'partial' | 'error';

export interface MediaItem {
	/** Stable id: the primary node's tree id. */
	id: string;
	kind: MediaKind;
	title: string;
	/** Path within the opened file (tree id minus the root segment). */
	path: string;
	/** Format badge, e.g. `GFBMDL`, `BNTX`, `FF7 field model`. */
	format: string;
	size?: number;
	/** The preview kind the detail panel renders for this item's node. */
	previewKind: string;
	/** Tree ids of files merged into this item (meshes, textures, animations). */
	parts?: string[];
	/**
	 * Set when this item is itself a part of another item (a texture of a
	 * model, a mesh piece of a character). Parts are hidden by default.
	 */
	partOf?: string;
	status: MediaStatus;
	/** Why the item is partial / failed. */
	note?: string;
	/** Facts learned while scanning or generating thumbnails. */
	info?: MediaInfo;
	/**
	 * Other places the same file appears (identical content, e.g. the
	 * same model on each disc of a multi-disc game). Those copies are
	 * folded into this item instead of being listed separately.
	 */
	duplicates?: { id: string; path: string }[];
}

export interface MediaInfo {
	durationSec?: number;
	width?: number;
	height?: number;
	triangles?: number;
	vertices?: number;
	/** `[found, wanted]` textures for models. */
	textures?: [number, number];
	/** Sub-asset count (textures in a bank, clips in a model). */
	count?: number;
	/** Animation clips available for a model. */
	animations?: number;
}

/** A group of files the app couldn't interpret (fell back to the hex view). */
export interface UnknownGroup {
	/** Lower-case extension (`(none)` when the file has none). */
	ext: string;
	count: number;
	totalSize: number;
	/** First bytes (hex) of up to a few samples, deduplicated. */
	magics: string[];
	/** A few example paths. */
	examples: string[];
}

export interface ScanProblem {
	path: string;
	message: string;
}

export interface ScanStats {
	visited: number;
	containers: number;
	leaves: number;
	durationMs: number;
	/** Identical copies folded into another item (see `MediaItem.duplicates`). */
	duplicates?: number;
	/** The duplicate pass ran out of time; some copies may still be listed separately. */
	duplicatesPartial?: boolean;
}

/** Everything the library knows about one opened file — what gets cached. */
export interface MediaIndex {
	version: number;
	/** Display name of the opened file. */
	fileName: string;
	fileSize: number;
	/** Root format label (e.g. `NSP`, `N64`, `GCM`). */
	platform: string;
	items: MediaItem[];
	unknown: UnknownGroup[];
	/** Containers that failed to expand (bad keys, corrupt data, unsupported compression). */
	errors: ScanProblem[];
	/** Containers deliberately not expanded (too expensive for an automatic scan). */
	skipped: (ScanProblem & { id: string; size?: number })[];
	/** Items whose preview / thumbnail failed to load. */
	failures: ScanProblem[];
	stats: ScanStats;
	complete: boolean;
	scannedAt: number;
}

/** Bump when classification changes so cached indexes rebuild. */
export const MEDIA_INDEX_VERSION = 2;
