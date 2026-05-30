# @tootallnate/wem

## 0.0.2

### Patch Changes

- 90e7be9: Wwise Vorbis WEMs now play in the browser. New
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

- 03add67: Three new parser packages targeting **Audiokinetic Wwise** — the
  audio middleware shipped in essentially every third-party Switch
  title (Pokémon Legends Arceus, Doom Eternal, Cuphead, Hollow
  Knight, NieR, Spyro, Crash, Ori, etc.). Together they take a
  `.pck` or `.bnk` file straight to playable audio in the browser.

  - **`@tootallnate/wwise-pck`** — parses AKPK (`.pck`) streaming-
    WEM packages. Walks the language map, soundbank LUT, streamed-
    files LUT, and external table; surfaces every WEM as a lazy
    `Blob` slice keyed by Wwise's FNV-hashed asset id. Handles the
    643 MB `Default.pck` from PLA cleanly (5,471 entries, header
    parsed in milliseconds, payload data resolved on demand).

  - **`@tootallnate/wwise-bnk`** — parses Wwise SoundBanks
    (BKHD / DIDX / DATA / HIRC chunks). Returns the full chunk list
    plus a flat array of embedded WEMs (DIDX entries pointing into
    DATA). HIRC is exposed as a raw `Blob` for callers that want
    the event/sound-graph; we don't decode it (50+ object types,
    not needed for actual playback).

  - **`@tootallnate/wem`** — full WEM parser + codec dispatch.
    Identifies all 17 known Wwise codec ids (Vorbis, OPUSNX, OPUSWW,
    PCM, IMA, DSP, XMA, ATRAC9, etc.) and converts the playable
    ones to browser-friendly Blobs:

    - **PCM 16-bit LE → WAV** (44-byte header + raw samples)
    - **Switch-Opus (0x3039) → Ogg-Opus** via a from-scratch
      pure-JS Ogg muxer. Strips the per-frame `(u32 size + u32
final_range)` Wwise framing, derives sample-counts from
      Opus TOC bytes (RFC 6716 §3.1), wraps everything in
      RFC-7845-compliant Ogg pages with proper CRC-32, granule
      positions, BOS/EOS flags, and segment-table lacing.
    - **Standard Ogg-Opus (0x3040) → passthrough** (data chunk
      _is_ a `.ogg`).
    - **Wwise Vorbis (0xFFFF)** + everything else surfaces a
      clear "not supported yet" error. Vorbis specifically needs
      a ww2ogg-style codebook reconstruction (~1500–2000 lines,
      multi-version detection logic) which is its own substantial
      undertaking.

    No dependencies — fully pure-JS, ~750 lines of source.

  Wired into `apps/nx-archive`:

  - `.pck` (AKPK) and `.bnk` (BKHD) files, both as top-level
    archives and as nested children, expand into their constituent
    WEMs in the file tree. Each WEM gets the music-note icon and
    a `wem_<id>.wem` synthetic filename (the original asset name
    isn't stored — Wwise hashes it at build time).
  - `.wem` files render with a dedicated audio preview pane:
    - Successful decode → embedded `<audio>` player + "Save .ogg"
      / "Save .wav" download link, plus a label explaining the
      decode path ("Re-muxed Switch-Opus → Ogg-Opus" / "PCM →
      WAV").
    - Unsupported codec → friendly explanation + raw-WEM download.
    - Always: structured codec metadata (codec id + name, sample
      rate, channels, avg bytes/sec) and the RIFF chunk table
      (id / offset / size).

  Verified end-to-end against PLA's `Default.pck`: an 8.6 MB
  Switch-Opus music track is re-muxed to a 749-page Ogg-Opus stream
  with all CRCs validating, monotonically increasing granule
  positions matching `num_samples + pre_skip`, and the browser
  reports `audio.duration === 373.34s` (matching the WEM's claimed
  17,920,000 samples @ 48 kHz exactly). `audio.play()` advances
  `currentTime` correctly with no decode error — this is full,
  end-to-end Pokémon Legends Arceus background music playing in
  Chrome via nothing but the built-in Opus decoder.

- Updated dependencies [90e7be9]
  - @tootallnate/wem-vorbis@0.0.2
