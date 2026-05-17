/**
 * Unified archive parsing for Nintendo Switch container formats.
 *
 * This module turns a top-level file `Blob` into a lazy tree of `Node`s.
 * Each node represents a virtual file or directory; container files
 * (NSP/PFS0/HFS0/XCI/NCA/NRO/RomFS) lazily expand into child nodes when
 * `getChildren()` is awaited the first time. File data — including
 * decryption / decompression — is also lazy: `node.blob()` returns the
 * data on demand, and parsers operate on `Blob.slice()` ranges so
 * multi-gigabyte archives don't need to be fully buffered.
 */

import { decode as nroDecode } from '@tootallnate/nro';
import { parseNsp } from '@tootallnate/nsp';
import { parseHfs0 } from '@tootallnate/hfs0';
import { parseXci } from '@tootallnate/xci';
import { decode as romfsDecode, type RomFsEntry } from '@tootallnate/romfs';
import { decompressNcz, isNcz, type OnProgress } from '@tootallnate/ncz';
import { parseSarc, type SarcEntry } from '@tootallnate/sarc';
import {
	parseIdTechResources,
	type IdTechResourceEntry,
} from '@tootallnate/idtech-resources';
import { decompressYaz0 } from '@tootallnate/yaz0';
import { decompressLz4, type Lz4Variant } from '@tootallnate/lz4';
import { parseBars, type BarsEntry } from '@tootallnate/bars';
import { parseAwb } from '@tootallnate/awb';
import {
	cueNamesForAwb,
	CueWaveformSource,
	parseAcb,
} from '@tootallnate/acb';
import { parseBfsar, extForMagic as bfsarExtForMagic } from '@tootallnate/bfsar';
import { parseBfwar } from '@tootallnate/bfwar';
import { parseBfres } from '@tootallnate/bfres';
import { parseGfpak } from '@tootallnate/gfpak';
import { parseAkpk } from '@tootallnate/wwise-pck';
import { parseBnk } from '@tootallnate/wwise-bnk';
import {
	parseFmodBank,
	extractFsb5FromBank,
	type Fsb5ExtractResult,
} from '@tootallnate/fmod-bank';
import { parseFsb5 } from '@tootallnate/fsb5';
import { parseZip, type ZipEntry } from './zip';
import { parseUnityFs, type UnityFsNode } from './unityfs';
import {
	parseSerializedFile,
	parseObject as parseUnityObject,
	ClassId as UnityClassId,
	type ParsedSerializedFile,
	type SerializedObject,
} from '@tootallnate/unity-asset';
import {
	parseIoStoreToc,
	type IoStoreToc,
	type IoChunkEntry,
} from '@tootallnate/iostore';
import {
	isUpakV11,
	parseUpak,
	readUpakEntry,
	type ParsedUpak,
	type UpakEntry,
} from '@tootallnate/upak';
import {
	parseNca,
	NCA_FS_TYPE_PFS0,
	NCA_FS_TYPE_ROMFS,
	type ParsedNca,
	type NcaSection,
	NcaContentType,
	type KeySet,
	NcaKeyError,
} from '@tootallnate/nca';
import type { WalkedDirectory } from './directory';
import { mergeSplitFiles, type MergedFile } from './split-file';
import { zstdDecompressBytes, zstdDecompressStream } from './zstd';

// ----- Node types -----

export type NodeKind =
	| 'file'
	| 'directory'
	| 'archive-root'
	| 'nca-section'
	| 'pfs0'
	| 'hfs0'
	| 'romfs'
	| 'nca'
	| 'xci-partition'
	| 'zip'
	| 'sarc'
	| 'lz4'
	| 'zstd'
	| 'unityfs'
	| 'unity-asset'
	| 'unity-object'
	| 'bars'
	| 'bfsar'
	| 'bfwar'
	| 'bfres'
	| 'awb'
	| 'acb'
	| 'gfpak'
	| 'wwise-pck'
	| 'wwise-bnk'
	| 'fmod-bank'
	| 'iostore'
	| 'upak'
	/**
	 * idTech BFG-era `.resources` archive (DOOM 3 BFG, RAGE,
	 * Wolfenstein: The New Order). Flat list of file entries with
	 * full-path names; we synthesise a directory tree at the
	 * forward-slash separators.
	 */
	| 'idtech-resources'
	/**
	 * A user-selected directory from the local filesystem. Functions
	 * like an "ad-hoc PFS0" — its children are the files inside, with
	 * `.tik` tickets aggregated for titlekey decryption across the
	 * subtree.
	 */
	| 'fs-directory'
	/**
	 * A `*.htdocs/` directory inside an offline-manual RomFS — these
	 * contain a self-contained mini-website (HTML/CSS/img/JS) shipped with
	 * a Nintendo Switch game and viewed through the Web Applet. We render
	 * them in an iframe with a stubbed `window.nx` so the user can browse
	 * the manual interactively instead of just digging through the files.
	 */
	| 'htdocs';

export interface NodeMeta {
	[key: string]: unknown;
}

/**
 * Options accepted by {@link Node.blob} for callers that want
 * progress events. See {@link OnProgress} from `@tootallnate/ncz`.
 */
export interface BlobOptions {
	onProgress?: OnProgress;
}

/**
 * A node in the virtual archive tree. Nodes are lazy: their children
 * (and sometimes their blob contents) are produced on demand.
 */
export interface Node {
	/** Unique stable id (path-like) used as React key */
	id: string;
	name: string;
	/** Whether this is a leaf file or a container/directory */
	kind: NodeKind;
	/** True when this node can have children */
	isContainer: boolean;
	/** Size in bytes if known (files only) */
	size?: number;
	/** Reported "format" for UI badge */
	format?: string;
	/** Arbitrary metadata for preview formatters (e.g. NCA fields) */
	meta?: NodeMeta;
	/**
	 * Returns the file's data as a Blob. For directories, undefined.
	 *
	 * The optional `onProgress` callback is fired periodically when
	 * materialising the blob involves a long-running decompression
	 * or decryption (e.g. NCZ → NCA, AES-CTR over multi-GB sections,
	 * Yaz0). For trivial blob retrievals (slicing a containers's
	 * already-loaded bytes) it's typically not called at all, or
	 * called once at 100% on completion. UIs that want a progress
	 * bar should always pass a callback; UIs that don't care can
	 * call `node.blob!()` without arguments.
	 */
	blob?: (options?: BlobOptions) => Promise<Blob>;
	/**
	 * Lazy children for containers.
	 *
	 * Same `onProgress` semantics as {@link Node.blob}: typically
	 * not called for trivial container expansions (parsing a few
	 * hundred bytes of header), but fires when expansion triggers
	 * a multi-second operation like NCZ decompression.
	 */
	getChildren?: (options?: BlobOptions) => Promise<Node[]>;
	/** Cached children once resolved. */
	_children?: Node[];
	_childrenError?: Error;
}

/**
 * Long-lived context shared across every node in an opened archive tree.
 *
 * Important: closures inside the tree capture this object by reference and
 * keep it forever, so the values it exposes must be reachable LAZILY at
 * call time — not snapshotted at tree-build time. The App passes in a
 * stable instance whose `getKeys()` reads from the latest React state,
 * so providing keys later (after the tree has already been built and
 * partially expanded) immediately makes those keys available to every
 * pending NCA decryption.
 */
/**
 * A function that decompresses one Oodle-compressed block in-place.
 * The host wires this up by loading `oodle.wasm` (built per the
 * `@tootallnate/oodle-wasm` package's README) and forwarding to
 * `OodleDecoder.decompress`.
 */
export type OodleDecompress = (
	compressed: Uint8Array,
	uncompressedSize: number,
) => Promise<Uint8Array>;

export interface ArchiveContext {
	/** Returns the current `KeySet`, or `null` if none has been provided yet. */
	getKeys: () => KeySet | null;
	/** Asks the UI to prompt the user for `prod.keys`. */
	requestKeys: () => void;
	/**
	 * Returns an Oodle decompressor if the user has supplied an
	 * `oodle.wasm` blob, or `null` otherwise. Reading
	 * Oodle-compressed PAK/IoStore entries calls this once per
	 * block; the returned function may be the same instance across
	 * calls or a fresh closure each time.
	 */
	getOodleDecompressor?: () => OodleDecompress | null;
	/** Asks the UI to prompt the user for an `oodle.wasm` blob. */
	requestOodle?: () => void;
}

/**
 * Maps a 32-char hex Rights ID (lower-case) to its encrypted titlekey,
 * collected from `.tik` files in the same NSP/XCI container. NCA nodes
 * use this to decrypt their bodies when the NCA has a non-zero RightsId.
 */
type TikMap = Map<string, Uint8Array>;

const TIK_RIGHTS_ID_OFFSET = 0x2a0;
const TIK_TITLE_KEY_OFFSET = 0x180;
const TIK_TITLE_KEY_SIZE = 0x10;

/**
 * The first 0x4000 bytes of an NCZ are the original (encrypted) NCA
 * header passed through verbatim, before the NCZ section table begins.
 * For preview-time inspection we can read these bytes directly off the
 * compressed file and never touch zstd.
 *
 * Source: `@tootallnate/ncz`'s `NCZ_HEADER_SIZE` constant; documented
 * in the NCZ section magic at offset 0x4000.
 */
const NCZ_NCA_HEADER_BYTES = 0x4000;

function bytesToHex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
	return s;
}

/**
 * Locale-aware "natural" string comparator used to sort tree entries.
 *
 * The default `localeCompare` treats the digits in `level10` as
 * coming before `level2`, which is wrong for the way humans (and
 * file managers) read filenames with embedded numbers. Setting
 * `numeric: true` makes runs of digits compare as numbers, so the
 * order becomes `level1 < level2 < level10 < level11 …`. We also
 * pin `sensitivity: 'base'` so case differences don't reorder
 * neighbours unpredictably.
 */
const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: 'base',
});
function humanCompare(a: string, b: string): number {
	return collator.compare(a, b);
}

/**
 * Extract a `rightsId → encryptedTitleKey` map from any `.tik` entries
 * inside a PFS0/HFS0 file map. Tickets that fail to parse are silently
 * skipped (we don't want one bad ticket to stop the whole archive).
 */
async function buildTikMap(
	files: Iterable<readonly [string, { data: Blob }]>,
): Promise<TikMap> {
	const map: TikMap = new Map();
	for (const [name, entry] of files) {
		if (!name.toLowerCase().endsWith('.tik')) continue;
		try {
			const bytes = new Uint8Array(await entry.data.arrayBuffer());
			if (bytes.length < TIK_RIGHTS_ID_OFFSET + 0x10) continue;
			const rightsId = bytes.slice(
				TIK_RIGHTS_ID_OFFSET,
				TIK_RIGHTS_ID_OFFSET + 0x10,
			);
			const encryptedTitleKey = bytes.slice(
				TIK_TITLE_KEY_OFFSET,
				TIK_TITLE_KEY_OFFSET + TIK_TITLE_KEY_SIZE,
			);
			map.set(bytesToHex(rightsId), encryptedTitleKey);
		} catch {
			/* ignore malformed ticket */
		}
	}
	return map;
}

const FILE_EXT_FORMATS: Record<string, string> = {
	nro: 'NRO',
	nsp: 'NSP',
	nsz: 'NSZ',
	xci: 'XCI',
	xcz: 'XCZ',
	nca: 'NCA',
	ncz: 'NCZ',
	nso: 'NSO',
	pfs0: 'PFS0',
	hfs0: 'HFS0',
	romfs: 'RomFS',
	bin: 'BIN',
	cnmt: 'CNMT',
	nacp: 'NACP',
	npdm: 'NPDM',
	bfttf: 'BFTTF',
	bfotf: 'BFOTF',
	bffnt: 'BFFNT',
	ttf: 'TTF',
	otf: 'OTF',
	ttc: 'TTC',
	otc: 'OTC',
	zip: 'ZIP',
	sarc: 'SARC',
	pack: 'SARC', // common first-party-game SARC alias
	arc: 'SARC', // SARC alias used by Pokémon LA, Resident Evil 0 / 1 (rebuild), Pokken, ToS Remastered, etc.
	szs: 'SZS', // Yaz0-compressed SARC, ubiquitous across 1st-party games
	yaz0: 'YAZ0',
	lz4: 'LZ4',
	zs: 'ZSTD', // Nintendo TotK / Wonder convention for Zstd-wrapped resources
	zst: 'ZSTD', // standard Zstandard suffix (Super Mario 3D All-Stars, Paper Mario TTYD)
	bundle: 'UnityFS', // Unity Addressables: `*.bundle`
	unity3d: 'UnityFS', // Legacy Unity AssetBundle extension
	ab: 'UnityFS', // Common Unity AssetBundle extension (Detective Pikachu, etc.)
	utoc: 'UE-TOC', // Unreal Engine IoStore: Table of Contents
	ucas: 'UE-CAS', // Unreal Engine IoStore: Container ASsets (raw)
	pak: 'UE-PAK', // Unreal Engine classic PAK container
	uasset: 'UASSET', // Unreal Engine asset package
	uexp: 'UEXP', // Unreal Engine export-data sidecar
	ubulk: 'UBULK', // Unreal Engine bulk-data sidecar
	umap: 'UMAP', // Unreal Engine map / level
	uplugin: 'UPLUGIN', // Unreal Engine plugin descriptor (JSON)
	uproject: 'UPROJECT', // Unreal Engine project descriptor (JSON)
	bars: 'BARS', // Nintendo audio resource archive
	bfsar: 'BFSAR', // Nintendo sound archive (NintendoWare; magic FSAR)
	bfwar: 'BFWAR', // Wave archive (collection of BFWAVs)
	bfstm: 'BFSTM', // Streamed audio
	bfwav: 'BFWAV', // Cached/baked audio
	bwav: 'BWAV', // Newer Nintendo wav (BotW 2 / Tears of the Kingdom / Mario Wonder era)
	bfstp: 'BFSTP', // Prefetch stream
	barslist: 'BARSLIST', // ARSL — manifest of BARS file refs
	bnvib: 'BNVIB', // Switch HD Rumble vibration pattern
	byaml: 'BYAML', // Nintendo binary YAML
	byml: 'BYML',
	bntx: 'BNTX', // Nintendo texture format (BC1/3/4/5/7, RGBA8, etc.)
	bfres: 'BFRES', // Nintendo 3D resource (FRES) — models + embedded BNTX
	gfpak: 'GFPAK', // Game Freak archive
	gfbmdl: 'GFBMDL', // Game Freak model
	gfbanm: 'GFBANM', // Game Freak skeletal animation
	gfbanmcfg: 'GFBANMCFG', // Game Freak animation config
	bfbnk: 'BFBNK', // Instrument bank
	bfseq: 'BFSEQ', // Sequence (MIDI-like)
	bfgrp: 'BFGRP', // Group sub-archive
	bfwsd: 'BFWSD', // Wave-sound graph (used inside BFSARs)
	pck: 'AKPK', // Audiokinetic Wwise streaming-WEM package
	bnk: 'BNK', // Audiokinetic Wwise SoundBank
	wem: 'WEM', // Wwise Encoded Media (audio asset)
	bank: 'BANK', // FMOD Studio bank (FEV form-type)
	fsb: 'FSB5', // FMOD Sample Bank
	awb: 'AWB', // CRI AFS2 audio wave bank
	acb: 'ACB', // CRI Audio Cue Binary (cue manifest; pairs with .awb sibling)
	hca: 'HCA', // CRI High Compression Audio
	resources: 'idTech-Resources', // DOOM 3 BFG / RAGE / Wolfenstein TNO container (magic 0xD000000D)
};

/**
 * The well-known names of NSO0 executable modules that ship inside an
 * ExeFS PFS0 with no extension. Files matching these get an `NSO`
 * format badge (and a structured preview).
 */
const NSO_EXEFS_NAMES = new Set([
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

function extOf(name: string): string {
	const i = name.lastIndexOf('.');
	if (i < 0) return '';
	return name.slice(i + 1).toLowerCase();
}

export function detectFormat(name: string): string {
	const lower = name.toLowerCase();
	// Switch app icons (in Control NCA RomFS) are JPEGs disguised as `.dat`.
	if (/^icon_.*\.dat$/.test(lower)) return 'JPEG';
	// Bare ExeFS module names (no extension) are NSO0 executables.
	if (NSO_EXEFS_NAMES.has(lower)) return 'NSO';
	const ext = extOf(name);
	return FILE_EXT_FORMATS[ext] ?? ext.toUpperCase();
}

/**
 * The format token ({@link FILE_EXT_FORMATS} value) for a magic
 * recognised by {@link sniffMagicCheap}. The caller maps these
 * tokens onto `make*Node` builders.
 */
type SniffedFormat =
	| 'pfs0'
	| 'hfs0'
	| 'romfs'
	| 'sarc'
	| 'szs'
	| 'unityfs'
	| 'zip'
	| 'lz4'
	| 'nro'
	| 'xci'
	| 'bars'
	| 'bfsar'
	| 'bfwar'
	| 'bfres'
	| 'gfpak'
	| 'wwise-pck'
	| 'wwise-bnk'
	| 'fmod-bank'
	| 'awb'
	| 'zstd'
	| 'idtech-resources';

/**
 * Sniff magic bytes that live in the first 8 bytes of the file. Cheap
 * enough to call on every child of a freshly-expanded container —
 * even when there are hundreds of children — because each call reads
 * at most 8 bytes, which for SARC / ZIP / RomFS children is a
 * synchronous slice into an already-resident `Uint8Array`.
 *
 * Avoid this for unbounded folders of unknown size opened at the
 * top level — for those, prefer {@link sniffMagic} which also looks
 * for magics deeper in the file (NRO at 0x10, XCI at 0x100). Those
 * deeper reads are unlikely to be relevant for nested content
 * (you don't typically find an NRO inside a SARC) and add fixed cost
 * even when the magic doesn't match.
 */
async function sniffMagicCheap(blob: Blob): Promise<SniffedFormat | null> {
	if (blob.size < 4) return null;
	// 12-byte read covers everything we need: 8-byte magics (GFLXPACK,
	// UnityFS) plus the RIFF+formType pattern at offsets 0..3 and 8..11.
	const headLen = Math.min(blob.size, 12);
	const head = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
	// 4-byte ASCII magics.
	const m4 =
		head.length >= 4
			? new TextDecoder().decode(head.subarray(0, 4))
			: '';
	if (m4 === 'PFS0') return 'pfs0';
	if (m4 === 'HFS0') return 'hfs0';
	if (m4 === 'IVFC') return 'romfs';
	if (m4 === 'SARC') return 'sarc';
	if (m4 === 'Yaz0') return 'szs'; // we treat all Yaz0 as SZS-style for browsing
	if (m4 === 'BARS') return 'bars';
	if (m4 === 'FSAR') return 'bfsar';
	if (m4 === 'FWAR') return 'bfwar';
	if (m4 === 'FRES') return 'bfres';
	if (m4 === 'AFS2') return 'awb';
	// Zstandard frame magic: 0x28b52ffd LE — used both by Nintendo's
	// `.zs` (TotK / Wonder) and by the standard `.zst` suffix
	// (Paper Mario TTYD, Super Mario 3D All-Stars). The extension
	// dispatch above catches most of these; this sniff covers files
	// inside containers that don't carry the suffix.
	if (
		head.length >= 4 &&
		head[0] === 0x28 &&
		head[1] === 0xb5 &&
		head[2] === 0x2f &&
		head[3] === 0xfd
	) {
		return 'zstd';
	}
	if (m4 === 'AKPK' || m4 === 'KPKA') return 'wwise-pck';
	if (m4 === 'BKHD') return 'wwise-bnk';
	// FMOD Studio bank: RIFF + form-type "FEV " at offset 8.
	if (
		m4 === 'RIFF' &&
		head.length >= 12 &&
		head[8] === 0x46 &&
		head[9] === 0x45 &&
		head[10] === 0x56 &&
		head[11] === 0x20
	) {
		return 'fmod-bank';
	}
	// GFPAK has 8-byte magic "GFLXPACK" — sniff if we read enough bytes.
	if (head.length >= 8) {
		const m8 = new TextDecoder().decode(head.subarray(0, 8));
		if (m8 === 'GFLXPACK') return 'gfpak';
	}
	// UnityFS bundle magic: NUL-terminated "UnityFS" (8 bytes including NUL).
	if (
		head.length >= 8 &&
		head[0] === 0x55 &&
		head[1] === 0x6e &&
		head[2] === 0x69 &&
		head[3] === 0x74 &&
		head[4] === 0x79 &&
		head[5] === 0x46 &&
		head[6] === 0x53 &&
		head[7] === 0x00
	) {
		return 'unityfs';
	}
	// ZIP local file header is "PK\x03\x04" — match raw bytes since
	// the trailing two bytes aren't printable.
	if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
		return 'zip';
	}
	// Standard LZ4 frame magic: 0x184D2204 (little-endian on disk).
	if (head[0] === 0x04 && head[1] === 0x22 && head[2] === 0x4d && head[3] === 0x18) {
		return 'lz4';
	}
	// Legacy LZ4 frame magic: 0x184C2102.
	if (head[0] === 0x02 && head[1] === 0x21 && head[2] === 0x4c && head[3] === 0x18) {
		return 'lz4';
	}
	// idTech BFG-era `.resources` archive: magic 0xD000000D (big-endian).
	if (head[0] === 0xd0 && head[1] === 0x00 && head[2] === 0x00 && head[3] === 0x0d) {
		return 'idtech-resources';
	}
	return null;
}

/**
 * Top-level magic sniffer used by {@link buildRootNode}. Includes
 * the cheap header-front magics plus deeper checks for NRO (magic
 * at 0x10) and XCI (magic at 0x100) — the two formats whose magic
 * doesn't sit at the start of the file.
 */
async function sniffMagic(blob: Blob): Promise<SniffedFormat | null> {
	const cheap = await sniffMagicCheap(blob);
	if (cheap) return cheap;
	const dec = new TextDecoder();
	// NRO has its magic at offset 0x10 ("NRO0")
	if (blob.size >= 0x14) {
		const magicAt10 = new Uint8Array(
			await blob.slice(0x10, 0x14).arrayBuffer(),
		);
		if (dec.decode(magicAt10) === 'NRO0') return 'nro';
	}
	// XCI has "HEAD" at offset 0x100
	if (blob.size >= 0x104) {
		const magicAtHead = new Uint8Array(
			await blob.slice(0x100, 0x104).arrayBuffer(),
		);
		if (dec.decode(magicAtHead) === 'HEAD') return 'xci';
	}
	return null;
}

// ----- Top-level entry: turn a user-provided Blob into a root Node -----

export async function buildRootNode(
	file: File | Blob,
	displayName: string,
	ctx: ArchiveContext,
): Promise<Node> {
	let format = detectFormat(displayName);
	if (!format || format === extOf(displayName).toUpperCase()) {
		const sniffed = await sniffMagic(file);
		if (sniffed) format = FILE_EXT_FORMATS[sniffed] ?? format;
	}

	const id = `/${displayName}`;
	const blob = file instanceof File ? file : (file as Blob);

	switch (format) {
		case 'NRO':
			return makeNroNode(id, displayName, blob, ctx);
		case 'NSP':
		case 'NSZ': // NSZ is an NSP whose NCAs are NCZs — same container
			return makePfs0Node(id, displayName, blob, ctx, 'NSP');
		case 'PFS0':
			return makePfs0Node(id, displayName, blob, ctx, 'PFS0');
		case 'HFS0':
			return makeHfs0Node(id, displayName, blob, ctx);
		case 'XCI':
		case 'XCZ':
			return makeXciNode(id, displayName, blob, ctx);
		case 'NCA':
			return makeNcaNode(id, displayName, blob, ctx);
		case 'NCZ':
			return makeNczNode(id, displayName, blob, ctx);
		case 'RomFS':
			return makeRomfsNode(id, displayName, blob, ctx);
		case 'ZIP':
			return makeZipNode(id, displayName, blob, ctx);
		case 'SARC':
			return makeSarcNode(id, displayName, blob, ctx);
		case 'idTech-Resources':
			return makeIdTechResourcesNode(id, displayName, blob, ctx);
		case 'SZS':
		case 'YAZ0':
			return makeSzsNode(id, displayName, blob, ctx);
		case 'LZ4':
			return makeLz4Node(id, displayName, blob, ctx);
		case 'ZSTD':
			return makeZstdNode(id, displayName, blob, ctx);
		case 'UnityFS':
			return makeUnityFsNode(id, displayName, blob, ctx);
		case 'UE-PAK': {
			// `.pak` is also used by Nintendo's bespoke `.pack`
			// family — footer-sniff to disambiguate before
			// committing to UE PAK parsing.
			if (await isUpakV11(blob)) {
				return makeUpakNode(id, displayName, blob, ctx);
			}
			// Otherwise fall through to a generic file (the user
			// can still download / hex-view it).
			return {
				id,
				name: displayName,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: 'PAK',
				blob: async () => blob,
			};
		}
		case 'AWB':
			return makeAwbNode(id, displayName, blob, ctx);
		case 'ACB':
			return makeAcbNode(id, displayName, blob, ctx, undefined);
		case 'BARS':
			return makeBarsNode(id, displayName, blob, ctx);
		case 'BFSAR':
			return makeBfsarNode(id, displayName, blob, ctx);
		case 'BFWAR':
			return makeBfwarNode(id, displayName, blob, ctx);
		case 'BFRES':
			return makeBfresNode(id, displayName, blob, ctx);
		case 'GFPAK':
			return makeGfpakNode(id, displayName, blob, ctx);
		case 'AKPK':
			return makeWwisePckNode(id, displayName, blob, ctx);
		case 'BNK':
			return makeWwiseBnkNode(id, displayName, blob, ctx);
		case 'BANK': {
			// Disambiguate Wwise vs FMOD by magic.
			const sniffed = await sniffMagicCheap(blob);
			if (sniffed === 'fmod-bank') return makeFmodBankNode(id, displayName, blob, ctx);
			if (sniffed === 'wwise-bnk') return makeWwiseBnkNode(id, displayName, blob, ctx);
			// Unknown bank flavour — fall through to generic.
			return {
				id,
				name: displayName,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: 'BANK',
				blob: async () => blob,
			};
		}
		default:
			// Unknown — present it as a single file the user can download
			return {
				id,
				name: displayName,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: format || 'BIN',
				blob: async () => blob,
			};
	}
}

// ----- Top-level entry: turn a user-selected directory into a root Node -----

/**
 * Build a root node from a walked directory. The directory is rendered
 * as a single top-level container ("ad-hoc PFS0") with one child per
 * merged file. `.tik` tickets anywhere in the subtree are aggregated
 * into a single tikMap so any encrypted NCAs in the directory can
 * decrypt with their matching titlekey.
 *
 * Split-archive parts (`foo.xci.00` / `foo.xci/00` / `foo.nsp.partN`)
 * are auto-merged into a single virtual archive via lazy `Blob` concat.
 */
export async function buildDirectoryRootNode(
	directory: WalkedDirectory,
	ctx: ArchiveContext,
): Promise<Node> {
	// Merge split-file groups before anything else, so the rest of the
	// pipeline never sees `.xci.00` etc.
	const merged = mergeSplitFiles(directory.files);
	// Build the tikMap once for the whole directory so titlekey
	// decryption works regardless of where the .tik file sits relative
	// to the NCA.
	const tikMap = await buildTikMap(
		merged.map((m) => [m.relativePath, { data: m.blob }] as const),
	);
	const rootId = `/${directory.name}`;
	const totalSize = merged.reduce((s, m) => s + m.size, 0);
	return {
		id: rootId,
		name: directory.name,
		kind: 'fs-directory',
		isContainer: true,
		size: totalSize,
		format: 'directory',
		// Directory roots aren't downloadable as a single blob (we'd
		// have to zip them); leave `blob` unset so the toolbar's
		// Download button hides itself.
		getChildren: async () =>
			directoryChildrenFromMerged(rootId, merged, ctx, tikMap),
	};
}

/**
 * Produce one level of children given a flat list of merged files
 * already prefixed with a base path. Any path that contains a `/` is
 * split — its first segment becomes a sub-directory node with the
 * remainder of the path passed down.
 */
function directoryChildrenFromMerged(
	parentId: string,
	merged: MergedFile[],
	ctx: ArchiveContext,
	tikMap: TikMap,
): Promise<Node[]> {
	// Group by first path segment.
	const dirs = new Map<string, MergedFile[]>();
	const files: MergedFile[] = [];
	for (const m of merged) {
		const slash = m.relativePath.indexOf('/');
		if (slash < 0) {
			files.push(m);
			continue;
		}
		const head = m.relativePath.slice(0, slash);
		const tail = m.relativePath.slice(slash + 1);
		const list = dirs.get(head);
		const childMerged: MergedFile = {
			...m,
			relativePath: tail,
		};
		if (list) list.push(childMerged);
		else dirs.set(head, [childMerged]);
	}

	// Resolve directories + files into Node[] in natural-sort order
	// with directories first (mirrors how the rest of the app sorts
	// romfs). `humanCompare` orders `level1 < level2 < level10`
	// instead of the default lexicographic `level1 < level10 < level2`.
	const dirNames = [...dirs.keys()].sort(humanCompare);
	const fileNames = files.sort((a, b) =>
		humanCompare(a.relativePath, b.relativePath),
	);

	const out: Promise<Node>[] = [];
	for (const name of dirNames) {
		const id = `${parentId}/${name}`;
		const childMerged = dirs.get(name)!;
		const subtotal = childMerged.reduce((s, m) => s + m.size, 0);
		out.push(
			Promise.resolve<Node>(
				childDirectoryNodeFor({
					id,
					name,
					size: subtotal,
					getChildren: () =>
						directoryChildrenFromMerged(id, childMerged, ctx, tikMap),
				}),
			),
		);
	}
	// Build a sibling map so pair-aware formats (AWB ↔ ACB) can
	// resolve their companion files lazily by name within this
	// directory level.
	const siblings = buildSiblingMap(
		fileNames.map((m) => [m.relativePath, m.blob] as const),
	);
	for (const m of fileNames) {
		const name = m.relativePath; // already a leaf
		const id = `${parentId}/${name}`;
		out.push(directoryFileNode(id, name, m, ctx, tikMap, siblings));
	}
	return Promise.all(out);
}

/**
 * Wrap a leaf file from a directory walk into a Node. Routes through
 * `childNodeFor` so we get format detection + container expansion +
 * NCA decryption for free.
 */
async function directoryFileNode(
	id: string,
	name: string,
	m: MergedFile,
	ctx: ArchiveContext,
	tikMap: TikMap,
	siblings?: SiblingMap,
): Promise<Node> {
	const node = await childNodeFor(id, name, m.blob, ctx, tikMap, siblings);
	// Annotate split files with a friendlier badge so users can see
	// "this is N parts joined".
	if (m.partCount > 1 && node.kind === 'file') {
		const original = node.format ?? '';
		return {
			...node,
			format: original
				? `${original} (${m.partCount} parts)`
				: `${m.partCount} parts`,
		};
	}
	return node;
}

// ----- NRO -----

function makeNroNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'archive-root',
		isContainer: true,
		size: blob.size,
		format: 'NRO',
		blob: async () => blob,
		getChildren: async () => {
			const nro = await nroDecode(blob);
			const children: Node[] = [];
			children.push({
				id: `${id}/nro-data`,
				name: 'main.nro',
				kind: 'file',
				isContainer: false,
				size: nro.data.size,
				format: 'NRO (executable)',
				blob: async () => nro.data,
			});
			if (nro.icon) {
				children.push({
					id: `${id}/icon.jpg`,
					name: 'icon.jpg',
					kind: 'file',
					isContainer: false,
					size: nro.icon.size,
					format: 'JPEG (icon)',
					blob: async () => nro.icon!,
				});
			}
			if (nro.nacp) {
				children.push({
					id: `${id}/control.nacp`,
					name: 'control.nacp',
					kind: 'file',
					isContainer: false,
					size: nro.nacp.size,
					format: 'NACP',
					blob: async () => nro.nacp!,
				});
			}
			if (nro.romfs) {
				children.push(
					makeRomfsNode(`${id}/romfs`, 'romfs', nro.romfs, ctx),
				);
			}
			return children;
		},
	};
}

// ----- PFS0 / NSP -----

function makePfs0Node(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	format: string,
): Node {
	return {
		id,
		name,
		kind: 'pfs0',
		isContainer: true,
		size: blob.size,
		format,
		blob: async () => blob,
		getChildren: async () => {
			const pfs0 = await parseNsp(blob);
			// Scan for .tik files first so we can pass titlekeys to NCA children
			const tikMap = await buildTikMap(pfs0.files);
			const children: Node[] = [];
			for (const [childName, entry] of pfs0.files) {
				children.push(
					await childNodeFor(
						`${id}/${childName}`,
						childName,
						entry.data,
						ctx,
						tikMap,
					),
				);
			}
			return children;
		},
	};
}

// ----- HFS0 -----

function makeHfs0Node(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'hfs0',
		isContainer: true,
		size: blob.size,
		format: 'HFS0',
		blob: async () => blob,
		getChildren: async () => {
			const hfs0 = await parseHfs0(blob);
			const tikMap = await buildTikMap(hfs0.files);
			const children: Node[] = [];
			for (const [childName, entry] of hfs0.files) {
				children.push(
					await childNodeFor(
						`${id}/${childName}`,
						childName,
						entry.data,
						ctx,
						tikMap,
					),
				);
			}
			return children;
		},
	};
}

// ----- XCI -----

function makeXciNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'archive-root',
		isContainer: true,
		size: blob.size,
		format: 'XCI',
		blob: async () => blob,
		getChildren: async () => {
			const xci = await parseXci(blob);
			// Tickets are usually in the secure partition; merge any we find.
			const mergedTik: TikMap = new Map();
			for (const partition of xci.partitions) {
				const m = await buildTikMap(partition.files);
				for (const [k, v] of m) mergedTik.set(k, v);
			}
			const children: Node[] = [];
			for (const partition of xci.partitions) {
				const partId = `${id}/${partition.name}`;
				children.push({
					id: partId,
					name: partition.name,
					kind: 'xci-partition',
					isContainer: true,
					format: 'HFS0 (partition)',
					getChildren: async () => {
						const partKids: Node[] = [];
						for (const [childName, entry] of partition.files) {
							partKids.push(
								await childNodeFor(
									`${partId}/${childName}`,
									childName,
									entry.data,
									ctx,
									mergedTik,
								),
							);
						}
						return partKids;
					},
				});
			}
			return children;
		},
	};
}

// ----- NCA -----

/**
 * Parse an NCA blob, automatically applying the matching titlekey from
 * the surrounding container's `tikMap` when the NCA is rights-id-keyed.
 *
 * Two-pass: a first cheap parse (header decrypt only) reads the rights
 * ID and key generation; if the NCA needs a titlekey AND the tikMap
 * has one for that rights ID, we re-parse with the titlekey wired in
 * so section bodies can be decrypted.
 *
 * Throws if `ctx.getKeys()` returns null (and asks the UI for keys);
 * does NOT throw on `parsed.missingKey` — callers can decide whether
 * to surface the metadata anyway. (The lazy section blobs already
 * throw on read when keys are missing, so the user gets a clear
 * error at the point where they actually try to use the data.)
 */
async function parseNcaWithTik(
	blob: Blob,
	ctx: ArchiveContext,
	tikMap: TikMap | undefined,
): Promise<ParsedNca> {
	const keys = ctx.getKeys();
	if (!keys) {
		ctx.requestKeys();
		throw new ProdKeysMissingError();
	}
	let parsed = await parseNca(blob, { keys });
	if (parsed.hasRightsId && tikMap) {
		const ridKey = bytesToHex(parsed.rightsId);
		const encryptedTitleKey = tikMap.get(ridKey);
		if (encryptedTitleKey) {
			parsed = await parseNca(blob, { keys, encryptedTitleKey });
		}
	}
	return parsed;
}

/**
 * Thrown when an NCA decryption operation needs `prod.keys` but
 * none has been loaded into the app yet. Distinct from the
 * `@tootallnate/nca` package's {@link NcaKeyError} (which covers
 * "keys present but wrong / outdated") so callers can branch on
 * `instanceof` to decide whether to prompt for keys or to suggest
 * updating an existing key file.
 *
 * The constructor double-fires `ctx.requestKeys()` is not
 * sufficient on its own — the user might dismiss the dialog,
 * navigate away, and click the same node later expecting a
 * fresh attempt. Throwing this error guarantees the failure
 * surfaces in the tree's per-node error state and gets re-tried
 * once keys land.
 */
export class ProdKeysMissingError extends Error {
	constructor() {
		super('NCA decryption requires prod.keys.');
		this.name = 'ProdKeysMissingError';
	}
}

/**
 * Thrown when an Oodle-compressed PAK / IoStore entry can't be
 * decompressed because the user hasn't supplied an `oodle.wasm`
 * blob. The host catches this and prompts the user; once a WASM
 * blob lands in `ArchiveContext.getOodleDecompressor()`, the read
 * succeeds on retry.
 */
export class OodleMissingError extends Error {
	constructor(
		message = 'Oodle-compressed data requires a separately-built oodle.wasm.',
	) {
		super(message);
		this.name = 'OodleMissingError';
	}
}

function makeNcaNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	tikMap?: TikMap,
): Node {
	return {
		id,
		name,
		kind: 'nca',
		isContainer: true,
		size: blob.size,
		format: 'NCA',
		// `meta.ncaSource` carries everything the preview component
		// needs to re-parse the NCA on its own (whether or not the user
		// has expanded it in the tree). Stash it as part of the node so
		// the preview pane can look it up via `node.meta`.
		meta: {
			ncaSource: {
				// For plain NCAs the header is already at the start of the
				// blob and `parseNca` only reads the first 0xC00 bytes
				// regardless, so it's fine to hand it the whole blob.
				getHeader: async () => blob,
				// Plain NCAs don't need decompression — return the blob
				// immediately. We still fire a single progress event at
				// 100% for callers that wired up a `<ProgressFiller>`,
				// so the UI doesn't get stuck on the spinner.
				getBlob: async (options) => {
					if (options?.onProgress) {
						options.onProgress({
							bytesIn: blob.size,
							bytesOut: blob.size,
							bytesInTotal: blob.size,
							bytesOutTotal: blob.size,
						});
					}
					return blob;
				},
				ctx,
				tikMap,
			} satisfies NcaSource,
		},
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseNcaWithTik(blob, ctx, tikMap);
			if (parsed.missingKeyDetail) {
				throw new NcaKeyError(parsed.missingKeyDetail);
			}
			return ncaSectionNodes(id, parsed, ctx, tikMap);
		},
	};
}

/**
 * Public type for the `meta.ncaSource` field stashed on `'nca'`-kind
 * nodes. The preview component imports this type and re-parses the
 * NCA on demand when the user selects the node.
 *
 * Two thunks are exposed because not every consumer needs the full
 * NCA bytes:
 *
 * - `getHeader()` returns a `Blob` from which the NCA *header* can be
 *   parsed — i.e. at least the first 0xC00 bytes, decrypted on demand
 *   by `parseNca` using the AES-XTS header key. Crucially, for NCZ
 *   sources this returns the first 0x4000 bytes of the *NCZ* blob
 *   (which holds the original NCA header verbatim, per the NCZ spec).
 *   This is what the preview pane uses, so opening an NCZ doesn't
 *   trigger a multi-gigabyte zstd decompression.
 *
 * - `getBlob()` returns the full NCA blob — for plain NCAs that's the
 *   blob as-is; for NCZs it triggers (and caches) the zstd
 *   decompression. Used when the user actually expands the NCA in
 *   the tree to drill into its sections.
 */
export interface NcaSource {
	/** Lightweight: only the bytes needed for header parsing. */
	getHeader: () => Promise<Blob>;
	/**
	 * Heavyweight: the full NCA, materialising NCZ decompression if
	 * needed. The optional `onProgress` is called periodically while
	 * decompression is running so the caller can render a progress
	 * bar; for already-plaintext NCAs it's only fired once at 100%.
	 */
	getBlob: (options?: { onProgress?: OnProgress }) => Promise<Blob>;
	ctx: ArchiveContext;
	tikMap?: TikMap;
}

/**
 * Re-parse the NCA *header* backing an `'nca'` node, applying
 * titlekey crypto via the surrounding container's tikMap when
 * applicable.
 *
 * Important: this only reads enough bytes to populate `ParsedNca`
 * fields. The returned object's `sections[].data` will not be
 * usable for reading section bodies on NCZ-backed nodes — that's
 * intentional. Reading section bodies needs the full decompressed
 * NCA, which only happens when the user expands the NCA in the
 * tree (`getChildren`) and gets back proper section nodes.
 */
export async function parseNcaForNode(source: NcaSource): Promise<ParsedNca> {
	const blob = await source.getHeader();
	return parseNcaWithTik(blob, source.ctx, source.tikMap);
}

function ncaSectionNodes(
	parentId: string,
	parsed: ParsedNca,
	ctx: ArchiveContext,
	tikMap?: TikMap,
): Node[] {
	// The NCA's structured header info is shown directly when the user
	// selects the NCA node in the tree (see `NcaPreview` in
	// `preview-pane.tsx`), so the children are just the real sections —
	// no synthetic `_nca-info.json` file.
	return parsed.sections.map((section) =>
		makeNcaSectionNode(parentId, parsed, section, ctx, tikMap),
	);
}

function makeNcaSectionNode(
	parentId: string,
	parsed: ParsedNca,
	section: NcaSection,
	ctx: ArchiveContext,
	_tikMap?: TikMap,
): Node {
	const sectionLabel =
		section.fsType === NCA_FS_TYPE_PFS0
			? `section${section.index} (PFS0)`
			: section.fsType === NCA_FS_TYPE_ROMFS
				? `section${section.index} (RomFS)`
				: `section${section.index} (unknown)`;

	const id = `${parentId}/${sectionLabel}`;

	// Try to expose the inner FS contents directly
	if (section.fsType === NCA_FS_TYPE_PFS0 && section.pfs0Data) {
		return makePfs0Node(id, sectionLabel, section.pfs0Data, ctx, 'PFS0 (NCA section)');
	}
	if (section.fsType === NCA_FS_TYPE_ROMFS && section.romfsData) {
		return makeRomfsNode(id, sectionLabel, section.romfsData, ctx);
	}

	// Fallback: just expose the raw decrypted section as a file
	return {
		id,
		name: sectionLabel,
		kind: 'file',
		isContainer: false,
		size: section.mediaEndOffset - section.mediaStartOffset,
		format: 'NCA section (raw)',
		blob: async () => section.data,
	};
}

// ----- NCZ -----

function makeNczNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	tikMap?: TikMap,
): Node {
	// We cache the decompressed NCA promise so multiple callers
	// (preview, getChildren, download) share a single zstd pass.
	// Concurrent `onProgress` subscribers all receive every event
	// produced after they subscribe.
	let cachedNca: Promise<Blob> | null = null;
	const subscribers = new Set<OnProgress>();
	let lastProgress: Parameters<OnProgress>[0] | null = null;

	const broadcast: OnProgress = (e) => {
		lastProgress = e;
		for (const fn of subscribers) {
			try {
				fn(e);
			} catch {
				// One bad subscriber shouldn't blow up the others.
			}
		}
	};

	const decompressOnce = (
		options?: { onProgress?: OnProgress },
	): Promise<Blob> => {
		if (options?.onProgress) {
			subscribers.add(options.onProgress);
			// Catch up newly-arrived subscribers with the last known
			// state (so the bar renders immediately without waiting
			// for the next event).
			if (lastProgress) options.onProgress(lastProgress);
		}
		if (!cachedNca) {
			cachedNca = decompressNczToBlob(blob, broadcast).finally(() => {
				subscribers.clear();
			});
		}
		return cachedNca;
	};

	return {
		id,
		name,
		kind: 'nca',
		isContainer: true,
		size: blob.size,
		format: 'NCZ',
		// Download yields the decompressed NCA. We propagate the
		// caller's onProgress through to the shared decompressor.
		blob: (options) => decompressOnce(options),
		meta: {
			ncaSource: {
				// The structured preview only needs the NCA header — and
				// per the NCZ spec, the first 0x4000 bytes of an NCZ are
				// the original NCA header verbatim. So we can serve the
				// preview straight off the compressed file without
				// triggering zstd decompression of the (possibly
				// multi-gigabyte) section bodies.
				getHeader: async () => blob.slice(0, NCZ_NCA_HEADER_BYTES),
				// `getBlob` returns the FULL decompressed NCA. Used by
				// `getChildren` and the download button. Cached, so we
				// only decompress once per session.
				getBlob: decompressOnce,
				ctx,
				tikMap,
			} satisfies NcaSource,
		},
		getChildren: async (options) => {
			const ncaBlob = await decompressOnce(options);
			const parsed = await parseNcaWithTik(ncaBlob, ctx, tikMap);
			if (parsed.missingKeyDetail) {
				throw new NcaKeyError(parsed.missingKeyDetail);
			}
			return ncaSectionNodes(id, parsed, ctx, tikMap);
		},
	};
}

async function decompressNczToBlob(
	blob: Blob,
	onProgress?: OnProgress,
): Promise<Blob> {
	if (!(await isNcz(blob))) {
		throw new Error('Not an NCZ file');
	}
	// Buffer the decompressed output through a TransformStream → Response → Blob.
	// This is still streaming under the hood (the writer applies backpressure)
	// but produces a real Blob the rest of the pipeline can use.
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const finish = new Response(readable).blob();
	await decompressNcz(blob, () => writable, {
		decompressBytes: zstdDecompressBytes,
		decompressStream: zstdDecompressStream,
		onProgress,
	});
	return finish;
}

// ----- RomFS -----

function makeRomfsNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'romfs',
		isContainer: true,
		size: blob.size,
		format: 'RomFS',
		blob: async () => blob,
		getChildren: async () => {
			const root = await romfsDecode(blob);
			return romfsEntriesToNodes(id, root, ctx);
		},
	};
}

/**
 * Detects whether a `RomFsEntry` value is a file (Blob-like) or a directory
 * (plain object).
 *
 * We can't use `instanceof Blob` here because the encrypted-NCA-section
 * adapter exposes lazy *Blob facades* — duck-typed objects that quack
 * like a `Blob` but aren't real `Blob` instances. The romfs decoder
 * happily slices through them and returns the same kind of object for
 * each file, so the resulting tree mixes real Blobs and facades. A
 * structural check covers both cases.
 */
function isBlobLike(value: unknown): value is Blob {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as Blob).arrayBuffer === 'function' &&
		typeof (value as Blob).slice === 'function' &&
		typeof (value as Blob).size === 'number'
	);
}

async function romfsEntriesToNodes(
	parentId: string,
	dir: RomFsEntry,
	ctx: ArchiveContext,
): Promise<Node[]> {
	const names = Object.keys(dir).sort((a, b) => {
		// Directories first, then files; natural-sort within each group.
		const aIsDir = !isBlobLike(dir[a]);
		const bIsDir = !isBlobLike(dir[b]);
		if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
		return humanCompare(a, b);
	});
	// Build sibling map so pair-aware formats (AWB ↔ ACB, .utoc ↔
	// .ucas) can look up companions lazily.
	const siblings = buildSiblingMap(
		names
			.filter((n) => isBlobLike(dir[n]))
			.map((n) => [n, dir[n] as Blob] as const),
	);
	// Resolve children in parallel — `childNodeFor` is sync object
	// construction for typical leaves, but for unknown extensions it
	// reads ~4 bytes to magic-sniff. RomFS file blobs are random-
	// access slices into the (already decrypted) source NCA section,
	// so the per-leaf cost is one AES-CTR block decrypt — fine.
	return Promise.all(
		names.map(async (name): Promise<Node> => {
			const value = dir[name];
			const id = `${parentId}/${name}`;
			if (isBlobLike(value)) {
				// IoStore: a `.utoc` is paired with a sibling `.ucas`
				// of the same base name; we resolve the pairing here
				// so the IoStore node can read inner files lazily.
				if (extOf(name) === 'utoc') {
					const base = name.slice(0, -'.utoc'.length);
					const sibling = dir[`${base}.ucas`];
					const ucasBlob = isBlobLike(sibling)
						? (sibling as Blob)
						: null;
					return makeIoStoreNode(id, name, value, ucasBlob, ctx);
				}
				// Route through childNodeFor so nested archives —
				// SARC, Yaz0+SARC under bizarre extensions like
				// `.sbfarc` / `.shksc` / `.sbactorpack`, ZIP, etc. —
				// become traversable instead of just downloadable.
				return childNodeFor(id, name, value, ctx, undefined, siblings);
			}
			return childDirectoryNodeFor({
				id,
				name,
				getChildren: async () =>
					romfsEntriesToNodes(id, value as RomFsEntry, ctx),
			});
		}),
	);
}

// ----- ZIP -----

function makeZipNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'zip',
		isContainer: true,
		size: blob.size,
		format: 'ZIP',
		blob: async () => blob,
		getChildren: async () => {
			const zip = await parseZip(blob);
			// Build a tikMap from any `.tik` entries anywhere in the
			// archive, so an NCA buried inside the ZIP can still
			// decrypt with its matching titlekey if a sibling
			// ticket is present (mirrors the NSP / HFS0 / directory
			// behaviour elsewhere). ZIP entry data is async, so we
			// resolve the .tik blobs eagerly here — there are
			// usually only one or two and they're tiny.
			const tikInputs = await Promise.all(
				zip.entries
					.filter(
						(e) =>
							!e.isDirectory &&
							e.name.toLowerCase().endsWith('.tik'),
					)
					.map(async (e) => [e.name, { data: await e.data() }] as const),
			);
			const tikMap = await buildTikMap(tikInputs);
			return zipEntriesToNodes(id, zip.entries, ctx, tikMap);
		},
	};
}

/**
 * Convert a flat list of ZIP entries into a hierarchical `Node` tree
 * by splitting on `/`. ZIP entries store full paths (`a/b/c.txt`)
 * with no separate directory records — though directory placeholder
 * entries (paths ending in `/`) do exist and we treat them as
 * empty-content directories.
 *
 * Mirrors the RomFS sort order: directories first, then files,
 * alphabetised within each group.
 */
async function zipEntriesToNodes(
	parentId: string,
	entries: ZipEntry[],
	ctx: ArchiveContext,
	tikMap: TikMap,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: ZipEntry }>;
	const root: Tree = new Map();
	for (const entry of entries) {
		const parts = entry.name.split('/').filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast && !entry.isDirectory) {
				node.file = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}

	const treeToNodes = async (
		treeId: string,
		t: Tree,
	): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			const aIsDir = !!t.get(a)!.dir;
			const bIsDir = !!t.get(b)!.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		// `childNodeFor` is sync object construction for typical
		// leaves; the actual blob read only happens when the user
		// expands or opens the inner node. So we can resolve the
		// whole tree level synchronously by wrapping each entry's
		// data in a lazy `Blob` facade — no inflation occurs until
		// something actually reads the bytes.
		return Promise.all(
			names.map(async (name): Promise<Node> => {
				const child = t.get(name)!;
				const childId = `${treeId}/${name}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return childDirectoryNodeFor({
						id: childId,
						name,
						getChildren: async () => subNodes,
					});
				}
				const file = child.file!;
				// Route through childNodeFor so nested formats
				// (NRO/NSP/NCA/SARC/LZ4/etc.) become traversable
				// inside the ZIP, exactly as they would be inside a
				// directory, NSP, or HFS0.
				return childNodeFor(
					childId,
					name,
					lazyBlobFromZip(file),
					ctx,
					tikMap,
				);
			}),
		);
	};

	return treeToNodes(parentId, root);
}

/**
 * Wrap a `ZipEntry` in a lazy `Blob` facade — synchronous `.size`,
 * lazy + memoised `.arrayBuffer()` / `.slice()`. The underlying
 * `entry.data()` only fires on first byte-level access, and the
 * inflated result is cached so repeated reads (e.g. from `.size`
 * of a slice + a separate `.arrayBuffer()`) don't re-inflate.
 *
 * For STORED entries the ZIP parser's `data()` already returns a
 * direct slice of the source blob — zero copy. For DEFLATE entries
 * this triggers a one-shot in-memory inflate.
 */
function lazyBlobFromZip(entry: ZipEntry): Blob {
	let cached: Promise<Blob> | null = null;
	const resolve = () => {
		if (!cached) cached = entry.data();
		return cached;
	};
	return makeLazyBlob(entry.size, resolve);
}

/**
 * Build a synchronous `Blob`-shaped facade backed by an async
 * resolver. The returned object reports `size` immediately and
 * forwards every other operation (`arrayBuffer`, `text`, `slice`,
 * `stream`) to the resolved real `Blob`.
 *
 * We use this whenever we want a `Blob`-typed value before we
 * actually have one — most prominently for ZIP entries (where
 * inflation is async) but also for any other deferred-data source.
 *
 * Note: `slice()` returns another lazy facade, so chained slices
 * still don't trigger resolution until something reads bytes.
 */
function makeLazyBlob(size: number, resolve: () => Promise<Blob>): Blob {
	const facade = {
		size,
		type: '',
		async arrayBuffer() {
			return (await resolve()).arrayBuffer();
		},
		async bytes() {
			const blob = await resolve();
			// Some browsers expose `Blob.prototype.bytes()`. Fall
			// back to arrayBuffer for the rest.
			return typeof (blob as Blob & { bytes?: () => Promise<Uint8Array> })
				.bytes === 'function'
				? (blob as Blob & { bytes: () => Promise<Uint8Array> }).bytes()
				: new Uint8Array(await blob.arrayBuffer());
		},
		async text() {
			return (await resolve()).text();
		},
		stream() {
			// Stream from the resolved blob. `ReadableStream` allows
			// async start, so this is just a thin pump.
			return new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						const blob = await resolve();
						const r = blob.stream().getReader();
						for (;;) {
							const { value, done } = await r.read();
							if (done) break;
							controller.enqueue(value);
						}
						controller.close();
					} catch (e) {
						controller.error(e);
					}
				},
			});
		},
		slice(start?: number, end?: number, contentType?: string) {
			// Chain lazily: the slice resolver awaits ours, then
			// slices the real blob. Slices remember their declared
			// size up-front so callers (e.g. NCA header readers)
			// can introspect it without forcing a read.
			const s = clampInt(start ?? 0);
			const e = clampInt(end ?? size);
			const lo = Math.min(Math.max(s < 0 ? size + s : s, 0), size);
			const hi = Math.min(Math.max(e < 0 ? size + e : e, lo), size);
			return makeLazyBlob(hi - lo, async () => {
				const blob = await resolve();
				return blob.slice(lo, hi, contentType);
			});
		},
	};
	// Pretend it's a Blob so consumers using `: Blob` types accept it.
	return facade as unknown as Blob;
}

function clampInt(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return n | 0;
}

// ----- SARC -----

function makeSarcNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'sarc',
		isContainer: true,
		size: blob.size,
		format: 'SARC',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseSarc(blob);
			return sarcEntriesToNodes(id, parsed.entries, ctx);
		},
	};
}

/**
 * Convert SARC entries (flat list of slash-delimited paths) into a
 * hierarchical `Node` tree. Same shape as the ZIP version above —
 * SARC names are also full paths, just without explicit directory
 * markers.
 */
async function sarcEntriesToNodes(
	parentId: string,
	entries: SarcEntry[],
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: SarcEntry }>;
	const root: Tree = new Map();
	for (const entry of entries) {
		const parts = entry.name.split('/').filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast) {
				node.file = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}

	const treeToNodes = async (
		treeId: string,
		t: Tree,
	): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			const aIsDir = !!t.get(a)!.dir;
			const bIsDir = !!t.get(b)!.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		return Promise.all(
			names.map(async (name): Promise<Node> => {
				const child = t.get(name)!;
				const childId = `${treeId}/${name}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return childDirectoryNodeFor({
						id: childId,
						name,
						getChildren: async () => subNodes,
					});
				}
				const file = child.file!;
				// Route through childNodeFor so nested NRO / SARC /
				// LZ4 / etc. become traversable inside the SARC.
				// SARC entries already are real Blob slices so the
				// data is genuinely lazy without any facade.
				return childNodeFor(childId, name, file.data, ctx);
			}),
		);
	};

	return treeToNodes(parentId, root);
}

// ----- idTech BFG `.resources` -----

/**
 * DOOM 3 BFG / RAGE / Wolfenstein TNO `.resources` archive.
 *
 * Flat list of full path entries (slash- or backslash-separated)
 * with uncompressed file bodies. We parse the header + table lazily
 * the first time the user expands the node, then route children
 * through `childNodeFor` so nested formats (e.g. `.bik` videos
 * inside DOOM 3 BFG) light up automatically.
 */
function makeIdTechResourcesNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'idtech-resources',
		isContainer: true,
		size: blob.size,
		format: 'idTech-Resources',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseIdTechResources(blob);
			return idTechResourcesEntriesToNodes(id, parsed.entries, ctx);
		},
	};
}

/**
 * Convert flat-path `.resources` entries into a hierarchical
 * `Node` tree, splitting on forward / backward slashes.
 * idTech's runtime normalises backslashes to forward slashes
 * (and lowercases for hash lookups) — we do the same when building
 * the tree so e.g. `materials\Adam.mtr` and `materials/Adam.mtr`
 * always end up in the same `materials/` directory.
 */
async function idTechResourcesEntriesToNodes(
	parentId: string,
	entries: IdTechResourceEntry[],
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: IdTechResourceEntry }>;
	const root: Tree = new Map();
	for (const entry of entries) {
		const parts = entry.name
			.replace(/\\/g, '/')
			.split('/')
			.filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast) {
				node.file = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}

	const treeToNodes = async (
		treeId: string,
		t: Tree,
	): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			const aIsDir = !!t.get(a)!.dir;
			const bIsDir = !!t.get(b)!.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		return Promise.all(
			names.map(async (name): Promise<Node> => {
				const child = t.get(name)!;
				const childId = `${treeId}/${name}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return childDirectoryNodeFor({
						id: childId,
						name,
						getChildren: async () => subNodes,
					});
				}
				const file = child.file!;
				// Route through childNodeFor so nested formats (.bik
				// videos, embedded SARCs, etc.) light up. The entry's
				// `data` is already a lazy Blob slice into the source.
				return childNodeFor(childId, name, file.data, ctx);
			}),
		);
	};

	return treeToNodes(parentId, root);
}

// ----- SZS / Yaz0 -----

/**
 * SZS = Yaz0-compressed SARC. We decompress lazily on first child
 * request, then expose the inner SARC's tree directly so the user
 * doesn't see a redundant `.szs → .sarc` indirection.
 *
 * Standalone (non-SARC) Yaz0 files also flow through here; in that
 * case `parseSarc` will throw and we fall back to a single-file
 * representation of the decompressed payload.
 */
function makeSzsNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	let cached: Promise<Blob> | null = null;
	const decompressOnce = () => {
		if (!cached) cached = decompressYaz0(blob);
		return cached;
	};
	return {
		id,
		name,
		kind: 'sarc',
		isContainer: true,
		size: blob.size,
		format: 'SZS (Yaz0+SARC)',
		// Downloading an SZS gives you the *decompressed* payload — that's
		// almost always what someone actually wants (e.g. drop into an
		// external SARC tool).
		blob: decompressOnce,
		getChildren: async () => {
			const inner = await decompressOnce();
			try {
				const parsed = await parseSarc(inner);
				return sarcEntriesToNodes(id, parsed.entries, ctx);
			} catch {
				// Standalone Yaz0 (no SARC inside) — route the
				// decompressed payload through `childNodeFor` so the
				// inner format (NRO / NSP / etc.) becomes traversable
				// even when wrapped in a bare Yaz0 stream.
				const innerName =
					name.replace(/\.szs$/i, '') || 'decompressed';
				return [
					await childNodeFor(
						`${id}/${innerName}`,
						innerName,
						inner,
						ctx,
					),
				];
			}
		},
	};
}

// ----- BARS (audio resource archive) -----

/**
 * Make a BARS container node. Each track inside becomes a leaf
 * named after its AMTA `STRG` block, with the appropriate
 * `.bfwav` / `.bfstp` extension so the format badge and any
 * downstream audio preview pick up on it. Tracks whose audio
 * payload is missing (common for "stub" archives that ship in
 * audio-resource directories) come through as empty
 * placeholders that surface the AMTA metadata via the structured
 * preview pane.
 */
function makeBarsNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'bars',
		isContainer: true,
		size: blob.size,
		format: 'BARS',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseBars(blob);
			return barsEntriesToNodes(id, parsed.entries, ctx);
		},
	};
}

async function barsEntriesToNodes(
	parentId: string,
	entries: BarsEntry[],
	ctx: ArchiveContext,
): Promise<Node[]> {
	const used = new Set<string>();
	return Promise.all(
		entries.map(async (e): Promise<Node> => {
			// Each track gets a name based on its AMTA STRG. Tracks
			// without an audio payload still show up so the user can
			// see the metadata; we just give them a deterministic
			// `track_NN` fallback. Use the canonical `.bfwav` /
			// `.bfstp` extensions (not `.fwav` / `.fstp`) so the
			// preview pane's audio detection picks them up.
			const baseName = e.name || `track_${e.index.toString().padStart(3, '0')}`;
			const ext =
				e.audioKind === 'fwav'
					? 'bfwav'
					: e.audioKind === 'fstp'
						? 'bfstp'
						: 'bin';
			let leaf = `${baseName}.${ext}`;
			// Real BARS archives occasionally have duplicate track
			// names (rare but it happens with auto-generated stubs);
			// disambiguate by suffixing the index so the React tree's
			// id-based keying stays stable.
			if (used.has(leaf)) leaf = `${baseName}_${e.index}.${ext}`;
			used.add(leaf);
			const childId = `${parentId}/${leaf}`;
			if (e.audio) {
				return childNodeFor(childId, leaf, e.audio, ctx);
			}
			// No audio payload: show the AMTA metadata as a leaf with
			// a synthetic 0-byte blob. The BARS-track preview pane
			// reads `node.meta.barsEntry` to render the AMTA fields.
			return {
				id: childId,
				name: leaf,
				kind: 'file',
				isContainer: false,
				size: 0,
				format: 'BARS-stub',
				meta: { barsEntry: e },
				blob: async () => new Blob([]),
			};
		}),
	);
}

// ----- AWB (CRI AFS2 audio wave bank) -----

/**
 * Map from lowercase basename → blob for a set of siblings at one
 * directory level. Passed through {@link childNodeFor} so formats
 * that benefit from sibling metadata (today: AWB looking for an
 * ACB) can find their pair lazily. Names are stored lowercase to
 * make matches case-insensitive on case-sensitive filesystems.
 */
type SiblingMap = Map<string, Blob>;

/**
 * Build a {@link SiblingMap} from a list of `(name, blob)` pairs.
 * Names are lowercased; duplicate keys keep the first-seen blob.
 */
function buildSiblingMap(entries: Iterable<readonly [string, Blob]>): SiblingMap {
	const out: SiblingMap = new Map();
	for (const [name, blob] of entries) {
		const key = name.toLowerCase();
		if (!out.has(key)) out.set(key, blob);
	}
	return out;
}

/**
 * Sibling-lookup callback for {@link makeAwbNode}. When the AWB is
 * being created from a directory or container that can locate
 * additional files by name, the parent supplies this so the AWB
 * node can find its companion `.acb` lazily (and only when the
 * user actually expands the bank). The implementation should match
 * `basename` case-insensitively and resolve to `null` when no such
 * sibling exists.
 *
 * Defaults to a no-op when omitted, which means AWB tracks fall
 * back to the `track_NNN.hca` naming convention.
 */
export type AwbSiblingResolver = (basename: string) => Promise<Blob | null>;

/** Wrap a {@link SiblingMap} into an {@link AwbSiblingResolver}. */
function siblingsToAwbResolver(
	siblings: SiblingMap | undefined,
): AwbSiblingResolver | undefined {
	if (!siblings) return undefined;
	return async (basename: string) => siblings.get(basename.toLowerCase()) ?? null;
}

/**
 * Make an AWB / AFS2 container node. The archive holds many
 * HCA-encoded audio tracks indexed by a small `(id, offset, size)`
 * table at the head of the file. Each track becomes a child Node
 * named after its cue (when an ACB companion is available) or
 * `track_NNN.hca` otherwise — so they show up in the tree just like
 * the contents of any other container.
 *
 * **ACB lookup**: when a `siblingResolver` is supplied, the AWB
 * node will look up a companion `.acb` with the same basename when
 * its `getChildren()` is first called. The ACB's `CueNameTable`
 * provides the human-readable cue names; tracks not referenced by
 * any cue keep the generic `track_NNN.hca` fallback. The lookup is
 * fully optional and failure-tolerant: if the resolver returns
 * `null`, throws, or the bytes don't parse as ACB, we silently fall
 * back to generic names. No errors surface in the tree.
 *
 * The parent's per-bank HCA subkey is threaded into each child's
 * `meta.awbSubkey` so the HCA preview can derive the type-56
 * cipher tables when the bank is encrypted and a per-file key is
 * supplied.
 *
 * Tracks are extracted lazily via `Blob.slice()` — even for banks
 * with hundreds of tracks, the only eager work is parsing the AFS2
 * header (a few KiB) and optionally the ACB header.
 */
function makeAwbNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	siblingResolver?: AwbSiblingResolver,
): Node {
	return {
		id,
		name,
		kind: 'awb',
		isContainer: true,
		size: blob.size,
		format: 'AWB',
		blob: async () => blob,
		getChildren: async () => {
			// Header is small; 64 KiB is more than enough for any
			// bank we've seen. If a future bank has a massive id/offset
			// table the parser will throw a clear error and we can
			// grow this.
			const headLen = Math.min(blob.size, 0x10000);
			const head = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
			const parsed = parseAwb(head);
			void ctx; // reserved for future tikMap-style propagation

			// Optional ACB sibling lookup. `<name>.awb` → `<name>.acb`.
			// We strip the extension case-insensitively and prefer the
			// dot-stripped form; the resolver itself decides how to
			// match (some directory layouts are case-sensitive).
			const baseName = name.replace(/\.awb$/i, '');
			let cueNames: Map<number, string> | null = null;
			if (siblingResolver) {
				try {
					const acbBlob = await siblingResolver(`${baseName}.acb`);
					if (acbBlob) {
						const acbBytes = new Uint8Array(await acbBlob.arrayBuffer());
						const acb = parseAcb(acbBytes);
						// Memory cues point at the embedded AwbFile;
						// stream cues point at our AWB. We use stream
						// port 0 (the standard layout — single companion
						// per ACB) which matches the vast majority of
						// in-the-wild banks. When that yields nothing
						// (memory-only ACB), fall back to the memory map.
						const stream = cueNamesForAwb(acb, CueWaveformSource.Stream, 0);
						cueNames = stream.size > 0
							? stream
							: cueNamesForAwb(acb, CueWaveformSource.Memory);
					}
				} catch {
					// Soft-fall-back to generic names; logging would
					// be noisy for every loose AWB.
					cueNames = null;
				}
			}

			const width = Math.max(3, String(parsed.tracks.length).length);
			const used = new Set<string>();
			return parsed.tracks.map((t, i): Node => {
				const cueName = cueNames?.get(t.id);
				let leafName: string;
				if (cueName) {
					// Sanitize for the filesystem: replace anything
					// that's not [A-Za-z0-9._-] with `_`. ACB cue names
					// in the wild are mostly ASCII; defensive anyway.
					const safe = cueName.replace(/[^A-Za-z0-9._-]/g, '_');
					leafName = `${safe}.hca`;
					// Disambiguate if the sanitization collapses two
					// distinct cues to the same name.
					if (used.has(leafName)) {
						leafName = `${safe}_${i}.hca`;
					}
				} else {
					leafName = `track_${String(i).padStart(width, '0')}.hca`;
				}
				used.add(leafName);
				const childId = `${id}/${leafName}`;
				const trackBlob = blob.slice(t.offset, t.offset + t.size);
				return {
					id: childId,
					name: leafName,
					kind: 'file',
					isContainer: false,
					size: t.size,
					format: 'HCA',
					meta: {
						awbTrackId: t.id,
						awbSubkey: parsed.subkey,
						awbCueName: cueName ?? null,
					},
					blob: async () => trackBlob,
				};
			});
		},
	};
}

// ----- ACB (CRI Audio Cue Binary) -----

/**
 * Make an ACB container node. An ACB is a cue manifest that maps
 * human-readable cue names (`BGM_TitleScreen`, `SE_Footstep_Wood`)
 * to one or more audio tracks living in either:
 *
 *   - The ACB's own *embedded* AWB (memory cues — small SFX banks);
 *   - An external *streamed* AWB sibling file (typically `<name>.awb`).
 *
 * Tree shape:
 *
 *   <name>.acb/
 *     ├─ memory/
 *     │    ├─ BGM_Boss_Theme.hca       ← decoded from embedded AwbFile
 *     │    └─ …
 *     └─ stream/
 *          ├─ → <sibling0>.awb         ← jump-target leaves
 *          └─ …
 *
 * Stream-AWB references render as `<name>.awb` leaves whose blob() is
 * the sibling file's bytes — when the actual `.awb` is in the same
 * dir, this means clicking either the `.acb` node OR the sibling
 * `.awb` opens the same tracks. (Memory cues live only here.)
 */
function makeAcbNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	siblings: SiblingMap | undefined,
): Node {
	return {
		id,
		name,
		kind: 'acb',
		isContainer: true,
		size: blob.size,
		format: 'ACB',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const acb = parseAcb(bytes);
			const children: Node[] = [];

			// Memory cues: embedded AwbFile in the ACB itself.
			if (acb.embeddedAwb && acb.embeddedAwb.byteLength > 0) {
				// Copy into a fresh ArrayBuffer to satisfy `Blob`'s
				// type signature (the parsed view's underlying buffer
				// is `ArrayBufferLike`, which may be a SharedArrayBuffer).
				const copy = new Uint8Array(acb.embeddedAwb.byteLength);
				copy.set(acb.embeddedAwb);
				const memoryAwbBlob = new Blob([copy.buffer]);
				const memoryId = `${id}/memory.awb`;
				children.push(
					makeAwbNode(memoryId, 'memory.awb', memoryAwbBlob, ctx, async (lookupName) => {
						// The embedded-AWB node would normally look for a
						// sibling `.acb`. Short-circuit: the ACB IS this
						// node's parent, so we already know the cue mapping
						// without re-parsing. The siblingResolver only fires
						// for the `.acb` filename lookup, so it's safe to
						// return our own bytes.
						if (lookupName.toLowerCase().endsWith('.acb')) return blob;
						return null;
					}),
				);
			}

			// Stream cues: each `streamAwbs` entry refers to a sibling
			// `.awb` file by name. Resolve via the sibling map (loose-
			// directory / RomFS), surface as a child AWB so the user
			// can open it in-tree.
			const seenStream = new Set<string>();
			for (const stream of acb.streamAwbs) {
				if (!stream.name || seenStream.has(stream.name.toLowerCase())) continue;
				seenStream.add(stream.name.toLowerCase());
				const awbName = `${stream.name}.awb`;
				const childId = `${id}/${awbName}`;
				const siblingBlob = siblings ? siblings.get(awbName.toLowerCase()) : undefined;
				if (siblingBlob) {
					children.push(
						makeAwbNode(childId, awbName, siblingBlob, ctx, async (lookupName) => {
							// Same self-resolution as the memory case.
							if (lookupName.toLowerCase().endsWith('.acb')) return blob;
							return null;
						}),
					);
				} else {
					// Sibling not present in the archive we have access
					// to — surface as an informational placeholder so
					// the user can see the cue refers to an external file.
					children.push({
						id: childId,
						name: awbName,
						kind: 'file',
						isContainer: false,
						size: 0,
						format: 'EXTERNAL',
						blob: async () => new Blob(),
						meta: {
							acbStreamPort: acb.streamAwbs.indexOf(stream),
							missing: true,
						},
					});
				}
			}

			return children;
		},
	};
}

// ----- BFSAR (Binary caFe Sound ARchive) -----

/**
 * Make a BFSAR container node. The archive contains a flat list of
 * named internal files (BFSTM / BFWAV / BFSTP / BFWAR / BFBNK /
 * BFSEQ / BFGRP / BFWSD) plus references to external files that
 * live elsewhere on disc. Each internal file becomes a leaf in the
 * tree, named after its STRG-table entry; external files become
 * non-clickable info-only leaves marked `EXTERNAL`.
 */
function makeBfsarNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'bfsar',
		isContainer: true,
		size: blob.size,
		format: 'BFSAR',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseBfsar(blob);
			const used = new Set<string>();
			const internals: Node[] = await Promise.all(
				parsed.internalFiles.map(async (f): Promise<Node> => {
					const ext = f.innerExt;
					let leaf = `${f.name}.${ext}`;
					if (used.has(leaf)) leaf = `${f.name}_${f.index}.${ext}`;
					used.add(leaf);
					const childId = `${id}/${leaf}`;
					if (f.location === 'inline' && f.data) {
						return childNodeFor(childId, leaf, f.data, ctx);
					}
					// In-group file: we don't recurse into the FGRP
					// payload yet, so expose it as an info-only leaf.
					return {
						id: childId,
						name: leaf,
						kind: 'file',
						isContainer: false,
						size: 0,
						format: 'BFSAR-group',
						meta: { bfsarFile: f },
						blob: async () => new Blob([]),
					};
				}),
			);
			const externals: Node[] = parsed.externalFiles.map((f): Node => {
				const leaf = `${f.name} (external)`;
				return {
					id: `${id}/external-${f.index}-${leaf}`,
					name: leaf,
					kind: 'file',
					isContainer: false,
					size: 0,
					format: 'EXTERNAL',
					meta: { bfsarExternal: f },
					blob: async () => new Blob([]),
				};
			});
			return [...internals, ...externals];
		},
	};
}

// ----- BFWAR (wave archive) -----

/**
 * Make a BFWAR container node. Each inline FWAV becomes a leaf;
 * since BFWAR doesn't store names, leaves are numbered
 * `wave_NNN.bfwav` so the BFWAV preview & audio player still pick
 * them up via the `.bfwav` extension.
 */
function makeBfwarNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'bfwar',
		isContainer: true,
		size: blob.size,
		format: 'BFWAR',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseBfwar(blob);
			return Promise.all(
				parsed.entries.map(async (e): Promise<Node> => {
					const ext = e.innerMagic === 'FWAV' ? 'bfwav' : 'bin';
					const leaf = `wave_${e.index.toString().padStart(3, '0')}.${ext}`;
					const childId = `${id}/${leaf}`;
					if (e.size === 0) {
						return {
							id: childId,
							name: leaf,
							kind: 'file',
							isContainer: false,
							size: 0,
							format: 'EMPTY',
							blob: async () => new Blob([]),
						};
					}
					return childNodeFor(childId, leaf, e.data, ctx);
				}),
			);
		},
	};
}

// ----- BFRES (Nintendo 3D resource) -----

/**
 * Make a BFRES container node. The structured preview pane reads
 * the parsed metadata directly via {@link parseBfresForView}; the
 * children we expose here are the *external* files — typically
 * just `textures.bntx`, but occasionally a `*.bfsha` shader bank
 * — which the user can drill into for actual content (the BNTX
 * preview decodes textures, the shader bank is opaque).
 */
function makeBfresNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'bfres',
		isContainer: true,
		size: blob.size,
		format: 'BFRES',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseBfres(blob);
			return Promise.all(
				parsed.externalFiles.map(async (e): Promise<Node> => {
					const leaf = e.name || `external_${e.offset.toString(16)}`;
					const childId = `${id}/${leaf}`;
					if (e.size === 0) {
						return {
							id: childId,
							name: leaf,
							kind: 'file',
							isContainer: false,
							size: 0,
							format: 'EMPTY',
							blob: async () => new Blob([]),
						};
					}
					return childNodeFor(childId, leaf, e.data, ctx);
				}),
			);
		},
	};
}

// ----- GFPAK (Game Freak archive) -----

/**
 * Make a GFPAK container node. Each entry inside the GFPAK
 * becomes a leaf in the tree; we synthesize a name that combines
 * the entry's embedded name (when available, for BNTX / BFRES
 * containers that store their own filename) with its sniffed
 * inner-file extension (`bntx`, `bfres`, `byaml`, …) so the
 * downstream previews pick them up automatically.
 *
 * Oodle-compressed entries (the default in newer Game Freak titles)
 * surface as info-only leaves with the original 0-byte blob; the
 * user gets a friendly error if they click "Download" because the
 * extractor throws. LZ4 / uncompressed entries extract cleanly.
 */
function makeGfpakNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'gfpak',
		isContainer: true,
		size: blob.size,
		format: 'GFPAK',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseGfpak(blob);
			const used = new Set<string>();
			return Promise.all(
				parsed.entries.map(async (e): Promise<Node> => {
					const baseName =
						e.embeddedName ||
						`0x${e.pathHash.toString(16).padStart(16, '0')}`;
					let leaf = `${baseName}.${e.innerExt}`;
					if (used.has(leaf)) leaf = `${baseName}_${e.index}.${e.innerExt}`;
					used.add(leaf);
					const childId = `${id}/${leaf}`;
					// Lazy: only call `getData()` on demand. childNodeFor
					// expects a Blob, so wrap in a deferred-decompress
					// proxy that materialises bytes when first read.
					const lazyBlob = new LazyDecompressBlob(() => e.getData());
					return childNodeFor(childId, leaf, lazyBlob, ctx);
				}),
			);
		},
	};
}

// ----- Wwise (.pck AKPK / .bnk SoundBank) -----

/**
 * Make a Wwise `.pck` (AKPK) container node. The PCK is a flat
 * package of streamed WEMs — each entry has a Wwise FNV-hashed id
 * (the original asset name isn't stored) plus a language index.
 *
 * We synthesize a `wem_<id>.wem` leaf name per entry; the WEM
 * preview decodes it (PCM → WAV, Switch-Opus → Ogg-Opus) for
 * in-browser playback.
 */
function makeWwisePckNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'wwise-pck',
		isContainer: true,
		size: blob.size,
		format: 'AKPK',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseAkpk(blob);
			const all: Node[] = [];
			// Soundbanks first (they expand into more children themselves)…
			for (const sb of parsed.soundbanks) {
				const leaf = `bank_${sb.id.toString(16).padStart(8, '0')}.bnk`;
				const childId = `${id}/${leaf}`;
				all.push(await childNodeFor(childId, leaf, sb.data, ctx));
			}
			// …then streamed WEMs.
			for (const w of parsed.streamedFiles) {
				const langSuffix =
					parsed.languageMap[w.languageIndex]?.name &&
					parsed.languageMap[w.languageIndex].name !== 'sfx'
						? `__${parsed.languageMap[w.languageIndex].name}`
						: '';
				const leaf = `wem_${w.id.toString(16).padStart(8, '0')}${langSuffix}.wem`;
				const childId = `${id}/${leaf}`;
				all.push({
					id: childId,
					name: leaf,
					kind: 'file',
					isContainer: false,
					size: w.size,
					format: 'WEM',
					blob: async () => w.data,
				});
			}
			return all;
		},
	};
}

/**
 * Make a Wwise `.bnk` SoundBank container node. The bank's DIDX +
 * DATA chunks list embedded WEMs that we expose as children; the
 * structured preview (rendered separately) shows the BKHD header
 * + chunk table, including HIRC size for power users.
 */
function makeWwiseBnkNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'wwise-bnk',
		isContainer: true,
		size: blob.size,
		format: 'BNK',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseBnk(blob);
			return parsed.wems.map((w): Node => {
				const leaf = `wem_${w.id.toString(16).padStart(8, '0')}.wem`;
				const childId = `${id}/${leaf}`;
				return {
					id: childId,
					name: leaf,
					kind: 'file',
					isContainer: false,
					size: w.size,
					format: 'WEM',
					blob: async () => w.data,
				};
			});
		},
	};
}

// ----- FMOD Studio bank (.bank with "FEV " form-type) -----

/**
 * Make an FMOD Studio `.bank` container node. The bank's metadata
 * tree (`PROJ` LIST with `EVTS`, `WAIS`, `BSSL`, etc.) is hidden
 * behind the scenes; we only expose the actual audio samples
 * (extracted from the embedded FSB5 inside the SND chunk).
 *
 * Encrypted banks auto-detect the right key from a built-in list
 * of ~50 known per-game keys. Banks with unknown keys surface a
 * single "encrypted (key not in built-in list)" placeholder leaf
 * — the user can still download the raw bank.
 */
function makeFmodBankNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'fmod-bank',
		isContainer: true,
		size: blob.size,
		format: 'BANK',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseFmodBank(blob);
			const extracted: Fsb5ExtractResult | null = await extractFsb5FromBank(parsed, blob);
			if (!extracted) {
				// No SND chunk — Master.bank / Master.strings.bank-like
				// metadata-only banks. Show no children.
				return [];
			}
			if (!extracted.fsb5) {
				// Encrypted with unknown key. Surface a single placeholder
				// leaf with a friendly message.
				return [
					{
						id: `${id}/__encrypted__`,
						name: '⚠︎ encrypted (no matching key)',
						kind: 'file',
						isContainer: false,
						size: 0,
						format: 'BIN',
						blob: async () => new Blob([]),
					},
				];
			}
			// Got plaintext FSB5 → parse and surface each sample as a leaf.
			const fsb5 = parseFsb5(extracted.fsb5);
			const ext =
				fsb5.header.mode === 15 // VORBIS
					? 'ogg'
					: fsb5.header.mode === 11 // MPEG
						? 'mp3'
						: 'wav';
			return fsb5.samples.map((s): Node => {
				const safeName = (s.name || `sample_${s.index}`)
					.replace(/[^a-zA-Z0-9._-]/g, '_');
				const leaf = `${safeName}.${ext}`;
				const childId = `${id}/${leaf}`;
				// We surface the per-sample raw payload bytes via blob().
				// The preview will re-parse the bank on click to actually
				// decode (PCM/ADPCM → WAV, Vorbis → Ogg). For "Download"
				// we give the bytes verbatim too — most useful as a
				// reference for offline tools (vgmstream / fsbtool / etc).
				return {
					id: childId,
					name: leaf,
					kind: 'file',
					isContainer: false,
					size: s.data.length,
					format: fsb5.header.modeName,
					blob: async () => new Blob([s.data as unknown as BlobPart]),
					meta: {
						fmodBankBlob: blob,
						fmodSampleIndex: s.index,
					},
				};
			});
		},
	};
}

/**
 * A `Blob`-shaped facade that lazily materialises its bytes on
 * first read (or first slice). Used for GFPAK entries where the
 * actual decompression is expensive and we'd rather not run it
 * just to populate a tree node — many users will browse the GFPAK
 * without ever clicking into individual files.
 *
 * Internally, `arrayBuffer()` triggers the underlying decoder
 * and caches the result. Subsequent calls return the same buffer.
 */
class LazyDecompressBlob extends Blob {
	private _decoder: () => Promise<Blob>;
	private _cached: Promise<ArrayBuffer> | null = null;
	// We declare a fake "size" up front since callers (the
	// preview pane, the file tree) read `size` synchronously to
	// label entries. We surface 0 — the entry's true size becomes
	// known only after decompression. Most Game Freak GFPAKs are
	// already opaque enough that this is fine UX.
	constructor(decoder: () => Promise<Blob>) {
		super([]);
		this._decoder = decoder;
	}
	override async arrayBuffer(): Promise<ArrayBuffer> {
		if (!this._cached) {
			this._cached = this._decoder().then((b) => b.arrayBuffer());
		}
		return this._cached;
	}
	override slice(start = 0, end?: number): Blob {
		// `slice()` is used by magic-sniffing code and by leaf-blob
		// downloaders. We materialise the whole thing and slice
		// synthetically; once the cache is warm this is cheap.
		const promise = this.arrayBuffer().then((buf) => {
			const u8 = new Uint8Array(buf);
			const sliced = u8.subarray(start, end ?? u8.byteLength);
			return new Blob([sliced as BlobPart]);
		});
		// Return a Blob facade backed by `promise`. Recursive use of
		// LazyDecompressBlob keeps things uniform.
		return new LazyDecompressBlob(async () => promise);
	}
}

// ----- LZ4 -----

/**
 * `.lz4`-wrapped files appear in the tree as a single-child container
 * whose child is the inner (decompressed) file. We re-route the
 * decompressed blob through `childNodeFor`, so wrapping is fully
 * transparent: a `cairo_wkc.nro.lz4` shows up as an expandable NRO
 * node with `main.nro` / `icon.jpg` / `control.nacp` / `romfs/`
 * children, exactly as if you'd downloaded the inner NRO directly.
 *
 * Decompression is lazy + memoised — we only invoke the LZ4 decoder
 * when the user expands or downloads the node, and we only do it
 * once per session.
 *
 * Auto-detects all three LZ4 variants (standard frame, legacy frame,
 * Switch firmware wrapper) since the file extension alone doesn't
 * tell us which Nintendo team built the file.
 */
/**
 * Lazy Zstandard-decompressed wrapper. Mirrors `makeLz4Node`:
 * the decompression is deferred until the user opens or reads the
 * file (which is what we want — TotK contains 224k `.zs` files and
 * decompressing them all eagerly would be hostile).
 *
 * Naming: we strip the trailing `.zs` / `.zst` suffix so the inner
 * `childNodeFor()` can dispatch on whatever extension was left
 * behind. `FileEntry.byml.zs` → `FileEntry.byml` → BYAML preview;
 * `Cuepoint.zst` → `Cuepoint` → magic-sniff fallthrough.
 *
 * Cache: the decompressed payload is held for the lifetime of the
 * node (typical TotK .zs files are < 1 MB each). For the rare large
 * cases, GC reclaims when the node is dropped on tree-collapse.
 */
function makeZstdNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	let cached: Promise<Blob> | null = null;
	const decompressOnce = (): Promise<Blob> => {
		if (!cached) {
			cached = (async () => {
				const compressed = new Uint8Array(await blob.arrayBuffer());
				const decompressed = await zstdDecompressBytes(compressed);
				return new Blob([decompressed.buffer as ArrayBuffer]);
			})();
		}
		return cached;
	};
	// Strip a trailing `.zs` or `.zst` so the inner node has a sensible
	// name for format-detection (`FileEntry.byml.zs` → `FileEntry.byml`).
	const innerName = name.replace(/\.zst?$/i, '') || 'decompressed';
	return {
		id,
		name,
		kind: 'zstd',
		isContainer: true,
		size: blob.size,
		format: 'ZSTD',
		blob: async () => decompressOnce(),
		getChildren: async () => {
			const data = await decompressOnce();
			return [
				await childNodeFor(`${id}/${innerName}`, innerName, data, ctx),
			];
		},
	};
}

function makeLz4Node(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	let cached: Promise<{ data: Blob; variant: Lz4Variant }> | null = null;
	const decompressOnce = () => {
		if (!cached) cached = decompressLz4(blob);
		return cached;
	};
	// Strip the `.lz4` suffix so the inner node gets a sensible name
	// for format-detection purposes (`cairo_wkc.nro.lz4` → `cairo_wkc.nro`).
	const innerName = name.replace(/\.lz4$/i, '') || 'decompressed';
	return {
		id,
		name,
		kind: 'lz4',
		isContainer: true,
		size: blob.size,
		format: 'LZ4',
		// Downloading the LZ4 node yields the *decompressed* payload,
		// matching the SZS convention.
		blob: async () => (await decompressOnce()).data,
		getChildren: async () => {
			const { data } = await decompressOnce();
			return [
				await childNodeFor(`${id}/${innerName}`, innerName, data, ctx),
			];
		},
	};
}

// ----- IoStore (Unreal Engine 4/5 .utoc + .ucas) -----

/**
 * Build a tree node for an Unreal Engine IoStore container. The
 * directory index lives in the `.utoc`; the actual file payload
 * lives in the matching `.ucas` (which we may or may not have on
 * hand). We list the inner files based on the `.utoc` alone — that
 * unlocks browsing without paying the cost of reading the (often
 * multi-GB) `.ucas`. Inner-file `blob()` getters either pull bytes
 * from `.ucas` (if a sibling resolver supplied one) or surface a
 * "needs companion .ucas" error.
 *
 * Decompression of the inner blocks is intentionally NOT
 * implemented: the bulk of UE games on Switch use Oodle, which has
 * no open-source decoder. Block-mode `None` (uncompressed) blocks
 * pass through fine; `Zlib` blocks could be added later.
 */
function makeIoStoreNode(
	id: string,
	name: string,
	utocBlob: Blob,
	ucasBlob: Blob | null,
	ctx: ArchiveContext,
): Node {
	let parsed: Promise<IoStoreToc> | null = null;
	const parse = (): Promise<IoStoreToc> => {
		if (!parsed) parsed = parseIoStoreToc(utocBlob);
		return parsed;
	};
	return {
		id,
		name,
		kind: 'iostore',
		isContainer: true,
		size: utocBlob.size,
		format: 'UE-TOC',
		blob: async () => utocBlob,
		getChildren: async () => {
			const toc = await parse();
			return ioStoreEntriesToNodes(id, toc, ucasBlob, ctx);
		},
	};
}

/**
 * Convert an IoStore TOC's flat path → entry map into a nested
 * tree of Node objects, mirroring how RomFS / SARC / ZIP
 * directory trees are built. Inner files become leaves whose
 * `blob()` reads the corresponding chunk from the `.ucas` if
 * available — or throws a descriptive error if not.
 */
async function ioStoreEntriesToNodes(
	parentId: string,
	toc: IoStoreToc,
	ucasBlob: Blob | null,
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: IoChunkEntry }>;
	const root: Tree = new Map();
	for (const entry of toc.entries.values()) {
		const parts = entry.path.split('/').filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast) {
				node.file = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}

	const treeToNodes = async (
		treeId: string,
		t: Tree,
	): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			const aIsDir = !!t.get(a)!.dir;
			const bIsDir = !!t.get(b)!.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		return Promise.all(
			names.map(async (n): Promise<Node> => {
				const child = t.get(n)!;
				const childId = `${treeId}/${n}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return childDirectoryNodeFor({
						id: childId,
						name: n,
						getChildren: async () => subNodes,
					});
				}
				const file = child.file!;
				return makeIoStoreLeaf(childId, n, file, toc, ucasBlob, ctx);
			}),
		);
	};

	return treeToNodes(parentId, root);
}

/**
 * Leaf node for a single file inside an IoStore container. The
 * `blob()` getter reconstructs the file's bytes by reading the
 * relevant compression blocks from the `.ucas` and (for now) only
 * supports the `None` compression method — i.e. blocks the build
 * tool chose not to compress. Any block that uses a compression
 * method (Oodle, Zlib, Gzip, Zstd, …) yields an "unsupported"
 * error so users can still see the file in the tree even if its
 * bytes aren't accessible.
 */
function makeIoStoreLeaf(
	id: string,
	name: string,
	entry: IoChunkEntry,
	toc: IoStoreToc,
	ucasBlob: Blob | null,
	ctx: ArchiveContext,
): Node {
	const ext = extOf(name);
	const format = detectFormat(name) || ext.toUpperCase() || 'BIN';
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: Number(entry.length),
		format,
		blob: async () => {
			if (!ucasBlob) {
				throw new Error(
					`Reading IoStore entries requires the matching ".ucas" file alongside this ".utoc". Open the parent directory to make both files available.`,
				);
			}
			return readIoStoreChunk(toc, ucasBlob, entry, ctx);
		},
	};
}

/**
 * Reconstruct an IoStore entry's bytes by stitching together the
 * compression blocks that cover its `[offset, offset + length)`
 * range.
 *
 * Each block's compression method is checked at read time:
 *
 *   - `None` (or method index 0): the block is copied verbatim.
 *   - `Oodle`/`Kraken`/`Mermaid`/`Selkie`/`Leviathan`/`Hydra`: the
 *     block is dispatched to the host's Oodle decompressor. When
 *     the host hasn't supplied one (the user hasn't uploaded an
 *     `oodle.wasm`), we throw {@link OodleMissingError} — the
 *     preview pane catches that and shows a prompt.
 *   - Anything else (Zlib, etc.): unsupported, throws a
 *     descriptive error.
 */
async function readIoStoreChunk(
	toc: IoStoreToc,
	ucasBlob: Blob,
	entry: IoChunkEntry,
	ctx: ArchiveContext,
): Promise<Blob> {
	const blockSize = BigInt(toc.header.compressionBlockSize);
	const fullBlockSize = toc.header.compressionBlockSize;
	const firstBlock = Number(entry.offset / blockSize);
	const offsetInFirstBlock = Number(entry.offset % blockSize);
	const lastBlockExclusive = Number(
		(entry.offset + entry.length + blockSize - 1n) / blockSize,
	);
	const totalLength = Number(entry.length);

	const out = new Uint8Array(totalLength);
	let written = 0;
	let skip = offsetInFirstBlock;
	let oodleDecompress: OodleDecompress | null | undefined;
	for (let i = firstBlock; i < lastBlockExclusive; i++) {
		const b = toc.compressionBlocks[i];
		const methodName =
			b.compressionMethodIndex === 0
				? 'None'
				: toc.compressionMethods[b.compressionMethodIndex];
		const blockStart = Number(b.offset);
		const blockEnd = blockStart + b.compressedSize;
		const rawSlice = new Uint8Array(
			await ucasBlob.slice(blockStart, blockEnd).arrayBuffer(),
		);
		let decoded: Uint8Array;
		if (methodName === 'None' || b.compressionMethodIndex === 0) {
			decoded = rawSlice;
		} else if (isOodleMethodName(methodName)) {
			if (oodleDecompress === undefined) {
				oodleDecompress = ctx.getOodleDecompressor?.() ?? null;
			}
			if (!oodleDecompress) {
				ctx.requestOodle?.();
				throw new OodleMissingError(
					`IoStore block #${i} uses ${methodName} compression; upload an oodle.wasm to decode it.`,
				);
			}
			// Each block's decompressed size is either `fullBlockSize`
			// or the entry's remainder for the last block.
			decoded = await oodleDecompress(rawSlice, b.uncompressedSize);
		} else {
			throw new Error(
				`IoStore block #${i} uses unsupported compression "${methodName}". ` +
					`Only "None" and Oodle are supported.`,
			);
		}
		const take = Math.min(decoded.length - skip, totalLength - written);
		out.set(decoded.subarray(skip, skip + take), written);
		written += take;
		skip = 0;
	}
	if (written !== totalLength) {
		throw new Error(
			`IoStore reconstruction short: expected ${totalLength} bytes, got ${written}`,
		);
	}
	void fullBlockSize;
	return new Blob([out]);
}

/**
 * Returns true if `name` matches any of the Oodle compressor names
 * UE writes into PAK / IoStore compression-method slots. UE's tools
 * often write the generic name "Oodle" but some pipelines split out
 * the variant names directly.
 */
function isOodleMethodName(name: string | undefined): boolean {
	if (!name) return false;
	return /^(?:oodle|kraken|mermaid|selkie|leviathan|hydra)$/i.test(name);
}

// ----- UE PAK (Unreal Engine archive) -----

/**
 * `.pak` is the legacy monolithic Unreal Engine asset container
 * (UE3 → UE5). Distinct from the `.utoc`/`.ucas` IoStore format
 * we already support — both ship UE assets but with very
 * different layouts. PAKs are still common alongside IoStore for
 * content that doesn't fit the IoStore model (and remained the
 * only option in earlier UE versions).
 *
 * We expose every inner file as a lazy `Blob` window. Compressed
 * entries (Zlib only — Oodle isn't supported) decompress on read
 * via `readUpakEntry`. Inner files route through `childNodeFor`
 * so that nested formats (.uplugin / .ini / .locres / etc.) get
 * the same per-extension treatment they would in any other
 * container.
 *
 * Older PAK versions (v1–v10) and AES-encrypted indexes throw a
 * descriptive error from `parseUpak` rather than silently mis-
 * decoding. Per-file AES encryption is similarly unsupported and
 * surfaces on first read of an affected entry.
 */
function makeUpakNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	// Build both the parsed PAK and the path-keyed tree once on
	// first `getChildren()`. After the tree is built we drop the
	// flat `pak.entries[]` reference: every leaf's entry is now
	// reachable via the tree, and the duplicate ~30 MB of
	// per-entry JS objects in a 200k-file PAK adds up fast on
	// memory-constrained browsers.
	let parsed: Promise<{ ctx: UpakNodeContext }> | null = null;
	const parse = () => {
		if (!parsed) {
			parsed = parseUpak(blob).then((pak) => {
				const tree = buildUpakTree(pak);
				// Free the flat entry list — `tree` references
				// the same `UpakEntry` objects through its map
				// values, so this is purely shedding the array
				// container, not the entries themselves.
				const ctxObj: UpakNodeContext = {
					source: pak.source,
					footer: pak.footer,
					tree,
				};
				return { ctx: ctxObj };
			});
		}
		return parsed;
	};
	return {
		id,
		name,
		kind: 'upak',
		isContainer: true,
		size: blob.size,
		format: 'UE-PAK',
		blob: async () => blob,
		getChildren: async () => {
			const { ctx: pakCtx } = await parse();
			return upakEntriesToNodes(id, pakCtx.tree, pakCtx, ctx);
		},
	};
}

/**
 * Per-PAK shared state passed down to lazy `getChildren`
 * thunks. Avoids holding a reference to the parsed PAK's flat
 * `entries[]` array (which we drop right after building the
 * tree to keep memory bounded for 200k+-entry PAKs).
 */
interface UpakNodeContext {
	source: Blob;
	footer: ParsedUpak['footer'];
	tree: UpakTree;
}

/**
 * Build the path-keyed tree shape `upakEntriesToNodes` expands
 * lazily. Returned once per PAK and cached on the parent node;
 * subsequent `getChildren` calls walk into the already-built
 * tree without re-allocating maps.
 *
 * For UE PAKs with hundreds of thousands of entries (a typical
 * Switch port can have 200k+ files) this single up-front walk
 * still allocates a fair amount, but it's a flat array of
 * `Map`s rather than the much heavier `Node`-with-closures
 * graph the previous "build the whole node tree at once"
 * approach produced.
 */
type UpakTree = Map<string, { dir?: UpakTree; file?: UpakEntry }>;

function buildUpakTree(pak: ParsedUpak): UpakTree {
	const root: UpakTree = new Map();
	for (const entry of pak.entries) {
		const parts = entry.path.split('/').filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			const isLast = i === parts.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast) {
				node.file = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}
	return root;
}

/**
 * Lazily expand a single level of a parsed PAK's path tree into
 * `Node` objects. Mirrors the structure other containers
 * (RomFS / ZIP / SARC / IoStore) produce, but the recursion
 * lives in each child's `getChildren` thunk rather than running
 * up-front.
 *
 * For modest PAKs (a few thousand entries) the eager tree walk
 * the iostore branch uses is fine; for UE-shipping PAKs (200k+
 * entries) it allocates so many `Node` closures and intermediate
 * `Map`s that the browser tab crashes. This per-level expansion
 * keeps the node graph minimal: the user only pays for what
 * they actually open.
 *
 * Files become leaves whose `blob()` materialises the
 * decompressed bytes via `readUpakEntry` on first read.
 */
function upakEntriesToNodes(
	parentId: string,
	tree: UpakTree,
	pakCtx: UpakNodeContext,
	ctx: ArchiveContext,
): Node[] {
	const names = [...tree.keys()].sort((a, b) => {
		const aIsDir = !!tree.get(a)!.dir;
		const bIsDir = !!tree.get(b)!.dir;
		if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
		return humanCompare(a, b);
	});
	return names.map((n): Node => {
		const child = tree.get(n)!;
		const childId = `${parentId}/${n}`;
		if (child.dir) {
			const subTree = child.dir;
			return childDirectoryNodeFor({
				id: childId,
				name: n,
				// Defer expanding this subdirectory's children
				// until the user actually opens it. The
				// `subTree` map is already in memory (built once
				// by `buildUpakTree`), so the only allocation
				// here is the closure itself.
				getChildren: async () =>
					upakEntriesToNodes(childId, subTree, pakCtx, ctx),
			});
		}
		const file = child.file!;
		// Wrap the per-entry materialisation in a lazy Blob
		// facade so we don't decompress the file just because
		// the user clicked into a sibling directory.
		const lazyBlob = makeLazyBlob(file.uncompressedSize, () =>
			readUpakEntry(pakCtx.source, file, pakCtx.footer, {
				externalDecompressor: async (
					compressed,
					uncompressedSize,
					methodName,
				) => {
					if (!isOodleMethodName(methodName)) {
						throw new Error(
							`PAK uses unsupported compression "${methodName}".`,
						);
					}
					const od = ctx.getOodleDecompressor?.();
					if (!od) {
						ctx.requestOodle?.();
						throw new OodleMissingError(
							`PAK entry uses ${methodName}; upload an oodle.wasm to decode it.`,
						);
					}
					return od(compressed, uncompressedSize);
				},
			}),
		);
		return upakLeafNode(childId, n, lazyBlob, ctx);
	});
}

/**
 * Synchronous variant of {@link childNodeFor} for PAK leaves.
 *
 * UE PAKs tend to ship with millions of inner files, so even
 * paying the cost of an async `sniffMagicCheap` per file at
 * tree-build time would be prohibitive. The vast majority of
 * inner file names are well-known UE extensions
 * (.uasset / .uexp / .ubulk / .umap / .uplugin / .uproject /
 * .ini / .locres / .bin / .pak …), all of which we can dispatch
 * by extension alone. Anything we don't recognise falls back to
 * a generic `'file'` node — the user can still download and
 * inspect it via the hex preview.
 */
function upakLeafNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	void ctx;
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: blob.size,
		format: detectFormat(name) || 'BIN',
		blob: async () => blob,
	};
}

// ----- UnityFS (Unity AssetBundle) -----

/**
 * `.bundle` / `.unity3d` files (and anything with the `UnityFS` magic)
 * are Unity AssetBundles — the runtime container Unity-engine games
 * use to ship their asset payloads. We parse the envelope and expose
 * each inner virtual file as an entry in the tree, routing through
 * `childNodeFor` so any inner files that happen to be in formats we
 * already know about (rare in practice — most are Unity's own
 * `*.assets` SerializedFile binaries) get their normal preview.
 *
 * Unity SerializedFile parsing (the per-object Texture2D / AudioClip /
 * GameObject / etc. listing) is intentionally NOT implemented here —
 * that's a much larger project handled by external tools like
 * AssetStudio / AssetRipper. Browsing stops at "here are the inner
 * files".
 */
function makeUnityFsNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'unityfs',
		isContainer: true,
		size: blob.size,
		format: 'UnityFS',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseUnityFs(blob);
			return unityFsEntriesToNodes(id, parsed.nodes, ctx);
		},
	};
}

/**
 * Convert a UnityFS bundle's flat node list into tree-shaped
 * children. Most bundles emit flat names (`CAB-xxxxxxxxxxxx`,
 * `CAB-xxxxxxxxxxxx.resS`, etc.), but Addressable bundles
 * occasionally use `/`-delimited paths — handle both transparently
 * by splitting on `/` and grouping into nested directories the same
 * way the ZIP / SARC code paths do.
 */
async function unityFsEntriesToNodes(
	parentId: string,
	entries: UnityFsNode[],
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: UnityFsNode }>;
	const root: Tree = new Map();
	for (const entry of entries) {
		const parts = entry.path.split('/').filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast) {
				node.file = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}

	const treeToNodes = async (
		treeId: string,
		t: Tree,
	): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			const aIsDir = !!t.get(a)!.dir;
			const bIsDir = !!t.get(b)!.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		return Promise.all(
			names.map(async (name): Promise<Node> => {
				const child = t.get(name)!;
				const childId = `${treeId}/${name}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return childDirectoryNodeFor({
						id: childId,
						name,
						getChildren: async () => subNodes,
					});
				}
				const file = child.file!;
				// CAB-* (no extension) files inside a UnityFS bundle
				// are Unity SerializedFiles — the actual asset records
				// live in those, alongside their `.resS` siblings
				// (large texture / audio pixel data referenced via
				// `m_StreamData`). Hand them a dedicated node kind so
				// the preview pane can mount the SerializedFile parser
				// + viewer instead of just dumping hex.
				if (
					/^cab-[0-9a-f]+$/i.test(name) &&
					!name.toLowerCase().endsWith('.ress')
				) {
					return makeUnitySerializedFileNode(
						childId,
						name,
						file.data,
						ctx,
					);
				}
				return childNodeFor(childId, name, file.data, ctx);
			}),
		);
	};

	return treeToNodes(parentId, root);
}

/**
 * Wrap a Unity SerializedFile (`CAB-…` inside a UnityFS bundle)
 * as a browsable container. The CAB itself is a single binary
 * blob in the bundle, but conceptually it holds a heterogeneous
 * collection of typed objects (`Font`, `Texture2D`, `Material`,
 * `MonoBehaviour`, …) — making each one an addressable child node
 * lets users drill into a single asset (e.g. one font out of 26)
 * instead of being dropped into a wall of stacked previews.
 *
 * Children carry `kind: 'unity-object'` plus enough `meta` for the
 * preview pane to re-fetch and decode the specific object on click
 * without us having to hold the entire decoded SerializedFile in
 * memory across the whole tree.
 *
 * We don't try to recurse into nested archive formats here — the
 * embedded font bytes inside a `Font` object, for instance, get
 * surfaced via the per-object preview rather than as a virtual
 * `.ttf` child. (We could revisit this if it turns out useful.)
 */
function makeUnitySerializedFileNode(
	id: string,
	name: string,
	blob: Blob,
	_ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'unity-asset',
		isContainer: true,
		size: blob.size,
		format: 'Unity Asset',
		blob: async () => blob,
		getChildren: async () => unitySerializedFileChildren(id, blob),
	};
}

/**
 * Build per-object child nodes for a Unity SerializedFile. Each
 * child represents one object (`SerializedObject`) and is named
 * `<m_Name>.<ext>` where `<ext>` is a class-derived hint (e.g.
 * `.ttf` / `.otf` for a `Font`, falling back to a class-shaped
 * suffix like `.tex2d` / `.mat` / `.mb`). The hint nudges the
 * preview pane and download dialog toward the right behaviour
 * even when the object falls back to the generic preview.
 *
 * Sorted by class name first (so Fonts cluster together, Textures
 * cluster together, …), then by display name (case-insensitive).
 */
async function unitySerializedFileChildren(
	parentId: string,
	blob: Blob,
): Promise<Node[]> {
	let parsed: ParsedSerializedFile;
	try {
		parsed = await parseSerializedFile(blob);
	} catch {
		// Bad / unsupported SerializedFile — surface no children.
		// The preview pane will still render the header-level error
		// when the user clicks the parent node.
		return [];
	}
	const idToClass = new Map<number, string>(
		Object.entries(UnityClassId).map(([k, v]) => [v as number, k]),
	);
	type Entry = {
		obj: SerializedObject;
		className: string;
		displayName: string;
		ext: string;
	};
	const entries: Entry[] = [];
	for (const obj of parsed.objects) {
		const className = idToClass.get(obj.classId) ?? `Class${obj.classId}`;
		// Pull out `m_Name` if the object has a TypeTree we can decode.
		// For untyped objects (no TypeTree) we fall back to a
		// `<Class>#<pathId>`-style synthetic name. This is rare for
		// Switch / mobile bundles which ship TypeTrees, but legal.
		let displayName = '';
		let extHint = unityClassExtension(className);
		const ty = parsed.types[obj.typeIndex];
		if (ty?.typeTree) {
			try {
				const v = await parseUnityObject(obj, ty.typeTree);
				if (v && typeof v === 'object') {
					const r = v as Record<string, unknown>;
					if (typeof r.m_Name === 'string') displayName = r.m_Name;
					// Refine the Font extension to TTF / OTF based on
					// the embedded sfnt magic. Mostly cosmetic — the
					// per-object preview re-sniffs anyway — but it makes
					// the tree label honest.
					if (className === 'Font') {
						// Unity 2020+ describes `m_FontData` as
						// `vector<char>` (returned as `Uint8Array` by
						// the array fast-path); older bundles use
						// `TypelessData` (returned as
						// `{ size, data: Uint8Array }`). Accept both.
						let fontBytes: Uint8Array | null = null;
						const fd = r.m_FontData;
						if (fd instanceof Uint8Array) fontBytes = fd;
						else if (
							fd &&
							typeof fd === 'object' &&
							'data' in fd &&
							(fd as { data?: unknown }).data instanceof Uint8Array
						) {
							fontBytes = (fd as { data: Uint8Array }).data;
						}
						if (fontBytes && fontBytes.length >= 4) {
							const m =
								((fontBytes[0] ?? 0) << 24) |
								((fontBytes[1] ?? 0) << 16) |
								((fontBytes[2] ?? 0) << 8) |
								(fontBytes[3] ?? 0);
							if (m === 0x4f54544f /* OTTO */) extHint = 'otf';
						}
					}
				}
			} catch {
				/* fall through to synthetic name */
			}
		}
		// Fallback: when TypeTrees are stripped (release builds), most
		// objects start with a `string m_Name` field. Read just that
		// prefix to get a useful tree label without paying the cost of
		// a full hardcoded class decode. The reader is identical to
		// the one in `@tootallnate/unity-asset`'s `UnityReader.string`
		// (u32 length + UTF-8 bytes), but inlined here so this file
		// stays free of any per-class layout knowledge — name is the
		// universal first field, regardless of class.
		if (!displayName) {
			try {
				const head = new Uint8Array(
					await obj.data.slice(0, Math.min(obj.size, 1024)).arrayBuffer(),
				);
				if (head.length >= 4) {
					const len =
						head[0]! | (head[1]! << 8) | (head[2]! << 16) | (head[3]! << 24);
					if (len > 0 && len <= head.length - 4 && len < 256) {
						const decoder = new TextDecoder('utf-8', { fatal: false });
						const name = decoder.decode(head.subarray(4, 4 + len));
						// Sanity-check: m_Name should look like a typical
						// identifier (printable ASCII + a handful of unicode
						// scripts). Reject obvious garbage.
						let printable = 0;
						for (const c of name) {
							const cp = c.codePointAt(0)!;
							if (cp >= 0x20 && cp < 0x7f) printable++;
							else if (cp >= 0x4e00) printable++; // CJK
						}
						if (name.length > 0 && printable / name.length > 0.5) {
							displayName = name;
						}
					}
				}
			} catch {
				/* fall through */
			}
		}
		if (!displayName) displayName = `${className}#${obj.pathId.toString()}`;
		entries.push({ obj, className, displayName, ext: extHint });
	}
	entries.sort((a, b) => {
		if (a.className !== b.className)
			return a.className.localeCompare(b.className);
		return a.displayName.localeCompare(b.displayName, undefined, {
			sensitivity: 'base',
		});
	});
	// Disambiguate duplicate names within the same class (e.g.
	// "Font Texture" appears 26 times). Append `(N)` based on
	// occurrence within the post-sort sequence.
	const seen = new Map<string, number>();
	return entries.map((e): Node => {
		const baseLeaf = sanitizeLeafName(e.displayName);
		const baseFull = `${baseLeaf}.${e.ext}`;
		const n = seen.get(baseFull) ?? 0;
		seen.set(baseFull, n + 1);
		const leaf = n === 0 ? baseFull : `${baseLeaf} (${n + 1}).${e.ext}`;
		const childId = `${parentId}/${leaf}`;
		return {
			id: childId,
			name: leaf,
			kind: 'unity-object',
			isContainer: false,
			size: e.obj.size,
			format: e.className,
			meta: {
				unityClass: e.className,
				unityPathId: e.obj.pathId.toString(),
				unityObjectSize: e.obj.size,
				// The CAB blob — used by the per-object preview to
				// re-parse the SerializedFile and locate this object
				// by `pathId` without re-walking the archive tree.
				unitySerializedFileBlob: blob,
				// CAB node id — used to resolve `.resS` siblings via
				// the existing externals walk (which expects the
				// SerializedFile's tree node, not the inner object).
				unitySerializedFileNodeId: parentId,
			},
			// `blob()` returns the raw object bytes (the slice of the
			// SerializedFile's data section that holds this object's
			// payload). It's the most useful "save this asset" payload
			// for hex-dumping or feeding into external tooling like
			// AssetStudio that wants the bytes verbatim.
			blob: async () => e.obj.data,
		};
	});
}

/**
 * Filesystem-friendly default extension for a Unity object class.
 *
 * The leading `.<class>` segment is informational — names the
 * Unity class so users can spot what the file is at a glance —
 * and is followed by `.bin` so the OS / external tooling treat
 * the download as opaque bytes rather than the named format.
 *
 * Concretely: a Texture2D's serialised payload comes out as
 * `<Name>.tex2d.bin`. The bytes are *not* a self-contained `.tex2d`
 * file — they're a slice of the parent SerializedFile whose meaning
 * depends on the parent's TypeTree. Marking them `.bin` avoids
 * implying re-importability while keeping the class hint visible.
 *
 * Font is the lone exception: when the embedded `m_FontData` is a
 * complete TTF/OTF, we DO surface `.ttf` / `.otf` directly because
 * those bytes stand on their own (the Font object's other fields
 * are metadata, not part of the font file itself). The children
 * builder re-sniffs the magic to refine `.ttf` → `.otf`.
 */
function unityClassExtension(className: string): string {
	if (className === 'Font') return 'ttf';
	const hint = unityClassHint(className);
	return `${hint}.bin`;
}

/** Class-name hint used as the inner extension segment (before `.bin`). */
function unityClassHint(className: string): string {
	switch (className) {
		case 'Texture2D':
			return 'tex2d';
		case 'Texture3D':
			return 'tex3d';
		case 'Cubemap':
			return 'cubemap';
		case 'Material':
			return 'mat';
		case 'Shader':
			return 'shader';
		case 'Mesh':
			return 'mesh';
		case 'AudioClip':
			return 'audio';
		case 'AnimationClip':
			return 'anim';
		case 'TextAsset':
			return 'txt';
		case 'MonoBehaviour':
			return 'mb';
		case 'GameObject':
			return 'go';
		case 'Transform':
			return 'transform';
		case 'AssetBundle':
			return 'manifest';
		case 'Sprite':
			return 'sprite';
		default:
			return 'asset';
	}
}

/**
 * Strip / replace characters that would be awkward in a tree-leaf
 * name (slashes, control chars, leading dots). Mirrors the kind of
 * sanitation the FMOD-bank node does for its sample children.
 */
function sanitizeLeafName(name: string): string {
	const cleaned = name.replace(/[\\/\u0000-\u001f]+/g, '_').trim();
	if (!cleaned) return 'unnamed';
	// Avoid leading dot (would render as a hidden file in download
	// dialogs).
	return cleaned.replace(/^\.+/, '_');
}

// ----- Bundle wrapper detection -----

/**
 * Read the first 32 bytes of a blob for magic-byte sniffing. 32
 * bytes is enough to distinguish raw UnityFS (`UnityFS\0` at offset
 * 0) from Square Enix's Pixel Remaster wrapper (a fixed 32-byte
 * encrypted preamble that's identical across every `*.bundle` in
 * every FFPR Switch title).
 */
async function sniffHead(blob: Blob): Promise<Uint8Array> {
	const len = Math.min(blob.size, 32);
	if (len === 0) return new Uint8Array(0);
	return new Uint8Array(await blob.slice(0, len).arrayBuffer());
}

function isUnityFsHead(head: Uint8Array): boolean {
	return (
		head.length >= 8 &&
		head[0] === 0x55 && // 'U'
		head[1] === 0x6e && // 'n'
		head[2] === 0x69 && // 'i'
		head[3] === 0x74 && // 't'
		head[4] === 0x79 && // 'y'
		head[5] === 0x46 && // 'F'
		head[6] === 0x53 && // 'S'
		head[7] === 0x00
	);
}

/**
 * The Final Fantasy Pixel Remaster Switch ports wrap each Unity
 * AssetBundle in a custom encryption layer. The same fixed 32-byte
 * preamble appears at the start of every `*.bundle` in every FFPR
 * Switch title (FF1 / FF2 / FF3 / FF4 / FF5 / FF6 — verified on
 * `font_en.bundle` from all six). The encryption itself is a
 * proprietary Square Enix scheme and isn't decoded here; we just
 * detect the wrapper so the UI can avoid spamming an "Unsupported
 * bundle signature" error full of garbage bytes.
 *
 * If you have a working decoder for this format, please open an
 * issue or PR — see the `@tootallnate/ffpr-bundle` package
 * placeholder in the repo for prior-art links.
 */
const FFPR_BUNDLE_MAGIC = new Uint8Array([
	0x7e, 0x10, 0xd8, 0x12, 0x10, 0xc7, 0x3e, 0xb8,
	0xdd, 0xe3, 0x7f, 0x40, 0xdb, 0xf6, 0xa1, 0x8d,
	0x9a, 0xf3, 0x49, 0xa5, 0x78, 0x02, 0x45, 0x11,
	0x80, 0x2d, 0x2b, 0x89, 0x7b, 0xae, 0x97, 0x9c,
]);

function isFfprBundle(head: Uint8Array): boolean {
	if (head.length < FFPR_BUNDLE_MAGIC.length) return false;
	for (let i = 0; i < FFPR_BUNDLE_MAGIC.length; i++) {
		if (head[i] !== FFPR_BUNDLE_MAGIC[i]) return false;
	}
	return true;
}

/**
 * Leaf node for an FFPR-wrapped Unity AssetBundle. We don't (yet)
 * decrypt the contents, so this exposes the file as a non-container
 * with a clear `Encrypted Unity AssetBundle (Square Enix)` format
 * label. Users can still download the raw bytes for offline analysis
 * with their own tools.
 */
function makeFfprBundleNode(
	id: string,
	name: string,
	blob: Blob,
	_ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: blob.size,
		format: 'SQEX-AB',
		blob: async () => blob,
	};
}

// ----- Generic dispatcher for directory-shaped child nodes -----

/**
 * Single source of truth for every container's directory-shaped
 * child nodes. Containers (PFS0 / HFS0 / RomFS / ZIP / SARC /
 * IoStore / UnityFS / loose-directory) used to inline `kind:
 * 'directory'` independently, which meant any cross-cutting
 * directory recognition (e.g. `*.htdocs/` for the offline-manual
 * iframe renderer) had to be re-added to each one. Routing
 * through this helper guarantees a single recognition pass and a
 * uniform node shape.
 *
 * Recognition is purely name-based today (`*.htdocs/` → the
 * htdocs preview). The preview itself queries `getChildren()`
 * lazily when it needs the file map, so the archive layer never
 * has to materialise a full RomFS-shaped tree up-front.
 *
 * Mirrors the shape of {@link childNodeFor}: pass the bare
 * inputs, get back a fully-formed `Node`.
 */
function childDirectoryNodeFor(opts: {
	id: string;
	name: string;
	getChildren: () => Promise<Node[]>;
	/** Optional size in bytes (only the fs-directory walker has this up-front). */
	size?: number;
}): Node {
	const { id, name, getChildren, size } = opts;
	const isHtdocs = name.toLowerCase().endsWith('.htdocs');
	return {
		id,
		name,
		kind: isHtdocs ? 'htdocs' : 'directory',
		isContainer: true,
		size,
		format: isHtdocs ? 'HTDOCS' : 'directory',
		getChildren,
	};
}

// ----- Generic dispatcher for nested children whose container type is determined by name/sniff -----

async function childNodeFor(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	tikMap?: TikMap,
	siblings?: SiblingMap,
): Promise<Node> {
	const ext = extOf(name);
	if (ext === 'nca') return makeNcaNode(id, name, blob, ctx, tikMap);
	if (ext === 'ncz') return makeNczNode(id, name, blob, ctx, tikMap);
	if (ext === 'nro') return makeNroNode(id, name, blob, ctx);
	if (ext === 'nsp') return makePfs0Node(id, name, blob, ctx, 'NSP');
	if (ext === 'pfs0') return makePfs0Node(id, name, blob, ctx, 'PFS0');
	if (ext === 'hfs0') return makeHfs0Node(id, name, blob, ctx);
	if (ext === 'xci') return makeXciNode(id, name, blob, ctx);
	if (ext === 'zip') return makeZipNode(id, name, blob, ctx);
	if (ext === 'sarc' || ext === 'pack') return makeSarcNode(id, name, blob, ctx);
	if (ext === 'resources') return makeIdTechResourcesNode(id, name, blob, ctx);
	if (ext === 'szs') return makeSzsNode(id, name, blob, ctx);
	if (ext === 'lz4') return makeLz4Node(id, name, blob, ctx);
	if (ext === 'zs' || ext === 'zst') return makeZstdNode(id, name, blob, ctx);
	// `.utoc` standalone (no `.ucas` sibling): we can still browse
	// the file listing via the directory index, but inner-file
	// reads will surface a clear error. The "right" path \u2014
	// pairing with the sibling `.ucas` \u2014 lives in
	// `romfsEntriesToNodes` where the parent directory is in scope.
	if (ext === 'utoc') return makeIoStoreNode(id, name, blob, null, ctx);
	if (ext === 'pak') {
		// `.pak` covers two unrelated formats with the same
		// extension: Unreal Engine PAKs (footer magic
		// `0x5A6F12E1`) and Switch first-party `.pack` files
		// (SARC under a different ext — Nintendo varies the
		// extension freely). Footer-sniff to disambiguate so a
		// Nintendo PACK that happens to be named `.pak` falls
		// through to the SARC magic check below.
		if (await isUpakV11(blob)) return makeUpakNode(id, name, blob, ctx);
		// Fall through.
	}
	if (ext === 'bundle' || ext === 'unity3d' || ext === 'ab') {
		// Sniff the magic before committing to UnityFS parsing. Some
		// Switch ports wrap their AssetBundles in a custom encryption
		// envelope (notably the Final Fantasy Pixel Remasters: see
		// `isFfprBundle` below). Without this guard the UnityFS parser
		// would surface a noisy "Unsupported bundle signature" error
		// containing raw garbage bytes from the encrypted prefix.
		const head = await sniffHead(blob);
		if (isUnityFsHead(head)) return makeUnityFsNode(id, name, blob, ctx);
		if (isFfprBundle(head)) return makeFfprBundleNode(id, name, blob, ctx);
		// Unknown wrapper — fall through to generic.
	}
	if (ext === 'bars') return makeBarsNode(id, name, blob, ctx);
	if (ext === 'bfsar') return makeBfsarNode(id, name, blob, ctx);
	if (ext === 'bfwar') return makeBfwarNode(id, name, blob, ctx);
	if (ext === 'bfres') return makeBfresNode(id, name, blob, ctx);
	if (ext === 'awb') {
		return makeAwbNode(id, name, blob, ctx, siblingsToAwbResolver(siblings));
	}
	if (ext === 'acb') return makeAcbNode(id, name, blob, ctx, siblings);
	// Unity standalone-build SerializedFiles: `*.assets` (e.g.
	// `resources.assets`, `sharedassets0.assets`, `globalgamemanagers.assets`)
	// and the no-extension scene / global files (`level0`..`levelN`,
	// `globalgamemanagers`, `mainData`, `customdata`). All use the
	// Unity SerializedFile format and reference companion `.resS` /
	// `.resource` files in the same directory.
	if (ext === 'assets') return makeUnitySerializedFileNode(id, name, blob, ctx);
	if (
		/^(?:level\d+|globalgamemanagers|maindata|customdata)$/i.test(name)
	) {
		return makeUnitySerializedFileNode(id, name, blob, ctx);
	}
	if (ext === 'gfpak') return makeGfpakNode(id, name, blob, ctx);
	if (ext === 'pck') return makeWwisePckNode(id, name, blob, ctx);
	if (ext === 'bnk') return makeWwiseBnkNode(id, name, blob, ctx);
	if (ext === 'bank') {
		// `.bank` is ambiguous: Wwise uses BKHD, FMOD uses RIFF/FEV.
		// Sniff first, then dispatch.
		const sniffed = await sniffMagicCheap(blob);
		if (sniffed === 'fmod-bank') return makeFmodBankNode(id, name, blob, ctx);
		if (sniffed === 'wwise-bnk') return makeWwiseBnkNode(id, name, blob, ctx);
		// Unknown bank — fall through to generic.
	}

	// Magic sniff fallback for files whose extension doesn't tell us
	// what they are. Especially important for 1st-party Nintendo
	// games, which use a long tail of bespoke extensions (`.shksc`,
	// `.shknm2`, `.sbactorpack`, `.sbfarc`, `.sbeventpack`, `.spack`,
	// …) for what's almost always a Yaz0+SARC archive. Rather than
	// maintain a doomed catalogue of every Nintendo internal-team
	// suffix, we read the first 8 bytes and dispatch by the actual
	// magic. This is cheap for SARC / ZIP / RomFS children (the
	// parent's bytes are already in memory and a 4-byte slice is
	// effectively free) and handles the long tail uniformly.
	const sniffed = await sniffMagicCheap(blob);
	if (sniffed === 'sarc') return makeSarcNode(id, name, blob, ctx);
	if (sniffed === 'idtech-resources') return makeIdTechResourcesNode(id, name, blob, ctx);
	if (sniffed === 'szs') return makeSzsNode(id, name, blob, ctx);
	if (sniffed === 'pfs0') return makePfs0Node(id, name, blob, ctx, 'PFS0');
	if (sniffed === 'hfs0') return makeHfs0Node(id, name, blob, ctx);
	if (sniffed === 'romfs') return makeRomfsNode(id, name, blob, ctx);
	if (sniffed === 'zip') return makeZipNode(id, name, blob, ctx);
	if (sniffed === 'lz4') return makeLz4Node(id, name, blob, ctx);
	if (sniffed === 'zstd') return makeZstdNode(id, name, blob, ctx);
	if (sniffed === 'unityfs') return makeUnityFsNode(id, name, blob, ctx);
	if (sniffed === 'bars') return makeBarsNode(id, name, blob, ctx);
	if (sniffed === 'bfsar') return makeBfsarNode(id, name, blob, ctx);
	if (sniffed === 'bfwar') return makeBfwarNode(id, name, blob, ctx);
	if (sniffed === 'bfres') return makeBfresNode(id, name, blob, ctx);
	if (sniffed === 'awb') {
		return makeAwbNode(id, name, blob, ctx, siblingsToAwbResolver(siblings));
	}
	if (sniffed === 'gfpak') return makeGfpakNode(id, name, blob, ctx);
	if (sniffed === 'wwise-pck') return makeWwisePckNode(id, name, blob, ctx);
	if (sniffed === 'wwise-bnk') return makeWwiseBnkNode(id, name, blob, ctx);
	if (sniffed === 'fmod-bank') return makeFmodBankNode(id, name, blob, ctx);

	// Generic file
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: blob.size,
		format: detectFormat(name) || 'BIN',
		blob: async () => blob,
	};
}
