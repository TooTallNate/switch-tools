# @tootallnate/ffmpeg-bink-video-wasm — Bink 1 video decoder
# extension for @tootallnate/ffmpeg-wasm.
#
# Builds the FFmpeg Bink 1 video decoder (libavcodec/bink.c, plus
# bink-specific DSP helpers binkdsp.c) as a wasm32-wasip1 shared
# library. License: LGPL-2.1+ (FFmpeg-derivative).
#
# Pair with `@tootallnate/ffmpeg-bink-demuxer-wasm` for the
# container and optionally `@tootallnate/ffmpeg-bink-audio-wasm`
# for audio tracks.
#
# binkdsp lives in this extension (not the base) because no other
# codec uses it. blockdsp + hpeldsp dependencies come from the
# base (shared with future codecs).

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC      = $(WASI_SDK)/bin/clang
WASM_LD = $(WASI_SDK)/bin/wasm-ld

SYSROOT = $(WASI_SDK)/share/wasi-sysroot

FFMPEG_BASE = ../ffmpeg-wasm/build/ffmpeg
SHARED_INC  = ../ffmpeg-wasm/c

OUT = src/bink-video.so

OBJS = build/bink.o build/binkdsp.o build/init.o

# libavcodec sources put `-I libavcodec` first so `#include "internal.h"`
# resolves to libavcodec/internal.h.
BASE_CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC \
	-fvisibility=hidden \
	-O2 \
	-I$(FFMPEG_BASE) \
	-I$(FFMPEG_BASE)/libavcodec \
	-I$(SHARED_INC) \
	-Ic/bink \
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

build/bink.o: c/bink/bink.c c/bink/binkdsp.h c/bink/binkdata.h | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

build/binkdsp.o: c/bink/binkdsp.c c/bink/binkdsp.h | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

build/init.o: c/init.c | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

$(OUT): $(OBJS)
	@mkdir -p $(dir $@)
	$(WASM_LD) $(LDFLAGS) -o $@ $(OBJS)
	@echo "Built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

clean:
	rm -rf build $(OUT)
