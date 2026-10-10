# @tootallnate/upak

## 0.1.0

### Minor Changes

- 250f019: Read legacy PAK files (versions 3–9, UE 4.0–4.24), such as Octopath Traveler's v4 PAKs. `isUpak` detects any supported footer, and `parseUpak` falls back to the legacy index format when the file isn't v11.
