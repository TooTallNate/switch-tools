import { describe, it, expect } from 'vitest';
import {
	parseBattleSkeleton,
	parseAnimationPack,
	splitRootFromFrames,
	computeBoneMeshFilename,
	computeTextureFilename,
	isBattleSkeleton,
	BATTLE_HEADER_SIZE,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Filename derivation
// ---------------------------------------------------------------------------

describe('computeBoneMeshFilename', () => {
	it('counts from `am` for the first bone', () => {
		expect(computeBoneMeshFilename('rt', 0)).toBe('rtam');
		expect(computeBoneMeshFilename('rt', 1)).toBe('rtan');
		expect(computeBoneMeshFilename('rt', 2)).toBe('rtao');
	});
	it('wraps `az` → `ba` at bone 14', () => {
		// 'am' (0), 'an' (1), ..., 'az' (13), 'ba' (14)
		expect(computeBoneMeshFilename('rt', 13)).toBe('rtaz');
		expect(computeBoneMeshFilename('rt', 14)).toBe('rtba');
		expect(computeBoneMeshFilename('rt', 15)).toBe('rtbb');
	});
	it('wraps `bz` → `ca` at bone 40', () => {
		// 14 + 26 = 40
		expect(computeBoneMeshFilename('rt', 39)).toBe('rtbz');
		expect(computeBoneMeshFilename('rt', 40)).toBe('rtca');
	});
	it('uses any 2-char prefix', () => {
		expect(computeBoneMeshFilename('ru', 0)).toBe('ruam'); // Tifa
		expect(computeBoneMeshFilename('rs', 0)).toBe('rsam'); // Frog
	});
});

describe('computeTextureFilename', () => {
	it('counts from `ac` for the first texture', () => {
		expect(computeTextureFilename('rt', 0)).toBe('rtac');
		expect(computeTextureFilename('rt', 1)).toBe('rtad');
		expect(computeTextureFilename('rt', 9)).toBe('rtal'); // max practical
	});
});

// ---------------------------------------------------------------------------
// Skeleton parser (synthetic)
// ---------------------------------------------------------------------------

function makeMasterFile(opts: {
	numBones?: number;
	numTextures?: number;
	numBodyAnimations?: number;
	numWeaponAnimations?: number;
	bones?: { parent: number; length: number; hasModel: boolean }[];
}): Uint8Array {
	const bones = opts.bones ?? [];
	const numBones = opts.numBones ?? bones.length;
	const out = new Uint8Array(BATTLE_HEADER_SIZE + numBones * 12);
	const view = new DataView(out.buffer);
	view.setUint32(0x0c, numBones, true);
	view.setUint32(0x18, opts.numTextures ?? 0, true);
	view.setUint32(0x1c, opts.numBodyAnimations ?? 0, true);
	view.setUint32(0x28, opts.numWeaponAnimations ?? 0, true);
	for (let i = 0; i < bones.length; i++) {
		const off = BATTLE_HEADER_SIZE + i * 12;
		view.setInt32(off + 0, bones[i]!.parent, true);
		view.setFloat32(off + 4, bones[i]!.length, true);
		view.setUint32(off + 8, bones[i]!.hasModel ? 1 : 0, true);
	}
	return out;
}

describe('parseBattleSkeleton', () => {
	it('parses a 3-bone character skeleton', () => {
		const bytes = makeMasterFile({
			numTextures: 2,
			numBodyAnimations: 4,
			numWeaponAnimations: 3,
			bones: [
				{ parent: -1, length: 10, hasModel: false },
				{ parent: 0, length: 25, hasModel: true },
				{ parent: 1, length: 18, hasModel: true },
			],
		});
		const sk = parseBattleSkeleton(bytes, 'rtaa');
		expect(sk.header.numBones).toBe(3);
		expect(sk.header.numTextures).toBe(2);
		expect(sk.header.numBodyAnimations).toBe(4);
		expect(sk.header.numWeaponAnimations).toBe(3);
		expect(sk.isBattleStage).toBe(false);
		expect(sk.baseName).toBe('rt');
		expect(sk.animationPackFilename).toBe('rtda');
		expect(sk.textureFilenames).toEqual(['rtac', 'rtad']);
		expect(sk.bones).toHaveLength(3);

		// Sign-flipping the length: on-disk 10 → exposed as -10.
		expect(sk.bones[0]!.length).toBe(-10);
		expect(sk.bones[0]!.parent).toBe(-1);
		expect(sk.bones[0]!.hasModel).toBe(false);
		expect(sk.bones[0]!.meshFilename).toBe('rtam');

		expect(sk.bones[1]!.meshFilename).toBe('rtan');
		expect(sk.bones[2]!.meshFilename).toBe('rtao');
	});

	it('exposes the candidate weapon-mesh filenames (`ck`..`cz`)', () => {
		const bytes = makeMasterFile({ numBones: 0 });
		const sk = parseBattleSkeleton(bytes, 'rtaa');
		expect(sk.weaponMeshFilenames).toHaveLength(16);
		expect(sk.weaponMeshFilenames[0]).toBe('rtck');
		expect(sk.weaponMeshFilenames[15]).toBe('rtcz');
	});

	it('handles battle stages (numBones == 0)', () => {
		const bytes = makeMasterFile({ numBones: 0, numTextures: 1 });
		const sk = parseBattleSkeleton(bytes, 'svaa');
		expect(sk.isBattleStage).toBe(true);
		expect(sk.bones).toHaveLength(0);
		expect(sk.stagePieceFilenames).toHaveLength(14); // am..az
		expect(sk.stagePieceFilenames[0]).toBe('svam');
		expect(sk.stagePieceFilenames[13]).toBe('svaz');
	});

	it('rejects buffers smaller than the 52-byte header', () => {
		expect(() => parseBattleSkeleton(new Uint8Array(20), 'rtaa')).toThrow(
			/too short/,
		);
	});

	it('rejects truncated bone records', () => {
		const partial = makeMasterFile({
			bones: [{ parent: -1, length: 1, hasModel: false }],
		}).slice(0, BATTLE_HEADER_SIZE + 6);
		// numBones = 1 but only 6 bytes of bone record present
		expect(() => parseBattleSkeleton(partial, 'rtaa')).toThrow(/declares/);
	});

	it('rejects short master filenames', () => {
		expect(() => parseBattleSkeleton(makeMasterFile({}), 'rt')).toThrow(
			/too short/,
		);
	});
});

describe('isBattleSkeleton sniff', () => {
	it('accepts valid headers', () => {
		const bytes = makeMasterFile({
			bones: [{ parent: -1, length: 1, hasModel: false }],
		});
		expect(isBattleSkeleton(bytes)).toBe(true);
	});
	it('rejects too-short buffers', () => {
		expect(isBattleSkeleton(new Uint8Array(40))).toBe(false);
	});
	it('rejects implausible counts', () => {
		const bytes = new Uint8Array(BATTLE_HEADER_SIZE);
		const view = new DataView(bytes.buffer);
		view.setUint32(0x0c, 999, true);
		expect(isBattleSkeleton(bytes)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Animation pack
// ---------------------------------------------------------------------------

/**
 * Build a single uncompressed (key=0) battle animation with N
 * frames × M bone slots, all rotations and root translations
 * set to zero. The animation stream is fully literal — no
 * deltas, so easy to author by hand.
 *
 * Frame 0: rootT 3 × 16-bit signed = 48 bits, then per-bone
 *   3 × 12-bit signed = 36 bits.
 * Frame 1+: rootT 3 × (1 flag bit + 7 bits delta) = 24 bits,
 *   then per-bone 3 × (1 bit "no delta") = 3 bits.
 */
function makeOneFrameAnimation(boneCount: number): Uint8Array {
	const fullBits = 12; // key=0
	const frame0Bits = 48 + boneCount * 3 * fullBits;
	const streamBytes = Math.ceil(frame0Bits / 8);
	const stream = new Uint8Array(streamBytes);
	// All bits are zero — that gives rootT=(0,0,0), rotations=(0,0,0).
	const header = new Uint8Array(12 + 5);
	const view = new DataView(header.buffer);
	view.setUint32(0, boneCount + 1, true); // numBonesModel
	view.setUint32(4, 1, true); // numFrames1
	view.setUint32(8, 5 + streamBytes, true); // blockLength = sub-header(5) + stream
	view.setUint16(12, 1, true); // numFrames2
	view.setUint16(14, streamBytes, true); // animationLength
	view.setUint8(16, 0); // key=0
	const out = new Uint8Array(header.length + streamBytes);
	out.set(header, 0);
	out.set(stream, header.length);
	return out;
}

describe('parseAnimationPack', () => {
	it('parses a single 1-frame body animation', () => {
		const sentinel = new Uint8Array(4); // count = 0
		const anim = makeOneFrameAnimation(3); // 3 bones + root
		const pack = new Uint8Array(sentinel.length + anim.length);
		pack.set(sentinel, 0);
		pack.set(anim, sentinel.length);
		const parsed = parseAnimationPack(pack, {
			numBones: 2, // bonesVectorLength = numBones + 1 = 3
			numBodyAnimations: 1,
			numWeaponAnimations: 0,
		});
		expect(parsed.bodyAnimations).toHaveLength(1);
		const a = parsed.bodyAnimations[0]!;
		expect(a.empty).toBe(false);
		expect(a.key).toBe(0);
		expect(a.frames).toHaveLength(1);
		expect(a.frames[0]!.rootTranslation).toEqual([0, 0, 0]);
		expect(a.frames[0]!.boneRotations).toHaveLength(3);
		expect(a.frames[0]!.boneRotations[0]).toEqual([0, 0, 0]);
	});

	it('splits the root rotation out of body animations', () => {
		const sentinel = new Uint8Array(4);
		const anim = makeOneFrameAnimation(3);
		const pack = new Uint8Array(sentinel.length + anim.length);
		pack.set(sentinel, 0);
		pack.set(anim, sentinel.length);
		const parsed = parseAnimationPack(pack, {
			numBones: 2,
			numBodyAnimations: 1,
			numWeaponAnimations: 0,
		});
		const split = splitRootFromFrames(parsed.bodyAnimations[0]!);
		expect(split.frames[0]!.rootRotation).toEqual([0, 0, 0]);
		expect(split.frames[0]!.boneRotations).toHaveLength(2); // 3 − 1 (root)
	});

	it('handles empty-slot sentinels (blockLength < 11)', () => {
		// Sentinel + one empty slot (numBonesModel + numFrames1 + blockLength=0)
		const empty = new Uint8Array(4 + 12);
		const view = new DataView(empty.buffer);
		view.setUint32(8, 0, true); // blockLength = 0
		const parsed = parseAnimationPack(empty, {
			numBones: 2,
			numBodyAnimations: 1,
			numWeaponAnimations: 0,
		});
		expect(parsed.bodyAnimations[0]!.empty).toBe(true);
		expect(parsed.bodyAnimations[0]!.frames).toHaveLength(0);
	});
});
