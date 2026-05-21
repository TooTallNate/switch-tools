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

import { emitFiles } from "./emit.ts"
import { enumerateFromFiles, type EnumeratedEntry } from "./enumerate.ts"
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

/** Slug convention: lowercase + hyphens. */
function slugify(thing: string): string {
	return thing.replaceAll("_", "-")
}

/** Friendly one-liner for the manifest / Makefile header. */
function describe(e: EnumeratedEntry): string {
	const kindLabel = ({
		decoder: "decoder",
		encoder: "encoder",
		demuxer: "demuxer",
		muxer: "muxer",
	} as const)[e.kind]
	const stem = e.stem.replaceAll("_", " ").toUpperCase()
	return `${stem} ${kindLabel}.`
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

	const manifestEntries: Array<{
		slug: string
		kind: string
		thing: string
		stem: string
		symbol: string
		classification: string
		description: string
	}> = []
	const skipped: Record<string, number> = {}

	let generated = 0
	for (const e of enumerated) {
		const skip = inclusionFilter(e)
		if (skip) {
			skipped[skip] = (skipped[skip] ?? 0) + 1
			continue
		}

		const slug = slugify(e.thing)
		const r = resolve(e.thing, resolveOpts)
		// The own CONFIG flag must always be in the closure even
		// if the resolver missed it (happens when the entry's own
		// `_select` cascade doesn't bring it back in).
		if (!r.configFlags.includes(e.configFlag)) {
			r.configFlags.push(e.configFlag)
		}

		const files = emitFiles({
			slug,
			description: describe(e),
			entries: [
				{
					thing: e.thing,
					kind: e.kind,
					symbol: e.symbol,
					cType: cTypeFor(e.kind),
				},
			],
			resolved: r,
			baseRel: "../../..",
		})

		const dir = pathResolve(extRoot, slug)
		mkdirSync(dir, { recursive: true })
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(pathResolve(dir, name), content)
		}
		manifestEntries.push({
			slug,
			kind: e.kind,
			thing: e.thing,
			stem: e.stem,
			symbol: e.symbol,
			classification: e.classification,
			description: describe(e),
		})
		generated++
	}

	// Emit the package-wide manifest (`dist/extensions-manifest.json`).
	const distDir = pathResolve(pkgRoot, "dist")
	mkdirSync(distDir, { recursive: true })
	writeFileSync(
		pathResolve(distDir, "extensions-manifest.json"),
		JSON.stringify(
			manifestEntries.sort((a, b) =>
				a.slug.localeCompare(b.slug),
			),
			null,
			2,
		) + "\n",
	)

	console.log(`Generated ${generated} extension(s) in ${extRoot}`)
	console.log()
	console.log("Skipped:")
	for (const [reason, n] of Object.entries(skipped).sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(`  ${n}\t${reason}`)
	}
}

main()
