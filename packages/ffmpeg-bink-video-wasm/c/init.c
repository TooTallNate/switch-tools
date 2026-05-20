/**
 * Extension init for `@tootallnate/ffmpeg-bink-video-wasm`.
 *
 * Exposes the FFmpeg Bink 1 video decoder (KB2 'b'..'k' — Bink
 * versions covering the original Bink Video codec used in many
 * Switch/PC/console games shipped pre-2017). Pairs with
 * `@tootallnate/ffmpeg-bink-demuxer-wasm` for the container and
 * optionally `@tootallnate/ffmpeg-bink-audio-wasm` for audio
 * tracks.
 *
 * Uses the upstream `AV_CODEC_ID_BINKVIDEO` enum value (0x87) — it
 * already exists in libavcodec/codec_id.h with a correct descriptor
 * in codec_desc.c (lossy, not intra-only), so no synthetic-id
 * collision risk like bink2 has.
 */

#include <stddef.h>

struct FFCodec;
extern const struct FFCodec ff_bink_decoder;

__attribute__((visibility("default")))
const struct FFCodec *ffmpeg_ext_bink_video_codec(void)
{
	return &ff_bink_decoder;
}
