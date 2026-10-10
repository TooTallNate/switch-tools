/**
 * Map tree nodes onto media kinds. Leaf files go through the same
 * {@link previewKindForNode} routing the preview pane uses, so anything
 * the app can preview is classified identically here; files that fall
 * back to the hex view are "unknown" and feed the gap report.
 */

import type { Node } from '../archive';
import { previewKindForNode } from '../preview';
import type { MediaKind } from './types';

export type Classification =
	| { type: 'media'; kind: MediaKind; previewKind: string; format: string }
	/** Understood, but not media (text, metadata, shaders, animations…). */
	| { type: 'known'; previewKind: string }
	/** Fell back to the hex view. */
	| { type: 'unknown' };

const MODEL_KINDS = new Set([
	'gfbmdl-model',
	'hsd-model',
	'n64-model',
	'halo-model',
	'j3d-model',
	'phyre-mesh',
	'ff7-hrc',
	'ff7-battle-skeleton',
	'ff7-pmesh',
	'ff7-world-map',
	'ff8-mch',
	'ff8-battle-dat',
]);

const AUDIO_KINDS = new Set([
	'audio',
	'bfwav-audio',
	'bwav-audio',
	'bfstm-audio',
	'wem-audio',
	'fmod-sample-audio',
	'hca-audio',
	'nx-opus-audio',
	'midi-audio',
]);

const VIDEO_KINDS = new Set(['video', 'usm-video', 'bink1-video', 'bink2-video', 'thp-video', 'mth-video', 'psx-str']);

const FONT_KINDS = new Set(['bfttf-info', 'font-info', 'bffnt-info', 'bmfont-info', 'spritefont-info', 'idfont']);

const IMAGE_KINDS = new Set([
	'image',
	'psx-tim',
	'dds-image',
	'bntx-image',
	'phyre-image',
	'bimage',
	'bti-image',
	'ff7-tex',
	'ff7-field-scene',
	'ff8-field-scene',
]);

/** Kinds whose sound is a long-form stream / sequence rather than an effect. */
const MUSIC_KINDS = new Set(['bfstm-audio', 'midi-audio']);

const MUSIC_PATH = /(^|[\/_.\-])(bgm|music|musics|song|songs|strm|stream|streams|bgms|jingle|me_|ost)([\/_.\-0-9]|$)/i;

/** Compressed / streamed audio above this size is almost always music. */
const MUSIC_SIZE_BYTES = 1_500_000;

/** Music vs sound effect, from container kind, path and size. */
export function audioKindFor(previewKind: string, node: Node, path: string): 'music' | 'sound' {
	if (MUSIC_KINDS.has(previewKind)) return 'music';
	if (MUSIC_PATH.test(path)) return 'music';
	if ((node.size ?? 0) >= MUSIC_SIZE_BYTES) return 'music';
	return 'sound';
}

/** Short format label for the item badge. */
function formatFor(node: Node, previewKind: string): string {
	const special: Record<string, string> = {
		'ff7-hrc': 'FF7 field model',
		'ff7-battle-skeleton': 'FF7 battle model',
		'ff7-pmesh': 'FF7 P mesh',
		'ff7-tex': 'FF7 TEX',
		'ff7-world-map': 'FF7 world map',
		'ff7-field-scene': 'FF7 field background',
		'ff8-field-scene': 'FF8 field background',
		'hsd-model': 'HSD model',
		'n64-model': 'N64 display list',
		'halo-model': 'Halo model',
		'psx-str': 'PlayStation STR',
		'psx-tim': 'PlayStation TIM',
		'ff8-battle-dat': 'FF8 battle model',
		'ff8-mch': 'FF8 field model',
		'j3d-model': 'J3D',
		'gfbmdl-model': 'GFBMDL',
		'unity-object': 'Unity',
	};
	if (special[previewKind]) return special[previewKind];
	if (node.format && node.format !== 'BIN' && node.format !== 'file') return node.format;
	const dot = node.name.lastIndexOf('.');
	return dot > 0 ? node.name.slice(dot + 1).toUpperCase() : previewKind;
}

/** Unity objects carry their class in `meta.unityClass`. */
function unityKind(node: Node): MediaKind | null {
	const cls = node.meta?.unityClass;
	if (cls === 'Mesh') return 'model';
	if (cls === 'Texture2D' || cls === 'Sprite') return 'image';
	if (cls === 'AudioClip') return 'sound';
	if (cls === 'Font') return 'font';
	return null;
}

export function classifyNode(node: Node, path: string): Classification {
	const previewKind = previewKindForNode(node);
	const media = (kind: MediaKind): Classification => ({
		type: 'media',
		kind,
		previewKind,
		format: formatFor(node, previewKind),
	});
	if (previewKind === 'unity-object') {
		const k = unityKind(node);
		if (!k) return { type: 'known', previewKind };
		return {
			type: 'media',
			kind: k === 'sound' ? audioKindFor('audio', node, path) : k,
			previewKind,
			format: `Unity ${String(node.meta?.unityClass)}`,
		};
	}
	if (MODEL_KINDS.has(previewKind)) return media('model');
	if (AUDIO_KINDS.has(previewKind)) return media(audioKindFor(previewKind, node, path));
	if (VIDEO_KINDS.has(previewKind)) return media('video');
	if (FONT_KINDS.has(previewKind)) return media('font');
	if (IMAGE_KINDS.has(previewKind)) return media('image');
	if (previewKind === 'hex') {
		// Companion payloads read through their primary file (UE export
		// bodies / bulk data, Unity resource streams) — not gaps.
		if (/\.(uexp|ubulk|uptnl|ress|resource)$/i.test(node.name)) return { type: 'known', previewKind };
		// PlayStation / PSP system files: boot config, executables, PARAM.SFO.
		if (/^(system\.cnf|param\.sfo|data\.psp|[a-z]{4}_\d{3}\.\d{2})$/i.test(node.name)) return { type: 'known', previewKind };
		return { type: 'unknown' };
	}
	return { type: 'known', previewKind };
}

/** Human title for an item: file name without extension(s) / tree noise. */
export function titleFor(node: Node, pathNames: string[]): string {
	let name = node.name;
	// Unity objects: `<m_Name>.<hint>.bin`, titled by their source asset
	// path from the bundle (`assets/fbx/monsters/pm0025/model.fbx` →
	// `monsters/pm0025/model`) when the bundle names it.
	if (node.kind === 'unity-object') {
		name = name.replace(/\.[a-z0-9]+\.bin$/i, '').replace(/ \(\d+\)$/, '');
		const asset = node.meta?.unityAssetPath;
		if (typeof asset === 'string' && asset) {
			const parts = asset.replace(/^assets\//i, '').replace(/\.[^./]+$/, '').split('/');
			const short = parts.slice(-3).join('/');
			const base = parts[parts.length - 1] ?? '';
			return base.toLowerCase() === name.toLowerCase() || !name ? short : `${short} · ${name}`;
		}
		return name || node.name;
	}
	else name = name.replace(/\.(zs|lz4|szs)$/i, '').replace(/\.[^.\/]+$/, '');
	// Generic leaf names are meaningless on their own — prefix the parent.
	if (/^(model|mesh|root|joint\d*|data|main|index|0x[0-9a-f]+)$/i.test(name) || node.meta?.n64Model) {
		const parent = pathNames[pathNames.length - 2];
		if (parent) name = `${parent.replace(/\.[^.]+$/, '')} · ${name}`;
	}
	return name || node.name;
}
