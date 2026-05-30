# @tootallnate/fmod-bank

## 0.0.2

### Patch Changes

- 46507c6: FMOD Studio audio support: parse `.bank` files, extract embedded
  FSB5 sample banks, decrypt encrypted banks against an embedded
  list of ~50 known per-game keys, and decode every codec FMOD
  ships into browser-playable formats:

  - **`@tootallnate/fmod-bank`** — RIFF/FEV chunk-tree walker for
    FMOD Studio `.bank` files. Recursively decodes the LIST(PROJ)
    metadata tree (BSSL / EVTS / WAIS / BNKI / etc.), extracts the
    encrypted SND chunk, and exposes the embedded FSB5 bytes ready
    to feed to `@tootallnate/fsb5`. Includes:

    - Per-byte XOR + bit-reversal decryption matching FMOD's
      `FMOD_STUDIO_LOAD_BANK_DECRYPT` scheme. The algorithm is
      bit-for-bit compatible with FMODBankDecryptor (MIT) and
      CUE4Parse's `Fsb5Decryption.cs` (Apache 2.0).
    - **`KNOWN_BANK_KEYS`** — 50+ documented per-game encryption
      keys (sourced from CUE4Parse, FMODBankDecryptor, and
      vgmstream's `fsb_keys.h` — all permissive licenses). Includes
      Sekiro, Dark Souls 3, Forza, Fall Guys, Cult of the Lamb,
      Signalis, Wanderstop, and others.
    - **`tryKnownKeysAndDecrypt`** — auto-detects the right key
      by probing each candidate against the encrypted region's
      first 4 bytes (cheap: just 4 XOR ops per attempt) and
      confirming the decrypted bytes match `FSB5`. ~50 attempts
      per encrypted bank, all in <1 ms.
    - Extra-keys argument for callers with private keys.

  - **`@tootallnate/fsb5`** — FMOD Sample Bank parser + per-codec
    decoders. Reads the 60-byte FSB5 header, the variable-length
    sample table (with per-sample metadata chunks for frequency,
    channels, loop, Vorbis-CRC32, etc.), the optional name table,
    and exposes each sample as a typed record with `frequency`,
    `channels`, `numSamples`, `data` (zero-copy view).

    Per-codec decoders:

    - **PCM8 / PCM16 / PCM32 / PCMFLOAT** → WAV blob.
    - **IMA-ADPCM** → WAV blob (FMOD's mono-interleaved variant).
    - **Vorbis (mode 15)** → Ogg-Vorbis blob via a precomputed
      setup-packet lookup table. Each FSB5 Vorbis sample carries
      a `VORBISDATA` metadata chunk with a 4-byte CRC32 keying
      one of 161 ready-to-emit Vorbis Setup packets we ship in
      `assets/fmod_vorbis_setup_packets.bin`. The per-sample
      audio data is a flat `(u16 packet_size, packet_bytes)`
      sequence of standard Vorbis packets — we just need to
      wrap them in Ogg pages with proper granule positions
      (computed from per-packet block sizes by reading each
      packet's mode bit + the embedded mode-count from our
      setup table).

    The setup-packet table is a 620 KB OSS-licensed asset derived
    from python-fsb5 (MIT) — we don't extract it from any single
    game. Other codecs (PCM24 / GCADPCM / MPEG / CELT / AT9 / XMA
    / XWMA / VAG / HEVAG) surface a clear "not supported yet"
    error and let the user download the raw FSB5 payload for
    offline conversion.

  `apps/nx-archive` integration:

  - `.bank` files (RIFF + FEV form-type) auto-detected via magic
    sniff and routed to `makeFmodBankNode`. Wwise BNK files
    (`BKHD` magic) keep their existing dispatch path; the
    ambiguous `.bank` extension is resolved by inspecting the
    first 12 bytes.
  - Bank container expands to one virtual `.ogg` / `.wav` leaf per
    embedded sample, named from the FSB5 name table.
  - The FMOD audio preview pane decodes the sample at click time,
    shows codec metadata + duration + bank decryption status, and
    embeds an `<audio>` player + Save .ogg / Save .wav download.
  - The Vorbis setup-packet asset is fetched lazily on first
    Vorbis decode and cached for the rest of the session.

  Verified end-to-end against the real-world flow: encrypted FMOD
  bank → auto-detect key → decrypt SND chunk → parse FSB5 → per-
  sample Vorbis rebuild → Ogg-Vorbis → browser plays.
