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
import {
	parseNca,
	NCA_FS_TYPE_PFS0,
	NCA_FS_TYPE_ROMFS,
	type ParsedNca,
	type NcaSection,
	NcaContentType,
	type KeySet,
} from '@tootallnate/nca';
import type { WalkedFolder } from './folder';
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
	/**
	 * A user-selected folder from the local filesystem. Functions like
	 * an "ad-hoc PFS0" — its children are the files inside, with `.tik`
	 * tickets aggregated for titlekey decryption across the subtree.
	 */
	| 'fs-folder'
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

// Sniff magic bytes to recognize containers when we don't have a friendly extension.
async function sniffMagic(blob: Blob): Promise<string | null> {
	if (blob.size < 0x10) return null;
	const head = new Uint8Array(await blob.slice(0, 0x10).arrayBuffer());
	const dec = new TextDecoder();
	const m4 = dec.decode(head.subarray(0, 4));
	if (m4 === 'PFS0') return 'pfs0';
	if (m4 === 'HFS0') return 'hfs0';
	if (m4 === 'IVFC') return 'romfs';
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
			return makeNroNode(id, displayName, blob);
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
			return makeRomfsNode(id, displayName, blob);
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

// ----- Top-level entry: turn a user-selected folder into a root Node -----

/**
 * Build a root node from a walked folder. The folder is rendered as a
 * single top-level container ("ad-hoc PFS0") with one child per merged
 * file. `.tik` tickets anywhere in the subtree are aggregated into a
 * single tikMap so any encrypted NCAs in the folder can decrypt with
 * their matching titlekey.
 *
 * Split-archive parts (`foo.xci.00` / `foo.xci/00` / `foo.nsp.partN`)
 * are auto-merged into a single virtual archive via lazy `Blob` concat.
 */
export async function buildFolderRootNode(
	folder: WalkedFolder,
	ctx: ArchiveContext,
): Promise<Node> {
	// Merge split-file groups before anything else, so the rest of the
	// pipeline never sees `.xci.00` etc.
	const merged = mergeSplitFiles(folder.files);
	// Build the tikMap once for the whole folder so titlekey decryption
	// works regardless of where the .tik file sits relative to the NCA.
	const tikMap = await buildTikMap(
		merged.map((m) => [m.relativePath, { data: m.blob }] as const),
	);
	const rootId = `/${folder.name}`;
	const totalSize = merged.reduce((s, m) => s + m.size, 0);
	return {
		id: rootId,
		name: folder.name,
		kind: 'fs-folder',
		isContainer: true,
		size: totalSize,
		format: 'folder',
		// Folder roots aren't downloadable as a single blob (we'd have to
		// zip them); leave `blob` unset so the toolbar's Download button
		// hides itself.
		getChildren: async () => folderChildrenFromMerged(rootId, merged, ctx, tikMap),
	};
}

/**
 * Produce one level of children given a flat list of merged files
 * already prefixed with a base path. Any path that contains a `/` is
 * split — its first segment becomes a sub-directory node with the
 * remainder of the path passed down.
 */
function folderChildrenFromMerged(
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
					folderChildrenFromMerged(id, childMerged, ctx, tikMap),
			}),
		);
	}
	for (const m of fileNames) {
		const name = m.relativePath; // already a leaf
		const id = `${parentId}/${name}`;
		out.push(folderFileNode(id, name, m, ctx, tikMap));
	}
	return Promise.all(out);
}

/**
 * Wrap a leaf file from a folder walk into a Node. Routes through
 * `childNodeFor` so we get format detection + container expansion +
 * NCA decryption for free.
 */
async function folderFileNode(
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

function makeNroNode(id: string, name: string, blob: Blob): Node {
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
				children.push(makeRomfsNode(`${id}/romfs`, 'romfs', nro.romfs));
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
		blob: async () => blob,
		getChildren: async () => {
			const keys = ctx.getKeys();
			if (!keys) {
				ctx.requestKeys();
				throw new Error(
					'NCA decryption requires prod.keys. Click the "Add keys" button to provide them.',
				);
			}
			// Two-pass: first peek at the rights ID, then look up the
			// matching titlekey from the tikMap (if any) and re-parse with
			// it. The peek is cheap (header decrypt only).
			let parsed = await parseNca(blob, { keys });
			if (parsed.hasRightsId && tikMap) {
				const ridKey = bytesToHex(parsed.rightsId);
				const encryptedTitleKey = tikMap.get(ridKey);
				if (encryptedTitleKey) {
					parsed = await parseNca(blob, { keys, encryptedTitleKey });
				}
			}
			if (parsed.missingKey) {
				throw new Error(parsed.missingKey);
			}
			return ncaSectionNodes(id, parsed, ctx, tikMap);
		},
	};
}

function ncaSectionNodes(
	parentId: string,
	parsed: ParsedNca,
	ctx: ArchiveContext,
	tikMap?: TikMap,
): Node[] {
	const out: Node[] = [];

	// Synthetic info file at the top of the NCA so users can preview the header
	out.push({
		id: `${parentId}/__info.json`,
		name: '_nca-info.json',
		kind: 'file',
		isContainer: false,
		format: 'JSON',
		meta: { ncaInfo: ncaInfoForPreview(parsed) },
		blob: async () => {
			const json = JSON.stringify(ncaInfoForPreview(parsed), null, 2);
			return new Blob([json], { type: 'application/json' });
		},
	});

	for (const section of parsed.sections) {
		out.push(makeNcaSectionNode(parentId, parsed, section, ctx, tikMap));
	}
	return out;
}

function ncaInfoForPreview(parsed: ParsedNca) {
	return {
		magic: parsed.magic,
		distribution: parsed.distribution,
		contentType: NcaContentType[parsed.contentType] ?? parsed.contentType,
		titleId: '0x' + parsed.titleId.toString(16).padStart(16, '0'),
		ncaSize: parsed.ncaSize.toString(),
		keyGeneration: parsed.keyGeneration,
		kaekIndex: parsed.kaekIndex,
		sdkVersion: parsed.sdkVersion,
		hasRightsId: parsed.hasRightsId,
		sections: parsed.sections.map((s) => ({
			index: s.index,
			fsType: s.fsType === NCA_FS_TYPE_PFS0 ? 'PFS0' : s.fsType === NCA_FS_TYPE_ROMFS ? 'RomFS' : `unknown(${s.fsType})`,
			cryptType: s.cryptType,
			mediaStartOffset: s.mediaStartOffset,
			mediaEndOffset: s.mediaEndOffset,
		})),
	};
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
		return makeRomfsNode(id, sectionLabel, section.romfsData);
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
		getChildren: async () => {
			const keys = ctx.getKeys();
			if (!keys) {
				ctx.requestKeys();
				throw new Error(
					'NCA decryption requires prod.keys. Click the "Add keys" button to provide them.',
				);
			}
			const ncaBlob = await decompressOnce();
			let parsed = await parseNca(ncaBlob, { keys });
			if (parsed.hasRightsId && tikMap) {
				const ridKey = bytesToHex(parsed.rightsId);
				const encryptedTitleKey = tikMap.get(ridKey);
				if (encryptedTitleKey) {
					parsed = await parseNca(ncaBlob, { keys, encryptedTitleKey });
				}
			}
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

function makeRomfsNode(id: string, name: string, blob: Blob): Node {
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
			return romfsEntriesToNodes(id, root);
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

function romfsEntriesToNodes(parentId: string, dir: RomFsEntry): Node[] {
	const out: Node[] = [];
	const names = Object.keys(dir).sort((a, b) => {
		// Directories first, then files; alphabetical within each group.
		const aIsDir = !isBlobLike(dir[a]);
		const bIsDir = !isBlobLike(dir[b]);
		if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
		return a.localeCompare(b);
	});
	for (const name of names) {
		const value = dir[name];
		const id = `${parentId}/${name}`;
		if (isBlobLike(value)) {
			out.push({
				id,
				name,
				kind: 'file',
				isContainer: false,
				size: value.size,
				format: detectFormat(name) || 'BIN',
				blob: async () => value,
			});
		} else {
			const isHtdocs = name.toLowerCase().endsWith('.htdocs');
			out.push({
				id,
				name,
				kind: isHtdocs ? 'htdocs' : 'directory',
				isContainer: true,
				format: isHtdocs ? 'HTDOCS' : 'directory',
				meta: isHtdocs ? { htdocsRoot: value as RomFsEntry } : undefined,
				getChildren: async () => romfsEntriesToNodes(id, value as RomFsEntry),
			});
		}
	}
	return out;
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
	if (ext === 'nro') return makeNroNode(id, name, blob);
	if (ext === 'nsp') return makePfs0Node(id, name, blob, ctx, 'NSP');
	if (ext === 'pfs0') return makePfs0Node(id, name, blob, ctx, 'PFS0');
	if (ext === 'hfs0') return makeHfs0Node(id, name, blob, ctx);
	if (ext === 'xci') return makeXciNode(id, name, blob, ctx);

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
