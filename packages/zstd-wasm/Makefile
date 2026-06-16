# @tootallnate/zstd-wasm — build streaming zstd (de)compressor as WASM.
#
# The single-file zstd library (encoder + decoder) is compiled with
# wasi-sdk's clang into a freestanding `wasm32-unknown-unknown` module.
# We do NOT use WASI: zstd doesn't need a libc beyond malloc / memcpy /
# memset (pulled in from the wasi-sysroot libc objects + clang
# builtins) and is otherwise pure computation. This keeps the resulting
# WASM portable across browser + Node.
#
# NOTE: this is the FULL library build (compress + decompress). The
# vendored `c/zstd.c` is the single-file amalgamation generated from
# upstream zstd 1.5.7 via build/single_file_libs/combine.py (with
# multithreading disabled and error strings stripped).
#
# Run `make setup` once to download wasi-sdk to /tmp/wasi-sdk.

WASI_SDK_VERSION ?= 32
WASI_SDK ?= /tmp/wasi-sdk
CC = $(WASI_SDK)/bin/clang
WASM_LD = $(WASI_SDK)/bin/wasm-ld

# Use freestanding wasm32 (no WASI imports). We provide our own tiny
# memcpy / memset via clang builtins. zstd uses __builtin_* functions
# for the rest, which compile to pure WASM ops.
SYSROOT = $(WASI_SDK)/share/wasi-sysroot

# We compile against wasi-sysroot for headers (string.h, stdint.h, etc.)
# and link against the wasm32-wasip1 libc objects (malloc, memcpy,
# memset, etc.). zstd doesn't actually call any WASI imports — only the
# freestanding bits of libc — so the resulting module has no
# `wasi_snapshot_preview1` imports and runs in plain
# WebAssembly.Module instantiation.
CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fvisibility=hidden \
	-O3 \
	-flto \
	-DZSTDLIB_VISIBLE= \
	-DZSTDERRORLIB_VISIBLE= \
	-Wno-implicit-function-declaration \
	-Wno-int-conversion \
	-Ic

LDFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-nostartfiles \
	-Wl,--no-entry \
	-Wl,--export-dynamic \
	-Wl,--allow-undefined \
	-Wl,--lto-O3 \
	-Wl,-z,stack-size=1048576 \
	-Wl,--initial-memory=8388608

OBJS = build/zstd.o build/wrapper.o
# The WASM is checked in at `src/zstd.wasm` so consumers using
# `new URL('./zstd.wasm', import.meta.url)` resolve correctly during
# development (against `src/`). It's also copied to `dist/` during
# `tsc` so the published package's consumers find it next to the
# compiled JS.
OUT = src/zstd.wasm

.PHONY: all clean setup check-wasi-sdk

all: check-wasi-sdk $(OUT)

check-wasi-sdk:
	@if [ ! -x "$(CC)" ]; then \
		echo "ERROR: wasi-sdk clang not found at $(CC)"; \
		echo "Run 'make setup' to install wasi-sdk $(WASI_SDK_VERSION)."; \
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
	rm -rf "$(WASI_SDK)"; \
	mkdir -p "$(WASI_SDK)"; \
	curl -sL "$$URL" | tar xz -C "$(WASI_SDK)" --strip-components=1
	@echo "wasi-sdk $(WASI_SDK_VERSION) installed to $(WASI_SDK)"

build:
	@mkdir -p build

build/zstd.o: c/zstd.c | build
	$(CC) $(CFLAGS) -c -o $@ $<

build/wrapper.o: c/wrapper.c c/zstd.h | build
	$(CC) $(CFLAGS) -c -o $@ $<

$(OUT): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS)

clean:
	rm -rf build $(OUT)
