# @tootallnate/nus3

## 0.1.0

### Minor Changes

- d47881d: New package for Bandai Namco NUS3BANK sound banks (Pokkén Tournament DX, Smash 4). `parseNus3Bank` lists a bank's playable tones and skips random/sequence containers. `decodeIdsp` decodes Namco's interleaved multi-channel DSP-ADPCM streams to PCM, with loop points; the output is bit-exact against vgmstream.
