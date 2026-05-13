/**
 * Platform-config override for building Oodle with wasi-sdk.
 *
 * Oodle's `rrplatform.h` includes `oodle_platform.h` to discover the
 * target OS family at compile time; the upstream platform header in
 * `src/oodle2/core/public/` doesn't have a branch for
 * `wasm32-wasip1`, so it fires its `#error "Target platform not
 * recognized!"`. This file replaces the upstream header (we list our
 * `c/oodle-platform-wasi/` directory FIRST on the Makefile's
 * `-I` line, so the compiler picks this one up).
 *
 * The handful of macro names this file defines (`__RADWASI__`,
 * `__RADDETECTED__`, `RADLINK`) are part of Oodle's compile-time
 * interface — symbols its other source files test with `#ifdef`.
 * Re-implementing that interface with our own minimal contents is
 * the standard way Oodle's build system handles new platforms.
 *
 * The numeric value picked for `__RADWASI__` is arbitrary; nothing
 * in Oodle's source compares it to a specific number. It just needs
 * to be defined.
 *
 * No code or text in this file is copied from RAD's source. The
 * comments and structure are this project's; the macro names are
 * Oodle's compile-time interface contract.
 */

#pragma once

/* We assume a WASI target compiled by wasi-sdk's clang. Bail out
 * loudly if that's not the case — the WASI sysroot supplies the
 * libc symbols (malloc, memcpy, etc.) Oodle's code needs. */
#if !defined(__wasi__) && !defined(__wasm__)
	#error "oodle-wasm: this oodle_platform.h is for wasi-sdk builds only."
#endif

/* Identify the platform family. The exact integer doesn't matter
 * — Oodle just needs SOMETHING to be defined as __RADDETECTED__. */
#define __RADWASI__ 64
#define __RADDETECTED__ __RADWASI__

/* RADLINK is used by Oodle for callback-function calling
 * conventions on platforms that distinguish them (e.g. Windows'
 * `__stdcall`). wasm32 has only one calling convention; the empty
 * definition is correct. */
#define RADLINK
