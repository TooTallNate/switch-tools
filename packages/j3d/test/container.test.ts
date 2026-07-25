import { describe, expect, it } from 'vitest';

import {
	J3D_HEADER_SIZE,
	chunkOffset,
	findChunk,
	isJ3d,
	parseJ3d,
	parseJ3dContainer,
} from '../src/index.js';
import { buildChunk, buildContainer, buildFillerChunk } from './fixtures.js';

describe('isJ3d', () => {
	it('accepts every retail magic', () => {
		for (const magic of ['J3D2bmd3', 'J3D2bdl4', 'J3D1bmd1', 'J3D1bmd2']) {
			expect(isJ3d(buildContainer([], { magic }))).toBe(true);
		}
	});

	it('rejects other files', () => {
		expect(isJ3d(new Uint8Array(0))).toBe(false);
		// Right magic, but not enough bytes for a header.
		expect(isJ3d(new Uint8Array([0x4a, 0x33, 0x44, 0x32]))).toBe(false);
		expect(isJ3d(buildContainer([], { magic: 'J3D2xxx9' }))).toBe(false);
		expect(isJ3d(buildContainer([], { magic: 'J3DXbmd3' }))).toBe(false);
		expect(isJ3d(buildContainer([], { magic: 'RARCbmd3' }))).toBe(false);
		// A BTI, which has no magic at all and must not be mistaken for a model.
		expect(isJ3d(new Uint8Array(0x40))).toBe(false);
	});

	it('honours the offset argument', () => {
		const file = buildContainer([buildFillerChunk('INF1')]);
		const embedded = new Uint8Array(file.length + 16);
		embedded.set(file, 16);
		expect(isJ3d(embedded)).toBe(false);
		expect(isJ3d(embedded, 16)).toBe(true);
		expect(isJ3d(embedded, -1)).toBe(false);
		expect(isJ3d(embedded, 1.5)).toBe(false);
	});
});

describe('container walk', () => {
	it('enumerates chunks with absolute offsets and header-inclusive sizes', () => {
		const file = buildContainer([
			buildFillerChunk('INF1', 24),
			buildFillerChunk('VTX1', 8),
			buildFillerChunk('SHP1', 40),
		]);
		const c = parseJ3dContainer(file);
		expect(c).not.toBeNull();
		expect(c!.chunkCount).toBe(3);
		expect(c!.chunks.map((x) => x.magic)).toEqual(['INF1', 'VTX1', 'SHP1']);
		expect(c!.chunks[0].offset).toBe(J3D_HEADER_SIZE);
		expect(c!.chunks[0].size).toBe(24 + 8);
		expect(c!.chunks[1].offset).toBe(J3D_HEADER_SIZE + 32);
		expect(c!.chunks[1].size).toBe(8 + 8);
		expect(c!.chunks[2].offset).toBe(J3D_HEADER_SIZE + 32 + 16);
		expect(findChunk(c!.chunks, 'VTX1')).toBe(c!.chunks[1]);
		expect(findChunk(c!.chunks, 'MAT3')).toBeNull();
	});

	it('distinguishes bmd from bdl', () => {
		expect(parseJ3dContainer(buildContainer([]))!.kind).toBe('bmd');
		expect(parseJ3dContainer(buildContainer([]))!.version).toBe('J3D2bmd3');
		const bdl = parseJ3dContainer(buildContainer([], { magic: 'J3D2bdl4' }))!;
		expect(bdl.kind).toBe('bdl');
		expect(bdl.version).toBe('J3D2bdl4');
		const old = parseJ3dContainer(buildContainer([], { magic: 'J3D1bmd1' }))!;
		expect(old.kind).toBe('bmd');
		expect(old.version).toBe('J3D1bmd1');
	});

	it('skips chunks it does not understand', () => {
		const file = buildContainer([
			buildFillerChunk('MDL3', 64),
			buildFillerChunk('ANK1', 16),
			buildFillerChunk('TEX1', 16),
		]);
		const model = parseJ3d(file);
		expect(model).not.toBeNull();
		expect(model!.chunks.map((c) => c.magic)).toEqual(['MDL3', 'ANK1', 'TEX1']);
		expect(model!.vtx1).toBeNull();
		expect(model!.shp1).toBeNull();
		expect(model!.inf1).toBeNull();
	});

	it('rejects a chunk size below the 8-byte header without hanging', () => {
		// size 0 would leave the walk pointer where it is, forever.
		for (const size of [0, 1, 7]) {
			const file = buildContainer([
				buildChunk('INF1', (w) => w.fill(16), { sizeOverride: size }),
			]);
			expect(parseJ3dContainer(file)).toBeNull();
			expect(parseJ3d(file)).toBeNull();
		}
	});

	it('rejects a chunk that runs past the end of the buffer', () => {
		const file = buildContainer([
			buildChunk('VTX1', (w) => w.fill(16), { sizeOverride: 0x10000 }),
		]);
		expect(parseJ3dContainer(file)).toBeNull();
	});

	it('rejects an absurd chunk count instead of looping four billion times', () => {
		const file = buildContainer([buildFillerChunk('INF1')], {
			chunkCount: 0xffffffff,
		});
		expect(parseJ3dContainer(file)).toBeNull();
	});

	it('stops early when the header claims more chunks than the file holds', () => {
		const file = buildContainer([buildFillerChunk('INF1')], { chunkCount: 4 });
		const c = parseJ3dContainer(file);
		expect(c).not.toBeNull();
		expect(c!.chunks).toHaveLength(1);
	});

	it('uses fileSize to stop when the model is embedded in a larger buffer', () => {
		const inner = buildContainer([buildFillerChunk('INF1')]);
		// Append a second file's worth of bytes; the walk must not wander into it
		// even though the appended bytes happen to start with a plausible magic.
		const outer = new Uint8Array(inner.length + 64);
		outer.set(inner, 0);
		outer.set(new Uint8Array([0x54, 0x45, 0x58, 0x31]), inner.length);
		const c = parseJ3dContainer(outer);
		expect(c!.chunks).toHaveLength(1);
		expect(c!.fileSize).toBe(inner.length);
	});

	it('tolerates trailing garbage and a bogus fileSize', () => {
		const file = buildContainer([buildFillerChunk('INF1')], {
			trailing: 32,
			fileSize: 0xdeadbeef,
		});
		const c = parseJ3dContainer(file);
		expect(c).not.toBeNull();
		expect(c!.chunks).toHaveLength(1);
	});

	it('parses at a non-zero offset', () => {
		const file = buildContainer([buildFillerChunk('JNT1')]);
		const embedded = new Uint8Array(file.length + 0x20);
		embedded.set(file, 0x20);
		const c = parseJ3dContainer(embedded, 0x20);
		expect(c).not.toBeNull();
		expect(c!.chunks[0].offset).toBe(0x20 + J3D_HEADER_SIZE);
		expect(parseJ3dContainer(embedded, 0)).toBeNull();
	});

	it('returns null rather than throwing for junk', () => {
		expect(parseJ3d(new Uint8Array(0))).toBeNull();
		expect(parseJ3d(new Uint8Array(1024))).toBeNull();
		const random = new Uint8Array(512);
		for (let i = 0; i < random.length; i++) random[i] = (i * 37) & 0xff;
		expect(() => parseJ3d(random)).not.toThrow();
		expect(parseJ3d(random)).toBeNull();
	});
});

describe('chunkOffset', () => {
	const chunk = { magic: 'VTX1', offset: 0x100, size: 0x80 };

	it('resolves chunk-relative offsets to absolute ones', () => {
		expect(chunkOffset(chunk, 0x40)).toBe(0x140);
		expect(chunkOffset(chunk, 0x7f, 1)).toBe(0x17f);
	});

	it('rejects offsets that point into the chunk header or past its end', () => {
		// 0 is the format's "table absent" marker, and no table can start inside
		// the chunk's own 8-byte header.
		expect(chunkOffset(chunk, 0)).toBe(-1);
		expect(chunkOffset(chunk, 7)).toBe(-1);
		expect(chunkOffset(chunk, 0x80)).toBe(-1);
		expect(chunkOffset(chunk, 0x7c, 8)).toBe(-1);
	});
});
