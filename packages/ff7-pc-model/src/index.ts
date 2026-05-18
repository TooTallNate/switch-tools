/**
 * Parsers for FF7 PC's bespoke 3D model formats.
 *
 * Most FF7 characters and props are an inter-linked bundle of
 * four file types stored side-by-side in `char.lgp` /
 * `battle.lgp` / `magic.lgp`:
 *
 *   * `.hrc` — a TEXT skeleton file (bone tree + bone lengths
 *     + RSD references)
 *   * `.rsd` — a TEXT resource file pointing to the per-bone
 *     `.ply` / `.mat` / `.grp` / texture file names
 *   * `.p`   — the BINARY mesh ("P file") attached to a single
 *     bone (this is FF7's bespoke format, NOT Stanford PLY)
 *   * `.tex` — the BINARY texture (palette-indexed or direct RGB)
 *
 * Each format is parseable in isolation; the composite "render
 * the whole skeleton" view is the caller's job.
 *
 * Format references:
 *   - https://wiki.ffrtt.ru/index.php/FF7/P
 *   - https://wiki.ffrtt.ru/index.php/FF7/TEX_format
 *   - https://wiki.ffrtt.ru/index.php/FF7/HRC
 */

export * from './hrc.js';
export * from './rsd.js';
export * from './p.js';
export * from './tex.js';
