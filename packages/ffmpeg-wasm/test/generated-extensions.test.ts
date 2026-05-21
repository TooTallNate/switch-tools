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
	 * Heavy test: load every built extension that the base WASM
	 * can resolve all symbols for. Reports a count.
	 *
	 * As the base expands its export surface, more extensions
	 * become loadable. This test treats that progress as the
	 * success metric — it doesn't fail when extensions exist
	 * that the base can't yet satisfy; it only fails if a
	 * loadable extension fails to actually load.
	 */
	it("loads every built extension whose symbols the base can satisfy", async () => {
		const baseExports = new Set(
			WebAssembly.Module.exports(new WebAssembly.Module(baseWasm)).map(
				(e) => e.name,
			),
		)
		// Symbols provided by the dynamic loader rather than the
		// base WASM module. Not "missing" from a load standpoint.
		const LOADER_PROVIDED = new Set(["__memory_base", "__table_base"])

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

		const loadable: { slug: string; wasm: Buffer }[] = []
		let unsatisfied = 0
		let parseErrors = 0
		for (const slug of slugs) {
			const wasm = readFileSync(pathResolve(extRoot, slug, `${slug}.so`))
			let mod: WebAssembly.Module
			try {
				mod = new WebAssembly.Module(wasm)
			} catch {
				parseErrors++
				continue
			}
			const envImports = WebAssembly.Module.imports(mod)
				.filter((i) => i.module === "env")
				.map((i) => i.name)
			const missing = envImports.filter(
				(n) => !baseExports.has(n) && !LOADER_PROVIDED.has(n),
			)
			if (missing.length === 0) loadable.push({ slug, wasm })
			else unsatisfied++
		}

		// We should have at least the basic core working — if this
		// regresses, something broke. Bump as the surface grows.
		expect(loadable.length).toBeGreaterThanOrEqual(400)

		const exts = loadable.map((e) => ({ name: e.slug, wasm: e.wasm }))
		const ff = await Ffmpeg.create({ wasm: baseWasm, extensions: exts })

		const codecs = ff.listCodecs()
		const demuxers = ff.listDemuxers()
		const muxers = ff.listMuxers()

		// Each loadable slug should register exactly one thing
		// matching its kind suffix.
		const decoderSlugs = loadable.filter((e) => e.slug.endsWith("-decoder"))
		const encoderSlugs = loadable.filter((e) => e.slug.endsWith("-encoder"))
		const demuxerSlugs = loadable.filter((e) => e.slug.endsWith("-demuxer"))
		const muxerSlugs = loadable.filter((e) => e.slug.endsWith("-muxer"))

		expect(codecs.length).toBe(decoderSlugs.length + encoderSlugs.length)
		expect(demuxers.length).toBe(demuxerSlugs.length)
		expect(muxers.length).toBe(muxerSlugs.length)

		ff.dispose()

		// Diagnostic line for stdout — useful while we expand the
		// base's export surface.
		// eslint-disable-next-line no-console
		console.log(
			`[${loadable.length} loadable / ${unsatisfied} unsatisfied / ${parseErrors} parse-error of ${slugs.length} built]`,
		)
	}, 60_000)
})
