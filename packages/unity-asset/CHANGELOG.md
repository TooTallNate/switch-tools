# @tootallnate/unity-asset

## 0.1.1

### Patch Changes

- ff99ae6: 3D preview for Unity `Mesh` objects.

  `@tootallnate/unity-asset` adds `extractUnityMesh`, which decodes a TypeTree-parsed Mesh into positions / normals / UVs / colours / indices / sub-meshes. It handles multi-stream vertex data, both vertex-format enums (2017–2018 and 2019+), inline or `.resS`-streamed vertex bytes (`unityMeshStreamRef`), and 16/32-bit indices. `toRightHanded` converts to Three.js handedness. `ClassId` gains `MeshRenderer`, `MeshFilter` and `SkinnedMeshRenderer`.

  nx-archive renders Mesh objects in the shared 3D viewer, with STL/3MF export. Per-sub-mesh textures are resolved through the `SkinnedMeshRenderer` (or `MeshFilter` + `MeshRenderer`) that draws the mesh. The albedo is picked by conventional property name, or for Shader Graph materials with generated property names, by the texture's own name and colour space.

- 817db87: Skinned Unity meshes are posed and animated in the 3D viewer instead of sitting in their T-pose bind pose.

  `@tootallnate/unity-asset`:

  - `extractUnityMesh` returns skin weights / bone indices (`skin`, from the vertex stream or legacy `m_Skin`) and inverse bind matrices (`bindPoses`).
  - New `decodeUnityAnimationClip` decodes Mecanim clips: streamed cubic keys, dense samples, constants, and `genericBindings` to Transform position / rotation / scale / Euler tracks.
  - New `unityPathHash` (CRC32 of the binding path).

  nx-archive builds the bone hierarchy from the mesh's `SkinnedMeshRenderer` Transforms and matches clips by path hash. The mesh is CPU-skinned each frame, so exports capture the pose. There are two layers: full-body clips (opening on `idle`) plus partial overlays such as eye and mouth clips. `MeshViewer` animation drivers can now set a `defaultIndex`.

- Updated dependencies [8f52079]
  - @tootallnate/bntx@0.0.3

## 0.1.0

### Minor Changes

- 9e3a6a9: Add `@tootallnate/unity-asset`, a parser for Unity
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

### Patch Changes

- Updated dependencies [5330e53]
  - @tootallnate/bntx@0.0.2
