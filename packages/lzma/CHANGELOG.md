# @tootallnate/lzma

## 0.1.0

### Minor Changes

- cdaff79: New package: a small, dependency-free LZMA (LZMA1) decoder. `decodeLzmaAlone` reads `.lzma` streams, and `decodeLzma` decodes a raw properties + stream block to a known size, which is the layout Unity uses for LZMA-compressed asset bundles.
