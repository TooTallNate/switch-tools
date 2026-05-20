# @tootallnate/ffmpeg-bink-demuxer-wasm — Bink container demuxer
# extension for @tootallnate/ffmpeg-wasm.
#
# Builds the FFmpeg Bink demuxer (libavformat/bink.c, with manual
# patches for Switch's KB2n revision) as a wasm32-wasip1 shared
# library. License: LGPL-2.1+ (FFmpeg-derivative).
#
# This is the SHARED demuxer for all Bink container variants. Pair
# with one or more of:
#
#   - @tootallnate/ffmpeg-bink-video-wasm   (Bink 1 video, KB2 'b'..'k')
#   - @tootallnate/ffmpeg-bink2-video-wasm  (Bink 2 video, KB2 'f'..'n')
#   - @tootallnate/ffmpeg-bink-audio-wasm   (Bink audio RDFT + DCT)
#
# Headers come from `../ffmpeg-wasm/build/ffmpeg/`. We don't ship
# our own copy of the FFmpeg sources; just the one patched bink.c.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC      = $(WASI_SDK)/bin/clang
WASM_LD = $(WASI_SDK)/bin/wasm-ld

SYSROOT = $(WASI_SDK)/share/wasi-sysroot

FFMPEG_BASE = ../ffmpeg-wasm/build/ffmpeg
SHARED_INC  = ../ffmpeg-wasm/c

OUT = src/bink-demuxer.so

OBJS = build/bink.o build/init.o

# libavformat source needs `-I libavformat` first so file-local
# `#include "internal.h"` resolves correctly. Also force-include
# `libavutil/internal.h` for `NULL_IF_CONFIG_SMALL` which the
# format-side internal.h doesn't transitively include.
BASE_CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC \
	-fvisibility=hidden \
	-O2 \
	-I$(FFMPEG_BASE) \
	-I$(FFMPEG_BASE)/libavformat \
	-I$(SHARED_INC) \
	-include libavutil/internal.h \
	-include ext_codec_ids.h \
	-Wno-implicit-fallthrough \
	-Wno-deprecated-declarations \
	-Wno-incompatible-pointer-types \
	-Wno-unused-but-set-variable \
	-Wno-unused-variable \
	-Wno-unused-function

LDFLAGS = \
	--shared \
	--no-entry \
	--export-dynamic \
	--allow-undefined \
	--gc-sections

.PHONY: all clean check-base

all: check-base $(OUT)

check-base:
	@if [ ! -d "$(FFMPEG_BASE)" ]; then \
		echo "ERROR: base FFmpeg checkout not found at $(FFMPEG_BASE)"; \
		echo "Run 'make setup-source' in ../ffmpeg-wasm first."; \
		exit 1; \
	fi

build:
	@mkdir -p build

build/bink.o: c/bink-demuxer/bink.c | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

build/init.o: c/init.c | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

$(OUT): $(OBJS)
	@mkdir -p $(dir $@)
	$(WASM_LD) $(LDFLAGS) -o $@ $(OBJS)
	@echo "Built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

clean:
	rm -rf build $(OUT)
