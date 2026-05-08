---
'@tootallnate/unity-asset': minor
---

Add `@tootallnate/unity-asset`, a parser for Unity
SerializedFile assets — the `CAB-…` files packed inside a
UnityFS bundle.

`parseSerializedFile(blob)` decodes the header, the type
table (with TypeTree blobs when present, which is the default
in shipping Unity 2019+ bundles), and the object table.
`parseObject(obj, typeTree)` then walks the TypeTree to
deserialise an object's payload bytes into a JSON-shaped
value — numbers / strings / booleans / arrays / records /
binary blobs.

The TypeTree-driven path means we don't have to maintain
hardcoded schemas per Unity version: the bundle ships its
own self-describing layout, and we walk it directly. Tested
end-to-end against a real Unity 2021.3.15f1 TextMeshPro font
asset (VDL-Logona Bold), pulling out the per-glyph metrics
(112 glyphs), the character → glyph index map (113 entries),
and a `m_StreamData` reference that points into the matching
`.resS` resource stream where the SDF atlas lives.

A few format quirks worth calling out:

  - The v22+ extension words at offsets +0x14..+0x2C stay
    BIG-endian like the legacy fields above them, even though
    the rest of the payload is little-endian. Got this wrong
    on the first pass and ended up with `metadataSize` in the
    multi-gigabyte range.
  - `TypelessData` in the TypeTree appears as `int size` +
    `UInt8 data` siblings rather than nested under an `Array`
    wrapper, but the on-disk layout IS `[i32 size][size×u8]`.
    Walking the tree as a generic struct reads only one byte
    for `data` and corrupts every subsequent field. Read it
    as a length-prefixed blob instead.
