# @tootallnate/ffmpeg-bink2-video-wasm — Bink 2 video decoder
# extension for @tootallnate/ffmpeg-wasm.
#
# Builds Paul B Mahol's Bink 2 decoder (KB2f...KB2n) as a
# wasm32-wasip1 shared library. License: LGPL-2.1+
# (FFmpeg-derivative).
#
# Pair with `@tootallnate/ffmpeg-bink-demuxer-wasm` for the .bk2
# container and optionally `@tootallnate/ffmpeg-bink-audio-wasm`
# for audio tracks.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC      = $(WASI_SDK)/bin/clang
WASM_LD = $(WASI_SDK)/bin/wasm-ld

SYSROOT = $(WASI_SDK)/share/wasi-sysroot

FFMPEG_BASE = ../ffmpeg-wasm/build/ffmpeg
SHARED_INC  = ../ffmpeg-wasm/c

OUT = src/bink2-video.so

OBJS = build/bink2.o build/init.o

# libavcodec sources put `-I libavcodec` first so `#include "internal.h"`
# resolves to libavcodec/internal.h. `-include ext_codec_ids.h`
# pulls in the synthetic AV_CODEC_ID_BINKVIDEO2 constant.
BASE_CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC \
	-fvisibility=hidden \
	-O2 \
	-I$(FFMPEG_BASE) \
	-I$(FFMPEG_BASE)/libavcodec \
	-I$(SHARED_INC) \
	-Ic/bink2 \
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

build/bink2.o: c/bink2/bink2.c c/bink2/bink2.h c/bink2/bink2f.h c/bink2/bink2g.h | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

build/init.o: c/init.c | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

$(OUT): $(OBJS)
	@mkdir -p $(dir $@)
	$(WASM_LD) $(LDFLAGS) -o $@ $(OBJS)
	@echo "Built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

clean:
	rm -rf build $(OUT)
