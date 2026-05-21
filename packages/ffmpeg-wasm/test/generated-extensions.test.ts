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
	/** Decoder/encoder name(s) the extension is expected to register. */
	codecNames?: string[]
	/** Demuxer name(s) expected. */
	demuxerNames?: string[]
	/** Muxer name(s) expected. */
	muxerNames?: string[]
}

const CASES: ExtCase[] = [
	// `pcm` bundles all 32 PCM variants + their demuxers + muxers
	// into one extension. We just sample a few.
	{
		slug: "pcm",
		codecNames: ["pcm_s16le", "pcm_s24be", "pcm_f32le"],
		demuxerNames: ["s16le", "s24be"],
	},
	// HCA: decoder-only, no encoder / mux / demux.
	{ slug: "hca", codecNames: ["hca"] },
	// FLAC: full decoder + encoder + demuxer + muxer bundle.
	{
		slug: "flac",
		codecNames: ["flac"],
		demuxerNames: ["flac"],
		muxerNames: ["flac"],
	},
	// AAC: decoder + fixed-point decoder + encoder + ADTS demuxer/muxer +
	// raw AAC demuxer + LATM muxer all bundled.
	{
		slug: "aac",
		codecNames: ["aac"],
	},
	// WAV: demuxer + muxer (no PCM codec — that lives in `pcm`).
	{ slug: "wav", demuxerNames: ["wav"], muxerNames: ["wav"] },
	// ADTS muxer lives in `aac` group.
	// FLAC demuxer is already covered in `flac` above.
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

			if (c.codecNames) {
				const codecs = ff.listCodecs()
				expect(codecs.length).toBeGreaterThanOrEqual(c.codecNames.length)
				for (const name of c.codecNames) {
					const codec = codecs.find((x) => x.name === name)
					expect(codec, `codec ${name} should be registered`).toBeDefined()
					expect(codec!.longName.length).toBeGreaterThan(0)
					expect(codec!.isDecoder || codec!.isEncoder).toBe(true)
				}
			}

			if (c.demuxerNames) {
				const demuxers = ff.listDemuxers()
				expect(demuxers.length).toBeGreaterThanOrEqual(c.demuxerNames.length)
				for (const name of c.demuxerNames) {
					const demuxer = demuxers.find((x) => x.name === name)
					expect(
						demuxer,
						`demuxer ${name} should be registered`,
					).toBeDefined()
					expect(demuxer!.longName.length).toBeGreaterThan(0)
				}
			}

			if (c.muxerNames) {
				const muxers = ff.listMuxers()
				expect(muxers.length).toBeGreaterThanOrEqual(c.muxerNames.length)
				for (const name of c.muxerNames) {
					const muxer = muxers.find((x) => x.name === name)
					expect(
						muxer,
						`muxer ${name} should be registered`,
					).toBeDefined()
					expect(muxer!.longName.length).toBeGreaterThan(0)
				}
			}

			ff.dispose()
		})
	}

	it("loads sampled grouped extensions and lists their contents", async () => {
		const exts = CASES.map((c) => ({
			name: c.slug,
			wasm: readFileSync(
				pathResolve(pkgRoot, `src/extensions/${c.slug}/${c.slug}.so`),
			),
		}))
		const ff = await Ffmpeg.create({ wasm: baseWasm, extensions: exts })

		// We expect AT LEAST the explicitly named things, plus
		// whatever else gets bundled into those groups.
		const codecs = ff.listCodecs()
		const demuxers = ff.listDemuxers()
		const muxers = ff.listMuxers()

		for (const c of CASES) {
			for (const name of c.codecNames ?? []) {
				expect(
					codecs.some((x) => x.name === name),
					`expected codec ${name} from ${c.slug}`,
				).toBe(true)
			}
			for (const name of c.demuxerNames ?? []) {
				expect(
					demuxers.some((x) => x.name === name),
					`expected demuxer ${name} from ${c.slug}`,
				).toBe(true)
			}
			for (const name of c.muxerNames ?? []) {
				expect(
					muxers.some((x) => x.name === name),
					`expected muxer ${name} from ${c.slug}`,
				).toBe(true)
			}
		}

		// Sanity: PCM extension alone registers dozens of codecs.
		const pcmCodecs = codecs.filter((c) => c.name.startsWith("pcm_"))
		expect(pcmCodecs.length).toBeGreaterThanOrEqual(20)

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
		expect(loadable.length).toBeGreaterThanOrEqual(300)

		const exts = loadable.map((e) => ({ name: e.slug, wasm: e.wasm }))
		const ff = await Ffmpeg.create({ wasm: baseWasm, extensions: exts })

		const codecs = ff.listCodecs()
		const demuxers = ff.listDemuxers()
		const muxers = ff.listMuxers()

		// Loaded extensions register one or more things each.
		// We just sanity-check totals are positive and that no
		// extension claims duplicates within the same kind.
		expect(codecs.length).toBeGreaterThan(0)
		expect(demuxers.length).toBeGreaterThan(0)
		expect(muxers.length).toBeGreaterThan(0)

		// Uniqueness: no two registered codecs should share both
		// name AND kind (decoder vs encoder), no duplicate
		// demuxer/muxer names.
		expect(
			new Set(codecs.map((c) => `${c.name}/${c.isDecoder ? "d" : "e"}`)).size,
		).toBe(codecs.length)
		expect(new Set(demuxers.map((d) => d.name)).size).toBe(demuxers.length)
		expect(new Set(muxers.map((m) => m.name)).size).toBe(muxers.length)

		ff.dispose()

		// Diagnostic line for stdout — useful while we expand the
		// base's export surface.
		// eslint-disable-next-line no-console
		console.log(
			`[${loadable.length} loadable / ${unsatisfied} unsatisfied / ${parseErrors} parse-error of ${slugs.length} built]`,
		)
	}, 60_000)
})
