/**
 * Copy AudioWorklet processor files from `node_modules` to
 * `public/` so they're served as same-origin static assets.
 *
 * Why a script and not `?url` imports? `audioContext.audioWorklet
 * .addModule(url)` resolves `url` against the SW-controlled root
 * fetcher — Vite's transformed `?url` paths sometimes carry hashes
 * or live under `/@fs/`, neither of which the worklet runtime
 * fetches reliably across browsers. A flat `/spessasynth_processor.min.js`
 * URL "just works" and the file is tiny enough not to need
 * fingerprinting.
 *
 * The script runs as part of `predev` / `prebuild`.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Resolve a path inside an installed dependency, using Node's
 * module resolution so workspace overrides + pnpm hard-links
 * work the same as runtime imports.
 */
function resolveDepFile(pkg, file) {
	// `require.resolve` finds the package's `main` entry; we strip
	// down to the package root and then append the desired file.
	const main = require.resolve(`${pkg}/package.json`);
	return resolve(dirname(main), file);
}

const PUBLIC_DIR = resolve(__dirname, '..', 'public');

if (!existsSync(PUBLIC_DIR)) {
	mkdirSync(PUBLIC_DIR, { recursive: true });
}

const worklets = [
	{
		from: resolveDepFile('spessasynth_lib', 'dist/spessasynth_processor.min.js'),
		to: resolve(PUBLIC_DIR, 'spessasynth_processor.min.js'),
	},
];

for (const w of worklets) {
	copyFileSync(w.from, w.to);
	console.log(`Copied ${w.from} -> ${w.to}`);
}
