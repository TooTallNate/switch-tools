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
} from '@tootallnate/bntx';
import { parseBfres, type ParsedBfres } from '@tootallnate/bfres';
import {
	parseWem,
	decodeWemToBlob,
	type ParsedWem,
	type WemDecodeResult,
} from '@tootallnate/wem';

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
	/** Switch / Wii U single-shot audio (BFWAV / BFSTP, also BARS-embedded FWAVs). */
	| 'bfwav-audio'
	/** Switch / Wii U streamed audio (BFSTM / BFSTP). */
	| 'bfstm-audio'
	/** Wwise WEM audio asset (Switch-Opus → Ogg, PCM → WAV). */
	| 'wem-audio'
	/** Tiny ARSL manifest of BARS file paths. */
	| 'barslist-info'
	/** Switch HD Rumble vibration patterns. */
	| 'bnvib-audio'
	/** Nintendo binary YAML — game configs / data tables. */
	| 'byaml-tree'
	/** Nintendo texture format (BC1/3/4/5/7, RGBA8, etc.). */
	| 'bntx-image'
	| 'hex';

export const TEXT_EXTS = new Set([
	'txt',
	'md',
	'log',
	'cfg',
	'ini',
	'toml',
	'yml',
	'yaml',
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
	'html',
	'htm',
]);

export const JSON_EXTS = new Set(['json', 'webmanifest']);
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
	if (lower.endsWith('.ttf') || lower.endsWith('.otf') || lower.endsWith('.ttc') || lower.endsWith('.otc'))
		return 'font-info';
	if (lower.endsWith('.bffnt')) return 'bffnt-info';
	if (lower.endsWith('.bfwav')) return 'bfwav-audio';
	if (lower.endsWith('.bfstm') || lower.endsWith('.bfstp')) return 'bfstm-audio';
	if (lower.endsWith('.wem')) return 'wem-audio';
	if (lower.endsWith('.barslist')) return 'barslist-info';
	if (lower.endsWith('.bnvib')) return 'bnvib-audio';
	if (lower.endsWith('.byaml') || lower.endsWith('.byml')) return 'byaml-tree';
	if (lower.endsWith('.bntx')) return 'bntx-image';
	// Switch app icons (in Control NCA RomFS) are JPEGs with a `.dat` ext.
	if (/^icon_.*\.dat$/.test(lower)) return 'image';
	const ext = extOf(name);
	if (IMAGE_EXTS.has(ext)) return 'image';
	if (AUDIO_EXTS.has(ext)) return 'audio';
	if (VIDEO_EXTS.has(ext)) return 'video';
	if (JSON_EXTS.has(ext)) return 'json';
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
export interface FontView {
	/** Decoded font bytes ready for `FontFace` and download. */
	font: Blob;
	/** Sniffed sfnt format. */
	format: 'ttf' | 'otf' | 'unknown';
	/** Size of the decoded font in bytes. */
	size: number;
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
	 * plain TTF / OTF inputs.
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
 * Build a unified `FontView` from any sfnt blob — plain TTF / OTF
 * or Nintendo's obfuscated BFTTF / BFOTF wrapper. The returned
 * `font` Blob is always a *real* TTF / OTF ready for `FontFace`
 * registration.
 *
 * Auto-detects the input format by checking for the BFTTF magic
 * (8-byte read), falling back to "treat as plain sfnt" otherwise.
 * That way callers can hand us anything that looks like a font
 * file — `.ttf`, `.otf`, `.ttc` (collections, treated as opaque),
 * `.bfttf`, `.bfotf` — and get a uniform view.
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
	// Plain sfnt path: sniff the format from the first 4 bytes,
	// pick a sensible MIME type, and read the name table directly.
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const format = sniffSfntFormat(bytes);
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
 * Sniff `'ttf' | 'otf' | 'unknown'` from the first 4 bytes of an
 * sfnt-format font payload (TTF: 0x00010000 or "true" / "typ1";
 * OTF: "OTTO"; "ttcf" / "OTTO" wrapped in a TTC). TTC collections
 * have magic `ttcf` and contain multiple sub-fonts; we report them
 * as `'ttf'` since the contained sub-fonts are TTF-flavoured —
 * `FontFace` will pick the first one.
 */
function sniffSfntFormat(bytes: Uint8Array): 'ttf' | 'otf' | 'unknown' {
	if (bytes.length < 4) return 'unknown';
	const tag =
		(bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
	if (tag === 0x00010000) return 'ttf';
	if (tag === 0x4f54544f /* "OTTO" */) return 'otf';
	if (tag === 0x74727565 /* "true" */) return 'ttf';
	if (tag === 0x74797031 /* "typ1" */) return 'ttf';
	if (tag === 0x74746366 /* "ttcf" */) return 'ttf';
	return 'unknown';
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

	const count = view.getUint16(nameOff + 2, false);
	const stringOffset = view.getUint16(nameOff + 4, false);
	const stringStart = nameOff + stringOffset;
	if (stringStart > bytes.length) return {};

	const out: TtfNameTable = {};
	// Iterate the name records. Score each candidate so we prefer the
	// Unicode platform (0) or the Microsoft-Unicode platform (3, encoding 1)
	// over the Macintosh platform (1, encoding 0).
	const scored = new Map<number, { score: number; value: string }>();
	for (let i = 0; i < count; i++) {
		const recOff = nameOff + 6 + i * 12;
		if (recOff + 12 > nameOff + nameLen) break;
		const platformId = view.getUint16(recOff + 0, false);
		const encodingId = view.getUint16(recOff + 2, false);
		// const languageId = view.getUint16(recOff + 4, false);
		const nameId = view.getUint16(recOff + 6, false);
		const length = view.getUint16(recOff + 8, false);
		const offset = view.getUint16(recOff + 10, false);
		const dataOff = stringStart + offset;
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
	const decoded = decodeBntxLayer(bytes, texture, 0);
	return { parsed, texture, pixels: decoded.pixels };
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
