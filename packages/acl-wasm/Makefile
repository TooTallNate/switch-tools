# @tootallnate/acl-wasm — build ACL's transform-track decompressor as WASM.
#
#   make setup          download wasi-sdk to /tmp/wasi-sdk (see oodle-wasm)
#   make setup-source   fetch ACL and RTM (MIT) into c/
#   make                build src/acl.wasm
#
# The output is a freestanding module (no imports) exporting
# acl_malloc, acl_free, acl_decompress and acl_result_size.

WASI_SDK ?= /tmp/wasi-sdk
ACL_VERSION ?= 2.0.6
RTM_VERSION ?= 2.1.5
CXX = $(WASI_SDK)/bin/clang++

src/acl.wasm: c/wrapper.cpp c/acl-src c/rtm-src
	$(CXX) --target=wasm32-wasip1 --sysroot=$(WASI_SDK)/share/wasi-sysroot \
		-O2 -std=c++17 -fno-exceptions -fno-rtti \
		-Wno-missing-template-arg-list-after-template-kw \
		-DRTM_NO_INTRINSICS -DACL_NO_INTRINSICS \
		-Ic/acl-src/includes -Ic/rtm-src/includes \
		-nostartfiles -Wl,--no-entry -Wl,--strip-all \
		-o $@ c/wrapper.cpp

setup-source: c/acl-src c/rtm-src

c/acl-src:
	mkdir -p $@ && curl -sL https://github.com/nfrechette/acl/archive/refs/tags/v$(ACL_VERSION).tar.gz | tar xz -C $@ --strip-components=1

c/rtm-src:
	mkdir -p $@ && curl -sL https://github.com/nfrechette/rtm/archive/refs/tags/v$(RTM_VERSION).tar.gz | tar xz -C $@ --strip-components=1

setup:
	$(MAKE) -C ../oodle-wasm setup WASI_SDK=$(WASI_SDK)

.PHONY: setup setup-source
