/**
 * @tootallnate/ff7-battle — Final Fantasy VII PC battle-model
 * file-format decoder.
 *
 * Battle characters / enemies / arenas in `battle.lgp` use a
 * different format from field models: a compiled binary HRC
 * (52-byte header + 12-byte bones) instead of the field's
 * text-format HRC + RSD reference chain. Sibling files
 * (per-bone meshes, textures, animation pack) are derived
 * from the master file's 2-char prefix by naming convention.
 *
 * P-mesh + TEX files reuse the field-model parsers from
 * `@tootallnate/ff7-pc-model` (identical byte format).
 *
 * Usage:
 *
 * ```ts
 * import { parseBattleSkeleton, parseAnimationPack } from '@tootallnate/ff7-battle';
 *
 * const sk = parseBattleSkeleton(masterBytes, 'rtaa');
 * // → { header: { numBones, numTextures, numBodyAnimations, numWeaponAnimations },
 * //     bones: [{ index, parent, length, hasModel, meshFilename }],
 * //     textureFilenames, animationPackFilename, weaponMeshFilenames }
 *
 * const pack = parseAnimationPack(rtdaBytes, sk.header);
 * // → { bodyAnimations: [...], weaponAnimations: [...] }
 * ```
 */

export * from './skeleton.js';
export * from './animation-pack.js';
