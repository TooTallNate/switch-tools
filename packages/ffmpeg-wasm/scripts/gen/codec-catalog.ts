/**
 * Catalog of FFmpeg native codecs / demuxers / muxers we know
 * how to generate extensions for, along with hand-curated
 * metadata that doesn't come from parsing alone.
 *
 * The "thing" name is lowercase and matches the FFmpeg
 * convention used in `configure` and the symbol name
 * (`ff_<thing>` → e.g. `ff_aac_decoder`).
 *
 * To regenerate everything once full enumeration is wired up,
 * walk `allcodecs.c` + `allformats.c` instead — for now we keep
 * a small explicit list to validate the generator end-to-end.
 */
import type { ExtensionEntry, ExtensionKind } from "./emit.ts"

/** Hand-curated list of extensions to generate. */
export interface CatalogEntry {
	/** Directory name + .so name (lowercase + dashes). */
	slug: string
	/** One-line human description for manifest + README. */
	description: string
	/** The things this extension registers. */
	entries: Array<{ thing: string; kind: ExtensionKind }>
}

/**
 * Hand-picked initial set for end-to-end validation. Covers
 * the categories that exercise the generator's edge cases:
 *
 *   - single-source decoder (HCA)
 *   - single-source PCM decoder (PCM_S16LE)
 *   - multi-source decoder with helper cascade (FLAC, AAC)
 *   - demuxer with libavformat helpers (WAV)
 *   - muxer with libavformat helpers (WAV)
 *   - muxer that pulls a libavcodec helper (ADTS)
 *
 * Once the loop is proven we'll auto-enumerate from upstream.
 */
export const SEED_CATALOG: CatalogEntry[] = [
	{
		slug: "pcm-s16le-decoder",
		description: "16-bit signed little-endian PCM audio decoder.",
		entries: [{ thing: "pcm_s16le_decoder", kind: "decoder" }],
	},
	{
		slug: "hca-decoder",
		description: "CRI HCA (CRI Sofdec2 audio) decoder.",
		entries: [{ thing: "hca_decoder", kind: "decoder" }],
	},
	{
		slug: "flac-decoder",
		description: "FLAC (Free Lossless Audio Codec) decoder.",
		entries: [{ thing: "flac_decoder", kind: "decoder" }],
	},
	{
		slug: "aac-decoder",
		description: "AAC (Advanced Audio Coding) decoder.",
		entries: [{ thing: "aac_decoder", kind: "decoder" }],
	},
	{
		slug: "wav-demuxer",
		description: "WAV / RIFF audio container demuxer.",
		entries: [{ thing: "wav_demuxer", kind: "demuxer" }],
	},
	{
		slug: "wav-muxer",
		description: "WAV / RIFF audio container muxer.",
		entries: [{ thing: "wav_muxer", kind: "muxer" }],
	},
	{
		slug: "adts-muxer",
		description: "ADTS (Audio Data Transport Stream) AAC muxer.",
		entries: [{ thing: "adts_muxer", kind: "muxer" }],
	},
	{
		slug: "flac-demuxer",
		description: "FLAC (Free Lossless Audio Codec) demuxer.",
		entries: [{ thing: "flac_demuxer", kind: "demuxer" }],
	},
]

/**
 * Map an extension kind to the C type name used for its
 * upstream symbol. Codecs (decoders/encoders) use the internal
 * `FFCodec` wrapper struct; demuxers and muxers use the public
 * `AVInputFormat` / `AVOutputFormat`.
 *
 * The `&ff_<thing>` address is valid as both `FFCodec *` and
 * `AVCodec *` because `FFCodec.p` is the first field — the
 * registration ABI in `ffmpeg_register_codec` takes
 * `AVCodec *` directly.
 */
export function cTypeFor(kind: ExtensionKind): string {
	switch (kind) {
		case "decoder":
		case "encoder":
			return "FFCodec"
		case "demuxer":
			return "AVInputFormat"
		case "muxer":
			return "AVOutputFormat"
	}
}

/** Build the upstream symbol name for a thing. */
export function symbolFor(thing: string): string {
	return `ff_${thing}`
}

/** Turn a catalog entry into the emitter's `ExtensionEntry` shape. */
export function catalogToExtensionEntries(
	cat: CatalogEntry,
): ExtensionEntry[] {
	return cat.entries.map((e) => ({
		thing: e.thing,
		kind: e.kind,
		symbol: symbolFor(e.thing),
		cType: cTypeFor(e.kind),
	}))
}
