/*
 * Synthetic AVCodecID values used by `@tootallnate/ffmpeg-wasm`
 * extensions to coordinate with each other.
 *
 * Background: the base WASM is built with zero codecs / demuxers
 * enabled, but `libavcodec/codec_id.h` is still present in the
 * source tree with its full enum. The wrapper's per-stream codec
 * lookup (in `ffmpeg_open` → `find_codec(codec_id, type)`) matches
 * an extension-provided codec to the demuxer-produced `codec_id`
 * field.
 *
 * **Critical constraint**: the value used must NOT collide with an
 * unrelated entry in `codec_desc.c`. Even though we never call
 * `avcodec_find_decoder(id)`, libavformat's `compute_pkt_fields()`
 * calls `ff_is_intra_only(id)` which does
 * `avcodec_descriptor_get(id)`. If that finds a different codec
 * descriptor (e.g. SGI at 0x65 when we wanted Bink 2), it can mark
 * P-frame packets as intra-only and break decoding. (We tripped this
 * with bink2 originally.)
 *
 * The strategy for our extensions is:
 *
 *   - Use existing enum IDs where possible (e.g. BINKVIDEO,
 *     BINKAUDIO_*). Those have correct descriptors already
 *     (BINKVIDEO is not intra-only, BINKAUDIO_* are intra-only as
 *     expected for audio).
 *
 *   - For codecs that don't exist in the upstream enum (e.g. Bink 2),
 *     pick a value well above the highest existing video AVCodecID
 *     (~0x103) but below `AV_CODEC_ID_FIRST_AUDIO` (0x10000).
 *
 * Multiple extensions that need to coordinate (e.g. the bink
 * demuxer + bink2 video decoder) include this header so they
 * agree on the codec_id values.
 */

#ifndef TTN_FFMPEG_EXT_CODEC_IDS_H
#define TTN_FFMPEG_EXT_CODEC_IDS_H

#include "libavcodec/codec_id.h"

/* Bink video 2, versions 'f'..'n' (KB2f...KB2n). Not in upstream
 * enum — invented for our build. Value verified not to collide
 * with any descriptor in `codec_desc.c`. */
#define AV_CODEC_ID_BINKVIDEO2 0xFFFD

#endif /* TTN_FFMPEG_EXT_CODEC_IDS_H */
