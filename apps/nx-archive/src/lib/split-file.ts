/**
 * Detect and merge split-archive parts.
 *
 * Retail Switch dumps are sometimes shipped as split files because of
 * filesystem size limits (FAT32 → 4 GB max, exFAT-on-some-tools → 4 GB
 * convention). The two common conventions:
 *
 *   1. Numeric extension after the real one
 *      `Game.xci.00`, `Game.xci.01`, ... (NSZ/XCI tools)
 *      `Game.nsp.partN` (older NSP splitters)
 *
 *   2. The "directory-as-archive" form (Switch's native split format)
 *      `Game.xci/00`, `Game.xci/01`, ... (no extension on parts)
 *      `Game.nsp/`, `Game.nsz/`
 *
 * This module groups loose-folder files into virtual whole archives,
 * concatenating the parts via `new Blob([...])`. `Blob` concat is
 * lazy: the parts aren't read into memory until something calls
 * `.arrayBuffer()` / `.slice()` / etc., and `.slice()` only materialises
 * the requested range.
 */

import type { WalkedFile } from './folder';

export interface MergedFile {
	/** The path the merged file should appear under (with the split suffix stripped). */
	relativePath: string;
	/** A `File`-or-`Blob` for the merged contents. */
	blob: Blob;
	/** Number of source parts that contributed (1 for non-split files). */
	partCount: number;
	/** Total size in bytes (sum of part sizes for split files). */
	size: number;
}

/**
 * Group a flat list of `WalkedFile`s into `MergedFile`s, joining
 * detected split parts. Non-split files pass through with `partCount: 1`.
 */
export function mergeSplitFiles(files: WalkedFile[]): MergedFile[] {
	// Three classification buckets:
	//   - "extension-style" splits like `foo.xci.00`
	//   - "directory-style" splits where every entry under a directory
	//     is named exactly `00`, `01`, …, `NN`
	//   - everything else
	type ExtKey = string; // e.g. "path/foo.xci"
	type DirKey = string; // e.g. "path/foo.xci/" — directory acting as archive

	const extGroups = new Map<ExtKey, WalkedFile[]>();
	const dirCandidates = new Map<DirKey, WalkedFile[]>();
	const passthrough: MergedFile[] = [];

	// First pass: bucket each file.
	for (const wf of files) {
		const extMatch = matchExtensionSplit(wf.relativePath);
		if (extMatch) {
			const list = extGroups.get(extMatch.basePath);
			if (list) list.push(wf);
			else extGroups.set(extMatch.basePath, [wf]);
			continue;
		}
		const dirMatch = matchDirectorySplit(wf.relativePath);
		if (dirMatch) {
			const list = dirCandidates.get(dirMatch.basePath);
			if (list) list.push(wf);
			else dirCandidates.set(dirMatch.basePath, [wf]);
			continue;
		}
		passthrough.push({
			relativePath: wf.relativePath,
			blob: wf.file,
			partCount: 1,
			size: wf.file.size,
		});
	}

	// Helper: take a bucket of "is this part of a split set?" candidates
	// and emit either a merged file (if the bucket is contiguous from 00)
	// or pass them through individually.
	function finishGroup(
		basePath: string,
		group: WalkedFile[],
		ordinalOf: (relPath: string) => number | null,
	): void {
		if (group.length < 2) {
			// A single ".00"-suffixed file isn't really a split set — leave
			// it as-is so weird names don't get mangled.
			for (const wf of group) {
				passthrough.push({
					relativePath: wf.relativePath,
					blob: wf.file,
					partCount: 1,
					size: wf.file.size,
				});
			}
			return;
		}
		// Sort by ordinal and verify they're contiguous starting at 0.
		const sorted = [...group].sort((a, b) => {
			const oa = ordinalOf(a.relativePath) ?? 0;
			const ob = ordinalOf(b.relativePath) ?? 0;
			return oa - ob;
		});
		for (let i = 0; i < sorted.length; i++) {
			const ord = ordinalOf(sorted[i].relativePath);
			if (ord !== i) {
				// Non-contiguous → fall back to passthrough; the user can
				// inspect parts individually.
				for (const wf of sorted) {
					passthrough.push({
						relativePath: wf.relativePath,
						blob: wf.file,
						partCount: 1,
						size: wf.file.size,
					});
				}
				return;
			}
		}
		const blobs: Blob[] = sorted.map((wf) => wf.file);
		const totalSize = sorted.reduce((s, wf) => s + wf.file.size, 0);
		passthrough.push({
			relativePath: basePath,
			blob: new Blob(blobs),
			partCount: sorted.length,
			size: totalSize,
		});
	}

	for (const [basePath, group] of extGroups) {
		finishGroup(basePath, group, (rel) => {
			const m = matchExtensionSplit(rel);
			return m ? m.ordinal : null;
		});
	}
	for (const [basePath, group] of dirCandidates) {
		finishGroup(basePath, group, (rel) => {
			const m = matchDirectorySplit(rel);
			return m ? m.ordinal : null;
		});
	}

	return passthrough;
}

interface SplitMatch {
	basePath: string;
	ordinal: number;
}

const EXT_SPLIT_RE = /^(.+?)\.(\d{2,3})$/;
const PART_SPLIT_RE = /^(.+?)\.part(\d{1,3})$/i;

/**
 * Recognise extension-style split-archive parts:
 *   `foo.xci.00`, `foo.xci.01`, …
 *   `foo.nsp.part0`, `foo.nsp.part1`, …
 *
 * Returns `null` if the path doesn't match the pattern OR if the base
 * name doesn't look like an archive extension we'd want to merge
 * (avoids merging `report.txt.00` style noise).
 */
function matchExtensionSplit(relPath: string): SplitMatch | null {
	let m = EXT_SPLIT_RE.exec(relPath);
	if (m) {
		const base = m[1];
		const ord = parseInt(m[2], 10);
		if (looksLikeArchiveExt(base) && Number.isFinite(ord)) {
			return { basePath: base, ordinal: ord };
		}
	}
	m = PART_SPLIT_RE.exec(relPath);
	if (m) {
		const base = m[1];
		const ord = parseInt(m[2], 10);
		if (looksLikeArchiveExt(base) && Number.isFinite(ord)) {
			return { basePath: base, ordinal: ord };
		}
	}
	return null;
}

/**
 * Recognise directory-as-archive split parts: a path like
 * `Game.xci/00` or `Game.xci/01` where the directory name itself
 * carries the archive extension and the file name is a 2-digit
 * numeric ordinal.
 */
function matchDirectorySplit(relPath: string): SplitMatch | null {
	const slash = relPath.lastIndexOf('/');
	if (slash < 0) return null;
	const dir = relPath.slice(0, slash);
	const name = relPath.slice(slash + 1);
	if (!/^\d{2,3}$/.test(name)) return null;
	if (!looksLikeArchiveExt(dir)) return null;
	const ord = parseInt(name, 10);
	if (!Number.isFinite(ord)) return null;
	return { basePath: dir, ordinal: ord };
}

const ARCHIVE_EXTS = new Set([
	'nca',
	'ncz',
	'nsp',
	'nsz',
	'xci',
	'xcz',
	'pfs0',
	'hfs0',
]);

function looksLikeArchiveExt(path: string): boolean {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return false;
	return ARCHIVE_EXTS.has(path.slice(dot + 1).toLowerCase());
}
