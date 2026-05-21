/**
 * Quick smoke check for the parsers + resolver. Run with:
 *
 *   node --experimental-strip-types scripts/gen/smoke.ts
 *
 * (Or `bun scripts/gen/smoke.ts`.) Prints what the resolver sees
 * for a handful of well-known codecs so we can eyeball it.
 */
import { parseConfigureFile } from "./parse-configure.ts"
import { parseMakefileFile } from "./parse-makefile.ts"
import { resolve } from "./resolve.ts"

const ROOT = new URL("../../build/ffmpeg/", import.meta.url).pathname

const configure = parseConfigureFile(ROOT + "configure")
const codec = parseMakefileFile(ROOT + "libavcodec/Makefile")
const fmt = parseMakefileFile(ROOT + "libavformat/Makefile")

console.log("configure: _select entries:", configure.select.size)
console.log("configure: _deps entries:", configure.deps.size)
console.log("libavcodec base OBJS:", codec.baseObjs.length)
console.log("libavcodec conditional rules:", codec.conditionalObjs.size)
console.log("libavformat base OBJS:", fmt.baseObjs.length)
console.log("libavformat conditional rules:", fmt.conditionalObjs.size)
console.log()

// Helpers already compiled into the base WASM (mirror of
// scripts/enable-helpers.sh's HELPERS array).
const baseHelpers = new Set([
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

const opts = {
	configure,
	makefiles: [
		{ library: "libavcodec", data: codec },
		{ library: "libavformat", data: fmt },
	],
	baseHelpers,
}

const things = [
	"aac_decoder",
	"flac_decoder",
	"hca_decoder",
	"binkaudio_rdft_decoder",
	"binkaudio_dct_decoder",
	"vp9_decoder",
	"hevc_decoder",
	"mp3_decoder",
	"pcm_s16le_decoder",
	"wav_demuxer",
	"wav_muxer",
	"adts_muxer",
	"flac_demuxer",
	"mp3_demuxer",
]

for (const t of things) {
	const r = resolve(t, opts)
	console.log(`${t}`)
	console.log(
		`  objs (${r.objs.length}):`,
		r.objs.map((e) => `${e.library}/${e.obj}`).join(" "),
	)
	console.log(`  configFlags:`, r.configFlags.join(" "))
	console.log(`  resolvedFromBase:`, r.resolvedFromBase.join(" "))
	console.log()
}
