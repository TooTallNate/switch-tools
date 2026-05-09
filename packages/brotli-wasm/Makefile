# @tootallnate/brotli-wasm — build streaming Brotli decoder as WASM.
#
# The official Brotli C reference decoder is split across `c/dec/`
# and `c/common/`. We compile every required source file with
# wasi-sdk's clang and link them into a single freestanding
# `wasm32-unknown-unknown` module, the same approach as
# `@tootallnate/zstd-wasm`.
#
# Run `make setup` once to download wasi-sdk to /tmp/wasi-sdk
# (shared across this and the zstd-wasm build).

WASI_SDK_VERSION ?= 32
WASI_SDK ?= /tmp/wasi-sdk
CC = $(WASI_SDK)/bin/clang
WASM_LD = $(WASI_SDK)/bin/wasm-ld
SYSROOT = $(WASI_SDK)/share/wasi-sysroot

# We compile against wasi-sysroot for headers (string.h, stdint.h,
# malloc / free) and link against the wasm32-wasip1 libc objects.
# The decoder doesn't actually call any WASI imports — only the
# freestanding bits of libc — so the resulting module has no
# `wasi_snapshot_preview1` imports.
CFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fvisibility=hidden \
	-O3 \
	-flto \
	-DBROTLI_SHARED_COMPILATION= \
	-DBROTLICOMMON_SHARED_COMPILATION= \
	-DBROTLIDEC_SHARED_COMPILATION= \
	-Wno-implicit-function-declaration \
	-Wno-int-conversion \
	-Ic/include \
	-Ic/common \
	-Ic/dec

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

# All Brotli decoder source files. Order doesn't matter for the
# linker; we list `dec/` first then `common/` for readability.
DEC_SRCS = \
	c/dec/bit_reader.c \
	c/dec/decode.c \
	c/dec/huffman.c \
	c/dec/prefix.c \
	c/dec/state.c \
	c/dec/static_init.c

COMMON_SRCS = \
	c/common/constants.c \
	c/common/context.c \
	c/common/dictionary.c \
	c/common/platform.c \
	c/common/shared_dictionary.c \
	c/common/transform.c

SRCS = $(DEC_SRCS) $(COMMON_SRCS) c/wrapper.c

# Map each `c/foo/bar.c` to `build/foo/bar.o`.
OBJS = $(SRCS:c/%.c=build/%.o)

OUT = src/brotli.wasm

.PHONY: all clean setup check-wasi-sdk

all: check-wasi-sdk $(OUT)

check-wasi-sdk:
	@if [ ! -x "$(CC)" ]; then \
		echo "ERROR: wasi-sdk clang not found at $(CC)"; \
		echo "Run 'make setup' (or share with sibling zstd-wasm package)."; \
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

# Generic rule: each .o file lives at build/<same-relative-path>.o.
# The `mkdir -p` makes sure the build/dec/, build/common/ subtrees
# exist before clang tries to write into them.
build/%.o: c/%.c
	@mkdir -p "$$(dirname "$@")"
	$(CC) $(CFLAGS) -c -o $@ $<

$(OUT): $(OBJS)
	@mkdir -p "$$(dirname "$(OUT)")"
	$(CC) $(LDFLAGS) -o $@ $(OBJS)

clean:
	rm -rf build $(OUT)
