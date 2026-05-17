# @tootallnate/bink1-wasm

WebAssembly decoder for **Bink 1** (`.bik`) video — including its
audio tracks — built from a slim FFmpeg configuration. The decoder
runs in browsers and Node/Bun with no native dependencies.

> [!IMPORTANT]
> This package ships the compiled `bink1.wasm` artifact directly.
> FFmpeg is licensed under the **LGPL-2.1-or-later**, which permits
> redistribution of compiled binaries provided the recipient retains
> the right to relink the application against a modified FFmpeg.
> The source recipe + patches used to produce this WASM are included
> below (see [Build reproduction](#build-reproduction)).

## Install

```bash
pnpm add @tootallnate/bink1-wasm
```

## Usage

```ts
import { Bink1Decoder } from '@tootallnate/bink1-wasm';
import wasmUrl from '@tootallnate/bink1-wasm/bink1.wasm?url';

const wasmBytes = await fetch(wasmUrl).then(r => r.arrayBuffer());
const bikBytes  = await fetch('/path/to/cinematic.bik').then(r => r.arrayBuffer());

const decoder = await Bink1Decoder.create(wasmBytes, new Uint8Array(bikBytes));

console.log(decoder.info);
// { width: 1920, height: 1080, frameCount: 645,
//   fpsNum: 30, fpsDen: 1, audioTrackCount: 1 }

let frame = decoder.decodeNextFrame();
while (frame) {
    // frame.{y,u,v} are views into WASM memory. Copy before the
    // next decode call or the bytes will be overwritten.
    yourYuv420ToRgbConverter(frame);

    // Pull whatever audio was decoded inline with this video frame:
    for (let t = 0; t < decoder.info.audioTrackCount; t++) {
        const audio = decoder.drainAudio(t);
        if (audio.samplesPerChannel > 0) {
            yourAudioSink(audio.interleaved);
        }
    }

    frame = decoder.decodeNextFrame();
}

// Drain any tail samples after end-of-stream.
for (let t = 0; t < decoder.info.audioTrackCount; t++) {
    const tail = decoder.drainAudio(t);
    if (tail.samplesPerChannel > 0) yourAudioSink(tail.interleaved);
}

decoder.dispose();
```

## API

### `class Bink1Decoder`

- **`static create(wasmSource, bikBytes): Promise<Bink1Decoder>`** —
  Compile (if needed) and instantiate the WASM, then open the
  given `.bik` byte buffer.
- **`info: Bink1Info`** — Container metadata: `{ width, height,
  frameCount, fpsNum, fpsDen, audioTrackCount }`.
- **`audioTrack(i): Bink1AudioTrackInfo`** — `{ sampleRate, channels }`
  for audio track `i`.
- **`decodeNextFrame(): Bink1Frame | null`** — Decode the next
  video frame in monotonic order. Returns `null` at end-of-stream.
  Plane views are invalidated by the next call.
- **`drainAudio(track): Bink1AudioFrame`** — Pull whatever audio
  was decoded for `track` since the last drain. The `interleaved`
  Float32 view is invalidated by the next `drainAudio(track)` call.
- **`copyVisiblePlanes(frame)`** — Copy the cropped, stride-stripped
  planes of `frame` into fresh JS-side `Uint8Array`s. Use this when
  you need to keep frame bytes around past the next decode call.
- **`dispose()`** — Release the WASM-owned buffers. Always call when
  done; the decoder owns up to `bikBytes.length + width*height*1.5`
  bytes plus audio FIFOs.

### Error model

- **`Bink1DecodeError`** — Subclass of `Error` thrown for input
  rejections (`bink1_open` failures) and decode errors.

## What's in the WASM

The WASM is built from FFmpeg with `--disable-everything` plus:

- `--enable-decoder=bink,binkaudio_dct,binkaudio_rdft`
- `--enable-demuxer=bink`

Result: ~700 KB compiled WASM with **only** Bink 1 video, Bink
audio (DCT + RDFT variants), and the Bink container demuxer. No
networking, no filesystem, no other codecs.

The TS wrapper drives FFmpeg through a custom `AVIOContext` that
reads from a single in-memory copy of the `.bik` bytes — there is
no virtual filesystem, no temp files, no `WASI` filesystem access.

## Build reproduction

LGPL-2.1+ permits redistributing the binary so long as users can
relink. To rebuild `bink1.wasm` from source:

```bash
# 1. Install wasi-sdk (once):
make setup           # downloads wasi-sdk-25 to /tmp/wasi-sdk

# 2. Fetch and patch FFmpeg source:
make setup-source    # clones FFmpeg n6.1.1 into build/ffmpeg/

# 3. Configure FFmpeg, compile, and link bink1.wasm:
make                 # writes src/bink1.wasm (~700 KB)
```

Pinned versions:

- **FFmpeg `n6.1.1`** (LGPL-2.1-or-later)
- **wasi-sdk-25** (clang 19.1.5)

Patches applied to FFmpeg are in `c/patches/` (currently just a
two-line forward declaration in `libavutil/file_open.c` to satisfy
the wasi-libc build; the corresponding `mkstemp` symbol is dead
code at link time and gets dropped by LTO + `--gc-sections`).

## Limitations

- **Monotonic decode only.** Arbitrary frame seek isn't exposed;
  callers needing it must construct a fresh `Bink1Decoder`.
- **No transparency support.** Bink 1 supports alpha planes via the
  `BIKa`/`BIKg` magic variants; the wrapper currently exposes only
  the YUV planes. Adding alpha is straightforward but hasn't been
  needed for the cinematics encountered so far.
- **Sample rate ≠ effective rate.** Bink stereo RDFT tracks double
  the container-declared sample rate; the wrapper's `audioTrack(i)`
  reports the container-declared value. Most callers want
  `decoder.info` for video timing and `audioTrack(i).sampleRate`
  directly for audio sink construction (FFmpeg's binkaudio decoder
  already normalises to the effective rate).

## License

This package's TS wrapper code is **MIT**. The compiled
`bink1.wasm` artifact is **LGPL-2.1-or-later** (inherited from
FFmpeg). See [`LICENSE.LGPL-2.1`](./LICENSE.LGPL-2.1).
