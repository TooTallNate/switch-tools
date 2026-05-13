# `@tootallnate/oodle-wasm`

A WebAssembly wrapper around [RAD Game Tools' Oodle Data
Compression](https://www.radgametools.com/oodle.htm) decoder, for
reading Oodle-compressed Unreal Engine PAK files in the browser.

## Why does this package work differently from the others?

Oodle is a high-quality proprietary compression library that ships
inside the Unreal Engine source distribution. The source code is
**publicly available** (under `EpicGames/UnrealEngine` and mirrored
in [`WorkingRobot/OodleUE`](https://github.com/WorkingRobot/OodleUE))
but is governed by the [Unreal Engine
EULA](https://www.unrealengine.com/eula/unreal), **not** an open-source
license. Among other things, that EULA does not permit Oodle's source
or compiled binaries to be redistributed as standalone tooling.

This repository's licensing policy is MIT/Apache-2.0/public-domain;
shipping Oodle bytes here would compromise that policy. So this
package contains **only**:

1. A small MIT-licensed C wrapper (`c/wrapper.c`) that exposes
   `OodleLZ_Decompress` to JavaScript via a stable, no-libc-imports
   WASM interface.
2. A build recipe (`Makefile`) that compiles the wrapper + RAD's
   source using [wasi-sdk](https://github.com/WebAssembly/wasi-sdk).
3. A TypeScript wrapper around the resulting WASM (`src/index.ts`).
4. A setup script (`scripts/setup-source.sh`) that fetches RAD's
   source from `EpicGames/UnrealEngine` for you, after you accept the
   UE EULA.

The compiled `oodle.wasm` blob is never committed to or distributed
by this repository. **You build your own.** Callers pass the WASM
bytes to this package's API at runtime, the same way you would with
any user-supplied resource a project can't redistribute (game ROMs,
console BIOSes, signing keys, etc.).

## Building from scratch

You'll need:

- A POSIX shell (`bash`), `make`, `curl`, `unzip`.
- About 200 MB of disk space (wasi-sdk + Oodle source).
- About 5 minutes.

```bash
cd packages/oodle-wasm

# 1. Install wasi-sdk into /tmp/wasi-sdk (downloads ~150 MB).
make setup

# 2. Fetch Oodle's source from EpicGames/UnrealEngine.
#    This prints the EULA URL and prompts for confirmation.
make setup-source

# 3. Compile to WebAssembly.
make

# Result: src/oodle.wasm (~500 KB - 1 MB).
```

After step 3, the WASM file is at `src/oodle.wasm`. Pass its bytes
to this package's TypeScript API:

```ts
import { OodleDecoder } from "@tootallnate/oodle-wasm";
import { readFile } from "node:fs/promises";

const wasm = await readFile("./src/oodle.wasm");
const decoder = await OodleDecoder.create(wasm);
const decompressed = decoder.decompress(compressedBytes, expectedSize);
decoder.dispose();
```

## License situation in detail

| Component | License | Where |
|---|---|---|
| `c/wrapper.c`, `c/wrapper.h` | MIT (this repo) | committed |
| `src/index.ts` (TS API) | MIT (this repo) | committed |
| `Makefile`, `scripts/setup-source.sh` | MIT (this repo) | committed |
| RAD's Oodle source | Unreal Engine EULA | **fetched by you**, lives in `c/oodle-src/` after `make setup-source`. Gitignored, never committed. |
| Compiled `oodle.wasm` | Derived from RAD's source — covered by the UE EULA | **built by you**. Never committed, never distributed. |

You should read the [Unreal Engine
EULA](https://www.unrealengine.com/eula/unreal) before running
`make setup-source`. The setup script prints a confirmation prompt
referencing the EULA URL.

We (the `switch-tools` maintainers) have no relationship with Epic
Games or RAD Game Tools and make no warranty about the legal status
of your usage. The pattern this package follows — providing build
recipes for proprietary software without shipping the artifacts —
is well-established (e.g. emulator BIOS prompts, modding tools that
require user-supplied SDKs) but it is not zero-risk; if you intend
to use this in a commercial product, consult counsel.

## Why `wasi-sdk` instead of Emscripten?

For consistency with the other WASM packages in this repository
(`zstd-wasm`, `brotli-wasm`, `astc-wasm`), all of which use
[`wasi-sdk`](https://github.com/WebAssembly/wasi-sdk)'s clang. The
resulting module imports nothing from WASI and runs in plain
`WebAssembly.Module` instantiation — works identically in browsers
and Node.

We export only the decoder side of Oodle. Encoders are intentionally
excluded from the build to keep the WASM small (the decoder is the
expensive optimized part, the encoder pulls in another ~2 MB of
analysis machinery for the optimal-parser levels). This package can
read Oodle-compressed data but cannot create new Oodle data.

## Supported compressors

After build, the WASM can decode any UE-PAK-supported Oodle
compressor:

- Kraken (most common; modern UE5 default)
- Mermaid, Selkie, Leviathan, Hydra
- Legacy: LZNA, BitKnit (the source still includes their decoders
  even though encoding is deprecated)

## What if I just want to try it without building?

If you have a copy of `oodle.wasm` someone else built (and you are
permitted to use it under their distribution of RAD's source), you
can use that directly. The TypeScript wrapper just needs the bytes
of the compiled WASM module.
