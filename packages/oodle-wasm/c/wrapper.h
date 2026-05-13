/**
 * Public ABI for the @tootallnate/oodle-wasm JS wrapper.
 *
 * This header is MIT-licensed (part of this repo) and exists only to
 * document what `c/wrapper.c` exports. The actual Oodle API itself
 * lives in `c/oodle-src/oodle2/include/oodle2.h` which is fetched
 * separately via `make setup-source` — see this package's README.
 */

#ifndef OODLE_WASM_WRAPPER_H
#define OODLE_WASM_WRAPPER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialise the Oodle plugins (allocator / printf / assert) so the
 * decoder doesn't try to call host platform APIs that don't exist in
 * the WASM sandbox. Call once after `WebAssembly.instantiate` — the
 * JS wrapper does this automatically.
 *
 * Returns 0 on success.
 */
int oodle_init(void);

/**
 * Allocate `n` bytes inside the WASM linear memory and return a
 * pointer (offset into `memory`). The JS wrapper uses this to stage
 * its input/output buffers before calling `oodle_decompress`.
 */
void *oodle_malloc(size_t n);

/** Free a pointer previously returned by `oodle_malloc`. */
void oodle_free(void *p);

/**
 * Decompress `compressedSize` bytes at `compressed` into `decompressed`,
 * which must point to a buffer of at least `expectedRawSize` bytes.
 *
 * Returns the number of bytes actually decompressed, or 0 on failure.
 * (This matches Oodle's own `OodleLZ_Decompress` return convention.)
 *
 * Behaviour:
 *   - Always uses `OodleLZ_FuzzSafe_Yes` — corrupt input cannot
 *     overrun the output buffer.
 *   - Disables CRC checking (`OodleLZ_CheckCRC_No`).
 *   - Verbosity off.
 *   - No callback / threading / preconditioning.
 *
 * Use cases like UE PAK entries always know `expectedRawSize` from
 * the archive's index, so this minimal surface is enough.
 */
size_t oodle_decompress(
	const void *compressed, size_t compressedSize,
	void *decompressed, size_t expectedRawSize);

#ifdef __cplusplus
}
#endif

#endif /* OODLE_WASM_WRAPPER_H */
