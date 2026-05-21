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
