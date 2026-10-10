/**
 * Headless media-library scan: open a game file with the same archive
 * code as the web app, run the media scan, and print a coverage / gap
 * report (Markdown) — the same document the app's "Gaps" dialog shows.
 *
 *   bun scripts/media-scan.ts <file> [--keys ~/.switch/prod.keys] [--deep]
 *                                    [--md report.md] [--json index.json]
 *
 * Requires Bun (Node's `fs.openAsBlob` truncates files over 4 GiB).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

import { initializeKeySet, type KeySet } from '@tootallnate/nca';

import { buildRootNode } from '../src/lib/archive';
import { gapReportMarkdown, summarize } from '../src/lib/media/gaps';
import { scanMedia } from '../src/lib/media/scanner';
import { MEDIA_KIND_LABEL, MEDIA_KINDS } from '../src/lib/media/types';

declare const Bun: { file(path: string): Blob } | undefined;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
if (!file) {
	console.error('usage: bun scripts/media-scan.ts <file> [--keys prod.keys] [--deep] [--md out.md] [--json out.json]');
	process.exit(1);
}
if (typeof Bun === 'undefined') {
	console.error('Run with Bun: Node truncates files larger than 4 GiB when opened as a Blob.');
	process.exit(1);
}

const keysPath = arg('--keys') ?? `${homedir()}/.switch/prod.keys`;
let keys: KeySet | null = null;
if (existsSync(keysPath)) keys = await initializeKeySet(readFileSync(keysPath, 'utf8'));

const blob = Bun.file(file);
const name = basename(file);
const root = await buildRootNode(blob, name, { getKeys: () => keys, requestKeys: () => {} });

let last = 0;
const index = await scanMedia(
	root,
	{ fileName: name, fileSize: blob.size, platform: root.format ?? 'file' },
	{
		deep: process.argv.includes('--deep'),
		onProgress: (visited, path) => {
			if (process.stderr.isTTY && Date.now() - last > 200) {
				last = Date.now();
				process.stderr.write(`\r\x1b[2Kscanning ${visited.toLocaleString()} ${path.slice(-80)}`);
			}
		},
	},
);
if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');

const s = summarize(index);
console.error(
	`${name}: ${MEDIA_KINDS.map((k) => `${s.counts[k]} ${MEDIA_KIND_LABEL[k].toLowerCase()}`).join(', ')}; ` +
		`${s.parts} merged parts; ${s.unknownFiles} unrecognized files; ${index.errors.length} container errors ` +
		`(${(index.stats.durationMs / 1000).toFixed(1)} s)`,
);

const md = gapReportMarkdown(index);
const mdOut = arg('--md');
const jsonOut = arg('--json');
if (mdOut) writeFileSync(mdOut, md);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(index, null, 1));
if (!mdOut && !jsonOut) console.log(md);
