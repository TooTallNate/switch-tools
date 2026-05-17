# @tootallnate/bink1-wasm — build a slim ffmpeg (Bink 1 decoder +
# Bink audio decoders + Bink demuxer only) as a WASM module.
#
# This Makefile expects:
#   1. wasi-sdk installed at /tmp/wasi-sdk  (run `make setup` once).
#   2. ffmpeg source cloned + patched into build/ffmpeg/
#      (run `make setup-source`).
#
# Output: src/bink1.wasm — a freestanding `wasm32-wasip1` module
# exporting `bink1_open`, `bink1_close`, `bink1_decode_next_frame`,
# and the suite of header/plane accessors used by the TS wrapper.
#
# Unlike @tootallnate/bink2-wasm (which inherits GPL-3 from
# cnc-ra-libs), ffmpeg is LGPL-2.1+ — the compiled `bink1.wasm` is
# free to redistribute, so we ship it inside the package.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC      = $(WASI_SDK)/bin/clang
AR      = $(WASI_SDK)/bin/llvm-ar
NM      = $(WASI_SDK)/bin/llvm-nm
RANLIB  = $(WASI_SDK)/bin/llvm-ranlib
STRIP   = $(WASI_SDK)/bin/llvm-strip

SYSROOT  = $(WASI_SDK)/share/wasi-sysroot
FFMPEG_SRC = build/ffmpeg

OUT = src/bink1.wasm

# Common target / sysroot flags for both compile and link.
TARGET_FLAGS = --target=wasm32-wasip1 --sysroot=$(SYSROOT)

# C flags for compiling the wrapper. We include ffmpeg's source root
# so the wrapper can `#include "libavcodec/avcodec.h"` etc.
WRAPPER_CFLAGS = \
	$(TARGET_FLAGS) \
	-fvisibility=hidden \
	-O3 \
	-flto \
	-I$(FFMPEG_SRC) \
	-Wall

# Link flags. -mexec-model=reactor produces a WASI module that
# initialises once (via the special `_initialize` export) and stays
# resident for repeated function calls — exactly the shape our TS
# wrapper drives. `--allow-undefined` lets wasi-libc symbols we don't
# end up calling (mkstemp etc.) remain undefined and be erased by GC.
LDFLAGS = \
	$(TARGET_FLAGS) \
	-mexec-model=reactor \
	-O3 \
	-flto \
	-Wl,--export-dynamic \
	-Wl,--allow-undefined \
	-Wl,--gc-sections \
	-Wl,--lto-O3 \
	-Wl,--strip-debug \
	-Wl,-z,stack-size=2097152 \
	-Wl,--initial-memory=33554432

FFMPEG_LIBS = \
	$(FFMPEG_SRC)/libavformat/libavformat.a \
	$(FFMPEG_SRC)/libavcodec/libavcodec.a \
	$(FFMPEG_SRC)/libavutil/libavutil.a

WRAPPER_OBJ = build/wrapper.o

.PHONY: all clean setup setup-source check-wasi-sdk check-source ffmpeg

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

# Configure + build ffmpeg, slim to just Bink. This is idempotent;
# running `make` again after a fresh `setup-source` will reconfigure
# and rebuild from scratch (~30 s).
$(FFMPEG_SRC)/libavformat/libavformat.a $(FFMPEG_SRC)/libavcodec/libavcodec.a $(FFMPEG_SRC)/libavutil/libavutil.a: | check-source
	@echo "Configuring ffmpeg ..."
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
		--disable-everything \
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
		--disable-protocols \
		--enable-decoder=bink,binkaudio_dct,binkaudio_rdft \
		--enable-demuxer=bink \
		--extra-cflags="$(TARGET_FLAGS) -O3" \
		--extra-ldflags="$(TARGET_FLAGS)" \
		> /dev/null
	@# Force HAVE_MKSTEMP=1: wasi-libc declares mkstemp() behind a
	@# __wasilibc_unmodified_upstream macro so ffmpeg's configure
	@# probe can't detect it. The actual symbol stays undefined; LTO
	@# / --gc-sections drops the dead callsite at link time.
	@sed -i.bak 's/#define HAVE_MKSTEMP 0/#define HAVE_MKSTEMP 1/' $(FFMPEG_SRC)/config.h
	@echo "Building ffmpeg ..."
	@$(MAKE) -C $(FFMPEG_SRC) -j$$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu || echo 4)

build:
	@mkdir -p build

$(WRAPPER_OBJ): c/wrapper.c $(FFMPEG_LIBS) | build
	@mkdir -p $(dir $@)
	$(CC) $(WRAPPER_CFLAGS) -c -o $@ $<

$(OUT): $(WRAPPER_OBJ) $(FFMPEG_LIBS)
	@mkdir -p $(dir $@)
	$(CC) $(LDFLAGS) -o $@ $(WRAPPER_OBJ) $(FFMPEG_LIBS)
	@echo "Built $(OUT) ($$(wc -c < $(OUT) | tr -d ' ') bytes)"

clean:
	rm -rf build $(OUT)
