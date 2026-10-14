/**
 * DOOM 3 BFG Edition compiled model formats (as shipped in the Switch
 * port's `.resources`):
 *
 * - {@link parseBrm}: `BRMl` static models (`.blwo`, `.base`, `.bma`, …).
 * - {@link parseBmd5mesh}: `.bmd5mesh` skinned models.
 * - {@link parseBmd5anim} / {@link sampleBmd5anim}: `.bmd5anim` clips.
 * - {@link parseBproc}: `.bproc` map render worlds (level geometry).
 * - {@link Md5Pose}: CPU posing and skinning.
 *
 * Ported from id Software's GPL DOOM-3-BFG source release; each module
 * cites the functions it follows.
 */
export * from './model.js';
export * from './anim.js';
export * from './proc.js';
export * from './pose.js';
export { halfToFloat } from './reader.js';
