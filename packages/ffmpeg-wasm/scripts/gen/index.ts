/**
 * Generator entry point: produce per-extension directories under
 * `src/extensions/` for every entry in the catalog.
 *
 * Run with:
 *
 *   bun scripts/gen/index.ts
 *   # or
 *   node --experimental-strip-types scripts/gen/index.ts
 *
 * Output layout (relative to the @tootallnate/ffmpeg-wasm package
 * root):
 *
 *   src/extensions/
 *     aac-decoder/
 *       Makefile
 *       init.c
 *       shim.h
 *       manifest.json
 *       (and after `make`: aac-decoder.so)
 *     flac-decoder/...
 *     wav-demuxer/...
 *
 * The generator is deterministic: same upstream FFmpeg source +
 * same catalog = byte-identical output.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
	SEED_CATALOG,
	catalogToExtensionEntries,
} from "./codec-catalog.ts"
import { emitFiles } from "./emit.ts"
import { parseConfigureFile } from "./parse-configure.ts"
import { parseMakefileFile } from "./parse-makefile.ts"
import { resolve } from "./resolve.ts"

// Helpers already in the base WASM (mirror of enable-helpers.sh).
const BASE_HELPERS = new Set([
	"blockdsp",
	"pixblockdsp",
	"bswapdsp",
	"idctdsp",
	"fdctdsp",
	"hpeldsp",
	"qpeldsp",
	"videodsp",
	"h264chroma",
	"h264dsp",
	"h264pred",
	"h264qpel",
	"fft",
	"rdft",
	"mdct",
	"dct",
	"sinewin",
	"audiodsp",
	"mpegaudiodsp",
	"mpegaudio",
	"aandcttables",
	"wma_freqs",
	"cabac",
	"huffyuvdsp",
	"huffyuvencdsp",
	"intrax8",
	"me_cmp",
	"mpegvideo",
	"mpegvideoenc",
	"mpegvideodec",
	"pixelutils",
])

function main() {
	const here = dirname(fileURLToPath(import.meta.url))
	const pkgRoot = pathResolve(here, "..", "..")
	const ffmpegRoot = pathResolve(pkgRoot, "build", "ffmpeg")

	const configure = parseConfigureFile(`${ffmpegRoot}/configure`)
	const codec = parseMakefileFile(`${ffmpegRoot}/libavcodec/Makefile`)
	const fmt = parseMakefileFile(`${ffmpegRoot}/libavformat/Makefile`)

	const opts = {
		configure,
		makefiles: [
			{ library: "libavcodec", data: codec },
			{ library: "libavformat", data: fmt },
		],
		baseHelpers: BASE_HELPERS,
	}

	const extRoot = pathResolve(pkgRoot, "src", "extensions")
	mkdirSync(extRoot, { recursive: true })

	let generated = 0
	for (const cat of SEED_CATALOG) {
		// Union the resolved objs / configFlags across every
		// entry in the extension. Most extensions have just one
		// entry; multi-entry ones (e.g. binkaudio RDFT+DCT) merge
		// naturally since they share most object files.
		const resolved = {
			objs: [] as { library: string; obj: string }[],
			configFlags: [] as string[],
			resolvedFromBase: [] as string[],
		}
		const seenObjs = new Set<string>()
		const seenFlags = new Set<string>()
		const seenBase = new Set<string>()
		for (const e of cat.entries) {
			const r = resolve(e.thing, opts)
			for (const o of r.objs) {
				const k = `${o.library}/${o.obj}`
				if (!seenObjs.has(k)) {
					seenObjs.add(k)
					resolved.objs.push(o)
				}
			}
			for (const f of r.configFlags) {
				if (!seenFlags.has(f)) {
					seenFlags.add(f)
					resolved.configFlags.push(f)
				}
			}
			for (const b of r.resolvedFromBase) {
				if (!seenBase.has(b)) {
					seenBase.add(b)
					resolved.resolvedFromBase.push(b)
				}
			}
			// The codec / demuxer / muxer thing itself becomes a
			// CONFIG flag we need to force on.
			const ownFlag = e.thing.toUpperCase()
			if (!seenFlags.has(ownFlag)) {
				seenFlags.add(ownFlag)
				resolved.configFlags.push(ownFlag)
			}
		}

		const files = emitFiles({
			slug: cat.slug,
			description: cat.description,
			entries: catalogToExtensionEntries(cat),
			resolved,
			// extensions live at src/extensions/<slug>/, so going
			// back to the package root means 3 levels up:
			// ../../../ → packages/ffmpeg-wasm/
			baseRel: "../../..",
		})

		const dir = pathResolve(extRoot, cat.slug)
		mkdirSync(dir, { recursive: true })
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(pathResolve(dir, name), content)
		}
		generated++
		console.log(`generated ${cat.slug} (${resolved.objs.length} objs)`)
	}

	console.log(`\nGenerated ${generated} extension(s) in ${extRoot}`)
}

main()
