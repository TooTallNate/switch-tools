//! Thin C-ABI wrapper around `texture2ddecoder::decode_astc` for
//! WebAssembly. We expose two intrinsics the JS side needs:
//!
//!   - `astc_alloc(n)`     — allocate `n` bytes inside the WASM
//!                           linear memory and return the pointer.
//!                           Used to stage compressed input + the
//!                           decoded RGBA output. `core::alloc` is
//!                           unavailable in `no_std` without an
//!                           allocator, so we hand-roll a bump
//!                           allocator backed by a fixed-size
//!                           static buffer (sized for 4K textures).
//!   - `astc_free()`       — reset the bump allocator to zero,
//!                           reclaiming all currently-staged memory.
//!                           The JS side calls this between decodes.
//!   - `astc_decode(...)`  — decode an ASTC block stream of the
//!                           given block dimensions to RGBA8.
//!
//! There's no thread safety here — JS is single-threaded inside a
//! given WASM instance and we serialise calls from the wrapper.

#![no_std]
#![no_main]

use core::cell::UnsafeCell;
use core::panic::PanicInfo;

// `texture2ddecoder` is compiled with its default `alloc` feature
// (the `no-default-features` build path has unrelated compile errors
// in pvrtc.rs that we don't want to patch around), so the linker
// expects a `#[global_allocator]`. `wee_alloc` is the smallest
// option for WASM and we never actually allocate from the ASTC code
// path — every call hands a preallocated `&mut [u32]` to the decoder.
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// ---- Panic handler ------------------------------------------------
//
// `no_std` modules need a `panic_handler`. We never want a panic to
// reach the WASM boundary; if the decoder hits an internal assertion
// we'd rather return an error code from `astc_decode` and keep the
// runtime alive. Mark this `#[inline(never)]` so the linker keeps a
// single copy.

#[panic_handler]
#[inline(never)]
fn panic(_info: &PanicInfo) -> ! {
    // Trigger a WebAssembly trap (`unreachable`) so JS-side gets a
    // catchable `RuntimeError` instead of an infinite loop. The
    // `texture2ddecoder` crate panics on malformed ASTC blocks
    // rather than returning a `Result` for invalid bit patterns,
    // and an infinite loop here would deadlock the host.
    core::arch::wasm32::unreachable()
}

// ---- Bump allocator -----------------------------------------------
//
// 16 MiB is enough for a 2048×2048 RGBA texture (16 MiB exactly) plus
// a comfortable margin for the compressed input. We back it with an
// `UnsafeCell` because mutation through a `static` reference would
// otherwise need `unsafe` blocks at every callsite.

const ARENA_SIZE: usize = 32 * 1024 * 1024;

struct Arena {
    bytes: UnsafeCell<[u8; ARENA_SIZE]>,
    cursor: UnsafeCell<usize>,
}

unsafe impl Sync for Arena {}

static ARENA: Arena = Arena {
    bytes: UnsafeCell::new([0u8; ARENA_SIZE]),
    cursor: UnsafeCell::new(0),
};

#[no_mangle]
pub extern "C" fn astc_alloc(n: usize) -> *mut u8 {
    unsafe {
        let cursor = &mut *ARENA.cursor.get();
        let aligned = (*cursor + 15) & !15; // 16-byte align
        if aligned + n > ARENA_SIZE {
            return core::ptr::null_mut();
        }
        let ptr = (*ARENA.bytes.get()).as_mut_ptr().add(aligned);
        *cursor = aligned + n;
        ptr
    }
}

#[no_mangle]
pub extern "C" fn astc_free() {
    unsafe {
        *ARENA.cursor.get() = 0;
    }
}

// ---- Decoder ------------------------------------------------------
//
// `texture2ddecoder::decode_astc` writes BGRA pixels packed as `u32`
// words into the output slice — one word per pixel, in row-major
// order. We expose:
//
//     i32 astc_decode(
//         block_w, block_h,
//         width, height,
//         src_ptr, src_len,
//         dst_ptr, dst_pixels
//     )
//
// where:
//   - block_w / block_h: ASTC block dimensions (4..=12 each).
//   - width / height:    image dimensions in pixels.
//   - src:               pointer + byte length of compressed data.
//   - dst:               pointer + pixel count of RGBA8 output;
//                        the slice is `width*height` u32s laid out
//                        as RGBA bytes, top-down.
//
// Returns 0 on success, non-zero on error.

#[no_mangle]
pub extern "C" fn astc_decode(
    block_w: usize,
    block_h: usize,
    width: usize,
    height: usize,
    src_ptr: *const u8,
    src_len: usize,
    dst_ptr: *mut u32,
    dst_pixels: usize,
) -> i32 {
    if src_ptr.is_null() || dst_ptr.is_null() {
        return 1;
    }
    if dst_pixels < width * height {
        return 2;
    }
    let src = unsafe { core::slice::from_raw_parts(src_ptr, src_len) };
    let dst = unsafe { core::slice::from_raw_parts_mut(dst_ptr, dst_pixels) };
    match texture2ddecoder::decode_astc(src, width, height, block_w, block_h, dst) {
        Ok(()) => {
            // The decoder writes BGRA-packed u32s (little-endian
            // memory layout: B, G, R, A). Browsers want RGBA, so
            // swap B↔R per pixel in place.
            for px in dst.iter_mut() {
                let v = *px;
                let b = v & 0xff;
                let g = (v >> 8) & 0xff;
                let r = (v >> 16) & 0xff;
                let a = (v >> 24) & 0xff;
                *px = (a << 24) | (b << 16) | (g << 8) | r;
            }
            0
        }
        Err(_) => 3,
    }
}
