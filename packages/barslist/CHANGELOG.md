# @tootallnate/barslist

## 0.0.2

### Patch Changes

- 4e0ffef: Three new parser packages, all surveyed up from a sweep across
  13 first-party Switch ROMs:

  - **`@tootallnate/barslist`** — Nintendo's `ARSL` audio resource
    manifest, used by Mario Kart 8 Deluxe (et al.) as a sound-pack
    table-of-contents that names a logical group plus the BARS
    files belonging to it. ~150 LOC, 9 tests, validated against
    every shipped MK8D barslist (single-entry & multi-entry).

  - **`@tootallnate/bnvib`** — Switch HD Rumble vibration patterns
    (no magic; sniffed via the type+`0x03`-magic combo at offset 0).
    Decodes the per-band amplitude / frequency stream into both a
    structured `BnvibSample[]` and an audible stereo PCM16 waveform
    (low band → left, high band → right) you can wrap in a WAV
    blob and play in `<audio>`. 13 tests, including round-trips
    for all three vibration types (Normal, Loop, Loop+Wait).

  - **`@tootallnate/byaml`** — Nintendo's binary YAML format. The
    workhorse data table format across Wii U / Switch first-party
    games (AI rivalry tables, course parameters, balloon-battle
    paths, you name it). Decodes to a JS object tree with
    type-discriminated wrappers (`ByamlInt` / `ByamlUInt` / `ByamlFloat`
    / etc.) so callers that need to round-trip the file don't lose
    the s32-vs-u32 distinction; provides a `byamlToJson` helper for
    the common case where you just want a JSON tree. Handles every
    shipped version we've seen (v1 little-endian Wii U through v7
    Switch big-endian) including the BotW/MK8D quirk where v1 files
    put the root offset at 0x10 instead of 0x0C. 8 tests.

  All three are wired into `apps/nx-archive`:

  - `.barslist` files get a structured manifest preview showing the
    archive name, endian, and a table of resource paths (with the
    `.bars` paths that the in-app BARS preview will Just Work on
    if you've also extracted those).
  - `.bnvib` files get an audio player with a custom amplitude-
    envelope canvas (low band blue, high band orange) showing the
    rumble's intensity over time, with a translucent overlay marking
    the loop region.
  - `.byaml` / `.byml` files get a header summary and a Shiki-
    highlighted JSON tree with truncation for files larger than
    256 KB of formatted output.

  Also: `.ab` is now mapped to UnityFS in the file-extension table
  (it's the most common Unity AssetBundle extension and turned up
  ~1.8K times in the Detective Pikachu Returns dump).
