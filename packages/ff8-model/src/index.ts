/**
 * @tootallnate/ff8-model — Final Fantasy VIII field-character
 * model decoder.
 *
 * FFVIII field maps reference their character models through
 * a per-map `chara.one` container that may either inline a
 * full model (mesh + textures + animations) or reference a
 * sibling `d###.mch` file. This package decodes:
 *
 *   - {@link parseCharaOne}: the outer container's entry table.
 *   - {@link parseMch}: an MCH body's skeleton, geometry, skin
 *      assignments and animation track.
 *   - {@link parseTim}: the PSX TIM textures embedded in
 *      chara.one entries (and in the VRAM page used by
 *      sibling MCH files).
 *   - {@link unpackRotationDegrees}: the per-bone 4-byte packed
 *      rotation decoder (OpenVIII-corrected formula).
 *
 * All entry-point functions are pure and take `Uint8Array`
 * input; no I/O.
 */

export * from './chara-one.js';
export * from './mch.js';
export * from './tim.js';
export * from './animation-decode.js';
