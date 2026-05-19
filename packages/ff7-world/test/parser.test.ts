import { describe, it, expect } from 'vitest';
import {
	parseWorldMap,
	sectorVertexWorld,
	SECTOR_WORLD_SIZE,
	SECTION_SIZE,
	OVERWORLD_TEXTURES,
	UNDERWATER_TEXTURES,
	GLACIER_TEXTURES,
	WALKMAP_NAMES,
	REGION_NAMES,
	texturesForMap,
	kindFromSectionCount,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Texture tables (verify counts + named entries match Braver)
// ---------------------------------------------------------------------------

describe('OVERWORLD_TEXTURES', () => {
	it('has exactly 282 entries', () => {
		expect(OVERWORLD_TEXTURES).toHaveLength(282);
	});
	it('id 0 is "pond"', () => {
		expect(OVERWORLD_TEXTURES[0]).toMatchObject({
			id: 0,
			name: 'pond',
			width: 32,
			height: 32,
		});
	});
	it('last entry id matches array index', () => {
		const last = OVERWORLD_TEXTURES[OVERWORLD_TEXTURES.length - 1]!;
		expect(last.id).toBe(OVERWORLD_TEXTURES.length - 1);
		// "wtrk" is the canonical last entry in Braver's table.
		expect(last.name).toBe('wtrk');
	});
});

describe('UNDERWATER_TEXTURES', () => {
	it('has 8 entries', () => {
		expect(UNDERWATER_TEXTURES).toHaveLength(8);
	});
});

describe('GLACIER_TEXTURES', () => {
	it('has 4 entries', () => {
		expect(GLACIER_TEXTURES).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

describe('WALKMAP_NAMES', () => {
	it('has 32 entries', () => {
		expect(WALKMAP_NAMES).toHaveLength(32);
	});
	it('starts with Grass / Forest / Mountain', () => {
		expect(WALKMAP_NAMES.slice(0, 3)).toEqual(['Grass', 'Forest', 'Mountain']);
	});
});

describe('REGION_NAMES', () => {
	it('starts with Midgar', () => {
		expect(REGION_NAMES[0]).toBe('Midgar Area');
	});
});

// ---------------------------------------------------------------------------
// Map detection
// ---------------------------------------------------------------------------

describe('kindFromSectionCount', () => {
	it('returns overworld for 60+ sections', () => {
		expect(kindFromSectionCount(63)).toBe('overworld');
		expect(kindFromSectionCount(68)).toBe('overworld');
		expect(kindFromSectionCount(69)).toBe('overworld');
	});
	it('returns underwater for 8..16 sections', () => {
		expect(kindFromSectionCount(12)).toBe('underwater');
	});
	it('returns glacier for fewer than 8', () => {
		expect(kindFromSectionCount(4)).toBe('glacier');
	});
});

describe('texturesForMap', () => {
	it('routes each kind to the matching table', () => {
		expect(texturesForMap('overworld')).toBe(OVERWORLD_TEXTURES);
		expect(texturesForMap('underwater')).toBe(UNDERWATER_TEXTURES);
		expect(texturesForMap('glacier')).toBe(GLACIER_TEXTURES);
	});
});

// ---------------------------------------------------------------------------
// Map parser (synthetic — too complex to author a full mesh blob,
// but we can verify the outer-container scan + grid detection.)
// ---------------------------------------------------------------------------

describe('parseWorldMap', () => {
	it('rejects sizes that are not a multiple of section size', () => {
		expect(() => parseWorldMap(new Uint8Array(SECTION_SIZE - 1))).toThrow(
			/multiple of/,
		);
	});

	it('detects WM3 layout from a 4-section file', () => {
		const bytes = new Uint8Array(SECTION_SIZE * 4); // all-zero
		// All section pointers are 0 → no mesh data → empty sectors.
		const world = parseWorldMap(bytes);
		expect(world.sections).toHaveLength(4);
		expect(world.gridWidth).toBe(2);
		expect(world.gridHeight).toBe(2);
		expect(world.liveSections).toBe(4);
	});

	it('detects WM2 layout from a 12-section file', () => {
		const world = parseWorldMap(new Uint8Array(SECTION_SIZE * 12));
		expect(world.gridWidth).toBe(3);
		expect(world.gridHeight).toBe(4);
	});

	it('detects WM0 layout (9 × 7 + alternates) from a 68- or 69-section file', () => {
		const w68 = parseWorldMap(new Uint8Array(SECTION_SIZE * 68));
		expect(w68.gridWidth).toBe(9);
		expect(w68.gridHeight).toBe(7);
		expect(w68.liveSections).toBe(63);
		const w69 = parseWorldMap(new Uint8Array(SECTION_SIZE * 69));
		expect(w69.gridWidth).toBe(9);
		expect(w69.gridHeight).toBe(7);
		expect(w69.liveSections).toBe(63);
	});
});

// ---------------------------------------------------------------------------
// World-space helper
// ---------------------------------------------------------------------------

describe('sectorVertexWorld', () => {
	it('translates by sector offset + section grid', () => {
		const sector = {
			sectorIndex: 5,
			gridX: 1,
			gridZ: 1,
			offsetX: SECTOR_WORLD_SIZE,
			offsetZ: SECTOR_WORLD_SIZE,
			triangles: [],
			vertices: [],
			normals: [],
		};
		// Section (0, 0) — no additional offset.
		const w = sectorVertexWorld({ x: 100, y: 200, z: 300 }, sector, 0, 0);
		expect(w).toEqual({
			x: 100 + SECTOR_WORLD_SIZE,
			y: 200,
			z: 300 + SECTOR_WORLD_SIZE,
		});
		// Section (2, 3) — adds 2 × 4 × SECTOR_WORLD_SIZE on X, 3 × 4 × on Z.
		const w2 = sectorVertexWorld({ x: 0, y: 0, z: 0 }, sector, 2, 3);
		expect(w2.x).toBe(SECTOR_WORLD_SIZE + 2 * 4 * SECTOR_WORLD_SIZE);
		expect(w2.z).toBe(SECTOR_WORLD_SIZE + 3 * 4 * SECTOR_WORLD_SIZE);
	});
});
