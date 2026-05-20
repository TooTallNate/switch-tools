/**
 * Force-export of FFmpeg symbols needed by dynamic-load extensions.
 *
 * The base WASM is compiled with `--gc-sections` for size, which
 * drops any libav function that isn't referenced from the wrapper.
 * Extensions can't import symbols that don't exist, so this file
 * keeps the canonical set of libav APIs alive by holding a
 * function-pointer table that the linker treats as a live root.
 *
 * The accompanying `-Wl,--export=<symbol>` flags in the Makefile
 * make these symbols visible to extension imports via the
 * dynamic-linking ABI (`env.av_log`, `env.av_frame_alloc`, ...).
 *
 * Adding a symbol here costs ~zero binary size beyond the
 * function's own code (which we'd need anyway if any decoder
 * uses it). Curate liberally — false positives just keep dead
 * code around; false negatives mean an extension fails to load
 * with an "unresolved env.X" error at instantiation.
 */

#include <stdint.h>

#include "libavcodec/avcodec.h"
#include "libavcodec/blockdsp.h"
#include "libavcodec/hpeldsp.h"
#include "libavcodec/get_bits.h"
#include "libavformat/avformat.h"
#include "libavutil/avutil.h"
#include "libavutil/avstring.h"
#include "libavutil/buffer.h"
#include "libavutil/dict.h"
#include "libavutil/imgutils.h"
#include "libavutil/intreadwrite.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"

/*
 * Internal FFmpeg helpers — declared in private headers extensions
 * have `#include`d. We forward-declare them here so we can pin
 * them into the live set without dragging the whole private
 * header into this file.
 */
extern int  ff_get_buffer(AVCodecContext *s, AVFrame *frame, int flags);
extern int  ff_reget_buffer(AVCodecContext *s, AVFrame *frame, int flags);
extern int  ff_set_dimensions(AVCodecContext *s, int width, int height);
extern int  ff_get_extradata(void *s, AVCodecParameters *par,
                             AVIOContext *pb, int size);

/* VLC tables — bink2 uses these directly. */
struct VLC;
extern int ff_init_vlc_sparse(struct VLC *vlc, int nb_bits, int nb_codes,
                              const void *bits, int bits_wrap, int bits_size,
                              const void *codes, int codes_wrap, int codes_size,
                              const void *symbols, int symbols_wrap, int symbols_size,
                              int flags);
extern void ff_free_vlc(struct VLC *vlc);

/* Audio DSP — binkaudio uses RDFT + DCT transforms. */
struct RDFTContext;
struct DCTContext;
extern int  ff_rdft_init(struct RDFTContext *s, int nbits, int trans);
extern void ff_rdft_end(struct RDFTContext *s);
extern int  ff_dct_init(struct DCTContext *s, int nbits, int type);
extern void ff_dct_end(struct DCTContext *s);

/* WMA frequency tables — shared between wmaprodec / binkaudio. */
extern const uint16_t ff_wma_critical_freqs[25];

/* Channel layout helpers — audio codecs use av_channel_layout_copy
 * and similar. */
struct AVChannelLayout;
extern int av_channel_layout_copy(struct AVChannelLayout *dst,
                                  const struct AVChannelLayout *src);
extern void av_channel_layout_uninit(struct AVChannelLayout *channel_layout);
extern void av_channel_layout_default(struct AVChannelLayout *ch_layout,
                                       int nb_channels);
/* av_log2 is already declared in <libavutil/common.h> — taking its
 * address is enough to pin it. */

/* Decoder internal API — modern codecs that use the
 * receive_frame callback pattern call this to pull the next
 * packet on demand. */
extern int ff_decode_get_packet(AVCodecContext *avctx, AVPacket *pkt);

/* Demuxer internals used by the bink demuxer (and most other
 * demuxers). Their declarations live in `libavformat/internal.h`
 * which we don't include here. */
struct AVRational; /* tag, not real type */
extern void avpriv_set_pts_info(AVStream *st, int pts_wrap_bits,
                                unsigned int pts_num, unsigned int pts_den);
extern int ff_alloc_extradata(AVCodecParameters *par, int size);

/*
 * Touch each exported symbol. The compiler can't fold these away
 * because they're written to a `volatile` global table. The
 * linker then keeps the whole transitive closure of these
 * functions in the binary, and `--export=<symbol>` makes them
 * importable by extensions.
 */
void * volatile ffmpeg_keepalive_table[] = {
	/* --- libavutil --- */
	(void *)&av_log,
	(void *)&av_log_set_level,
	(void *)&av_log_get_level,
	(void *)&av_log_default_callback,
	(void *)&av_malloc,
	(void *)&av_mallocz,
	(void *)&av_malloc_array,
	(void *)&av_calloc,
	(void *)&av_realloc,
	(void *)&av_realloc_f,
	(void *)&av_free,
	(void *)&av_freep,
	(void *)&av_strdup,
	(void *)&av_memdup,
	(void *)&av_image_check_size,
	(void *)&av_image_get_buffer_size,
	(void *)&av_image_fill_pointers,
	(void *)&av_image_fill_linesizes,
	(void *)&av_image_alloc,
	(void *)&av_pix_fmt_desc_get,
	(void *)&av_get_pix_fmt_name,
	(void *)&av_buffer_alloc,
	(void *)&av_buffer_create,
	(void *)&av_buffer_ref,
	(void *)&av_buffer_unref,
	(void *)&av_dict_set,
	(void *)&av_dict_get,
	(void *)&av_dict_free,
	(void *)&av_opt_set,
	(void *)&av_opt_set_int,
	(void *)&av_opt_get,
	(void *)&av_opt_find,
	(void *)&av_strstart,
	(void *)&av_strlcpy,
	(void *)&av_strlcat,
	(void *)&av_strlcatf,
	(void *)&av_strcasecmp,
	(void *)&av_strncasecmp,
	(void *)&av_strerror,

	/* --- libavcodec --- */
	(void *)&avcodec_alloc_context3,
	(void *)&avcodec_free_context,
	(void *)&avcodec_open2,
	(void *)&avcodec_close,
	(void *)&avcodec_send_packet,
	(void *)&avcodec_receive_frame,
	(void *)&avcodec_send_frame,
	(void *)&avcodec_receive_packet,
	(void *)&avcodec_parameters_to_context,
	(void *)&avcodec_parameters_from_context,
	(void *)&avcodec_parameters_alloc,
	(void *)&avcodec_parameters_free,
	(void *)&avcodec_parameters_copy,
	(void *)&avcodec_flush_buffers,
	(void *)&avcodec_get_name,
	(void *)&av_packet_alloc,
	(void *)&av_packet_free,
	(void *)&av_packet_unref,
	(void *)&av_packet_ref,
	(void *)&av_packet_clone,
	(void *)&av_packet_rescale_ts,
	(void *)&av_packet_get_side_data,
	(void *)&av_packet_add_side_data,
	(void *)&av_packet_new_side_data,
	(void *)&av_packet_make_writable,
	(void *)&av_frame_alloc,
	(void *)&av_frame_free,
	(void *)&av_frame_ref,
	(void *)&av_frame_unref,
	(void *)&av_frame_clone,
	(void *)&av_frame_get_buffer,
	(void *)&av_frame_make_writable,
	(void *)&av_grow_packet,
	(void *)&av_new_packet,
	(void *)&av_shrink_packet,

	/* libavcodec internals that extensions reach for. Their
	 * upstream visibility is `default` (no `av_visibility_hidden`),
	 * so they're exportable. */
	(void *)&ff_get_buffer,
	(void *)&ff_reget_buffer,
	(void *)&ff_set_dimensions,
	(void *)&ff_get_extradata,
	(void *)&ff_init_vlc_sparse,
	(void *)&ff_free_vlc,
	(void *)&ff_blockdsp_init,
	(void *)&ff_hpeldsp_init,
	(void *)&ff_rdft_init,
	(void *)&ff_rdft_end,
	(void *)&ff_dct_init,
	(void *)&ff_dct_end,
	(void *)&ff_wma_critical_freqs,
	(void *)&av_channel_layout_copy,
	(void *)&av_channel_layout_uninit,
	(void *)&av_channel_layout_default,
	(void *)&av_log2,
	(void *)&ff_decode_get_packet,

	/* --- libavformat --- */
	(void *)&avformat_alloc_context,
	(void *)&avformat_free_context,
	(void *)&avformat_open_input,
	(void *)&avformat_close_input,
	(void *)&avformat_find_stream_info,
	(void *)&avformat_new_stream,
	(void *)&av_read_frame,
	(void *)&av_seek_frame,
	(void *)&avio_alloc_context,
	(void *)&avio_context_free,
	(void *)&avio_read,
	(void *)&avio_skip,
	(void *)&avio_seek,
	(void *)&avio_tell,
	(void *)&avio_size,
	(void *)&avio_feof,
	(void *)&avio_r8,
	(void *)&avio_rl16,
	(void *)&avio_rl24,
	(void *)&avio_rl32,
	(void *)&avio_rl64,
	(void *)&avio_rb16,
	(void *)&avio_rb24,
	(void *)&avio_rb32,
	(void *)&avio_rb64,
	(void *)&av_add_index_entry,
	(void *)&av_get_packet,
	(void *)&av_index_search_timestamp,
	(void *)&avpriv_set_pts_info,
	(void *)&ff_alloc_extradata,

	(void *)0,
};
