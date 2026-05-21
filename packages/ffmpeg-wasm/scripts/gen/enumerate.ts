/**
 * Enumerate every codec / demuxer / muxer FFmpeg upstream knows
 * about, with enough metadata to decide whether to ship as a
 * generated extension.
 *
 * Inputs:
 *   - `libavcodec/allcodecs.c`      — list of FFCodec extern decls
 *   - `libavformat/allformats.c`    — list of AVInput/OutputFormat decls
 *   - `configure`                    — for GPL / nonfree / external
 *                                       categorisation
 *   - parsed Makefile data           — to look up which `.c` files
 *                                       each thing pulls in (used
 *                                       to filter externals + arch-
 *                                       gated variants)
 *
 * Output: a list of `EnumeratedEntry` records ready to feed into
 * the catalog / generator.
 */
import { readFileSync } from "node:fs"

import type { ConfigureData } from "./parse-configure.ts"
import type { MakefileData } from "./parse-makefile.ts"

export type EnumeratedKind = "decoder" | "encoder" | "demuxer" | "muxer"

export interface EnumeratedEntry {
	/** Lowercase `<name>_<kind>`, matches the `_select` keys in configure. */
	thing: string
	/** Just `<name>`, useful for slugs and human display. */
	stem: string
	kind: EnumeratedKind
	/** `ff_<thing>` per FFmpeg convention. */
	symbol: string
	/** The CONFIG_* flag the Makefile gates this on. */
	configFlag: string
	/**
	 * Classification of this entry:
	 *   - `native`    — pure upstream C, safe to ship
	 *   - `gpl`       — GPL-only (e.g. libx264) — skip in npm
	 *   - `nonfree`   — non-free (e.g. libfdk_aac)  — skip in npm
	 *   - `external`  — depends on an external library we don't
	 *                    bundle yet (libvorbis, libopus, ...) — skip
	 *   - `hardware`  — needs platform-specific accel (cuda, vaapi,
	 *                    mediacodec, ...) — skip for WASM
	 *   - `version3`  — LGPLv3 / GPLv3 — skip until we sort licensing
	 *   - `unknown`   — couldn't classify; skip and log
	 */
	classification:
		| "native"
		| "gpl"
		| "nonfree"
		| "external"
		| "hardware"
		| "version3"
		| "unknown"
}

export interface EnumerateOptions {
	allcodecsSource: string
	allformatsSource: string
	configure: ConfigureData
	makefiles: { library: string; data: MakefileData }[]
	/** Set of external library names FFmpeg treats as GPL. */
	gplLibs: Set<string>
	/** Non-free externals. */
	nonfreeLibs: Set<string>
	/** Version-3 externals. */
	version3Libs: Set<string>
	/** All known external libraries (union of all categories). */
	allExternalLibs: Set<string>
}

// Hardware / accel suffixes the Makefile uses for codec variants
// we can't build for wasi (require GPU / OS APIs).
const HARDWARE_SUFFIXES = [
	"cuvid",
	"nvenc",
	"nvdec",
	"vaapi",
	"vdpau",
	"qsv",
	"videotoolbox",
	"mediacodec",
	"mediafoundation",
	"omx",
	"v4l2m2m",
	"amf",
	"rkmpp",
	"crystalhd",
	"d3d11va",
	"d3d12va",
	"dxva2",
	"mmal",
	"at",          // Apple AudioToolbox suffix
]

/**
 * Configure-level `_deps` that imply we can't ship this in
 * wasm32-wasip1: OS platform integrations, hardware codec
 * APIs, missing kernel features.
 */
const HARDWARE_DEPS = new Set([
	"cuda_llvm",
	"cuda",
	"audiotoolbox",
	"videotoolbox",
	"mediacodec",
	"mediafoundation",
	"mmal",
	"omx",
	"v4l2_m2m",
	"rkmpp",
	"vaapi",
	"vdpau",
	"qsv",
	"amf",
	"crystalhd",
	"d3d11va",
	"d3d12va",
	"dxva2",
	"appkit",
	"avfoundation",
	"jni",
	"vulkan",
	"metal",
	"coreimage",
	"opengl",
	"openal",
	"x11grab",
	"libxcb",
	"sdl2",
	"alsa",
	"pulse",
	"oss",
	"jack",
	"sndio",
	"decklink",
	"libcdio",
	"libdc1394",
	"libv4l2",
	"linux_perf",
	"posix_memalign",
	"libdrm",
])

/** Strip the `ff_` prefix and parse `<stem>_<kind>`. */
function parseSymbol(
	sym: string,
): { thing: string; stem: string; kind: EnumeratedKind } | null {
	if (!sym.startsWith("ff_")) return null
	const body = sym.slice(3)
	for (const k of [
		"decoder",
		"encoder",
		"demuxer",
		"muxer",
	] as const) {
		const suffix = `_${k}`
		if (body.endsWith(suffix)) {
			const stem = body.slice(0, -suffix.length)
			return { thing: body, stem, kind: k }
		}
	}
	return null
}

/**
 * Extract every `extern const <Type> ff_<name>_<kind>;` declaration
 * from a source file like `allcodecs.c`.
 */
function extractExterns(source: string): string[] {
	const out: string[] = []
	const re = /^extern const \w+\s+(ff_[a-z0-9_]+);/gm
	let m: RegExpExecArray | null
	while ((m = re.exec(source))) {
		out.push(m[1]!)
	}
	return out
}

/**
 * Determine whether a thing should be shippable as a generated
 * native extension. Looks at:
 *   - hardware accel suffixes in the stem
 *   - prefix match against an `external` library name
 *   - configure-level licensing buckets
 */
function classify(
	stem: string,
	configFlag: string,
	opts: EnumerateOptions,
): EnumeratedEntry["classification"] {
	// Hardware: codec stems with a hardware suffix.
	for (const suffix of HARDWARE_SUFFIXES) {
		if (stem.endsWith(`_${suffix}`)) return "hardware"
	}

	// Anything whose stem starts with `lib` is, by FFmpeg
	// convention, a wrapper around an external library. Even
	// if the specific `libfoo` isn't enumerated in
	// `EXTERNAL_LIBRARY_LIST` (e.g. `libx262` lives in a
	// secondary list), the source file `libfoo.c` always
	// `#include`s the external library's headers. Mark as
	// external by default — concrete subcategorisation (GPL /
	// nonfree / etc.) gets folded in below if we recognise it.
	if (stem.startsWith("lib")) {
		// Strip an underscore-suffixed codec qualifier so we
		// match the right library entry: `libvpx_vp9` → `libvpx`.
		for (const lib of opts.allExternalLibs) {
			if (stem === lib || stem.startsWith(lib + "_")) {
				if (opts.gplLibs.has(lib)) return "gpl"
				if (opts.nonfreeLibs.has(lib)) return "nonfree"
				if (opts.version3Libs.has(lib)) return "version3"
				return "external"
			}
		}
		// Catch-all for `lib*` stems we don't have a libs-list
		// entry for (e.g. `libx262`). Treat as external.
		return "external"
	}

	// Some non-`lib*` externals (e.g. `chromaprint`, `avisynth`,
	// `frei0r`). Check stem against external lib list directly.
	if (opts.allExternalLibs.has(stem)) {
		if (opts.gplLibs.has(stem)) return "gpl"
		if (opts.nonfreeLibs.has(stem)) return "nonfree"
		if (opts.version3Libs.has(stem)) return "version3"
		return "external"
	}

	// `configure`'s `_deps` AND `_select` cascades may say "this
	// thing requires X" where X is a hardware / external /
	// OS-platform thing. We need to chase _select transitively
	// because helpers can themselves depend on externals (e.g.
	// `inflate_wrapper_deps=zlib`).
	const visited = new Set<string>()
	const stack: string[] = [
		`${stem}_decoder`,
		`${stem}_encoder`,
		`${stem}_demuxer`,
		`${stem}_muxer`,
	]
	while (stack.length > 0) {
		const cur = stack.pop()!
		if (visited.has(cur)) continue
		visited.add(cur)

		const deps = opts.configure.deps.get(cur)
		if (deps) {
			for (const d of deps) {
				if (opts.gplLibs.has(d)) return "gpl"
				if (opts.nonfreeLibs.has(d)) return "nonfree"
				if (opts.version3Libs.has(d)) return "version3"
				if (opts.allExternalLibs.has(d)) return "external"
				if (HARDWARE_DEPS.has(d)) return "hardware"
				if (HARDWARE_SUFFIXES.some((s) => d.includes(s))) return "hardware"
				// Follow the dependency further so its own deps /
				// selects are evaluated.
				stack.push(d)
			}
		}
		const selects = opts.configure.select.get(cur)
		if (selects) {
			for (const s of selects) stack.push(s)
		}
	}

	// Anything else: assume native.
	return "native"
}

export function enumerate(opts: EnumerateOptions): EnumeratedEntry[] {
	// Index the makefile's OBJS rules so we can verify a thing
	// actually has a compile unit (some declarations are dead
	// in the upstream tree).
	const knownConfigs = new Set<string>()
	for (const mf of opts.makefiles) {
		for (const k of mf.data.conditionalObjs.keys()) knownConfigs.add(k)
	}

	const out: EnumeratedEntry[] = []

	// Codecs.
	for (const sym of extractExterns(opts.allcodecsSource)) {
		const parsed = parseSymbol(sym)
		if (!parsed) continue
		const configFlag = parsed.thing.toUpperCase()
		if (!knownConfigs.has(configFlag)) {
			// Declaration without a build rule — orphan. Skip.
			continue
		}
		out.push({
			thing: parsed.thing,
			stem: parsed.stem,
			kind: parsed.kind,
			symbol: sym,
			configFlag,
			classification: classify(parsed.stem, configFlag, opts),
		})
	}

	// Formats.
	for (const sym of extractExterns(opts.allformatsSource)) {
		const parsed = parseSymbol(sym)
		if (!parsed) continue
		const configFlag = parsed.thing.toUpperCase()
		if (!knownConfigs.has(configFlag)) {
			continue
		}
		out.push({
			thing: parsed.thing,
			stem: parsed.stem,
			kind: parsed.kind,
			symbol: sym,
			configFlag,
			classification: classify(parsed.stem, configFlag, opts),
		})
	}

	// Stable order: by kind then name.
	out.sort((a, b) =>
		a.kind === b.kind
			? a.thing.localeCompare(b.thing)
			: a.kind.localeCompare(b.kind),
	)
	return out
}

/** Convenience wrapper that reads the upstream files. */
export function enumerateFromFiles(opts: {
	ffmpegRoot: string
	configure: ConfigureData
	makefiles: { library: string; data: MakefileData }[]
	gplLibs: Set<string>
	nonfreeLibs: Set<string>
	version3Libs: Set<string>
	allExternalLibs: Set<string>
}): EnumeratedEntry[] {
	return enumerate({
		allcodecsSource: readFileSync(
			`${opts.ffmpegRoot}/libavcodec/allcodecs.c`,
			"utf8",
		),
		allformatsSource: readFileSync(
			`${opts.ffmpegRoot}/libavformat/allformats.c`,
			"utf8",
		),
		configure: opts.configure,
		makefiles: opts.makefiles,
		gplLibs: opts.gplLibs,
		nonfreeLibs: opts.nonfreeLibs,
		version3Libs: opts.version3Libs,
		allExternalLibs: opts.allExternalLibs,
	})
}
