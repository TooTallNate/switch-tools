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
#include "libavutil/base64.h"
#include "libavutil/buffer.h"
#include "libavutil/channel_layout.h"
#include "libavutil/crc.h"
#include "libavutil/dict.h"
#include "libavutil/float_dsp.h"
#include "libavutil/imgutils.h"
#include "libavutil/intreadwrite.h"
#include "libavutil/log.h"
#include "libavutil/mathematics.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "libavutil/samplefmt.h"
#include "libavutil/time.h"
#include "libavutil/tx.h"

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

/* libavcodec FFT / MDCT / sinewin internals — pre-`av_tx` code
 * path. `ff_fft_init` / `ff_mdct_init` live in libavcodec/fft.c
 * (template-generated) and live alongside `av_tx_init` until
 * fully removed. AAC + many other audio codecs still call
 * `ff_mdct_init` directly. */
struct FFTContext;
extern int  ff_fft_init(struct FFTContext *s, int nbits, int inverse);
extern void ff_fft_end(struct FFTContext *s);
extern int  ff_mdct_init(struct FFTContext *s, int nbits, int inverse,
                          double scale);
extern void ff_mdct_end(struct FFTContext *s);
extern void ff_sine_window_init(float *window, int n);
extern void ff_init_ff_sine_windows(int index);

/* AAC float helper: initialises shared float-precision tables. */
extern void ff_aac_float_common_init(void);

/* Frame-threaded decoder buffer accessor — newer codecs route
 * `ff_get_buffer` through this even in single-thread builds. */
extern int  ff_thread_get_buffer(AVCodecContext *avctx, AVFrame *f, int flags);

/* Diagnostics — defined in libavutil but exported under `avpriv_`
 * for libavcodec to call across the LGPL boundary. */
extern void avpriv_request_sample(void *avc, const char *msg, ...);
extern void avpriv_report_missing_feature(void *avc, const char *msg, ...);

/* libavutil math helpers in mathematics.h / time.h (included above) —
 * no forward decls needed: av_rescale, av_rescale_rnd, av_rescale_q,
 * av_compare_ts, av_gcd, av_gettime, av_base64_decode. */

/* AVCodec parser API — opening, feeding, closing. */
struct AVCodecParserContext;
extern struct AVCodecParserContext *av_parser_init(int codec_id);
extern int av_parser_parse2(struct AVCodecParserContext *s, AVCodecContext *avctx,
                             uint8_t **poutbuf, int *poutbuf_size,
                             const uint8_t *buf, int buf_size,
                             int64_t pts, int64_t dts, int64_t pos);
extern void av_parser_close(struct AVCodecParserContext *s);

/* Side-data + PCM helpers — declared in avcodec.h via the
 * `avcodec.h` include above; just take their addresses below. */

/* libavformat IO helpers — extra `avio_*` reads/writes. The
 * declarations live in `avio.h` which `avformat.h` pulls in;
 * no forward decls needed here for any `avio_*` symbol. */

/* Internal libavformat helpers — declarations live in private
 * headers we don't include. Forward-declare the minimum we need
 * to take their address; the actual type signatures don't matter
 * here because we never call them through this file. */
extern int  ffio_read_size(AVIOContext *s, unsigned char *buf, int size);
extern void ffio_fill(AVIOContext *s, int b, int64_t count);
extern void ffio_free_dyn_buf(AVIOContext **s);
extern void *avpriv_new_chapter(AVFormatContext *s, int64_t id,
                                 int time_base_num, int time_base_den,
                                 int64_t start, int64_t end,
                                 const char *title);
extern int  ff_codec_get_id(const void *tags, unsigned int tag);
extern int  ff_get_pcm_codec_id(int bps, int flt, int be, int sflags);
extern int  ff_add_attached_pic(AVFormatContext *s, AVStream *st,
                                 AVIOContext *pb, void **buf, int size);
extern void ff_id3v2_read_dict(AVIOContext *pb, void **m,
                                const char *magic, void *extra_meta);
extern int  ff_id3v2_parse_apic(AVFormatContext *s, void *extra_meta);
extern int  ff_id3v2_parse_chapters(AVFormatContext *s, void *extra_meta);
extern int  ff_id3v2_parse_priv(AVFormatContext *s, void *extra_meta);
extern void ff_id3v2_free_extra_meta(void *extra_meta);
extern void ff_metadata_conv(void **pm, const void *d_conv, const void *s_conv);
extern void ff_metadata_conv_ctx(AVFormatContext *ctx,
                                  const void *d_conv, const void *s_conv);
extern int  ff_standardize_creation_time(AVFormatContext *s);

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

	/* Audio sample-format introspection — used by every audio
	 * codec to figure out the size of decoded buffers. */
	(void *)&av_get_bytes_per_sample,
	(void *)&av_sample_fmt_is_planar,
	(void *)&av_samples_get_buffer_size,
	(void *)&av_samples_fill_arrays,

	/* Generic CRC table machinery. FLAC + a few other codecs
	 * pull the CRC-16 / CRC-24 table at init time. */
	(void *)&av_crc,
	(void *)&av_crc_get_table,

	/* Channel-layout helpers beyond the ones already exported. */
	(void *)&av_channel_layout_from_mask,
	(void *)&av_channel_layout_compare,

	/* Modern transform API (FFT, MDCT, RDFT via `av_tx_*`) — many
	 * newer codecs (HCA, modern Opus, AAC's USAC path) use this
	 * instead of the older `ff_fft_*` / `ff_mdct_*` direct calls. */
	(void *)&av_tx_init,
	(void *)&av_tx_uninit,

	/* Legacy FFT / MDCT / sinewin — pre-`av_tx` transform API.
	 * AAC + several other audio codecs still call these. */
	(void *)&ff_fft_init,
	(void *)&ff_fft_end,
	(void *)&ff_mdct_init,
	(void *)&ff_mdct_end,
	(void *)&ff_sine_window_init,
	(void *)&ff_init_ff_sine_windows,
	(void *)&ff_aac_float_common_init,

	/* Float-DSP context allocator — used by the modern audio
	 * decoder path for vector ops (`vector_fmul`, etc.). */
	(void *)&avpriv_float_dsp_alloc,

	/* Diagnostics from inside upstream codec code. */
	(void *)&avpriv_request_sample,
	(void *)&avpriv_report_missing_feature,

	/* Frame-threaded buffer get — non-threaded build still
	 * routes through this. */
	(void *)&ff_thread_get_buffer,

	/* Allocator-backed re-malloc with growth. Used inside
	 * many codec parsers / demuxers. */
	(void *)&av_fast_malloc,
	(void *)&av_fast_realloc,

	/* libavutil math + timestamp utilities. */
	(void *)&av_rescale,
	(void *)&av_rescale_rnd,
	(void *)&av_rescale_q,
	(void *)&av_compare_ts,
	(void *)&av_gcd,
	(void *)&av_gettime,

	/* Base64 decode. */
	(void *)&av_base64_decode,

	/* AVCodec parser API. */
	(void *)&av_parser_init,
	(void *)&av_parser_parse2,
	(void *)&av_parser_close,

	/* Stream side-data attach. */
	(void *)&av_stream_new_side_data,

	/* PCM / audio utilities. */
	(void *)&av_get_bits_per_sample,
	(void *)&av_get_exact_bits_per_sample,
	(void *)&av_get_audio_frame_duration2,

	/* FourCC pretty-printing. */
	(void *)&av_fourcc_make_string,

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

	/* Extra avio_* IO primitives that muxers/demuxers reach for. */
	(void *)&avio_get_str,
	(void *)&avio_read_partial,
	(void *)&avio_w8,
	(void *)&avio_write,
	(void *)&avio_wl16,
	(void *)&avio_wb16,
	(void *)&avio_wl32,
	(void *)&avio_wb32,
	(void *)&avio_wl64,
	(void *)&avio_wb64,
	(void *)&avio_put_str,
	(void *)&avio_put_str16le,
	(void *)&avio_open_dyn_buf,
	(void *)&avio_get_dyn_buf,
	(void *)&ffio_free_dyn_buf,
	(void *)&ffio_fill,
	(void *)&ffio_read_size,

	/* Demuxer chapter creator. */
	(void *)&avpriv_new_chapter,

	/* PCM / codec-tag helpers. */
	(void *)&ff_codec_get_id,
	(void *)&ff_get_pcm_codec_id,

	/* Cover art + attached pictures. */
	(void *)&ff_add_attached_pic,

	/* ID3v2 parsing. */
	(void *)&ff_id3v2_read_dict,
	(void *)&ff_id3v2_parse_apic,
	(void *)&ff_id3v2_parse_chapters,
	(void *)&ff_id3v2_parse_priv,
	(void *)&ff_id3v2_free_extra_meta,

	/* Metadata conversion tables. */
	(void *)&ff_metadata_conv,
	(void *)&ff_metadata_conv_ctx,

	/* Creation-time tag helper. */
	(void *)&ff_standardize_creation_time,

	(void *)0,
};
