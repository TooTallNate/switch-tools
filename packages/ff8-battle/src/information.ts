/**
 * FFVIII battle DAT — Section 7: Information (380-byte enemy stats record).
 *
 * Layout (section-relative, per FFRTT wiki and OpenVIII reference impl):
 *
 *   offset   size  type              field
 *    0x000    24   u8[24]            name              (FF8-encoded; trailing 0x00)
 *    0x018     4   u8[4]             hp                (polynomial coefficients)
 *    0x01C     4   u8[4]             str
 *    0x020     4   u8[4]             vit
 *    0x024     4   u8[4]             mag
 *    0x028     4   u8[4]             spr
 *    0x02C     4   u8[4]             spd
 *    0x030     4   u8[4]             eva
 *    0x034    64   Ability[16]       abilitiesLow      (4 bytes each)
 *    0x074    64   Ability[16]       abilitiesMed
 *    0x0B4    64   Ability[16]       abilitiesHigh
 *    0x0F4     1   u8                medLevelStart     (level threshold for med set)
 *    0x0F5     1   u8                highLevelStart    (level threshold for high set)
 *    0x0F6     1   u8                flag1a            (unknown flags, 3 bits used)
 *    0x0F7     1   u8                flag1b            ([Zombie/Fly/zz1/zz2/zz3/AutoReflect/AutoShell/AutoProtect])
 *    0x0F8     3   u8[3]             cards             (low/med/high)
 *    0x0FB     3   u8[3]             devour            (low/med/high)
 *    0x0FE     1   u8                flag2a            ([zz1/zz2/unused×4/DiablosMissed/AlwaysObtainsCard])
 *    0x0FF     1   u8                flag2b            (unknown flags, 4 bits used)
 *    0x100     2   u16               expExtra
 *    0x102     2   u16               exp
 *    0x104     8   Draw[4]           drawLow           (8 bytes = 4 × {u8 magicId, u8 qty})
 *    0x10C     8   Draw[4]           drawMed
 *    0x114     8   Draw[4]           drawHigh
 *    0x11C     8   Drop[4]           mugLow            (4 × {u8 itemId, u8 qty})
 *    0x124     8   Drop[4]           mugMed
 *    0x12C     8   Drop[4]           mugHigh
 *    0x134     8   Drop[4]           dropLow
 *    0x13C     8   Drop[4]           dropMed
 *    0x144     8   Drop[4]           dropHigh
 *    0x14C     1   u8                mugRate
 *    0x14D     1   u8                dropRate
 *    0x14E     1   u8                padding
 *    0x14F     1   u8                ap
 *    0x150    16   u8[16]            unknown           (unparsed)
 *    0x160     8   u8[8]             elementalResistance  (Fire, Ice, Thunder, Earth, Poison, Wind, Water, Holy)
 *    0x168    20   u8[20]            statusResistance     (20 status flags — see field comment)
 *   ────────
 *    0x17C  =  380 bytes total
 *
 * Ability record (4 bytes):
 *     u8  kernelId    (0x02 = magic, 0x04 = item, 0x08 = monster ability)
 *     u8  animation   (animation slot)
 *     u16 abilityId   (id within the kernel table)
 *
 * Draw / Mug / Drop record (8 bytes total, 4 × {u8 id, u8 qty}):
 *     u8 id  (magicId for Draw, itemId for Mug/Drop)
 *     u8 qty (always 0 for Draw)
 *     (repeat 4 times)
 *
 * Resistance bytes are 0..255 where smaller = more resistant (per FF8 conventions);
 * this decoder leaves them raw and lets the caller interpret.
 *
 * Status resistance order (20 bytes):
 *   Death, Poison, Petrify, Darkness,
 *   Silence, Berserk, Zombie, Sleep,
 *   Haste, Slow, Stop, Regen,
 *   Reflect, Doom, SlowPetrify, Float,
 *   Confuse, Drain, Expulsion, (unknown)
 */

import { DatParseError } from './header.js';
import { decodeFF8Text } from './text.js';

export const INFORMATION_SIZE = 380 as const;
export const INFORMATION_NAME_LEN = 24 as const;

export interface DatAbility {
	kernelId: number; // 0x02=magic, 0x04=item, 0x08=monster ability
	animation: number; // u8
	abilityId: number; // u16
}

export interface DatDrop {
	itemId: number; // u8
	qty: number; // u8
}

export interface DatInformation {
	name: string;
	hp: [number, number, number, number];
	str: [number, number, number, number];
	vit: [number, number, number, number];
	mag: [number, number, number, number];
	spr: [number, number, number, number];
	spd: [number, number, number, number];
	eva: [number, number, number, number];
	abilitiesLow: DatAbility[]; // 16 entries
	abilitiesMed: DatAbility[];
	abilitiesHigh: DatAbility[];
	medLevelStart: number;
	highLevelStart: number;
	cards: [number, number, number];
	devour: [number, number, number];
	exp: number;
	expExtra: number;
	ap: number;
	drawLow: DatDrop[]; // 4 slots
	drawMed: DatDrop[];
	drawHigh: DatDrop[];
	mugLow: DatDrop[];
	mugMed: DatDrop[];
	mugHigh: DatDrop[];
	dropLow: DatDrop[];
	dropMed: DatDrop[];
	dropHigh: DatDrop[];
	mugRate: number;
	dropRate: number;
	elementalResistance: number[]; // 8
	statusResistance: number[]; // 20
	flag1: number; // byte at 0xF7
	flag2: number; // byte at 0xFE
	/** Three additional flag/unknown bytes for completeness. */
	flag1a: number; // byte at 0xF6
	flag2b: number; // byte at 0xFF
}

function safeU8(bytes: Uint8Array, off: number): number {
	return off < bytes.length ? bytes[off]! : 0;
}

function safeU16(bytes: Uint8Array, off: number): number {
	if (off + 1 >= bytes.length) return safeU8(bytes, off);
	return bytes[off]! | (bytes[off + 1]! << 8);
}

function read4(bytes: Uint8Array, off: number): [number, number, number, number] {
	return [
		safeU8(bytes, off + 0),
		safeU8(bytes, off + 1),
		safeU8(bytes, off + 2),
		safeU8(bytes, off + 3),
	];
}

function readAbilities(bytes: Uint8Array, off: number): DatAbility[] {
	const out: DatAbility[] = [];
	for (let i = 0; i < 16; i++) {
		const base = off + i * 4;
		out.push({
			kernelId: safeU8(bytes, base + 0),
			animation: safeU8(bytes, base + 1),
			abilityId: safeU16(bytes, base + 2),
		});
	}
	return out;
}

function readDrops(bytes: Uint8Array, off: number): DatDrop[] {
	const out: DatDrop[] = [];
	for (let i = 0; i < 4; i++) {
		out.push({
			itemId: safeU8(bytes, off + i * 2 + 0),
			qty: safeU8(bytes, off + i * 2 + 1),
		});
	}
	return out;
}

function readBytes(bytes: Uint8Array, off: number, n: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(safeU8(bytes, off + i));
	return out;
}

export function parseInformation(
	bytes: Uint8Array,
	sectionOffset: number,
): DatInformation {
	if (sectionOffset >= bytes.length) {
		throw new DatParseError(
			`Information section offset ${sectionOffset} past EOF (${bytes.length})`,
		);
	}
	const slice = bytes.subarray(sectionOffset);

	const O_NAME = 0x000;
	const O_HP = 0x018;
	const O_STR = 0x01c;
	const O_VIT = 0x020;
	const O_MAG = 0x024;
	const O_SPR = 0x028;
	const O_SPD = 0x02c;
	const O_EVA = 0x030;
	const O_AB_LOW = 0x034;
	const O_AB_MED = 0x074;
	const O_AB_HIGH = 0x0b4;
	const O_MED_LEVEL = 0x0f4;
	const O_HIGH_LEVEL = 0x0f5;
	const O_FLAG1A = 0x0f6;
	const O_FLAG1 = 0x0f7;
	const O_CARDS = 0x0f8;
	const O_DEVOUR = 0x0fb;
	const O_FLAG2 = 0x0fe;
	const O_FLAG2B = 0x0ff;
	const O_EXP_EXTRA = 0x100;
	const O_EXP = 0x102;
	const O_DRAW_LOW = 0x104;
	const O_DRAW_MED = 0x10c;
	const O_DRAW_HIGH = 0x114;
	const O_MUG_LOW = 0x11c;
	const O_MUG_MED = 0x124;
	const O_MUG_HIGH = 0x12c;
	const O_DROP_LOW = 0x134;
	const O_DROP_MED = 0x13c;
	const O_DROP_HIGH = 0x144;
	const O_MUG_RATE = 0x14c;
	const O_DROP_RATE = 0x14d;
	const O_AP = 0x14f;
	const O_ELEM_RES = 0x160;
	const O_STATUS_RES = 0x168;

	const nameBytes = slice.subarray(O_NAME, O_NAME + INFORMATION_NAME_LEN);

	return {
		name: decodeFF8Text(nameBytes, INFORMATION_NAME_LEN),
		hp: read4(slice, O_HP),
		str: read4(slice, O_STR),
		vit: read4(slice, O_VIT),
		mag: read4(slice, O_MAG),
		spr: read4(slice, O_SPR),
		spd: read4(slice, O_SPD),
		eva: read4(slice, O_EVA),
		abilitiesLow: readAbilities(slice, O_AB_LOW),
		abilitiesMed: readAbilities(slice, O_AB_MED),
		abilitiesHigh: readAbilities(slice, O_AB_HIGH),
		medLevelStart: safeU8(slice, O_MED_LEVEL),
		highLevelStart: safeU8(slice, O_HIGH_LEVEL),
		flag1a: safeU8(slice, O_FLAG1A),
		flag1: safeU8(slice, O_FLAG1),
		cards: [
			safeU8(slice, O_CARDS + 0),
			safeU8(slice, O_CARDS + 1),
			safeU8(slice, O_CARDS + 2),
		],
		devour: [
			safeU8(slice, O_DEVOUR + 0),
			safeU8(slice, O_DEVOUR + 1),
			safeU8(slice, O_DEVOUR + 2),
		],
		flag2: safeU8(slice, O_FLAG2),
		flag2b: safeU8(slice, O_FLAG2B),
		expExtra: safeU16(slice, O_EXP_EXTRA),
		exp: safeU16(slice, O_EXP),
		drawLow: readDrops(slice, O_DRAW_LOW),
		drawMed: readDrops(slice, O_DRAW_MED),
		drawHigh: readDrops(slice, O_DRAW_HIGH),
		mugLow: readDrops(slice, O_MUG_LOW),
		mugMed: readDrops(slice, O_MUG_MED),
		mugHigh: readDrops(slice, O_MUG_HIGH),
		dropLow: readDrops(slice, O_DROP_LOW),
		dropMed: readDrops(slice, O_DROP_MED),
		dropHigh: readDrops(slice, O_DROP_HIGH),
		mugRate: safeU8(slice, O_MUG_RATE),
		dropRate: safeU8(slice, O_DROP_RATE),
		ap: safeU8(slice, O_AP),
		elementalResistance: readBytes(slice, O_ELEM_RES, 8),
		statusResistance: readBytes(slice, O_STATUS_RES, 20),
	};
}
