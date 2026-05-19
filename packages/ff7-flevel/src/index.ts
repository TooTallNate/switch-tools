/**
 * @tootallnate/ff7-flevel — Final Fantasy VII PC field-scene
 * decoder. Reads `flevel.lgp` entries (LZSS-compressed
 * FieldModule containers) and composites the pre-rendered
 * tile-based backgrounds to an RGBA image.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   decompressLzss,
 *   parseFieldModule,
 *   getSection,
 *   parsePalette,
 *   parseBackground,
 *   composite,
 * } from '@tootallnate/ff7-flevel';
 *
 * const decompressed = decompressLzss(lgpEntryBytes);
 * const module = parseFieldModule(decompressed);
 * const palette = parsePalette(getSection(module, 'Palette'));
 * const background = parseBackground(getSection(module, 'Background'));
 * const { width, height, pixels } = composite(background, palette);
 * // pixels is RGBA8, row-major, top-down.
 * ```
 */

export * from './lzss.js';
export * from './field-module.js';
export * from './palette.js';
export * from './background.js';
export * from './composite.js';
