# @tootallnate/oodle-wasm — build the Oodle Data decoder as a WASM module.
#
# This Makefile expects:
#   1. wasi-sdk installed at /tmp/wasi-sdk  (run `make setup` once).
#   2. RAD's Oodle source fetched to c/oodle-src/  (run `make setup-source`).
#
# Output: src/oodle.wasm — a freestanding `wasm32-unknown-unknown`
# module exporting `oodle_init`, `oodle_malloc`, `oodle_free`,
# `oodle_decompress`. No WASI imports.

WASI_SDK_VERSION ?= 25
WASI_SDK ?= /tmp/wasi-sdk
CC = $(WASI_SDK)/bin/clang
CXX = $(WASI_SDK)/bin/clang++

SRC_DIR = c/oodle-src

SYSROOT = $(WASI_SDK)/share/wasi-sysroot

# Common flags for both C and C++ compilation. We target
# `wasm32-wasip1` for the libc headers (Oodle wants string.h /
# stdint.h / etc.) but the resulting WASM has no WASI imports — we
# don't call any functions that touch the WASI ABI.
COMMON_FLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-fvisibility=hidden \
	-O3 \
	-flto \
	-Ic/oodle-platform-wasi \
	-I$(SRC_DIR)/include \
	-I$(SRC_DIR)/src/oodle2/base \
	-I$(SRC_DIR)/src/oodle2/core \
	-I$(SRC_DIR)/src/oodle2/core/public \
	-Ic

# Flags specific to compiling Oodle's own source files.
#
#  - OODLE_BUILDING_LIB puts the headers into "we are building the
#    implementation" mode (vs. the default "user including the public
#    API"). Compiling wrapper.c, which calls Oodle as a consumer, must
#    NOT see this define.
#  - `__RADEMSCRIPTEN__` is a slight lie about the toolchain but
#    matches the semantic intent: we are a WASM target without
#    prefetch hints, native-int sin/cos, or POSIX console I/O. All
#    of Oodle's `__RADEMSCRIPTEN__` branches are either platform-class
#    selections or "no-op prefetch" fallbacks, none of them include
#    `<emscripten.h>` or rely on Emscripten-specific runtime support.
#    Wiring those branches in saves us from patching upstream files
#    or hand-defining the resulting policy macros one by one.
OODLE_INTERNAL_FLAGS = \
	-DOODLE_BUILDING_LIB \
	-DOO_BUILD_DLL=0 \
	-DOO_BUILDING_OODLECORE=1 \
	-D__RAD_NDA_PLATFORMS__=0 \
	-D__RADEMSCRIPTEN__

# When the wrapper consumes the public oodle2.h header, it acts as
# a library user, so we set OODLE_IMPORT_LIB instead.
WRAPPER_FLAGS = \
	-DOODLE_IMPORT_LIB

CFLAGS   = $(COMMON_FLAGS) $(WRAPPER_FLAGS) -std=gnu11
CXXFLAGS = $(COMMON_FLAGS) $(OODLE_INTERNAL_FLAGS) -std=gnu++14 -fno-exceptions -fno-rtti

LDFLAGS = \
	--target=wasm32-wasip1 \
	--sysroot=$(SYSROOT) \
	-nostartfiles \
	-Wl,--no-entry \
	-Wl,--export-dynamic \
	-Wl,--allow-undefined \
	-Wl,--lto-O3 \
	-Wl,--strip-debug \
	-Wl,-z,stack-size=2097152 \
	-Wl,--initial-memory=16777216

# Discover every .cpp under c/oodle-src/src/oodle2. We exclude
# platform-specific SIMD variants (these are intrinsics or asm-only
# files that won't compile for wasm32). The "generic" / scalar path
# is what we want — Oodle ships scalar fallbacks for every fast path.
OODLE_SRC := $(shell find $(SRC_DIR)/src/oodle2 \
	-name '*.cpp' \
	! -name '*_sse2.cpp' \
	! -name '*_sse4.cpp' \
	! -name '*_ssse3.cpp' \
	! -name '*_avx2.cpp' \
	! -name '*_avx512.cpp' \
	! -name '*_arm_dotprod.cpp' \
	! -name '*_arm64.cpp' \
	! -name '*_neon.cpp' \
	! -name '*_x86.cpp' \
	! -name '*_x64.cpp' \
	2>/dev/null)

OODLE_OBJS = $(patsubst $(SRC_DIR)/src/%.cpp,build/oodle/%.o,$(OODLE_SRC))

OUT = src/oodle.wasm

.PHONY: all clean setup setup-source check-wasi-sdk check-source

all: check-wasi-sdk check-source $(OUT)

check-wasi-sdk:
	@if [ ! -x "$(CC)" ]; then \
		echo "ERROR: wasi-sdk clang not found at $(CC)"; \
		echo "Run 'make setup' to install wasi-sdk $(WASI_SDK_VERSION)."; \
		exit 1; \
	fi

check-source:
	@if [ ! -d "$(SRC_DIR)/include" ] || [ ! -d "$(SRC_DIR)/src" ]; then \
		echo "ERROR: Oodle source not found at $(SRC_DIR)/"; \
		echo "Run 'make setup-source' (or 'pnpm setup-source') first."; \
		echo "See README.md for details on the EULA implications."; \
		exit 1; \
	fi
	@if [ -z "$(OODLE_SRC)" ]; then \
		echo "ERROR: No .cpp files matched under $(SRC_DIR)/src/"; \
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
	@mkdir -p build/oodle

build/wrapper.o: c/wrapper.c c/wrapper.h | build check-source
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c -o $@ $<

build/oodle/%.o: $(SRC_DIR)/src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

$(OUT): build/wrapper.o $(OODLE_OBJS)
	@mkdir -p $(dir $@)
	$(CXX) $(LDFLAGS) -o $@ $^

clean:
	rm -rf build $(OUT)
