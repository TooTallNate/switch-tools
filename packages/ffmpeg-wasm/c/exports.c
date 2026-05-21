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
#include "libavutil/bprint.h"
#include "libavutil/buffer.h"
#include "libavutil/channel_layout.h"
#include "libavutil/crc.h"
#include "libavutil/dict.h"
#include "libavutil/eval.h"
#include "libavutil/float_dsp.h"
#include "libavutil/imgutils.h"
#include "libavutil/intreadwrite.h"
#include "libavutil/lfg.h"
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

/* Encoder helpers — modern encoders use these instead of allocating
 * packets manually. Defined in `libavcodec/encode.c`. */
extern int  ff_get_encode_buffer(AVCodecContext *avctx, AVPacket *pkt,
                                  int64_t size, int flags);
extern int  ff_alloc_packet(AVCodecContext *avctx, AVPacket *pkt,
                             int64_t size);

/* libavcodec parser / DSP infrastructure — pulled in by most
 * MPEG-family decoders. `ff_init_vlc_from_lengths` lives in the
 * private vlc.h header; we declare it with `int` instead of
 * the real `VLC*` first arg since we only need to take its
 * address. */
extern int  ff_init_vlc_from_lengths();
extern void ff_init_scantable(uint8_t *permutation, void *st,
                               const uint8_t *src_scantable);
extern void ff_bswapdsp_init(void *c);
extern void ff_idctdsp_init(void *c, AVCodecContext *avctx);
extern void ff_videodsp_init(void *ctx, int bpc);
extern void ff_qpeldsp_init(void *c);
extern void ff_pixblockdsp_init(void *c, AVCodecContext *avctx);

/* MPEG-video common helpers — H.263, MPEG-1/2/4, FLV, RV*, WMV1/2,
 * MSMPEG4 family all share this core machinery. */
struct MpegEncContext;
extern int  ff_mpv_common_init(struct MpegEncContext *s);
extern void ff_mpv_common_end(struct MpegEncContext *s);
extern int  ff_mpv_decode_init(struct MpegEncContext *s, AVCodecContext *avctx);
extern int  ff_mpv_frame_start(struct MpegEncContext *s, AVCodecContext *avctx);
extern void ff_mpv_frame_end(struct MpegEncContext *s);
extern int  ff_mpv_idct_init(struct MpegEncContext *s);
extern void ff_mpeg_er_frame_start(struct MpegEncContext *s);
extern void ff_print_debug_info(struct MpegEncContext *s, void *p);
extern void ff_set_qscale(struct MpegEncContext *s, int q);
extern void ff_rl_init(void *rl, uint8_t static_store[2][2 * 2 * 64]);
extern int  ff_rl_init_vlc(void *rl, unsigned int static_size);
extern int  ff_set_sar(AVCodecContext *avctx, void *r);
extern int  ff_set_cmp(void *c, void *cmp, int type);
extern int  ff_toupper4(unsigned int x);

/* Error-resilience helpers — used by MPEG-family decoders to
 * recover from corrupt bitstreams. */
extern void ff_er_frame_end(void *s, int *decode_error_flags);
extern void ff_er_add_slice(void *s, int startx, int starty, int endx,
                             int endy, int status);
extern int  ff_er_frame_start(void *s);
extern int  ff_init_block_index(void *s);

/* MPEG-video extras: format, slice & QP-table accessors. */
extern int  ff_get_format(AVCodecContext *avctx, const int *fmt);
extern void ff_mpv_reconstruct_mb(void *s, void *block);
extern int  ff_mpv_export_qp_table(void *s, AVFrame *f, void *p, int qp_type);
extern void ff_mpv_report_decode_progress(void *s);
extern void ff_mpeg_draw_horiz_band(void *s, int y, int h);

/* MPEG audio header parsing + DSP init. */
extern int  ff_mpadsp_init(void *s);
extern int  avpriv_mpegaudio_decode_header(void *header, uint32_t header_int);

/* Combine-frame + start-code helpers — used by parser-style
 * demuxers (MOV, MPEGTS, AVI). */
extern int  ff_combine_frame(void *pc, int next, const uint8_t **buf,
                              int *buf_size);
extern const uint8_t *avpriv_find_start_code(const uint8_t *p,
                                              const uint8_t *end,
                                              uint32_t *state);

/* Palette / picture / line helpers. */
extern int  ff_copy_palette(void *dst, const AVPacket *src, void *logctx);
extern int  ff_get_line(AVIOContext *s, char *buf, int maxlen);
extern int  ff_codec_get_tag(const void *tags, int id);

/* The rest below are declared in libavformat/libavutil public
 * headers we already include above (avio.h, bprint.h, dict.h,
 * rational.h, frame.h, imgutils.h). We just take their address. */

/* Frame-threading helpers (single-thread fallbacks present even
 * when threads are disabled). */
extern void ff_thread_finish_setup(AVCodecContext *avctx);
extern void ff_thread_await_progress(AVFrame *f, int n, int field);
extern void ff_thread_report_progress(AVFrame *f, int n, int field);
extern int  ff_thread_get_ext_buffer(AVCodecContext *avctx, AVFrame *f,
                                      int flags);
extern int  ff_thread_get_format(AVCodecContext *avctx, const int *fmt);
extern int  ff_thread_ref_frame(AVFrame *dst, AVFrame *src);
extern void ff_thread_release_buffer(AVCodecContext *avctx, AVFrame *f);
extern int  ff_thread_release_ext_buffer(AVCodecContext *avctx, void *f);
extern int  ff_thread_can_start_frame(AVCodecContext *avctx);

/* Format-IO + probing helpers. `av_demuxer_iterate`,
 * `av_probe_input_format3` are declared in avformat.h. */
extern void ff_format_io_close(AVFormatContext *s, AVIOContext **pb);
extern int  avio_check(const char *url, int flags);
extern int  avio_printf(AVIOContext *s, const char *fmt, ...);
extern int  ff_read_packet(AVFormatContext *s, AVPacket *pkt);
extern void ff_read_frame_flush(AVFormatContext *s);
extern int  ff_reduce_index(AVFormatContext *s, int stream_index);
extern int  ff_seek_frame_binary(AVFormatContext *s, int stream_index,
                                  int64_t target_ts, int flags);
extern int  ff_rfps_add_frame(AVFormatContext *ic, AVStream *st,
                               int64_t ts);
extern void ff_rfps_calculate(AVFormatContext *ic);
extern int  ff_remove_stream(AVFormatContext *s, AVStream *st);
extern int  ff_stream_add_bitstream_filter(AVStream *st, const char *name,
                                            const char *args);
extern int  ff_stream_encode_params_copy(AVStream *dst, const AVStream *src);
extern int  ff_stream_side_data_copy(AVStream *dst, const AVStream *src);
extern int  ff_write_chained(AVFormatContext *dst, int dst_stream,
                              AVPacket *pkt, AVFormatContext *src, int interleave);
extern int  ff_parse_key_value(const char *str, void *callback, void *ctx);

/* libavutil — bprint, eval, LFG, side-data, frame helpers.
 * `av_packet_pack_dictionary`, `av_hex_dump`, `av_pkt_dump_log2`
 * are declared in their respective public headers. */
extern void av_fast_padded_malloc(void *ptr, unsigned int *size, size_t min_size);
extern int  av_get_frame_filename(char *buf, int buf_size, const char *path,
                                   int number);
extern int  av_reduce(int *dst_num, int *dst_den, int64_t num, int64_t den,
                       int64_t max);
extern void *av_realloc_array(void *ptr, size_t nmemb, size_t size);
extern int  av_reallocp_array(void *ptr, size_t nmemb, size_t size);
extern int  av_get_pix_fmt(const char *name);
extern int  av_pix_fmt_get_chroma_sub_sample(int pix_fmt, int *h, int *v);
extern char *av_asprintf(const char *fmt, ...);
extern int  av_stristart(const char *str, const char *pfx, const char **ptr);
extern const char *av_basename(const char *path);
extern int  av_channel_layout_index_from_channel(const AVChannelLayout *cl,
                                                  int channel);
extern void av_downmix_info_update_side_data(AVFrame *f);
extern int  av_side_data_update_matrix_encoding(AVFrame *f, int matrix_encoding);
extern int  av_stream_set_side_data(AVStream *st, int type, void *data,
                                     size_t size);
extern int  ff_side_data_update_matrix_encoding(AVStream *st, int matrix);
extern int  ff_side_data_set_encoder_stats(AVPacket *pkt, int quality,
                                            int64_t *error, int error_count,
                                            int pict_type);
extern uint32_t av_adler32_update(uint32_t adler, const uint8_t *buf,
                                   unsigned int len);

/* Internal libavformat helpers — declarations live in private
 * headers we don't include. Forward-declare the minimum we need
 * to take their address; the actual type signatures don't matter
 * here because we never call them through this file. */
extern int  ffio_read_size(AVIOContext *s, unsigned char *buf, int size);
extern void ffio_fill(AVIOContext *s, int b, int64_t count);
extern void ffio_free_dyn_buf(AVIOContext **s);
extern int  ffio_init_context(void *s, unsigned char *buf, int buf_size,
                               int write_flag, void *opaque,
                               int (*read_packet)(void *, uint8_t *, int),
                               int (*write_packet)(void *, const uint8_t *, int),
                               int64_t (*seek)(void *, int64_t, int));
extern int  ffio_get_checksum(AVIOContext *s);
extern void ffio_init_checksum(AVIOContext *s, uint32_t (*update_checksum)(uint32_t, const uint8_t *, unsigned int), uint32_t checksum);
extern int  ffio_limit(AVIOContext *s, int size);
extern int  ffio_ensure_seekback(AVIOContext *s, int64_t buf_size);
extern int  ffio_read_indirect(AVIOContext *s, unsigned char *buf, int size,
                                const unsigned char **data);
extern int  ffio_read_varlen(AVIOContext *s);
extern void ffio_reset_dyn_buf(AVIOContext *s);
extern int  ffio_rewind_with_probe_data(AVIOContext *s, unsigned char **buf,
                                          int buf_size);
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

	/* bprint API — many encoders + muxers use this for building
	 * variable-length strings (metadata, log lines, etc.). */
	(void *)&av_bprint_init,
	(void *)&av_bprint_finalize,
	(void *)&av_bprint_chars,
	(void *)&av_bprintf,
	(void *)&av_asprintf,
	(void *)&av_basename,
	(void *)&av_stristart,
	(void *)&av_reduce,
	(void *)&av_realloc_array,
	(void *)&av_reallocp_array,
	(void *)&av_fast_padded_malloc,

	/* Pixel-format introspection. */
	(void *)&av_get_pix_fmt,
	(void *)&av_pix_fmt_get_chroma_sub_sample,

	/* Frame / packet helpers used by encoders. */
	(void *)&av_packet_pack_dictionary,
	(void *)&av_get_frame_filename,
	(void *)&av_channel_layout_index_from_channel,
	(void *)&av_downmix_info_update_side_data,
	(void *)&av_adler32_update,
	(void *)&av_hex_dump,
	(void *)&av_pkt_dump_log2,

	/* LFG (linear feedback random gen) — used by AC-3 / Speex /
	 * DCA decoders for noise generation. */
	(void *)&av_lfg_init,

	/* Codec encoder helpers — modern encoders route allocations
	 * through these. */
	(void *)&ff_get_encode_buffer,
	(void *)&ff_alloc_packet,

	/* DSP init helpers for video codecs. */
	(void *)&ff_init_vlc_from_lengths,
	(void *)&ff_init_scantable,
	(void *)&ff_bswapdsp_init,
	(void *)&ff_idctdsp_init,
	(void *)&ff_videodsp_init,
	(void *)&ff_qpeldsp_init,
	(void *)&ff_pixblockdsp_init,

	/* MPEG-video common — used by every MPEG-family codec
	 * (H.263, MPEG-1/2/4, FLV, RealVideo, WMV1/2, MSMPEG4). */
	(void *)&ff_mpv_common_init,
	(void *)&ff_mpv_common_end,
	(void *)&ff_mpv_decode_init,
	(void *)&ff_mpv_frame_start,
	(void *)&ff_mpv_frame_end,
	(void *)&ff_mpv_idct_init,
	(void *)&ff_mpeg_er_frame_start,
	(void *)&ff_print_debug_info,
	(void *)&ff_set_qscale,
	(void *)&ff_rl_init,
	(void *)&ff_rl_init_vlc,
	(void *)&ff_set_sar,
	(void *)&ff_set_cmp,
	(void *)&ff_toupper4,

	/* Frame-threading helpers (single-threaded fallbacks). */
	(void *)&ff_thread_finish_setup,
	(void *)&ff_thread_await_progress,
	(void *)&ff_thread_report_progress,
	(void *)&ff_thread_get_ext_buffer,
	(void *)&ff_thread_get_format,
	(void *)&ff_thread_ref_frame,
	(void *)&ff_thread_release_buffer,
	(void *)&ff_thread_release_ext_buffer,
	(void *)&ff_thread_can_start_frame,

	/* Side-data helpers. */
	(void *)&ff_side_data_update_matrix_encoding,
	(void *)&ff_side_data_set_encoder_stats,

	/* Error-resilience helpers. */
	(void *)&ff_er_frame_end,
	(void *)&ff_er_add_slice,
	(void *)&ff_init_block_index,

	/* MPEG-video extras. */
	(void *)&ff_get_format,
	(void *)&ff_mpv_reconstruct_mb,
	(void *)&ff_mpv_export_qp_table,
	(void *)&ff_mpv_report_decode_progress,
	(void *)&ff_mpeg_draw_horiz_band,

	/* MPEG audio header + DSP. */
	(void *)&ff_mpadsp_init,
	(void *)&avpriv_mpegaudio_decode_header,

	/* Combine-frame + start-code. */
	(void *)&ff_combine_frame,
	(void *)&avpriv_find_start_code,

	/* Palette / picture / line. */
	(void *)&ff_copy_palette,
	(void *)&ff_get_line,
	(void *)&ff_codec_get_tag,

	/* Bprint + dict extras. */
	(void *)&av_bprint_clear,
	(void *)&av_dict_copy,
	(void *)&av_dict_set_int,
	(void *)&av_get_media_type_string,
	(void *)&av_d2q,
	(void *)&av_mul_q,
	(void *)&av_memcpy_backptr,
	(void *)&av_match_ext,
	(void *)&av_frame_new_side_data,
	(void *)&av_stream_get_side_data,
	(void *)&av_image_copy_plane,
	(void *)&av_get_picture_type_char,
	(void *)&avio_write_marker,

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

	/* Format-IO + probing helpers. */
	(void *)&ff_format_io_close,
	(void *)&av_demuxer_iterate,
	(void *)&av_probe_input_format3,
	(void *)&avio_check,
	(void *)&avio_printf,
	(void *)&ff_read_packet,
	(void *)&ff_read_frame_flush,
	(void *)&ff_reduce_index,
	(void *)&ff_seek_frame_binary,
	(void *)&ff_rfps_add_frame,
	(void *)&ff_rfps_calculate,
	(void *)&ff_remove_stream,
	(void *)&ff_stream_add_bitstream_filter,
	(void *)&ff_stream_encode_params_copy,
	(void *)&ff_stream_side_data_copy,
	(void *)&ff_write_chained,
	(void *)&ff_parse_key_value,

	/* Internal ffio_* helpers. */
	(void *)&ffio_init_context,
	(void *)&ffio_get_checksum,
	(void *)&ffio_init_checksum,
	(void *)&ffio_limit,
	(void *)&ffio_ensure_seekback,
	(void *)&ffio_read_indirect,
	(void *)&ffio_read_varlen,
	(void *)&ffio_reset_dyn_buf,
	(void *)&ffio_rewind_with_probe_data,

	(void *)0,
};
