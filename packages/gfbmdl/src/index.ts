/**
 * Game Freak GFLX FlatBuffers formats (Pokémon: Let's Go, Pikachu! /
 * Eevee!):
 *
 *  - `.gfbmdl` — models: materials with named texture slots, a bone
 *    hierarchy, and interleaved vertex buffers with u16 triangle lists.
 *  - `.gfbanm` — skeletal / material / visibility animation.
 *  - `.gfbanmcfg` — a model's animation state table (state → file).
 *
 * All three are plain FlatBuffers with no magic; {@link sniffGflx}
 * tells them apart structurally. Schema reference: Switch-Toolbox
 * (KillzXGaming, MIT), with corrections verified against the game.
 */

export * from './flatbuffers.js';
export * from './model.js';
export * from './mesh.js';
export * from './math.js';
export * from './animation.js';
export * from './animation-config.js';
export * from './pose.js';
export * from './sniff.js';
