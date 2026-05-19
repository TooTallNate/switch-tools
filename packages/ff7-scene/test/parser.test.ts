import { describe, it, expect } from 'vitest';
import { decodeFF7Text } from '../src/text.js';
import {
	iterateSceneBinBlocks,
	validateSceneBytes,
	SCENE_BLOCK_SIZE,
	SCENE_DECOMPRESSED_SIZE,
	SceneBinParseError,
} from '../src/archive.js';
import {
	parseScene,
	SCRIPT_SLOT_NAMES,
	SceneParseError,
} from '../src/scene.js';

// ---------------------------------------------------------------------------
// Text decoder
// ---------------------------------------------------------------------------

describe('decodeFF7Text', () => {
	it('decodes basic Latin-range characters', () => {
		// FF7 char table: 0x01='!', 0x20='@', 0x21='A', 0x41='a'.
		expect(decodeFF7Text(new Uint8Array([0x01, 0x20, 0x21, 0x41]))).toBe('!@Aa');
	});

	it('stops at 0xFF (terminator/pad)', () => {
		// 0x21='A', 0x22='B', 0x23='C'
		expect(decodeFF7Text(new Uint8Array([0x21, 0x22, 0xff, 0x23]))).toBe('AB');
	});

	it('honors a maxLen cap', () => {
		expect(decodeFF7Text(new Uint8Array([0x21, 0x22, 0x23]), 2)).toBe('AB');
	});

	it('expands character-name escape codes', () => {
		// 0xEA = "Cloud"
		expect(decodeFF7Text(new Uint8Array([0xea]))).toBe('Cloud');
		// 0xEC = "Tifa"
		expect(decodeFF7Text(new Uint8Array([0xec]))).toBe('Tifa');
	});

	it('expands newline (0xE7) and tab (0xE1)', () => {
		expect(decodeFF7Text(new Uint8Array([0x21, 0xe7, 0x22]))).toBe('A\nB');
		expect(decodeFF7Text(new Uint8Array([0x21, 0xe1, 0x22]))).toBe('A\tB');
	});

	it('skips known color codes (0xFE D2..0xFE DB)', () => {
		// 0xFE 0xD4 = "red"; we just drop the 2 bytes
		expect(decodeFF7Text(new Uint8Array([0xfe, 0xd4, 0x21]))).toBe('A');
	});

	it('surfaces unknown 0xFE codes with a hex placeholder', () => {
		expect(decodeFF7Text(new Uint8Array([0xfe, 0x77]))).toBe('<FE 77>');
	});

	it('decodes the empty string', () => {
		expect(decodeFF7Text(new Uint8Array([]))).toBe('');
		expect(decodeFF7Text(new Uint8Array([0xff]))).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Outer container
// ---------------------------------------------------------------------------

describe('iterateSceneBinBlocks', () => {
	it('yields nothing for an empty buffer', () => {
		const results = Array.from(iterateSceneBinBlocks(new Uint8Array(0)));
		expect(results).toHaveLength(0);
	});

	it('yields nothing when the buffer is shorter than one block', () => {
		const results = Array.from(iterateSceneBinBlocks(new Uint8Array(4000)));
		expect(results).toHaveLength(0);
	});

	it('walks one block with two pointers', () => {
		const block = new Uint8Array(SCENE_BLOCK_SIZE).fill(0xff);
		const view = new DataView(block.buffer);
		// pointers[0] = 0x40 >> 2 = 0x10 (scene #0 starts at 0x40)
		// pointers[1] = 0x80 >> 2 = 0x20 (scene #1 starts at 0x80)
		view.setUint32(0, 0x10, true);
		view.setUint32(4, 0x20, true);
		// scene #0: bytes 0x40..0x4F = "00112233 44556677 ..." (16 unique bytes)
		for (let i = 0; i < 16; i++) block[0x40 + i] = 0x10 + i;
		// scene #1: bytes 0x80..0x8F = different content
		for (let i = 0; i < 16; i++) block[0x80 + i] = 0xa0 + i;
		const yielded = Array.from(iterateSceneBinBlocks(block));
		expect(yielded).toHaveLength(2);
		expect(yielded[0]!.sceneIndex).toBe(0);
		expect(yielded[1]!.sceneIndex).toBe(1);
		// First scene: 0x40..0x80 with trailing 0xFF stripped — should
		// be 16 unique bytes since 0x50..0x7F is all 0xFF padding.
		expect(yielded[0]!.compressed.length).toBe(16);
		expect(Array.from(yielded[0]!.compressed.subarray(0, 4))).toEqual([
			0x10, 0x11, 0x12, 0x13,
		]);
	});

	it('uses end-of-block for the last scene', () => {
		const block = new Uint8Array(SCENE_BLOCK_SIZE).fill(0xff);
		const view = new DataView(block.buffer);
		view.setUint32(0, 0x10, true);
		// Only one pointer; subsequent slots are 0xFFFFFFFF.
		for (let i = 0; i < 16; i++) block[0x40 + i] = 0xab;
		const yielded = Array.from(iterateSceneBinBlocks(block));
		expect(yielded).toHaveLength(1);
		expect(yielded[0]!.compressed.length).toBe(16);
	});

	it('numbers scenes monotonically across multiple blocks', () => {
		const buf = new Uint8Array(SCENE_BLOCK_SIZE * 2).fill(0xff);
		const v = new DataView(buf.buffer);
		// Block 0: pointers at slots 0 and 1
		v.setUint32(0, 0x10, true);
		v.setUint32(4, 0x20, true);
		for (let i = 0; i < 16; i++) buf[0x40 + i] = 1;
		for (let i = 0; i < 16; i++) buf[0x80 + i] = 2;
		// Block 1: pointer at slot 0
		v.setUint32(SCENE_BLOCK_SIZE + 0, 0x10, true);
		for (let i = 0; i < 16; i++) buf[SCENE_BLOCK_SIZE + 0x40 + i] = 3;
		const yielded = Array.from(iterateSceneBinBlocks(buf));
		expect(yielded.map((x) => x.sceneIndex)).toEqual([0, 1, 2]);
	});
});

describe('validateSceneBytes', () => {
	it('accepts 0x1E80', () => {
		expect(() => validateSceneBytes(new Uint8Array(0x1e80))).not.toThrow();
	});
	it('rejects PSX-JP 0x1C50 with a specific message', () => {
		expect(() => validateSceneBytes(new Uint8Array(0x1c50))).toThrow(
			/PSX-JP/,
		);
	});
	it('rejects arbitrary sizes', () => {
		expect(() => validateSceneBytes(new Uint8Array(1234))).toThrow(/Expected/);
	});
});

// ---------------------------------------------------------------------------
// Scene parser
// ---------------------------------------------------------------------------

describe('parseScene', () => {
	it('rejects the wrong buffer size', () => {
		expect(() => parseScene(new Uint8Array(0x1c50))).toThrow(SceneParseError);
	});

	it('parses an all-empty scene', () => {
		// All 0xFF — every "is empty" sentinel triggers.
		const bytes = new Uint8Array(0x1e80).fill(0xff);
		const scene = parseScene(bytes, 42);
		expect(scene.sceneIndex).toBe(42);
		expect(scene.enemies).toEqual([null, null, null]);
		expect(scene.attacks).toHaveLength(0);
		expect(scene.formations).toHaveLength(4);
		// All formation slots should be (0xFFFF) empty
		for (const f of scene.formations) {
			expect(f.slots.every((s) => s.enemyID === 0xffff)).toBe(true);
		}
		expect(scene.formationAI.entities).toEqual([null, null, null, null]);
		expect(scene.enemyAI.entities).toEqual([null, null, null]);
	});

	it('decodes enemy name with high-byte ASCII characters', () => {
		const bytes = new Uint8Array(0x1e80).fill(0xff);
		const v = new DataView(bytes.buffer);
		// Slot 0 enemy model ID
		v.setUint16(0, 1, true);
		// Enemy 0 at 0x298 — write "Hi!" using FF7 char codes:
		// 0x28='H', 0x49='i', 0x01='!'.
		bytes[0x298 + 0] = 0x28; // 'H'
		bytes[0x298 + 1] = 0x49; // 'i'
		bytes[0x298 + 2] = 0x01; // '!'
		// Rest of name = 0xFF padding (already filled)
		// Set HP at 0xA4 to 1234
		v.setUint32(0x298 + 0xa4, 1234, true);
		const scene = parseScene(bytes);
		expect(scene.enemies[0]!.name).toBe('Hi!');
		expect(scene.enemies[0]!.hp).toBe(1234);
	});
});

describe('SCRIPT_SLOT_NAMES', () => {
	it('has 16 entries including the standard ones', () => {
		expect(SCRIPT_SLOT_NAMES).toHaveLength(16);
		expect(SCRIPT_SLOT_NAMES[0]).toBe('Initialize');
		expect(SCRIPT_SLOT_NAMES[1]).toBe('Main');
		expect(SCRIPT_SLOT_NAMES[2]).toBe('General Counter');
	});
});
