/**
 * @tootallnate/ff7-world — Final Fantasy VII PC overworld map
 * decoder. Parses `wm0.map` (Midgar → Crater), `wm2.map`
 * (underwater + Junon harbor), and `wm3.map` (Great Glacier).
 *
 * Each `.map` file is an array of 0xB800-byte sections; each
 * section holds 16 LZSS-compressed mesh "sectors" addressed via
 * a 64-byte u32 pointer table. Each sector is a chunk of
 * heightfield-textured triangles in PSX-style raw int16 vertex
 * coords. Texture coords are PSX VRAM offsets and require a
 * hardcoded per-texture lookup table to convert to per-texture
 * UVs (this package embeds the 282-entry table from Braver, plus
 * the smaller 8/4-entry tables for the WM2/WM3 variants).
 *
 * Usage:
 *
 * ```ts
 * import {
 *   parseWorldMap,
 *   sectorVertexWorld,
 *   OVERWORLD_TEXTURES,
 *   kindFromSectionCount,
 *   texturesForMap,
 *   SECTOR_WORLD_SIZE,
 * } from '@tootallnate/ff7-world';
 *
 * const world = parseWorldMap(bytes);
 * const kind = kindFromSectionCount(world.sections.length);
 * const tex = texturesForMap(kind);
 *
 * // Iterate every triangle in world space:
 * for (let s = 0; s < world.sections.length; s++) {
 *   const sectionGridX = s % world.gridWidth;
 *   const sectionGridZ = Math.floor(s / world.gridWidth);
 *   for (const sector of world.sections[s].sectors) {
 *     for (const tri of sector.triangles) {
 *       const v0 = sector.vertices[tri.v0];
 *       const wv0 = sectorVertexWorld(v0, sector, sectionGridX, sectionGridZ);
 *       const t = tex[tri.textureId];
 *       const u = (tri.u0 - t.uOffset) / t.width;
 *       // ...
 *     }
 *   }
 * }
 * ```
 *
 * Pair with `@tootallnate/lgp` + `@tootallnate/ff7-pc-model` to
 * resolve the matching `.tex` files inside `world_us.lgp` (or
 * the localised `world_xx.lgp`).
 */

export * from './map.js';
export * from './texture-table.js';
