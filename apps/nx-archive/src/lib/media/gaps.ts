/**
 * Coverage / gap report: what the library could and couldn't make sense
 * of in an opened file, rendered as a brief an agent (or a human) can
 * act on. Generated from a {@link MediaIndex}, so the in-app panel and
 * `scripts/media-scan.ts` produce the same document.
 */

import { MEDIA_KIND_LABEL, MEDIA_KINDS, type MediaIndex, type MediaKind } from './types';

export interface CoverageSummary {
	counts: Record<MediaKind, number>;
	/** Items merged into another item (textures, mesh pieces). */
	parts: number;
	partial: number;
	failed: number;
	unknownFiles: number;
	unknownBytes: number;
}

export function summarize(index: MediaIndex): CoverageSummary {
	const counts = Object.fromEntries(MEDIA_KINDS.map((k) => [k, 0])) as Record<MediaKind, number>;
	let parts = 0;
	let partial = 0;
	let failed = 0;
	for (const item of index.items) {
		if (item.partOf) {
			parts++;
			continue;
		}
		counts[item.kind]++;
		if (item.status === 'partial') partial++;
		if (item.status === 'error') failed++;
	}
	return {
		counts,
		parts,
		partial,
		failed,
		unknownFiles: index.unknown.reduce((n, g) => n + g.count, 0),
		unknownBytes: index.unknown.reduce((n, g) => n + g.totalSize, 0),
	};
}

function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ['KiB', 'MiB', 'GiB'];
	let v = n / 1024;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown brief describing coverage gaps, suitable for handing to an agent. */
export function gapReportMarkdown(index: MediaIndex, opts: { maxRows?: number } = {}): string {
	const max = opts.maxRows ?? 40;
	const s = summarize(index);
	const lines: string[] = [];
	lines.push(`# nx-archive media coverage: ${index.fileName}`);
	lines.push('');
	lines.push(
		`Container: **${index.platform}**, ${bytes(index.fileSize)}. Scanned ${index.stats.visited.toLocaleString()} nodes ` +
			`(${index.stats.containers.toLocaleString()} containers, ${index.stats.leaves.toLocaleString()} files) in ` +
			`${(index.stats.durationMs / 1000).toFixed(1)} s${index.complete ? '' : ' — **scan incomplete**'}.`,
	);
	lines.push('');
	lines.push('## Media found');
	lines.push('');
	lines.push('| Kind | Items |');
	lines.push('|---|---|');
	for (const k of MEDIA_KINDS) lines.push(`| ${MEDIA_KIND_LABEL[k]} | ${s.counts[k].toLocaleString()} |`);
	lines.push(`| (merged parts: textures, mesh pieces) | ${s.parts.toLocaleString()} |`);
	if (index.stats.duplicates) {
		lines.push(`| (identical copies folded together${index.stats.duplicatesPartial ? ', partial' : ''}) | ${index.stats.duplicates.toLocaleString()} |`);
	}
	lines.push('');

	lines.push('## Gaps');
	lines.push('');
	lines.push(
		'Each section below is something the app could not turn into media. Use the paths and leading bytes to identify the format, add a parser package under `packages/`, and route it in `apps/nx-archive` (`detectPreviewKind` / `previewKindForNode` in `src/lib/preview.ts`, a preview component, and a media classification in `src/lib/media/classify.ts`).',
	);
	lines.push('');

	if (index.unknown.length) {
		lines.push(`### Unrecognized files (${s.unknownFiles.toLocaleString()} files, ${bytes(s.unknownBytes)})`);
		lines.push('');
		lines.push('Files that fall back to the hex view, grouped by extension, largest total size first.');
		lines.push('');
		lines.push('| Extension | Files | Total size | Leading bytes (samples) | Example paths |');
		lines.push('|---|---|---|---|---|');
		for (const g of index.unknown.slice(0, max)) {
			lines.push(
				`| \`.${cell(g.ext)}\` | ${g.count.toLocaleString()} | ${bytes(g.totalSize)} | ${g.magics.map((m) => `\`${m}\``).join('<br>') || '—'} | ${g.examples
					.slice(0, 3)
					.map((e) => `\`${cell(e)}\``)
					.join('<br>')} |`,
			);
		}
		if (index.unknown.length > max) lines.push(`| … ${index.unknown.length - max} more extensions | | | | |`);
		lines.push('');
	}

	const failed = index.items.filter((i) => !i.partOf && (i.status === 'error' || i.status === 'partial'));
	if (failed.length || index.failures.length) {
		lines.push(`### Media that failed or is incomplete (${(failed.length + index.failures.length).toLocaleString()})`);
		lines.push('');
		lines.push('Recognized as media, but loading it failed or lost data (e.g. missing textures).');
		lines.push('');
		lines.push('| Status | Format | Path | Problem |');
		lines.push('|---|---|---|---|');
		for (const i of failed.slice(0, max)) {
			lines.push(`| ${i.status} | ${cell(i.format)} | \`${cell(i.path)}\` | ${cell(i.note ?? '')} |`);
		}
		for (const f of index.failures.slice(0, Math.max(0, max - failed.length))) {
			lines.push(`| error | | \`${cell(f.path)}\` | ${cell(f.message)} |`);
		}
		lines.push('');
	}

	if (index.errors.length) {
		lines.push(`### Containers that failed to open (${index.errors.length.toLocaleString()})`);
		lines.push('');
		lines.push('| Path | Error |');
		lines.push('|---|---|');
		for (const e of index.errors.slice(0, max)) lines.push(`| \`${cell(e.path)}\` | ${cell(e.message)} |`);
		lines.push('');
	}

	if (index.skipped.length) {
		lines.push(`### Skipped (too expensive for an automatic scan)`);
		lines.push('');
		lines.push('| Path | Size | Reason |');
		lines.push('|---|---|---|');
		for (const e of index.skipped.slice(0, max)) lines.push(`| \`${cell(e.path)}\` | ${e.size ? bytes(e.size) : ''} | ${cell(e.message)} |`);
		lines.push('');
	}

	if (!index.unknown.length && !failed.length && !index.failures.length && !index.errors.length) {
		lines.push('No gaps found — every file was recognized.');
		lines.push('');
	}
	return lines.join('\n');
}
