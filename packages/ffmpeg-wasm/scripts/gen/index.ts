/**
 * Generator entry point: enumerate every native upstream codec /
 * demuxer / muxer, generate a per-extension directory for each,
 * and emit a package-level manifest.
 *
 * Run with:
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
 *     ...
 *   dist/extensions-manifest.json
 *
 * The generator is deterministic: same upstream FFmpeg source =
 * byte-identical output. The current run skips any classification
 * other than `native`; GPL / nonfree / external / hardware / etc.
 * fall through silently.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"

import { emitFiles, type ExtensionEntry } from "./emit.ts"
import { enumerateFromFiles, type EnumeratedEntry } from "./enumerate.ts"
import { groupFor } from "./grouping.ts"
import { parseConfigureFile } from "./parse-configure.ts"
import { parseExternalLibsFile } from "./parse-external-libs.ts"
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
	"mpegaudioheader",
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
	"mpeg_er",
	"error_resilience",
	"rangecoder",
	"vp3dsp",
	"pixelutils",
	"audio_frame_queue",
	"iso_media",
	"mpeg4audio",
	"wmv2dsp",
])

/**
 * Decide whether a thing should be generated. Currently:
 *   - Only `native` classification.
 *   - Skip hand-curated extensions (those with their own
 *     packages, see `HAND_CURATED` below).
 *   - Skip a small set of known-broken-in-our-base things
 *     (typically anything that needs an explicit upstream
 *     parser/BSF we don't have wired up yet).
 *
 * Returns `null` to skip, or a reason string for diagnostics.
 */
function inclusionFilter(e: EnumeratedEntry): string | null {
	if (e.classification !== "native") {
		return `non-native (${e.classification})`
	}
	if (HAND_CURATED.has(e.thing)) {
		return "hand-curated (lives in its own package)"
	}
	if (KNOWN_BROKEN.has(e.thing)) {
		return "known-broken (needs threading or networking)"
	}
	return null
}

/**
 * Things that already live as hand-written packages with their
 * own patches / quirks (Bink 2 needs Paul B Mahol's out-of-tree
 * patch; the rest are decoder helpers / shared infrastructure).
 * Excluded from generation so we don't double-publish them.
 */
const HAND_CURATED = new Set([
	"bink_decoder",
	"binkaudio_dct_decoder",
	"binkaudio_rdft_decoder",
	"bink_demuxer",
	// bink2_decoder — synthetic AVCodecID, also hand-curated
])

/**
 * Native-classified things that don't compile in our wasi-sdk
 * base because they assume POSIX threading or a network stack
 * we don't provide. Most are RTP/RTSP/SAP streaming-related;
 * one is the `fifo` muxer (which uses pthreads to flush an
 * upstream muxer asynchronously).
 *
 * We could try to plumb wasi-thread in eventually, but for
 * now the policy is simple: skip.
 */
const KNOWN_BROKEN = new Set([
	"fifo_muxer",
	"fifo_test_muxer",
	"rtsp_demuxer",
	"rtsp_muxer",
	"sap_demuxer",
	"sap_muxer",
	"sdp_demuxer",
	"rtp_muxer",
	"rtp_mpegts_muxer",
	// HLS / DASH / SmoothStreaming muxers all create files /
	// directories via `mkdir` / `stat` / `unlink` calls that
	// our WASI sandbox doesn't currently allow.
	"hls_demuxer",
	"hls_muxer",
	"hds_muxer",
	"dash_muxer",
	"webm_dash_manifest_muxer",
	"smoothstreaming_muxer",
	"segment_muxer",
	"stream_segment_muxer",
	"tee_muxer",
	// image2 family iterates a directory with `glob()`/`stat()`.
	"image2_demuxer",
	"image2pipe_demuxer",
	"image2_muxer",
	"image2_alias_pix_demuxer",
	"image2_brender_pix_demuxer",
	// Per-image pipe demuxers use `glob`/`stat` for filename
	// pattern expansion.
	"image_bmp_pipe_demuxer",
	"image_cri_pipe_demuxer",
	"image_dds_pipe_demuxer",
	"image_dpx_pipe_demuxer",
	"image_exr_pipe_demuxer",
	"image_gem_pipe_demuxer",
	"image_gif_pipe_demuxer",
	"image_j2k_pipe_demuxer",
	"image_jpeg_pipe_demuxer",
	"image_jpegls_pipe_demuxer",
	"image_jpegxl_pipe_demuxer",
	"image_pam_pipe_demuxer",
	"image_pbm_pipe_demuxer",
	"image_pcx_pipe_demuxer",
	"image_pgm_pipe_demuxer",
	"image_pgmyuv_pipe_demuxer",
	"image_pgx_pipe_demuxer",
	"image_photocd_pipe_demuxer",
	"image_pictor_pipe_demuxer",
	"image_png_pipe_demuxer",
	"image_ppm_pipe_demuxer",
	"image_psd_pipe_demuxer",
	"image_qdraw_pipe_demuxer",
	"image_sgi_pipe_demuxer",
	"image_sunrast_pipe_demuxer",
	"image_svg_pipe_demuxer",
	"image_tiff_pipe_demuxer",
	"image_webp_pipe_demuxer",
	"image_xbm_pipe_demuxer",
	"image_xpm_pipe_demuxer",
	"image_xwd_pipe_demuxer",
])

/** Slug convention: lowercase + hyphens (groupFor already lowercase + underscores). */
function slugify(groupName: string): string {
	return groupName.replaceAll("_", "-")
}

/**
 * Pretty one-line description for an extension that bundles
 * multiple entries.
 *
 * - Single entry: `"AAC decoder."`
 * - Two entries: `"AAC decoder + AAC encoder."`
 * - Many entries: `"AAC decoder, encoder, demuxer, muxer."`
 * - Mixed kinds across many stems: `"PCM family (35 decoders, 31 encoders, 21 demuxers, 21 muxers)."`
 */
function describeGroup(slug: string, entries: EnumeratedEntry[]): string {
	if (entries.length === 1) {
		const e = entries[0]!
		return `${e.stem.replaceAll("_", " ").toUpperCase()} ${e.kind}.`
	}

	// Group entries by kind for tidy reporting.
	const byKind: Partial<Record<EnumeratedEntry["kind"], EnumeratedEntry[]>> = {}
	for (const e of entries) {
		;(byKind[e.kind] ??= []).push(e)
	}
	const kindOrder: EnumeratedEntry["kind"][] = [
		"decoder",
		"encoder",
		"demuxer",
		"muxer",
	]

	// All entries share a single stem (e.g. flac decoder/encoder/demuxer/muxer).
	const uniqueStems = new Set(entries.map((e) => e.stem))
	if (uniqueStems.size === 1) {
		const stem = entries[0]!.stem.replaceAll("_", " ").toUpperCase()
		const kinds = kindOrder.filter((k) => byKind[k]?.length)
		return `${stem} ${kinds.join(", ")}.`
	}

	// Family group with many stems (PCM, ADPCM, image, ...).
	const counts = kindOrder
		.filter((k) => byKind[k]?.length)
		.map((k) => {
			const n = byKind[k]!.length
			return `${n} ${k}${n === 1 ? "" : "s"}`
		})
		.join(", ")
	return `${slug.toUpperCase()} family (${counts}).`
}

function cTypeFor(kind: EnumeratedEntry["kind"]): string {
	return kind === "decoder" || kind === "encoder"
		? "FFCodec"
		: kind === "demuxer"
			? "AVInputFormat"
			: "AVOutputFormat"
}

function main() {
	const here = dirname(fileURLToPath(import.meta.url))
	const pkgRoot = pathResolve(here, "..", "..")
	const ffmpegRoot = pathResolve(pkgRoot, "build", "ffmpeg")

	const configure = parseConfigureFile(`${ffmpegRoot}/configure`)
	const externals = parseExternalLibsFile(`${ffmpegRoot}/configure`)
	const codec = parseMakefileFile(`${ffmpegRoot}/libavcodec/Makefile`)
	const fmt = parseMakefileFile(`${ffmpegRoot}/libavformat/Makefile`)

	const enumerated = enumerateFromFiles({
		ffmpegRoot,
		configure,
		makefiles: [
			{ library: "libavcodec", data: codec },
			{ library: "libavformat", data: fmt },
		],
		gplLibs: externals.gpl,
		nonfreeLibs: externals.nonfree,
		version3Libs: externals.version3,
		allExternalLibs: externals.all,
	})

	const resolveOpts = {
		configure,
		makefiles: [
			{ library: "libavcodec", data: codec },
			{ library: "libavformat", data: fmt },
		],
		baseHelpers: BASE_HELPERS,
	}

	const extRoot = pathResolve(pkgRoot, "src", "extensions")
	mkdirSync(extRoot, { recursive: true })

	// Step 1: filter + group entries by their groupFor() slug.
	const groups = new Map<string, EnumeratedEntry[]>()
	const skipped: Record<string, number> = {}
	for (const e of enumerated) {
		const reason = inclusionFilter(e)
		if (reason) {
			skipped[reason] = (skipped[reason] ?? 0) + 1
			continue
		}
		const slug = slugify(groupFor(e.stem))
		if (!groups.has(slug)) groups.set(slug, [])
		groups.get(slug)!.push(e)
	}

	// Step 2: emit one extension per group, unioning all the
	// resolved objs / configFlags from its member entries.
	const manifestGroups: Array<{
		slug: string
		description: string
		entries: Array<{
			thing: string
			stem: string
			kind: string
			symbol: string
		}>
	}> = []
	let generated = 0
	for (const [slug, members] of [...groups.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		// Stable ordering of members for deterministic output.
		members.sort((a, b) =>
			a.thing === b.thing
				? 0
				: a.thing < b.thing
					? -1
					: 1,
		)

		// Union the resolver output across members. Most members
		// share huge overlaps (e.g. all 32 PCM variants compile
		// pcm.o); deduping is critical to avoid re-emitting the
		// same `.o` rule.
		const objSet = new Set<string>()
		const objsUnion: Array<{ library: string; obj: string }> = []
		const flagSet = new Set<string>()
		const baseSet = new Set<string>()
		for (const e of members) {
			const r = resolve(e.thing, resolveOpts)
			for (const o of r.objs) {
				const key = `${o.library}/${o.obj}`
				if (objSet.has(key)) continue
				objSet.add(key)
				objsUnion.push(o)
			}
			for (const f of r.configFlags) flagSet.add(f)
			for (const b of r.resolvedFromBase) baseSet.add(b)
			// The member's own CONFIG_X must always be on, even
			// if the resolver missed it from select-cascade.
			flagSet.add(e.configFlag)
		}

		const extensionEntries: ExtensionEntry[] = members.map((e) => ({
			thing: e.thing,
			kind: e.kind,
			symbol: e.symbol,
			cType: cTypeFor(e.kind),
		}))

		const files = emitFiles({
			slug,
			description: describeGroup(slug, members),
			entries: extensionEntries,
			resolved: {
				objs: objsUnion,
				configFlags: [...flagSet].sort(),
				resolvedFromBase: [...baseSet].sort(),
			},
			baseRel: "../../..",
		})

		const dir = pathResolve(extRoot, slug)
		mkdirSync(dir, { recursive: true })
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(pathResolve(dir, name), content)
		}
		manifestGroups.push({
			slug,
			description: describeGroup(slug, members),
			entries: members.map((e) => ({
				thing: e.thing,
				stem: e.stem,
				kind: e.kind,
				symbol: e.symbol,
			})),
		})
		generated++
	}

	// Emit the package-wide manifest (`dist/extensions-manifest.json`).
	const distDir = pathResolve(pkgRoot, "dist")
	mkdirSync(distDir, { recursive: true })
	writeFileSync(
		pathResolve(distDir, "extensions-manifest.json"),
		JSON.stringify(manifestGroups, null, 2) + "\n",
	)

	console.log(`Generated ${generated} extension(s) in ${extRoot}`)
	const totalThings = [...groups.values()].reduce(
		(sum, m) => sum + m.length,
		0,
	)
	console.log(
		`  bundling ${totalThings} thing(s); avg ${(totalThings / generated).toFixed(1)} per extension`,
	)
	console.log()
	console.log("Skipped:")
	for (const [reason, n] of Object.entries(skipped).sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(`  ${n}\t${reason}`)
	}
}

main()
