/**
 * Map each FFmpeg `<stem>_<kind>` thing to an extension "group
 * slug" — the directory name + `.so` filename + npm subpath of
 * the generated extension.
 *
 * Grouping policy:
 *
 *   1. Per-format short name = group slug. A WAV demuxer, WAV
 *      muxer, and AC-3 decoder/encoder/demuxer/muxer all live
 *      in extensions named after their FFmpeg short name
 *      (`wav` / `ac3`). This matches `ffmpeg -codecs` /
 *      `ffmpeg -formats` output.
 *
 *   2. Family collapses. A handful of large families share so
 *      much source that splitting them would just duplicate
 *      object files:
 *        - `pcm_*`     → `pcm`     (32 PCM variants share pcm.c)
 *        - `adpcm_*`   → `adpcm`   (51 ADPCM variants share adpcm.c)
 *        - `*_dpcm`    → `dpcm`
 *        - WMA / WMV / ASF / XMA family → `wmv`
 *        - JPEG family (mjpeg/jpegxl/ljpeg/...) → `jpeg`
 *        - G.7xx telephony → `g7xx`
 *        - Text subtitle formats → `subtitle`
 *        - Obscure raw image formats (PAM/PBM/PCX/...) → `image`
 *        - Tracker module music → `tracker`
 *
 *   3. Everything else stands alone with `slug = stem`.
 *
 * The generator emits one extension per UNIQUE group slug,
 * bundling every entry that maps to that slug into a single
 * `.so`.
 */

/**
 * Hand-picked one-off stems that map to a group slug. Mostly
 * used for variant names that don't match a prefix rule.
 */
const FAMILY_OVERRIDES: Record<string, string> = {
	// G.7xx telephony codecs.
	g722: "g7xx",
	g723_1: "g7xx",
	g726: "g7xx",
	g726le: "g7xx",
	g729: "g7xx",

	// Vorbis-comment carrier groupings.
	vc1test: "wmv",
	xma1: "wmv",
	xma2: "wmv",
	xwma: "wmv",
}

/**
 * Prefix/regex → group slug. Tried in order; first match wins.
 */
const FAMILY_PREFIXES: Array<[RegExp, string]> = [
	// PCM family — pcm_s16le, pcm_s24be, pcm_f32le, pcm_dvd,
	// pcm_bluray, pcm_alaw, pcm_mulaw, ...
	[/^pcm_/, "pcm"],
	// ADPCM family.
	[/^adpcm_/, "adpcm"],
	// DPCM family (sol_dpcm, gremlin_dpcm, roq_dpcm, derf_dpcm, ...).
	[/^([a-z0-9]+_)?dpcm$/, "dpcm"],
	// WMV / WMA / ASF / VC-1 — Microsoft Media family.
	[/^wma/, "wmv"],
	[/^wmv/, "wmv"],
	[/^asf/, "wmv"],
	[/^vc1/, "wmv"],
	// JPEG family (mjpeg, mjpegb, jpegls, jpegxl, ljpeg, ...).
	[/^mjpeg/, "jpeg"],
	[/^jpeg/, "jpeg"],
	[/^ljpeg/, "jpeg"],
]

/**
 * Text subtitle codec / format stems. They all decode to the
 * same internal text-subtitle pipeline; bundling avoids 50+
 * 1-member extensions.
 */
const SUBTITLE_STEMS = new Set([
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
	"sup",
	"pgssub",
	"dvbsub",
	"dvdsub",
	"xsub",
	"hdmv_pgs_subtitle",
	"hdmv_text_subtitle",
	"eia_608",
])

/**
 * Obscure raw / uncompressed image formats. The popular ones
 * (PNG, JPEG, GIF, BMP, TIFF) stay standalone since users
 * search for them by name.
 */
const IMAGE_STEMS = new Set([
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
	"cri",
	"gem",
])

/**
 * Tracker / module music formats — niche by definition.
 */
const TRACKER_STEMS = new Set([
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

/**
 * Map a stem (the `ff_<stem>_<kind>` prefix) to its group slug.
 *
 * Examples:
 *   - "aac"           → "aac"
 *   - "pcm_s16le"     → "pcm"
 *   - "adpcm_4xm"     → "adpcm"
 *   - "wmv1"          → "wmv"
 *   - "srt"           → "subtitle"
 *   - "pam"           → "image"
 *   - "vp9"           → "vp9"
 */
export function groupFor(stem: string): string {
	if (FAMILY_OVERRIDES[stem]) return FAMILY_OVERRIDES[stem]
	for (const [re, group] of FAMILY_PREFIXES) {
		if (re.test(stem)) return group
	}
	if (SUBTITLE_STEMS.has(stem)) return "subtitle"
	if (IMAGE_STEMS.has(stem)) return "image"
	if (TRACKER_STEMS.has(stem)) return "tracker"
	return stem
}
