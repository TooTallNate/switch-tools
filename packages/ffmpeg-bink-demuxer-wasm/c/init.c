/**
 * Extension init for `@tootallnate/ffmpeg-bink-demuxer-wasm`.
 *
 * Exposes the FFmpeg Bink demuxer (`libavformat/bink.c`, patched for
 * Switch's KB2n revision) as a dynamic-extension entry point.
 *
 * This package is the SHARED demuxer for all Bink container variants:
 *
 *   - Bink 1 video (KB2 'b'..'k'): pair with `ffmpeg-bink-video-wasm`.
 *   - Bink 2 video (KB2 'f'..'n'): pair with `ffmpeg-bink2-video-wasm`.
 *   - Bink audio (RDFT/DCT): pair with `ffmpeg-bink-audio-wasm`.
 *
 * Any combination of those can be loaded simultaneously — the
 * demuxer produces packets with `codec_id` already set; the base
 * wrapper's `find_codec()` then matches each stream to whichever
 * codec extension is loaded.
 */

#include <stddef.h>

struct AVInputFormat;
extern const struct AVInputFormat ff_bink_demuxer;

__attribute__((visibility("default")))
const struct AVInputFormat *ffmpeg_ext_bink_demuxer_demuxer(void)
{
	return &ff_bink_demuxer;
}
