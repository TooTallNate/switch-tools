/**
 * Pure-JS decoder for CRI Middleware's HCA audio codec.
 *
 * - {@link parseHca}    — read the header without decoding samples
 * - {@link decodeHca}   — full block-by-block decode → interleaved
 *                          Float32 PCM
 * - {@link encodeToWav} — wrap PCM in a RIFF/WAVE container
 *
 * Ported from kohos/CriTools (MIT) — https://github.com/kohos/CriTools
 */

export * from './parse.js';
export * from './decode.js';
export * from './decrypt.js';
export * from './wav.js';
