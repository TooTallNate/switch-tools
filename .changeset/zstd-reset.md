---
"@tootallnate/zstd-wasm": minor
---

`ZstdDecoder.reset()` starts a fresh decompression context in the same WebAssembly instance, so one decoder can serve many one-shot decodes.
