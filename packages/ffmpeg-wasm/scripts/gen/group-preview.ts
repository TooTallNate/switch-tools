/**
 * Preview the proposed grouping policy: bundle by FFmpeg short
 * name AND collapse families (PCM, ADPCM, G.7xx, etc.) that
 * share source files.
 *
 * Prints:
 *   - total grouped extensions
 *   - groups with multiple entries (the interesting unifications)
 *   - largest groups
 */
import { enumerateFromFiles } from "./enumerate.ts"
import { parseConfigureFile } from "./parse-configure.ts"
import { parseExternalLibsFile } from "./parse-external-libs.ts"
import { parseMakefileFile } from "./parse-makefile.ts"

const ROOT = new URL("../../build/ffmpeg/", import.meta.url).pathname
const externals = parseExternalLibsFile(ROOT + "configure")

const entries = enumerateFromFiles({
	ffmpegRoot: ROOT.replace(/\/$/, ""),
	configure: parseConfigureFile(ROOT + "configure"),
	makefiles: [
		{ library: "libavcodec", data: parseMakefileFile(ROOT + "libavcodec/Makefile") },
		{ library: "libavformat", data: parseMakefileFile(ROOT + "libavformat/Makefile") },
	],
	gplLibs: externals.gpl,
	nonfreeLibs: externals.nonfree,
	version3Libs: externals.version3,
	allExternalLibs: externals.all,
})

const FAMILY_OVERRIDES: Record<string, string> = {
	// G.7xx telephony codecs.
	g722: "g7xx",
	g723_1: "g7xx",
	g726: "g7xx",
	g726le: "g7xx",
	g729: "g7xx",

	// WMV / WMA / ASF — Microsoft Media family.
	wmv1: "wmv",
	wmv2: "wmv",
	wmv3: "wmv",
	wmv3image: "wmv",
	wmavoice: "wmv",
	wmapro: "wmv",
	wmalossless: "wmv",
	wmv1_image: "wmv",
	wma: "wmv",
	wma_v1: "wmv",
	wma_v2: "wmv",
	wma_lossless: "wmv",
	wma_pro: "wmv",
	wma_voice: "wmv",
	asf: "wmv",
	asf_o: "wmv",
	asf_stream: "wmv",
	xma1: "wmv",
	xma2: "wmv",
	xwma: "wmv",
	vc1: "wmv",
	vc1_image: "wmv",
	vc1test: "wmv",
}

const FAMILY_PREFIXES: Array<[RegExp, string]> = [
	// PCM family.
	[/^pcm_/, "pcm"],
	// ADPCM family.
	[/^adpcm_/, "adpcm"],
	// DPCM family.
	[/^([a-z]+_)?dpcm$/, "dpcm"],
	// WMA / WMV / WMV image variants (prefix match).
	[/^wma/, "wmv"],
	[/^wmv/, "wmv"],
	[/^asf/, "wmv"],
	// JPEG family.
	[/^mjpeg/, "jpeg"],
	[/^jpeg/, "jpeg"],
	[/^ljpeg/, "jpeg"],
]

/**
 * Subtitle text formats — there are many obscure ones that all
 * decode/encode to AV_CODEC_ID_SUBRIP-style text. We bundle them
 * into one `subtitle` extension.
 */
const SUBTITLE_TEXT_STEMS = new Set([
	"srt",
	"subrip",
	"ass",
	"ssa",
	"webvtt",
	"microdvd",
	"mpl2",
	"pjs",
	"realtext",
	"sami",
	"stl",
	"text",
	"vplayer",
	"mov_text",
	"ttml",
	"jacosub",
	"aqtitle",
	"lrc",
	"subviewer",
	"subviewer1",
	"vtt",
	"scc",
	"mcc",
	"sup", // PGS bitmap subtitles — actually image; put with subtitle bitmap?
	"pgssub",
	"dvbsub",
	"dvdsub",
	"xsub",
	"hdmv_pgs_subtitle",
	"hdmv_text_subtitle",
	"eia_608",
	"text",
])

/**
 * Obscure raw-image formats. PNG / JPEG / GIF / BMP / TIFF stay
 * standalone since they're commonly-known.
 */
const RAW_IMAGE_STEMS = new Set([
	"pam",
	"pbm",
	"pcx",
	"pfm",
	"pgm",
	"pgmyuv",
	"phm",
	"pgx",
	"ppm",
	"psd",
	"sgi",
	"sunrast",
	"xbm",
	"xpm",
	"xwd",
	"bitpacked",
	"alias_pix",
	"brender_pix",
	"dpx",
	"exr",
	"vbn",
	"qoi",
	"qdraw",
	"photocd",
	"pictor",
	"smvjpeg",
])

/**
 * Tracker / module music formats — bundle since they're niche.
 */
const TRACKER_MUSIC_STEMS = new Set([
	"s3m",
	"xm",
	"it",
	"mod",
	"669",
	"ams",
	"dbm",
	"digi",
	"dmf",
	"dsm",
	"far",
	"ftm",
	"gdm",
	"imf",
	"j2b",
	"mdl",
	"med",
	"mt2",
	"mtm",
	"okt",
	"plm",
	"psm",
	"ptm",
	"sfx",
	"stm",
	"stp",
	"ult",
	"umx",
])

function groupFor(stem: string): string {
	if (FAMILY_OVERRIDES[stem]) return FAMILY_OVERRIDES[stem]
	for (const [re, group] of FAMILY_PREFIXES) {
		if (re.test(stem)) return group
	}
	if (SUBTITLE_TEXT_STEMS.has(stem)) return "subtitle"
	if (RAW_IMAGE_STEMS.has(stem)) return "image"
	if (TRACKER_MUSIC_STEMS.has(stem)) return "tracker"
	return stem
}

const native = entries.filter((e) => e.classification === "native")

const groups = new Map<string, Array<typeof native[number]>>()
for (const e of native) {
	const g = groupFor(e.stem)
	if (!groups.has(g)) groups.set(g, [])
	groups.get(g)!.push(e)
}

const allGroups = [...groups.entries()].sort(
	(a, b) => b[1].length - a[1].length,
)

console.log(`Native entries:    ${native.length}`)
console.log(`Grouped extensions: ${allGroups.length}`)
console.log(`Reduction:         ${(((native.length - allGroups.length) / native.length) * 100).toFixed(1)}%`)
console.log()
console.log(`Distribution:`)
const sizeBuckets = new Map<number, number>()
for (const [, members] of allGroups) {
	const n = members.length
	sizeBuckets.set(n, (sizeBuckets.get(n) ?? 0) + 1)
}
for (const [size, count] of [...sizeBuckets.entries()].sort((a, b) => a[0] - b[0])) {
	console.log(`  ${count} group(s) with ${size} member(s)`)
}
console.log()
console.log(`Top 20 largest groups:`)
for (const [name, members] of allGroups.slice(0, 20)) {
	const byKind: Record<string, string[]> = {}
	for (const m of members) {
		;(byKind[m.kind] ??= []).push(m.stem)
	}
	const summary = Object.entries(byKind)
		.map(([k, v]) => `${v.length} ${k}${v.length === 1 ? "" : "s"}`)
		.join(", ")
	console.log(`  ${name.padEnd(16)} ${members.length.toString().padStart(3)}  (${summary})`)
}
