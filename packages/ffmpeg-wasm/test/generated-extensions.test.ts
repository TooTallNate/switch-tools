/**
 * Smoke test: load each generated extension into a fresh
 * Ffmpeg instance and verify it registers without errors.
 *
 * This validates the generator's output end-to-end: shim.h
 * forces the right CONFIG flags, init.c exports the right
 * `ffmpeg_ext_*` accessors, the wasi-sdk-shared `.so` parses
 * cleanly, and the base WASM's `ffmpeg_register_codec` /
 * `ffmpeg_register_demuxer` accept the pointers.
 */
import { readFileSync } from "node:fs"
import { resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { Ffmpeg } from "../src/index.ts"

const here = pathResolve(fileURLToPath(import.meta.url), "..")
const pkgRoot = pathResolve(here, "..")
const baseWasm = readFileSync(pathResolve(pkgRoot, "src/ffmpeg.wasm"))

interface ExtCase {
	slug: string
	expectCodecs: number
	expectDemuxers: number
}

const CASES: ExtCase[] = [
	{ slug: "pcm-s16le-decoder", expectCodecs: 1, expectDemuxers: 0 },
	{ slug: "hca-decoder", expectCodecs: 1, expectDemuxers: 0 },
	{ slug: "flac-decoder", expectCodecs: 1, expectDemuxers: 0 },
	{ slug: "aac-decoder", expectCodecs: 1, expectDemuxers: 0 },
	{ slug: "wav-demuxer", expectCodecs: 0, expectDemuxers: 1 },
	// muxers: currently the loader doesn't auto-register these.
	// Once we add muxer support, expectMuxers should grow.
]

describe("generated extensions", () => {
	for (const c of CASES) {
		it(`loads ${c.slug}`, async () => {
			const so = readFileSync(
				pathResolve(pkgRoot, `src/extensions/${c.slug}/${c.slug}.so`),
			)
			const ff = await Ffmpeg.create({
				wasm: baseWasm,
				extensions: [{ name: c.slug, wasm: so }],
			})
			// The loader populates loadedExtension.codecs / .demuxers
			// arrays — but `Ffmpeg` doesn't currently surface that.
			// For now we just confirm the instance was constructed
			// without throwing (which means the .so parsed, linked,
			// and registered all its codecs without errors).
			expect(ff).toBeDefined()
			ff.dispose()
		})
	}
})
