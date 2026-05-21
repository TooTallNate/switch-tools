# @tootallnate/ffmpeg-wasm — build base FFmpeg as a WASM "reactor"
# that exposes the libav* C API for dynamically-loaded codec
# extensions.
#
# What this builds:
#
#   - Slim FFmpeg core (libavutil + libavcodec scaffolding +
#     libavformat scaffolding) compiled to wasm32-wasip1. No codecs,
#     no demuxers, no muxers, no filters — extensions provide those.
#
#   - A small C wrapper (`c/wrapper.c`, MIT-licensed) that:
#       * Allocates / frees FFmpeg objects (AVCodecContext,
#         AVFrame, AVPacket, ...).
#       * Drives single-file in-memory demuxing + decoding using
#         caller-provided codec pointers (one active session at a
#         time, matching bink1-wasm's shape).
#
# Design: extensions expose `ffmpeg_ext_<name>_codec()` returning
# a `const FFCodec *` (e.g. `&ff_bink2_decoder`). JS reads that
# pointer from the extension and hands it back to the base when
# calling `ffmpeg_open_codec()`. Extensions don't need to register
# into FFmpeg's static `codec_list[]` — we bypass `av_find_decoder`
# entirely and pass the codec pointer directly to `avcodec_open2`.
# Demuxers are similar: extensions provide an `AVInputFormat *`
# pointer that JS hands to the wrapper.
#
# FFmpeg is LGPL-2.1+; the compiled `ffmpeg.wasm` may be freely
# redistributed and is shipped inside this package.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC      = $(WASI_SDK)/bin/clang
AR      = $(WASI_SDK)/bin/llvm-ar
NM      = $(WASI_SDK)/bin/llvm-nm
RANLIB  = $(WASI_SDK)/bin/llvm-ranlib
STRIP   = $(WASI_SDK)/bin/llvm-strip

SYSROOT     = $(WASI_SDK)/share/wasi-sysroot
FFMPEG_SRC  = build/ffmpeg

OUT = src/ffmpeg.wasm

TARGET_FLAGS = --target=wasm32-wasip1 --sysroot=$(SYSROOT)

# Wrapper compile flags. `-fPIC` not needed for the base module
# (extensions are PIC; the base is a regular static binary).
WRAPPER_CFLAGS = \
	$(TARGET_FLAGS) \
	-fvisibility=hidden \
	-O3 \
	-I$(FFMPEG_SRC) \
	-Wall

# Linker flags. Key things:
#
#   - `-mexec-model=reactor`: produces a WASI library-style module
#     with `_initialize` instead of `_start`.
#
#   - `--export-dynamic`: exports every symbol with default visibility
#     (works alongside the explicit `--export=<name>` list below).
#
#   - `--export=__indirect_function_table`: extensions share this
#     table for their own function pointers.
#
#   - `--export=__stack_pointer`: extensions reuse the same mutable
#     stack-pointer global.
#
#   - `--export=malloc / free`: extension loader uses these to allocate
#     a memory region per extension for its static data (`__memory_base`).
#
#   - `--growable-table`: lets the host `.grow()` the function table
#     when extensions add their own function pointers.
#
#   - `--initial-memory=33554432` (32 MB): a generous starting heap
#     so we don't immediately fault on the bink2 decoder's quant
#     table allocations.
#
#   - The big `--export=<libav-symbol>` block: hand-curated list of
#     libavutil/libavcodec/libavformat APIs that extensions need to
#     import. Without these the linker's `--gc-sections` would drop
#     them since `wrapper.c` only references a small subset. To
#     extend: add the symbol to `c/exports.c`'s keepalive table AND
#     add a `-Wl,--export=<symbol>` line here. (The two halves are
#     redundant by design — keepalive keeps the code alive past LTO,
#     `--export` makes the symbol importable.)
LDFLAGS = \
	$(TARGET_FLAGS) \
	-mexec-model=reactor \
	-O3 \
	-Wl,--export-dynamic \
	-Wl,--allow-undefined \
	-Wl,--export=memory \
	-Wl,--export=__indirect_function_table \
	-Wl,--export=__stack_pointer \
	-Wl,--export=malloc \
	-Wl,--export=free \
	-Wl,--export=realloc \
	-Wl,--export=calloc \
	-Wl,--export=memcpy \
	-Wl,--export=memset \
	-Wl,--export=memmove \
	-Wl,--export=memcmp \
	-Wl,--export=memchr \
	-Wl,--export=strlen \
	-Wl,--export=strcmp \
	-Wl,--export=strncmp \
	-Wl,--export=strchr \
	-Wl,--export=strrchr \
	-Wl,--export=strstr \
	-Wl,--export=strcpy \
	-Wl,--export=strncpy \
	-Wl,--export=snprintf \
	-Wl,--export=sprintf \
	-Wl,--export=vsnprintf \
	-Wl,--export=qsort \
	-Wl,--export=bsearch \
	-Wl,--export=abort \
	-Wl,--export=lrintf \
	-Wl,--export=lrint \
	-Wl,--export=rintf \
	-Wl,--export=rint \
	-Wl,--export=floor \
	-Wl,--export=ceil \
	-Wl,--export=round \
	-Wl,--export=trunc \
	-Wl,--export=fabs \
	-Wl,--export=fabsf \
	-Wl,--export=sqrt \
	-Wl,--export=sqrtf \
	-Wl,--export=pow \
	-Wl,--export=powf \
	-Wl,--export=exp \
	-Wl,--export=expf \
	-Wl,--export=log \
	-Wl,--export=logf \
	-Wl,--export=log2 \
	-Wl,--export=log10 \
	-Wl,--export=sin \
	-Wl,--export=sinf \
	-Wl,--export=cos \
	-Wl,--export=cosf \
	-Wl,--export=tan \
	-Wl,--export=atan \
	-Wl,--export=atan2 \
	-Wl,--export=ldexp \
	-Wl,--export=frexp \
	-Wl,--export=fmin \
	-Wl,--export=fmax \
	-Wl,--export=fmod \
	-Wl,--export=copysign \
	-Wl,--export=av_buffer_alloc \
	-Wl,--export=av_buffer_create \
	-Wl,--export=av_buffer_ref \
	-Wl,--export=av_buffer_unref \
	-Wl,--export=av_calloc \
	-Wl,--export=av_dict_free \
	-Wl,--export=av_dict_get \
	-Wl,--export=av_dict_set \
	-Wl,--export=av_frame_alloc \
	-Wl,--export=av_frame_clone \
	-Wl,--export=av_frame_free \
	-Wl,--export=av_frame_get_buffer \
	-Wl,--export=av_frame_make_writable \
	-Wl,--export=av_frame_ref \
	-Wl,--export=av_frame_unref \
	-Wl,--export=av_free \
	-Wl,--export=av_freep \
	-Wl,--export=av_get_pix_fmt_name \
	-Wl,--export=av_grow_packet \
	-Wl,--export=av_image_alloc \
	-Wl,--export=av_image_check_size \
	-Wl,--export=av_image_fill_linesizes \
	-Wl,--export=av_image_fill_pointers \
	-Wl,--export=av_image_get_buffer_size \
	-Wl,--export=av_log \
	-Wl,--export=av_log_default_callback \
	-Wl,--export=av_log_get_level \
	-Wl,--export=av_log_set_level \
	-Wl,--export=av_malloc \
	-Wl,--export=av_malloc_array \
	-Wl,--export=av_mallocz \
	-Wl,--export=av_memdup \
	-Wl,--export=av_new_packet \
	-Wl,--export=av_opt_find \
	-Wl,--export=av_opt_get \
	-Wl,--export=av_opt_set \
	-Wl,--export=av_opt_set_int \
	-Wl,--export=av_packet_add_side_data \
	-Wl,--export=av_packet_alloc \
	-Wl,--export=av_packet_clone \
	-Wl,--export=av_packet_free \
	-Wl,--export=av_packet_get_side_data \
	-Wl,--export=av_packet_make_writable \
	-Wl,--export=av_packet_new_side_data \
	-Wl,--export=av_packet_ref \
	-Wl,--export=av_packet_rescale_ts \
	-Wl,--export=av_packet_unref \
	-Wl,--export=av_pix_fmt_desc_get \
	-Wl,--export=av_read_frame \
	-Wl,--export=av_realloc \
	-Wl,--export=av_realloc_f \
	-Wl,--export=av_seek_frame \
	-Wl,--export=av_shrink_packet \
	-Wl,--export=av_strcasecmp \
	-Wl,--export=av_strdup \
	-Wl,--export=av_strerror \
	-Wl,--export=av_strlcat \
	-Wl,--export=av_strlcatf \
	-Wl,--export=av_strlcpy \
	-Wl,--export=av_strncasecmp \
	-Wl,--export=av_strstart \
	-Wl,--export=avcodec_alloc_context3 \
	-Wl,--export=avcodec_close \
	-Wl,--export=avcodec_flush_buffers \
	-Wl,--export=avcodec_free_context \
	-Wl,--export=avcodec_get_name \
	-Wl,--export=avcodec_open2 \
	-Wl,--export=avcodec_parameters_alloc \
	-Wl,--export=avcodec_parameters_copy \
	-Wl,--export=avcodec_parameters_free \
	-Wl,--export=avcodec_parameters_from_context \
	-Wl,--export=avcodec_parameters_to_context \
	-Wl,--export=avcodec_receive_frame \
	-Wl,--export=avcodec_receive_packet \
	-Wl,--export=avcodec_send_frame \
	-Wl,--export=avcodec_send_packet \
	-Wl,--export=avformat_alloc_context \
	-Wl,--export=avformat_close_input \
	-Wl,--export=avformat_find_stream_info \
	-Wl,--export=avformat_free_context \
	-Wl,--export=avformat_new_stream \
	-Wl,--export=avformat_open_input \
	-Wl,--export=avio_alloc_context \
	-Wl,--export=avio_context_free \
	-Wl,--export=avio_feof \
	-Wl,--export=avio_r8 \
	-Wl,--export=avio_rb16 \
	-Wl,--export=avio_rb24 \
	-Wl,--export=avio_rb32 \
	-Wl,--export=avio_rb64 \
	-Wl,--export=avio_read \
	-Wl,--export=avio_rl16 \
	-Wl,--export=avio_rl24 \
	-Wl,--export=avio_rl32 \
	-Wl,--export=avio_rl64 \
	-Wl,--export=avio_seek \
	-Wl,--export=avio_size \
	-Wl,--export=avio_skip \
	-Wl,--export=avio_tell \
	-Wl,--export=av_add_index_entry \
	-Wl,--export=av_get_packet \
	-Wl,--export=av_index_search_timestamp \
	-Wl,--export=avpriv_set_pts_info \
	-Wl,--export=ff_alloc_extradata \
	-Wl,--export=ff_blockdsp_init \
	-Wl,--export=ff_hpeldsp_init \
	-Wl,--export=ff_free_vlc \
	-Wl,--export=ff_get_buffer \
	-Wl,--export=ff_reget_buffer \
	-Wl,--export=ff_get_extradata \
	-Wl,--export=ff_init_vlc_sparse \
	-Wl,--export=ff_set_dimensions \
	-Wl,--export=ff_rdft_init \
	-Wl,--export=ff_rdft_end \
	-Wl,--export=ff_dct_init \
	-Wl,--export=ff_dct_end \
	-Wl,--export=ff_wma_critical_freqs \
	-Wl,--export=av_channel_layout_copy \
	-Wl,--export=av_channel_layout_uninit \
	-Wl,--export=av_channel_layout_default \
	-Wl,--export=av_channel_layout_from_mask \
	-Wl,--export=av_channel_layout_compare \
	-Wl,--export=av_log2 \
	-Wl,--export=ff_decode_get_packet \
	-Wl,--export=av_get_bytes_per_sample \
	-Wl,--export=av_sample_fmt_is_planar \
	-Wl,--export=av_samples_get_buffer_size \
	-Wl,--export=av_samples_fill_arrays \
	-Wl,--export=av_crc \
	-Wl,--export=av_crc_get_table \
	-Wl,--export=av_tx_init \
	-Wl,--export=av_tx_uninit \
	-Wl,--export=ff_fft_init \
	-Wl,--export=ff_fft_end \
	-Wl,--export=ff_mdct_init \
	-Wl,--export=ff_mdct_end \
	-Wl,--export=ff_sine_window_init \
	-Wl,--export=ff_init_ff_sine_windows \
	-Wl,--export=ff_aac_float_common_init \
	-Wl,--export=avpriv_float_dsp_alloc \
	-Wl,--export=avpriv_request_sample \
	-Wl,--export=avpriv_report_missing_feature \
	-Wl,--export=ff_thread_get_buffer \
	-Wl,--export=av_fast_malloc \
	-Wl,--export=av_fast_realloc \
	-Wl,--export=av_rescale \
	-Wl,--export=av_rescale_rnd \
	-Wl,--export=av_rescale_q \
	-Wl,--export=av_compare_ts \
	-Wl,--export=av_gcd \
	-Wl,--export=av_gettime \
	-Wl,--export=av_base64_decode \
	-Wl,--export=av_parser_init \
	-Wl,--export=av_parser_parse2 \
	-Wl,--export=av_parser_close \
	-Wl,--export=av_stream_new_side_data \
	-Wl,--export=av_get_bits_per_sample \
	-Wl,--export=av_get_exact_bits_per_sample \
	-Wl,--export=av_get_audio_frame_duration2 \
	-Wl,--export=av_fourcc_make_string \
	-Wl,--export=avio_get_str \
	-Wl,--export=avio_read_partial \
	-Wl,--export=avio_w8 \
	-Wl,--export=avio_write \
	-Wl,--export=avio_wl16 \
	-Wl,--export=avio_wb16 \
	-Wl,--export=avio_wl32 \
	-Wl,--export=avio_wb32 \
	-Wl,--export=avio_wl64 \
	-Wl,--export=avio_wb64 \
	-Wl,--export=avio_put_str \
	-Wl,--export=avio_put_str16le \
	-Wl,--export=avio_open_dyn_buf \
	-Wl,--export=avio_get_dyn_buf \
	-Wl,--export=ffio_free_dyn_buf \
	-Wl,--export=ffio_fill \
	-Wl,--export=ffio_read_size \
	-Wl,--export=avpriv_new_chapter \
	-Wl,--export=ff_codec_get_id \
	-Wl,--export=ff_get_pcm_codec_id \
	-Wl,--export=ff_add_attached_pic \
	-Wl,--export=ff_id3v2_read_dict \
	-Wl,--export=ff_id3v2_parse_apic \
	-Wl,--export=ff_id3v2_parse_chapters \
	-Wl,--export=ff_id3v2_parse_priv \
	-Wl,--export=ff_id3v2_free_extra_meta \
	-Wl,--export=ff_metadata_conv \
	-Wl,--export=ff_metadata_conv_ctx \
	-Wl,--export=ff_standardize_creation_time \
	-Wl,--export=ldexpf \
	-Wl,--export=sscanf \
	-Wl,--export=atan2f \
	-Wl,--export=atanf \
	-Wl,--export=log2f \
	-Wl,--export=cbrt \
	-Wl,--export=cbrtf \
	-Wl,--export=hypot \
	-Wl,--export=strspn \
	-Wl,--export=strtol \
	-Wl,--export=strtoll \
	-Wl,--export=localtime_r \
	-Wl,--export=strftime \
	-Wl,--export=ffmpeg_register_muxer \
	-Wl,--export=ffmpeg_codec_count \
	-Wl,--export=ffmpeg_codec_at \
	-Wl,--export=ffmpeg_codec_name \
	-Wl,--export=ffmpeg_codec_long_name \
	-Wl,--export=ffmpeg_codec_id \
	-Wl,--export=ffmpeg_codec_type \
	-Wl,--export=ffmpeg_codec_capabilities \
	-Wl,--export=ffmpeg_codec_is_decoder \
	-Wl,--export=ffmpeg_codec_is_encoder \
	-Wl,--export=ffmpeg_demuxer_count \
	-Wl,--export=ffmpeg_demuxer_at \
	-Wl,--export=ffmpeg_demuxer_name \
	-Wl,--export=ffmpeg_demuxer_long_name \
	-Wl,--export=ffmpeg_demuxer_extensions \
	-Wl,--export=ffmpeg_demuxer_mime_type \
	-Wl,--export=ffmpeg_demuxer_flags \
	-Wl,--export=ffmpeg_muxer_count \
	-Wl,--export=ffmpeg_muxer_at \
	-Wl,--export=ffmpeg_muxer_name \
	-Wl,--export=ffmpeg_muxer_long_name \
	-Wl,--export=ffmpeg_muxer_extensions \
	-Wl,--export=ffmpeg_muxer_mime_type \
	-Wl,--export=ffmpeg_muxer_flags \
	-Wl,--export=ffmpeg_muxer_video_codec \
	-Wl,--export=ffmpeg_muxer_audio_codec \
	-Wl,--export=av_bprint_init \
	-Wl,--export=av_bprint_finalize \
	-Wl,--export=av_bprint_chars \
	-Wl,--export=av_bprintf \
	-Wl,--export=av_asprintf \
	-Wl,--export=av_basename \
	-Wl,--export=av_stristart \
	-Wl,--export=av_reduce \
	-Wl,--export=av_realloc_array \
	-Wl,--export=av_reallocp_array \
	-Wl,--export=av_fast_padded_malloc \
	-Wl,--export=av_get_pix_fmt \
	-Wl,--export=av_pix_fmt_get_chroma_sub_sample \
	-Wl,--export=av_packet_pack_dictionary \
	-Wl,--export=av_get_frame_filename \
	-Wl,--export=av_channel_layout_index_from_channel \
	-Wl,--export=av_downmix_info_update_side_data \
	-Wl,--export=av_adler32_update \
	-Wl,--export=av_hex_dump \
	-Wl,--export=av_pkt_dump_log2 \
	-Wl,--export=av_lfg_init \
	-Wl,--export=av_lfg_init_from_data \
	-Wl,--export=ff_get_encode_buffer \
	-Wl,--export=ff_alloc_packet \
	-Wl,--export=ff_init_vlc_from_lengths \
	-Wl,--export=ff_init_scantable \
	-Wl,--export=ff_bswapdsp_init \
	-Wl,--export=ff_idctdsp_init \
	-Wl,--export=ff_videodsp_init \
	-Wl,--export=ff_qpeldsp_init \
	-Wl,--export=ff_pixblockdsp_init \
	-Wl,--export=ff_mpv_common_init \
	-Wl,--export=ff_mpv_common_end \
	-Wl,--export=ff_mpv_decode_init \
	-Wl,--export=ff_mpv_frame_start \
	-Wl,--export=ff_mpv_frame_end \
	-Wl,--export=ff_mpv_idct_init \
	-Wl,--export=ff_mpeg_er_frame_start \
	-Wl,--export=ff_print_debug_info \
	-Wl,--export=ff_set_qscale \
	-Wl,--export=ff_rl_init \
	-Wl,--export=ff_rl_init_vlc \
	-Wl,--export=ff_set_sar \
	-Wl,--export=ff_set_cmp \
	-Wl,--export=ff_toupper4 \
	-Wl,--export=ff_thread_finish_setup \
	-Wl,--export=ff_thread_await_progress \
	-Wl,--export=ff_thread_report_progress \
	-Wl,--export=ff_thread_get_ext_buffer \
	-Wl,--export=ff_thread_get_format \
	-Wl,--export=ff_thread_ref_frame \
	-Wl,--export=ff_thread_release_buffer \
	-Wl,--export=ff_thread_release_ext_buffer \
	-Wl,--export=ff_thread_can_start_frame \
	-Wl,--export=ff_side_data_update_matrix_encoding \
	-Wl,--export=ff_side_data_set_encoder_stats \
	-Wl,--export=ff_format_io_close \
	-Wl,--export=av_demuxer_iterate \
	-Wl,--export=av_probe_input_format3 \
	-Wl,--export=avio_check \
	-Wl,--export=avio_printf \
	-Wl,--export=ff_read_packet \
	-Wl,--export=ff_read_frame_flush \
	-Wl,--export=ff_reduce_index \
	-Wl,--export=ff_seek_frame_binary \
	-Wl,--export=ff_rfps_add_frame \
	-Wl,--export=ff_rfps_calculate \
	-Wl,--export=ff_remove_stream \
	-Wl,--export=ff_stream_add_bitstream_filter \
	-Wl,--export=ff_stream_encode_params_copy \
	-Wl,--export=ff_stream_side_data_copy \
	-Wl,--export=ff_write_chained \
	-Wl,--export=ff_parse_key_value \
	-Wl,--export=ffio_init_context \
	-Wl,--export=ffio_get_checksum \
	-Wl,--export=ffio_init_checksum \
	-Wl,--export=ffio_limit \
	-Wl,--export=ffio_ensure_seekback \
	-Wl,--export=ffio_read_indirect \
	-Wl,--export=ffio_read_varlen \
	-Wl,--export=ffio_reset_dyn_buf \
	-Wl,--export=ffio_rewind_with_probe_data \
	-Wl,--export=exp2 \
	-Wl,--export=exp2f \
	-Wl,--export=tanf \
	-Wl,--export=roundf \
	-Wl,--export=log10f \
	-Wl,--export=fmaxf \
	-Wl,--export=fminf \
	-Wl,--export=strcspn \
	-Wl,--export=strerror \
	-Wl,--export=strtod \
	-Wl,--export=strtoul \
	-Wl,--export=strtoull \
	-Wl,--export=atoi \
	-Wl,--export=atof \
	-Wl,--export=llrint \
	-Wl,--export=mktime \
	-Wl,--export=time \
	-Wl,--export=gmtime_r \
	-Wl,--export=__assert_fail \
	-Wl,--export=ff_er_frame_end \
	-Wl,--export=ff_er_add_slice \
	-Wl,--export=ff_er_frame_start \
	-Wl,--export=ff_init_block_index \
	-Wl,--export=ff_get_format \
	-Wl,--export=ff_mpv_reconstruct_mb \
	-Wl,--export=ff_mpv_export_qp_table \
	-Wl,--export=ff_mpv_report_decode_progress \
	-Wl,--export=ff_mpeg_draw_horiz_band \
	-Wl,--export=ff_mpadsp_init \
	-Wl,--export=avpriv_mpegaudio_decode_header \
	-Wl,--export=ff_combine_frame \
	-Wl,--export=avpriv_find_start_code \
	-Wl,--export=ff_copy_palette \
	-Wl,--export=ff_get_line \
	-Wl,--export=ff_codec_get_tag \
	-Wl,--export=av_bprint_clear \
	-Wl,--export=av_dict_copy \
	-Wl,--export=av_dict_set_int \
	-Wl,--export=av_get_media_type_string \
	-Wl,--export=av_d2q \
	-Wl,--export=av_mul_q \
	-Wl,--export=av_memcpy_backptr \
	-Wl,--export=av_match_ext \
	-Wl,--export=av_frame_new_side_data \
	-Wl,--export=av_stream_get_side_data \
	-Wl,--export=av_image_copy_plane \
	-Wl,--export=av_get_picture_type_char \
	-Wl,--export=avio_write_marker \
	-Wl,--export=ff_af_queue_init \
	-Wl,--export=ff_af_queue_close \
	-Wl,--export=ff_af_queue_add \
	-Wl,--export=ff_af_queue_remove \
	-Wl,--export=ff_mpv_common_frame_size_change \
	-Wl,--export=ff_find_unused_picture \
	-Wl,--export=ff_guess_coded_bitrate \
	-Wl,--export=ff_audiodsp_init \
	-Wl,--export=ff_fdctdsp_init \
	-Wl,--export=ff_me_cmp_init \
	-Wl,--export=ff_h264_pred_init \
	-Wl,--export=ff_build_rac_states \
	-Wl,--export=ff_init_scantable_permutation \
	-Wl,--export=ff_mpa_synth_init_fixed \
	-Wl,--export=ff_mpa_synth_init_float \
	-Wl,--export=ff_mpa_synth_filter_fixed \
	-Wl,--export=ff_mpa_synth_filter_float \
	-Wl,--export=ff_mpegaudiodec_common_init_static \
	-Wl,--export=ff_mpa_l2_select_table \
	-Wl,--export=av_fifo_alloc2 \
	-Wl,--export=av_fifo_freep2 \
	-Wl,--export=av_fifo_write \
	-Wl,--export=av_fifo_read_to_cb \
	-Wl,--export=av_fifo_can_read \
	-Wl,--export=av_fifo_can_write \
	-Wl,--export=av_frame_move_ref \
	-Wl,--export=av_frame_copy \
	-Wl,--export=av_packet_move_ref \
	-Wl,--export=av_append_packet \
	-Wl,--export=av_get_random_seed \
	-Wl,--export=av_buffer_allocz \
	-Wl,--export=av_reallocp \
	-Wl,--export=av_get_bits_per_pixel \
	-Wl,--export=av_pix_fmt_count_planes \
	-Wl,--export=av_sscanf \
	-Wl,--export=av_stereo3d_create_side_data \
	-Wl,--export=av_stereo3d_alloc \
	-Wl,--export=av_display_rotation_set \
	-Wl,--export=av_display_matrix_flip \
	-Wl,--export=av_stream_add_side_data \
	-Wl,--export=av_bprint_append_data \
	-Wl,--export=av_dict_count \
	-Wl,--export=avpriv_update_cur_dts \
	-Wl,--export=avpriv_split_xiph_headers \
	-Wl,--export=avpriv_dict_set_timestamp \
	-Wl,--export=ff_parse_creation_time_metadata \
	-Wl,--export=ff_id3v2_read \
	-Wl,--export=avio_get_str16le \
	-Wl,--export=avio_close_dyn_buf \
	-Wl,--export=avio_wb24 \
	-Wl,--export=ff_h264chroma_init \
	-Wl,--export=ff_h264qpel_init \
	-Wl,--export=ff_init_range_encoder \
	-Wl,--export=ff_rac_terminate \
	-Wl,--export=ff_copy_bits \
	-Wl,--export=avpriv_scalarproduct_float_c \
	-Wl,--export=ff_mp4_read_descr \
	-Wl,--export=ff_mp4_read_dec_config_descr \
	-Wl,--export=ff_mp4_parse_es_descr \
	-Wl,--export=avpriv_packet_list_put \
	-Wl,--export=avpriv_packet_list_get \
	-Wl,--export=avpriv_packet_list_free \
	-Wl,--export=avpriv_init_lls \
	-Wl,--export=avpriv_solve_lls \
	-Wl,--export=av_timecode_init_from_string \
	-Wl,--export=av_timecode_make_smpte_tc_string2 \
	-Wl,--export=av_hash_alloc \
	-Wl,--export=av_hash_freep \
	-Wl,--export=av_hash_init \
	-Wl,--export=av_hash_update \
	-Wl,--export=av_hash_final_hex \
	-Wl,--export=av_hash_get_name \
	-Wl,--export=ff_id3v1_read \
	-Wl,--export=ff_format_shift_data \
	-Wl,--export=ff_data_to_hex \
	-Wl,--export=ff_bprint_to_codecpar_extradata \
	-Wl,--export=ff_encode_alloc_frame \
	-Wl,--export=ff_add_param_change \
	-Wl,--export=ff_mpegvideoencdsp_init \
	-Wl,--export=ff_mpeg_flush \
	-Wl,--export=ff_mdct_init_fixed_32 \
	-Wl,--export=ff_mdct_end_fixed_32 \
	-Wl,--export=av_image_check_size2 \
	-Wl,--export=av_image_check_sar \
	-Wl,--export=av_channel_layout_check \
	-Wl,--export=av_channel_layout_describe \
	-Wl,--export=av_buffer_realloc \
	-Wl,--export=av_frame_new_side_data_from_buf \
	-Wl,--export=av_fifo_grow2 \
	-Wl,--export=av_div_q \
	-Wl,--export=avpriv_mpeg4audio_get_config2 \
	-Wl,--export=ff_mpeg4audio_get_config_gb \
	-Wl,--export=ff_wmv2dsp_init \
	-Wl,--export=av_md5_alloc \
	-Wl,--export=av_md5_init \
	-Wl,--export=av_md5_update \
	-Wl,--export=av_md5_final \
	-Wl,--export=ff_id3v2_parse_priv_dict \
	-Wl,--export=av_buffer_pool_init \
	-Wl,--export=av_buffer_pool_uninit \
	-Wl,--export=av_buffer_pool_get \
	-Wl,--export=av_crc_init \
	-Wl,--export=avcodec_descriptor_get \
	-Wl,--export=avcodec_get_type \
	-Wl,--export=av_codec_is_encoder \
	-Wl,--export=av_dovi_alloc \
	-Wl,--export=avpriv_pix_fmt_find \
	-Wl,--export=avformat_write_header \
	-Wl,--export=av_write_frame \
	-Wl,--export=av_write_trailer \
	-Wl,--export=avformat_alloc_output_context2 \
	-Wl,--export=avio_seek_time \
	-Wl,--export=avio_wl24 \
	-Wl,--export=av_frame_get_side_data \
	-Wl,--export=ff_decode_frame_props \
	-Wl,--export=ff_copy_whiteblacklists \
	-Wl,--export=ff_add_cpb_side_data \
	-Wl,--export=av_xiphlacing \
	-Wl,--export=ff_ac3_parse_header \
	-Wl,--export=ff_find_stream_index \
	-Wl,--export=ff_fetch_timestamp \
	-Wl,--export=av_timecode_make_mpeg_tc_string \
	-Wl,--export=av_timecode_init \
	-Wl,--export=ff_put_string \
	-Wl,--export=ff_intrax8_common_init \
	-Wl,--export=ff_intrax8_common_end \
	-Wl,--export=ff_intrax8_decode_picture \
	-Wl,--export=ff_init_range_decoder \
	-Wl,--export=ff_id3v2_tag_len \
	-Wl,--export=ff_id3v2_match \
	-Wl,--export=ff_vp3dsp_init \
	-Wl,--export=ff_vp3dsp_set_bounding_values \
	-Wl,--export=avpriv_alloc_fixed_dsp \
	-Wl,--export=avpriv_set_systematic_pal2 \
	-Wl,--export=av_parse_time \
	-Wl,--export=av_strtok \
	-Wl,--export=av_stristr \
	-Wl,--export=av_vbprintf \
	-Wl,--growable-table \
	-Wl,--gc-sections \
	-Wl,--strip-debug \
	-Wl,-z,stack-size=2097152 \
	-Wl,--initial-memory=33554432

FFMPEG_LIBS = \
	$(FFMPEG_SRC)/libavformat/libavformat.a \
	$(FFMPEG_SRC)/libavcodec/libavcodec.a \
	$(FFMPEG_SRC)/libavutil/libavutil.a

WRAPPER_OBJ = build/wrapper.o
EXPORTS_OBJ = build/exports.o
WASM_OBJS = $(WRAPPER_OBJ) $(EXPORTS_OBJ)

.PHONY: all clean setup setup-source check-wasi-sdk check-source

all: check-wasi-sdk check-source $(OUT)

check-wasi-sdk:
	@if [ ! -x "$(CC)" ]; then \
		echo "ERROR: wasi-sdk clang not found at $(CC)"; \
		echo "Run 'make setup' to install wasi-sdk $(WASI_SDK_VERSION)."; \
		exit 1; \
	fi

check-source:
	@if [ ! -d "$(FFMPEG_SRC)" ]; then \
		echo "ERROR: ffmpeg source not found at $(FFMPEG_SRC)/"; \
		echo "Run 'make setup-source' first."; \
		exit 1; \
	fi

setup:
	@case "$$(uname -s)-$$(uname -m)" in \
		Linux-x86_64)  P="x86_64-linux" ;; \
		Linux-aarch64) P="arm64-linux" ;; \
		Darwin-arm64)  P="arm64-macos" ;; \
		Darwin-x86_64) P="x86_64-macos" ;; \
		*) echo "Unsupported platform"; exit 1 ;; \
	esac; \
	URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$(WASI_SDK_VERSION)/wasi-sdk-$(WASI_SDK_VERSION).0-$$P.tar.gz"; \
	echo "Downloading wasi-sdk $(WASI_SDK_VERSION) from $$URL"; \
	rm -rf "$(WASI_SDK)"; \
	mkdir -p "$(WASI_SDK)"; \
	curl -sL "$$URL" | tar xz -C "$(WASI_SDK)" --strip-components=1
	@echo "wasi-sdk $(WASI_SDK_VERSION) installed to $(WASI_SDK)"

setup-source:
	@bash scripts/setup-source.sh

# Configure + build ffmpeg. We follow the Ubuntu/Debian-style
# split: base package ships the universally-needed runtime
# (libav* infrastructure + DSP helpers like blockdsp/vlc/idctdsp
# that nearly every codec calls); per-format codec packages ship
# as extensions that bind into this base at load time.
#
# To get the DSP helpers compiled WITHOUT pulling in any codec,
# we disable codec FAMILIES individually (`--disable-decoders`,
# `--disable-encoders`, etc.) instead of using FFmpeg's
# `--disable-everything` switch (which also kills the helper
# modules). With this set:
#
#   ENABLED  libavutil + libavcodec scaffolding + DSP helpers
#            (blockdsp, vlc, idctdsp, get_bits, etc.) + libavformat
#            scaffolding
#
#   DISABLED individual codecs / demuxers / muxers / parsers /
#            BSFs / protocols / filters / network / programs
#
# Result: extensions can `#include` and call any DSP helper
# from the base WASM rather than carrying duplicates.
$(FFMPEG_SRC)/libavformat/libavformat.a $(FFMPEG_SRC)/libavcodec/libavcodec.a $(FFMPEG_SRC)/libavutil/libavutil.a: | check-source
	@echo "Configuring ffmpeg (base, no codecs)..."
	@cd $(FFMPEG_SRC) && CC=$(CC) ./configure \
		--target-os=none \
		--arch=wasm32 \
		--enable-cross-compile \
		--cross-prefix= \
		--cc=$(CC) \
		--ar=$(AR) \
		--nm=$(NM) \
		--ranlib=$(RANLIB) \
		--strip=$(STRIP) \
		--pkg-config=/usr/bin/false \
		--disable-decoders \
		--disable-encoders \
		--disable-hwaccels \
		--disable-muxers \
		--disable-demuxers \
		--disable-parsers \
		--disable-bsfs \
		--disable-protocols \
		--disable-filters \
		--disable-network \
		--disable-doc \
		--disable-programs \
		--disable-avdevice \
		--disable-postproc \
		--disable-swresample \
		--disable-swscale \
		--disable-avfilter \
		--disable-asm \
		--disable-pthreads \
		--disable-w32threads \
		--disable-os2threads \
		--disable-iconv \
		--disable-debug \
		--disable-stripping \
		--extra-cflags="$(TARGET_FLAGS) -O3" \
		--extra-ldflags="$(TARGET_FLAGS)" \
		> /dev/null
	@# Force HAVE_MKSTEMP=1: wasi-libc hides mkstemp() behind a
	@# macro so ffmpeg's configure probe can't detect it. The actual
	@# symbol stays undefined; LTO / --gc-sections drops the dead
	@# callsite at link time.
	@sed -i.bak 's/#define HAVE_MKSTEMP 0/#define HAVE_MKSTEMP 1/' $(FFMPEG_SRC)/config.h
	@# Enable the "common DSP helpers" that extensions rely on but
	@# that FFmpeg's configure-time auto-enable logic only turns
	@# on when a specific codec requests them. We need them in the
	@# BASE (not in each extension) for deduplication — that's the
	@# whole point of the dpkg-style architecture.
	@bash scripts/enable-helpers.sh $(FFMPEG_SRC)
	@# Apply our patches (mkstemp declaration shim, etc.).
	@bash scripts/apply-patches.sh $(FFMPEG_SRC)
	@echo "Building ffmpeg ..."
	@$(MAKE) -C $(FFMPEG_SRC) -j$$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu || echo 4)

build:
	@mkdir -p build

$(WRAPPER_OBJ): c/wrapper.c $(FFMPEG_LIBS) | build
	@mkdir -p $(dir $@)
	$(CC) $(WRAPPER_CFLAGS) -c -o $@ $<

$(EXPORTS_OBJ): c/exports.c $(FFMPEG_LIBS) | build
	@mkdir -p $(dir $@)
	$(CC) $(WRAPPER_CFLAGS) -c -o $@ $<

$(OUT): $(WASM_OBJS) $(FFMPEG_LIBS)
	@mkdir -p $(dir $@)
	$(CC) $(LDFLAGS) -o $@ $(WASM_OBJS) $(FFMPEG_LIBS)
	@echo "Built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

clean:
	rm -rf build $(OUT)
