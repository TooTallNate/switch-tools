/**
 * End-to-end test for the auto-generated extensions and the
 * introspection API.
 *
 * Each case loads a generated extension into a fresh Ffmpeg
 * instance and then asserts what shows up in
 * `listCodecs() / listDemuxers() / listMuxers()`. The
 * introspection layer is the canonical answer to "what's
 * currently registered" (analogous to `ffmpeg -decoders`),
 * so verifying it matches the catalog also verifies that
 * the extension's `.so` parsed, dynamically linked, and
 * registered cleanly.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { Ffmpeg } from "../src/index.ts"

const here = pathResolve(fileURLToPath(import.meta.url), "..")
const pkgRoot = pathResolve(here, "..")
const baseWasm = readFileSync(pathResolve(pkgRoot, "src/ffmpeg.wasm"))

interface ExtCase {
	slug: string
	/** Decoder/encoder name the extension is expected to register. */
	codecName?: string
	/** Demuxer name expected. */
	demuxerName?: string
	/** Muxer name expected. */
	muxerName?: string
}

const CASES: ExtCase[] = [
	{ slug: "pcm-s16le-decoder", codecName: "pcm_s16le" },
	{ slug: "hca-decoder", codecName: "hca" },
	{ slug: "flac-decoder", codecName: "flac" },
	{ slug: "aac-decoder", codecName: "aac" },
	{ slug: "wav-demuxer", demuxerName: "wav" },
	{ slug: "wav-muxer", muxerName: "wav" },
	{ slug: "adts-muxer", muxerName: "adts" },
	{ slug: "flac-demuxer", demuxerName: "flac" },
]

describe("generated extensions", () => {
	for (const c of CASES) {
		it(`registers ${c.slug}`, async () => {
			const so = readFileSync(
				pathResolve(pkgRoot, `src/extensions/${c.slug}/${c.slug}.so`),
			)
			const ff = await Ffmpeg.create({
				wasm: baseWasm,
				extensions: [{ name: c.slug, wasm: so }],
			})

			if (c.codecName) {
				const codecs = ff.listCodecs()
				expect(codecs.length).toBeGreaterThanOrEqual(1)
				const codec = codecs.find((x) => x.name === c.codecName)
				expect(codec, `codec ${c.codecName} should be registered`).toBeDefined()
				expect(codec!.longName.length).toBeGreaterThan(0)
				expect(codec!.isDecoder || codec!.isEncoder).toBe(true)
			}

			if (c.demuxerName) {
				const demuxers = ff.listDemuxers()
				expect(demuxers.length).toBeGreaterThanOrEqual(1)
				const demuxer = demuxers.find((x) => x.name === c.demuxerName)
				expect(
					demuxer,
					`demuxer ${c.demuxerName} should be registered`,
				).toBeDefined()
				expect(demuxer!.longName.length).toBeGreaterThan(0)
			}

			if (c.muxerName) {
				const muxers = ff.listMuxers()
				expect(muxers.length).toBeGreaterThanOrEqual(1)
				const muxer = muxers.find((x) => x.name === c.muxerName)
				expect(
					muxer,
					`muxer ${c.muxerName} should be registered`,
				).toBeDefined()
				expect(muxer!.longName.length).toBeGreaterThan(0)
			}

			ff.dispose()
		})
	}

	it("loads many extensions and lists everything", async () => {
		const exts = CASES.map((c) => ({
			name: c.slug,
			wasm: readFileSync(
				pathResolve(pkgRoot, `src/extensions/${c.slug}/${c.slug}.so`),
			),
		}))
		const ff = await Ffmpeg.create({ wasm: baseWasm, extensions: exts })

		const codecs = ff.listCodecs()
		const demuxers = ff.listDemuxers()
		const muxers = ff.listMuxers()

		// One codec per codec-extension, etc.
		const expectedCodecNames = CASES.filter((c) => c.codecName).map(
			(c) => c.codecName!,
		)
		const expectedDemuxerNames = CASES.filter((c) => c.demuxerName).map(
			(c) => c.demuxerName!,
		)
		const expectedMuxerNames = CASES.filter((c) => c.muxerName).map(
			(c) => c.muxerName!,
		)
		expect(codecs.map((c) => c.name).sort()).toEqual(
			expectedCodecNames.sort(),
		)
		expect(demuxers.map((d) => d.name).sort()).toEqual(
			expectedDemuxerNames.sort(),
		)
		expect(muxers.map((m) => m.name).sort()).toEqual(
			expectedMuxerNames.sort(),
		)

		ff.dispose()
	})

	/**
	 * Heavy test: load EVERY built extension into a single Ffmpeg
	 * instance and sanity-check the resulting catalog.
	 *
	 * Validates:
	 *   - Loader correctly handles hundreds of extensions in one
	 *     `create()` call.
	 *   - The introspection arrays' sizing limits are big enough.
	 *   - Every loaded extension's claimed kind matches what
	 *     ends up registered (no decoder extensions registering
	 *     in the demuxer table, etc.).
	 *   - There are no name collisions in the registered set
	 *     (uniqueness of codec/demuxer/muxer names).
	 */
	it("loads every built extension at once", async () => {
		const extRoot = pathResolve(pkgRoot, "src/extensions")
		const slugs = readdirSync(extRoot).filter((n) => {
			try {
				const s = statSync(pathResolve(extRoot, n))
				if (!s.isDirectory()) return false
				statSync(pathResolve(extRoot, n, `${n}.so`))
				return true
			} catch {
				return false
			}
		})
		const exts = slugs.map((slug) => ({
			name: slug,
			wasm: readFileSync(pathResolve(extRoot, slug, `${slug}.so`)),
		}))

		const ff = await Ffmpeg.create({ wasm: baseWasm, extensions: exts })

		const codecs = ff.listCodecs()
		const demuxers = ff.listDemuxers()
		const muxers = ff.listMuxers()

		// We loaded a known number of slugs from a known catalog.
		// Each slug registers exactly one thing (codecs / demuxers
		// / muxers), so the totals should equal the slug counts
		// per kind.
		const decoderSlugs = slugs.filter((s) => s.endsWith("-decoder"))
		const encoderSlugs = slugs.filter((s) => s.endsWith("-encoder"))
		const demuxerSlugs = slugs.filter((s) => s.endsWith("-demuxer"))
		const muxerSlugs = slugs.filter((s) => s.endsWith("-muxer"))

		// listCodecs() returns BOTH decoders and encoders.
		expect(codecs.length).toBe(decoderSlugs.length + encoderSlugs.length)
		expect(demuxers.length).toBe(demuxerSlugs.length)
		expect(muxers.length).toBe(muxerSlugs.length)

		// No duplicate codec/demuxer/muxer names.
		// (A codec named "aac" may exist in BOTH the decoder and
		// encoder slug — both are valid, but at the AVCodec level
		// they're separate entries.)
		expect(new Set(codecs.map((c) => `${c.name}/${c.isDecoder ? "d" : "e"}`)).size).toBe(
			codecs.length,
		)
		expect(new Set(demuxers.map((d) => d.name)).size).toBe(demuxers.length)
		expect(new Set(muxers.map((m) => m.name)).size).toBe(muxers.length)

		ff.dispose()
	}, 30_000)
})
