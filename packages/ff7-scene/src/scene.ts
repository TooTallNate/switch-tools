/**
 * Per-scene decoder. Operates on the 7808-byte (0x1E80)
 * decompressed buffer.
 *
 * Layout (verified against Xeeynamo/ff7-decomp's
 * `SceneContainer` struct, cebix/ff7tools' `scene.py`, and the
 * Qhimm wiki):
 *
 *   offset  size     section
 *   0x0000  8        enemyModelID[3] + u16 0xFFFF pad
 *   0x0008  4 × 0x14  BattleSetup
 *   0x0058  4 × 4 × 0xC  CameraPlacement (4 formations × 4 placements)
 *   0x0118  4 × 6 × 0x10 FormationEntry (4 formations × 6 enemy slots)
 *   0x0298  3 × 0xB8 SceneEnemy (per-enemy stats)
 *   0x04C0  32 × 0x1C AttackEntry (32 attack records)
 *   0x0840  32 × u16  attackID[32]   (0xFFFF = unused slot)
 *   0x0880  32 × 0x20 attackName[32] (FF7-encoded, 0xFF-padded)
 *   0x0C80  0x200    Formation AI block (4 entities)
 *   0x0E80  0x1000   Enemy AI block    (3 entities)
 *   0x1E80           end
 *
 * Empty slots:
 *   - Enemy slot i is empty if `enemyModelID[i] === 0xFFFF`. Skip
 *     `parseEnemy(d, 0x298 + i*0xB8)` for these.
 *   - Attack slot i is empty if `attackID[i] === 0xFFFF`.
 *   - Drop slot i is empty if `dropRate[i] === 0xFF`.
 *   - AI entity i is absent if `entityTable[i] === 0xFFFF`.
 *   - AI script slot j (within an entity) is absent if
 *     `scriptTable[j] === 0xFFFF`.
 */

import { decodeFF7Text } from './text.js';

export const SCENE_OFFSETS = {
	enemyModelIDs: 0x000,
	battleSetup: 0x008,
	cameras: 0x058,
	formations: 0x118,
	enemies: 0x298,
	attackRecords: 0x4c0,
	attackIDs: 0x840,
	attackNames: 0x880,
	formationAI: 0xc80,
	enemyAI: 0xe80,
} as const;

export interface BattleSetup {
	stageID: number;
	nextStageID: number;
	/** Frames before the "Run" command succeeds. */
	escapeCounter: number;
	/** Battle-Arena chained formations (or all `0x03E7` = "none"). */
	arenaFormations: [number, number, number, number];
	flags: number;
	/** 0 normal · 1 preempt · 2 back · 3 side · 4 pincer · 5 pincer2 · 6 side2 · 7 side3 · 8 no-row-change */
	type: number;
	cameraID: number;
}

export interface CameraPlacement {
	x: number;
	y: number;
	z: number;
	dx: number;
	dy: number;
	dz: number;
}

export interface FormationEntry {
	enemyID: number;
	x: number;
	y: number;
	z: number;
	/** 0=front, 1=middle, 2=back. */
	row: number;
	/** 5-bit cover mask for short-range targeting (preserve, don't interpret). */
	coverFlags: number;
	/** Initial-condition bitmask (visible / targetable / etc.). */
	flags: number;
}

export interface Formation {
	setup: BattleSetup;
	cameras: CameraPlacement[];
	slots: FormationEntry[];
}

export interface EnemyDrop {
	kind: 'drop' | 'steal';
	itemID: number;
	/** 0..63 — chance is `rate / 63`. */
	rate: number;
}

export interface SceneEnemy {
	/** 16-bit model ID from the 0x000 table (links to `<id>aa` in battle.lgp). */
	modelID: number;
	name: string;
	level: number;
	speed: number;
	luck: number;
	evade: number;
	strength: number;
	defense: number;
	magic: number;
	magicDef: number;
	/** Element IDs (0..15), 0xFF = none. */
	elements: number[];
	/** Element rates parallel to `elements[]`. */
	elementRates: number[];
	/** Animation indices for each of 16 attack slots. */
	anims: number[];
	/** Global attack IDs (resolve via `scene.attacks` for in-scene; kernel.bin otherwise). */
	attackIDs: number[];
	/** Per-attack-slot camera ID overrides; 0xFFFF = use attack default. */
	cameraIDs: number[];
	/** 4 drop/steal slots, null = empty. */
	drops: (EnemyDrop | null)[];
	/** Up to 3 attacks usable when Manipulated/Berserked. */
	manipAttacks: number[];
	mp: number;
	ap: number;
	morphItem: number | null;
	/** Back-attack damage multiplier: damage × backAttackMul / 8. */
	backAttackMul: number;
	hp: number;
	exp: number;
	gil: number;
	/** Bitmask of status effects this enemy is immune to. */
	statusImmunities: number;
}

export interface AttackRecord {
	id: number;
	name: string;
	accuracy: number;
	impactEffectID: number;
	hurtActionID: number;
	mpCost: number;
	impactSfxID: number;
	cameraSingleID: number;
	cameraMultiID: number;
	targetFlags: number;
	attackEffectID: number;
	damageCalcID: number;
	strength: number;
	conditionSubmenu: number;
	statusChange: number;
	additionalEffects: number;
	effectsModifier: number;
	statuses: number;
	elements: number;
	flags: number;
}

export interface AIScript {
	/** Slot index 0..15 (see SCRIPT_SLOT_NAMES). */
	slotIndex: number;
	slotName: string;
	/** Raw bytecode (trailing 0xFF padding already stripped). */
	bytecode: Uint8Array;
}

export interface AIEntity {
	scripts: (AIScript | null)[];
}

export interface AIBlock {
	entities: (AIEntity | null)[];
}

export interface ParsedScene {
	sceneIndex: number;
	enemies: (SceneEnemy | null)[];
	attacks: AttackRecord[];
	formations: Formation[];
	formationAI: AIBlock;
	enemyAI: AIBlock;
}

/**
 * Names of the 16 AI script slots. Indices 8..15 are "custom"
 * events triggered by other scripts via opcode 0x92 (ACT type 0x22).
 */
export const SCRIPT_SLOT_NAMES: readonly string[] = [
	'Initialize',
	'Main',
	'General Counter',
	'Death Counter',
	'Physical Counter',
	'Magical Counter',
	'Battle End',
	'Pre-Action Setup',
	'Custom 1',
	'Custom 2',
	'Custom 3',
	'Custom 4',
	'Custom 5',
	'Custom 6',
	'Custom 7',
	'Custom 8',
];

export class SceneParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SceneParseError';
	}
}

export function parseScene(bytes: Uint8Array, sceneIndex = 0): ParsedScene {
	if (bytes.length !== 0x1e80) {
		throw new SceneParseError(
			`Scene must be exactly 0x1E80 (7808) bytes; got ${bytes.length}`,
		);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Enemy model IDs (slot 3 is padding).
	const enemyModelIDs: [number, number, number] = [
		v.getUint16(0x000, true),
		v.getUint16(0x002, true),
		v.getUint16(0x004, true),
	];

	// Battle setups.
	const setups: BattleSetup[] = [];
	for (let i = 0; i < 4; i++) {
		const off = SCENE_OFFSETS.battleSetup + i * 0x14;
		setups.push({
			stageID: v.getUint16(off + 0x00, true),
			nextStageID: v.getInt16(off + 0x02, true),
			escapeCounter: v.getInt16(off + 0x04, true),
			arenaFormations: [
				v.getUint16(off + 0x08, true),
				v.getUint16(off + 0x0a, true),
				v.getUint16(off + 0x0c, true),
				v.getUint16(off + 0x0e, true),
			],
			flags: v.getUint16(off + 0x10, true),
			type: v.getUint8(off + 0x12),
			cameraID: v.getInt8(off + 0x13),
		});
	}

	// Cameras (4 placements × 4 formations).
	const cameras: CameraPlacement[][] = [];
	for (let f = 0; f < 4; f++) {
		const fc: CameraPlacement[] = [];
		for (let p = 0; p < 4; p++) {
			const off = SCENE_OFFSETS.cameras + f * 4 * 0xc + p * 0xc;
			fc.push({
				x: v.getInt16(off + 0x00, true),
				y: v.getInt16(off + 0x02, true),
				z: v.getInt16(off + 0x04, true),
				dx: v.getInt16(off + 0x06, true),
				dy: v.getInt16(off + 0x08, true),
				dz: v.getInt16(off + 0x0a, true),
			});
		}
		cameras.push(fc);
	}

	// Formations.
	const formations: Formation[] = [];
	for (let f = 0; f < 4; f++) {
		const slots: FormationEntry[] = [];
		for (let s = 0; s < 6; s++) {
			const off = SCENE_OFFSETS.formations + f * 6 * 0x10 + s * 0x10;
			slots.push({
				enemyID: v.getUint16(off + 0x00, true),
				x: v.getInt16(off + 0x02, true),
				y: v.getInt16(off + 0x04, true),
				z: v.getInt16(off + 0x06, true),
				row: v.getUint16(off + 0x08, true),
				coverFlags: v.getUint16(off + 0x0a, true),
				flags: v.getUint32(off + 0x0c, true),
			});
		}
		formations.push({
			setup: setups[f]!,
			cameras: cameras[f]!,
			slots,
		});
	}

	// Enemies.
	const enemies: (SceneEnemy | null)[] = [];
	for (let i = 0; i < 3; i++) {
		if (enemyModelIDs[i] === 0xffff) {
			enemies.push(null);
			continue;
		}
		enemies.push(parseEnemy(bytes, v, SCENE_OFFSETS.enemies + i * 0xb8, enemyModelIDs[i]!));
	}

	// Attacks.
	const attacks: AttackRecord[] = [];
	for (let i = 0; i < 32; i++) {
		const id = v.getUint16(SCENE_OFFSETS.attackIDs + i * 2, true);
		if (id === 0xffff) continue;
		attacks.push(parseAttack(bytes, v, SCENE_OFFSETS.attackRecords + i * 0x1c, i, id));
	}

	// AI blocks.
	const formationAI = parseAIBlock(bytes, SCENE_OFFSETS.formationAI, 0x200, 4);
	const enemyAI = parseAIBlock(bytes, SCENE_OFFSETS.enemyAI, 0x1000, 3);

	return {
		sceneIndex,
		enemies,
		attacks,
		formations,
		formationAI,
		enemyAI,
	};
}

function parseEnemy(
	bytes: Uint8Array,
	v: DataView,
	base: number,
	modelID: number,
): SceneEnemy {
	const name = decodeFF7Text(bytes.subarray(base, base + 0x20));
	const drops: (EnemyDrop | null)[] = [];
	for (let i = 0; i < 4; i++) {
		const rate = v.getUint8(base + 0x88 + i);
		const item = v.getUint16(base + 0x8c + i * 2, true);
		if (rate === 0xff || item === 0xffff) {
			drops.push(null);
		} else {
			const isSteal = rate >= 0x80;
			drops.push({
				kind: isSteal ? 'steal' : 'drop',
				itemID: item,
				rate: isSteal ? rate - 0x80 : rate,
			});
		}
	}
	const manipAttacks: number[] = [];
	for (let i = 0; i < 3; i++) {
		const id = v.getUint16(base + 0x94 + i * 2, true);
		if (id !== 0xffff) manipAttacks.push(id);
	}
	const morphRaw = v.getUint16(base + 0xa0, true);
	return {
		modelID,
		name,
		level: v.getUint8(base + 0x20),
		speed: v.getUint8(base + 0x21),
		luck: v.getUint8(base + 0x22),
		evade: v.getUint8(base + 0x23),
		strength: v.getUint8(base + 0x24),
		defense: v.getUint8(base + 0x25),
		magic: v.getUint8(base + 0x26),
		magicDef: v.getUint8(base + 0x27),
		elements: Array.from(bytes.subarray(base + 0x28, base + 0x30)),
		elementRates: Array.from(bytes.subarray(base + 0x30, base + 0x38)),
		anims: Array.from(bytes.subarray(base + 0x38, base + 0x48)),
		attackIDs: Array.from({ length: 16 }, (_, i) =>
			v.getUint16(base + 0x48 + i * 2, true),
		),
		cameraIDs: Array.from({ length: 16 }, (_, i) =>
			v.getUint16(base + 0x68 + i * 2, true),
		),
		drops,
		manipAttacks,
		mp: v.getUint16(base + 0x9c, true),
		ap: v.getUint16(base + 0x9e, true),
		morphItem: morphRaw === 0xffff ? null : morphRaw,
		backAttackMul: v.getUint8(base + 0xa2),
		hp: v.getUint32(base + 0xa4, true),
		exp: v.getUint32(base + 0xa8, true),
		gil: v.getUint32(base + 0xac, true),
		statusImmunities: v.getUint32(base + 0xb0, true),
	};
}

function parseAttack(
	bytes: Uint8Array,
	v: DataView,
	base: number,
	slot: number,
	id: number,
): AttackRecord {
	const name = decodeFF7Text(
		bytes.subarray(SCENE_OFFSETS.attackNames + slot * 0x20, SCENE_OFFSETS.attackNames + slot * 0x20 + 0x20),
	);
	return {
		id,
		name,
		accuracy: v.getUint8(base + 0x00),
		impactEffectID: v.getUint8(base + 0x01),
		hurtActionID: v.getUint8(base + 0x02),
		mpCost: v.getUint16(base + 0x04, true),
		impactSfxID: v.getUint16(base + 0x06, true),
		cameraSingleID: v.getUint16(base + 0x08, true),
		cameraMultiID: v.getUint16(base + 0x0a, true),
		targetFlags: v.getUint8(base + 0x0c),
		attackEffectID: v.getUint8(base + 0x0d),
		damageCalcID: v.getUint8(base + 0x0e),
		strength: v.getUint8(base + 0x0f),
		conditionSubmenu: v.getUint8(base + 0x10),
		statusChange: v.getUint8(base + 0x11),
		additionalEffects: v.getUint8(base + 0x12),
		effectsModifier: v.getUint8(base + 0x13),
		statuses: v.getUint32(base + 0x14, true),
		elements: v.getUint16(base + 0x18, true),
		flags: v.getUint16(base + 0x1a, true),
	};
}

function parseAIBlock(
	bytes: Uint8Array,
	base: number,
	size: number,
	numEntities: number,
): AIBlock {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entities: (AIEntity | null)[] = [];
	for (let e = 0; e < numEntities; e++) {
		const ePtr = v.getUint16(base + e * 2, true);
		if (ePtr === 0xffff) {
			entities.push(null);
			continue;
		}
		const tableBase = base + ePtr;
		const scriptPtrs: number[] = [];
		for (let i = 0; i < 16; i++) {
			scriptPtrs.push(v.getUint16(tableBase + i * 2, true));
		}
		// Find this entity's upper bound = next entity's table base
		// (or end of block).
		let entityEnd = base + size;
		for (let e2 = e + 1; e2 < numEntities; e2++) {
			const p = v.getUint16(base + e2 * 2, true);
			if (p !== 0xffff) {
				entityEnd = base + p;
				break;
			}
		}
		const scripts: (AIScript | null)[] = [];
		for (let idx = 0; idx < 16; idx++) {
			const sPtr = scriptPtrs[idx]!;
			if (sPtr === 0xffff) {
				scripts.push(null);
				continue;
			}
			// Next script's start = upper bound (next non-FFFF slot,
			// or this entity's `entityEnd`).
			let nextStart = entityEnd;
			for (let j = idx + 1; j < 16; j++) {
				if (scriptPtrs[j] !== 0xffff) {
					nextStart = tableBase + scriptPtrs[j]!;
					break;
				}
			}
			let end = nextStart;
			while (end > tableBase + sPtr && bytes[end - 1] === 0xff) end--;
			scripts.push({
				slotIndex: idx,
				slotName: SCRIPT_SLOT_NAMES[idx] ?? `Slot ${idx}`,
				bytecode: bytes.subarray(tableBase + sPtr, end),
			});
		}
		entities.push({ scripts });
	}
	return { entities };
}
