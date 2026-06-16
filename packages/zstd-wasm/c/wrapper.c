/**
 * Thin wrapper exposing zstd's streaming compression + decompression
 * APIs to JS.
 *
 * The single-file `zstd.c` implements the full zstd encoder and
 * decoder. We expose just the symbols our TypeScript wrapper needs:
 *
 *   Decompression:
 *   - dctx_new / dctx_free            — allocate / release a streaming context
 *   - decompress_stream(...)          — feed input, produce output
 *
 *   Compression:
 *   - cctx_new / cctx_free            — allocate / release a streaming context
 *   - cctx_set_level(...)             — set the compression level
 *   - compress_stream(...)            — feed input, produce output (with endOp)
 *
 *   Shared:
 *   - is_error / get_error_name       — error handling
 *   - zstd_malloc / zstd_free         — allocate shared I/O buffers
 *   - {c,d}stream_{in,out}_size       — recommended buffer sizes
 *
 * Both directions use the same small "in/out cursor" struct so we can
 * pass everything through a single WASM function call.
 *
 * Memory layout (all u32 little-endian, packed):
 *
 *     struct ZstdInOutBuf {
 *         uint32_t src;     // pointer to input buffer in WASM linear memory
 *         uint32_t srcSize; // size of the input buffer
 *         uint32_t srcPos;  // bytes consumed (out)
 *         uint32_t dst;     // pointer to output buffer
 *         uint32_t dstSize; // size of the output buffer
 *         uint32_t dstPos;  // bytes written (out)
 *     };
 *
 * `decompress_stream` returns the suggested next-input size as a
 * size_t. A return of 0 means "frame fully decoded". Any value with
 * `is_error(ret) != 0` is a zstd error code.
 *
 * `compress_stream` takes an additional `endOp` argument matching
 * `ZSTD_EndDirective` (0 = continue, 1 = flush, 2 = end). It returns a
 * hint: for `ZSTD_e_end`/`ZSTD_e_flush` a return of 0 means all
 * internal buffers have been flushed; non-zero means "call again with
 * more output space". Any value with `is_error(ret) != 0` is an error.
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

/* ---------------------------------------------------------------- */
/* Decompression                                                    */
/* ---------------------------------------------------------------- */

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

EXPORT size_t dstream_in_size(void) {
	return ZSTD_DStreamInSize();
}

EXPORT size_t dstream_out_size(void) {
	return ZSTD_DStreamOutSize();
}

/* ---------------------------------------------------------------- */
/* Compression                                                      */
/* ---------------------------------------------------------------- */

EXPORT void *cctx_new(void) {
	return ZSTD_createCCtx();
}

EXPORT void cctx_free(void *cctx) {
	ZSTD_freeCCtx((ZSTD_CCtx *)cctx);
}

/*
 * Set the compression level on a context. Returns a zstd return code
 * (test with `is_error`). Must be called before the first
 * `compress_stream` call on a fresh / reset context.
 */
EXPORT size_t cctx_set_level(void *cctx, int level) {
	return ZSTD_CCtx_setParameter((ZSTD_CCtx *)cctx, ZSTD_c_compressionLevel, level);
}

/*
 * Drive the streaming compressor. `endOp` is a `ZSTD_EndDirective`:
 *   0 = ZSTD_e_continue, 1 = ZSTD_e_flush, 2 = ZSTD_e_end.
 *
 * Returns zstd's flush hint (0 = fully flushed for flush/end ops).
 */
EXPORT size_t compress_stream(void *cctx, JsBuf *buf, int endOp) {
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
	size_t ret = ZSTD_compressStream2(
		(ZSTD_CCtx *)cctx, &out, &in, (ZSTD_EndDirective)endOp);
	buf->srcPos = (uint32_t)in.pos;
	buf->dstPos = (uint32_t)out.pos;
	return ret;
}

EXPORT size_t cstream_in_size(void) {
	return ZSTD_CStreamInSize();
}

EXPORT size_t cstream_out_size(void) {
	return ZSTD_CStreamOutSize();
}

/* ---------------------------------------------------------------- */
/* Shared error handling                                            */
/* ---------------------------------------------------------------- */

EXPORT unsigned is_error(size_t code) {
	return ZSTD_isError(code);
}

EXPORT const char *get_error_name(size_t code) {
	return ZSTD_getErrorName(code);
}
