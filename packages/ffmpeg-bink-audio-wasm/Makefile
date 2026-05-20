# @tootallnate/ffmpeg-bink-audio-wasm — Bink audio decoder
# extension for @tootallnate/ffmpeg-wasm.
#
# Ships BOTH binkaudio variants (RDFT and DCT) since .bk1/.bk2
# files can mix them across tracks. The wrapper picks the right
# decoder per-track based on `codec_id`.
#
# Pair with `@tootallnate/ffmpeg-bink-demuxer-wasm` for the
# container.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC      = $(WASI_SDK)/bin/clang
WASM_LD = $(WASI_SDK)/bin/wasm-ld

SYSROOT = $(WASI_SDK)/share/wasi-sysroot

FFMPEG_BASE = ../ffmpeg-wasm/build/ffmpeg
SHARED_INC  = ../ffmpeg-wasm/c

OUT = src/bink-audio.so

OBJS = build/binkaudio.o build/init.o

BASE_CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fPIC \
	-fvisibility=hidden \
	-O2 \
	-I$(FFMPEG_BASE) \
	-I$(FFMPEG_BASE)/libavcodec \
	-I$(SHARED_INC) \
	-include libavutil/internal.h \
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

build/binkaudio.o: c/binkaudio/binkaudio.c | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

build/init.o: c/init.c | build check-base
	$(CC) $(BASE_CFLAGS) -c -o $@ $<

$(OUT): $(OBJS)
	@mkdir -p $(dir $@)
	$(WASM_LD) $(LDFLAGS) -o $@ $(OBJS)
	@echo "Built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

clean:
	rm -rf build $(OUT)
