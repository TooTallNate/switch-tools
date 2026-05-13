/**
 * MIT-licensed wrapper around RAD's Oodle decompressor for WebAssembly.
 *
 * What this file does:
 *
 *   - Exports `oodle_init`, `oodle_malloc`, `oodle_free`,
 *     `oodle_decompress` to the WASM linker.
 *   - Installs no-op plugins for Oodle's allocator / printf / assert
 *     callbacks, since the WASM target has no host platform to
 *     forward them to (no stderr, no OutputDebugString, etc.).
 *   - Calls `OodleLZ_Decompress` with a stable subset of its
 *     parameters that's sufficient for UE PAK reading.
 *
 * What this file does NOT contain:
 *
 *   - Any of RAD's Oodle source. Their `oodle2.h` is `#include`'d
 *     from `c/oodle-src/oodle2/include/`, which is populated by
 *     `make setup-source` and is gitignored.
 *
 * Build:
 *
 *   The Makefile builds this file together with the .cpp files from
 *   RAD's `c/oodle-src/oodle2/src/` directory. The resulting WASM
 *   exports only the four `oodle_*` symbols here; everything else
 *   stays internal via `-fvisibility=hidden`.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "wrapper.h"

/*
 * Pull in RAD's public header. The path is what `make setup-source`
 * lays out under `c/oodle-src/`. The Makefile adds that as an `-I`
 * directory.
 */
#include "oodle2.h"

#define EXPORT __attribute__((visibility("default")))

/*
 * ---------------------------------------------------------------------
 * Plugin callbacks
 * ---------------------------------------------------------------------
 * Oodle calls out to a small set of host functions: aligned alloc /
 * free, printf, assertion display, and a job system. We provide
 * minimal implementations:
 *
 *   - alloc / free: route through stdlib's malloc, with manual
 *     alignment using overhead bytes (since wasi-sdk's libc doesn't
 *     ship `aligned_alloc` in the freestanding variant we link
 *     against).
 *   - printf / assert: discard everything (no host to log to).
 *   - jobs: handled by the default plugins (synchronous fallback).
 */

static void *plugin_malloc_aligned(OO_SINTa bytes, OO_S32 alignment)
{
	/* Allocate `alignment + sizeof(void*) + bytes` and store the
	 * original pointer just before the aligned address so `free`
	 * can find it again. */
	if (alignment < (OO_S32)sizeof(void *)) alignment = sizeof(void *);
	size_t raw_size = (size_t)bytes + (size_t)alignment + sizeof(void *);
	void *raw = malloc(raw_size);
	if (!raw) return NULL;
	uintptr_t base = (uintptr_t)raw + sizeof(void *);
	uintptr_t aligned = (base + (uintptr_t)alignment - 1) & ~((uintptr_t)alignment - 1);
	((void **)aligned)[-1] = raw;
	return (void *)aligned;
}

static void plugin_free(void *p)
{
	if (!p) return;
	void *raw = ((void **)p)[-1];
	free(raw);
}

static void plugin_printf(int level, const char *file, int line, const char *fmt, ...)
{
	/* No-op: the WASM environment has no usable stderr. The JS
	 * wrapper surfaces decode errors via the function return value. */
	(void)level;
	(void)file;
	(void)line;
	(void)fmt;
}

static OO_BOOL plugin_display_assertion(const char *file, const int line, const char *function, const char *message)
{
	(void)file;
	(void)line;
	(void)function;
	(void)message;
	/* Return false → continue without breaking. We can't do anything
	 * useful here since there's no debugger to break into. The JS
	 * wrapper will still see decompress() return 0 (failure). */
	return 0;
}

EXPORT int oodle_init(void)
{
	OodleCore_Plugins_SetAllocators(plugin_malloc_aligned, plugin_free);
	OodleCore_Plugins_SetPrintf(plugin_printf);
	OodleCore_Plugins_SetAssertion(plugin_display_assertion);
	return 0;
}

/*
 * ---------------------------------------------------------------------
 * Public exports
 * ---------------------------------------------------------------------
 */

EXPORT void *oodle_malloc(size_t n)
{
	return malloc(n);
}

EXPORT void oodle_free(void *p)
{
	free(p);
}

EXPORT size_t oodle_decompress(
	const void *compressed, size_t compressedSize,
	void *decompressed, size_t expectedRawSize)
{
	OO_SINTa ret = OodleLZ_Decompress(
		compressed, (OO_SINTa)compressedSize,
		decompressed, (OO_SINTa)expectedRawSize,
		OodleLZ_FuzzSafe_Yes,
		OodleLZ_CheckCRC_No,
		OodleLZ_Verbosity_None,
		NULL,                          /* decBufBase */
		0,                             /* decBufSize */
		NULL,                          /* fpCallback */
		NULL,                          /* callbackUserData */
		NULL,                          /* decoderMemory */
		0,                             /* decoderMemorySize */
		OodleLZ_Decode_Unthreaded);
	if (ret < 0) return 0;
	return (size_t)ret;
}
