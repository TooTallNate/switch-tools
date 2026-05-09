/**
 * Thin wrapper exposing Brotli's streaming-decompression API to JS.
 *
 * Mirrors the design of `@tootallnate/zstd-wasm`'s wrapper: we expose
 * the minimum subset our TypeScript bindings need and pass everything
 * through a single struct so each WASM call only takes one argument.
 *
 *   - dctx_new / dctx_free            — allocate / release a streaming context
 *   - decompress_stream(...)          — feed input, produce output
 *   - is_error / get_error_name       — error handling
 *
 * Memory layout of the I/O buffer struct (all u32 little-endian):
 *
 *     struct BrotliInOutBuf {
 *         uint32_t src;     // pointer to input buffer in WASM linear memory
 *         uint32_t srcSize; // size of the input buffer
 *         uint32_t srcPos;  // bytes consumed by the decoder (in/out)
 *         uint32_t dst;     // pointer to output buffer
 *         uint32_t dstSize; // size of the output buffer
 *         uint32_t dstPos;  // bytes written by the decoder (in/out)
 *     };
 *
 * `decompress_stream` returns a `BrotliDecoderResult`:
 *
 *     0  ERROR              — decoding error; call get_error_name
 *     1  SUCCESS            — frame fully decoded
 *     2  NEEDS_MORE_INPUT   — call again with more bytes appended
 *     3  NEEDS_MORE_OUTPUT  — call again with `dstPos` reset to 0
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <brotli/decode.h>

#define EXPORT __attribute__((visibility("default")))

/*
 * Re-export malloc / free so the JS wrapper can allocate the
 * I/O buffers it shares with the WASM instance. Without this,
 * `-fvisibility=hidden` keeps libc symbols internal.
 */
EXPORT void *brotli_malloc(size_t n) { return malloc(n); }
EXPORT void brotli_free(void *p)     { free(p); }

typedef struct {
	uint32_t src;
	uint32_t srcSize;
	uint32_t srcPos;
	uint32_t dst;
	uint32_t dstSize;
	uint32_t dstPos;
} JsBuf;

EXPORT void *dctx_new(void) {
	return BrotliDecoderCreateInstance(NULL, NULL, NULL);
}

EXPORT void dctx_free(void *dctx) {
	BrotliDecoderDestroyInstance((BrotliDecoderState *)dctx);
}

/**
 * Returns one of the four `BrotliDecoderResult` enum values.
 * On `ERROR` (0) the caller should fetch the textual code via
 * `BrotliDecoderGetErrorCode` + `BrotliDecoderErrorString`.
 */
EXPORT int decompress_stream(void *dctx, JsBuf *buf) {
	const uint8_t *next_in = (const uint8_t *)(uintptr_t)(buf->src + buf->srcPos);
	uint8_t *next_out = (uint8_t *)(uintptr_t)(buf->dst + buf->dstPos);
	size_t avail_in = buf->srcSize - buf->srcPos;
	size_t avail_out = buf->dstSize - buf->dstPos;

	BrotliDecoderResult ret = BrotliDecoderDecompressStream(
		(BrotliDecoderState *)dctx,
		&avail_in, &next_in,
		&avail_out, &next_out,
		NULL /* total_out — we don't need the running total */
	);

	/* Recompute positions from the now-advanced cursors. */
	buf->srcPos = buf->srcSize - (uint32_t)avail_in;
	buf->dstPos = buf->dstSize - (uint32_t)avail_out;
	return (int)ret;
}

EXPORT int is_finished(void *dctx) {
	return BrotliDecoderIsFinished((BrotliDecoderState *)dctx) ? 1 : 0;
}

EXPORT int get_error_code(void *dctx) {
	return (int)BrotliDecoderGetErrorCode((BrotliDecoderState *)dctx);
}

EXPORT const char *get_error_name(int code) {
	return BrotliDecoderErrorString((BrotliDecoderErrorCode)code);
}
