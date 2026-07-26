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
import { thpRestuffJpeg } from '@tootallnate/thp';
import { parseVbf, type VbfFileEntry } from '@tootallnate/vbf';
import { parseLgp, type LgpEntry } from '@tootallnate/lgp';
import {
	parseWd,
	decodeWaveToWav,
	waveDurationSeconds,
	type WdBank,
	type WdWave,
} from '@tootallnate/square-wd';
import {
	psAdpcmBytesToSamples,
	PS_ADPCM_FRAME_SIZE,
} from '@tootallnate/ps-adpcm';
import {
	parseIdTechResources,
	type IdTechResourceEntry,
} from '@tootallnate/idtech-resources';
import { decompressYaz0 } from '@tootallnate/yaz0';
import { decompressLz4, decodeBlock, type Lz4Variant } from '@tootallnate/lz4';
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
import { parseNesHeader } from '@tootallnate/nes-rom';
import {
	renderNesAudio,
	encodeWav as encodeNesWav,
} from '@tootallnate/nes-audio';
import {
	scanGbaCompression,
	decompressGba,
	type GbaCompressedBlock,
} from '@tootallnate/gba-rom';
import { parseSnesRom, scanBrrSamples } from '@tootallnate/snes-rom';
import { decodeBrr } from '@tootallnate/brr';
import {
	isSmw,
	readAllSmwGfx,
	readSmwPalettes,
	SMW_DEFAULT_SPRITE_PALETTE,
	type SmwGfxFile,
} from '@tootallnate/smw';
import {
	detectN64ByteOrder,
	normalizeN64,
	scanN64Compression,
	type N64CompressedBlockRef,
} from '@tootallnate/n64-rom';
import { decompressMio0Bytes } from '@tootallnate/mio0';
import { decompressYay0Bytes } from '@tootallnate/yay0';
import { scanDisplayLists, type DisplayListRef } from '@tootallnate/f3dex';
import {
	scanRare1172,
	decompressRare1172,
	type Rare1172File,
} from '@tootallnate/rare-1172';
import { decompressYaz0ToBytes } from '@tootallnate/yaz0';
import { parseZ64Fs, extractDmaFile, type DmaEntry } from '@tootallnate/z64-fs';
import {
	findSoundBanks,
	scanAllSamples as scanSoundBankSamples,
	decodeBankSample,
	encodeWav as encodeBankWav,
	NOMINAL_SAMPLE_RATE,
	type LocatedSample,
	type SoundBankPair,
} from '@tootallnate/n64-soundbank';
import {
	scanZ64Samples,
	decodeZ64Sample,
	encodeWav as encodeZ64Wav,
	Z64_NOMINAL_SAMPLE_RATE,
	type Z64Sample,
} from '@tootallnate/z64-audio';
import { encodeWavBlob } from '@tootallnate/dsp-adpcm';
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
import {
	AfcVariant,
	decodeAfc,
	decodeAfcStream,
	parseAfcStreamHeader,
} from '@tootallnate/afc';
import { decodeHps, isHps, parseHps } from '@tootallnate/hps';
import { decodeAst, parseAst } from '@tootallnate/ast';
import { gxFormatIsPaletted } from '@tootallnate/bti';
import {
	hsdAllRoots,
	hsdImages,
	hsdJoints,
	hsdMesh,
	isHsdHeader,
	parseHsdFile,
	type HsdArchive,
	type HsdImage,
} from '@tootallnate/hsd';
import { decodeSsmSound, parseSsm, parseSem } from '@tootallnate/ssm';
import {
	decodeWsysPcm8,
	parseBsft,
	parseBstn,
	type BstnType,
	decodeWsysPcm16,
	wsysWaveAfcBlockSize,
	findWaveGroupForAw,
	parseAaf,
	aafSequenceIndex,
	WsysWaveFormat,
	wsysWaveDecodableSamples,
	type WsysGroup,
} from '@tootallnate/wsys';

import { parseRarc, type RarcArchive, type RarcNode } from '@tootallnate/rarc';
import { parseRvz, isRvz as isRvzMagic, type RvzImage } from '@tootallnate/rvz';
import {
	gcmMaxFileEnd,
	isGcm as isGcmMagic,
	parseGcm,
	parseNkitInfo,
	type GcmDisc,
	type GcmEntry,
} from '@tootallnate/gcm';

// ----- Node types -----

export type NodeKind =
	| 'file'
	/** A JPEG wearing another extension, e.g. Melee's `.thp` stills. */
	| 'jpeg-still'
	| 'mth'
	/** HAL sound-effect map; children are its per-bank groups. */
	| 'sem'
	/** JAudio stream-filename table; children are the streams it names. */
	| 'bsft'
	/** JAudio sound-name table; children are its name categories. */
	| 'bstn'
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
	/**
	 * Virtuos Big File (`.vbf`, magic `SRYK`). Used by the Final
	 * Fantasy X / X-2 HD Remaster and Final Fantasy XII The Zodiac
	 * Age. Decompresses zlib-chunked content lazily on read.
	 */
	| 'vbf'
	/**
	 * Square wave bank (`.wd`, magic `WD\0\0`). Used by FFXI (PS2),
	 * FFX (PS2/HD/Switch), FFX-2 (PS2/Vita), and FF Crystal
	 * Chronicles (GameCube). A flat list of mono PS-ADPCM (LE) or
	 * DSP-ADPCM (BE) sound effects + voice samples. We expose each
	 * wave as a virtual `.wav` child so the existing audio preview
	 * handles them transparently.
	 */
	| 'square-wd'
	/**
	 * Sony PhyreEngine binary container (`.phyre`, magic `RYHP`).
	 * Used by FFX/X-2 HD Remaster (and FFXII TZA) for textures,
	 * meshes, shaders. We decode the texture variants
	 * (`.dds.phyre`) to RGBA8 for preview and offer a "Save as
	 * .dds" download.
	 */
	| 'phyre'
	/**
	 * Square LGP archive (`.lgp`, magic `\0\0SQUARESOFT` + footer
	 * `FINAL FANTASY7`). Used by FF7/FF8 PC for textures, models,
	 * MIDI music, etc. Browseable like a directory; entries are
	 * lazy slices into the archive.
	 */
	| 'lgp'
	/**
	 * Final Fantasy VIII PC archive triplet (`.fs` + `.fi` + `.fl`).
	 * The `.fs` (filesystem) is the payload; the `.fi` (file index)
	 * and `.fl` (file list) sit alongside as siblings. Used by
	 * every PC release (and the Switch Remastered port, which keeps
	 * the format verbatim under `weepff8/game_data/data/`).
	 */
	| 'ff8-fs'
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
	/**
	 * Square Enix SEAD audio bank (`.sab` sound effects /
	 * `.mab` music). Magic `sabf` / `mabf`. Contains one or
	 * more audio streams encoded as HCA, Ogg Vorbis, MS-ADPCM,
	 * etc. Used by every Square Unity-based title since FFXV:
	 * FF Pixel Remasters, Kingdom Hearts 3 / Melody of Memory,
	 * FFXII TZA, FF VII Remake, Paranormasight, etc.
	 */
	| 'sead-audio'
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
	| 'htdocs'
	/**
	 * NES ROM image (iNES / NES 2.0, magic `NES\x1A`). Children are
	 * the PRG-ROM / CHR-ROM segments (and 512-byte trainer when
	 * present) split out per the header sizes. CHR-ROM is raw
	 * uncompressed 2bpp tile data — prime material for the tile
	 * viewer preview.
	 */
	| 'nes-rom'
	/**
	 * Game Boy Advance ROM (`.gba`). The header carries no file
	 * index, but GBA games overwhelmingly store assets as GBA BIOS
	 * LZ77 (type 0x10) blocks, which have a scannable header —
	 * children are the blocks found by a strict decompression scan.
	 */
	| 'gba-rom'
	/**
	 * Super Nintendo ROM (`.sfc` / `.smc`). Headerless memory image;
	 * the internal header is located by checksum scoring. Children
	 * are BRR audio samples found by heuristic scan, decoded to WAV.
	 */
	| 'snes-rom'
	/**
	 * Nintendo 64 ROM (`.z64` / `.n64` / `.v64`, any byte order).
	 * Children are either the Zelda 64 dmadata filesystem (when
	 * detected) or MIO0 / Yay0 / Yaz0 compression blocks found by
	 * magic scan.
	 */
	| 'n64-rom'
	/**
	 * A buffer of decompressed N64 data (a MIO0 / Yay0 / Yaz0 block,
	 * or a Zelda 64 dmadata file). Browsable for the 3D models its
	 * display lists draw; also previewable as raw graphics via the
	 * tile explorer, since N64 textures live in these same buffers.
	 */
	| 'n64-blob'
	/**
	 * A GameCube disc image, either raw (`.iso` / `.gcm`) or inside a
	 * Dolphin RVZ/WIA compressed container. Browsable as its FST
	 * filesystem; files are read straight out of the compressed image
	 * without unpacking the whole disc.
	 */
	| 'gamecube-disc'
	/**
	 * Nintendo RARC archive (`.arc`, magic `RARC`). The standard
	 * bundled-file container for GameCube/Wii JSystem titles — Wind
	 * Waker, Twilight Princess, Super Mario Sunshine, Pikmin. Often
	 * Yaz0-wrapped, in which case we arrive here via the SZS path.
	 * Browseable as a real directory tree.
	 */
	| 'rarc'
	/**
	 * Nintendo AFC streamed audio (`.afc`). Used for GameCube music
	 * beds — Wind Waker keeps 76 of them under `Audiores/Stream/`.
	 * Exposed as a container holding one decoded `.wav` child, so the
	 * original bytes stay downloadable from the parent.
	 */
	| 'afc'
	/**
	 * Nintendo THP video (`.thp`, magic `THP\0`). GameCube/Wii
	 * cutscenes and attract loops: baseline-JPEG frames plus
	 * DSP-ADPCM audio. A leaf: the preview re-encodes it to MP4 and
	 * plays it, audio included.
	 */
	| 'thp'
	| 'mth'
	/**
	 * JAudio wave bank (`.aw`). Headerless AFC waveform data whose
	 * index lives in a sibling `.aaf`; browsable only when that
	 * sibling can be found.
	 */
	| 'aw'
	/**
	 * HAL streamed audio (`.hps`, magic `" HALPST\0"`). The music format
	 * used by Super Smash Bros. Melee and Kirby Air Ride: DSP-ADPCM in a
	 * block-linked stream. Holds the decoded track as a `.wav` child.
	 */
	| 'hps'
	/**
	 * HAL sound-sample bank (`.ssm`). The sound-effect companion to `.hps`:
	 * many short DSP-ADPCM sounds packed end to end. Expands to one `.wav`
	 * per sound.
	 */
	| 'ssm'
	/**
	 * Nintendo AST streamed audio (`.ast`, magic `STRM`). First-party
	 * streaming music for GameCube/Wii — Mario Kart: Double Dash!!, Super
	 * Mario Galaxy. Holds the decoded track as a `.wav` child.
	 */
	| 'ast'
	/**
	 * HAL HSDArchive (`.dat` / `.usd`). Melee's asset container: a relocated
	 * object graph with named roots. Browseable as a list of those roots;
	 * the typed graph inside them is not decoded.
	 */
	| 'hsd';

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

/**
 * Extension → format label. Exported so `dispatch.test.ts` can assert it agrees
 * with {@link CONTAINER_FORMAT_REGISTRY}.
 */
export const FILE_EXT_FORMATS: Record<string, string> = {
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
	// `.arc` is claimed by two unrelated formats: GameCube/Wii RARC (Wind
	// Waker, Twilight Princess, Mario Sunshine) and, as an alias, SARC
	// (Pokémon LA, Pokkén, RE0/1 rebuilds). `makeArcNode` sniffs the magic
	// when the node is expanded, so neither is assumed here.
	arc: 'ARC',
	rarc: 'RARC',
	afc: 'AFC', // GameCube streamed ADPCM music
	// Labels for formats that were previously dispatchable only as a nested
	// child. They had no entry here, so `buildRootNode` resolved them to a bare
	// uppercased extension and never reached their handler.
	sab: 'SEAD-AUDIO',
	mab: 'SEAD-AUDIO',
	sabf: 'SEAD-AUDIO',
	mabf: 'SEAD-AUDIO',
	fs: 'FF8-FS', // Final Fantasy VIII archive index
	ddsz: 'DDSZ', // LZ4-wrapped DDS texture
	assets: 'UNITY-ASSETS', // Unity standalone-build SerializedFile
	thp: 'THP', // GameCube/Wii video: JPEG frames + DSP-ADPCM audio
	mth: 'MTH', // Melee video: JPEG frames, no audio track
	hps: 'HPS', // HAL streamed music (Melee, Kirby Air Ride)
	ssm: 'SSM', // HAL sound-sample bank
	ast: 'AST', // Nintendo streamed audio (STRM)
	usd: 'HSD', // HAL HSDArchive
	// Claimed only because `makeHsdNode` falls back to a plain file when the
	// content isn't an archive; `.dat` means nothing on its own.
	dat: 'HSD',
	aw: 'AW', // GameCube wave-data blob, indexed by a WSYS in the .aaf
	aaf: 'AAF', // JAudio archive: sound table + IBNK banks + WSYS wave indices
	sem: 'SEM', // HAL sound-effect map, grouping SFX by .ssm bank
	bsft: 'BSFT', // JAudio stream-filename table
	bstn: 'BSTN', // JAudio sound-name table
	bms: 'BMS', // JAudio sequence bytecode
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
	bimage: 'idTech-bimage', // BFG-era preprocessed texture format
	vbf: 'VBF', // Virtuos Big File — FFX/X-2 HD Remaster, FFXII TZA
	wd: 'WD', // Square wave bank — FFXI/X/X-2/Crystal Chronicles
	'square-wd': 'WD', // alias used by the magic sniffer (returns 'square-wd')
	phyre: 'Phyre', // Sony PhyreEngine container — FFX/X-2 HD, FFXII TZA
	lgp: 'LGP', // Square LGP archive — FF7/FF8 PC
	sf2: 'SF2', // SoundFont 2 — sample-based MIDI instrument bank
	mid: 'MIDI', // Standard MIDI file
	midi: 'MIDI',
	nes: 'NES', // NES ROM (iNES / NES 2.0)
	gb: 'GB', // Game Boy ROM
	gbc: 'GBC', // Game Boy Color ROM
	gba: 'GBA', // Game Boy Advance ROM
	sfc: 'SNES', // Super Nintendo ROM (headerless)
	smc: 'SNES', // Super Nintendo ROM (usually with 512-byte copier header)
	rvz: 'RVZ', // Dolphin compressed GameCube/Wii disc image
	wia: 'RVZ', // the older WIA form of the same container
	gcm: 'GCM', // raw GameCube disc image
	// `.iso` is claimed by everything from PS2 to PC installers, so it gets a
	// neutral label and is only routed to the GameCube reader after its magic
	// is confirmed. See `makeIsoNode`.
	iso: 'ISO',
	z64: 'N64', // Nintendo 64 ROM, big-endian (native)
	n64: 'N64', // Nintendo 64 ROM, little-endian
	v64: 'N64', // Nintendo 64 ROM, 16-bit byteswapped
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
	| 'rarc'
	| 'thp'
	| 'mth'
	| 'hps'
	| 'bsft'
	| 'bstn'
	| 'ast'
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
	| 'idtech-resources'
	| 'idfont'
	| 'bimage'
	| 'vbf'
	| 'square-wd'
	| 'phyre'
	| 'lgp'
	| 'nes'
	| 'gb'
	| 'gba'
	| 'n64'
	| 'rvz';

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
	if (m4 === 'SRYK') return 'vbf';
	if (m4 === 'RYHP') return 'phyre'; // Sony PhyreEngine — LE magic 0x50485952
	// Square LGP archive — `\0\0SQUARESOFT` at offset 0, used
	// for FF7/FF8 PC asset packs (music, models, textures).
	if (
		head.length >= 12 &&
		head[0] === 0x00 &&
		head[1] === 0x00 &&
		String.fromCharCode(...head.subarray(2, 12)) === 'SQUARESOFT'
	) {
		return 'lgp';
	}
	if (m4 === 'RARC') return 'rarc'; // GameCube/Wii JSystem archive
	if (m4 === 'STRM') return 'ast'; // Nintendo streamed audio
	if (m4 === 'THP\0') return 'thp'; // GameCube/Wii video
	if (m4 === 'MTHP') return 'mth'; // Melee video
	if (m4 === 'bsft') return 'bsft'; // JAudio stream-filename table
	if (m4 === 'BSTN') return 'bstn'; // JAudio sound-name table
	// HPS's magic is eight bytes and starts with a space, so it can't be
	// matched against the 4-byte prefix the checks above use.
	if (
		head.length >= 8 &&
		String.fromCharCode(...head.subarray(0, 8)) === ' HALPST\0'
	) {
		return 'hps';
	}
	if (m4 === 'Yaz0') return 'szs'; // we treat all Yaz0 as SZS-style for browsing
	if (m4 === 'BARS') return 'bars';
	if (m4 === 'FSAR') return 'bfsar';
	if (m4 === 'FWAR') return 'bfwar';
	if (m4 === 'FRES') return 'bfres';
	if (m4 === 'AFS2') return 'awb';
	// Square `.wd` wave bank: byte pattern 'W' 'D' 0 0. The
	// trailing nulls would break a plain TextDecoder match, so
	// check the bytes directly.
	if (
		head.length >= 4 &&
		head[0] === 0x57 &&
		head[1] === 0x44 &&
		head[2] === 0x00 &&
		head[3] === 0x00
	) {
		return 'square-wd';
	}
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
	// idTech BFG bitmap-font metrics: magic 'idf*' (`0x6964662A`).
	if (head[0] === 0x69 && head[1] === 0x64 && head[2] === 0x66 && head[3] === 0x2a) {
		return 'idfont';
	}
	// idTech BFG `.bimage`: magic at offset 8 (after 8-byte sourceFileTime).
	if (head.length >= 12 &&
	    head[8] === 0x0a && head[9] === 0x4d && head[10] === 0x49 && head[11] === 0x42) {
		return 'bimage';
	}
	// Dolphin RVZ / WIA compressed disc image.
	if (
		head[0] === 0x52 && head[1] === 0x56 && head[2] === 0x5a && head[3] === 0x01
	) {
		return 'rvz';
	}
	if (
		head[0] === 0x57 && head[1] === 0x49 && head[2] === 0x41 && head[3] === 0x01
	) {
		return 'rvz';
	}
	// NES ROM (iNES / NES 2.0): "NES\x1A".
	if (head[0] === 0x4e && head[1] === 0x45 && head[2] === 0x53 && head[3] === 0x1a) {
		return 'nes';
	}
	// N64 ROM: first word is the PI BSD DOM1 config, whose byte
	// pattern identifies both the format and the dump byte order:
	// 80 37 12 40 (z64 big-endian), 37 80 40 12 (v64 byteswapped),
	// 40 12 37 80 (n64 little-endian).
	if (
		(head[0] === 0x80 && head[1] === 0x37 && head[2] === 0x12 && head[3] === 0x40) ||
		(head[0] === 0x37 && head[1] === 0x80 && head[2] === 0x40 && head[3] === 0x12) ||
		(head[0] === 0x40 && head[1] === 0x12 && head[2] === 0x37 && head[3] === 0x80)
	) {
		return 'n64';
	}
	// GBA ROM: the fixed Nintendo logo bitmap starts at offset 4;
	// its first 8 bytes are a strong magic.
	if (
		head.length >= 12 &&
		head[4] === 0x24 && head[5] === 0xff && head[6] === 0xae && head[7] === 0x51 &&
		head[8] === 0x69 && head[9] === 0x9a && head[10] === 0xa2 && head[11] === 0x21
	) {
		return 'gba';
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
	// Game Boy / Game Boy Color: the fixed Nintendo logo bitmap at
	// 0x104. Its first 8 bytes are a strong magic (the boot ROM
	// refuses to run carts without it, so every real ROM has it).
	if (blob.size >= 0x150) {
		const logo = new Uint8Array(
			await blob.slice(0x104, 0x10c).arrayBuffer(),
		);
		if (
			logo[0] === 0xce && logo[1] === 0xed && logo[2] === 0x66 && logo[3] === 0x66 &&
			logo[4] === 0xcc && logo[5] === 0x0d && logo[6] === 0x00 && logo[7] === 0x0b
		) {
			return 'gb';
		}
	}
	return null;
}

/**
 * A plain, downloadable file node.
 *
 * Used wherever dispatch declines to treat something as a container — an
 * unrecognised format, or a probe that came back negative.
 */
function genericFileNode(
	id: string,
	name: string,
	blob: Blob,
	format: string,
): Node {
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: blob.size,
		format,
		blob: async () => blob,
	};
}

// ----- Container format registry -----

/**
 * Everything a format's node builder might need.
 *
 * Passing one object rather than a positional list is what lets every format —
 * including the handful that need ticket keys, sibling files, or their own
 * resolved label — sit in the same table.
 */
interface ContainerBuildArgs {
	id: string;
	name: string;
	blob: Blob;
	ctx: ArchiveContext;
	/** The resolved format label. Some builders vary on it (GB vs GBC). */
	format: string;
	/** Ticket keys, when the caller had them (NCA / NCZ). */
	tikMap?: TikMap;
	/** Files alongside this one, for formats that need a partner (AWB/ACB, AW). */
	siblings?: SiblingMap;
}

/**
 * One browsable container format.
 *
 * This table is the **single source of truth** for "what can be opened as a
 * container, and how". Every dispatch path consults it: the top-level
 * {@link buildRootNode}, the nested {@link childNodeFor} extension lookup, and
 * the magic-sniff fallback.
 *
 * ## Why this exists
 *
 * These three paths used to be three hand-maintained lists — a `switch` on the
 * format label, an `if (ext === …)` chain, and an `if (sniffed === …)` chain —
 * with nothing tying them together. Adding a format meant remembering all three,
 * and forgetting one produced a silent, confusing failure rather than an error:
 * the file would open from one direction and appear as an opaque blob from
 * another. That happened four separate times (`.arc`, `.afc`, `.aw`, and again
 * when `.iso` and `.hps` were added), and a measurement of the old code found 13
 * live asymmetries — three formats openable only at the top level, ten
 * extensions openable only as a nested child.
 *
 * Registering a format here wires all three paths at once, and
 * `dispatch.test.ts` fails if they ever diverge again.
 */
interface ContainerFormat {
	/**
	 * Canonical label. Must match the value used in {@link FILE_EXT_FORMATS} so
	 * the format badge and the dispatch agree.
	 */
	format: string;
	/** Extensions that select this format: lowercase, no leading dot. */
	extensions: readonly string[];
	/** Magic-sniff keys that select this format, if it's detectable. */
	sniff?: readonly SniffedFormat[];
	/** Build the node. May be async when the format needs a deeper probe. */
	build: (args: ContainerBuildArgs) => Node | Promise<Node>;
}

const CONTAINER_FORMATS: readonly ContainerFormat[] = [
	// --- Switch / Nintendo packaging ---
	{ format: 'NRO', extensions: ['nro'], build: (a) => makeNroNode(a.id, a.name, a.blob, a.ctx) },
	{
		format: 'NSP',
		extensions: ['nsp'],
		build: (a) => makePfs0Node(a.id, a.name, a.blob, a.ctx, 'NSP'),
	},
	{
		// An NSP whose NCAs are NCZs — same container, different contents.
		format: 'NSZ',
		extensions: ['nsz'],
		build: (a) => makePfs0Node(a.id, a.name, a.blob, a.ctx, 'NSZ'),
	},
	{
		format: 'PFS0',
		extensions: ['pfs0'],
		sniff: ['pfs0'],
		build: (a) => makePfs0Node(a.id, a.name, a.blob, a.ctx, 'PFS0'),
	},
	{
		format: 'HFS0',
		extensions: ['hfs0'],
		sniff: ['hfs0'],
		build: (a) => makeHfs0Node(a.id, a.name, a.blob, a.ctx),
	},
	{ format: 'XCI', extensions: ['xci'], build: (a) => makeXciNode(a.id, a.name, a.blob, a.ctx) },
	{
		// The cartridge equivalent of NSZ.
		format: 'XCZ',
		extensions: ['xcz'],
		build: (a) => makeXciNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'NCA',
		extensions: ['nca'],
		build: (a) => makeNcaNode(a.id, a.name, a.blob, a.ctx, a.tikMap),
	},
	{
		format: 'NCZ',
		extensions: ['ncz'],
		build: (a) => makeNczNode(a.id, a.name, a.blob, a.ctx, a.tikMap),
	},
	{
		format: 'RomFS',
		extensions: ['romfs'],
		sniff: ['romfs'],
		build: (a) => makeRomfsNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'SARC',
		extensions: ['sarc', 'pack'],
		sniff: ['sarc'],
		build: (a) => makeSarcNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'SZS',
		extensions: ['szs'],
		sniff: ['szs'],
		build: (a) => makeSzsNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		// A bare Yaz0 stream. Same node as SZS: it decompresses, then
		// re-dispatches on whatever magic is inside.
		format: 'YAZ0',
		extensions: ['yaz0'],
		build: (a) => makeSzsNode(a.id, a.name, a.blob, a.ctx),
	},

	// --- Generic containers / compression ---
	{
		format: 'ZIP',
		extensions: ['zip'],
		sniff: ['zip'],
		build: (a) => makeZipNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'LZ4',
		extensions: ['lz4'],
		sniff: ['lz4'],
		build: (a) => makeLz4Node(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'ZSTD',
		extensions: ['zs', 'zst'],
		sniff: ['zstd'],
		build: (a) => makeZstdNode(a.id, a.name, a.blob, a.ctx),
	},

	// --- GameCube / Wii ---
	{
		format: 'RARC',
		extensions: ['rarc'],
		sniff: ['rarc'],
		build: (a) => makeRarcNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		// `.arc` is ambiguous (RARC on disc-based Nintendo, SARC as a Switch
		// alias) and resolves itself lazily when expanded.
		format: 'ARC',
		extensions: ['arc'],
		build: (a) => makeArcNode(a.id, a.name, a.blob, a.ctx, a.siblings),
	},
	{
		format: 'AFC',
		extensions: ['afc'],
		build: (a) => makeAfcNode(a.id, a.name, a.blob),
	},
	{
		format: 'MTH',
		extensions: ['mth'],
		sniff: ['mth'],
		build: (a) => makeMthNode(a.id, a.name, a.blob, a.siblings),
	},
	{
		format: 'THP',
		extensions: ['thp'],
		sniff: ['thp'],
		build: (a) => makeThpNode(a.id, a.name, a.blob),
	},
	{
		format: 'HPS',
		extensions: ['hps'],
		sniff: ['hps'],
		build: (a) => makeHpsNode(a.id, a.name, a.blob),
	},
	{
		// No magic, so extension-only: see `isSsm` on why sniffing it would be
		// unwise.
		format: 'SSM',
		extensions: ['ssm'],
		build: (a) => makeSsmNode(a.id, a.name, a.blob),
	},
	{
		format: 'AST',
		extensions: ['ast'],
		sniff: ['ast'],
		build: (a) => makeAstNode(a.id, a.name, a.blob),
	},
	{
		// `.dat` is a famously generic extension and HSDArchive has no magic, so
		// this entry is only safe because `makeHsdNode` validates before
		// committing: anything that isn't a well-formed archive stays the plain
		// downloadable file it was.
		format: 'HSD',
		extensions: ['usd', 'dat'],
		build: (a) => makeHsdNode(a.id, a.name, a.blob),
	},
	{
		// Needs its sibling `.aaf`/`.baa` index to mean anything.
		format: 'AW',
		extensions: ['aw'],
		build: (a) => makeAwNode(a.id, a.name, a.blob, a.siblings),
	},
	{
		// No magic of its own — five bare integer arrays — so extension only.
		format: 'SEM',
		extensions: ['sem'],
		build: (a) => makeSemNode(a.id, a.name, a.blob),
	},
	{
		format: 'BSFT',
		extensions: ['bsft'],
		sniff: ['bsft'],
		build: (a) => makeBsftNode(a.id, a.name, a.blob, a.ctx, a.siblings),
	},
	{
		format: 'BSTN',
		extensions: ['bstn'],
		sniff: ['bstn'],
		build: (a) => makeBstnNode(a.id, a.name, a.blob),
	},
	{
		format: 'RVZ',
		extensions: ['rvz', 'wia'],
		sniff: ['rvz'],
		build: (a) => makeRvzNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'GCM',
		extensions: ['gcm'],
		build: (a) => makeGamecubeIsoNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'ISO',
		extensions: ['iso'],
		build: (a) => makeIsoNode(a.id, a.name, a.blob, a.ctx),
	},

	// --- Cartridge ROMs ---
	{
		format: 'NES',
		extensions: ['nes'],
		sniff: ['nes'],
		build: (a) => makeNesRomNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'GB',
		extensions: ['gb'],
		build: (a) => makeGbRomFileNode(a.id, a.name, a.blob, a.format),
	},
	{
		format: 'GBC',
		extensions: ['gbc'],
		build: (a) => makeGbRomFileNode(a.id, a.name, a.blob, a.format),
	},
	{
		format: 'GBA',
		extensions: ['gba'],
		sniff: ['gba'],
		build: (a) => makeGbaRomNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'SNES',
		extensions: ['sfc', 'smc'],
		build: (a) => makeSnesRomNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'N64',
		extensions: ['z64', 'n64', 'v64'],
		sniff: ['n64'],
		build: (a) => makeN64RomNode(a.id, a.name, a.blob, a.ctx),
	},

	// --- Audio middleware ---
	{
		format: 'AWB',
		extensions: ['awb'],
		sniff: ['awb'],
		build: (a) =>
			makeAwbNode(a.id, a.name, a.blob, a.ctx, siblingsToAwbResolver(a.siblings)),
	},
	{
		format: 'ACB',
		extensions: ['acb'],
		build: (a) => makeAcbNode(a.id, a.name, a.blob, a.ctx, a.siblings),
	},
	{
		format: 'BARS',
		extensions: ['bars'],
		sniff: ['bars'],
		build: (a) => makeBarsNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'BFSAR',
		extensions: ['bfsar'],
		sniff: ['bfsar'],
		build: (a) => makeBfsarNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'BFWAR',
		extensions: ['bfwar'],
		sniff: ['bfwar'],
		build: (a) => makeBfwarNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'BFRES',
		extensions: ['bfres'],
		sniff: ['bfres'],
		build: (a) => makeBfresNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'AKPK',
		extensions: ['pck'],
		sniff: ['wwise-pck'],
		build: (a) => makeWwisePckNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'BNK',
		extensions: ['bnk'],
		sniff: ['wwise-bnk'],
		build: (a) => makeWwiseBnkNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		// `.bank` is claimed by both FMOD and Wwise, so the flavour has to be
		// sniffed. Doing it inside `build` rather than at the call site is what
		// keeps every dispatch path behaving the same way.
		format: 'BANK',
		extensions: ['bank'],
		sniff: ['fmod-bank'],
		build: async (a) => {
			const sniffed = await sniffMagicCheap(a.blob);
			if (sniffed === 'fmod-bank') {
				return makeFmodBankNode(a.id, a.name, a.blob, a.ctx);
			}
			if (sniffed === 'wwise-bnk') {
				return makeWwiseBnkNode(a.id, a.name, a.blob, a.ctx);
			}
			return genericFileNode(a.id, a.name, a.blob, 'BANK');
		},
	},
	{
		format: 'SEAD-AUDIO',
		extensions: ['sab', 'mab', 'sabf', 'mabf'],
		build: (a) => makeSeadAudioNode(a.id, a.name, a.blob, a.ctx),
	},

	// --- Square Enix ---
	{
		format: 'VBF',
		extensions: ['vbf'],
		sniff: ['vbf'],
		build: (a) => makeVbfNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'WD',
		extensions: ['wd'],
		sniff: ['square-wd'],
		build: (a) => makeSquareWdNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'LGP',
		extensions: ['lgp'],
		sniff: ['lgp'],
		build: (a) => makeLgpNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'FF8-FS',
		extensions: ['fs'],
		build: (a) => makeFf8FsNode(a.id, a.name, a.blob, a.ctx, a.siblings),
	},
	{
		format: 'DDSZ',
		extensions: ['ddsz'],
		build: (a) => makeDdszNode(a.id, a.name, a.blob, a.ctx),
	},

	// --- Unity / Unreal / idTech ---
	{
		format: 'UnityFS',
		extensions: [],
		sniff: ['unityfs'],
		build: (a) => makeUnityFsNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'UNITY-ASSETS',
		extensions: ['assets'],
		build: (a) => makeUnitySerializedFileNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'UE-TOC',
		extensions: ['utoc'],
		build: (a) => makeIoStoreNode(a.id, a.name, a.blob, null, a.ctx),
	},
	{
		// `.pak` covers Unreal Engine PAKs (footer magic 0x5A6F12E1) and
		// Nintendo's unrelated `.pack` family. Footer-sniff to tell them apart;
		// a Nintendo PACK falls through to the SARC magic check.
		format: 'UE-PAK',
		extensions: ['pak'],
		build: async (a) => {
			if (await isUpakV11(a.blob)) {
				return makeUpakNode(a.id, a.name, a.blob, a.ctx);
			}
			return genericFileNode(a.id, a.name, a.blob, 'PAK');
		},
	},
	{
		format: 'GFPAK',
		extensions: ['gfpak'],
		sniff: ['gfpak'],
		build: (a) => makeGfpakNode(a.id, a.name, a.blob, a.ctx),
	},
	{
		format: 'idTech-Resources',
		extensions: ['resources'],
		sniff: ['idtech-resources'],
		build: (a) => makeIdTechResourcesNode(a.id, a.name, a.blob, a.ctx),
	},
];

/** Registry lookups, built once. */
const FORMAT_BY_LABEL = new Map<string, ContainerFormat>();
const FORMAT_BY_EXT = new Map<string, ContainerFormat>();
const FORMAT_BY_SNIFF = new Map<string, ContainerFormat>();
for (const def of CONTAINER_FORMATS) {
	FORMAT_BY_LABEL.set(def.format, def);
	for (const ext of def.extensions) FORMAT_BY_EXT.set(ext, def);
	for (const key of def.sniff ?? []) FORMAT_BY_SNIFF.set(key, def);
}

/**
 * The registry, exposed for `dispatch.test.ts`.
 *
 * The test asserts each entry is reachable from every dispatch path and that its
 * label and extensions agree with {@link FILE_EXT_FORMATS} — the invariants whose
 * absence caused the drift this table replaces.
 */
export const CONTAINER_FORMAT_REGISTRY = CONTAINER_FORMATS;

// ----- Top-level entry: turn a user-provided Blob into a root Node -----

export async function buildRootNode(
	file: File | Blob,
	displayName: string,
	ctx: ArchiveContext,
): Promise<Node> {
	let format = detectFormat(displayName);
	// `.arc` is self-dispatching: `makeArcNode` sniffs RARC / Yaz0 / SARC when
	// expanded. Letting the generic sniff run here would instead see the Yaz0
	// wrapper on a compressed RARC and route it to the SZS node, which happens
	// to produce the right tree but labels a GameCube archive "Yaz0+SARC".
	const selfDispatching = format === 'ARC';
	if (
		!selfDispatching &&
		(!format || format === extOf(displayName).toUpperCase())
	) {
		const sniffed = await sniffMagic(file);
		if (sniffed) format = FILE_EXT_FORMATS[sniffed] ?? format;
	}

	const id = `/${displayName}`;
	const blob = file instanceof File ? file : (file as Blob);

	// Dispatch through the registry: one table, consulted identically here and
	// in `childNodeFor`. See `CONTAINER_FORMATS` for why.
	const def = format ? FORMAT_BY_LABEL.get(format) : undefined;
	if (def) {
		return def.build({
			id,
			name: displayName,
			blob,
			ctx,
			format: format ?? def.format,
		});
	}
	// Unknown — present it as a single file the user can download.
	return genericFileNode(id, displayName, blob, format || 'BIN');
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

// ----- VBF (Virtuos Big File) -----

/**
 * Virtuos Big File archive (`.vbf`, magic `SRYK`). Used by the
 * Final Fantasy X / X-2 HD Remaster and Final Fantasy XII The
 * Zodiac Age. Files inside are zlib-chunked; the entries are
 * exposed as lazy `Blob`-shaped facades that decompress on
 * read, so opening this node is cheap regardless of archive
 * size (a typical FFX vbf is ~5 GB with ~35 k files).
 */
function makeVbfNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'vbf',
		isContainer: true,
		size: blob.size,
		format: 'VBF',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseVbf(blob);
			return vbfEntriesToNodes(id, parsed.entries, ctx);
		},
	};
}

/**
 * Make an FFVIII archive-triplet container node. Looks up the
 * sibling `.fi` and `.fl` files via the supplied `siblings` map
 * (lowercased basename lookup). If either sibling is missing we
 * fall back to a plain file node — the user will at least see
 * the `.fs` blob exists but won't be able to browse it.
 */
function makeFf8FsNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	siblings: SiblingMap | undefined,
): Node {
	const base = name.toLowerCase().replace(/\.fs$/, '');
	const fiName = base + '.fi';
	const flName = base + '.fl';
	const fi = siblings?.get(fiName);
	const fl = siblings?.get(flName);
	if (!fi || !fl) {
		// Sibling triplet incomplete — surface as a plain file.
		return {
			id,
			name,
			kind: 'file',
			isContainer: false,
			size: blob.size,
			format: 'FF8-FS (missing .fi/.fl)',
			blob: async () => blob,
		};
	}
	return {
		id,
		name,
		kind: 'ff8-fs',
		isContainer: true,
		size: blob.size,
		format: 'FF8-FS',
		blob: async () => blob,
		getChildren: async () => {
			const { parseFf8Triplet } = await import('@tootallnate/ff8-fs');
			const arc = await parseFf8Triplet(fl, fi, blob);
			return ff8EntriesToNodes(id, arc.entries, blob, ctx);
		},
	};
}

/**
 * Convert a flat list of FFVIII entries (each with a Windows-
 * style cumulative path) into a hierarchical {@link Node} tree.
 *
 * Each leaf reads its bytes lazily via the package's
 * `readEntry` helper (LZSS-decompresses if needed) and exposes
 * the result as a `Blob`. Nested `.fs` triplets are detected
 * by basename suffix and re-routed through `makeFf8FsNode` —
 * since each level inside a `.fs` may contain its own `.fl`/
 * `.fi`/`.fs` triplet (e.g. `field.fs` has 21+ nested ones).
 */
async function ff8EntriesToNodes(
	parentId: string,
	entries: import('@tootallnate/ff8-fs').Ff8Entry[],
	parentFs: Blob,
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<
		string,
		{ dir?: Tree; entry?: import('@tootallnate/ff8-fs').Ff8Entry }
	>;
	const root: Tree = new Map();
	for (const entry of entries) {
		const parts = entry.pathNormalised
			.split('/')
			.filter((p) => p.length > 0);
		// Strip the leading `c:` drive letter if present (it's the
		// original devs' Windows build path, not useful in our tree).
		const stripped = parts[0]?.endsWith(':') ? parts.slice(1) : parts;
		if (stripped.length === 0) continue;
		let cur = root;
		for (let i = 0; i < stripped.length; i++) {
			const part = stripped[i]!;
			const isLast = i === stripped.length - 1;
			let node = cur.get(part);
			if (!node) {
				node = {};
				cur.set(part, node);
			}
			if (isLast) {
				node.entry = entry;
			} else {
				if (!node.dir) node.dir = new Map();
				cur = node.dir;
			}
		}
	}
	const { readEntry } = await import('@tootallnate/ff8-fs');
	const treeToNodes = async (treeId: string, t: Tree): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			const an = t.get(a)!;
			const bn = t.get(b)!;
			const aIsDir = !!an.dir;
			const bIsDir = !!bn.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		// Build a sibling map at THIS level so nested `.fs` triplets
		// can resolve their `.fi`/`.fl` companions.
		const levelSiblings = buildSiblingMap(
			[...t.entries()]
				.filter(([, v]) => !!v.entry)
				.map(([n, v]): [string, Blob] => {
					const entry = v.entry!;
					const lazyBlob = new Blob([]) as Blob; // placeholder; will be replaced
					// We need a real Blob for the sibling map — wrap
					// readEntry in a custom Blob facade.
					return [n, ff8EntryToBlob(entry, parentFs, readEntry)];
				}),
		);
		return Promise.all(
			names.map(async (n): Promise<Node> => {
				const nodeRec = t.get(n)!;
				const cid = `${treeId}/${n}`;
				if (nodeRec.dir) {
					const subtree = nodeRec.dir;
					return childDirectoryNodeFor({
						id: cid,
						name: n,
						getChildren: async () => treeToNodes(cid, subtree),
					});
				}
				const entry = nodeRec.entry!;
				const blob = levelSiblings.get(n.toLowerCase())!;
				return childNodeFor(cid, n, blob, ctx, {
					siblings: levelSiblings,
				});
			}),
		);
	};
	return treeToNodes(parentId, root);
}

/**
 * Wrap an FFVIII archive entry as a lazy `Blob`-shaped facade.
 * Reading the blob (`.arrayBuffer()`, `.slice()`) triggers
 * `readEntry`, which seeks into the parent `.fs` payload and
 * LZSS-decompresses if needed.
 */
function ff8EntryToBlob(
	entry: import('@tootallnate/ff8-fs').Ff8Entry,
	parentFs: Blob,
	readEntry: (
		entry: import('@tootallnate/ff8-fs').Ff8Entry,
		fs: Blob,
	) => Promise<Uint8Array>,
): Blob {
	// Materialise lazily on first read — most leaves are never
	// expanded so we want to avoid eagerly LZSS-decompressing
	// thousands of entries on container open.
	let cached: Promise<Blob> | null = null;
	const load = (): Promise<Blob> => {
		if (cached) return cached;
		cached = readEntry(entry, parentFs).then((bytes) => {
			// Copy into a fresh ArrayBuffer so the Blob constructor's
			// strict `ArrayBuffer` typing is satisfied (DOM lib doesn't
			// accept Uint8Array<SharedArrayBuffer>).
			const buf = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(buf).set(bytes);
			return new Blob([buf]);
		});
		return cached;
	};
	const facade = {
		size: entry.uncompressedSize,
		type: '',
		async arrayBuffer() {
			return (await load()).arrayBuffer();
		},
		async bytes() {
			const b = await load();
			return new Uint8Array(await b.arrayBuffer());
		},
		slice(start?: number, end?: number, contentType?: string) {
			// Force materialisation then slice — we don't have a
			// cheap way to slice into LZSS-compressed bytes.
			return new Blob([], { type: contentType ?? '' }) as Blob; // placeholder shape; real path below
		},
		async stream() {
			const b = await load();
			return b.stream();
		},
		async text() {
			const b = await load();
			return b.text();
		},
	} as unknown as Blob;
	// Replace `.slice` with a proper async-deferred implementation.
	(facade as { slice: Blob['slice'] }).slice = function (
		start?: number,
		end?: number,
		contentType?: string,
	): Blob {
		const startVal = start ?? 0;
		const endVal = end ?? entry.uncompressedSize;
		// Build a small derivative facade that defers to the parent's load.
		const childFacade = {
			size: Math.max(0, endVal - startVal),
			type: contentType ?? '',
			async arrayBuffer() {
				const b = await load();
				return b.slice(startVal, endVal).arrayBuffer();
			},
			async bytes() {
				const b = await load();
				const sliced = b.slice(startVal, endVal);
				return new Uint8Array(await sliced.arrayBuffer());
			},
			slice(s?: number, e?: number, t?: string) {
				return facade.slice((startVal + (s ?? 0)), Math.min(endVal, startVal + (e ?? endVal - startVal)), t);
			},
			async stream() {
				const b = await load();
				return b.slice(startVal, endVal).stream();
			},
			async text() {
				const b = await load();
				return b.slice(startVal, endVal).text();
			},
		} as unknown as Blob;
		return childFacade;
	};
	return facade;
}

function makeLgpNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'lgp',
		isContainer: true,
		size: blob.size,
		format: 'LGP',
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseLgp(blob);
			return lgpEntriesToNodes(id, name, parsed.entries, ctx);
		},
	};
}

/**
 * LGP entries carry an optional `directory` from the path table.
 * For files in the root the directory is empty; otherwise we
 * build a tree the same way the VBF flat-paths code does. Each
 * entry's `data` is already a lazy `Blob.slice()` over the
 * source archive, so child nodes inherit free laziness.
 */
async function lgpEntriesToNodes(
	parentId: string,
	parentName: string,
	entries: LgpEntry[],
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: LgpEntry }>;
	const root: Tree = new Map();
	for (const entry of entries) {
		const parts = entry.name.split('/').filter((p) => p.length > 0);
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

	const treeToNodes = async (treeId: string, t: Tree): Promise<Node[]> => {
		const names = [...t.keys()].sort((a, b) => {
			// Directories first, then files; natural-sort within each.
			const an = t.get(a)!;
			const bn = t.get(b)!;
			const aIsDir = !!an.dir;
			const bIsDir = !!bn.dir;
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return humanCompare(a, b);
		});
		return Promise.all(
			names.map(async (n): Promise<Node> => {
				const nodeRec = t.get(n)!;
				const cid = `${treeId}/${n}`;
				if (nodeRec.dir) {
					const subtree = nodeRec.dir;
					return childDirectoryNodeFor({
						id: cid,
						name: n,
						getChildren: async () => treeToNodes(cid, subtree),
					});
				}
				const file = nodeRec.file!;
				return childNodeFor(cid, n, file.data, ctx, {
					parentArchiveName: parentName.toLowerCase(),
				});
			}),
		);
	};

	return treeToNodes(parentId, root);
}

/**
 * Convert flat VBF entries (full slash-delimited paths) into a
 * hierarchical `Node` tree. Same shape as the SARC version
 * above. The per-file `data` field is already a lazy
 * decompressing facade, so nested children also get free
 * laziness — opening a deep directory doesn't materialise any
 * file bodies until the user actually downloads / previews one.
 */
async function vbfEntriesToNodes(
	parentId: string,
	entries: VbfFileEntry[],
	ctx: ArchiveContext,
): Promise<Node[]> {
	type Tree = Map<string, { dir?: Tree; file?: VbfFileEntry }>;
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
				// Route through childNodeFor so known-extension
				// containers (.nca, .sarc, .zip, etc.) inside the
				// VBF still dispatch to their dedicated readers.
				// SKIP the magic-sniff fallback though — VBF
				// entries are zlib-chunked, so probing the first 12
				// bytes of each of ~35k files would inflate ~35k
				// chunks of 64 KiB each and freeze the renderer.
				// VBFs in practice contain leaf data files
				// (textures, sounds, configs) so the sniff would
				// almost never produce a hit anyway.
				return childNodeFor(childId, name, file.data, ctx, {
					skipMagicSniff: true,
				});
			}),
		);
	};

	return treeToNodes(parentId, root);
}

// ----- Square `.WD` wave bank -----

/**
 * Make a node for a Square `.wd` wave bank. The bank parses
 * cheaply (a few KB of header + entry table), so we read it
 * upfront and synthesise one virtual `<index>.wav` child per
 * wave. Each child's blob is built lazily: the ADPCM bytes are
 * already a Blob slice, but the actual decode + WAV wrapping
 * only happens when the user previews or downloads a wave.
 *
 * Naming: `<basename>_<index>.wav` so a 36-wave bank produces
 * `wave0028_000.wav` … `wave0028_035.wav`. We don't have human-
 * readable cue names for these (the bank format predates them);
 * the index + sample rate in the metadata is the best we can
 * do for orientation.
 */
function makeSquareWdNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	void ctx;
	return {
		id,
		name,
		kind: 'square-wd',
		isContainer: true,
		size: blob.size,
		format: 'WD',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const bank = parseWd(bytes);
			// Width for zero-padded indices so directory listings
			// sort naturally (000.wav < 001.wav < 010.wav).
			const width = Math.max(3, String(bank.waves.length).length);
			// Base name without the `.wd` extension for nicer
			// child filenames.
			const baseName = name.replace(/\.wd$/i, '');
			return bank.waves.map((w): Node => {
				const idxStr = String(w.index).padStart(width, '0');
				const childName = `${baseName}_${idxStr}.wav`;
				const childId = `${id}/${childName}`;
				// Compute the WAV size upfront without decoding —
				// PS-ADPCM is a fixed 16:28 byte:sample ratio, so
				// the sample count (and hence the final WAV size)
				// is known purely from the ADPCM byte length.
				const samples = wdWaveSampleCount(w, bank);
				const wavSize = 44 + samples * 2;
				return {
					id: childId,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: wavSize,
					format: 'WAV',
					meta: {
						wdIndex: w.index,
						wdSampleRate: w.sampleRate,
						wdDurationSeconds: waveDurationSeconds(w, bank),
						wdSourceCodec: bank.codec,
					},
					blob: async () => {
						const wavBytes = await decodeWaveToWav(w, bank);
						return new Blob([wavBytes as BlobPart], {
							type: 'audio/wav',
						});
					},
				};
			});
		},
	};
}

/**
 * Sample count helper that doesn't need to do the decompression.
 * Mirrors what {@link decodeWaveToPcmAsync} would produce.
 */
function wdWaveSampleCount(wave: WdWave, bank: Pick<WdBank, 'codec'>): number {
	if (bank.codec === 'ps-adpcm') {
		return psAdpcmBytesToSamples(wave.data.byteLength);
	}
	// DSP-ADPCM: 14 samples per 8 bytes
	return Math.floor(wave.data.byteLength / 8) * 14;
}

// Avoid unused-import warning until DSP path needs the constant.
void PS_ADPCM_FRAME_SIZE;

/**
 * A Nintendo `.ast` music stream.
 *
 * Same container-with-one-`.wav` shape as `.afc` and `.hps`. The payload is
 * big-endian PCM16 rather than ADPCM, so there's no codec involved — the work is
 * de-interleaving each block's contiguous per-channel halves.
 *
 * A DSP-ADPCM AST would decode to nothing here; `decodeAst` refuses that codec
 * rather than guessing, so the node simply has no child.
 */
function makeAstNode(id: string, name: string, blob: Blob): Node {
	const base = name.replace(/\.ast$/i, '') || 'stream';
	const childName = `${base}.wav`;
	let cached: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!cached) cached = blob.arrayBuffer().then((b) => new Uint8Array(b));
		return cached;
	};
	return {
		id,
		name,
		kind: 'ast',
		isContainer: true,
		size: blob.size,
		format: 'AST',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = await bytesOnce();
			const file = parseAst(bytes);
			if (!file || file.decodableSamples <= 0) return [];
			return [
				{
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: 44 + file.decodableSamples * file.channelCount * 2,
					format: `WAV (${file.sampleRate} Hz, ${file.channelCount}ch${
						file.looped ? ' · loop' : ''
					})`,
					blob: async () => {
						const all = await bytesOnce();
						const parsed = parseAst(all);
						if (!parsed) return new Blob([]);
						const decoded = decodeAst(all, parsed);
						if (!decoded) return new Blob([]);
						return encodeWavBlob(
							decoded.samples,
							decoded.sampleRate,
							decoded.channelCount,
						);
					},
				},
			];
		},
	};
}

/**
 * A HAL HSDArchive.
 *
 * Presents each named root as a leaf, labelled with the type its name suffix
 * implies. A concatenated animation file — Melee's `Pl??AJ.dat`, up to 330
 * archives in one file — is grouped one directory per sub-archive so the tree
 * stays navigable.
 *
 * The roots themselves are not decoded. HSDArchive stores no type information,
 * so interpreting a root means hardcoding a struct layout and trusting the
 * naming convention to choose it; that belongs in a separate module built on
 * this one. What's here is the container, which is fully recoverable.
 */
async function makeHsdNode(id: string, name: string, blob: Blob): Promise<Node> {
	// HSDArchive has no magic, so the only way to know is to try. The header is
	// strongly self-validating (five counts that must describe a layout fitting
	// the declared size exactly), which is what makes claiming `.dat` tolerable.
	// Checking the first header costs one small read.
	const head = new Uint8Array(
		await blob.slice(0, Math.min(blob.size, 0x20)).arrayBuffer(),
	);
	if (!isHsdHeader(head, blob.size)) {
		// Not an archive: leave it exactly as it was before this entry existed.
		return genericFileNode(id, name, blob, detectFormat(name) || 'BIN');
	}

	let cached: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!cached) cached = blob.arrayBuffer().then((b) => new Uint8Array(b));
		return cached;
	};
	/**
	 * Repackage a recovered texture as a standalone BTI.
	 *
	 * BTI is just a 0x20 header over the same GX pixel data, and its data and
	 * palette offsets are relative to the header — so a texture can be handed to
	 * the existing, already-validated BTI decoder and preview by writing a
	 * header in front of it. That is far better than adding a second texture
	 * preview path that would need its own decoding and its own bugs.
	 */
	const toBti = (bytes: Uint8Array, image: HsdImage): Blob => {
		const paletteBytes = image.palette ? image.palette.count * 2 : 0;
		const out = new Uint8Array(0x20 + paletteBytes + image.dataSize);
		const view = new DataView(out.buffer);
		out[0x00] = image.format;
		out[0x01] = 0; // alphaMode
		view.setUint16(0x02, image.width, false);
		view.setUint16(0x04, image.height, false);
		out[0x06] = 0; // wrapS: clamp
		out[0x07] = 0; // wrapT
		out[0x08] = image.palette ? 1 : 0;
		out[0x09] = image.palette ? image.palette.format : 0;
		view.setUint16(0x0a, image.palette ? image.palette.count : 0, false);
		view.setUint32(0x0c, image.palette ? 0x20 : 0, false);
		out[0x18] = 1; // mipmapCount: BTI requires at least one
		view.setUint32(0x1c, 0x20 + paletteBytes, false);
		if (image.palette) {
			out.set(
				bytes.subarray(
					image.palette.offset,
					image.palette.offset + paletteBytes,
				),
				0x20,
			);
		}
		out.set(
			bytes.subarray(image.dataOffset, image.dataOffset + image.dataSize),
			0x20 + paletteBytes,
		);
		return new Blob([out as BlobPart]);
	};

	const imageLeaf = (
		parentId: string,
		bytes: Uint8Array,
		image: HsdImage,
	): Node => {
		const childName = `${image.name}.bti`;
		return {
			id: `${parentId}/${childName}`,
			name: childName,
			kind: 'file',
			isContainer: false,
			size: 0x20 + (image.palette ? image.palette.count * 2 : 0) + image.dataSize,
			format: `${image.width}x${image.height}${image.palette ? ' · paletted' : ''}`,
			blob: async () => toBti(bytes, image),
		};
	};

	/** Roots for one archive, with images upgraded to previewable textures. */
	const archiveChildren = (
		parentId: string,
		bytes: Uint8Array,
		archive: HsdArchive,
	): Node[] => {
		const images = hsdImages(bytes, archive);
		// Only offer a texture when it can actually be decoded. A paletted image
		// whose TLUT we failed to recover (about 6% of them) would otherwise
		// become a .bti that refuses to open — worse than showing it plainly as
		// the root it is.
		const byName = new Map(
			images
				.filter((i) => !gxFormatIsPaletted(i.format) || i.palette)
				.map((i) => [i.name, i]),
		);
		const unpalettedNames = new Set(
			images
				.filter((i) => gxFormatIsPaletted(i.format) && !i.palette)
				.map((i) => i.name),
		);
		return archive.roots.map((r) => {
			const image = byName.get(r.name);
			if (image) return imageLeaf(parentId, bytes, image);
			if (r.kind === 'scene graph') {
				const joints = hsdJoints(bytes, archive, r.dataOffset);
				// A root whose name ends in `_joint` isn't guaranteed to be one;
				// the walk only follows relocation-marked pointers, so a
				// non-joint yields a single node. Don't dress that up as a
				// skeleton.
				if (joints.length > 1) {
					const childId = `${parentId}/${r.name}`;
					const withGeometry = joints.filter((j) => j.displayObject).length;
					// Only offer a 3D preview when geometry actually resolves;
					// a skeleton with no drawable mesh shouldn't advertise one.
					const mesh = withGeometry > 0 ? hsdMesh(bytes, archive, joints) : null;
					return {
						id: childId,
						name: r.name,
						kind: 'directory',
						isContainer: true,
						format: `skeleton · ${joints.length} joints${
							withGeometry ? ` · ${withGeometry} with geometry` : ''
						}`,
						getChildren: async () => [
							...(mesh
								? [
										{
											id: `${childId}/model`,
											name: 'model',
											kind: 'file' as const,
											isContainer: false,
											size: 0,
											format: `${mesh.numVertices.toLocaleString()} verts · ${(
												mesh.indices.length / 3
											).toLocaleString()} tris`,
											meta: {
												hsdModel: {
													archiveIndex: archive.index,
													rootDataOffset: r.dataOffset,
												},
											},
											blob: async () => new Blob([bytes as BlobPart]),
										},
									]
								: []),
							...joints.map((j, i): Node => ({
								id: `${childId}/${i}`,
								// Indent by depth so the hierarchy reads at a glance;
								// joints are unnamed on disc.
								name: `${'· '.repeat(j.depth)}joint${i}`,
								kind: 'file',
								isContainer: false,
								size: 0,
								format: j.displayObject
									? `depth ${j.depth} · geometry`
									: `depth ${j.depth}`,
								blob: async () => new Blob([]),
							})),
						],
					};
				}
			}
			const leaf = rootLeaf(parentId, r);
			return unpalettedNames.has(r.name)
				? { ...leaf, format: `${leaf.format} · no palette found` }
				: leaf;
		});
	};

	const rootLeaf = (parentId: string, root: ReturnType<typeof hsdAllRoots>[number]): Node => ({
		id: `${parentId}/${root.name || `root${root.index}`}`,
		name: root.name || `root${root.index}`,
		kind: 'file',
		isContainer: false,
		size: 0,
		format: root.extern
			? `extern${root.kind ? ` · ${root.kind}` : ''}`
			: root.kind || 'root',
		blob: async () => new Blob([]),
	});
	return {
		id,
		name,
		kind: 'hsd',
		isContainer: true,
		size: blob.size,
		format: 'HSD',
		blob: async () => blob,
		getChildren: async () => {
			const file = parseHsdFile(await bytesOnce());
			if (!file) return [];
			void hsdAllRoots;
			// A single archive lists its roots directly; a chain gets one level
			// of grouping so hundreds of animations don't flood the tree.
			const bytes = await bytesOnce();
			if (file.archives.length === 1) {
				return archiveChildren(id, bytes, file.archives[0]);
			}
			return file.archives.map((archive): Node => {
				const label =
					archive.roots[0]?.name || `archive${archive.index}`;
				const childId = `${id}/${label}`;
				return childDirectoryNodeFor({
					id: childId,
					name: label,
					getChildren: async () =>
						archiveChildren(childId, bytes, archive),
				});
			});
		},
	};
}

// ----- HPS (HAL streamed audio) -----

/**
 * A HAL `.hps` music stream.
 *
 * Same shape as {@link makeAfcNode}: a container holding one decoded `.wav`, so
 * the original bytes stay downloadable from the parent while the existing audio
 * preview handles the child with no format-specific UI.
 *
 * The payload is DSP-ADPCM, so `@tootallnate/hps` only has to walk the block
 * chain and hand frames to the shared codec. Note that a looping track expresses
 * its loop by pointing the last block's `nextOffset` *backwards* rather than
 * terminating, so the decoded `.wav` is one pass through the chain.
 */
function makeHpsNode(id: string, name: string, blob: Blob): Node {
	const base = name.replace(/\.hps$/i, '') || 'stream';
	const childName = `${base}.wav`;
	let cached: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!cached) cached = blob.arrayBuffer().then((b) => new Uint8Array(b));
		return cached;
	};
	return {
		id,
		name,
		kind: 'hps',
		isContainer: true,
		size: blob.size,
		format: 'HPS',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = await bytesOnce();
			if (!isHps(bytes)) return [];
			const file = parseHps(bytes);
			if (!file) return [];
			return [
				{
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: 44 + file.sampleCount * file.channelCount * 2,
					format: `WAV (${file.sampleRate} Hz, ${file.channelCount}ch${
						file.looped ? ' · loop' : ''
					})`,
					blob: async () => {
						const all = await bytesOnce();
						const parsed = parseHps(all);
						if (!parsed) return new Blob([]);
						const decoded = decodeHps(all, parsed);
						if (!decoded) return new Blob([]);
						return encodeWavBlob(
							decoded.samples,
							decoded.sampleRate,
							decoded.channelCount,
						);
					},
				},
			];
		},
	};
}

/**
 * A HAL `.ssm` sound-sample bank.
 *
 * Expands to one `.wav` per sound, named by the bank-relative id the game uses.
 * Unlike `.hps` there's no single "track" to expose, so the container holds many
 * children rather than one.
 *
 * Deliberately extension-only, with no magic sniff: SSM has no magic number, and
 * `parseSsm` recognises it purely by whether the header's own numbers account for
 * the file. That's strong enough to validate a file we already believe is an SSM,
 * but too weak to go hunting with.
 */
function makeSsmNode(id: string, name: string, blob: Blob): Node {
	let cached: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!cached) cached = blob.arrayBuffer().then((b) => new Uint8Array(b));
		return cached;
	};
	return {
		id,
		name,
		kind: 'ssm',
		isContainer: true,
		size: blob.size,
		format: 'SSM',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = await bytesOnce();
			const bank = parseSsm(bytes);
			if (!bank) return [];
			return bank.sounds.map((sound): Node => {
				const childName = `${sound.id}.wav`;
				const rate = Math.max(1, Math.round(sound.sampleRate));
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: 44 + sound.sampleCount * sound.channelCount * 2,
					format: `WAV (${rate} Hz, ${sound.channelCount}ch)`,
					blob: async () => {
						const all = await bytesOnce();
						const parsed = parseSsm(all);
						const target = parsed?.sounds[sound.index];
						if (!target) return new Blob([]);
						const decoded = decodeSsmSound(all, target);
						if (!decoded) return new Blob([]);
						return encodeWavBlob(
							decoded.samples,
							decoded.sampleRate,
							decoded.channelCount,
						);
					},
				};
			});
		},
	};
}

// ----- AW (JAudio wave bank) -----

// ----- SEM (HAL sound-effect map) -----

/**
 * The `.ssm` bank each `smash2.sem` group belongs to, in group order.
 *
 * The map itself has no names in it — it is five arrays of integers — and the
 * banks on disc are just files, so nothing connects group 6 to `captain.ssm`
 * except this ordering. It comes from `lbl_803BBCFC` in `main.dol`, the array
 * of filenames `lbAudioAx` walks when it loads a bank, read through the DOL's
 * section table. All 55 name a file that is really on the disc.
 *
 * Region- and build-specific, like {@link MTH_AUDIO_PAIRS}. A disc whose group
 * count doesn't match simply goes unlabelled rather than mislabelled.
 */
const SEM_BANK_NAMES: readonly string[] = [
	'main.ssm', 'pokemon.ssm', 'nr_title.ssm', 'nr_select.ssm', 'nr_1p.ssm',
	'nr_vs.ssm', 'captain.ssm', 'clink.ssm', 'dk.ssm', 'drmario.ssm',
	'falco.ssm', 'fox.ssm', 'gkoopa.ssm', 'ice.ssm', 'kirby.ssm', 'koopa.ssm',
	'link.ssm', 'luigi.ssm', 'mario.ssm', 'mars.ssm', 'mewtwo.ssm', 'ness.ssm',
	'peach.ssm', 'pichu.ssm', 'pikachu.ssm', 'purin.ssm', 'samus.ssm',
	'zs.ssm', 'yoshi.ssm', 'gw.ssm', 'ganon.ssm', 'emblem.ssm', 'mhands.ssm',
	'kirbytm.ssm', 'castle.ssm', 'corneria.ssm', 'greatbay.ssm', 'kongo.ssm',
	'mutecity.ssm', 'onett.ssm', 'zebes.ssm', 'garden.ssm', 'klaid.ssm',
	'greens.ssm', 'venom.ssm', 'bigblue.ssm', 'fourside.ssm', 'pupupu.ssm',
	'pstadium.ssm', '1padv.ssm', 'ending.ssm', 'nr_name.ssm', '1pend.ssm',
	'last.ssm', 'end.ssm',
];

/**
 * A HAL sound-effect map (`smash2.sem`).
 *
 * Browsed as its groups, because the grouping is the whole point: a group is
 * one `.ssm` bank's worth of sound effects, and that correspondence exists
 * nowhere else. A group holds at least as many effects as its bank has samples
 * — 528 against 246 for `main.ssm` — since several effects can play the same
 * sample with different parameters; for the simpler banks the two are equal.
 *
 * The effect entries themselves are left as bytes. They are short, variable
 * length parameter blocks, and nothing here decodes them, so presenting them as
 * anything more structured than a byte range would be inventing detail.
 */
function makeSemNode(id: string, name: string, blob: Blob): Node {
	return {
		id,
		name,
		kind: 'sem',
		isContainer: true,
		size: blob.size,
		format: 'SEM',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const groups = parseSem(bytes);
			if (!groups) return [];
			const named = groups.length === SEM_BANK_NAMES.length;
			return groups.map((group) => {
				const slot = String(group.index).padStart(2, '0');
				const bank = named ? SEM_BANK_NAMES[group.index] : '';
				const groupName = bank ? `${slot} ${bank}` : slot;
				const groupId = `${id}/${groupName}`;
				return childDirectoryNodeFor({
					id: groupId,
					name: groupName,
					size: group.sounds.reduce((a, s) => a + s.size, 0),
					getChildren: async () =>
						group.sounds.map((sound) => {
							const childName = `sfx${String(sound.index).padStart(4, '0')}.bin`;
							return {
								id: `${groupId}/${childName}`,
								name: childName,
								kind: 'file' as const,
								isContainer: false,
								size: sound.size,
								format: 'SEM entry',
								blob: async () =>
									blob.slice(sound.offset, sound.offset + sound.size),
							};
						}),
				});
			});
		},
	};
}

// ----- BSFT / BSTN (JAudio sound tables) -----

/**
 * A JAudio `bsft`: the table of streams a game's music ids resolve to.
 *
 * Presented as the 50 music slots rather than as one blob, because that is what
 * the table *is* — an ordered mapping, with several slots deliberately sharing
 * a track. Each child plays: the paths are disc-relative, so the real `.ast`
 * can be handed straight over and the existing AST support takes it from there.
 *
 * Slots are labelled from the sibling `.bstn` when one is around, which turns
 * `COURSE_BEACH_0` into `JA_STRM_PEACH` and `JA_STRM_DAISY` — two slots, one
 * track, which is exactly right for a course two characters share. The index
 * prefix stays regardless so duplicate tracks remain distinguishable.
 */
function makeBsftNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	siblings: SiblingMap | undefined,
): Node {
	return {
		id,
		name,
		kind: 'bsft',
		isContainer: true,
		size: blob.size,
		format: 'BSFT',
		blob: async () => blob,
		getChildren: async () => {
			const paths = parseBsft(new Uint8Array(await blob.arrayBuffer()));
			if (!paths) return [];
			const labels = await bstnStreamNames(siblings);
			const out: Node[] = [];
			for (let i = 0; i < paths.length; i++) {
				const base = paths[i].split('/').pop() ?? paths[i];
				const target = siblings?.get(base.toLowerCase());
				const slot = String(i).padStart(2, '0');
				const label = labels[i] ? `${slot} ${labels[i]}` : slot;
				const childName = `${label} ${base}`;
				if (!target) {
					// A shared table can name a stream this region doesn't ship;
					// saying so is more use than dropping the slot silently.
					out.push({
						id: `${id}/${childName}`,
						name: childName,
						kind: 'file',
						isContainer: false,
						size: 0,
						format: 'BSFT slot (stream not on this disc)',
						blob: async () => new Blob([]),
					});
					continue;
				}
				out.push(
					await childNodeFor(`${id}/${childName}`, childName, target, ctx),
				);
			}
			return out;
		},
	};
}

/** Stream slot names from a sibling `.bstn`, or an empty list if there isn't one. */
async function bstnStreamNames(
	siblings: SiblingMap | undefined,
): Promise<string[]> {
	if (!siblings) return [];
	for (const [key, candidate] of siblings) {
		if (!key.endsWith('.bstn')) continue;
		try {
			const types = parseBstn(new Uint8Array(await candidate.arrayBuffer()));
			const stream = types?.find((t) => t.name === 'TYPE_STREAM');
			if (stream) return stream.categories.flatMap((c) => c.sounds);
		} catch {
			// Fall through to unlabelled slots.
		}
	}
	return [];
}

/**
 * A JAudio `BSTN`: every sound name the game knows, in its own categories.
 *
 * Nothing else on the disc carries these. Waveforms are indexed numerically all
 * the way down, so without this table `SE_VOICE` is 821 anonymous sounds. They
 * can't be attached to the waves themselves — a sound id reaches audio through
 * an instrument bank rather than naming a wave — so the table is presented as
 * what it is, a catalogue, one text listing per category.
 */
function makeBstnNode(id: string, name: string, blob: Blob): Node {
	let cached: Promise<BstnType[] | null> | null = null;
	const parseOnce = () => {
		if (!cached) {
			cached = (async () =>
				parseBstn(new Uint8Array(await blob.arrayBuffer())))();
		}
		return cached;
	};
	return {
		id,
		name,
		kind: 'bstn',
		isContainer: true,
		size: blob.size,
		format: 'BSTN',
		blob: async () => blob,
		getChildren: async () => {
			const types = await parseOnce();
			if (!types) return [];
			return types.map((type) => {
				const typeId = `${id}/${type.name}`;
				const total = type.categories.reduce(
					(a, c) => a + c.sounds.length,
					0,
				);
				return childDirectoryNodeFor({
					id: typeId,
					name: type.name,
					size: total,
					getChildren: async () =>
						type.categories.map((cat) => {
							const childName = `${cat.name}.txt`;
							const text = `${cat.sounds.join('\n')}\n`;
							return {
								id: `${typeId}/${childName}`,
								name: childName,
								kind: 'file' as const,
								isContainer: false,
								size: text.length,
								format: `${cat.sounds.length} sound names`,
								blob: async () =>
									new Blob([text], { type: 'text/plain' }),
							};
						}),
				});
			});
		},
	};
}

/**
 * How each wave format is shown in the tree. 4-bit AFC is the default and by
 * far the most common, so it goes unlabelled — calling it out on ~90% of rows
 * would be noise. The others are worth surfacing because they are the cases
 * where a decode bug would otherwise be silent.
 */
const WSYS_FORMAT_LABEL: Record<number, string> = {
	[WsysWaveFormat.AFC_2BIT]: 'AFC 2-bit',
	[WsysWaveFormat.PCM8]: 'PCM8',
	[WsysWaveFormat.PCM16]: 'PCM16',
};

/**
 * A JAudio `.aw` wave bank.
 *
 * An `.aw` is the one format here that genuinely cannot be understood on its
 * own: it is headerless AFC waveform data with no index, no count, and no
 * names. Everything needed to cut it into individual sounds — each wave's byte
 * range, sample rate, base key and loop points — lives in a `WSYS` inside a
 * sibling `.aaf`. On a Wind Waker disc that's `Audiores/JaiInit.aaf`, sitting
 * next to the `Audiores/Banks/` directory the `.aw` files are in. A Sunshine
 * disc has no such file anywhere; {@link addEmbeddedJaudioIndex} lifts its
 * index out of the boot archive beforehand, so by the time we get here it
 * looks like any other sibling.
 *
 * So we look for that sibling. If one is in reach, the bank expands into one
 * `.wav` per wave, named by wave id and correctly resampled. If none is, the
 * node stays a plain leaf whose format says why — an `.aw` without its index
 * really is opaque, and presenting it as a directory that then turns out to be
 * empty would wrongly suggest the file itself was empty.
 *
 * The waveform payload is AFC, the same codec as `.afc` music streams, which is
 * why this reuses `@tootallnate/afc` rather than introducing a second decoder.
 */
function makeAwNode(
	id: string,
	name: string,
	blob: Blob,
	siblings: SiblingMap | undefined,
): Node {
	// Whether an index *could* exist is answerable without any I/O — it's a
	// lookup over sibling names. We check it up front because `isContainer` has
	// to be decided when the node is built, and an `.aw` with no index in reach
	// should present as the opaque blob it is rather than as a directory that
	// mysteriously turns out to be empty.
	const hasIndexCandidate = (() => {
		if (!siblings) return false;
		for (const key of siblings.keys()) {
			if (key.endsWith('.aaf') || key.endsWith('.baa')) return true;
		}
		return false;
	})();

	if (!hasIndexCandidate) {
		return {
			id,
			name,
			kind: 'file',
			isContainer: false,
			size: blob.size,
			format: 'AW (no .aaf index alongside)',
			blob: async () => blob,
		};
	}

	let cached: Promise<WsysGroup | null> | null = null;

	/** Locate and parse the sibling index, once. */
	const groupOnce = () => {
		if (!cached) {
			cached = (async () => {
				if (!siblings) return null;
				// JAudio archives are `.aaf` (Wind Waker, Sunshine) or `.baa`
				// (Twilight Princess, Pikmin). There's normally exactly one.
				for (const [key, indexBlob] of siblings) {
					if (!key.endsWith('.aaf') && !key.endsWith('.baa')) continue;
					try {
						const aaf = parseAaf(
							new Uint8Array(await indexBlob.arrayBuffer()),
						);
						if (!aaf) continue;
						const group = findWaveGroupForAw(aaf, name);
						if (group) return group;
					} catch {
						// Try the next candidate index.
					}
				}
				return null;
			})();
		}
		return cached;
	};

	return {
		id,
		name,
		kind: 'aw',
		isContainer: true,
		size: blob.size,
		format: 'AW',
		blob: async () => blob,
		getChildren: async () => {
			const group = await groupOnce();
			if (!group) return [];
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const out: Node[] = [];
			for (const wave of group.waves) {
				// `size` is authoritative: a minority of waves declare a
				// `sampleCount` larger than their bytes can supply, and trusting
				// that would read into the next wave.
				const samples = wsysWaveDecodableSamples(wave);
				if (samples <= 0) continue;
				if (wave.start + wave.size > bytes.length) continue;
				const label = wave.id >= 0 ? `${wave.id}` : `idx${wave.index}`;
				const childName = `${label}.wav`;
				const rate = Math.max(1, Math.round(wave.sampleRate));
				out.push({
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: 44 + samples * 2,
					format: `WAV (${rate} Hz${
						WSYS_FORMAT_LABEL[wave.format]
							? ` · ${WSYS_FORMAT_LABEL[wave.format]}`
							: ''
					}${wave.looped ? ' · loop' : ''})`,
					meta: { awBaseKey: wave.baseKey },
					blob: async () => {
						// The format byte matters: a bank mixes all of these,
						// and decoding one as another produces heavily clipped
						// noise rather than an obvious failure. The two AFC
						// variants differ only in block size, which is the
						// value `AfcVariant` is keyed by.
						const pcm =
							decodeWsysPcm8(bytes, wave, 0) ??
							decodeWsysPcm16(bytes, wave, 0) ??
							decodeAfc(
								bytes,
								wave.start,
								wave.size,
								wsysWaveAfcBlockSize(wave.format) ||
									AfcVariant.HQ_4BIT,
								samples,
							);
						if (!pcm) return new Blob([]);
						return encodeWavBlob(pcm, rate, 1);
					},
				});
			}
			return out;
		},
	};
}

// ----- THP (GameCube / Wii video) -----

/**
 * A THP video.
 *
 * Like {@link makeAfcNode} this is a container rather than a leaf, so the
 * original bytes stay downloadable from the parent while the decoded audio
 * track hangs off it as a playable `.wav`.
 *
 * Deliberately *not* exposed: the individual frames. A THP is intra-only, so
 * every frame is a standalone JPEG and it would be technically easy to list
 * them — but a 70-second clip is over 2000 frames, and burying the tree under
 * that many nodes to look at one thumbnail is a bad trade. The video preview
 * reads frames directly instead.
 */
/**
 * A `.thp` file, which is not always a video.
 *
 * Melee ships 75 files with a `.thp` extension and not one of them is a THP
 * container: every one begins `FF D8 FF FE` — a JPEG start-of-image followed by
 * a comment segment — and they are single congratulation-screen stills. Sunshine
 * and Double Dash, by contrast, use the extension for real containers.
 *
 * So the extension is checked against the magic before promising a video
 * player, exactly as `icon_*.dat` is already treated as the JPEG it is rather
 * than the `.dat` it claims to be. Offering a player for a still leaves the pane
 * spinning on a decode that cannot succeed.
 *
 * Identifying them is only half of it. They are THP-dialect JPEGs, so their
 * entropy data is not byte-stuffed and no compliant decoder will read them —
 * `ffmpeg` rejects a retail still with `overread 8, bits 107 is invalid`, and a
 * browser fails the same way. The dimensions parse from the header either way,
 * which is what makes the breakage look like a rendering problem rather than a
 * decoding one. So the bytes handed on are re-stuffed, which also means the
 * download button yields a file that opens anywhere.
 */
async function makeThpNode(
	id: string,
	name: string,
	blob: Blob,
): Promise<Node> {
	const head = new Uint8Array(
		await blob.slice(0, Math.min(blob.size, 3)).arrayBuffer(),
	);
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
		return {
			...genericFileNode(id, name, blob, 'JPEG'),
			// Tagged rather than renamed: the preview pane routes on `kind` when a
			// filename can't be trusted, and the name is what's on the disc.
			kind: 'jpeg-still',
			// Re-stuffed lazily. Doing it here rather than in the preview keeps the
			// fix on the download path too, and doing it lazily keeps expanding a
			// directory of 75 stills from reading all of them.
			blob: async () => {
				const raw = new Uint8Array(await blob.arrayBuffer());
				const fixed = thpRestuffJpeg(raw);
				// If the structure can't be walked, hand back what was there rather
				// than nothing.
				return fixed ? new Blob([fixed as BlobPart]) : blob;
			},
		};
	}
	return {
		id,
		name,
		// Deliberately a leaf, not a container. The preview pane only resolves a
		// `PreviewKind` for non-container nodes (`isFile = !node.isContainer`), so
		// making this expandable would replace the video player with a directory
		// listing. The audio is muxed into the preview's MP4 anyway, which is why
		// there's nothing worth expanding into.
		kind: 'thp',
		isContainer: false,
		size: blob.size,
		format: 'THP',
		blob: async () => blob,
	};
}

/**
 * Which `.hps` stream accompanies a movie.
 *
 * MTH carries no audio, but the game plays music over these movies and it lives
 * in `audio/` as an ordinary HPS stream. Nothing in either file links them, so
 * the association comes from the game's own code rather than from the data.
 *
 * Each movie is started next to a music request, and the id passed is an index
 * into a table of all 99 `.hps` filenames that `main.dol` holds at `0x3b8ddc`
 * (4-byte aligned, alphabetical). Resolving the two together gives the mapping
 * outright (`doldecomp/melee`):
 *
 *   gmopening.c:179    lbAudioAx_80023F28(0x3E)  ->  [62] opening.hps
 *   gmhowto.c:44       lbAudioAx_80023F28(0x24)  ->  [36] howto.hps
 *   gmomake15.c:33     lbAudioAx_80023F28(0x52)  ->  [82] swm_15min.hps
 *   gmmovieend.c:129   lbAudioAx_80023F28(gm_803DB25C[char])
 *
 * That last one is a per-character lookup, which is the interesting case: the
 * movie filenames sit in `gm_803DB1F4[0x1A]` and the music ids in a parallel
 * `gm_803DB25C[0x1A]`, so each of the 26 roster slots could in principle have
 * its own theme. Every entry is `8`, so all 25 distinct ending films share
 * `ending.hps` — worth reading rather than assuming, since the array shape
 * invites the opposite conclusion. (26 slots for 25 files because Zelda and
 * Sheik name the same movie.)
 *
 * An earlier version of this table guessed the same four pairings from filename
 * similarity. It happened to be right, which is precisely why it was worth
 * replacing: nothing in the guess distinguished it from being wrong, and
 * duration proximity actively misleads here — the stream nearest `MvHowto` in
 * length is `bigblue`, an F-Zero stage theme.
 */
/**
 * Frame-pacing schedules for the two movies that use one.
 *
 * `lbMthp_8001F410(filename, rate_table, ...)` takes the schedule as an
 * argument, so it lives in the executable rather than in the movie. Twenty-six
 * of the 28 films pass null and run at one frame per display tick; these two do
 * not, and playing them at a constant rate is what makes their audio drift
 * further behind as they go — how-to-play holds single frames for 19, 85 and 101
 * ticks while narration runs over a still screen.
 *
 * Read out of `main.dol` at the addresses the call sites pass — `gm_803DBFB4`
 * and `gm_803DD2C0` — and each one checks out against its music: the opening
 * comes to 5,678 ticks, 94.7s at 59.94 Hz against 94.0s of `opening.hps`, and
 * how-to-play to 4,760 ticks, 79.4s against 81.0s of `howto.hps`. Both within
 * two percent, where a constant rate is out by a factor of two.
 *
 * Being executable data, these are specific to this build of the game. A
 * different region would need its own, which is why they are named per file and
 * simply absent for anything unrecognised — an unknown movie falls back to one
 * frame per tick rather than borrowing a schedule that isn't its own.
 */
const MTH_RATE_TABLES: Array<{
	match: RegExp;
	table: ReadonlyArray<readonly [number, number]>;
}> = [
	{ match: /^MvOpen\.mth$/i, table: [[1250, 2], [394, 1], [65536, 2]] },
	{
		match: /^MvHowto\.mth$/i,
		table: [
			[1, 19], [856, 1], [1, 85], [279, 1], [1, 59], [17, 1], [1, 59],
			[19, 1], [1, 59], [35, 1], [1, 27], [37, 1], [1, 59], [43, 1],
			[1, 59], [39, 1], [1, 59], [499, 1], [1, 67], [892, 1], [240, 2],
			[63, 1], [1, 77], [67, 1], [1, 67], [23, 1], [1, 71], [51, 1],
			[1, 59], [25, 1], [1, 87], [53, 1], [1, 95], [59, 1], [1, 101],
			[117, 1],
		],
	},
];

const MTH_AUDIO_PAIRS: Array<{ match: RegExp; hps: string }> = [
	{ match: /^MvOpen\.mth$/i, hps: 'opening.hps' },
	{ match: /^MvHowto\.mth$/i, hps: 'howto.hps' },
	{ match: /^MvOmake15\.mth$/i, hps: 'swm_15min.hps' },
	// All 25 character endings share the one congratulations theme.
	{ match: /^MvEnd[A-Za-z0-9]+\.mth$/i, hps: 'ending.hps' },
];

/**
 * A `.mth` movie: Melee's video container.
 *
 * A leaf for the same reason `.thp` is — the preview pane only resolves a
 * `PreviewKind` for non-containers, so making this expandable would trade the
 * player for a directory listing.
 *
 * The container declares no audio track, so the accompanying stream is looked up
 * among the disc's siblings; see {@link MTH_AUDIO_PAIRS} for how confident that
 * pairing is. When it isn't found the movie simply plays silent, as it did
 * before.
 */
function makeMthNode(
	id: string,
	name: string,
	blob: Blob,
	siblings?: SiblingMap,
): Node {
	const pair = MTH_AUDIO_PAIRS.find((p) => p.match.test(name));
	const rate = MTH_RATE_TABLES.find((r) => r.match.test(name));
	const audioBlob = pair && siblings ? siblings.get(pair.hps.toLowerCase()) : undefined;
	return {
		id,
		name,
		kind: 'mth',
		isContainer: false,
		size: blob.size,
		format: 'MTH',
		blob: async () => blob,
		meta: {
			...(audioBlob
				? { mthAudioName: pair!.hps, mthAudioBlob: audioBlob }
				: pair
					? { mthAudioMissing: pair.hps }
					: {}),
			...(rate ? { mthRateTable: rate.table } : {}),
		},
	};
}

// ----- `.arc` (ambiguous: RARC or SARC) -----

/**
 * A `.arc` file, whose container type is decided when it's expanded.
 *
 * `.arc` is claimed by two unrelated formats: Nintendo's GameCube/Wii **RARC**
 * (Wind Waker, Twilight Princess, Mario Sunshine) and, as an alias, the Switch
 * era's **SARC** (Pokémon Legends: Arceus, Pokkén, RE0/1 rebuilds). They are
 * told apart only by magic, and RARC additionally shows up Yaz0-wrapped.
 *
 * The decision is deferred to `getChildren` on purpose. Deciding it while
 * building a directory listing would mean one header read per file, and a
 * GameCube disc holds over a thousand `.arc`s in a single directory — each read
 * inflating a 128 KiB compressed chunk. Deferring makes listing free and moves
 * the single read to the moment the user actually opens one.
 */
function makeArcNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	siblings?: SiblingMap,
): Node {
	return {
		id,
		name,
		// Reported as RARC because that's what `.arc` is on every disc-based
		// platform this node is reachable from; the *content* dispatch below is
		// magic-driven either way, so a SARC still opens correctly.
		kind: 'rarc',
		isContainer: true,
		size: blob.size,
		format: 'ARC',
		blob: async () => blob,
		getChildren: async () => {
			const head = new Uint8Array(
				await blob.slice(0, 4).arrayBuffer(),
			);
			const magic = new TextDecoder().decode(head);
			if (magic === 'RARC') {
				const archive = parseRarc(new Uint8Array(await blob.arrayBuffer()));
				return archive
					? rarcChildren(id, archive, archive.root, ctx)
					: [];
			}
			if (magic === 'Yaz0') {
				// Yaz0-wrapped, which is the majority case on a Wind Waker
				// disc. Decompress, then re-dispatch on the inner magic.
				const inner = await decompressYaz0(blob);
				const innerBytes = new Uint8Array(await inner.arrayBuffer());
				const archive = parseRarc(innerBytes);
				if (archive) return rarcChildren(id, archive, archive.root, ctx);
				try {
					const parsed = await parseSarc(inner);
					return sarcEntriesToNodes(id, parsed.entries, ctx);
				} catch {
					return [];
				}
			}
			try {
				const parsed = await parseSarc(blob);
				return sarcEntriesToNodes(id, parsed.entries, ctx);
			} catch {
				// Not any kind of self-describing archive. On a JAudio disc
				// that's expected for a sequence archive, which is a bare
				// concatenation of BMS streams indexed from the `.aaf`.
				return sequenceArchiveChildren(id, name, blob, siblings);
			}
		},
	};
}

/**
 * Split a JAudio sequence archive using the `BARC` index from a sibling `.aaf`.
 *
 * `sequence.arc` is named like an archive but is not one — no magic, no
 * directory, just BMS streams butted together. Every other branch above has
 * already failed by the time we get here, and the honest alternative is an
 * empty container, which reads as "this file is empty" rather than "we can't
 * see inside it".
 *
 * The index has to name *this* file: an AAF can carry only one `BARC`, so
 * matching `archiveName` is what stops a disc with several sequence archives
 * from having them all cut up by the wrong table.
 */
async function sequenceArchiveChildren(
	id: string,
	name: string,
	blob: Blob,
	siblings: SiblingMap | undefined,
): Promise<Node[]> {
	if (!siblings) return [];
	for (const [key, indexBlob] of siblings) {
		if (!key.endsWith('.aaf') && !key.endsWith('.baa')) continue;
		try {
			const bytes = new Uint8Array(await indexBlob.arrayBuffer());
			const aaf = parseAaf(bytes);
			if (!aaf) continue;
			const barc = aafSequenceIndex(aaf, bytes);
			if (!barc) continue;
			if (barc.archiveName.toLowerCase() !== name.toLowerCase()) continue;
			return barc.entries
				.filter((e) => e.size > 0 && e.offset + e.size <= blob.size)
				.map((e) => {
					// The stored names have no extension; `.bms` is what the
					// sequence format is universally called.
					const childName = `${e.name || `seq${e.index}`}.bms`;
					return {
						id: `${id}/${childName}`,
						name: childName,
						kind: 'file' as const,
						isContainer: false,
						size: e.size,
						format: 'BMS (JAudio sequence)',
						blob: async () => blob.slice(e.offset, e.offset + e.size),
					};
				});
		} catch {
			// Try the next candidate index.
		}
	}
	return [];
}

// ----- AFC (GameCube streamed audio) -----

/**
 * An AFC stream.
 *
 * AFC has no magic number — it's a bare 0x20-byte header over ADPCM blocks —
 * so this is reached by extension only. Never add it to the magic sniffer, or
 * every headerless file on a disc becomes a candidate.
 *
 * We model it as a container with a single decoded `.wav` child rather than
 * swapping the leaf's own bytes for the decoded audio. That keeps the original
 * downloadable from the parent, and lets the existing audio preview handle the
 * child with no format-specific UI — the same shape the emulated NES capture
 * node uses.
 *
 * The channel count isn't stored in the header; `@tootallnate/afc` recovers it
 * from the payload size, which is also what validates the header.
 */
function makeAfcNode(id: string, name: string, blob: Blob): Node {
	const base = name.replace(/\.afc$/i, '') || 'stream';
	const childName = `${base}.wav`;
	let cached: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!cached) {
			cached = blob.arrayBuffer().then((b) => new Uint8Array(b));
		}
		return cached;
	};
	return {
		id,
		name,
		kind: 'afc',
		isContainer: true,
		size: blob.size,
		format: 'AFC',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = await bytesOnce();
			const header = parseAfcStreamHeader(bytes);
			if (!header) return [];
			return [
				{
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					// A WAV of the decoded stream: 16-bit, header.channelCount channels.
					size:
						44 +
						header.sampleCount * header.channelCount * 2,
					format: `WAV (${header.sampleRate} Hz, ${header.channelCount}ch)`,
					blob: async () => {
						const decoded = decodeAfcStream(await bytesOnce());
						if (!decoded) return new Blob([]);
						return encodeWavBlob(
							decoded.samples,
							decoded.sampleRate,
							decoded.channelCount,
						);
					},
				},
			];
		},
	};
}

// ----- RARC (GameCube / Wii JSystem archive) -----

/**
 * A Nintendo RARC archive.
 *
 * Unlike SARC (whose entries are slash-delimited paths that we have
 * to re-tree), RARC already stores a real directory graph — nodes
 * plus per-node entry ranges — so we can map it straight across
 * without reconstructing anything.
 *
 * Two kinds of compression show up and they're independent:
 *
 *   1. The whole `.arc` is Yaz0-compressed. That's the common case on
 *      the Wind Waker disc (640 of 1321), and those files arrive here
 *      via {@link makeSzsNode}, which unwraps the Yaz0 and re-sniffs.
 *   2. An *individual entry* inside an otherwise-plain RARC is Yaz0
 *      (or the older Yay0) compressed, flagged per entry. We
 *      decompress those when the containing directory is expanded so
 *      that a compressed `.bdl` still gets recognised as a model
 *      rather than showing up as an opaque `Yaz0` blob.
 *
 * (2) is eager-per-directory rather than lazy-per-file because
 * `childNodeFor` needs real bytes in hand to sniff the inner format.
 * That's cheap in practice: compressed entries average under two per
 * archive across the whole disc.
 */
function makeRarcNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	let cached: Promise<RarcArchive | null> | null = null;
	const parseOnce = () => {
		if (!cached) {
			cached = (async () => {
				const bytes = new Uint8Array(await blob.arrayBuffer());
				return parseRarc(bytes);
			})();
		}
		return cached;
	};
	return {
		id,
		name,
		kind: 'rarc',
		isContainer: true,
		size: blob.size,
		format: 'RARC',
		blob: async () => blob,
		getChildren: async () => {
			const archive = await parseOnce();
			if (!archive) return [];
			return rarcChildren(id, archive, archive.root, ctx);
		},
	};
}

/**
 * Map one RARC directory node to `Node` children, recursing lazily
 * into subdirectories.
 */
async function rarcChildren(
	parentId: string,
	archive: RarcArchive,
	dir: RarcNode,
	ctx: ArchiveContext,
): Promise<Node[]> {
	const entries = archive.readDir(dir);
	// Directories first, then human-friendly name order — matching how
	// every other container in here sorts.
	const sorted = [...entries].sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return humanCompare(a.name, b.name);
	});
	return Promise.all(
		sorted.map(async (entry): Promise<Node> => {
			const childId = `${parentId}/${entry.name}`;
			if (entry.isDir) {
				const sub = archive.nodes[entry.nodeIndex];
				return childDirectoryNodeFor({
					id: childId,
					name: entry.name,
					getChildren: async () =>
						sub ? rarcChildren(childId, archive, sub, ctx) : [],
				});
			}
			const raw = archive.read(entry);
			if (!raw) {
				// Entry points outside the archive — surface it as an
				// empty file rather than dropping it, so the tree still
				// reflects what the archive claims to contain.
				return {
					id: childId,
					name: entry.name,
					kind: 'file',
					isContainer: false,
					size: 0,
					format: detectFormat(entry.name) || 'BIN',
					blob: async () => new Blob([]),
				};
			}
			let data: Blob = new Blob([raw as BlobPart]);
			if (entry.compression === 'yaz0') {
				try {
					data = await decompressYaz0(data);
				} catch {
					// Leave it compressed; the user can still download
					// it and the format badge will say Yaz0.
				}
			}
			return childNodeFor(childId, entry.name, data, ctx);
		}),
	);
}

// ----- SZS / Yaz0 -----

/**
 * SZS = a Yaz0-compressed archive. Usually SARC on Switch-era titles, but just
 * as often RARC on GameCube ones — Super Mario Sunshine's `.szs` are Yaz0+RARC.
 * We decompress lazily on first child request and dispatch on the inner magic,
 * exposing that archive's tree directly so the user doesn't see a redundant
 * `.szs → .sarc` indirection. The label stays neutral because which of the two
 * it is isn't known until it's opened.
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
		format: 'SZS (Yaz0)',
		// Downloading an SZS gives you the *decompressed* payload — that's
		// almost always what someone actually wants (e.g. drop into an
		// external SARC tool).
		blob: decompressOnce,
		getChildren: async () => {
			const inner = await decompressOnce();
			// Yaz0+RARC is as common as Yaz0+SARC once you leave the
			// Switch behind — it's how nearly every GameCube JSystem
			// archive ships. Expose its tree directly for the same
			// reason we do for SARC: nobody wants a redundant
			// `.arc → .arc` indirection in the tree.
			const innerHead = new Uint8Array(
				await inner.slice(0, 4).arrayBuffer(),
			);
			if (new TextDecoder().decode(innerHead) === 'RARC') {
				const archive = parseRarc(
					new Uint8Array(await inner.arrayBuffer()),
				);
				if (archive) {
					return rarcChildren(id, archive, archive.root, ctx);
				}
			}
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
/**
 * Make a Square Enix SEAD audio container node (`.sab` /
 * `.mab` / `.sab.bytes` / `.mab.bytes`).
 *
 * Exposes each contained audio stream as a child node with
 * a synthetic filename based on the codec:
 *   `<index>_<name>.hca`    — for HCA streams (most common)
 *   `<index>_<name>.ogg`    — for Ogg Vorbis (browser-playable directly)
 *   `<index>_<name>.bin`    — for codecs we don't have downstream
 *                             decoders for yet (ATRAC9, XMA2, etc.)
 */
function makeSeadAudioNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	return {
		id,
		name,
		kind: 'sead-audio',
		isContainer: true,
		size: blob.size,
		format: 'SEAD',
		blob: async () => blob,
		getChildren: async () => {
			const { parseSead } = await import('@tootallnate/sead-audio');
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const sead = parseSead(bytes);
			void ctx;
			const out: Node[] = [];
			for (const m of sead.materials) {
				const safeName = m.name.replace(/[^\w.-]/g, '_');
				let ext = 'bin';
				// Pick which byte slice to expose, and synthesize a
				// filename whose extension matches the codec so the
				// downstream preview routes correctly (.hca, .ogg, or
				// a generic .bin fallback for codecs we don't decode
				// yet — ATRAC9, XMA2, etc.).
				let payload: Uint8Array = m.streamData;
				const extras = m.extras as { codec: string; decryptedHca?: Uint8Array };
				if (extras.codec === 'hca' && extras.decryptedHca) {
					ext = 'hca';
					payload = extras.decryptedHca;
				} else if (extras.codec === 'ogg-vorbis') {
					ext = 'ogg';
				}
				const buf = new ArrayBuffer(payload.byteLength);
				new Uint8Array(buf).set(payload);
				const childBlob = new Blob([buf]);
				const childName = `${safeName}.${ext}`;
				const cid = `${id}/${childName}`;
				out.push(
					await childNodeFor(cid, childName, childBlob, ctx, {
						skipMagicSniff: true,
					}),
				);
			}
			return out;
		},
	};
}

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

/**
 * Make a `.ddsz` (LZ4-compressed DDS) leaf node. Used by FFVIII
 * Switch Remastered for its HD texture overrides — 12,181 of
 * them, each an LZ4-block-compressed DDS file.
 *
 * The on-disk layout (per AnalogMan151/DDSZ_Tool):
 *   [u32 fileSize]                ← whole-file size, redundant
 *   [u32 uncompressedSize]         ← prepended by python lz4.block
 *   [LZ4 block stream]             ← rest of file
 *
 * We expose `.blob()` as the decompressed DDS payload and tag
 * the node with `meta.ddsz = true` so the preview pane routes
 * to the DDS image preview without re-detecting the extension
 * (which would still see `.ddsz`).
 */
function makeDdszNode(
	id: string,
	name: string,
	blob: Blob,
	_ctx: ArchiveContext,
): Node {
	let cached: Promise<Blob> | null = null;
	const decompressOnce = (): Promise<Blob> => {
		if (cached) return cached;
		cached = (async () => {
			const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
			const uncompressedSize =
				head[4]! | (head[5]! << 8) | (head[6]! << 16) | (head[7]! << 24);
			const lz4Bytes = new Uint8Array(
				await blob.slice(8).arrayBuffer(),
			);
			const out = decodeBlock(lz4Bytes, uncompressedSize);
			const buf = new ArrayBuffer(out.byteLength);
			new Uint8Array(buf).set(out);
			return new Blob([buf]);
		})();
		return cached;
	};
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: blob.size,
		format: 'DDSZ',
		meta: { ddsz: true },
		blob: async () => decompressOnce(),
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

interface ChildNodeForOptions {
	tikMap?: TikMap;
	siblings?: SiblingMap;
	/**
	 * Skip the bottom magic-sniff fallback that fires for files
	 * whose extension doesn't match any known container.
	 *
	 * Why this exists: the sniff reads ~12 bytes from each blob,
	 * which is normally cheap. But for containers whose child
	 * Blobs are lazy decompression facades (e.g. a VBF with
	 * 35,000 entries where each leaf is a zlib-chunked
	 * VbfChunkBlob), every "cheap" 12-byte read forces inflation
	 * of a full 64 KiB chunk. Multiplied across 35k children
	 * that's ~2 GB of memory churn that locks up the renderer.
	 *
	 * Containers populated with leaf data files (textures,
	 * sounds, configs) can safely opt out — the dispatcher
	 * still honours known extensions like `.nca` / `.sarc` /
	 * `.zip`, just doesn't probe unknown extensions.
	 */
	skipMagicSniff?: boolean;
	/**
	 * Lowercased name of the immediate parent archive. Used by
	 * specific format dispatchers that depend on context — e.g.
	 * FF7 PC field scenes have no file extension and only ever
	 * live inside `flevel.lgp`, so we route extensionless leaves
	 * under that container to the `ff7-field-scene` preview
	 * without expensive magic sniffs.
	 */
	parentArchiveName?: string;
}

// ----- Retro ROM formats (NES / GB / GBA / SNES / N64) -----

/**
 * NES ROM (iNES / NES 2.0). Unlike the Switch containers, a NES ROM
 * has no filesystem — but the header does describe a fixed physical
 * layout, so we expose the segments as children: optional 512-byte
 * trainer, PRG-ROM (code + data), and CHR-ROM (raw uncompressed 2bpp
 * tile graphics, which the tile-viewer preview renders directly).
 */
function makeNesRomNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	void ctx;
	return {
		id,
		name,
		kind: 'nes-rom',
		isContainer: true,
		size: blob.size,
		format: 'NES',
		blob: async () => blob,
		getChildren: async () => {
			const head = new Uint8Array(
				await blob.slice(0, 16).arrayBuffer(),
			);
			const info = parseNesHeader(head);
			const children: Node[] = [];
			const leaf = (
				childName: string,
				start: number,
				size: number,
				format: string,
				meta?: NodeMeta,
			): Node => ({
				id: `${id}/${childName}`,
				name: childName,
				kind: 'file',
				isContainer: false,
				size,
				format,
				meta,
				blob: async () => blob.slice(start, start + size),
			});
			if (info.trainer && info.trainerOffset !== undefined) {
				children.push(
					leaf('trainer.bin', info.trainerOffset, 512, 'BIN'),
				);
			}
			children.push(
				leaf('prg-rom.bin', info.prgRomOffset, info.prgRomSize, 'PRG-ROM'),
			);
			if (info.chrRomSize > 0 && info.chrRomOffset !== undefined) {
				// CHR-ROM's real structure is a series of 4 KB pattern
				// tables of 256 tiles each — the unit the PPU actually
				// addresses. Exposing them individually is far more
				// navigable than one flat blob, since a game's
				// background and sprite tiles live in separate tables.
				const tableCount = Math.floor(info.chrRomSize / NES_PATTERN_TABLE_SIZE);
				if (tableCount > 1) {
					children.push(
						makeNesPatternTablesNode(
							`${id}/pattern-tables`,
							blob,
							info.chrRomOffset,
							tableCount,
						),
					);
				}
				children.push(
					leaf(
						'chr-rom.bin',
						info.chrRomOffset,
						info.chrRomSize,
						'CHR-ROM',
						{ tileData: 'nes-2bpp' },
					),
				);
			}
			// Music and sound effects are 6502 code driving the APU,
			// so the only way to extract them is to run the game.
			children.push(makeNesAudioDirNode(`${id}/audio`, blob));
			return children;
		},
	};
}

// ----- GameCube discs (RVZ / WIA / raw GCM) -----

/**
 * Largest archive worth decompressing while hunting for an embedded JAudio
 * index, and how many to try. A boot archive is small by nature — it has to be
 * resident before the disc streams anything else — so the one we want sorts
 * near the front. The caps exist so that a disc which simply has no index
 * can't turn a directory listing into a decompression of every scene archive.
 */
const EMBEDDED_INDEX_MAX_ARCHIVE_SIZE = 4 * 1024 * 1024;
const EMBEDDED_INDEX_MAX_ARCHIVES = 24;

/**
 * Find a JAudio index that lives *inside* an archive and add it to the
 * disc-wide sibling map.
 *
 * Normally the index is a plain file on the disc — Wind Waker's
 * `Audiores/JaiInit.aaf` — and the sibling map finds it by name. Super Mario
 * Sunshine doesn't work that way. `MSound.cpp` names `/AudioRes/mSound.aaf`,
 * but no such file exists on the disc: it's a resource inside the boot archive,
 * loaded through a mounted RARC rather than off the filesystem, which
 * `Application.cpp` does like this:
 *
 *     this_01->mountFixed(arcBufNLogo, MBF_0);
 *     this_01->becomeCurrent("/audi");
 *     this_01->readResource(buf, uVar3, "mSound.aaf");
 *     gpMSound = new MSound(prevHeap, nullptr, 0xF40000, buf, nullptr, ...);
 *
 * On the retail disc that archive is `data/nintendo.szs` (Yaz0 → RARC →
 * `audi/mSound.aaf`). Without it the 24 `.aw` banks are unreadable: an `.aw` is
 * headerless waveform data whose every byte range, sample rate and loop point
 * lives in the index.
 *
 * Rather than hard-code that path, we search small archives for any `.aaf` or
 * `.baa` and accept one only when it actually indexes a bank *this disc has* —
 * `findWaveGroupForAw` matching a real `.aw` name is a structural identity, not
 * a guess, so a stray index from some other game can't be adopted by mistake.
 *
 * This runs only when the disc has `.aw` banks and no plain-file index, so it
 * costs nothing on the discs that were already working.
 */
async function addEmbeddedJaudioIndex(siblings: SiblingMap): Promise<void> {
	const names = [...siblings.keys()];
	const isIndex = (n: string) => n.endsWith('.aaf') || n.endsWith('.baa');
	const awNames = names.filter((n) => n.endsWith('.aw'));
	if (awNames.length === 0 || names.some(isIndex)) return;

	const candidates = names
		.filter(
			(n) =>
				n.endsWith('.szs') || n.endsWith('.arc') || n.endsWith('.rarc'),
		)
		.map((n) => ({ name: n, blob: siblings.get(n)! }))
		.filter(
			(c) => c.blob.size > 0 && c.blob.size <= EMBEDDED_INDEX_MAX_ARCHIVE_SIZE,
		)
		.sort((a, b) => a.blob.size - b.blob.size)
		.slice(0, EMBEDDED_INDEX_MAX_ARCHIVES);

	for (const candidate of candidates) {
		try {
			const head = new TextDecoder().decode(
				new Uint8Array(await candidate.blob.slice(0, 4).arrayBuffer()),
			);
			const bytes =
				head === 'Yaz0'
					? await decompressYaz0ToBytes(candidate.blob)
					: new Uint8Array(await candidate.blob.arrayBuffer());
			const archive = parseRarc(bytes);
			if (!archive) continue;
			for (const entry of archive.walk()) {
				if (!isIndex(entry.name.toLowerCase())) continue;
				const data = archive.read(entry);
				if (!data) continue;
				const aaf = parseAaf(data);
				if (!aaf) continue;
				// The identity check: this index must describe a bank that
				// actually exists here, otherwise it isn't ours.
				if (!awNames.some((aw) => findWaveGroupForAw(aaf, aw))) continue;
				siblings.set(
					entry.name.toLowerCase(),
					new Blob([data as BlobPart]),
				);
				return;
			}
		} catch {
			// Not a readable archive, or not one holding an index. Next.
		}
	}
}

/**
 * Build the browsable tree for a GameCube disc.
 *
 * `read` pulls arbitrary byte ranges out of the image, so the same
 * code serves a raw `.iso` and a compressed RVZ being reconstructed
 * chunk by chunk. Files are sliced on demand — Wind Waker's disc is
 * over a gigabyte and contains a 549 MB video, so nothing is
 * materialised until it is actually opened.
 */
async function gamecubeChildren(
	parentId: string,
	disc: GcmDisc,
	read: (offset: number, length: number) => Promise<Uint8Array>,
	ctx: ArchiveContext,
): Promise<Node[]> {
	// A disc-wide index of every file, keyed by lowercased basename.
	//
	// Normally a SiblingMap covers one directory level, which is right for
	// pairings like `.utoc`/`.ucas`. JAudio breaks that assumption: the `.aw`
	// banks live in `Audiores/Banks/` while the `.aaf` index that describes them
	// sits one level up in `Audiores/`. Rather than teach the map about parent
	// directories, we build it across the whole disc — the entries are lazy
	// facades, so 2000-odd of them cost nothing until something reads one.
	const discSiblings: SiblingMap = new Map();
	const indexEntry = (entry: GcmEntry): void => {
		if (entry.isDirectory) {
			for (const child of entry.children) indexEntry(child);
			return;
		}
		const key = entry.name.toLowerCase();
		if (discSiblings.has(key)) return;
		discSiblings.set(
			key,
			makeLazyBlob(
				entry.size,
				async () =>
					new Blob([(await read(entry.offset, entry.size)) as BlobPart]),
			),
		);
	};
	for (const entry of disc.entries) indexEntry(entry);
	// Sunshine keeps its JAudio index inside the boot archive rather than on
	// the filesystem, so the name-based lookup above can't see it.
	await addEmbeddedJaudioIndex(discSiblings);

	const toNode = async (entry: GcmEntry, idPrefix: string): Promise<Node> => {
		const childId = `${idPrefix}/${entry.name}`;
		if (entry.isDirectory) {
			return childDirectoryNodeFor({
				id: childId,
				name: entry.name,
				getChildren: async () =>
					Promise.all(entry.children.map((c) => toNode(c, childId))),
			});
		}
		// Route files through the generic dispatcher so the formats a
		// GameCube disc is actually made of — RARC archives, J3D models,
		// BTI textures, AFC streams — become traversable instead of
		// bottoming out as opaque blobs.
		//
		// `skipMagicSniff` is essential here rather than optional. A disc's
		// leaf Blobs are lazy windows into an RVZ, so the dispatcher's
		// "cheap" 12-byte probe would decompress a whole 128 KiB Zstd chunk
		// *per file* — and `res/Object/` alone holds ~1300 archives. We rely
		// on extensions instead, which is sufficient because every format
		// here is named consistently, and because the one genuinely
		// ambiguous extension (`.arc`, which is both RARC and SARC) is
		// resolved lazily by `makeArcNode` when the user expands it.
		//
		// The Blob stays a lazy facade so that merely *listing* a directory
		// costs no reads at all; the disc is only touched when a file is
		// opened, exactly as before this routing existed.
		const lazy = makeLazyBlob(
			entry.size,
			async () =>
				new Blob([(await read(entry.offset, entry.size)) as BlobPart]),
		);
		return childNodeFor(childId, entry.name, lazy, ctx, {
			skipMagicSniff: true,
			siblings: discSiblings,
		});
	};

	const children = await Promise.all(
		disc.entries.map((e) => toNode(e, parentId)),
	);

	// The boot header, disc metadata, apploader and executable sit
	// outside the FST but are the most interesting parts of the disc,
	// so surface them as siblings under a `sys` folder — the layout
	// Dolphin and GCRebuilder both use.
	const sysId = `${parentId}/sys`;
	const sysFile = (
		name: string,
		offset: number,
		size: number,
	): Node => ({
		id: `${sysId}/${name}`,
		name,
		kind: 'file',
		isContainer: false,
		size,
		format: detectFormat(name) || 'BIN',
		meta: { gcmOffset: offset },
		blob: async () => new Blob([(await read(offset, size)) as BlobPart]),
	});
	children.unshift({
		id: sysId,
		name: 'sys',
		kind: 'directory',
		isContainer: true,
		format: 'directory',
		getChildren: async () => {
			const out: Node[] = [
				sysFile('boot.bin', 0, 0x440),
				sysFile('bi2.bin', 0x440, 0x2000),
			];
			if (disc.apploaderSize > 0) {
				out.push(sysFile('apploader.img', 0x2440, disc.apploaderSize));
			}
			if (disc.header.dolOffset > 0 && disc.dolSize > 0) {
				out.push(
					sysFile('main.dol', disc.header.dolOffset, disc.dolSize),
				);
			}
			out.push(
				sysFile('fst.bin', disc.header.fstOffset, disc.header.fstSize),
			);
			return out;
		},
	});
	return children;
}

/**
 * A Dolphin RVZ (or older WIA) compressed disc image.
 *
 * The container stores the disc as independently-compressed chunks,
 * which is what makes browsing one practical: opening a file inside
 * decompresses only the chunks it spans.
 */
function makeRvzNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	let imagePromise: Promise<RvzImage> | null = null;
	const imageOnce = () => {
		if (!imagePromise) {
			imagePromise = parseRvz(blob, {
				// The app already carries a zstd decoder for NCZ; RVZ
				// uses the same codec, so reuse it rather than bundling
				// a second one.
				decompress: (compressed) => zstdDecompressBytes(compressed),
			});
		}
		return imagePromise;
	};
	return {
		id,
		name,
		kind: 'gamecube-disc',
		isContainer: true,
		size: blob.size,
		format: 'RVZ',
		blob: async () => blob,
		getChildren: async () => {
			const image = await imageOnce();
			const read = (offset: number, length: number) =>
				image.read(offset, length);
			const disc = await parseGcm(read);
			return gamecubeChildren(id, disc, read, ctx);
		},
	};
}

/** A raw, uncompressed GameCube disc image. */
function makeGamecubeIsoNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	/** Label override, so `.iso` can report NKit without duplicating this node. */
	format = 'GCM',
): Node {
	const read = async (offset: number, length: number) =>
		new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
	return {
		id,
		name,
		kind: 'gamecube-disc',
		isContainer: true,
		size: blob.size,
		format,
		blob: async () => blob,
		getChildren: async () => {
			const disc = await parseGcm(read);
			// A shrunk image (NKit) keeps the original disc header and FST, so it
			// parses cleanly whether or not its interior is still laid out the
			// way the FST claims. Check that before handing out byte ranges: if
			// the filesystem describes data past the end of the file, the image
			// was compacted and needs recovery we don't implement. Reading it
			// anyway would silently serve whatever happens to sit at those
			// offsets, which is far worse than an empty listing.
			const maxEnd = gcmMaxFileEnd(disc.entries);
			if (maxEnd > blob.size) {
				return [];
			}
			return gamecubeChildren(id, disc, read, ctx);
		},
	};
}

/**
 * A `.iso` disc image.
 *
 * The extension is shared by so many unrelated formats — PS2, Wii, PC installers,
 * plain ISO 9660 — that it carries no information on its own. So we check for the
 * GameCube magic (`0xC2339F3D` at 0x1C) and only then treat it as a disc.
 *
 * This also transparently covers **NKit** images. NKit shrinks a disc by dropping
 * junk data, and crucially it is not a wrapper: the original header stays at
 * offset 0 and the marker hides at 0x200, in an area a real disc leaves zeroed.
 * When only trailing junk was removed — which is the common case, and what
 * Sunshine's `.nkit.iso` does — every file remains at its original offset and the
 * image reads exactly like a plain one. `makeGamecubeIsoNode` verifies that
 * assumption before trusting it.
 */
function makeIsoNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	let resolved: Promise<Node | null> | null = null;
	const resolveOnce = () => {
		if (!resolved) {
			resolved = (async (): Promise<Node | null> => {
				// One read covers both the disc magic (at 0x1C) and the NKit
				// marker (at 0x200).
				const head = new Uint8Array(
					await blob.slice(0, 0x220).arrayBuffer(),
				);
				if (!isGcmMagic(head)) return null;
				const nkit = parseNkitInfo(head);
				const format = nkit
					? `GCM (NKit ${nkit.version}, shrunk from ${Math.round(nkit.originalSize / 1048576)} MB)`
					: 'GCM';
				return makeGamecubeIsoNode(id, name, blob, ctx, format);
			})();
		}
		return resolved;
	};

	return {
		id,
		name,
		kind: 'gamecube-disc',
		isContainer: true,
		size: blob.size,
		format: 'ISO',
		blob: async () => blob,
		getChildren: async () => {
			const inner = await resolveOnce();
			// Not a GameCube disc: nothing we can enumerate. The file is still
			// downloadable from this node.
			if (!inner || !inner.getChildren) return [];
			return inner.getChildren();
		},
	};
}

/** Bytes in one NES pattern table: 256 tiles of 16 bytes. */
const NES_PATTERN_TABLE_SIZE = 4096;

/**
 * NES pattern tables.
 *
 * The PPU addresses CHR-ROM as 4 KB pattern tables holding 256 8x8
 * tiles each, and a game conventionally puts background tiles in one
 * and sprite tiles in the other. Splitting the CHR blob along those
 * lines matches how the hardware — and the artist — saw it.
 */
function makeNesPatternTablesNode(
	id: string,
	blob: Blob,
	chrOffset: number,
	tableCount: number,
): Node {
	return {
		id,
		name: 'pattern-tables',
		kind: 'directory',
		isContainer: true,
		format: `${tableCount} tables`,
		getChildren: async () =>
			Array.from({ length: tableCount }, (_, i): Node => {
				const childName = `pattern_table_${i}.chr`;
				const start = chrOffset + i * NES_PATTERN_TABLE_SIZE;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: NES_PATTERN_TABLE_SIZE,
					format: '256 tiles',
					meta: { tileData: 'nes-2bpp', nesPatternTable: i },
					blob: async () =>
						blob.slice(start, start + NES_PATTERN_TABLE_SIZE),
				};
			}),
	};
}

/**
 * NES audio, rendered by emulation.
 *
 * There is nothing to decode: NES music is a program. The child here
 * is a WAV captured by booting the cartridge and recording its APU
 * output, which is slow enough (a few seconds of CPU per capture)
 * that it only happens when the node is actually opened.
 */
function makeNesAudioDirNode(id: string, blob: Blob): Node {
	return {
		id,
		name: 'audio',
		kind: 'directory',
		isContainer: true,
		format: 'emulated',
		getChildren: async () => {
			const captureSeconds = 30;
			const childName = 'capture.wav';
			return [
				{
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					format: 'APU capture',
					meta: { nesAudioCapture: true },
					blob: async () => {
						const bytes = new Uint8Array(await blob.arrayBuffer());
						const rendered = renderNesAudio(bytes, {
							seconds: captureSeconds,
						});
						return new Blob(
							[
								encodeNesWav(
									rendered.samples,
									rendered.sampleRate,
								) as BlobPart,
							],
							{ type: 'audio/wav' },
						);
					},
				},
			];
		},
	};
}

/**
 * Game Boy / Game Boy Color ROM. No children (the format has no
 * discoverable internal structure) — just a leaf file with a `meta`
 * tag so the header info preview routes even when the file was
 * identified by magic sniff rather than extension.
 */
function makeGbRomFileNode(
	id: string,
	name: string,
	blob: Blob,
	format: string,
): Node {
	return {
		id,
		name,
		kind: 'file',
		isContainer: false,
		size: blob.size,
		format,
		meta: { gbRom: true },
		blob: async () => blob,
	};
}

/**
 * Game Boy Advance ROM. Children are GBA BIOS LZ77 (type 0x10)
 * compression blocks found by a strict decompression scan — the
 * closest thing the platform has to a file index. Each child's
 * blob is the decompressed payload.
 */
function makeGbaRomNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	void ctx;
	let bytesP: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!bytesP)
			bytesP = blob
				.arrayBuffer()
				.then((ab) => new Uint8Array(ab));
		return bytesP;
	};
	return {
		id,
		name,
		kind: 'gba-rom',
		isContainer: true,
		size: blob.size,
		format: 'GBA',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = await bytesOnce();
			const blocks = scanGbaCompression(bytes);
			return blocks.map((b: GbaCompressedBlock): Node => {
				const childName = `${b.type}_0x${b.offset
					.toString(16)
					.toUpperCase()
					.padStart(7, '0')}.bin`;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: b.decompressedSize,
					format: b.type.toUpperCase(),
					meta: {
						tileData: 'gba-4bpp',
						compressedSize: b.compressedSize,
					},
					blob: async () => {
						const rom = await bytesOnce();
						const out = decompressGba(rom, b.offset);
						return new Blob([out as BlobPart]);
					},
				};
			});
		},
	};
}

/**
 * SNES sample rate for BRR-decoded WAV children. The S-DSP outputs
 * at 32 kHz; individual samples are usually recorded lower and
 * pitched at runtime, but 32 kHz is the least-wrong static choice.
 */
const SNES_BRR_SAMPLE_RATE = 32000;

/**
 * Minimum WAV duration to synthesize for looped BRR samples, in
 * output samples (1 s at 32 kHz). SNES instrument samples are tiny
 * looping waveforms (often < 25 ms); played once they're just a
 * click. Repeating the sample (with decoder filter state carried
 * across passes — see `@tootallnate/brr`'s `repeat` option) turns
 * them into the sustained tone they represent.
 */
const SNES_BRR_MIN_LOOP_SAMPLES = SNES_BRR_SAMPLE_RATE;

/** Cap on loop repeats so degenerate 16-block samples don't balloon. */
const SNES_BRR_MAX_REPEAT = 128;

/** Linear fade applied to the tail of a decoded BRR WAV (samples). */
const SNES_BRR_FADE_SAMPLES = 1600; // 50 ms at 32 kHz

/**
 * Number of times to decode a BRR sample for its WAV child: looped
 * samples repeat up to ~1 s of audio; one-shots play once.
 */
function brrRepeatCount(blocks: number, loop: boolean): number {
	if (!loop) return 1;
	const perPass = blocks * 16;
	return Math.min(
		SNES_BRR_MAX_REPEAT,
		Math.max(1, Math.ceil(SNES_BRR_MIN_LOOP_SAMPLES / perPass)),
	);
}

/**
 * In-place linear fade-out over the last `fade` samples — kills the
 * hard click where a loop is truncated mid-cycle.
 */
function fadeOutPcm(samples: Int16Array, fade: number): void {
	const n = samples.length;
	const span = Math.min(fade, n);
	for (let i = 0; i < span; i++) {
		const idx = n - span + i;
		const gain = 1 - i / span;
		samples[idx] = Math.round(samples[idx] * gain);
	}
}

/**
 * Super Nintendo ROM. Children are BRR audio samples found by
 * heuristic scan (filter-0 first block, valid shift ranges, END
 * flag chain), decoded to 16-bit PCM WAV for the audio preview.
 */
function makeSnesRomNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	void ctx;
	let bytesP: Promise<Uint8Array> | null = null;
	const bytesOnce = () => {
		if (!bytesP)
			bytesP = blob
				.arrayBuffer()
				.then((ab) => new Uint8Array(ab));
		return bytesP;
	};
	return {
		id,
		name,
		kind: 'snes-rom',
		isContainer: true,
		size: blob.size,
		format: 'SNES',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = await bytesOnce();
			const children: Node[] = [];
			// Game-specific extractors run first: when we recognise
			// the game we can decompress its real asset files
			// instead of falling back to blind heuristics.
			if (isSmw(bytes)) {
				children.push(makeSmwGfxDirNode(`${id}/graphics`, bytes));
			}
			const samples = scanBrrSamples(bytes);
			children.push(...samples.map((s): Node => {
				const childName = `brr_0x${s.offset
					.toString(16)
					.toUpperCase()
					.padStart(6, '0')}.wav`;
				const repeat = brrRepeatCount(s.blocks, s.loop);
				// 16 samples per 9-byte block, 16-bit mono PCM.
				const wavSize = 44 + s.blocks * 16 * repeat * 2;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: wavSize,
					format: 'BRR',
					meta: {
						brrLoop: s.loop,
						brrBlocks: s.blocks,
					},
					blob: async () => {
						const rom = await bytesOnce();
						const { samples: pcm } = decodeBrr(
							rom.subarray(s.offset, s.offset + s.byteLength),
							{ repeat },
						);
						if (repeat > 1) {
							fadeOutPcm(pcm, SNES_BRR_FADE_SAMPLES);
						}
						return encodeWavBlob(pcm, SNES_BRR_SAMPLE_RATE, 1);
					},
				};
			}));
			return children;
		},
	};
}

/**
 * Zelda 64 audio directory.
 *
 * Sampled audio lives in two dmadata files: `Audiobank` holds the
 * soundfonts (each sample header carrying a VADPCM codebook and loop
 * descriptor) and `Audiotable` holds the raw VADPCM frames. Neither
 * is usable alone, so this node pairs them and exposes each sample
 * as a decoded WAV that the existing audio preview can play.
 *
 * Both files are extracted lazily on first expansion — `Audiotable`
 * alone is several megabytes.
 */
function makeZ64AudioDirNode(
	id: string,
	getAudiobank: () => Promise<Uint8Array>,
	getAudiotable: () => Promise<Uint8Array>,
): Node {
	let pairP: Promise<{
		bank: Uint8Array;
		table: Uint8Array;
		samples: Z64Sample[];
	}> | null = null;
	const pairOnce = () => {
		if (!pairP) {
			pairP = (async () => {
				const [bank, table] = await Promise.all([
					getAudiobank(),
					getAudiotable(),
				]);
				return { bank, table, samples: scanZ64Samples(bank, table) };
			})();
		}
		return pairP;
	};
	return {
		id,
		name: 'audio',
		kind: 'directory',
		isContainer: true,
		format: 'Z64-Audio',
		getChildren: async () => {
			const { table, samples } = await pairOnce();
			const width = Math.max(3, String(samples.length).length);
			return samples.map((sample, index): Node => {
				const childName = `sample_${String(index).padStart(width, '0')}_0x${sample.dataOffset
					.toString(16)
					.toUpperCase()}.wav`;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					// 16-bit mono PCM plus the 44-byte RIFF header.
					size: 44 + sample.sampleCount * 2,
					format: 'VADPCM',
					meta: {
						vadpcmCompressedSize: sample.size,
						vadpcmSamples: sample.sampleCount,
						vadpcmLoops: sample.loop?.count ?? 0,
						vadpcmPredictors: sample.book.npredictors,
						vadpcmSourceOffset: sample.dataOffset,
					},
					blob: async () => {
						const decoded = decodeZ64Sample(table, sample);
						return new Blob(
							[
								encodeZ64Wav(
									decoded.samples,
									Z64_NOMINAL_SAMPLE_RATE,
								) as BlobPart,
							],
							{ type: 'audio/wav' },
						);
					},
				};
			});
		},
	};
}

/**
 * N64 SDK sound-bank audio directory.
 *
 * Games on the stock audio library keep sampled audio in a ctl/tbl
 * pair embedded in the ROM. Both are self-describing containers, so
 * they are located by structure rather than per-region offsets —
 * which is why this works unchanged on Super Mario 64 and Mario Kart
 * 64 despite their banks living at completely different addresses.
 */
function makeSoundBankDirNode(
	id: string,
	rom: Uint8Array,
	pair: SoundBankPair,
): Node {
	let samplesCache: LocatedSample[] | null = null;
	const samplesOnce = () => {
		if (!samplesCache) samplesCache = scanSoundBankSamples(rom, pair);
		return samplesCache;
	};
	return {
		id,
		name: 'audio',
		kind: 'directory',
		isContainer: true,
		format: 'N64-SoundBank',
		getChildren: async () => {
			const samples = samplesOnce();
			const width = Math.max(3, String(samples.length).length);
			return samples.map((sample, index): Node => {
				const childName = `bank${String(sample.bankIndex).padStart(
					2,
					'0',
				)}_sample_${String(index).padStart(width, '0')}.wav`;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: 44 + sample.sampleCount * 2,
					format: 'VADPCM',
					meta: {
						vadpcmBank: sample.bankIndex,
						vadpcmCompressedSize: sample.size,
						vadpcmSamples: sample.sampleCount,
						vadpcmLoops: sample.loop?.count ?? 0,
						vadpcmPredictors: sample.book.npredictors,
					},
					blob: async () => {
						const decoded = decodeBankSample(sample.waveforms, sample);
						return new Blob(
							[
								encodeBankWav(
									decoded.samples,
									NOMINAL_SAMPLE_RATE,
								) as BlobPart,
							],
							{ type: 'audio/wav' },
						);
					},
				};
			});
		},
	};
}

/**
 * Wrap a buffer of N64 data as a node that exposes the 3D models
 * inside it.
 *
 * Display lists have no container of their own — they are just
 * command streams somewhere in a segment, referencing vertices and
 * textures elsewhere in the same buffer by segmented address. So a
 * "model" child is the *same* buffer plus an entry offset, recorded
 * in `meta.n64Model` for the preview to interpret.
 *
 * Scanning is deferred to `getChildren()` because it costs a few
 * hundred milliseconds per hundred KB.
 */
function n64ModelChildren(
	parentId: string,
	getBytes: () => Promise<Uint8Array>,
	cachedBytes?: Uint8Array,
): () => Promise<Node[]> {
	let bytesP: Promise<Uint8Array> | null = cachedBytes
		? Promise.resolve(cachedBytes)
		: null;
	const bytesOnce = () => {
		if (!bytesP) bytesP = getBytes();
		return bytesP;
	};
	return async () => {
		const bytes = await bytesOnce();
		const refs = scanDisplayLists(bytes, {
			// Deliberately low: plenty of real N64 props are tiny.
			// Mario Kart 64's lamp posts, signs and billboarded
			// quads run 8-16 triangles, and a threshold of 24 hid
			// them entirely. False positives stay rare because the
			// scanner also demands zero unknown opcodes, zero
			// malformed triangles, a proper G_ENDDL, resolvable
			// vertex pointers and a non-degenerate bounding box.
			minTriangles: 8,
			limit: 256,
		});
		if (refs.length === 0) return [];
		const blobOnce = async () => new Blob([(await bytesOnce()) as BlobPart]);
		return refs.map((r: DisplayListRef): Node => {
			const childName = `model_0x${r.offset
				.toString(16)
				.toUpperCase()
				.padStart(6, '0')}.n64model`;
			return {
				id: `${parentId}/${childName}`,
				name: childName,
				kind: 'file',
				isContainer: false,
				// Report triangle count rather than a byte size: the
				// "file" is a view into the parent buffer, so a size
				// would be misleading.
				format: `${r.microcode.toUpperCase()} · ${r.triangleCount} tris`,
				meta: {
					n64Model: { offset: r.offset, microcode: r.microcode },
					n64ModelTriangles: r.triangleCount,
					n64ModelVertices: r.vertexCount,
					n64ModelMaterials: r.materialCount,
				},
				blob: blobOnce,
			};
		});
	};
}

/**
 * Super Mario World graphics directory.
 *
 * SMW keeps its tile graphics in 50 LC_LZ2-compressed "GFX files"
 * reachable through pointer tables in bank $00 — so unlike the
 * generic SNES path (which can only offer heuristics), we can list
 * and decompress the game's actual asset files. Each child carries
 * the game's palette block in `meta` so the tile viewer renders
 * them in true colour; decompressed graphics have no palette of
 * their own.
 */
function makeSmwGfxDirNode(id: string, rom: Uint8Array): Node {
	let filesP: SmwGfxFile[] | null = null;
	const filesOnce = () => {
		if (!filesP) filesP = readAllSmwGfx(rom);
		return filesP;
	};
	let palettesMeta: NodeMeta[string] | null = null;
	const palettesOnce = () => {
		if (!palettesMeta) {
			palettesMeta = {
				label: 'SMW palettes',
				palettes: readSmwPalettes(rom),
				defaultIndex: SMW_DEFAULT_SPRITE_PALETTE,
			};
		}
		return palettesMeta;
	};
	return {
		id,
		name: 'graphics',
		kind: 'directory',
		isContainer: true,
		format: 'SMW-GFX',
		getChildren: async () => {
			const files = filesOnce();
			const palettes = palettesOnce();
			return files.map((g): Node => {
				const childName = `${g.name}.bin`;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: g.bytes.length,
					format: `${g.bpp}bpp`,
					meta: {
						tileData: g.bpp === 3 ? 'snes-3bpp' : 'snes-2bpp',
						palettes,
						smwTiles: g.tiles,
						smwRomOffset: g.romOffset,
						smwCompressedSize: g.compressedSize,
					},
					blob: async () => new Blob([g.bytes as BlobPart]),
				};
			});
		},
	};
}

/**
 * Nintendo 64 ROM. The ROM is normalized to big-endian once
 * (v64 / n64 dumps are byte-swapped), then:
 *
 *   1. If the Zelda 64 `dmadata` filesystem is present (Ocarina of
 *      Time / Majora's Mask, any version), the children are its
 *      file entries — a real file tree with lazy Yaz0 decompression.
 *   2. Otherwise, children are MIO0 / Yay0 / Yaz0 compression
 *      blocks found by magic scan (SM64 and most first-party carts
 *      store graphics/level data this way).
 */
function makeN64RomNode(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
): Node {
	void ctx;
	let normP: Promise<Uint8Array> | null = null;
	const normalizedOnce = () => {
		if (!normP)
			normP = blob
				.arrayBuffer()
				.then((ab) => normalizeN64(new Uint8Array(ab)));
		return normP;
	};
	return {
		id,
		name,
		kind: 'n64-rom',
		isContainer: true,
		size: blob.size,
		format: 'N64',
		blob: async () => blob,
		getChildren: async () => {
			const rom = await normalizedOnce();
			// Zelda 64 dmadata filesystem takes precedence — it's a
			// real file table, not a heuristic.
			const fs = parseZ64Fs(rom);
			if (fs) {
				const normBlob = new Blob([rom as BlobPart]);
				const children: Node[] = [];
				// Pair Audiobank with Audiotable when both are present
				// so the sampled audio can be decoded.
				const bankEntry = fs.entries.find(
					(e: DmaEntry) => e.name === 'Audiobank',
				);
				const tableEntry = fs.entries.find(
					(e: DmaEntry) => e.name === 'Audiotable',
				);
				if (bankEntry && tableEntry) {
					const readEntry = (entry: DmaEntry) => async () =>
						new Uint8Array(
							await (await extractDmaFile(normBlob, entry)).arrayBuffer(),
						);
					children.push(
						makeZ64AudioDirNode(
							`${id}/audio`,
							readEntry(bankEntry),
							readEntry(tableEntry),
						),
					);
				}
				children.push(
					...fs.entries
					.filter((e: DmaEntry) => !e.deleted && e.size > 0)
					.map((e: DmaEntry): Node => {
						const childId = `${id}/${e.name}`;
						const getBytes = async () =>
							new Uint8Array(
								await (await extractDmaFile(normBlob, e)).arrayBuffer(),
							);
						return {
							id: childId,
							name: e.name,
							kind: 'n64-blob',
							isContainer: true,
							size: e.size,
							format: e.compressed ? 'Yaz0' : 'BIN',
							meta: {
								dmaIndex: e.index,
								dmaVromStart: e.vromStart,
								dmaCompressed: e.compressed,
								tileData: 'n64-rgba16',
							},
							blob: () => extractDmaFile(normBlob, e),
							getChildren: n64ModelChildren(childId, getBytes),
						};
					}),
				);
				return children;
			}
			// Generic path: scan for compression-block magics, then
			// for Rare's `0x1172` deflate containers (GoldenEye 007,
			// Perfect Dark), which use neither a dmadata table nor
			// any of the Nintendo compression formats.
			const blocks = scanN64Compression(rom);
			const rareFiles = await scanRare1172(rom);
			// Stock-library games embed a ctl/tbl sound-bank pair.
			const soundBanks = findSoundBanks(rom);
			const rareNodes = rareFiles.map((f: Rare1172File): Node => {
				const childName = `file_0x${f.offset
					.toString(16)
					.toUpperCase()
					.padStart(7, '0')}.bin`;
				const childId = `${id}/${childName}`;
				const decompress = async (): Promise<Uint8Array> =>
					decompressRare1172(await normalizedOnce(), f.offset);
				return {
					id: childId,
					name: childName,
					kind: 'n64-blob',
					isContainer: true,
					size: f.size,
					format: 'Rare-1172',
					meta: { tileData: 'n64-rgba16' },
					blob: async () => new Blob([(await decompress()) as BlobPart]),
					getChildren: n64ModelChildren(childId, decompress),
				};
			});
			const blockNodes = blocks.map((b: N64CompressedBlockRef): Node => {
				const childName = `${b.type.toLowerCase()}_0x${b.offset
					.toString(16)
					.toUpperCase()
					.padStart(7, '0')}.bin`;
				const childId = `${id}/${childName}`;
				const decompress = async (): Promise<Uint8Array> => {
					const bytes = await normalizedOnce();
					if (b.type === 'MIO0') {
						return decompressMio0Bytes(bytes, b.offset);
					}
					if (b.type === 'Yay0') {
						return decompressYay0Bytes(bytes, b.offset);
					}
					return decompressYaz0ToBytes(
						new Blob([bytes.subarray(b.offset) as BlobPart]),
					);
				};
				return {
					id: childId,
					name: childName,
					kind: 'n64-blob',
					isContainer: true,
					size: b.decompressedSize,
					format: b.type,
					meta: { tileData: 'n64-rgba16' },
					blob: async () => new Blob([(await decompress()) as BlobPart]),
					getChildren: n64ModelChildren(childId, decompress),
				};
			});
			return [
				...(soundBanks
					? [makeSoundBankDirNode(`${id}/audio`, rom, soundBanks)]
					: []),
				...blockNodes,
				...rareNodes,
			];
		},
	};
}

async function childNodeFor(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	tikMapOrOpts?: TikMap | ChildNodeForOptions,
	siblings?: SiblingMap,
): Promise<Node> {
	// Backwards-compat: the legacy 5-arg signature passed
	// `(id, name, blob, ctx, tikMap)`. New callers pass an
	// options object as the 5th arg. Detect and normalise.
	let tikMap: TikMap | undefined;
	let opts: ChildNodeForOptions | undefined;
	if (tikMapOrOpts && typeof tikMapOrOpts === 'object' && !(tikMapOrOpts instanceof Map)) {
		opts = tikMapOrOpts as ChildNodeForOptions;
		tikMap = opts.tikMap;
		if (!siblings) siblings = opts.siblings;
	} else {
		tikMap = tikMapOrOpts as TikMap | undefined;
	}
	const skipMagicSniff = opts?.skipMagicSniff === true;
	const ext = extOf(name);
	// NSZ = NSP-with-NCZ-compressed-NCAs inside. Identical outer
	// PFS0 container; the .ncz children are routed through
	// `makeNczNode` which handles the zstd decompression.
	// XCZ = XCI-with-NCZ-compressed-NCAs (the cartridge variant of NSZ).
	// `.utoc` standalone (no `.ucas` sibling): we can still browse
	// the file listing via the directory index, but inner-file
	// reads will surface a clear error. The "right" path \u2014
	// pairing with the sibling `.ucas` \u2014 lives in
	// `romfsEntriesToNodes` where the parent directory is in scope.
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
	// Unity TextAsset wrappers around SEAD files use the
	// `.sab.bytes` / `.mab.bytes` convention. Route those too.
	if (ext === 'bytes') {
		const lowerName = name.toLowerCase();
		if (lowerName.endsWith('.sab.bytes') || lowerName.endsWith('.mab.bytes')) {
			return makeSeadAudioNode(id, name, blob, ctx);
		}
	}
	// Unity standalone-build SerializedFiles: `*.assets` (e.g.
	// `resources.assets`, `sharedassets0.assets`, `globalgamemanagers.assets`)
	// and the no-extension scene / global files (`level0`..`levelN`,
	// `globalgamemanagers`, `mainData`, `customdata`). All use the
	// Unity SerializedFile format and reference companion `.resS` /
	// `.resource` files in the same directory.
	if (
		/^(?:level\d+|globalgamemanagers|maindata|customdata)$/i.test(name)
	) {
		return makeUnitySerializedFileNode(id, name, blob, ctx);
	}
	// Everything with a plain extension mapping goes through the registry — the
	// same table `buildRootNode` uses, so the two can't drift apart. `.bank`'s
	// Wwise-vs-FMOD disambiguation now lives in that table's BANK entry.
	const byExt = FORMAT_BY_EXT.get(ext);
	if (byExt) {
		return byExt.build({
			id,
			name,
			blob,
			ctx,
			format: byExt.format,
			tikMap,
			siblings,
		});
	}

	// FF7 PC field scenes live exclusively inside `flevel.lgp` and
	// carry no file extension (just `md1stin`, `cosmo`, `tin_1`,
	// etc.). The LGP child dispatcher tags them via
	// `parentArchiveName` so we route them straight to the field-
	// scene preview without an expensive magic sniff (each scene
	// would need to be partially LZSS-decompressed to identify).
	if (
		ext === '' &&
		opts?.parentArchiveName === 'flevel.lgp'
	) {
		return {
			id,
			name,
			kind: 'file',
			isContainer: false,
			size: blob.size,
			format: 'FF7-Field',
			meta: { ff7FieldScene: true },
			blob: async () => blob,
		};
	}

	// FF7 PC battle models live inside `battle.lgp` as
	// extensionless 4-char files. Three sub-formats by suffix:
	//   <id>aa    → master skeleton (binary HRC equivalent)
	//   <id>am..cz → P-mesh (uses the same .p parser as field models)
	//   <id>ac..al → TEX (uses the same .tex parser as field models)
	//   <id>da    → animation pack (the .a equivalent, but bundled)
	//   <id>ab    → battle AI script
	//
	// We tag by suffix here so the preview pane can dispatch
	// without doing another magic-sniff pass.
	if (
		ext === '' &&
		opts?.parentArchiveName === 'battle.lgp' &&
		name.length === 4
	) {
		const suffix = name.slice(2).toLowerCase();
		if (suffix === 'aa') {
			return {
				id,
				name,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: 'FF7-Battle-HRC',
				meta: { ff7BattleSkeleton: true },
				blob: async () => blob,
			};
		}
		if (suffix === 'da') {
			return {
				id,
				name,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: 'FF7-Battle-Anim',
				meta: { ff7BattleAnimPack: true },
				blob: async () => blob,
			};
		}
		if (suffix === 'ab') {
			return {
				id,
				name,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: 'FF7-Battle-AI',
				meta: { ff7BattleAi: true },
				blob: async () => blob,
			};
		}
		// Suffix 'ac'..'al' → texture (10 slots)
		const s1 = suffix.charCodeAt(0);
		const s2 = suffix.charCodeAt(1);
		if (s1 === 0x61 && s2 >= 0x63 && s2 <= 0x6c) {
			return {
				id,
				name,
				kind: 'file',
				isContainer: false,
				size: blob.size,
				format: 'FF7-Battle-Tex',
				meta: { ff7Tex: true },
				blob: async () => blob,
			};
		}
		// Suffix 'am'..'zz' or 'ck'..'cz' → P-mesh (bone or weapon)
		// We don't gate by exact range — anything else in the 4-char
		// space inside battle.lgp is most likely a P-mesh.
		return {
			id,
			name,
			kind: 'file',
			isContainer: false,
			size: blob.size,
			format: 'FF7-Battle-P',
			meta: { ff7P: true },
			blob: async () => blob,
		};
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
	//
	// Callers with thousands of leaf children whose blobs are
	// expensive to peek at (e.g. VBF entries that decompress 64 KiB
	// chunks on every slice) can opt out via skipMagicSniff.
	if (skipMagicSniff) {
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
	const sniffed = await sniffMagicCheap(blob);
	// idTech BFG bitmap font + texture atlas: leaf files routed via
	// `meta` tags so the preview pane can pick them out of the
	// generic `.dat` / arbitrary-extension stream.
	if (sniffed === 'idfont') {
		return {
			id,
			name,
			kind: 'file',
			isContainer: false,
			size: blob.size,
			format: 'idTech-Font',
			meta: { idfont: true },
			blob: async () => blob,
		};
	}
	if (sniffed === 'bimage') {
		return {
			id,
			name,
			kind: 'file',
			isContainer: false,
			size: blob.size,
			format: 'idTech-bimage',
			meta: { bimage: true },
			blob: async () => blob,
		};
	}

	// Magic-detected formats resolve through the same registry.
	const bySniff = sniffed ? FORMAT_BY_SNIFF.get(sniffed) : undefined;
	if (bySniff) {
		return bySniff.build({
			id,
			name,
			blob,
			ctx,
			format: bySniff.format,
			tikMap,
			siblings,
		});
	}

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
