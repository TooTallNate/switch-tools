/**
 * N64 F3D / F3DEX / F3DEX2 display-list interpretation.
 *
 * The Nintendo 64 has no model file format. Geometry reaches the
 * GPU as a *display list*: a stream of 64-bit commands for the
 * Reality Signal Processor. This package walks those command
 * streams and turns them into flat vertex/index arrays, plus the
 * texture state each triangle was drawn with.
 *
 * Typical use — find and decode the models in a decompressed blob:
 *
 * ```ts
 * import { scanDisplayLists, interpretDisplayList } from '@tootallnate/f3dex';
 *
 * for (const ref of scanDisplayLists(blob)) {
 *   const mesh = interpretDisplayList(blob, ref.offset, {
 *     microcode: ref.microcode,
 *   });
 *   // mesh.positions / mesh.indices / mesh.groups / mesh.materials
 * }
 * ```
 *
 * See `interpret.ts` for how the vertex cache, matrix stack, and
 * segmented addressing are handled, and `scan.ts` for what makes a
 * candidate offset believable.
 */

export type { Microcode } from './microcode.js';
export {
	opcodesFor,
	isValidOpcode,
	triangleIndexScale,
	vertexCacheSize,
	GEOMETRY_MODE,
	RDP,
	type RspOpcodes,
} from './microcode.js';

export {
	decodeN64Texture,
	textureFormatName,
	bitsPerTexel,
	ImageFormat,
	ImageSize,
	type DecodeTextureOptions,
} from './texture.js';

export {
	interpretDisplayList,
	defaultSegmentResolver,
	type F3dexMesh,
	type F3dexGroup,
	type F3dexMaterial,
	type InterpretOptions,
	type SegmentResolver,
	type WrapMode,
} from './interpret.js';

export {
	scanDisplayLists,
	type DisplayListRef,
	type ScanOptions,
} from './scan.js';
