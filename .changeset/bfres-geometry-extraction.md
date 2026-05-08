---
'@tootallnate/bfres': minor
---

Add `extractGeometry()` — pulls vertex / normal / UV / color buffers
and triangle indices for every shape in every model in the BFRES.
Returns `BfresGeometry[]` with `Float32Array` / `Uint16Array` /
`Uint32Array` fields ready to drop into Three.js `BufferGeometry`,
glTF, or any other 3D toolchain.

Supports the common Switch attribute formats:

- Float32: `Format_32_*`
- Half-float: `Format_16_*_Single`
- SNorm: `Format_8_*_SNorm`, `Format_16_*_SNorm`, `Format_10_10_10_2_SNorm`
- UNorm: `Format_8_*_UNorm`, `Format_16_*_UNorm`

Reads from BFRES v5+. Walks `BufferInfo.bufferOffset` to locate the
shared geometry blob at the end of the file, then iterates each
FMDL → FSHP → (FVTX, Mesh[0]) and decodes each attribute slot
according to its format. First LOD only; skeletal weights, FMAT
materials, and animations remain out of scope.

Reference: KillzXGaming/BfresLibrary's Switch parsers
(VertexBufferParser.cs, ShapeParser.cs, VertexAttrib.cs).
