# @tootallnate/bink2-wasm — build the Bink 2 video decoder as a WASM module.
#
# This Makefile expects:
#   1. wasi-sdk installed at /tmp/wasi-sdk  (run `make setup` once).
#   2. cnc-ra-libs cloned to c/cnc-ra-libs/ (run `make setup-source`).
#
# Output: src/bink2.wasm — a freestanding `wasm32-wasip1` module
# exporting `bink2_open`, `bink2_close`, `bink2_decode_frame`, and
# the suite of header/plane accessors used by the TS wrapper.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC = $(WASI_SDK)/bin/clang
CXX = $(WASI_SDK)/bin/clang++

SRC_DIR = c/cnc-ra-libs
BINK_SRC_DIR = $(SRC_DIR)/bink2

SYSROOT = $(WASI_SDK)/share/wasi-sysroot

# Common flags for C++ compilation. `wasm32-wasip1` gives us the
# wasi-libc headers (the decoder uses <vector>, <memory>, <cstring>,
# etc.) but the resulting WASM imports only a small handful of WASI
# symbols transitively from libc that the decode path never invokes.
# The TS wrapper stubs them out at instantiate time.
COMMON_FLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fvisibility=hidden \
	-O3 \
	-flto \
	-I$(BINK_SRC_DIR) \
	-Ic

# wasi-sdk's clang++ doesn't auto-add the libc++ include path for
# `--target=wasm32-wasip1`; we point it explicitly so <cstddef>,
# <vector>, <memory>, etc. resolve to wasi-sdk's libc++.
CXX_HEADERS = $(SYSROOT)/include/wasm32-wasip1/c++/v1

# C++17 matches what cnc-ra-libs targets. Disabled exceptions + RTTI
# to shrink the output; the decoder doesn't use either.
CXXFLAGS = $(COMMON_FLAGS) -std=gnu++17 -fno-exceptions -fno-rtti -isystem $(CXX_HEADERS)

LDFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-mexec-model=reactor \
	-Wl,--export-dynamic \
	-Wl,--allow-undefined \
	-Wl,--lto-O3 \
	-Wl,--strip-debug \
	-Wl,-z,stack-size=2097152 \
	-Wl,--initial-memory=16777216

# All .cpp files from cnc-ra-libs/bink2 plus our wrapper.
BINK_SRC := $(wildcard $(BINK_SRC_DIR)/*.cpp)
BINK_OBJS := $(patsubst $(BINK_SRC_DIR)/%.cpp,build/bink2/%.o,$(BINK_SRC))
WRAPPER_OBJ = build/wrapper.o

OUT = src/bink2.wasm

.PHONY: all clean setup setup-source check-wasi-sdk check-source

all: check-wasi-sdk check-source $(OUT)

check-wasi-sdk:
	@if [ ! -x "$(CC)" ]; then \
		echo "ERROR: wasi-sdk clang not found at $(CC)"; \
		echo "Run 'make setup' to install wasi-sdk $(WASI_SDK_VERSION)."; \
		exit 1; \
	fi

check-source:
	@if [ ! -d "$(BINK_SRC_DIR)" ]; then \
		echo "ERROR: cnc-ra-libs source not found at $(BINK_SRC_DIR)/"; \
		echo "Run 'make setup-source' (or 'pnpm setup-source') first."; \
		echo "See README.md for details on the GPL-3.0 license."; \
		exit 1; \
	fi
	@if [ -z "$(BINK_SRC)" ]; then \
		echo "ERROR: No .cpp files matched under $(BINK_SRC_DIR)/"; \
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

build:
	@mkdir -p build/bink2

$(WRAPPER_OBJ): c/wrapper.cpp | build check-source
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

build/bink2/%.o: $(BINK_SRC_DIR)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

$(OUT): $(WRAPPER_OBJ) $(BINK_OBJS)
	@mkdir -p $(dir $@)
	$(CXX) $(LDFLAGS) -o $@ $^

clean:
	rm -rf build $(OUT)
