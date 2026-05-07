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
import { decompressNcz, isNcz } from '@tootallnate/ncz';
import { parseSarc, type SarcEntry } from '@tootallnate/sarc';
import { decompressYaz0 } from '@tootallnate/yaz0';
import { decompressLz4, type Lz4Variant } from '@tootallnate/lz4';
import { parseZip, type ZipEntry } from './zip';
import { parseUnityFs, type UnityFsNode } from './unityfs';
import {
	parseNca,
	NCA_FS_TYPE_PFS0,
	NCA_FS_TYPE_ROMFS,
	type ParsedNca,
	type NcaSection,
	NcaContentType,
	type KeySet,
} from '@tootallnate/nca';
import type { WalkedDirectory } from './directory';
import { mergeSplitFiles, type MergedFile } from './split-file';
import { zstdDecompressBlob, zstdDecompressStream } from './zstd';

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
	| 'unityfs'
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
	/** Returns the file's data as a Blob. For directories, undefined. */
	blob?: () => Promise<Blob>;
	/** Lazy children for containers. */
	getChildren?: () => Promise<Node[]>;
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
export interface ArchiveContext {
	/** Returns the current `KeySet`, or `null` if none has been provided yet. */
	getKeys: () => KeySet | null;
	/** Asks the UI to prompt the user for `prod.keys`. */
	requestKeys: () => void;
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
	pack: 'SARC', // BotW / Splatoon style — `.pack` is plain SARC
	szs: 'SZS', // Yaz0-compressed SARC, ubiquitous across 1st-party games
	yaz0: 'YAZ0',
	lz4: 'LZ4',
	bundle: 'UnityFS', // Unity Addressables: `*.bundle`
	unity3d: 'UnityFS', // Legacy Unity AssetBundle extension
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
	| 'xci';

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
	const headLen = Math.min(blob.size, 8);
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
		case 'SZS':
		case 'YAZ0':
			return makeSzsNode(id, displayName, blob, ctx);
		case 'LZ4':
			return makeLz4Node(id, displayName, blob, ctx);
		case 'UnityFS':
			return makeUnityFsNode(id, displayName, blob, ctx);
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

	// Resolve directories + files into Node[] in alphabetical order with
	// directories first (mirrors how the rest of the app sorts romfs).
	const dirNames = [...dirs.keys()].sort((a, b) => a.localeCompare(b));
	const fileNames = files.sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath),
	);

	const out: Promise<Node>[] = [];
	for (const name of dirNames) {
		const id = `${parentId}/${name}`;
		const childMerged = dirs.get(name)!;
		const subtotal = childMerged.reduce((s, m) => s + m.size, 0);
		out.push(
			Promise.resolve<Node>({
				id,
				name,
				kind: 'directory',
				isContainer: true,
				size: subtotal,
				format: 'directory',
				getChildren: () =>
					directoryChildrenFromMerged(id, childMerged, ctx, tikMap),
			}),
		);
	}
	for (const m of fileNames) {
		const name = m.relativePath; // already a leaf
		const id = `${parentId}/${name}`;
		out.push(directoryFileNode(id, name, m, ctx, tikMap));
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
): Promise<Node> {
	const node = await childNodeFor(id, name, m.blob, ctx, tikMap);
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
		throw new Error(
			'NCA decryption requires prod.keys. Click the "Add keys" button to provide them.',
		);
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
				getBlob: async () => blob,
				ctx,
				tikMap,
			} satisfies NcaSource,
		},
		blob: async () => blob,
		getChildren: async () => {
			const parsed = await parseNcaWithTik(blob, ctx, tikMap);
			if (parsed.missingKey) {
				throw new Error(parsed.missingKey);
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
	/** Heavyweight: the full NCA, materialising NCZ decompression if needed. */
	getBlob: () => Promise<Blob>;
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
	let cachedNca: Promise<Blob> | null = null;
	const decompressOnce = () => {
		if (!cachedNca) cachedNca = decompressNczToBlob(blob);
		return cachedNca;
	};

	return {
		id,
		name,
		kind: 'nca',
		isContainer: true,
		size: blob.size,
		format: 'NCZ',
		blob: decompressOnce, // download yields the decompressed NCA
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
		getChildren: async () => {
			const ncaBlob = await decompressOnce();
			const parsed = await parseNcaWithTik(ncaBlob, ctx, tikMap);
			if (parsed.missingKey) {
				throw new Error(parsed.missingKey);
			}
			return ncaSectionNodes(id, parsed, ctx, tikMap);
		},
	};
}

async function decompressNczToBlob(blob: Blob): Promise<Blob> {
	if (!(await isNcz(blob))) {
		throw new Error('Not an NCZ file');
	}
	// Buffer the decompressed output through a TransformStream → Response → Blob.
	// This is still streaming under the hood (the writer applies backpressure)
	// but produces a real Blob the rest of the pipeline can use.
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const finish = new Response(readable).blob();
	await decompressNcz(blob, () => writable, {
		decompressBlob: zstdDecompressBlob,
		decompressStream: zstdDecompressStream,
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
		// Directories first, then files; alphabetical within each group.
		const aIsDir = !isBlobLike(dir[a]);
		const bIsDir = !isBlobLike(dir[b]);
		if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
		return a.localeCompare(b);
	});
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
				// Route through childNodeFor so nested archives —
				// SARC, Yaz0+SARC under bizarre extensions like
				// `.sbfarc` / `.shksc` / `.sbactorpack`, ZIP, etc. —
				// become traversable instead of just downloadable.
				return childNodeFor(id, name, value, ctx);
			}
			const isHtdocs = name.toLowerCase().endsWith('.htdocs');
			return {
				id,
				name,
				kind: isHtdocs ? 'htdocs' : 'directory',
				isContainer: true,
				format: isHtdocs ? 'HTDOCS' : 'directory',
				meta: isHtdocs ? { htdocsRoot: value as RomFsEntry } : undefined,
				getChildren: async () =>
					romfsEntriesToNodes(id, value as RomFsEntry, ctx),
			};
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
			return a.localeCompare(b);
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
					return {
						id: childId,
						name,
						kind: 'directory',
						isContainer: true,
						format: 'directory',
						getChildren: async () => subNodes,
					};
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
			return a.localeCompare(b);
		});
		return Promise.all(
			names.map(async (name): Promise<Node> => {
				const child = t.get(name)!;
				const childId = `${treeId}/${name}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return {
						id: childId,
						name,
						kind: 'directory',
						isContainer: true,
						format: 'directory',
						getChildren: async () => subNodes,
					};
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
			return a.localeCompare(b);
		});
		return Promise.all(
			names.map(async (name): Promise<Node> => {
				const child = t.get(name)!;
				const childId = `${treeId}/${name}`;
				if (child.dir) {
					const subNodes = await treeToNodes(childId, child.dir);
					return {
						id: childId,
						name,
						kind: 'directory',
						isContainer: true,
						format: 'directory',
						getChildren: async () => subNodes,
					};
				}
				const file = child.file!;
				return childNodeFor(childId, name, file.data, ctx);
			}),
		);
	};

	return treeToNodes(parentId, root);
}

// ----- Generic dispatcher for nested children whose container type is determined by name/sniff -----

async function childNodeFor(
	id: string,
	name: string,
	blob: Blob,
	ctx: ArchiveContext,
	tikMap?: TikMap,
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
	if (ext === 'szs') return makeSzsNode(id, name, blob, ctx);
	if (ext === 'lz4') return makeLz4Node(id, name, blob, ctx);
	if (ext === 'bundle' || ext === 'unity3d')
		return makeUnityFsNode(id, name, blob, ctx);

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
	if (sniffed === 'szs') return makeSzsNode(id, name, blob, ctx);
	if (sniffed === 'pfs0') return makePfs0Node(id, name, blob, ctx, 'PFS0');
	if (sniffed === 'hfs0') return makeHfs0Node(id, name, blob, ctx);
	if (sniffed === 'romfs') return makeRomfsNode(id, name, blob, ctx);
	if (sniffed === 'zip') return makeZipNode(id, name, blob, ctx);
	if (sniffed === 'lz4') return makeLz4Node(id, name, blob, ctx);
	if (sniffed === 'unityfs') return makeUnityFsNode(id, name, blob, ctx);

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
