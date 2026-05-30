# @tootallnate/usm

## 0.1.0

### Minor Changes

- 913c6f4: Add `@tootallnate/usm`, a parser for CRI Sofdec2 USM video
  container files (`*.usm`). Walks the chunk index lazily — each
  chunk header is ~24 bytes, so a multi-GB USM is indexed in
  milliseconds without materialising any payload bytes.

  `parseUsm(blob)` returns `{ fileSize, streams, chunks }`. Each
  stream carries its codec metadata (codec name, resolution +
  fps for video; codec, sample rate + channel count for audio)
  plus a lazy `Blob` that, when read, yields the concatenated
  codec payload across every data chunk for that stream/channel.

  For VP9 USMs (Mario RPG, modern Nintendo first-party titles)
  the resulting video Blob is a complete IVF file, directly
  decodable by browsers (via WebCodecs), ffmpeg, or VLC. H.264
  USMs come out as raw NAL streams. Audio Blobs are HCA / ADX /
  PCM, ready to hand off to a codec-specific decoder.

  Also exposes `parseUtfTable` for reading the embedded `@UTF`
  metadata tables — useful for callers that want to dig into
  codec params (bitrate, color space, seek index) the high-level
  parser doesn't surface.
