/**
 * FF7 PC battle-model "master file" parser.
 *
 * Each character / enemy / arena in `battle.lgp` has a master
 * file named `<id_pair>aa` (e.g. Cloud = `rtaa`, Tifa = `ruaa`).
 * It's the binary equivalent of the field models' text-format
 * HRC: 52-byte header + 12 bytes per bone. All sibling files
 * (per-bone meshes, textures, animation pack) are derived from
 * the master's 2-char prefix by suffix conventions.
 *
 * Header layout (52 bytes, all u32 LE except where noted):
 *
 *   offset  field
 *     0x00  unk[0]            (sentinel/version; always 0 in observed files)
 *     0x04  unk[1]
 *     0x08  unk[2]
 *     0x0C  numBones          (0 ⇒ this is a battle-stage piece, not a character)
 *     0x10  unk2[0]
 *     0x14  unk2[1]
 *     0x18  numTextures
 *     0x1C  numBodyAnimations
 *     0x20  unk3[0]
 *     0x24  unk3[1]
 *     0x28  numWeaponAnimations
 *     0x2C  unk4[0]
 *     0x30  unk4[1]
 *     0x34  (per-bone records start here)
 *
 * Per-bone record (12 bytes):
 *   offset  field
 *     0x00  parent  (i32; -1 = root)
 *     0x04  length  (f32; STORED POSITIVE, FLIP SIGN AT LOAD TIME — battle
 *                   models use the negated value for rendering, opposite of
 *                   field models)
 *     0x08  hasModel (u32; 0 = pure transform, non-zero = mesh present)
 *
 * Filename-derivation rules (given master = `<X><Y>aa`):
 *
 *   bone mesh i (0..numBones-1)
 *      counter starts at "am"; wraps through "az" → "ba" → "bz" → "ca" → "cz"
 *      examples: rtam, rtan, …, rtaz, rtba, …
 *
 *   texture j (0..numTextures-1)
 *      `<X><Y>` + "a" + (char(99+j))   →  rtac, rtad, rtae, …, rtal
 *
 *   animation pack
 *      `<X><Y>da`                       →  rtda
 *
 *   weapon meshes (probed on disk; up to 16 slots)
 *      `<X><Y>c` + (char(107+k))        →  rtck, rtcl, …, rtcz
 *
 * For battle stages (numBones == 0) the loader probes
 * `<X><Y>am` through `<X><Y>az` for static mesh pieces.
 */

export class BattleSkeletonParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BattleSkeletonParseError';
	}
}

export const BATTLE_HEADER_SIZE = 52 as const;
export const BATTLE_BONE_SIZE = 12 as const;

export interface BattleSkeletonHeader {
	numBones: number;
	numTextures: number;
	numBodyAnimations: number;
	numWeaponAnimations: number;
	/** Unknown header fields exposed for completeness (don't use). */
	unknowns: {
		unk1: [number, number, number];
		unk2: [number, number];
		unk3: [number, number];
		unk4: [number, number];
	};
}

export interface BattleBone {
	/** Index into the bone array (== record order in the file). */
	index: number;
	/** Parent bone index, or -1 for the root. */
	parent: number;
	/**
	 * Bone length. Stored positive on disk; sign-flipped at load
	 * time so `+length` consistently points "child-ward" (matching
	 * the field-model convention).
	 */
	length: number;
	/** Whether a `.p` mesh is attached at this bone. */
	hasModel: boolean;
	/**
	 * Computed mesh filename for this bone (no `.p` extension —
	 * battle files have no extension at all). Always set even if
	 * `hasModel` is false; the caller decides whether to load it.
	 */
	meshFilename: string;
}

export interface ParsedBattleSkeleton {
	header: BattleSkeletonHeader;
	/** Lowercased base name (first 2 chars of the master filename). */
	baseName: string;
	/**
	 * True when the master file has `numBones == 0` — indicates a
	 * battle stage/arena rather than a character. In that case
	 * `bones` is empty and `stagePieceFilenames` is the list of
	 * static `<base>am..<base>az` mesh filenames to probe on disk.
	 */
	isBattleStage: boolean;
	bones: BattleBone[];
	/** For battle stages: candidate piece filenames to probe on disk. */
	stagePieceFilenames: string[];
	/** Texture filenames (always exactly `numTextures` entries). */
	textureFilenames: string[];
	/** Single animation-pack filename (always `<base>da`). */
	animationPackFilename: string;
	/**
	 * Candidate weapon-mesh filenames to probe on disk
	 * (`<base>ck`..`<base>cz` — up to 16). Battle models that aren't
	 * weapon-wielding characters typically have none of these.
	 */
	weaponMeshFilenames: string[];
}

/**
 * Compute the bone-mesh filename for bone index `i`.
 *
 * Counter starts at `am` (suffix1=`a`, suffix2=`m`) and wraps:
 *   am, an, ao, ..., ay, az, ba, bb, ..., bz, ca, cb, ...
 */
export function computeBoneMeshFilename(baseName: string, i: number): string {
	let s1 = 0x61; // 'a'
	let s2 = 0x6d; // 'm'
	for (let k = 0; k < i; k++) {
		if (s2 === 0x7a) {
			s1++;
			s2 = 0x61; // 'a'
		} else {
			s2++;
		}
	}
	return baseName + String.fromCharCode(s1) + String.fromCharCode(s2);
}

/**
 * Compute the texture filename for texture index `j`.
 */
export function computeTextureFilename(baseName: string, j: number): string {
	// `ac` + j → 0x63 + j
	return baseName + 'a' + String.fromCharCode(0x63 + j);
}

export function parseBattleSkeleton(
	bytes: Uint8Array,
	masterFilename: string,
): ParsedBattleSkeleton {
	if (bytes.length < BATTLE_HEADER_SIZE) {
		throw new BattleSkeletonParseError(
			`Battle skeleton too short (${bytes.length} bytes); need at least ${BATTLE_HEADER_SIZE}`,
		);
	}
	if (masterFilename.length < 4) {
		throw new BattleSkeletonParseError(
			`Battle master filename "${masterFilename}" too short; need at least 4 chars`,
		);
	}

	const baseName = masterFilename.slice(0, 2).toLowerCase();
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const header: BattleSkeletonHeader = {
		numBones: view.getUint32(0x0c, true),
		numTextures: view.getUint32(0x18, true),
		numBodyAnimations: view.getUint32(0x1c, true),
		numWeaponAnimations: view.getUint32(0x28, true),
		unknowns: {
			unk1: [
				view.getUint32(0x00, true),
				view.getUint32(0x04, true),
				view.getUint32(0x08, true),
			],
			unk2: [view.getUint32(0x10, true), view.getUint32(0x14, true)],
			unk3: [view.getUint32(0x20, true), view.getUint32(0x24, true)],
			unk4: [view.getUint32(0x2c, true), view.getUint32(0x30, true)],
		},
	};

	const isBattleStage = header.numBones === 0;
	const bones: BattleBone[] = [];
	const stagePieceFilenames: string[] = [];

	if (isBattleStage) {
		// Battle stage: probe `am` through `az` (max 14 pieces). We
		// can't tell which actually exist without filesystem access;
		// expose all 14 candidates and let the caller filter.
		for (let c = 0x6d; c <= 0x7a; c++) {
			stagePieceFilenames.push(baseName + 'a' + String.fromCharCode(c));
		}
	} else {
		// Read per-bone records.
		const expectedSize = BATTLE_HEADER_SIZE + header.numBones * BATTLE_BONE_SIZE;
		if (bytes.length < expectedSize) {
			throw new BattleSkeletonParseError(
				`Battle skeleton declares ${header.numBones} bones; expected ${expectedSize} bytes, got ${bytes.length}`,
			);
		}
		for (let i = 0; i < header.numBones; i++) {
			const off = BATTLE_HEADER_SIZE + i * BATTLE_BONE_SIZE;
			const parent = view.getInt32(off + 0, true);
			const lengthRaw = view.getFloat32(off + 4, true);
			const hasModel = view.getUint32(off + 8, true) !== 0;
			bones.push({
				index: i,
				parent,
				// Battle convention: flip sign so "+length" points
				// child-ward, matching field models.
				length: -lengthRaw,
				hasModel,
				meshFilename: computeBoneMeshFilename(baseName, i),
			});
		}
	}

	const textureFilenames: string[] = [];
	for (let j = 0; j < header.numTextures; j++) {
		textureFilenames.push(computeTextureFilename(baseName, j));
	}

	const weaponMeshFilenames: string[] = [];
	for (let c = 0x6b; c <= 0x7a; c++) {
		weaponMeshFilenames.push(baseName + 'c' + String.fromCharCode(c));
	}

	return {
		header,
		baseName,
		isBattleStage,
		bones,
		stagePieceFilenames,
		textureFilenames,
		animationPackFilename: baseName + 'da',
		weaponMeshFilenames,
	};
}

/**
 * Header-only sniff. Battle skeleton files are 52 bytes minimum
 * and have a very specific bone-count / texture-count pattern.
 * We accept anything where the bone-count fits the remaining
 * bytes and the texture count is plausible (≤ 16).
 */
export function isBattleSkeleton(bytes: Uint8Array): boolean {
	if (bytes.length < BATTLE_HEADER_SIZE) return false;
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
	const numBones = view.getUint32(0x0c, true);
	const numTextures = view.getUint32(0x18, true);
	const numBodyAnims = view.getUint32(0x1c, true);
	const numWeaponAnims = view.getUint32(0x28, true);
	if (numBones > 200) return false; // sanity
	if (numTextures > 32) return false;
	if (numBodyAnims > 256 || numWeaponAnims > 256) return false;
	const need = BATTLE_HEADER_SIZE + numBones * BATTLE_BONE_SIZE;
	return bytes.length >= need;
}
