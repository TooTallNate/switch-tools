# `@tootallnate/bink2-wasm`

A WebAssembly wrapper around the in-tree Bink 2 video decoder from
[`bbit-git/cnc-ra-libs`](https://github.com/bbit-git/cnc-ra-libs), for
playing `.bk2` cinematics in the browser.

## Why does this package work differently from the others?

The Bink 2 video format is proprietary to RAD Game Tools (now part of
Epic Games). RAD has never published source code for its decoder. The
only currently-available open-source decoder is the in-tree
implementation in `cnc-ra-libs` — a C&C Remastered engine port — which
is **GPL-3.0 licensed**. The compiled WASM produced by this package's
build pipeline therefore inherits the GPL-3.0 license.

This repository's licensing policy is MIT/Apache-2.0/public-domain;
shipping a GPL-3.0 binary blob here would force the entire repo to
become GPL-3.0. So this package contains **only**:

1. A small MIT-licensed C++ wrapper (`c/wrapper.cpp`) that exposes the
   decoder's frame-at-a-time API to JavaScript via a stable C ABI.
2. A build recipe (`Makefile`) that compiles the wrapper + cnc-ra-libs'
   `bink2/` source using [wasi-sdk](https://github.com/WebAssembly/wasi-sdk).
3. Two scalar-path patches (`c/patches/`) that fix compile bugs in the
   upstream non-x86 fallback paths (`Clip255` typo, `__builtin_cpu_init`
   on non-x86). These are toolchain-agnostic and worth upstreaming.
4. A TypeScript wrapper around the resulting WASM (`src/index.ts`).
5. A setup script (`scripts/setup-source.sh`) that clones cnc-ra-libs
   at a pinned commit and applies the patches.

The compiled `bink2.wasm` blob is never committed to or distributed by
this repository. **You build your own.** Callers pass the WASM bytes to
this package's API at runtime, the same way you would with any
user-supplied resource a project can't redistribute (game ROMs,
console BIOSes, signing keys, etc.).

## Building from scratch

You'll need:

- A POSIX shell (`bash`), `make`, `git`, `patch`, `curl`.
- About 200 MB of disk space (wasi-sdk + cnc-ra-libs).
- About 2 minutes.

```bash
cd packages/bink2-wasm

# 1. Install wasi-sdk into /tmp/wasi-sdk (downloads ~150 MB). Skip
#    if you already have it from @tootallnate/oodle-wasm.
make setup

# 2. Clone cnc-ra-libs at the pinned commit and apply the patches.
#    Prints the GPL-3.0 URL and prompts for confirmation.
make setup-source

# 3. Compile to WebAssembly.
make

# Result: src/bink2.wasm (~210 KB).
```

The resulting `src/bink2.wasm` is what you'll upload to the consuming
application (e.g. nx-archive).

## Usage

```typescript
import { Bink2Decoder } from '@tootallnate/bink2-wasm';

const wasmBytes = await fetch('/bink2.wasm').then(r => r.arrayBuffer());
const bk2Bytes  = await fetch('/cinematic.bk2').then(r => r.arrayBuffer());

const decoder = await Bink2Decoder.create(wasmBytes, new Uint8Array(bk2Bytes));
console.log(decoder.info); // { width, height, frameCount, fpsNum, fpsDen, ... }

for (let i = 0; i < decoder.info.frameCount; i++) {
    const frame = decoder.decodeFrame(i);
    // frame.{y, u, v} are Uint8Array views into WASM memory.
    // The visible region is decoder.info.{width, height} from (0, 0).
    // The buffer width is frame.alignedWidth (rounded up to a 32-px multiple).
    //
    // *** The plane views are only valid until the next decodeFrame() call. ***
    // Copy them out before doing anything else with the decoder.
}

decoder.dispose();
```

### Frame ordering

Bink 2 uses inter-frame coding: most frames reference the previous
decoded frame for motion compensation. The decoder retains the
previous frame internally, so you must iterate forward in monotonic
frame order. You may seek to a keyframe (via `decoder.isKeyframe(i)`)
and resume forward iteration from there.

## Status

This is a thin browser-friendly wrapper around upstream
`cnc-ra-libs`. The upstream decoder:

- ✅ Container / header / frame index / audio tracks: fully working.
- ✅ Keyframe decode (intra): fully working.
- ⚠️ Inter-frame decode: substantially working but not bit-exact with
  RAD's reference. Most blocks decode correctly; some block types
  (RESIDUE / MOTION with certain MV modes) show artifacts. Adequate
  for visual previews; not adequate for archival re-encoding where
  exact reproduction matters.
- ❌ Audio decode: code exists but isn't exposed by the WASM build yet.

## Performance

On Apple M-series + Node 24:

- Open + parse header: ~5 ms.
- Decode: ~300 fps on 1280×960 video (single-threaded scalar fallback).

Browser performance will be similar; the WASM module is pure scalar
code (no SIMD intrinsics) for portability. The decoder ships ~210 KB
of code with no runtime dependencies beyond `WebAssembly` and a small
WASI shim for libc support.

## License

This package's own source files (everything under `c/wrapper.cpp`,
`src/`, `scripts/`, `c/patches/`, `Makefile`) is MIT-licensed. The
WASM artifact produced by `make`, derived from cnc-ra-libs sources,
is GPL-3.0.
