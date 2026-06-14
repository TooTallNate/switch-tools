# @tootallnate/nso

## 0.0.2

### Patch Changes

- b01f06f: Three new parser packages for Switch system-data formats.

  **`@tootallnate/bfttf`** — deobfuscator for Nintendo's `.bfttf` /
  `.bfotf` font containers (the system fonts shipped under SystemData
  title IDs `0x810`–`0x815`). `parseBfttf(blob)` strips the 8-byte
  header, undoes the per-word XOR with key `0x06186249`, and returns
  a real `Blob` typed as `font/ttf` or `font/otf` ready for
  `URL.createObjectURL` or the CSS Font Loading API. `isBfttf(blob)`
  sniffs the magic for cheap detection. Verified against retail
  Firmware 16.0.3 — all five system fonts (Standard, Korean, Chinese
  Traditional, Chinese Simplified, Nintendo Extension) round-trip
  into valid TrueType files.

  **`@tootallnate/npdm`** — full parser for `main.npdm` Process
  Definition Metadata. Decodes the Meta header (process name, thread
  priority, address-space type, flags), the ACID descriptor (signed
  access-control: program-id range, memory region, flags, signature,
  public key), the ACI0 runtime descriptor (program id), and the
  three sub-tables found in both ACID and ACI0:

  - **FsAccessControl** — the 64-bit FS permission bitmap decoded
    into named bits (`ApplicationInfo`, `GameCard`, `SaveDataBackUp`,
    …, `Debug`, `FullPermission`), plus content-owner / save-data-
    owner ID lists with per-id read/write/read-write accessibility.
  - **ServiceAccessControl** — the variable-length list of allowed
    service names (with wildcard `*` and the "may register" flag).
  - **KernelCapability** — all 9 kinds of bit-packed kernel-capability
    descriptors (`ThreadInfo`, `EnableSystemCalls`, `MemoryMap`
    paired form, `IoMemoryMap`, `MemoryRegionMap`, `EnableInterrupts`,
    `MiscParams`, `KernelVersion`, `HandleTableSize`, `MiscFlags`).

  **`@tootallnate/nso`** — header-only parser for NSO0 executables (the
  `main`, `subsdk*`, `sdk`, `rtld` files inside an ExeFS PFS0).
  `parseHeader(blob)` reads only the 0x100-byte header plus the module
  name slice — never the (possibly multi-MB compressed) segment
  payloads — and returns the GNU build-id (ModuleId), per-segment
  compression / hash status, virtual addresses, embedded
  `.dynstr` / `.dynsym` table offsets, plus the new firmware-22.0.0+
  zstd compression flag and 20.0.0+ execute-only-memory flag.
  `isNso(blob)` magic-sniffs in 4 bytes.

  All three ship browser-friendly: pure ESM, work on Node and on the
  web, no native deps. Total of 27 unit tests across the three
  packages.
