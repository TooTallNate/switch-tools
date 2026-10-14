/**
 * Headless media-library scan: open a game file with the same archive
 * code as the web app, run the media scan, and print a coverage / gap
 * report (Markdown) — the same document the app's "Gaps" dialog shows.
 *
 *   bun scripts/media-scan.ts <file|folder> [--keys ~/.switch/prod.keys] [--deep]
 *                                    [--oodle oodle.wasm]
 *                                    [--md report.md] [--json index.json]
 *
 * `--oodle` defaults to `~/.switch/oodle.wasm`, then a local build at
 * `packages/oodle-wasm/src/oodle.wasm` (see its README); without one,
 * Oodle-compressed content (UE paks, newer GFPAKs) is reported as gaps.
 *
 * A folder is opened like the app's folder picker: one root holding
 * every file under it (so, for example, a Switch update NSP pairs with
 * its base game NSP).
 *
 * Requires Bun (Node's `fs.openAsBlob` truncates files over 4 GiB).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeKeySet, type KeySet } from '@tootallnate/nca';
import { OodleDecoder } from '@tootallnate/oodle-wasm';

import { buildDirectoryRootNode, buildRootNode } from '../src/lib/archive';
import type { WalkedFile } from '../src/lib/directory';
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
	console.error('usage: bun scripts/media-scan.ts <file|folder> [--keys prod.keys] [--deep] [--oodle oodle.wasm] [--md out.md] [--json out.json]');
	process.exit(1);
}
if (typeof Bun === 'undefined') {
	console.error('Run with Bun: Node truncates files larger than 4 GiB when opened as a Blob.');
	process.exit(1);
}

const keysPath = arg('--keys') ?? `${homedir()}/.switch/prod.keys`;
let keys: KeySet | null = null;
if (existsSync(keysPath)) keys = await initializeKeySet(readFileSync(keysPath, 'utf8'));

const oodlePath = [
	arg('--oodle'),
	`${homedir()}/.switch/oodle.wasm`,
	join(dirname(fileURLToPath(import.meta.url)), '../../../packages/oodle-wasm/src/oodle.wasm'),
].find((p) => p && existsSync(p));
const oodle = oodlePath ? await OodleDecoder.create(readFileSync(oodlePath)) : null;
if (oodle) console.error(`Oodle: ${oodlePath}`);

const ctx = {
	getKeys: () => keys,
	requestKeys: () => {},
	getOodleDecompressor: () => (oodle ? async (c: Uint8Array, n: number) => oodle.decompress(c, n) : null),
};
const name = basename(file);
let root;
let totalSize = 0;
if (statSync(file).isDirectory()) {
	const files: WalkedFile[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				files.push({ relativePath: relative(file, path), file: Bun.file(path) as File });
				totalSize += statSync(path).size;
			}
		}
	};
	walk(file);
	root = await buildDirectoryRootNode({ name, files }, ctx);
} else {
	const blob = Bun.file(file);
	totalSize = blob.size;
	root = await buildRootNode(blob, name, ctx);
}

let last = 0;
const index = await scanMedia(
	root,
	{ fileName: name, fileSize: totalSize, platform: root.format ?? 'file' },
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
		`${s.parts} merged parts; ${index.stats.duplicates ?? 0} duplicates folded; ${s.unknownFiles} unrecognized files; ${index.errors.length} container errors ` +
		`(${(index.stats.durationMs / 1000).toFixed(1)} s)`,
);

const md = gapReportMarkdown(index);
const mdOut = arg('--md');
const jsonOut = arg('--json');
if (mdOut) writeFileSync(mdOut, md);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(index, null, 1));
if (!mdOut && !jsonOut) console.log(md);
