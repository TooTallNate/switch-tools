/**
 * PlatinumGames file formats, as used by Bayonetta 3 (and largely
 * shared with Astral Chain and NieR:Automata):
 *
 * - {@link parsePkz}: `.pkz` packages of compressed files.
 * - {@link parseDat}: `DAT\0` archives (`.dat` / `.dtt`).
 * - {@link parseWta} / {@link decodeWtaTexture}: `WTB\0` texture banks
 *   (`.wta` + `.wtp`, or `.wtb`), Switch XT1 surfaces.
 * - {@link parseWmb} / {@link buildWmbMesh}: WMB3 models.
 * - {@link parseMot}: MOT animations; {@link WmbPose} poses and skins.
 *
 * Format notes are in each module's doc comment. Sources: Kerilk's
 * bayonetta_tools (010 Editor templates and the Ruby `pgtools` gem).
 */
export * from './pkz.js';
export * from './dat.js';
export * from './wta.js';
export * from './wmb.js';
export * from './mot.js';
export * from './pose.js';
