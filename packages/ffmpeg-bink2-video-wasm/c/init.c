/**
 * Extension init for `@tootallnate/ffmpeg-bink2-video-wasm`.
 *
 * Exposes Paul B Mahol's Bink 2 video decoder (KB2f...KB2n) as a
 * dynamic-extension entry point. Pairs with
 * `@tootallnate/ffmpeg-bink-demuxer-wasm` for the container, and
 * optionally `@tootallnate/ffmpeg-bink-audio-wasm` for audio
 * tracks.
 *
 * The codec uses a synthetic `AV_CODEC_ID_BINKVIDEO2 = 0xFFFD`
 * defined in `ext_codec_ids.h` (shared with the bink demuxer).
 */

#include <stddef.h>

struct FFCodec;
extern const struct FFCodec ff_bink2_decoder;

__attribute__((visibility("default")))
const struct FFCodec *ffmpeg_ext_bink2_video_codec(void)
{
	return &ff_bink2_decoder;
}
