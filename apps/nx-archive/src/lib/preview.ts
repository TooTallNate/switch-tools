/**
 * File preview type detection + content loaders.
 *
 * For "kitchen sink" support:
 *   - text/JSON/XML/code: load as text
 *   - image: load as object URL (PNG, JPEG, GIF, WebP, SVG, BMP)
 *   - audio/video: load as object URL with appropriate MIME
 *   - NACP: parse with @tootallnate/nacp into a friendly form
 *   - CNMT: parse the binary into a friendly form
 *   - NRO: read the executable header
 *   - NSO: parse the NSO0 header
 *   - default: hex view of first N bytes
 */

import { NACP } from '@tootallnate/nacp';
import { parseHeader as parseNsoHeader, hex as nsoHex, type ParsedNsoHeader } from '@tootallnate/nso';
import { parseNpdm, hex as npdmHex, type ParsedNpdm } from '@tootallnate/npdm';
import { isBfttf, parseBfttf, type ParsedBfttf } from '@tootallnate/bfttf';
import {
	decodeBffnt,
	parseBffnt,
	renderText,
	textureFormatName,
	type ParsedBffnt,
	type RenderableBffnt,
} from '@tootallnate/bffnt';
import { parseBars, type ParsedBars } from '@tootallnate/bars';
import { parseBfsar, type ParsedBfsar } from '@tootallnate/bfsar';
import {
	parseBfwav,
	decodeBfwavToPcm16,
	type ParsedBfwav,
} from '@tootallnate/bfwav';
import {
	parseBfstm,
	decodeBfstmToPcm16,
	type ParsedBfstm,
} from '@tootallnate/bfstm';
import { encodeWav, encodeWavBlob } from '@tootallnate/dsp-adpcm';
import {
	isMsAdpcmWav,
	transcodeMsAdpcmToPcmWav,
} from '@tootallnate/ms-adpcm';
import { parseBarslist, type ParsedBarslist } from '@tootallnate/barslist';
import {
	parseBnvib,
	renderBnvibToPcm16,
	type ParsedBnvib,
} from '@tootallnate/bnvib';
import { parseByaml, byamlToJson, type ParsedByaml } from '@tootallnate/byaml';
import {
	parseBntx,
	decodeBntxLayer,
	type ParsedBntx,
	type BntxTexture,
	decodeBC1,
	decodeBC2,
	decodeBC3,
	decodeBC4,
	decodeBC5,
	decodeBC7,
} from '@tootallnate/bntx';
import {
	parsePhyre,
	findTexture,
	extractTexturePixels,
	deswizzleNvnMip,
	encodeAsDds,
	bytesForMipLevel,
	findMesh,
	extractPositions,
	extractIndices,
	extractUVs,
	extractNormals,
	findAssetReferences,
	type ParsedPhyre,
	type PhyreTexture,
	type PhyreMesh,
	type PhyreMeshSegment,
	type PhyreAssetReference,
} from '@tootallnate/phyre';
import { getAstcBlockDecoder } from './astc';
import { parseBfres, type ParsedBfres } from '@tootallnate/bfres';
import {
	parseWem,
	decodeWemToBlob,
	type ParsedWem,
	type WemDecodeResult,
} from '@tootallnate/wem';
import { parseFmodBank, extractFsb5FromBank } from '@tootallnate/fmod-bank';
import {
	parseFsb5,
	decodeSampleToBlob,
	loadFmodVorbisSetupPackets,
	SOUND_FORMAT_NAMES,
	type ParsedFsb5,
	type ParsedFsb5Sample,
	type DecodeSampleResult,
	type FmodVorbisSetupPackets,
} from '@tootallnate/fsb5';

export type PreviewKind =
	| 'text'
	| 'json'
	| 'image'
	| 'audio'
	| 'video'
	| 'nacp'
	| 'cnmt'
	| 'nro-info'
	| 'nso-info'
	| 'npdm-info'
	| 'bfttf-info'
	| 'font-info'
	| 'bffnt-info'
	/** AngelCode BMFont (`.fnt`) bitmap font descriptor. */
	| 'bmfont-info'
	/** DirectXTK SpriteFont (`.spritefont`, `DXTKfont` magic) — bitmap-atlas font. */
	| 'spritefont-info'
	/** Switch / Wii U single-shot audio (BFWAV / BFSTP, also BARS-embedded FWAVs). */
	| 'bfwav-audio'
	/** Nintendo BWAV (newer than BFWAV; BotW 2 / TotK / Wonder era). */
	| 'bwav-audio'
	/** Switch / Wii U streamed audio (BFSTM / BFSTP). */
	| 'bfstm-audio'
	/** Wwise WEM audio asset (Switch-Opus → Ogg, PCM → WAV). */
	| 'wem-audio'
	/** FMOD Studio FSB5 sample (PCM → WAV, FMOD-Vorbis → Ogg-Vorbis). */
	| 'fmod-sample-audio'
	/** CRI HCA — a single High Compression Audio track. Browsing
	 * an AWB bank or any source that hands us raw HCA bytes routes
	 * here; the preview decodes to PCM via `@tootallnate/hca`. */
	| 'hca-audio'
	/** Tiny ARSL manifest of BARS file paths. */
	| 'barslist-info'
	/** Nintendo MSBT (MsgStdBn) — localized text/dialog/UI strings. */
	| 'msbt-text'
	/** TotK / Wonder AI behavior-tree node binary (`.ainb`). */
	| 'ainb-info'
	/** Switch NRR0 — registry of NRO SHA-256 hashes a title may load. */
	| 'nrr-info'
	/** NintendoWare VFXB particle (`.ptcl`). */
	| 'ptcl-info'
	/** NintendoWare BNSH shader binary (`.bnsh`, `.bnsh_vsh`, `.bnsh_fsh`). */
	| 'bnsh-info'
	/** NintendoWare BFCPX composite-font manifest. */
	| 'bfcpx-info'
	/** Switch HD Rumble vibration patterns. */
	| 'bnvib-audio'
	/** Nintendo binary YAML — game configs / data tables. */
	| 'byaml-tree'
	/** Nintendo texture format (BC1/3/4/5/7, RGBA8, etc.). */
	| 'bntx-image'
	/** Sony PhyreEngine (`.phyre`) texture — FFX/X-2 HD, FFXII TZA. */
	| 'phyre-image'
	/** Sony PhyreEngine (`.dae.phyre`) 3D mesh — FFX/X-2 HD characters, weapons, maps. */
	| 'phyre-mesh'
	/** CRI Sofdec2 USM video container (VP9 / H.264 + HCA / ADX / PCM). */
	| 'usm-video'
	/** Bink 1 (`.bik`) video — decode via shipped WASM, re-encode to MP4. */
	| 'bink1-video'
	/**
	 * idTech BFG bitmap font metrics (`newfonts/<Family>/48.dat`).
	 * Decoded alongside the matching `.bimage` atlas to render a
	 * live preview of the font's glyphs.
	 */
	| 'idfont'
	/**
	 * idTech BFG preprocessed texture (`.bimage`). Header + per-mip
	 * decode, rendered as a flat image.
	 */
	| 'bimage'
	/** Bink 2 (`.bk2`) video — decode via user-supplied WASM, re-encode to MP4. */
	| 'bink2-video'
	/** Unity SerializedFile (`CAB-…` inside an AssetBundle). */
	| 'unity-asset'
	/** A single object inside a Unity SerializedFile (Font, Texture2D, …). */
	| 'unity-object'
	/** JSON with a collapsible-tree view (default) plus a Source toggle. */
	| 'json-tree'
	/** YAML, parsed to a JS value tree, presented like `json-tree`. */
	| 'yaml-tree'
	/**
	 * Standalone HTML file: rendered in a sandboxed iframe by default
	 * (with `.htdocs` ancestor's siblings as the resource scope when
	 * available), with a Source toggle for syntax-highlighted text.
	 */
	| 'html-preview'
	/** Unreal Engine `.uasset` / `.umap` package — header-level inspection. */
	| 'uasset-info'
	| 'hex';

export const TEXT_EXTS = new Set([
	'txt',
	'md',
	'log',
	'cfg',
	'ini',
	'toml',
	'csv',
	'tsv',
	'srt',
	'asm',
	's',
	'c',
	'h',
	'cpp',
	'hpp',
	'rs',
	'go',
	'js',
	'mjs',
	'ts',
	'tsx',
	'jsx',
	'lua',
	'sh',
	'bash',
	'py',
	'sql',
	'css',
]);

export const JSON_EXTS = new Set([
	'json',
	'webmanifest',
	// Unreal Engine descriptor files. Both `.uproject` and
	// `.uplugin` are JSON documents in disguise — detecting them
	// as JSON gets us the tree view + syntax-highlighted source
	// for free.
	'uproject',
	'uplugin',
]);
export const YAML_EXTS = new Set(['yml', 'yaml']);
export const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);
export const XML_EXTS = new Set(['xml', 'svg', 'plist']);
export const IMAGE_EXTS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'bmp',
	'avif',
	'ico',
]);
export const AUDIO_EXTS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a']);
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv']);

export const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	svg: 'image/svg+xml',
};

export const AUDIO_MIME: Record<string, string> = {
	wav: 'audio/wav',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
};

export const VIDEO_MIME: Record<string, string> = {
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
};

/**
 * Coerce an audio blob into a browser-playable form.
 *
 * `<audio>` and `AudioContext.decodeAudioData()` support only a
 * small set of codecs across vendors — PCM WAV, MP3, AAC,
 * Vorbis, Opus, FLAC. Any of the *other* WAV codec tags
 * (MS-ADPCM, IMA-ADPCM, A-law, mu-law, GSM…) silently fail
 * with `NS_ERROR_DOM_MEDIA_METADATA_ERR` on Firefox or
 * `Failed to load because no supported source was found` on
 * Chrome.
 *
 * This helper sniffs the RIFF header up front; if the file is
 * a MS-ADPCM WAV we transcode it to PCM-WAV via
 * `@tootallnate/ms-adpcm` and hand back the new Blob. For
 * everything else (PCM WAV, MP3, etc.) we return the source
 * blob unchanged.
 *
 * Only inspected for `.wav` inputs — non-WAV containers can't
 * suffer from this issue.
 */
export async function prepareAudioBlobForBrowser(
	blob: Blob,
	filename: string,
): Promise<Blob> {
	if (!filename.toLowerCase().endsWith('.wav')) return blob;
	// Peek at just enough of the header to identify the codec.
	// The MS-ADPCM check needs the first 22 bytes (RIFF magic +
	// WAVE + fmt header up to wFormatTag).
	const head = new Uint8Array(await blob.slice(0, 22).arrayBuffer());
	if (!isMsAdpcmWav(head)) return blob;
	// Confirmed MS-ADPCM — pull the full bytes and transcode to
	// PCM-WAV. Materialising the full file is necessary anyway:
	// browsers don't tolerate streaming reencoding via
	// MediaSource (no PCM source buffer support).
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return transcodeMsAdpcmToPcmWav(bytes);
}

export function extOf(name: string): string {
	const i = name.lastIndexOf('.');
	if (i < 0) return '';
	return name.slice(i + 1).toLowerCase();
}

/**
 * Bare filenames (no extension) used for NSO0 executable modules
 * inside an ExeFS PFS0. Files with these names get the structured NSO
 * preview by default; any file ending with `.nso` matches too.
 */
const NSO_BARE_NAMES = new Set([
	'main',
	'rtld',
	'sdk',
	'subsdk0',
	'subsdk1',
	'subsdk2',
	'subsdk3',
	'subsdk4',
	'subsdk5',
	'subsdk6',
	'subsdk7',
	'subsdk8',
	'subsdk9',
]);

export function detectPreviewKind(name: string): PreviewKind {
	const lower = name.toLowerCase();
	if (lower.endsWith('.nacp') || lower === 'control.nacp') return 'nacp';
	if (lower.endsWith('.cnmt')) return 'cnmt';
	if (lower.endsWith('.nro') || lower === 'main.nro') return 'nro-info';
	if (lower.endsWith('.npdm') || lower === 'main.npdm') return 'npdm-info';
	if (lower.endsWith('.nso') || NSO_BARE_NAMES.has(lower)) return 'nso-info';
	if (lower.endsWith('.bfttf') || lower.endsWith('.bfotf')) return 'bfttf-info';
	if (
		lower.endsWith('.ttf') ||
		lower.endsWith('.otf') ||
		lower.endsWith('.ttc') ||
		lower.endsWith('.otc') ||
		lower.endsWith('.woff') ||
		lower.endsWith('.woff2') ||
		// `.ufont` is the UE cooker's sibling-file format for
		// FontFace assets with a streaming load policy: the raw
		// TTF / OTF bytes verbatim, no UE wrapper. parseFontForView
		// sniffs the sfnt format from the magic bytes, so the
		// extension only needs to route here.
		lower.endsWith('.ufont')
	)
		return 'font-info';
	if (lower.endsWith('.bffnt')) return 'bffnt-info';
	if (lower.endsWith('.fnt')) return 'bmfont-info';
	if (lower.endsWith('.spritefont')) return 'spritefont-info';
	if (lower.endsWith('.uasset') || lower.endsWith('.umap'))
		return 'uasset-info';
	if (lower.endsWith('.bfwav')) return 'bfwav-audio';
	if (lower.endsWith('.bwav')) return 'bwav-audio';
	if (lower.endsWith('.msbt')) return 'msbt-text';
	if (lower.endsWith('.ainb')) return 'ainb-info';
	if (lower.endsWith('.nrr')) return 'nrr-info';
	if (lower.endsWith('.ptcl')) return 'ptcl-info';
	if (
		lower.endsWith('.bnsh') ||
		lower.endsWith('.bnsh_vsh') ||
		lower.endsWith('.bnsh_fsh')
	) {
		return 'bnsh-info';
	}
	if (lower.endsWith('.bfcpx')) return 'bfcpx-info';
	if (lower.endsWith('.bfstm') || lower.endsWith('.bfstp')) return 'bfstm-audio';
	if (lower.endsWith('.wem')) return 'wem-audio';
	// CRI HCA — standalone tracks (extracted from AWB or hand-named).
	// AWB itself is recognised one level up: its container Node has
	// `kind === 'awb'` and the preview pane dispatches directly on
	// that, so it never reaches `detectPreviewKind`.
	if (lower.endsWith('.hca')) return 'hca-audio';
	// Unreal `.ubulk` is a codec-agnostic "bulk data" sidecar, but in
	// practice the overwhelming majority of `.ubulk` files we encounter
	// are Wwise audio payloads (RIFF/WAVE wrappers) sitting under
	// `…/WwiseAudio/Media/`. Route them to the WEM player — for a
	// non-WEM `.ubulk` (e.g. texture-mip stream) `parseWem` throws a
	// clean error which the preview surfaces gracefully.
	if (lower.endsWith('.ubulk')) return 'wem-audio';
	if (lower.endsWith('.barslist')) return 'barslist-info';
	if (lower.endsWith('.bnvib')) return 'bnvib-audio';
	// `.byaml` / `.byml` are the historical extensions; TotK / Mario
	// Wonder switched to `.bgyml` ("Binary Game YAML") for game-config
	// resources but the on-disc format is identical (same YB / BY magic,
	// same encoding). One dispatch routes them all to the BYAML tree
	// preview.
	if (
		lower.endsWith('.byaml') ||
		lower.endsWith('.byml') ||
		lower.endsWith('.bgyml')
	) {
		return 'byaml-tree';
	}
	if (lower.endsWith('.bntx')) return 'bntx-image';
	// PhyreEngine: split by sub-extension. `.dds.phyre` -> textures;
	// `.dae.phyre` -> 3D meshes. `.fx.phyre` (shaders) and
	// `.ags.phyre` (animations) fall through to hex.
	if (lower.endsWith('.dds.phyre')) return 'phyre-image';
	if (lower.endsWith('.dae.phyre')) return 'phyre-mesh';
	if (lower.endsWith('.usm')) return 'usm-video';
	if (lower.endsWith('.bik')) return 'bink1-video';
	if (lower.endsWith('.bk2')) return 'bink2-video';
	// Switch app icons (in Control NCA RomFS) are JPEGs with a `.dat` ext.
	if (/^icon_.*\.dat$/.test(lower)) return 'image';
	const ext = extOf(name);
	if (IMAGE_EXTS.has(ext)) return 'image';
	if (AUDIO_EXTS.has(ext)) return 'audio';
	if (VIDEO_EXTS.has(ext)) return 'video';
	if (JSON_EXTS.has(ext)) return 'json-tree';
	if (YAML_EXTS.has(ext)) return 'yaml-tree';
	if (HTML_EXTS.has(ext)) return 'html-preview';
	if (XML_EXTS.has(ext) || TEXT_EXTS.has(ext)) return 'text';
	return 'hex';
}

// Special case for NRO files where the asset section may have been embedded —
// for those we want to show NRO info, not raw hex. But if the user explicitly
// chose a `.nro` we still show NRO info via the dedicated case above.

// ----- NACP parsing (uses @tootallnate/nacp) -----

export interface NacpView {
	title: string;
	author: string;
	version: string;
	id: string;
	addOnContentBaseId: string;
	saveDataOwnerId: string;
	presenceGroupId: string;
	hdcp: number;
	screenshot: number;
	videoCapture: number;
	logoType: number;
	logoHandling: number;
	startupUserAccount: number;
	supportedLanguageFlag: number;
	parentalControlFlag: number;
	attributeFlag: number;
}

export async function parseNacpForView(blob: Blob): Promise<NacpView> {
	// NACP is exactly 0x4000 bytes
	const buf = await blob.arrayBuffer();
	const sized =
		buf.byteLength >= 0x4000 ? buf.slice(0, 0x4000) : padTo(buf, 0x4000);
	const nacp = new NACP(sized);
	return {
		title: nacp.title,
		author: nacp.author,
		version: nacp.version,
		id: '0x' + nacp.id.toString(16).padStart(16, '0'),
		addOnContentBaseId:
			'0x' + nacp.addOnContentBaseId.toString(16).padStart(16, '0'),
		saveDataOwnerId:
			'0x' + nacp.saveDataOwnerId.toString(16).padStart(16, '0'),
		presenceGroupId:
			'0x' + nacp.presenceGroupId.toString(16).padStart(16, '0'),
		hdcp: nacp.hdcp,
		screenshot: nacp.screenshot,
		videoCapture: nacp.videoCapture,
		logoType: nacp.logoType,
		logoHandling: nacp.logoHandling,
		startupUserAccount: nacp.startupUserAccount,
		supportedLanguageFlag: nacp.supportedLanguageFlag,
		parentalControlFlag: nacp.parentalControlFlag,
		attributeFlag: nacp.attributeFlag,
	};
}

function padTo(buf: ArrayBuffer, size: number): ArrayBuffer {
	const out = new ArrayBuffer(size);
	new Uint8Array(out).set(new Uint8Array(buf));
	return out;
}

// ----- CNMT parsing -----
// Layout: switchbrew.org/wiki/CNMT
//   0x00 u64 title_id
//   0x08 u32 title_version
//   0x0C u8  title_type
//   0x0D u8  reserved
//   0x0E u16 extended_header_size
//   0x10 u16 content_count
//   0x12 u16 content_meta_count
//   0x14 u8  attribute
//   ...
//   0x20 u8 required_system_version
//   then extended header bytes,
//   then content_count × ContentRecord (0x38 bytes each)
//
// ContentRecord (0x38):
//   hash[0x20], nca_id[0x10], size[6 little-endian], type(u8), id_offset(u8)

export interface CnmtView {
	titleId: string;
	titleVersion: number;
	titleType: number;
	titleTypeName: string;
	contentCount: number;
	contentMetaCount: number;
	requiredSystemVersion: number;
	contents: Array<{
		ncaId: string;
		hash: string;
		size: number;
		type: number;
		typeName: string;
		idOffset: number;
	}>;
}

const META_TYPE_NAMES: Record<number, string> = {
	0x01: 'SystemProgram',
	0x02: 'SystemData',
	0x03: 'SystemUpdate',
	0x04: 'BootImagePackage',
	0x05: 'BootImagePackageSafe',
	0x80: 'Application',
	0x81: 'Patch',
	0x82: 'AddOnContent',
	0x83: 'Delta',
};

const CONTENT_TYPE_NAMES: Record<number, string> = {
	0: 'Meta',
	1: 'Program',
	2: 'Data',
	3: 'Control',
	4: 'HtmlDocument',
	5: 'LegalInformation',
	6: 'DeltaFragment',
};

export async function parseCnmtForView(blob: Blob): Promise<CnmtView> {
	const buf = await blob.arrayBuffer();
	const view = new DataView(buf);
	if (buf.byteLength < 0x20) {
		throw new Error('CNMT too small');
	}
	const titleId = view.getBigUint64(0x00, true);
	const titleVersion = view.getUint32(0x08, true);
	const titleType = view.getUint8(0x0c);
	const extendedHeaderSize = view.getUint16(0x0e, true);
	const contentCount = view.getUint16(0x10, true);
	const contentMetaCount = view.getUint16(0x12, true);
	const requiredSystemVersion = view.getUint32(0x28, true);

	const contentsOffset = 0x20 + extendedHeaderSize;
	const contents: CnmtView['contents'] = [];
	for (let i = 0; i < contentCount; i++) {
		const off = contentsOffset + i * 0x38;
		if (off + 0x38 > buf.byteLength) break;
		const hashBytes = new Uint8Array(buf, off, 0x20);
		const ncaIdBytes = new Uint8Array(buf, off + 0x20, 0x10);
		// size is 6 bytes little-endian (max 0xFFFF_FFFF_FFFF = ~280 TB, well within Number safety)
		const sizeBytes = new Uint8Array(buf, off + 0x30, 6);
		let size = 0;
		for (let k = 5; k >= 0; k--) size = size * 256 + sizeBytes[k];
		const type = view.getUint8(off + 0x36);
		const idOffset = view.getUint8(off + 0x37);
		contents.push({
			hash: hex(hashBytes),
			ncaId: hex(ncaIdBytes),
			size,
			type,
			typeName: CONTENT_TYPE_NAMES[type] ?? `Unknown(${type})`,
			idOffset,
		});
	}

	return {
		titleId: '0x' + titleId.toString(16).padStart(16, '0'),
		titleVersion,
		titleType,
		titleTypeName: META_TYPE_NAMES[titleType] ?? `Unknown(0x${titleType.toString(16)})`,
		contentCount,
		contentMetaCount,
		requiredSystemVersion,
		contents,
	};
}

// ----- NRO parsing -----

export interface NroView {
	magic: string;
	formatVersion: number;
	nroSize: number;
	flags: number;
	hasAssets: boolean;
}

export async function parseNroForView(blob: Blob): Promise<NroView> {
	const head = new Uint8Array(await blob.slice(0, 0x40).arrayBuffer());
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const magic = new TextDecoder().decode(head.subarray(0x10, 0x14));
	if (magic !== 'NRO0') throw new Error('Not an NRO');
	const formatVersion = view.getUint32(0x14, true);
	const nroSize = view.getUint32(0x18, true);
	const flags = view.getUint32(0x1c, true);

	let hasAssets = false;
	if (blob.size >= nroSize + 4) {
		const aset = new Uint8Array(
			await blob.slice(nroSize, nroSize + 4).arrayBuffer(),
		);
		hasAssets = new TextDecoder().decode(aset) === 'ASET';
	}
	return { magic, formatVersion, nroSize, flags, hasAssets };
}

// ----- NSO header view -----

export interface NsoSegmentView {
	name: '.text' | '.rodata' | '.data';
	memoryOffset: string;
	size: number;
	fileSize: number;
	compressed: boolean;
	hashed: boolean;
	hash: string;
}

export interface NsoView {
	magic: string;
	version: number;
	flags: string;
	usesZstd: boolean;
	executeOnlyMemory: boolean;
	moduleName: string;
	moduleId: string;
	bssSize: number;
	embeddedOffset: number;
	embeddedSize: number;
	dynStrOffset: number;
	dynStrSize: number;
	dynSymOffset: number;
	dynSymSize: number;
	segments: NsoSegmentView[];
}

export async function parseNsoForView(blob: Blob): Promise<NsoView> {
	const h: ParsedNsoHeader = await parseNsoHeader(blob);
	const seg = (
		name: NsoSegmentView['name'],
		s: ParsedNsoHeader['textSegment'],
	): NsoSegmentView => ({
		name,
		memoryOffset: '0x' + s.memoryOffset.toString(16).padStart(8, '0'),
		size: s.size,
		fileSize: s.fileSize,
		compressed: s.compressed,
		hashed: s.hashed,
		hash: nsoHex(s.hash),
	});
	// Trim trailing zeros from moduleId; NSOs commonly use a 20-byte build-id
	// padded to 32 bytes, and showing 12 trailing zeros is just noise.
	const id = h.moduleId;
	let lastNonZero = id.length - 1;
	while (lastNonZero >= 0 && id[lastNonZero] === 0) lastNonZero--;
	const trimmed = id.subarray(0, Math.max(lastNonZero + 1, 1));
	return {
		magic: h.magic,
		version: h.version,
		flags: '0x' + h.flags.toString(16).padStart(2, '0'),
		usesZstd: h.usesZstd,
		executeOnlyMemory: h.executeOnlyMemory,
		moduleName: h.moduleName,
		moduleId: nsoHex(trimmed),
		bssSize: h.bssSize,
		embeddedOffset: h.embeddedOffset,
		embeddedSize: h.embeddedSize,
		dynStrOffset: h.dynStrOffset,
		dynStrSize: h.dynStrSize,
		dynSymOffset: h.dynSymOffset,
		dynSymSize: h.dynSymSize,
		segments: [
			seg('.text', h.textSegment),
			seg('.rodata', h.rodataSegment),
			seg('.data', h.dataSegment),
		],
	};
}

// ----- NPDM header view -----

export interface NpdmView {
	parsed: ParsedNpdm;
	moduleIdHex?: string;
	signatureHex: string;
	publicKeyHex: string;
}

export async function parseNpdmForView(blob: Blob): Promise<NpdmView> {
	const parsed = await parseNpdm(blob);
	return {
		parsed,
		signatureHex: npdmHex(parsed.acid.signature),
		publicKeyHex: npdmHex(parsed.acid.publicKey),
	};
}

// ----- Font preview (TTF / OTF / BFTTF / BFOTF) -----

/**
 * A unified preview model for any sfnt-format font, regardless of
 * whether it came in as a plain `.ttf` / `.otf` or as Nintendo's
 * obfuscated `.bfttf` / `.bfotf` wrapper.
 *
 * `font` is always a real `Blob` whose bytes are a valid TTF or OTF
 * — for BFTTF inputs, that's the deobfuscated payload. The
 * preview component registers it with the browser via `FontFace`
 * and renders sample text in the actual font.
 */
export type FontFormat = 'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2' | 'unknown';

export interface FontView {
	/**
	 * Decoded font bytes ready for `FontFace` and download.
	 *
	 * For TTC inputs this is a single sub-font extracted from the
	 * collection (the one selected by `ttcIndex`), not the
	 * original collection bytes — `FontFace` rejects TTCs with
	 * "Invalid source buffer".
	 */
	font: Blob;
	/** Sniffed font format. */
	format: FontFormat;
	/**
	 * For `format === 'ttc'`: the sub-font format actually
	 * served via `font` (almost always `'ttf'`). Undefined for
	 * non-TTC inputs.
	 */
	containedFormat?: 'ttf' | 'otf';
	/** For `format === 'ttc'`: number of sub-fonts in the collection. */
	ttcSubfontCount?: number;
	/** For `format === 'ttc'`: which sub-font index `font` was extracted from. */
	ttcIndex?: number;
	/**
	 * Size of the decoded font in bytes. For TTC inputs this is
	 * the size of the original collection — the displayed
	 * "container" size — not the extracted sub-font.
	 */
	size: number;
	/**
	 * For TTC inputs: size of the extracted sub-font in bytes
	 * (matches `font.size`). Undefined otherwise.
	 */
	extractedSize?: number;
	/** Names extracted from the font's sfnt `name` table. */
	names: TtfNameTable;
	/**
	 * Whether the source was an obfuscated Switch system font that we
	 * deobfuscated. Affects the preview's section header label.
	 */
	wasObfuscated: boolean;
	/**
	 * For BFTTF inputs: whether the size declared in the obfuscation
	 * header matched the actual payload length. Always `true` for
	 * plain TTF / OTF / WOFF inputs.
	 */
	headerSizeOk: boolean;
}

/** @deprecated retained for backwards compatibility — use {@link FontView}. */
export interface BfttfView {
	parsed: ParsedBfttf;
	/** Names extracted from the deobfuscated font's `name` table. */
	names: TtfNameTable;
}

/**
 * A trimmed view of the TTF/OTF "name" table — the strings that
 * Font Book / browsers use to label a font. Each field is the
 * Unicode-platform English entry when available.
 */
export interface TtfNameTable {
	/** Name ID 1: Font Family (e.g. "Helvetica"). */
	family?: string;
	/** Name ID 2: Subfamily / style (e.g. "Bold Italic"). */
	subfamily?: string;
	/** Name ID 4: Full font name. */
	full?: string;
	/** Name ID 6: PostScript name. */
	postscript?: string;
	/** Name ID 0: Copyright. */
	copyright?: string;
	/** Name ID 5: Version. */
	version?: string;
	/** Name ID 16: Typographic family (preferred-family fallback). */
	typographicFamily?: string;
}

export async function isBfttfBlob(blob: Blob): Promise<boolean> {
	return isBfttf(blob);
}

export async function parseBfttfForView(blob: Blob): Promise<BfttfView> {
	const parsed = await parseBfttf(blob);
	const fontBytes = new Uint8Array(await parsed.font.arrayBuffer());
	const names = readTtfNameTable(fontBytes);
	return { parsed, names };
}

/**
 * Build a unified `FontView` from any font blob the previewer
 * understands — plain TTF / OTF, Nintendo's obfuscated
 * BFTTF / BFOTF wrappers, or web font WOFF / WOFF2.
 *
 * Auto-detects by magic so callers can hand us anything that
 * looks like a font file — `.ttf`, `.otf`, `.ttc`, `.bfttf`,
 * `.bfotf`, `.woff`, `.woff2` — and get a uniform view.
 *
 * The returned `font` Blob is always whatever the browser will
 * accept for `FontFace` registration:
 *   - TTF / OTF / BFTTF inputs → uncompressed sfnt bytes
 *   - WOFF / WOFF2 → the original wrapped bytes (browsers
 *     handle the unpacking inside `FontFace` natively)
 */
export async function parseFontForView(blob: Blob): Promise<FontView> {
	if (await isBfttf(blob)) {
		const parsed = await parseBfttf(blob);
		const fontBytes = new Uint8Array(await parsed.font.arrayBuffer());
		return {
			font: parsed.font,
			format: parsed.format,
			size: parsed.size,
			names: readTtfNameTable(fontBytes),
			wasObfuscated: true,
			headerSizeOk: parsed.headerSizeOk,
		};
	}
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const wofMagic = sniffWoffMagic(bytes);
	if (wofMagic === 'woff' || wofMagic === 'woff2') {
		const mime = wofMagic === 'woff2' ? 'font/woff2' : 'font/woff';
		// Browsers' `FontFace` accepts both WOFF flavours
		// directly. We just hand the original bytes through.
		const font = new Blob([bytes as BlobPart], { type: mime });
		// For WOFF1 we can pull out the `name` table cheaply by
		// inflating just that one table. For WOFF2, the entire
		// table data section is Brotli-compressed in one stream,
		// so we decompress it via @tootallnate/brotli-wasm and
		// then carve the `name` table out of the resulting
		// concatenated bytes.
		const names: TtfNameTable =
			wofMagic === 'woff'
				? await readWoff1NameTable(bytes).catch(() => ({}))
				: await readWoff2NameTable(bytes).catch(() => ({}));
		return {
			font,
			format: wofMagic,
			size: bytes.length,
			names,
			wasObfuscated: false,
			headerSizeOk: true,
		};
	}
	// Plain sfnt path: sniff the format from the first 4 bytes,
	// pick a sensible MIME type, and read the name table directly.
	const format = sniffSfntFormat(bytes);
	if (format === 'ttc') {
		// Collections need a sub-font extracted for `FontFace`:
		// the browser rejects raw TTCs with "Invalid source buffer".
		// We hand back sub-font 0 by default and surface the
		// sub-font count so the UI can show a "TTC contains N
		// fonts" badge.
		const subfontCount = readTtcSubfontCount(bytes);
		const extracted = extractTtcSubfont(bytes, 0);
		const containedFormat = sniffSfntFormat(extracted) === 'otf' ? 'otf' : 'ttf';
		const mime = containedFormat === 'otf' ? 'font/otf' : 'font/ttf';
		const font = new Blob([extracted as BlobPart], { type: mime });
		return {
			font,
			format: 'ttc',
			containedFormat,
			ttcSubfontCount: subfontCount,
			ttcIndex: 0,
			size: bytes.length,
			extractedSize: extracted.length,
			names: readTtfNameTable(extracted),
			wasObfuscated: false,
			headerSizeOk: true,
		};
	}
	const mime =
		format === 'otf'
			? 'font/otf'
			: format === 'ttf'
				? 'font/ttf'
				: 'application/octet-stream';
	// Re-Blob the bytes with the correct MIME so `URL.createObjectURL`
	// produces a font-typed URL (handy for download).
	const font = new Blob([bytes as BlobPart], { type: mime });
	return {
		font,
		format,
		size: bytes.length,
		names: readTtfNameTable(bytes),
		wasObfuscated: false,
		headerSizeOk: true,
	};
}

/**
 * Read the `numFonts` field from a TTC header. Returns 0 if the
 * bytes don't look like a TTC.
 */
export function readTtcSubfontCount(bytes: Uint8Array): number {
	if (bytes.length < 12) return 0;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = v.getUint32(0, /*littleEndian*/ false);
	if (magic !== 0x74746366 /* 'ttcf' */) return 0;
	return v.getUint32(8, false);
}

/**
 * Extract a single sub-font from a TTF / OTF Collection (TTC)
 * into a standalone sfnt byte buffer suitable for `FontFace`.
 *
 * Spec reference: OpenType "Font Collections" (`ttcf` header) +
 * the regular sfnt "Offset Table" / "Table Record" layout. The
 * key wrinkle is that table offsets inside a TTC sub-font's
 * Table Records are **absolute** within the TTC file, not
 * relative to the sub-font's Offset Table. We rebuild a flat
 * sfnt by:
 *
 *   1. Reading the chosen sub-font's Offset Table + Table Records
 *      from `ttcOffsets[index]`.
 *   2. Copying each table's body (using the absolute offsets in
 *      the source) into a fresh buffer.
 *   3. Writing a new Offset Table + Table Records pointing at the
 *      copied table bodies' positions in the new buffer.
 *
 * Tables shared between sub-fonts in the source TTC are
 * de-duplicated in the source but the extracted standalone copy
 * is self-contained, so a `glyf`-sharing pair of fonts will both
 * carry their own copy of the shared table once split.
 *
 * Throws if `index` is out of range, the magic doesn't match, or
 * any referenced table runs past the end of the input bytes.
 */
export function extractTtcSubfont(ttcBytes: Uint8Array, index: number): Uint8Array {
	if (ttcBytes.length < 12) {
		throw new Error('TTC too short to contain a valid header');
	}
	const v = new DataView(ttcBytes.buffer, ttcBytes.byteOffset, ttcBytes.byteLength);
	const magic = v.getUint32(0, false);
	if (magic !== 0x74746366 /* 'ttcf' */) {
		throw new Error(`Not a TTC (magic 0x${magic.toString(16).padStart(8, '0')})`);
	}
	const numFonts = v.getUint32(8, false);
	if (index < 0 || index >= numFonts) {
		throw new Error(`TTC sub-font index ${index} out of range (numFonts=${numFonts})`);
	}
	const offsetTableStart = v.getUint32(12 + index * 4, false);
	if (offsetTableStart + 12 > ttcBytes.length) {
		throw new Error(`Sub-font ${index} Offset Table runs past end of TTC`);
	}
	const sfntVersion = v.getUint32(offsetTableStart + 0, false);
	const numTables = v.getUint16(offsetTableStart + 4, false);
	const tableRecordsStart = offsetTableStart + 12;
	if (tableRecordsStart + numTables * 16 > ttcBytes.length) {
		throw new Error(`Sub-font ${index} Table Records run past end of TTC`);
	}

	// Read each Table Record, capture (tag, sourceOffset, length, checksum).
	interface SourceRecord {
		tag: number;
		checksum: number;
		sourceOffset: number;
		length: number;
	}
	const records: SourceRecord[] = new Array(numTables);
	for (let i = 0; i < numTables; i++) {
		const recOff = tableRecordsStart + i * 16;
		const tag = v.getUint32(recOff + 0, false);
		const checksum = v.getUint32(recOff + 4, false);
		const sourceOffset = v.getUint32(recOff + 8, false);
		const length = v.getUint32(recOff + 12, false);
		if (sourceOffset + length > ttcBytes.length) {
			throw new Error(
				`Sub-font ${index} table '${tagToString(tag)}' runs past end of TTC (` +
					`offset=${sourceOffset}, length=${length}, total=${ttcBytes.length})`,
			);
		}
		records[i] = { tag, checksum, sourceOffset, length };
	}

	// Sort records by tag for deterministic output (also matches
	// the convention most font tools use, though the spec doesn't
	// require it).
	const sorted = [...records].sort((a, b) => a.tag - b.tag);

	// Compute layout of the standalone sfnt:
	//   [Offset Table: 12 bytes]
	//   [Table Records: numTables * 16 bytes]
	//   [Table bodies, each padded to a 4-byte boundary]
	const headerSize = 12 + numTables * 16;
	let totalSize = headerSize;
	const newOffsets: number[] = new Array(sorted.length);
	for (let i = 0; i < sorted.length; i++) {
		// Pad to 4 bytes between tables.
		const aligned = (totalSize + 3) & ~3;
		newOffsets[i] = aligned;
		totalSize = aligned + sorted[i].length;
	}
	// Pad final size to 4 bytes as well so the file is well-formed.
	totalSize = (totalSize + 3) & ~3;

	const out = new Uint8Array(totalSize);
	const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);

	// Offset Table.
	ov.setUint32(0, sfntVersion, false);
	ov.setUint16(4, numTables, false);
	// searchRange = (largest power of 2 ≤ numTables) * 16
	let pow2 = 1;
	while (pow2 * 2 <= numTables) pow2 *= 2;
	const searchRange = pow2 * 16;
	let entrySelector = 0;
	let t = pow2;
	while (t > 1) {
		entrySelector++;
		t >>= 1;
	}
	const rangeShift = numTables * 16 - searchRange;
	ov.setUint16(6, searchRange, false);
	ov.setUint16(8, entrySelector, false);
	ov.setUint16(10, rangeShift, false);

	// Table Records + table bodies.
	for (let i = 0; i < sorted.length; i++) {
		const rec = sorted[i];
		const recOff = 12 + i * 16;
		ov.setUint32(recOff + 0, rec.tag, false);
		ov.setUint32(recOff + 4, rec.checksum, false);
		ov.setUint32(recOff + 8, newOffsets[i], false);
		ov.setUint32(recOff + 12, rec.length, false);
		// Copy the table body.
		out.set(
			ttcBytes.subarray(rec.sourceOffset, rec.sourceOffset + rec.length),
			newOffsets[i],
		);
	}
	// Repair any cmap format-4 length under-reporting in-place. This
	// is a no-op for well-formed fonts; older Asian fonts (e.g.
	// DynaLab DFYuan used in FFX HD Remaster) need it to pass
	// OTS / FontFace validation.
	repairSfntCmap(out);
	return out;
}

function tagToString(tag: number): string {
	return String.fromCharCode(
		(tag >>> 24) & 0xff,
		(tag >>> 16) & 0xff,
		(tag >>> 8) & 0xff,
		tag & 0xff,
	);
}

/**
 * Set of OpenType table tags that {@link stripOptionalSfntTables} will
 * remove on demand. These are layout / shaping / hinting tables
 * that aren't required for the font to render at all — losing
 * them only affects ligatures, kerning, and complex-script
 * shaping. Useful as a fallback when the browser rejects a
 * malformed-but-otherwise-renderable font.
 */
const OPTIONAL_SFNT_TABLES = [
	'GSUB', // Glyph substitution (ligatures, alternates)
	'GPOS', // Glyph positioning (kerning, mark positioning)
	'GDEF', // Glyph definitions (used by GSUB/GPOS)
	'BASE', // Baseline data
	'JSTF', // Justification
	'kern', // Legacy kerning
	'mort', // Apple legacy morphological substitution
	'morx', // Apple extended morphological substitution
	'feat', // Apple feature table
	'prop', // Apple glyph properties
	'fvar', // Variable font axes (we render at the default)
	'gvar', // Variable font glyph deltas
	'avar', // Variable font axis remap
	'HVAR', // Variable font horizontal metrics deltas
	'VVAR', // Variable font vertical metrics deltas
	'MVAR', // Variable font metric value deltas
	'STAT', // Style attributes
] as const;

/**
 * Return a new sfnt byte buffer with the named tables removed.
 * Used by the FontFace fallback path to drop layout / shaping
 * tables that the browser's font sanitizer (OTS) rejected on
 * the first try.
 *
 * Works in two passes:
 *
 *   1. Walk the input directory; record the table records we
 *      keep + their existing offsets.
 *   2. Lay out a new sfnt with a smaller directory + the kept
 *      tables' bytes copied across, at fresh 4-byte-aligned
 *      offsets.
 *
 * Returns the original buffer unchanged if no listed tables
 * were present.
 */
export function stripOptionalSfntTables(
	sfntBytes: Uint8Array,
	tagsToStrip: readonly string[] = OPTIONAL_SFNT_TABLES,
): Uint8Array {
	if (sfntBytes.length < 12) return sfntBytes;
	const view = new DataView(sfntBytes.buffer, sfntBytes.byteOffset, sfntBytes.byteLength);
	const sfntVersion = view.getUint32(0, false);
	const numTables = view.getUint16(4, false);
	const stripSet = new Set<number>();
	for (const t of tagsToStrip) {
		stripSet.add(
			(t.charCodeAt(0) << 24) |
				(t.charCodeAt(1) << 16) |
				(t.charCodeAt(2) << 8) |
				t.charCodeAt(3),
		);
	}
	interface KeepRecord {
		tag: number;
		checksum: number;
		sourceOffset: number;
		length: number;
	}
	const kept: KeepRecord[] = [];
	let droppedAny = false;
	for (let i = 0; i < numTables; i++) {
		const recOff = 12 + i * 16;
		const tag = view.getUint32(recOff + 0, false);
		const checksum = view.getUint32(recOff + 4, false);
		const sourceOffset = view.getUint32(recOff + 8, false);
		const length = view.getUint32(recOff + 12, false);
		if (stripSet.has(tag)) {
			droppedAny = true;
			continue;
		}
		kept.push({ tag, checksum, sourceOffset, length });
	}
	if (!droppedAny) return sfntBytes;
	// Recompute layout.
	const newNumTables = kept.length;
	const headerSize = 12 + newNumTables * 16;
	let totalSize = headerSize;
	const newOffsets: number[] = new Array(newNumTables);
	for (let i = 0; i < newNumTables; i++) {
		const aligned = (totalSize + 3) & ~3;
		newOffsets[i] = aligned;
		totalSize = aligned + kept[i].length;
	}
	totalSize = (totalSize + 3) & ~3;
	const out = new Uint8Array(totalSize);
	const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);
	ov.setUint32(0, sfntVersion, false);
	ov.setUint16(4, newNumTables, false);
	let pow2 = 1;
	while (pow2 * 2 <= newNumTables) pow2 *= 2;
	const searchRange = pow2 * 16;
	let entrySelector = 0;
	let t2 = pow2;
	while (t2 > 1) {
		entrySelector++;
		t2 >>= 1;
	}
	ov.setUint16(6, searchRange, false);
	ov.setUint16(8, entrySelector, false);
	ov.setUint16(10, newNumTables * 16 - searchRange, false);
	for (let i = 0; i < newNumTables; i++) {
		const rec = kept[i];
		const recOff = 12 + i * 16;
		ov.setUint32(recOff + 0, rec.tag, false);
		ov.setUint32(recOff + 4, rec.checksum, false);
		ov.setUint32(recOff + 8, newOffsets[i], false);
		ov.setUint32(recOff + 12, rec.length, false);
		out.set(
			sfntBytes.subarray(rec.sourceOffset, rec.sourceOffset + rec.length),
			newOffsets[i],
		);
	}
	return out;
}

/**
 * Repair a known cmap format-4 spec violation seen in older Asian
 * fonts (e.g. DynaLab DFYuan, used by FFX HD Remaster):
 *
 * The format-4 subtable's `length` field can under-report the
 * subtable's actual extent by a few bytes, leaving the final
 * `idRangeOffset` reference pointing exactly at the declared end
 * of the subtable. The OpenType Sanitizer (used by Chrome,
 * Firefox, Safari for FontFace validation) rejects this with
 * "bad glyph id offset (N > N)".
 *
 * Most native font renderers (FreeType, GDI, CoreText) tolerate
 * this. The repair is to bump the declared subtable length to
 * cover all references — provided the bytes are actually present
 * in the parent cmap table (the source TTCs we've seen include
 * the trailing bytes; the spec violation is the length field
 * specifically).
 *
 * Operates in-place on `sfntBytes` (a freshly-rebuilt sfnt from
 * `extractTtcSubfont`). Walks the table directory to find the
 * `cmap` table, then walks the cmap subtables and fixes any
 * under-reported format-4 lengths.
 *
 * Returns the (possibly slightly larger) byte buffer — the only
 * thing that might change size is the cmap subtable's `length`
 * field, which is u16; we don't grow the table, so the returned
 * buffer is the same as the input.
 */
function repairSfntCmap(sfntBytes: Uint8Array): void {
	if (sfntBytes.length < 12) return;
	const view = new DataView(sfntBytes.buffer, sfntBytes.byteOffset, sfntBytes.byteLength);
	const numTables = view.getUint16(4, false);
	let cmapOff = -1;
	let cmapLen = 0;
	for (let i = 0; i < numTables; i++) {
		const recOff = 12 + i * 16;
		const tag = view.getUint32(recOff + 0, false);
		if (tag === 0x636d6170 /* 'cmap' */) {
			cmapOff = view.getUint32(recOff + 8, false);
			cmapLen = view.getUint32(recOff + 12, false);
			break;
		}
	}
	if (cmapOff < 0 || cmapOff + 4 > sfntBytes.length) return;
	const cmapVersion = view.getUint16(cmapOff, false);
	if (cmapVersion !== 0) return;
	const numSubtables = view.getUint16(cmapOff + 2, false);
	for (let i = 0; i < numSubtables; i++) {
		const erOff = cmapOff + 4 + i * 8;
		if (erOff + 8 > sfntBytes.length) break;
		const subOff = cmapOff + view.getUint32(erOff + 4, false);
		if (subOff + 14 > sfntBytes.length) continue;
		const format = view.getUint16(subOff, false);
		if (format !== 4) continue;
		const declaredLen = view.getUint16(subOff + 2, false);
		const segCount = view.getUint16(subOff + 6, false) >>> 1;
		if (segCount < 1) continue;
		const endCountStart = subOff + 14;
		const startCountStart = endCountStart + segCount * 2 + 2;
		const idDeltaStart = startCountStart + segCount * 2;
		const idRangeOffsetStart = idDeltaStart + segCount * 2;
		if (idRangeOffsetStart + segCount * 2 > sfntBytes.length) continue;
		// Highest glyph_id_offset referenced across all segments.
		let maxOff = 0;
		for (let s = 0; s < segCount; s++) {
			const idRangeOff = view.getUint16(idRangeOffsetStart + s * 2, false);
			if (idRangeOff === 0) continue;
			const startCode = view.getUint16(startCountStart + s * 2, false);
			const endCode = view.getUint16(endCountStart + s * 2, false);
			if (endCode < startCode) continue;
			const rangeDelta = endCode - startCode;
			// id_range_offset_offset is relative to the start of the subtable.
			const idRangeOffOff = (idRangeOffsetStart + s * 2) - subOff;
			const glyphIdOff = idRangeOffOff + idRangeOff + rangeDelta * 2;
			if (glyphIdOff > maxOff) maxOff = glyphIdOff;
		}
		// OTS requires `glyphIdOff + 1 < length` (i.e. at least 2 bytes
		// must be readable). So minimum length is `maxOff + 2`.
		const minLen = maxOff + 2;
		if (minLen > declaredLen) {
			// Cap to what's actually present in the cmap table. If we
			// can't fit the references, leave the bytes alone — the
			// repair would just push the failure elsewhere.
			const maxAllowed = Math.min(0xffff, cmapLen - (subOff - cmapOff));
			if (minLen <= maxAllowed) {
				view.setUint16(subOff + 2, minLen, false);
			}
		}
	}
}

/**
 * Identify a WOFF / WOFF2 wrapper from the first 4 bytes.
 * `wOFF` = `0x774F4646` = WOFF 1, zlib-compressed tables.
 * `wOF2` = `0x774F4632` = WOFF 2, Brotli-compressed payload
 * with glyph-data transform. Returns `null` if the bytes
 * aren't either.
 */
function sniffWoffMagic(bytes: Uint8Array): 'woff' | 'woff2' | null {
	if (bytes.length < 4) return null;
	const tag =
		(bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
	if (tag === 0x774f4646) return 'woff';
	if (tag === 0x774f4632) return 'woff2';
	return null;
}

/**
 * sfnt-format magic sniffer.
 *
 * - `'ttf'`: classic TrueType (`0x00010000`, `'true'`, `'typ1'`)
 * - `'otf'`: PostScript-flavoured OpenType (`'OTTO'`)
 * - `'ttc'`: TrueType / OpenType collection (`'ttcf'`) — contains
 *   one or more sub-fonts. Browsers' `FontFace` does NOT accept
 *   collections directly; use {@link extractTtcSubfont} to pull
 *   out a standalone sfnt.
 */
function sniffSfntFormat(bytes: Uint8Array): 'ttf' | 'otf' | 'ttc' | 'unknown' {
	if (bytes.length < 4) return 'unknown';
	const tag =
		(bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
	if (tag === 0x00010000) return 'ttf';
	if (tag === 0x4f54544f /* "OTTO" */) return 'otf';
	if (tag === 0x74727565 /* "true" */) return 'ttf';
	if (tag === 0x74797031 /* "typ1" */) return 'ttf';
	if (tag === 0x74746366 /* "ttcf" */) return 'ttc';
	return 'unknown';
}

/**
 * Decompress and read just the `name` table from a WOFF 1 file.
 *
 * WOFF 1 layout (per the W3C spec):
 *
 *   +0x00  4   signature ('wOFF')
 *   +0x04  4   flavor (sfnt magic of the inner font)
 *   +0x08  4   length (full WOFF file size)
 *   +0x0C  2   numTables
 *   +0x0E  2   reserved (zero)
 *   +0x10  4   totalSfntSize (uncompressed sfnt size)
 *   +0x14  2   majorVersion
 *   +0x16  2   minorVersion
 *   +0x18  4   metaOffset
 *   +0x1C  4   metaLength
 *   +0x20  4   metaOrigLength
 *   +0x24  4   privOffset
 *   +0x28  4   privLength
 *
 *   Table directory (numTables × 20 bytes):
 *     +0x00  4   tag
 *     +0x04  4   offset within WOFF file
 *     +0x08  4   compLength (compressed bytes; equals origLength
 *                if stored uncompressed)
 *     +0x0C  4   origLength
 *     +0x10  4   origChecksum
 *
 * Each compressed table is a raw zlib stream (with header).
 * `DecompressionStream('deflate')` decodes those directly.
 */
async function readWoff1NameTable(
	bytes: Uint8Array,
): Promise<TtfNameTable> {
	if (bytes.length < 0x2c) return {};
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = view.getUint16(0x0c, false);
	if (numTables === 0) return {};
	for (let i = 0; i < numTables; i++) {
		const recOff = 0x2c + i * 20;
		if (recOff + 20 > bytes.length) break;
		const tag = String.fromCharCode(
			bytes[recOff],
			bytes[recOff + 1],
			bytes[recOff + 2],
			bytes[recOff + 3],
		);
		if (tag !== 'name') continue;
		const tableOff = view.getUint32(recOff + 4, false);
		const compLength = view.getUint32(recOff + 8, false);
		const origLength = view.getUint32(recOff + 12, false);
		if (tableOff + compLength > bytes.length) return {};
		const compBytes = bytes.subarray(tableOff, tableOff + compLength);
		let nameBytes: Uint8Array;
		if (compLength === origLength) {
			// Stored uncompressed (allowed when zlib wouldn't
			// shrink the table, e.g. tiny `name` tables).
			nameBytes = compBytes;
		} else {
			nameBytes = await inflateZlib(compBytes);
		}
		return readNameTableContents(nameBytes);
	}
	return {};
}

/**
 * Inflate a zlib-wrapped (RFC 1950) byte stream via the
 * platform's built-in `DecompressionStream('deflate')`. Used by
 * the WOFF1 table reader.
 */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate'));
	const out = new Uint8Array(await new Response(stream).arrayBuffer());
	return out;
}

/**
 * Decompress and read just the `name` table from a WOFF 2 file.
 *
 * WOFF 2 layout (per the W3C spec):
 *
 *   File header (48 bytes):
 *     +0x00  4   signature ('wOF2')
 *     +0x04  4   flavor (sfnt magic)
 *     +0x08  4   length
 *     +0x0C  2   numTables
 *     +0x0E  2   reserved
 *     +0x10  4   totalSfntSize
 *     +0x14  4   totalCompressedSize  ← the Brotli payload's size
 *     +0x18  2   majorVersion
 *     +0x1A  2   minorVersion
 *     +0x1C  4   metaOffset
 *     +0x20  4   metaLength
 *     +0x24  4   metaOrigLength
 *     +0x28  4   privOffset
 *     +0x2C  4   privLength
 *
 *   Table directory (numTables variable-length entries):
 *     1 byte flags
 *       low 6 bits: tag index into KNOWN_TAGS, or 63 for "arbitrary tag"
 *       bits 6-7:   transform variant (0 = identity for non-glyf/loca tables)
 *     [4 bytes tag]   only present if tag index == 63
 *     UIntBase128 origLength
 *     [UIntBase128 transformLength] only present for transformed
 *                                   tables (glyf/loca only)
 *
 *   Compressed payload (totalCompressedSize bytes of Brotli-
 *   compressed concatenated table data, in directory order).
 *
 *   The compressed payload's bytes correspond to the
 *   *transformed* tables back-to-back, which for the `name`
 *   table are just the original bytes (transform == identity).
 *   So we just sum each table's logical length up to `name` to
 *   get its offset in the decompressed stream.
 */
async function readWoff2NameTable(
	bytes: Uint8Array,
): Promise<TtfNameTable> {
	if (bytes.length < 0x30) return {};
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = view.getUint16(0x0c, false);
	const totalCompressedSize = view.getUint32(0x14, false);
	if (numTables === 0) return {};

	// KNOWN_TAGS — the 6-bit "tag index" maps into this exact
	// list (per the WOFF2 spec, section 5.3). Index 63 means
	// "the next 4 bytes are the tag itself."
	const KNOWN_TAGS = [
		'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
		'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
		'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
		'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
		'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
		'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
		'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
		'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
	];

	let cursor = 0x30; // start of table directory
	let nameOffsetInUncompressed = 0;
	let nameLength = 0;
	let totalUncompressedThroughName = 0;
	let foundName = false;

	// Walk the directory, summing each table's uncompressed
	// length so we know where the `name` table sits in the
	// Brotli payload. We DON'T need to decompress everything —
	// just up through the `name` table — but we don't know
	// its position without walking the directory.
	for (let i = 0; i < numTables; i++) {
		if (cursor >= bytes.length) return {};
		const flags = bytes[cursor];
		cursor += 1;
		const tagIndex = flags & 0x3f;
		const transformVersion = (flags >> 6) & 0x03;
		let tag: string;
		if (tagIndex === 0x3f) {
			if (cursor + 4 > bytes.length) return {};
			tag = String.fromCharCode(
				bytes[cursor], bytes[cursor + 1],
				bytes[cursor + 2], bytes[cursor + 3],
			);
			cursor += 4;
		} else {
			tag = KNOWN_TAGS[tagIndex] ?? '????';
		}
		const origRead = readUIntBase128(bytes, cursor);
		if (!origRead) return {};
		cursor = origRead.next;
		const origLength = origRead.value;
		// Whether a transform-length follows depends on the table.
		// Per the spec: for glyf and loca, a non-default transform
		// version (i.e. != 0 for glyf, != 0 for loca) means a
		// transformLength field IS present. For all OTHER tables
		// (including `name`), a transformLength field is present
		// when transformVersion != 0, but the spec for non-glyf/
		// non-loca tables says transform-version 0 = "no
		// transform" so no length follows.
		let logicalLength = origLength;
		if (
			(tag === 'glyf' || tag === 'loca')
				? transformVersion === 0 // glyf/loca: 0 == transformed (default)
				: transformVersion !== 0 // others: 0 == identity (default)
		) {
			const tlenRead = readUIntBase128(bytes, cursor);
			if (!tlenRead) return {};
			cursor = tlenRead.next;
			logicalLength = tlenRead.value;
		}
		if (tag === 'name') {
			nameOffsetInUncompressed = totalUncompressedThroughName;
			nameLength = logicalLength;
			foundName = true;
			break; // we have what we need
		}
		totalUncompressedThroughName += logicalLength;
	}
	if (!foundName) return {};

	// Decompress the WHOLE Brotli payload (we have to — the
	// stream isn't seekable). Keep cursor at the byte right
	// after the directory we walked. The compressed data starts
	// there. Note: we walked PAST the `name` table entry
	// (because we `break`-ed inside the loop), so `cursor` is
	// not actually pointing at the start of the compressed
	// payload. We need to skip the rest of the directory first.
	for (let i = 0; cursor < bytes.length; ) {
		// Restart the walk from where we broke out, finishing
		// the directory but not tracking anything — we just
		// need `cursor` at the end of the directory.
		void i;
		break;
	}
	// Easier: re-walk the directory in full to land cursor at
	// the start of the compressed payload.
	cursor = 0x30;
	for (let i = 0; i < numTables; i++) {
		if (cursor >= bytes.length) return {};
		const flags = bytes[cursor];
		cursor += 1;
		const tagIndex = flags & 0x3f;
		const transformVersion = (flags >> 6) & 0x03;
		let tag: string;
		if (tagIndex === 0x3f) {
			if (cursor + 4 > bytes.length) return {};
			tag = String.fromCharCode(
				bytes[cursor], bytes[cursor + 1],
				bytes[cursor + 2], bytes[cursor + 3],
			);
			cursor += 4;
		} else {
			tag = KNOWN_TAGS[tagIndex] ?? '????';
		}
		const r1 = readUIntBase128(bytes, cursor);
		if (!r1) return {};
		cursor = r1.next;
		if (
			(tag === 'glyf' || tag === 'loca')
				? transformVersion === 0
				: transformVersion !== 0
		) {
			const r2 = readUIntBase128(bytes, cursor);
			if (!r2) return {};
			cursor = r2.next;
		}
	}
	const compressedStart = cursor;
	const compressedEnd = compressedStart + totalCompressedSize;
	if (compressedEnd > bytes.length) return {};
	const compressed = bytes.subarray(compressedStart, compressedEnd);

	// Decompress just up to the byte after the `name` table.
	// Brotli's streaming API would let us do that exactly, but
	// for simplicity we decompress the whole payload — fonts
	// are small and the win isn't worth the extra plumbing.
	const { brotliDecompressBytes } = await import('./brotli');
	const decompressed = await brotliDecompressBytes(compressed);
	if (nameOffsetInUncompressed + nameLength > decompressed.length) {
		return {};
	}
	const nameBytes = decompressed.subarray(
		nameOffsetInUncompressed,
		nameOffsetInUncompressed + nameLength,
	);
	return readNameTableContents(nameBytes);
}

/**
 * Decode a UIntBase128 from `bytes` starting at `offset`.
 * Each byte's high bit is a continuation flag; the low 7 bits
 * are data, big-endian. Used by WOFF2 directory entries.
 *
 * Returns `null` if the encoding is malformed (more than 5
 * continuation bytes, or runs off the end of the buffer).
 */
function readUIntBase128(
	bytes: Uint8Array,
	offset: number,
): { value: number; next: number } | null {
	let value = 0;
	for (let i = 0; i < 5; i++) {
		if (offset + i >= bytes.length) return null;
		const b = bytes[offset + i];
		// Per the spec: leading-zero values are forbidden (so
		// the encoding is canonical) — we don't enforce that,
		// just decode permissively.
		value = (value << 7) | (b & 0x7f);
		if ((b & 0x80) === 0) {
			return { value, next: offset + i + 1 };
		}
		// Overflow check: 5 × 7 = 35 bits; we'd lose data above
		// 32 bits, but font tables are well under that.
		if (value > 0xffffffff) return null;
	}
	return null; // ran past 5 bytes without terminator
}



/**
 * Read the `name` table out of an sfnt-format font (TTF or OTF) and
 * return the most-relevant strings. Only Unicode-platform English
 * (or whatever is available) entries are considered.
 *
 * Returns an empty object for malformed or missing tables — callers
 * should treat every field as optional.
 */
export function readTtfNameTable(bytes: Uint8Array): TtfNameTable {
	if (bytes.length < 12) return {};
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = view.getUint16(4, false);
	if (numTables === 0) return {};
	// Find the name table.
	let nameOff = 0;
	let nameLen = 0;
	for (let i = 0; i < numTables; i++) {
		const recOff = 12 + i * 16;
		if (recOff + 16 > bytes.length) break;
		const tag = String.fromCharCode(
			bytes[recOff],
			bytes[recOff + 1],
			bytes[recOff + 2],
			bytes[recOff + 3],
		);
		if (tag === 'name') {
			nameOff = view.getUint32(recOff + 8, false);
			nameLen = view.getUint32(recOff + 12, false);
			break;
		}
	}
	if (!nameOff || nameOff + 6 > bytes.length) return {};
	const nameBytes = bytes.subarray(nameOff, nameOff + nameLen);
	return readNameTableContents(nameBytes);
}

/**
 * Decode an isolated `name` table payload (no surrounding sfnt
 * directory). Used by the WOFF1 metadata path, which can pull
 * just the `name` table out of the WOFF directory and inflate
 * it without needing to reconstitute a full sfnt.
 *
 * Layout per the OpenType spec — 6-byte header followed by
 * `count` 12-byte name records, followed by a string heap.
 */
export function readNameTableContents(bytes: Uint8Array): TtfNameTable {
	if (bytes.length < 6) return {};
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint16(2, false);
	const stringOffset = view.getUint16(4, false);
	if (stringOffset > bytes.length) return {};

	const out: TtfNameTable = {};
	// Iterate the name records. Score each candidate so we prefer the
	// Unicode platform (0) or the Microsoft-Unicode platform (3, encoding 1)
	// over the Macintosh platform (1, encoding 0).
	const scored = new Map<number, { score: number; value: string }>();
	for (let i = 0; i < count; i++) {
		const recOff = 6 + i * 12;
		if (recOff + 12 > bytes.length) break;
		const platformId = view.getUint16(recOff + 0, false);
		const encodingId = view.getUint16(recOff + 2, false);
		// const languageId = view.getUint16(recOff + 4, false);
		const nameId = view.getUint16(recOff + 6, false);
		const length = view.getUint16(recOff + 8, false);
		const offset = view.getUint16(recOff + 10, false);
		const dataOff = stringOffset + offset;
		if (dataOff + length > bytes.length) continue;
		const data = bytes.subarray(dataOff, dataOff + length);
		// Decode based on platform/encoding
		let value: string;
		let score: number;
		if (platformId === 3 && encodingId === 1) {
			// Microsoft-Unicode (BMP) — UTF-16 BE
			value = utf16beDecode(data);
			score = 100;
		} else if (platformId === 0) {
			value = utf16beDecode(data);
			score = 90;
		} else if (platformId === 1 && encodingId === 0) {
			// Macintosh-Roman — close enough to ASCII for our needs
			value = new TextDecoder('latin1').decode(data);
			score = 50;
		} else {
			// Fallback: treat as latin1 so we at least get something
			value = new TextDecoder('latin1').decode(data);
			score = 10;
		}
		const existing = scored.get(nameId);
		if (!existing || existing.score < score) {
			scored.set(nameId, { score, value });
		}
	}

	const get = (id: number) => scored.get(id)?.value;
	out.copyright = get(0);
	out.family = get(1);
	out.subfamily = get(2);
	out.full = get(4);
	out.version = get(5);
	out.postscript = get(6);
	out.typographicFamily = get(16);
	return out;
}

function utf16beDecode(bytes: Uint8Array): string {
	let s = '';
	const end = bytes.length & ~1;
	for (let i = 0; i < end; i += 2) {
		s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
	}
	return s;
}

// ----- BFFNT preview (Switch bitmap fonts) -----

/**
 * View model for the BFFNT preview pane. Wraps a fully-decoded
 * {@link RenderableBffnt} (parsed container + de-swizzled atlases)
 * with the metadata strings the React UI surfaces in its sidebar.
 *
 * Rendering happens lazily in the React component — we don't pre-
 * rasterise anything here so the user can type custom sample text.
 */
export interface BffntView {
	parsed: ParsedBffnt;
	renderable: RenderableBffnt;
	/** Friendly format name, e.g. "BC4" or "A8". */
	formatName: string;
	/** Total number of glyphs the font has CWDH metrics for. */
	glyphCount: number;
	/** Number of CMAP blocks (each covers some Unicode range). */
	cmapBlockCount: number;
	/** Total codepoints mapped across all CMAP blocks. */
	mappedCodepoints: number;
	/** Endian of the on-disk container. */
	endian: 'little' | 'big';
}

export async function parseBffntForView(blob: Blob): Promise<BffntView> {
	const parsed = await parseBffnt(blob);
	const renderable = decodeBffnt(parsed, { singleChannelTo: 'alpha' });
	const glyphCount = parsed.cwdhBlocks.reduce(
		(n, b) => n + (b.endIndex - b.startIndex + 1),
		0,
	);
	let mappedCodepoints = 0;
	for (const b of parsed.cmapBlocks) {
		mappedCodepoints += b.codeEnd - b.codeBegin + 1;
	}
	return {
		parsed,
		renderable,
		formatName: textureFormatName(parsed.tglp.sheetImageFormat),
		glyphCount,
		cmapBlockCount: parsed.cmapBlocks.length,
		mappedCodepoints,
		endian: parsed.header.endian,
	};
}

/**
 * Re-export of the underlying renderer so the preview component can
 * rasterise user-entered text without re-decoding the atlas.
 */
export { renderText as renderBffntText };

// ----- BARS preview (Switch / Wii U audio resource archive) -----

/**
 * View model for the structured BARS preview. Wraps the full
 * {@link ParsedBars} with a few derived counts the React UI uses
 * to label the summary section ("12 tracks · 9 FWAV · 3 stub …").
 */
export interface BarsView {
	parsed: ParsedBars;
	fwavCount: number;
	fstpCount: number;
	stubCount: number;
	totalAudioBytes: number;
}

export async function parseBarsForView(blob: Blob): Promise<BarsView> {
	const parsed = await parseBars(blob);
	let fwavCount = 0;
	let fstpCount = 0;
	let stubCount = 0;
	let totalAudioBytes = 0;
	for (const e of parsed.entries) {
		if (e.audioKind === 'fwav') fwavCount++;
		else if (e.audioKind === 'fstp') fstpCount++;
		else stubCount++;
		totalAudioBytes += e.audioSize;
	}
	return { parsed, fwavCount, fstpCount, stubCount, totalAudioBytes };
}

// ----- BFSAR preview (NintendoWare master sound archive) -----

/**
 * View model for the structured BFSAR preview. The underlying
 * {@link ParsedBfsar} already exposes counts and the lazily-sliced
 * file list; we just compute a sound-kind histogram so the summary
 * section can call out streams vs. waves vs. sequences.
 */
export interface BfsarView {
	parsed: ParsedBfsar;
	streamCount: number;
	waveCount: number;
	sequenceCount: number;
	inlineCount: number;
	groupCount: number;
}

export async function parseBfsarForView(blob: Blob): Promise<BfsarView> {
	const parsed = await parseBfsar(blob);
	let streamCount = 0;
	let waveCount = 0;
	let sequenceCount = 0;
	let inlineCount = 0;
	let groupCount = 0;
	for (const f of parsed.internalFiles) {
		if (f.soundKind === 'stream') streamCount++;
		else if (f.soundKind === 'wave') waveCount++;
		else if (f.soundKind === 'sequence') sequenceCount++;
		if (f.location === 'inline') inlineCount++;
		else if (f.location === 'group') groupCount++;
	}
	return {
		parsed,
		streamCount,
		waveCount,
		sequenceCount,
		inlineCount,
		groupCount,
	};
}

// ----- BFWAV / BFSTM audio preview -----

/**
 * Unified view model for the audio preview pane. Wraps the parsed
 * container metadata, an `audio/wav` `Blob` ready to play, and a
 * few derived fields for the metadata sidebar (duration, codec
 * label).
 *
 * `wavUrl` is owned by the React component that builds it — call
 * `URL.revokeObjectURL` on cleanup.
 */
export interface AudioPreviewView {
	/** What kind of source this came from. */
	source: 'bfwav' | 'bfstm' | 'bfstp';
	/** Codec name, e.g. `'DSP-ADPCM'` / `'PCM16'`. */
	codecName: string;
	sampleRate: number;
	numChannels: number;
	totalSamples: number;
	loopFlag: boolean;
	loopStart: number;
	/** Duration in seconds. */
	durationSeconds: number;
	/** Decoded WAV-format bytes ready for `<audio>` playback. */
	wavBlob: Blob;
	/**
	 * Original parsed metadata. We surface a discriminated union so
	 * the UI can show format-specific extras (e.g. interleave
	 * geometry for BFSTMs).
	 */
	parsed:
		| { kind: 'bfwav'; data: ParsedBfwav }
		| { kind: 'bfstm'; data: ParsedBfstm };
}

/**
 * Decode a BFWAV blob into an `AudioPreviewView`. Throws on
 * unsupported codecs (only DSP-ADPCM / PCM16 / PCM8 are wired up).
 */
export async function parseBfwavForAudioView(
	blob: Blob,
): Promise<AudioPreviewView> {
	const parsed = await parseBfwav(blob);
	const { samples, numChannels, sampleRate } = await decodeBfwavToPcm16(parsed);
	const wavBlob = encodeWavBlob(samples, sampleRate, numChannels);
	return {
		source: 'bfwav',
		codecName: parsed.codecName,
		sampleRate: parsed.sampleRate,
		numChannels: parsed.channels.length,
		totalSamples: parsed.totalSamples,
		loopFlag: parsed.loopFlag,
		loopStart: parsed.loopStart,
		durationSeconds: parsed.totalSamples / parsed.sampleRate,
		wavBlob,
		parsed: { kind: 'bfwav', data: parsed },
	};
}

/**
 * Decode a BFSTM (or BFSTP) blob into an `AudioPreviewView`. The
 * WAV blob represents the *full* decoded stream, including looped
 * sections — for BFSTPs (prefetch streams) this is the only
 * portion of the audio that's present anyway.
 */
export async function parseBfstmForAudioView(
	blob: Blob,
): Promise<AudioPreviewView> {
	const parsed = await parseBfstm(blob);
	const { samples, numChannels, sampleRate } = await decodeBfstmToPcm16(parsed);
	const wavBlob = encodeWavBlob(samples, sampleRate, numChannels);
	return {
		source: parsed.magic === 'FSTP' ? 'bfstp' : 'bfstm',
		codecName: parsed.codecName,
		sampleRate: parsed.sampleRate,
		numChannels: parsed.numChannels,
		totalSamples: parsed.totalSamples,
		loopFlag: parsed.loopFlag,
		loopStart: parsed.loopStart,
		durationSeconds: parsed.totalSamples / parsed.sampleRate,
		wavBlob,
		parsed: { kind: 'bfstm', data: parsed },
	};
}

// ----- BARSLIST manifest preview -----

export interface BarslistView {
	parsed: ParsedBarslist;
}

export async function parseBarslistForView(blob: Blob): Promise<BarslistView> {
	const parsed = await parseBarslist(blob);
	return { parsed };
}

// ----- BNVIB rumble pattern preview -----

export interface BnvibView {
	parsed: ParsedBnvib;
	/** Rendered audio waveform of the rumble (stereo: low/high band). */
	wavBlob: Blob;
}

export async function parseBnvibForView(blob: Blob): Promise<BnvibView> {
	const parsed = await parseBnvib(blob);
	const { samples, numChannels, sampleRate } = renderBnvibToPcm16(parsed);
	const wavBlob = encodeWavBlob(samples, sampleRate, numChannels);
	return { parsed, wavBlob };
}

// ----- BYAML / BYML tree preview -----

export interface ByamlView {
	parsed: ParsedByaml;
	/** JSON-serialisable tree, ready to feed to the JSON preview. */
	json: unknown;
	/** Pre-rendered, indented JSON string. */
	jsonString: string;
}

export async function parseByamlForView(blob: Blob): Promise<ByamlView> {
	const parsed = await parseByaml(blob);
	const json = byamlToJson(parsed.root);
	const jsonString = stringifyJson(json);
	return { parsed, json, jsonString };
}

/**
 * JSON.stringify wrapper that handles BigInt by stringifying it
 * (BYAML's i64 / u64 wrappers are already converted to strings by
 * byamlToJson, so this is just a safety net for any escaped
 * BigInts the converter doesn't catch).
 */
function stringifyJson(value: unknown): string {
	return JSON.stringify(
		value,
		(_k, v) => (typeof v === 'bigint' ? v.toString() : v),
		2,
	);
}

// `encodeWav` is re-exported (used by some scripts/tools); avoid
// the unused-import lint by referencing it once.
void encodeWav;

// ----- BNTX texture preview -----

export interface BntxView {
	parsed: ParsedBntx;
	/** The texture currently being previewed (always `parsed.textures[0]` here). */
	texture: BntxTexture;
	/** Decoded RGBA8 pixels (row-major, top-left origin). */
	pixels: Uint8Array;
}

export async function parseBntxForView(blob: Blob): Promise<BntxView> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const parsed = parseBntx(bytes);
	if (parsed.textureCount === 0) {
		throw new Error('BNTX has no textures');
	}
	const texture = parsed.textures[0];
	// If the texture is ASTC, lazy-load the ASTC WASM decoder before
	// decoding. BCn-only textures skip the load entirely (lazy import
	// inside `getAstcBlockDecoder` is gated by the `isAstc` check).
	const astcDecoder = texture.formatInfo.isAstc
		? await getAstcBlockDecoder()
		: undefined;
	const decoded = decodeBntxLayer(bytes, texture, 0, { astcDecoder });
	return { parsed, texture, pixels: decoded.pixels };
}

// ----- PhyreEngine texture preview -----

export interface PhyreView {
	parsed: ParsedPhyre;
	texture: PhyreTexture;
	/** Decoded RGBA8 pixels for mip 0 (row-major, top-left origin). */
	pixels: Uint8Array;
	/** The raw DDS bytes (header + pixel data) for "Save as .dds". */
	dds: Uint8Array;
}

/**
 * Decode mip 0 of a PhyreEngine NVN (Switch) texture into RGBA8
 * for canvas display. Also returns a standard DDS blob for the
 * "Save as .dds" download link.
 *
 * Currently supports the formats we've seen in FFX HD Remaster:
 * DXT1, DXT3, DXT5, BC4, BC5, BC7 (all NVN-deswizzled) plus
 * RGBA8 / ARGB8 uncompressed. Other formats throw.
 */
export async function parsePhyreForView(blob: Blob): Promise<PhyreView> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const parsed = parsePhyre(bytes);
	const texture = findTexture(parsed);
	if (!texture) {
		throw new Error('PhyreEngine file contains no texture');
	}
	// Slice out mip 0's swizzled bytes (the entire pixel payload for
	// single-mip textures, the first chunk for mipmapped ones).
	const allPixels = extractTexturePixels(parsed, texture);
	const swizzledMip0 =
		texture.mipmapCount > 0
			? allPixels // multi-mip: pass everything; deswizzleNvnMip reads only what it needs
			: allPixels;
	// Deswizzle mip 0 using the phyre-NVN block-height heuristic.
	const linear = deswizzleNvnMip({
		format: texture.format,
		width: texture.width,
		height: texture.height,
		data: swizzledMip0,
	});
	// Decode the linear blocks into RGBA8 for canvas display.
	const w = texture.width;
	const h = texture.height;
	let pixels: Uint8Array;
	switch (texture.format) {
		case 'DXT1':
			pixels = decodeBC1(linear, w, h);
			break;
		case 'DXT3':
			pixels = decodeBC2(linear, w, h);
			break;
		case 'DXT5':
			pixels = decodeBC3(linear, w, h);
			break;
		case 'BC4':
			pixels = decodeBC4(linear, w, h, { signed: false, mode: 'rgb' });
			break;
		case 'BC5':
			pixels = decodeBC5(linear, w, h, { signed: false, mode: 'normal' });
			break;
		case 'BC7':
			pixels = decodeBC7(linear, w, h);
			break;
		case 'RGBA8': {
			// PhyreEngine stores RGBA8 as B,G,R,A in memory (DDS ARGB8888
			// convention). Swap to canvas-friendly R,G,B,A.
			pixels = new Uint8Array(w * h * 4);
			for (let i = 0; i < w * h; i++) {
				pixels[i * 4 + 0] = linear[i * 4 + 2];
				pixels[i * 4 + 1] = linear[i * 4 + 1];
				pixels[i * 4 + 2] = linear[i * 4 + 0];
				pixels[i * 4 + 3] = linear[i * 4 + 3];
			}
			break;
		}
		case 'ARGB8': {
			// Same byte order as 'RGBA8' above (PhyreEngine treats them
			// interchangeably as far as in-memory layout goes).
			pixels = new Uint8Array(w * h * 4);
			for (let i = 0; i < w * h; i++) {
				pixels[i * 4 + 0] = linear[i * 4 + 2];
				pixels[i * 4 + 1] = linear[i * 4 + 1];
				pixels[i * 4 + 2] = linear[i * 4 + 0];
				pixels[i * 4 + 3] = linear[i * 4 + 3];
			}
			break;
		}
		default:
			throw new Error(
				`Unsupported PhyreEngine format ${texture.format}. ` +
					`Supported: DXT1, DXT3, DXT5, BC4, BC5, BC7, RGBA8, ARGB8.`,
			);
	}
	// PhyreEngine stores texture rows in upside-down (DDS) order
	// relative to the standard canvas top-left origin. Flip the
	// decoded RGBA rows so the preview displays right-side-up.
	flipRgbaRowsInPlace(pixels, w, h);
	// Build a DDS for the download link. DDS readers expect the
	// upside-down orientation that PhyreEngine already stores, so
	// we pass the pre-deswizzled `linear` bytes through unchanged.
	const texForDds = {
		...texture,
		mipmapCount: 0,
		maxMipLevel: 0,
		pixelDataSize: linear.byteLength,
	};
	const dds = encodeAsDds(texForDds, linear);
	return { parsed, texture, pixels, dds };
}

/**
 * Vertical flip of an RGBA8 buffer in-place. Used by the phyre
 * preview to convert from DDS-style bottom-up rows to canvas
 * top-down rows.
 */
function flipRgbaRowsInPlace(rgba: Uint8Array, width: number, height: number): void {
	if (height < 2) return;
	const rowBytes = width * 4;
	const tmp = new Uint8Array(rowBytes);
	for (let y = 0; y < height >> 1; y++) {
		const top = y * rowBytes;
		const bot = (height - 1 - y) * rowBytes;
		tmp.set(rgba.subarray(top, top + rowBytes));
		rgba.copyWithin(top, bot, bot + rowBytes);
		rgba.set(tmp, bot);
	}
}

// Reference `bytesForMipLevel` so the import isn't dead-code-pruned
// by IDE auto-cleanup tools. (Future multi-mip preview will use it.)
void bytesForMipLevel;

// ----- PhyreEngine mesh preview -----

export interface PhyreMeshSegmentView {
	segment: PhyreMeshSegment;
	positions: Float32Array;
	indices: Uint16Array | Uint32Array;
	/** UV coordinates (vec2 per vertex), or null if the segment has no UV stream. */
	uvs: Float32Array | null;
	/** Vertex normals (vec3 per vertex), or null if the segment has no normal stream. */
	normals: Float32Array | null;
}

export interface PhyreMeshView {
	parsed: ParsedPhyre;
	mesh: PhyreMesh;
	segments: PhyreMeshSegmentView[];
	/** Bounding box of all positions across all segments. */
	bbox: { min: [number, number, number]; max: [number, number, number] };
	/** Center point = (min + max) / 2. */
	center: [number, number, number];
	/** Longest axis of the bounding box. */
	size: number;
	/**
	 * Asset references parsed out of the model's
	 * `PAssetReference` / `PAssetReferenceImport` array tails.
	 * Used to find sibling `.dds.phyre` texture files for the
	 * material slots. The viewer treats `isTexture` references
	 * as resolution candidates; the rest (animation sets, mesh
	 * nodes, material names) are surfaced for the metadata
	 * panel only.
	 */
	assetRefs: PhyreAssetReference[];
}

/**
 * Parse a `.dae.phyre` and return per-segment vertex positions +
 * indices ready to feed into a Three.js `BufferGeometry`. Also
 * computes the bounding box for camera framing.
 */
export async function parsePhyreMeshForView(blob: Blob): Promise<PhyreMeshView> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const parsed = parsePhyre(bytes);
	const mesh = findMesh(parsed);
	if (!mesh) {
		throw new Error('PhyreEngine file contains no mesh');
	}
	const segments: PhyreMeshSegmentView[] = [];
	let xMin = Infinity, yMin = Infinity, zMin = Infinity;
	let xMax = -Infinity, yMax = -Infinity, zMax = -Infinity;
	for (const seg of mesh.segments) {
		const positions = extractPositions(parsed, seg);
		const indices = extractIndices(parsed, seg);
		const uvs = extractUVs(parsed, seg);
		const normals = extractNormals(parsed, seg);
		for (let i = 0; i < positions.length; i += 3) {
			const x = positions[i];
			const y = positions[i + 1];
			const z = positions[i + 2];
			if (x < xMin) xMin = x;
			if (y < yMin) yMin = y;
			if (z < zMin) zMin = z;
			if (x > xMax) xMax = x;
			if (y > yMax) yMax = y;
			if (z > zMax) zMax = z;
		}
		segments.push({ segment: seg, positions, indices, uvs, normals });
	}
	// Defensive: if no vertices were emitted, fall back to a unit
	// box so the renderer can still frame the empty scene.
	if (!Number.isFinite(xMin)) {
		xMin = yMin = zMin = -1;
		xMax = yMax = zMax = 1;
	}
	const bbox = {
		min: [xMin, yMin, zMin] as [number, number, number],
		max: [xMax, yMax, zMax] as [number, number, number],
	};
	const center: [number, number, number] = [
		(xMin + xMax) / 2,
		(yMin + yMax) / 2,
		(zMin + zMax) / 2,
	];
	const size = Math.max(xMax - xMin, yMax - yMin, zMax - zMin);
	const assetRefs = findAssetReferences(parsed);
	return { parsed, mesh, segments, bbox, center, size, assetRefs };
}

/**
 * Decode a sibling `.dds.phyre` texture blob into the shape the
 * generic {@link MeshViewer} expects (the same `DecodedTexture`
 * interface UE materials use). Used by the PhyreEngine mesh
 * viewer to apply material textures resolved via
 * {@link findAssetReferences}.
 *
 * `parsePhyreForView` returns pixels in canvas-top-down order.
 * We pass that straight through to Three.js, which has its own
 * `texture.flipY = true` upload flag — it flips on GPU upload,
 * landing pixels bottom-up in texture space. PhyreEngine UVs
 * are Maya-style (V=0 at bottom), so V=0 then samples the
 * bottom row → matches the engine's authoring intent.
 *
 * Errors are caught and the texture is skipped — partial
 * material coverage is better than nothing when one texture
 * fails to decode.
 */
export async function decodePhyreTextureForMaterial(
	blob: Blob,
	packagePath: string,
): Promise<{
	packagePath: string;
	width: number;
	height: number;
	pixels: Uint8Array;
	pixelFormat: string;
	normalReconstructed: boolean;
} | null> {
	try {
		const view = await parsePhyreForView(blob);
		return {
			packagePath,
			width: view.texture.width,
			height: view.texture.height,
			pixels: view.pixels,
			pixelFormat: view.texture.format,
			normalReconstructed: false,
		};
	} catch {
		return null;
	}
}

// ----- BFRES metadata preview -----

export interface BfresView {
	parsed: ParsedBfres;
}

export async function parseBfresForView(blob: Blob): Promise<BfresView> {
	const parsed = await parseBfres(blob);
	return { parsed };
}

// ----- WEM (Wwise Encoded Media) audio preview -----

/**
 * Unified WEM preview view-model. Either we managed to decode the
 * WEM into a browser-playable Blob (PCM → WAV, Switch-Opus → Ogg-
 * Opus), in which case `decoded` is non-null, or the codec isn't
 * something we can play in-browser yet (Vorbis, OPUSWW, etc.) and
 * we surface the codec metadata + a clear "unsupported" message.
 */
export interface WemView {
	parsed: ParsedWem;
	/** Successful decode result (browser-playable Blob), or null. */
	decoded: WemDecodeResult | null;
	/** Error message if the codec isn't supported for playback. */
	decodeError: string | null;
}

export async function parseWemForAudioView(blob: Blob): Promise<WemView> {
	const parsed = await parseWem(blob);
	let decoded: WemDecodeResult | null = null;
	let decodeError: string | null = null;
	try {
		// Vorbis WEMs need the aoTuV-603 codebook library. We fetch it
		// once on first use and cache the parsed library for all
		// subsequent decodes (kept in module scope below).
		const opts: Parameters<typeof decodeWemToBlob>[1] = {};
		if (parsed.fmt.codecId === 0xffff) {
			opts.vorbisCodebookLibrary = await getVorbisCodebookLibrary();
		}
		decoded = await decodeWemToBlob(parsed, opts);
	} catch (e) {
		decodeError = e instanceof Error ? e.message : String(e);
	}
	return { parsed, decoded, decodeError };
}

// ----- FMOD sample preview -----

export interface FmodSampleView {
	parsedFsb5: ParsedFsb5;
	sample: ParsedFsb5Sample;
	/** Successful decode (ready-to-play Blob), or null. */
	decoded: DecodeSampleResult | null;
	/** Error message if the codec isn't supported / decoding failed. */
	decodeError: string | null;
	/** Bank-level metadata for UI display. */
	bankInfo: {
		wasEncrypted: boolean;
		matchedKeyGame: string | null;
		paddingBytes: number;
	};
}

/**
 * Parse the FMOD bank that contains this sample, locate it by index,
 * and decode it. Used by the preview pane.
 */
export async function parseFmodSampleForView(
	bankBlob: Blob,
	sampleIndex: number,
): Promise<FmodSampleView> {
	const bank = await parseFmodBank(bankBlob);
	const r = await extractFsb5FromBank(bank, bankBlob);
	if (!r || !r.fsb5) {
		throw new Error(
			r?.wasEncrypted
				? 'FMOD bank is encrypted and no matching key was found in the built-in list.'
				: 'FMOD bank has no SND chunk (Master/strings bank?)',
		);
	}
	const fsb5 = parseFsb5(r.fsb5);
	if (sampleIndex < 0 || sampleIndex >= fsb5.samples.length) {
		throw new Error(`FMOD sample index ${sampleIndex} out of range (have ${fsb5.samples.length})`);
	}
	const sample = fsb5.samples[sampleIndex];

	let decoded: DecodeSampleResult | null = null;
	let decodeError: string | null = null;
	try {
		// Load the Vorbis setup library for Vorbis samples.
		let lib: FmodVorbisSetupPackets | undefined;
		if (fsb5.header.mode === 15) {
			lib = await getFmodVorbisLibrary();
		}
		decoded = await decodeSampleToBlob(sample, fsb5.header.mode, lib);
	} catch (e) {
		decodeError = e instanceof Error ? e.message : String(e);
	}

	return {
		parsedFsb5: fsb5,
		sample,
		decoded,
		decodeError,
		bankInfo: {
			wasEncrypted: r.wasEncrypted,
			matchedKeyGame: r.matchedKey?.game ?? null,
			paddingBytes: r.paddingBytes,
		},
	};
}

let _fmodVorbisLib: FmodVorbisSetupPackets | null = null;
let _fmodVorbisFetch: Promise<FmodVorbisSetupPackets> | null = null;
async function getFmodVorbisLibrary() {
	if (_fmodVorbisLib) return _fmodVorbisLib;
	if (_fmodVorbisFetch) return _fmodVorbisFetch;
	_fmodVorbisFetch = (async () => {
		const url = (
			await import(
				/* @vite-ignore */
				'@tootallnate/fsb5/assets/fmod_vorbis_setup_packets.bin?url'
			)
		).default as string;
		const res = await fetch(url);
		const buf = new Uint8Array(await res.arrayBuffer());
		_fmodVorbisLib = loadFmodVorbisSetupPackets(buf);
		return _fmodVorbisLib;
	})();
	return _fmodVorbisFetch;
}

// Re-export for the preview component
export { SOUND_FORMAT_NAMES };

// Lazy + cached fetch of the aoTuV-603 codebook library. The asset
// is bundled with `@tootallnate/wem-vorbis` and Vite resolves the
// `?url` import to a hashed asset URL at build time.
let _vorbisCodebookLib: import('@tootallnate/wem-vorbis').CodebookLibrary | null = null;
let _vorbisCodebookFetch: Promise<import('@tootallnate/wem-vorbis').CodebookLibrary> | null = null;
async function getVorbisCodebookLibrary() {
	if (_vorbisCodebookLib) return _vorbisCodebookLib;
	if (_vorbisCodebookFetch) return _vorbisCodebookFetch;
	_vorbisCodebookFetch = (async () => {
		// The `?url` query asks Vite to give us the resolved asset URL
		// (hashed in production, served as-is in dev). The .bin file
		// ships in the @tootallnate/wem-vorbis package.
		const cbUrl = (
			await import(
				/* @vite-ignore */
				'@tootallnate/wem-vorbis/assets/packed_codebooks_aoTuV_603.bin?url'
			)
		).default as string;
		const res = await fetch(cbUrl);
		const buf = new Uint8Array(await res.arrayBuffer());
		const { codebookLibraryFromBytes } = await import('@tootallnate/wem-vorbis');
		_vorbisCodebookLib = codebookLibraryFromBytes(buf);
		return _vorbisCodebookLib;
	})();
	return _vorbisCodebookFetch;
}

// ----- Hex view helpers -----

export function hex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i].toString(16).padStart(2, '0');
	}
	return s;
}

export function buildHexDump(
	bytes: Uint8Array,
	startOffset = 0,
	bytesPerRow = 16,
): string {
	const lines: string[] = [];
	for (let i = 0; i < bytes.length; i += bytesPerRow) {
		const off = (startOffset + i).toString(16).padStart(8, '0');
		const row = bytes.subarray(i, Math.min(i + bytesPerRow, bytes.length));
		const hexParts: string[] = [];
		for (let j = 0; j < bytesPerRow; j++) {
			if (j < row.length) hexParts.push(row[j].toString(16).padStart(2, '0'));
			else hexParts.push('  ');
			if (j === bytesPerRow / 2 - 1) hexParts.push(' ');
		}
		const ascii = Array.from(row)
			.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
			.join('');
		lines.push(`${off}  ${hexParts.join(' ')}  ${ascii}`);
	}
	return lines.join('\n');
}
