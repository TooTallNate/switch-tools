/**
 * Thin wrapper exposing zstd's streaming-decompression API to JS.
 *
 * The single-file `zstddeclib.c` already implements the full zstd
 * decoder. We expose just the symbols our TypeScript wrapper needs:
 *
 *   - dctx_new / dctx_free            — allocate / release a streaming context
 *   - decompress_stream(...)          — feed input, produce output
 *   - is_error / get_error_name       — error handling
 *
 * The streaming API uses a small "in/out cursor" struct so we can
 * pass everything through a single WASM function call.
 *
 * Memory layout (all u32 little-endian, packed):
 *
 *     struct ZstdInOutBuf {
 *         uint32_t src;     // pointer to input buffer in WASM linear memory
 *         uint32_t srcSize; // size of the input buffer
 *         uint32_t srcPos;  // bytes consumed by the decoder (out)
 *         uint32_t dst;     // pointer to output buffer
 *         uint32_t dstSize; // size of the output buffer
 *         uint32_t dstPos;  // bytes written by the decoder (out)
 *     };
 *
 * `decompress_stream` returns the suggested next-input size as a
 * size_t. A return of 0 means "frame fully decoded". Any value with
 * `is_error(ret) != 0` is a zstd error code.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include "zstd.h"

#define EXPORT __attribute__((visibility("default")))

/*
 * Re-export malloc / free so the JS wrapper can allocate the
 * I/O buffers it shares with the WASM instance. Without this,
 * `-fvisibility=hidden` keeps libc symbols internal.
 */
EXPORT void *zstd_malloc(size_t n) { return malloc(n); }
EXPORT void zstd_free(void *p)     { free(p); }

typedef struct {
	uint32_t src;
	uint32_t srcSize;
	uint32_t srcPos;
	uint32_t dst;
	uint32_t dstSize;
	uint32_t dstPos;
} JsBuf;

EXPORT void *dctx_new(void) {
	return ZSTD_createDCtx();
}

EXPORT void dctx_free(void *dctx) {
	ZSTD_freeDCtx((ZSTD_DCtx *)dctx);
}

EXPORT size_t decompress_stream(void *dctx, JsBuf *buf) {
	ZSTD_inBuffer in = {
		.src = (const void *)(uintptr_t)buf->src,
		.size = buf->srcSize,
		.pos = buf->srcPos,
	};
	ZSTD_outBuffer out = {
		.dst = (void *)(uintptr_t)buf->dst,
		.size = buf->dstSize,
		.pos = buf->dstPos,
	};
	size_t ret = ZSTD_decompressStream((ZSTD_DCtx *)dctx, &out, &in);
	buf->srcPos = (uint32_t)in.pos;
	buf->dstPos = (uint32_t)out.pos;
	return ret;
}

EXPORT unsigned is_error(size_t code) {
	return ZSTD_isError(code);
}

EXPORT const char *get_error_name(size_t code) {
	return ZSTD_getErrorName(code);
}

EXPORT size_t dstream_in_size(void) {
	return ZSTD_DStreamInSize();
}

EXPORT size_t dstream_out_size(void) {
	return ZSTD_DStreamOutSize();
}
