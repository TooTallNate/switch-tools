/**
 * @tootallnate/ff7-scene — Final Fantasy VII PC `scene.bin`
 * decoder. Each FF7 install ships `data/battle/scene.bin`, a
 * 256-entry archive of enemy stats / attack records / formation
 * data / AI bytecode. This package decodes the gzip-block outer
 * container, the 7808-byte per-scene struct, and the FF7 text
 * encoding. AI bytecode is exposed as raw bytes for callers that
 * want to disassemble.
 *
 * Usage:
 *
 * ```ts
 * import {
 *   iterateSceneBinBlocks,
 *   gunzipSceneBytes,
 *   parseScene,
 * } from '@tootallnate/ff7-scene';
 *
 * for (const { sceneIndex, compressed } of iterateSceneBinBlocks(bytes)) {
 *   const decompressed = await gunzipSceneBytes(compressed);
 *   const scene = parseScene(decompressed, sceneIndex);
 *   for (const enemy of scene.enemies) {
 *     if (!enemy) continue;
 *     console.log(`#${sceneIndex}: ${enemy.name} — ${enemy.hp} HP`);
 *   }
 * }
 * ```
 */

export * from './archive.js';
export * from './scene.js';
export * from './text.js';
