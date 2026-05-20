/**
 * Extension init for `@tootallnate/ffmpeg-bink-audio-wasm`.
 *
 * Exposes BOTH binkaudio decoder variants (RDFT and DCT) — the
 * codec_id in each track decides which one the wrapper picks.
 * Bink containers can mix both variants across tracks, so we
 * ship both in this single extension.
 */

#include <stddef.h>

struct FFCodec;
extern const struct FFCodec ff_binkaudio_rdft_decoder;
extern const struct FFCodec ff_binkaudio_dct_decoder;

__attribute__((visibility("default")))
const struct FFCodec *ffmpeg_ext_bink_audio_codec_1(void)
{
	return &ff_binkaudio_rdft_decoder;
}

__attribute__((visibility("default")))
const struct FFCodec *ffmpeg_ext_bink_audio_codec_2(void)
{
	return &ff_binkaudio_dct_decoder;
}
