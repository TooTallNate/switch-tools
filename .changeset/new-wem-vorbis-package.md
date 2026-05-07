---
'@tootallnate/wem-vorbis': patch
'@tootallnate/wem': patch
---

Wwise Vorbis WEMs now play in the browser. New
**`@tootallnate/wem-vorbis`** package — a TypeScript port of
[hcs64's ww2ogg](https://github.com/hcs64/ww2ogg) (BSD-3-Clause)
narrowed to the Switch-era **Wwise V62** format with external
aoTuV-603 codebooks. ~700 lines of source, no runtime
dependencies, fully pure-JS.

The ww2ogg pipeline ported in full for V62:

  1. **LSB-first bit I/O primitives** (`BitReader` / `BitWriter`)
     — Vorbis bitpacks values LSB-first within each byte;
     ww2ogg's `Bit_stream::get_bit()` uses an `0x80 >> bits_left`
     mask after decrementing, which is just an obfuscated way to
     say "read bit at position (7 - bits_left)" — i.e. LSB-first
     for both reads and writes. Verified by round-trip tests.

  2. **Codebook reconstruction**. The Switch-era WEM stores
     compact codebooks: 4-bit dimensions instead of 16, 14-bit
     entry count instead of 24, no 24-bit "BCV" identifier,
     1-bit lookup type instead of 4, and a variable per-codebook
     codeword-length descriptor instead of a fixed 5-bit field.
     We unpack these and emit full Vorbis codebooks (lookup
     types 0 and 1; type 2 is rejected, matching ww2ogg).

  3. **Setup-header rebuilding**. The Vorbis Setup packet is
     reconstructed end-to-end from the WEM's compact form,
     piping floor / residue / mapping / mode bits through with
     spec validation (codebook-index range checks, mapping-mux
     limits, reserved-field-must-be-zero, etc.). The mode list
     drives a `mode_blockflag[]` array that the audio rebuilder
     uses to fix up window-type bits.

  4. **Audio packet rebuild** (`mod_packets` mode). Wwise strips
     the leading bits of every audio packet (packet_type,
     mode_number, prev/next window types) and we restore them
     by peeking ahead at the next packet's mode. Each packet
     becomes its own Ogg page with proper granule positions
     computed from per-packet block sizes (bs/4 + bs/4 PCM
     samples per packet, with carry-over from the previous
     window).

  5. **Ogg-Vorbis muxer**. Reuses the page-builder pattern from
     our Switch-Opus → Ogg-Opus muxer (RFC 3533: 27-byte page
     header + segment table + payload, CRC-32 with poly
     0x04C11DB7).

The codebook library file (`packed_codebooks_aoTuV_603.bin`,
74 KB, BSD-3-Clause along with ww2ogg) ships in the package's
`assets/` directory; the consumer is responsible for loading it
at runtime (we don't embed it in the source). nx-archive uses
Vite's `?url` import to get a hashed asset URL and `fetch()`s
it once on the first Vorbis decode, caching the parsed library
for subsequent calls.

`@tootallnate/wem`'s `decodeWemToBlob` gains a new optional
second argument `WemDecodeOptions` for passing the codebook
library (or raw bytes); the Vorbis branch now produces Blobs
with type `audio/ogg; codecs=vorbis`. Without codebooks supplied,
Vorbis WEMs throw a friendly, actionable error pointing the
caller at the codebook file.

End-to-end verified against PLA samples (PLA's Default.pck has
566 OPUSNX entries and ~5,000 Vorbis entries — the Vorbis path
dominates the streaming pack):

  - 9/9 Vorbis WEMs from BATTLE_SYSTEM.bnk / BGM.bnk / ME.bnk /
    Default.pck decoded with zero ffmpeg errors. Mono SFX,
    stereo BGM, stereo ME, all four sample-rate variants tested.
  - In Chrome: `audio.duration` matches `sample_count /
    sample_rate` to ~4 ms precision, `audio.play()` advances
    `currentTime` correctly, no decode errors.
  - The full chain BNK → DIDX/DATA → WEM → Vorbis-rebuild →
    Ogg-Vorbis → browser audio works in nx-archive: open
    BATTLE_SYSTEM.bnk, click any of the 159 SFX WEMs, hit play.

Out of scope (deferred):

  - **Wwise Vorbis V34/V44/V48/V52/V53/V56** — pre-2014 Wwise
    versions with different setup layouts, separate "vorb"
    chunk, header-triad mode, etc. These don't ship on Switch.
    The `parseWemVorbisV62` function rejects non-0x42 fmt
    sizes with a clear error.
  - **OPUSWW (codec 0x3041)** — newer Wwise Opus framing with
    explicit per-frame seek table. Same Ogg-Opus muxer would
    work, just different framing. Not seen in PLA but used by
    AC Valhalla and some 2020+ Switch titles.
  - **Inline-codebooks Vorbis WEMs** — extremely rare; we have
    a parity port (`copyInlineCodebook`) but no validating
    sample. Consumers who hit this path should report an issue.
