/**
 * `@tootallnate/j3d` — parser for Nintendo's J3D model format (`.bmd` / `.bdl`).
 *
 * J3D is the model format of JSystem, the engine behind *The Legend of Zelda:
 * The Wind Waker* and *Twilight Princess*, *Super Mario Sunshine*, *Pikmin*,
 * *Luigi's Mansion* and the GameCube *Animal Crossing*. Models normally live
 * inside a `RARC` archive, which in turn is normally wrapped in `Yaz0`, so the
 * usual pipeline is:
 *
 *   `@tootallnate/yaz0` → `@tootallnate/rarc` → this → `@tootallnate/bti`
 *
 * Nothing here throws on bad input; parsers return `null` instead, so a file
 * browser can attempt a parse on anything it finds and just move on.
 *
 * Everything is big-endian, because the GameCube's Gekko is a PowerPC.
 *
 * Typical use:
 *
 * ```ts
 * const model = parseJ3d(bytes);
 * if (model) {
 *   const mesh = buildJ3dMesh(model);            // typed arrays for the GPU
 *   for (const s of mesh!.sections) {
 *     const texIdx = materialTextureIndex(model, s.materialIndex);
 *     const tex = texIdx >= 0 ? decodeJ3dTexture(model, bytes, texIdx) : null;
 *     // ...draw mesh.indices[s.firstIndex .. +s.numTriangles*3] with `tex`
 *   }
 * }
 * ```
 *
 * The chunk parsers are exported individually too, for tools that only care
 * about one section (a texture ripper wants `TEX1` and nothing else).
 */

export * from './container.js';
export * from './geometry.js';
export * from './gx.js';
export * from './inf1.js';
export * from './jnt1.js';
export * from './mat3.js';
export * from './model.js';
export * from './shp1.js';
export * from './skin.js';
export * from './tex1.js';
export * from './util.js';
export * from './vtx1.js';
