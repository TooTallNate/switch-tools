/**
 * @tootallnate/sead-audio — Square Enix SEAD audio container
 * parser. Decodes `.sab` (sound effect banks) and `.mab` (music
 * banks) into a flat list of audio streams plus enough metadata
 * to either play them directly (when the inner codec is Ogg
 * Vorbis) or hand them to a codec-specific decoder (HCA, ADPCM,
 * ATRAC9, etc.).
 *
 * On-disk magic: ASCII `"sabf"` (sound) or `"mabf"` (music).
 *
 * Used by:
 *   - Final Fantasy Pixel Remasters I-VI (Switch + PC) — MAB
 *   - Final Fantasy XV, XII TZA, VII Remake — SAB/MAB
 *   - Kingdom Hearts III, Melody of Memory — SAB/MAB
 *   - Final Fantasy Tactics PC Remaster — SAB
 *   - Dissidia Final Fantasy Opera Omnia — SAB/MAB
 *   - Paranormasight — SAB
 *   - Dragon Quest Builders, Star Ocean Anamnesis — SAB
 *   - many more Square Enix titles
 *
 * When wrapped inside a Unity `TextAsset` (e.g.
 * `SWAV_BGM_FF1_34.nx.mab`), the asset bytes are just the raw
 * `.sab` / `.mab` with the magic at offset 0 — no extra wrap.
 * Some Unreal-engine wraps prepend up to a few KB before the
 * magic; `parseSead` accepts an `offsetHint` for that case but
 * defaults to scanning for the magic.
 *
 * Cross-referenced against vgmstream's `src/meta/sqex_sead.c`
 * (canonical) and Yoraiz0r's AudioMog (clean C# port).
 */

export * from './sead.js';
export * from './codec-table.js';
