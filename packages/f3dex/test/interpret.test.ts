import { describe, it, expect } from 'vitest';
import {
	interpretDisplayList,
	scanDisplayLists,
	decodeN64Texture,
	textureFormatName,
	ImageFormat,
	ImageSize,
	type Microcode,
} from '../src/index.js';

// ---------------------------------------------------------------
// Synthetic display-list builders.
//
// No commercial ROM data: every fixture is assembled command by
// command from the `gbi.h` macro definitions.
// ---------------------------------------------------------------

/** Append a big-endian u32. */
function u32(out: number[], v: number): void {
	out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

/** A 16-byte N64 vertex. */
function vertex(
	x: number,
	y: number,
	z: number,
	opts: {
		s?: number;
		t?: number;
		rgba?: [number, number, number, number];
	} = {},
): number[] {
	const out: number[] = [];
	const s16 = (v: number) => {
		const n = v < 0 ? v + 0x10000 : v;
		out.push((n >>> 8) & 0xff, n & 0xff);
	};
	s16(x);
	s16(y);
	s16(z);
	s16(0); // flag
	s16(opts.s ?? 0);
	s16(opts.t ?? 0);
	const [r, g, b, a] = opts.rgba ?? [255, 255, 255, 255];
	out.push(r, g, b, a);
	return out;
}

interface Cmd {
	w0: number;
	w1: number;
}

const cmds = {
	f3dex2: {
		vtx: (addr: number, n: number, v0: number): Cmd => ({
			w0: (0x01 << 24) | (n << 12) | ((v0 + n) << 1),
			w1: addr,
		}),
		tri1: (a: number, b: number, c: number): Cmd => ({
			w0: (0x05 << 24) | ((a * 2) << 16) | ((b * 2) << 8) | (c * 2),
			w1: 0,
		}),
		tri2: (
			a: number, b: number, c: number,
			d: number, e: number, f: number,
		): Cmd => ({
			w0: (0x06 << 24) | ((a * 2) << 16) | ((b * 2) << 8) | (c * 2),
			w1: ((d * 2) << 16) | ((e * 2) << 8) | (f * 2),
		}),
		enddl: (): Cmd => ({ w0: 0xdf << 24, w1: 0 }),
		dl: (addr: number, branch = false): Cmd => ({
			w0: (0xde << 24) | ((branch ? 1 : 0) << 16),
			w1: addr,
		}),
		geometryMode: (clear: number, set: number): Cmd => ({
			w0: (0xd9 << 24) | (~clear & 0x00ffffff),
			w1: set,
		}),
		mtx: (addr: number, params: number): Cmd => ({
			// F3DEX2 stores the push flag inverted.
			w0: (0xda << 24) | ((params ^ 0x01) << 16) | 64,
			w1: addr,
		}),
		popmtx: (): Cmd => ({ w0: 0xd8 << 24, w1: 0 }),
	},
	/**
	 * F3DEX v1 — shares F3D's opcodes but *not* its encodings:
	 * G_VTX packs v0/n/length differently and triangle indices are
	 * scaled by 2 rather than 10. Mario Kart 64 uses this.
	 */
	f3dex: {
		vtx: (addr: number, n: number, v0: number): Cmd => ({
			// v0 in bits 16-23, n in bits 10-15, (n*16 - 1) in 0-9.
			w0: (0x04 << 24) | (v0 << 16) | (n << 10) | (n * 16 - 1),
			w1: addr,
		}),
		tri1: (a: number, b: number, c: number): Cmd => ({
			w0: 0xbf << 24,
			w1: ((a * 2) << 16) | ((b * 2) << 8) | c * 2,
		}),
		tri2: (
			a: number, b: number, c: number,
			d: number, e: number, f: number,
		): Cmd => ({
			w0: (0xb1 << 24) | ((a * 2) << 16) | ((b * 2) << 8) | c * 2,
			w1: ((d * 2) << 16) | ((e * 2) << 8) | f * 2,
		}),
		enddl: (): Cmd => ({ w0: 0xb8 << 24, w1: 0 }),
	},
	f3d: {
		vtx: (addr: number, n: number, v0: number): Cmd => ({
			w0: (0x04 << 24) | (v0 << 16) | (n * 16),
			w1: addr,
		}),
		tri1: (a: number, b: number, c: number): Cmd => ({
			w0: 0xbf << 24,
			w1: ((a * 10) << 16) | ((b * 10) << 8) | (c * 10),
		}),
		enddl: (): Cmd => ({ w0: 0xb8 << 24, w1: 0 }),
		dl: (addr: number, branch = false): Cmd => ({
			w0: (0x06 << 24) | ((branch ? 1 : 0) << 16),
			w1: addr,
		}),
		setGeometryMode: (bits: number): Cmd => ({ w0: 0xb7 << 24, w1: bits }),
		clearGeometryMode: (bits: number): Cmd => ({ w0: 0xb6 << 24, w1: bits }),
	},
};

/** RDP commands (identical across microcodes). */
const rdp = {
	setTimg: (addr: number, fmt: number, siz: number): Cmd => ({
		w0: (0xfd << 24) | (fmt << 21) | (siz << 19),
		w1: addr,
	}),
	setTileSize: (width: number, height: number): Cmd => ({
		w0: 0xf2 << 24,
		w1: (((width - 1) * 4) << 12) | ((height - 1) * 4),
	}),
};

function assemble(list: Cmd[]): number[] {
	const out: number[] = [];
	for (const c of list) {
		u32(out, c.w0);
		u32(out, c.w1);
	}
	return out;
}

/**
 * Lay out a buffer as: display list at offset 0, vertex data at
 * `vtxOffset`. Segmented addresses use segment 6 (Zelda's object
 * segment) to prove the resolver ignores the segment byte.
 */
function buildBuffer(list: Cmd[], vertices: number[][], vtxOffset = 0x400) {
	const dl = assemble(list);
	const size = Math.max(vtxOffset + vertices.length * 16, dl.length);
	const buf = new Uint8Array(size);
	buf.set(dl, 0);
	vertices.forEach((v, i) => buf.set(v, vtxOffset + i * 16));
	return buf;
}

const SEG6 = 0x06000000;

describe('interpretDisplayList — F3DEX2', () => {
	it('decodes a single triangle with vertex colours', () => {
		const c = cmds.f3dex2;
		const buf = buildBuffer(
			[
				c.vtx(SEG6 | 0x400, 3, 0),
				c.tri1(0, 1, 2),
				c.enddl(),
			],
			[
				vertex(0, 0, 0, { rgba: [255, 0, 0, 255] }),
				vertex(100, 0, 0, { rgba: [0, 255, 0, 255] }),
				vertex(0, 100, 0, { rgba: [0, 0, 255, 255] }),
			],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.indices.length / 3).toBe(1);
		expect(m.positions.length / 3).toBe(3);
		expect(Array.from(m.positions)).toEqual([0, 0, 0, 100, 0, 0, 0, 100, 0]);
		// Colours round-trip through the 0..1 normalisation.
		expect(m.colors[0]).toBeCloseTo(1);
		expect(m.colors[4]).toBeCloseTo(1);
		expect(m.colors[8]).toBeCloseTo(1);
		expect(m.unknownCommands).toBe(0);
		expect(m.invalidTriangles).toBe(0);
		expect(m.truncated).toBe(false);
		expect(m.verticesLoaded).toBe(3);
	});

	it('decodes G_TRI2 as two triangles', () => {
		const c = cmds.f3dex2;
		const buf = buildBuffer(
			[c.vtx(SEG6 | 0x400, 4, 0), c.tri2(0, 1, 2, 0, 2, 3), c.enddl()],
			[
				vertex(0, 0, 0),
				vertex(10, 0, 0),
				vertex(10, 10, 0),
				vertex(0, 10, 0),
			],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.indices.length / 3).toBe(2);
		expect(m.positions.length / 3).toBe(6);
	});

	it('honours v0 when loading into the middle of the vertex cache', () => {
		const c = cmds.f3dex2;
		// Load 3 vertices at cache slot 5, then draw from 5,6,7.
		const buf = buildBuffer(
			[c.vtx(SEG6 | 0x400, 3, 5), c.tri1(5, 6, 7), c.enddl()],
			[vertex(1, 2, 3), vertex(4, 5, 6), vertex(7, 8, 9)],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(Array.from(m.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('follows G_DL into a nested list and returns', () => {
		const c = cmds.f3dex2;
		// Main list calls a child at 0x100, then draws its own tri.
		const main = assemble([
			c.vtx(SEG6 | 0x400, 3, 0),
			c.dl(SEG6 | 0x100),
			c.tri1(0, 1, 2),
			c.enddl(),
		]);
		const child = assemble([c.tri1(0, 1, 2), c.enddl()]);
		const buf = new Uint8Array(0x400 + 3 * 16);
		buf.set(main, 0);
		buf.set(child, 0x100);
		[vertex(0, 0, 0), vertex(5, 0, 0), vertex(0, 5, 0)].forEach((v, i) =>
			buf.set(v, 0x400 + i * 16),
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		// Child's triangle plus the main list's triangle.
		expect(m.indices.length / 3).toBe(2);
		expect(m.displayListCount).toBe(1);
	});

	it('treats a branching G_DL as a jump with no return', () => {
		const c = cmds.f3dex2;
		const main = assemble([
			c.vtx(SEG6 | 0x400, 3, 0),
			c.dl(SEG6 | 0x100, true),
			// Unreachable: the branch never comes back.
			c.tri1(0, 1, 2),
			c.enddl(),
		]);
		const child = assemble([c.tri1(0, 1, 2), c.enddl()]);
		const buf = new Uint8Array(0x400 + 3 * 16);
		buf.set(main, 0);
		buf.set(child, 0x100);
		[vertex(0, 0, 0), vertex(5, 0, 0), vertex(0, 5, 0)].forEach((v, i) =>
			buf.set(v, 0x400 + i * 16),
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.indices.length / 3).toBe(1);
	});

	it('applies the matrix stack, and G_POPMTX restores it', () => {
		const c = cmds.f3dex2;
		// A translation matrix at 0x200: +1000 on X.
		const mtx = new Uint8Array(64);
		const setInt = (i: number, j: number, v: number) => {
			const o = i * 8 + j * 2;
			const n = v < 0 ? v + 0x10000 : v;
			mtx[o] = (n >>> 8) & 0xff;
			mtx[o + 1] = n & 0xff;
		};
		setInt(0, 0, 1);
		setInt(1, 1, 1);
		setInt(2, 2, 1);
		setInt(3, 3, 1);
		setInt(3, 0, 1000); // translate X
		// params: bit0 = push, bit1 = load.
		const main = assemble([
			c.mtx(SEG6 | 0x200, 0x03), // push + load
			c.vtx(SEG6 | 0x400, 3, 0),
			c.tri1(0, 1, 2),
			c.popmtx(),
			c.vtx(SEG6 | 0x400, 3, 0),
			c.tri1(0, 1, 2),
			c.enddl(),
		]);
		const buf = new Uint8Array(0x400 + 3 * 16);
		buf.set(main, 0);
		buf.set(mtx, 0x200);
		[vertex(0, 0, 0), vertex(5, 0, 0), vertex(0, 5, 0)].forEach((v, i) =>
			buf.set(v, 0x400 + i * 16),
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.indices.length / 3).toBe(2);
		// First triangle is translated, second is back at the origin.
		expect(m.positions[0]).toBeCloseTo(1000);
		expect(m.positions[9]).toBeCloseTo(0);
	});

	it('reads normals instead of colours when G_LIGHTING is set', () => {
		const c = cmds.f3dex2;
		const G_LIGHTING = 0x00020000;
		const buf = buildBuffer(
			[
				c.geometryMode(0, G_LIGHTING),
				c.vtx(SEG6 | 0x400, 3, 0),
				c.tri1(0, 1, 2),
				c.enddl(),
			],
			[
				// 0x7F ≈ +1.0 along X after normalisation.
				vertex(0, 0, 0, { rgba: [0x7f, 0, 0, 255] }),
				vertex(5, 0, 0, { rgba: [0x7f, 0, 0, 255] }),
				vertex(0, 5, 0, { rgba: [0x7f, 0, 0, 255] }),
			],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.usesLighting).toBe(true);
		expect(m.normals[0]).toBeCloseTo(1);
		// Colour stays white so normal bytes aren't shown as RGB.
		expect(m.colors[0]).toBeCloseTo(1);
		expect(m.colors[1]).toBeCloseTo(1);
	});

	it('groups triangles by texture state and normalises UVs', () => {
		const c = cmds.f3dex2;
		const list = [
			rdp.setTimg(SEG6 | 0x800, ImageFormat.RGBA, ImageSize.BITS_16),
			rdp.setTileSize(32, 32),
			c.vtx(SEG6 | 0x400, 3, 0),
			c.tri1(0, 1, 2),
			// Switch to a different texture: a new group must open.
			rdp.setTimg(SEG6 | 0x900, ImageFormat.RGBA, ImageSize.BITS_16),
			rdp.setTileSize(32, 32),
			c.tri1(0, 1, 2),
			c.enddl(),
		];
		const buf = buildBuffer(list, [
			// s/t are S10.5: 32 texels × 32 = 1024.
			vertex(0, 0, 0, { s: 0, t: 0 }),
			vertex(5, 0, 0, { s: 1024, t: 0 }),
			vertex(0, 5, 0, { s: 0, t: 1024 }),
		]);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.materials.length).toBe(2);
		expect(m.groups.length).toBe(2);
		expect(m.groups[0].numTriangles).toBe(1);
		expect(m.groups[1].numTriangles).toBe(1);
		expect(m.materials[0].width).toBe(32);
		expect(m.materials[0].formatName).toBe('RGBA16');
		// s=1024 → 1024/32 = 32 texels → /32 width = 1.0
		expect(m.uvs[2]).toBeCloseTo(1);
		expect(m.uvs[5]).toBeCloseTo(1);
	});

	it('reports invalid triangle indices instead of crashing', () => {
		// A G_TRI1 whose packed bytes are not multiples of 2.
		const buf = new Uint8Array(64);
		const list: number[] = [];
		u32(list, (0x05 << 24) | (0x01 << 16) | (0x03 << 8) | 0x05);
		u32(list, 0);
		u32(list, 0xdf << 24);
		u32(list, 0);
		buf.set(list, 0);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.invalidTriangles).toBe(1);
		expect(m.indices.length).toBe(0);
	});

	it('does not throw on random bytes and reports the damage', () => {
		const rnd = new Uint8Array(2048);
		let seed = 12345;
		for (let i = 0; i < rnd.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			rnd[i] = (seed >> 16) & 0xff;
		}
		const m = interpretDisplayList(rnd, 0, { microcode: 'f3dex2' });
		expect(m.unknownCommands).toBeGreaterThan(0);
	});

	it('stops at maxCommands and flags truncation', () => {
		// An infinite self-branch.
		const c = cmds.f3dex2;
		const buf = new Uint8Array(64);
		buf.set(assemble([c.dl(SEG6 | 0x000, true)]), 0);
		const m = interpretDisplayList(buf, 0, {
			microcode: 'f3dex2',
			maxCommands: 100,
		});
		expect(m.truncated).toBe(true);
		expect(m.truncationReason).toMatch(/commands/);
	});

	it('respects a custom segment resolver', () => {
		const c = cmds.f3dex2;
		// The real vertices live at 0x400, but the list points at
		// segment 9 offset 0. The default resolver keeps the low 24
		// bits, so it reads offset 0 — the display list's own bytes,
		// i.e. garbage. A custom resolver rebases onto the real data.
		const buf = buildBuffer(
			[c.vtx(0x09000000, 3, 0), c.tri1(0, 1, 2), c.enddl()],
			[vertex(7, 7, 7), vertex(8, 8, 8), vertex(9, 9, 9)],
		);
		const withDefault = interpretDisplayList(buf, 0, {
			microcode: 'f3dex2',
		});
		// It "resolves" (to offset 0) but decodes nonsense.
		expect(withDefault.positions[0]).not.toBe(7);
		const withCustom = interpretDisplayList(buf, 0, {
			microcode: 'f3dex2',
			resolveSegment: (addr) =>
				addr >>> 24 === 0x09 ? 0x400 + (addr & 0xffffff) : null,
		});
		expect(withCustom.verticesLoaded).toBe(3);
		expect(Array.from(withCustom.positions.subarray(0, 3))).toEqual([7, 7, 7]);
	});

	it('a resolver returning null skips the vertex load entirely', () => {
		const c = cmds.f3dex2;
		const buf = buildBuffer(
			[c.vtx(0x09000000, 3, 0), c.tri1(0, 1, 2), c.enddl()],
			[vertex(7, 7, 7), vertex(8, 8, 8), vertex(9, 9, 9)],
		);
		const m = interpretDisplayList(buf, 0, {
			microcode: 'f3dex2',
			resolveSegment: () => null,
		});
		expect(m.verticesLoaded).toBe(0);
	});
});

describe('interpretDisplayList — F3D', () => {
	it('decodes vertices and triangles with the F3D encoding', () => {
		const c = cmds.f3d;
		const buf = buildBuffer(
			[c.vtx(0x0e000400, 3, 0), c.tri1(0, 1, 2), c.enddl()],
			[vertex(1, 0, 0), vertex(0, 1, 0), vertex(0, 0, 1)],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3d' });
		expect(m.indices.length / 3).toBe(1);
		expect(Array.from(m.positions)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
		expect(m.unknownCommands).toBe(0);
		expect(m.invalidTriangles).toBe(0);
	});

	it('uses the separate set/clear geometry-mode commands', () => {
		const c = cmds.f3d;
		const G_LIGHTING = 0x00020000;
		const buf = buildBuffer(
			[
				c.setGeometryMode(G_LIGHTING),
				c.vtx(0x0e000400, 3, 0),
				c.tri1(0, 1, 2),
				c.clearGeometryMode(G_LIGHTING),
				c.vtx(0x0e000400, 3, 0),
				c.tri1(0, 1, 2),
				c.enddl(),
			],
			[
				vertex(0, 0, 0, { rgba: [0x7f, 0, 0, 255] }),
				vertex(5, 0, 0, { rgba: [0x7f, 0, 0, 255] }),
				vertex(0, 5, 0, { rgba: [0x7f, 0, 0, 255] }),
			],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3d' });
		expect(m.usesLighting).toBe(true);
		// First triangle lit (white colour), second unlit (red).
		expect(m.colors[0]).toBeCloseTo(1);
		expect(m.colors[1]).toBeCloseTo(1);
		expect(m.colors[9]).toBeCloseTo(0x7f / 255);
		expect(m.colors[10]).toBeCloseTo(0);
	});

	it('rejects F3DEX2 index scaling (proves the microcodes differ)', () => {
		// Build with F3D macros, interpret as F3DEX2: the *10 index
		// scaling is not a multiple of 2 for most indices, so the
		// triangle is rejected rather than silently mis-decoded.
		const c = cmds.f3d;
		const buf = buildBuffer(
			[c.vtx(0x0e000400, 3, 0), c.tri1(0, 1, 3), c.enddl()],
			[vertex(1, 0, 0), vertex(0, 1, 0), vertex(0, 0, 1), vertex(2, 2, 2)],
		);
		const asF3dex2 = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(asF3dex2.indices.length / 3).toBe(0);
	});
});

describe('scanDisplayLists', () => {
	/** Place a valid display list at `at` inside a noisy buffer. */
	function bufferWithListAt(
		at: number,
		microcode: Microcode,
		triangles = 12,
	): Uint8Array {
		const c = microcode === 'f3dex2' ? cmds.f3dex2 : cmds.f3d;
		const list: Cmd[] = [c.vtx(0x06000800, 16, 0)];
		for (let i = 0; i < triangles; i++) {
			list.push(c.tri1(i % 14, (i + 1) % 14, (i + 2) % 14));
		}
		list.push(c.enddl());
		const dl = assemble(list);
		const buf = new Uint8Array(0x800 + 16 * 16);
		// Deterministic noise everywhere first.
		let seed = 999;
		for (let i = 0; i < buf.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			buf[i] = (seed >> 16) & 0xff;
		}
		buf.set(dl, at);
		for (let i = 0; i < 16; i++) {
			buf.set(
				vertex(i * 10 - 80, (i % 4) * 20, (i % 3) * 15, {
					rgba: [200, 100, 50, 255],
				}),
				0x800 + i * 16,
			);
		}
		return buf;
	}

	/**
	 * Find the hit corresponding to a planted list.
	 *
	 * A reported offset can sit a little *before* the planted one:
	 * preceding bytes sometimes decode as harmless commands (a NOP,
	 * a sync, a state setter) that simply flow into the real list.
	 * The geometry is identical, so the contract is "a hit that
	 * covers the planted offset", not an exact address match.
	 */
	function hitCovering(
		refs: ReturnType<typeof scanDisplayLists>,
		at: number,
	) {
		return refs.find((r) => r.offset <= at && r.offset > at - 0x80);
	}

	it('finds a planted F3DEX2 display list', () => {
		const buf = bufferWithListAt(0x100, 'f3dex2');
		const refs = scanDisplayLists(buf, {
			minTriangles: 8,
			microcodes: ['f3dex2'],
		});
		const hit = hitCovering(refs, 0x100);
		expect(hit).toBeDefined();
		expect(hit!.microcode).toBe('f3dex2');
		expect(hit!.triangleCount).toBe(12);
	});

	it('finds a planted F3D display list', () => {
		const buf = bufferWithListAt(0x200, 'f3d');
		const refs = scanDisplayLists(buf, {
			minTriangles: 8,
			microcodes: ['f3d'],
		});
		const hit = hitCovering(refs, 0x200);
		expect(hit).toBeDefined();
		expect(hit!.microcode).toBe('f3d');
		expect(hit!.triangleCount).toBe(12);
	});

	it('reports a bounding box for the geometry it found', () => {
		const buf = bufferWithListAt(0x100, 'f3dex2');
		const hit = hitCovering(
			scanDisplayLists(buf, { minTriangles: 8, microcodes: ['f3dex2'] }),
			0x100,
		)!;
		expect(hit.min[0]).toBeLessThan(hit.max[0]);
		expect(Number.isFinite(hit.min[0])).toBe(true);
	});

	it('does not report display lists in pure noise', () => {
		const buf = new Uint8Array(8192);
		let seed = 4242;
		for (let i = 0; i < buf.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			buf[i] = (seed >> 16) & 0xff;
		}
		expect(scanDisplayLists(buf, { minTriangles: 8 })).toEqual([]);
	});

	it('respects minTriangles', () => {
		const buf = bufferWithListAt(0x100, 'f3dex2', 10);
		expect(
			scanDisplayLists(buf, { minTriangles: 32, microcodes: ['f3dex2'] }),
		).toEqual([]);
		expect(
			scanDisplayLists(buf, { minTriangles: 8, microcodes: ['f3dex2'] })
				.length,
		).toBeGreaterThan(0);
	});
});

describe('N64 texture decoding', () => {
	it('names formats', () => {
		expect(textureFormatName(ImageFormat.RGBA, ImageSize.BITS_16)).toBe('RGBA16');
		expect(textureFormatName(ImageFormat.CI, ImageSize.BITS_4)).toBe('CI4');
		expect(textureFormatName(ImageFormat.IA, ImageSize.BITS_8)).toBe('IA8');
	});

	it('decodes RGBA16 (5551)', () => {
		// Pure red = 0xF801 (r=31, g=0, b=0, a=1).
		const data = Uint8Array.from([0xf8, 0x01, 0x00, 0x01]);
		const out = decodeN64Texture(data, 0, 2, 1, ImageFormat.RGBA, ImageSize.BITS_16)!;
		expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255]);
		// Second texel: all channels 0, alpha bit set → opaque black.
		expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 0, 255]);
	});

	it('decodes RGBA32 verbatim', () => {
		const data = Uint8Array.from([1, 2, 3, 4]);
		const out = decodeN64Texture(data, 0, 1, 1, ImageFormat.RGBA, ImageSize.BITS_32)!;
		expect(Array.from(out)).toEqual([1, 2, 3, 4]);
	});

	it('decodes CI4 through a TLUT', () => {
		// Two texels: indices 0 and 1, packed in one byte.
		const data = Uint8Array.from([0x01]);
		// TLUT entry 0 = red, entry 1 = opaque black.
		const tlut = Uint8Array.from([0xf8, 0x01, 0x00, 0x01]);
		const out = decodeN64Texture(
			data, 0, 2, 1, ImageFormat.CI, ImageSize.BITS_4, { tlut },
		)!;
		expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255]);
		expect(Array.from(out.subarray(4, 8))).toEqual([0, 0, 0, 255]);
	});

	it('falls back to greyscale indices when no TLUT is available', () => {
		// CI8: one byte per texel, so 2 texels need 2 bytes.
		const out = decodeN64Texture(
			Uint8Array.from([0x0f, 0x80]), 0, 2, 1, ImageFormat.CI, ImageSize.BITS_8,
		)!;
		// Index rendered as grey; opaque.
		expect(out[0]).toBe(15);
		expect(out[3]).toBe(255);
		expect(out[4]).toBe(128);
	});

	it('decodes IA8 into grey + alpha', () => {
		// 0xF0 → intensity 0xF→255, alpha 0x0→0.
		const out = decodeN64Texture(
			Uint8Array.from([0xf0]), 0, 1, 1, ImageFormat.IA, ImageSize.BITS_8,
		)!;
		expect(Array.from(out)).toEqual([255, 255, 255, 0]);
	});

	it('decodes I8 as opaque grey', () => {
		const out = decodeN64Texture(
			Uint8Array.from([0x80]), 0, 1, 1, ImageFormat.I, ImageSize.BITS_8,
		)!;
		expect(Array.from(out)).toEqual([128, 128, 128, 255]);
	});

	it('returns null for unsupported formats and short buffers', () => {
		expect(
			decodeN64Texture(new Uint8Array(4), 0, 8, 8, ImageFormat.YUV, ImageSize.BITS_16),
		).toBeNull();
		// 8×8 RGBA16 needs 128 bytes.
		expect(
			decodeN64Texture(new Uint8Array(4), 0, 8, 8, ImageFormat.RGBA, ImageSize.BITS_16),
		).toBeNull();
	});
});

describe('external textures', () => {
	it('does not resolve a texture from a segment other than the geometry', () => {
		const c = cmds.f3dex2;
		// Geometry in segment 6; texture claims segment 8. Masking
		// the segment off would land inside the buffer and decode
		// unrelated bytes as pixels — it must be flagged external
		// instead.
		const buf = buildBuffer(
			[
				rdp.setTimg(0x08000100, ImageFormat.RGBA, ImageSize.BITS_16),
				rdp.setTileSize(8, 8),
				c.vtx(SEG6 | 0x400, 3, 0),
				c.tri1(0, 1, 2),
				c.enddl(),
			],
			[vertex(0, 0, 0), vertex(5, 0, 0), vertex(0, 5, 0)],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.materials).toHaveLength(1);
		expect(m.materials[0].textureAddress).toBe(0x08000100);
		expect(m.materials[0].externalTexture).toBe(true);
		expect(m.materials[0].textureOffset).toBeNull();
	});

	it('resolves a texture in the same segment as the geometry', () => {
		const c = cmds.f3dex2;
		const buf = buildBuffer(
			[
				rdp.setTimg(SEG6 | 0x100, ImageFormat.RGBA, ImageSize.BITS_16),
				rdp.setTileSize(8, 8),
				c.vtx(SEG6 | 0x400, 3, 0),
				c.tri1(0, 1, 2),
				c.enddl(),
			],
			[vertex(0, 0, 0), vertex(5, 0, 0), vertex(0, 5, 0)],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(m.materials[0].externalTexture).toBe(false);
		expect(m.materials[0].textureOffset).toBe(0x100);
	});
});

describe('interpretDisplayList — F3DEX (v1)', () => {
	it('decodes the F3DEX G_VTX packing (v0/n/length)', () => {
		const c = cmds.f3dex;
		const buf = buildBuffer(
			[c.vtx(0x0d000400, 3, 0), c.tri1(0, 1, 2), c.enddl()],
			[vertex(11, 0, 0), vertex(0, 22, 0), vertex(0, 0, 33)],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex' });
		expect(m.verticesLoaded).toBe(3);
		expect(Array.from(m.positions)).toEqual([11, 0, 0, 0, 22, 0, 0, 0, 33]);
		expect(m.invalidTriangles).toBe(0);
		expect(m.unknownCommands).toBe(0);
	});

	it('matches the real Mario Kart 64 command encoding', () => {
		// Verbatim from Mario Kart 64 (USA) at ROM 0xE9960:
		//   0400207f  -> G_VTX  n=8, v0=0, len=n*16-1=127
		//   bf000000 00000204 -> G_TRI1 indices (0,2,4)/2 = 0,1,2
		const buf = new Uint8Array(0x400 + 8 * 16);
		const bytes: number[] = [];
		u32(bytes, 0x0400207f);
		u32(bytes, 0x0d000400);
		u32(bytes, 0xbf000000);
		u32(bytes, 0x00000204);
		u32(bytes, 0xb8000000);
		u32(bytes, 0x00000000);
		buf.set(bytes, 0);
		for (let i = 0; i < 8; i++) {
			buf.set(vertex(i * 10, i * 2, i * 3), 0x400 + i * 16);
		}
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex' });
		// n=8 vertices loaded, one triangle from cache slots 0,1,2.
		expect(m.verticesLoaded).toBe(8);
		expect(m.indices.length / 3).toBe(1);
		expect(Array.from(m.positions.subarray(0, 9))).toEqual([
			0, 0, 0, 10, 2, 3, 20, 4, 6,
		]);
	});

	it('uses ×2 triangle index scaling, not F3D’s ×10', () => {
		const c = cmds.f3dex;
		const buf = buildBuffer(
			[c.vtx(0x0d000400, 4, 0), c.tri2(0, 1, 2, 0, 2, 3), c.enddl()],
			[
				vertex(0, 0, 0),
				vertex(10, 0, 0),
				vertex(10, 10, 0),
				vertex(0, 10, 0),
			],
		);
		const m = interpretDisplayList(buf, 0, { microcode: 'f3dex' });
		expect(m.indices.length / 3).toBe(2);
		expect(m.invalidTriangles).toBe(0);
		// The same bytes read as F3D produce fractional indices and
		// are rejected — this is what made MK64 look empty.
		const asF3d = interpretDisplayList(buf, 0, { microcode: 'f3d' });
		expect(asF3d.indices.length).toBe(0);
		expect(asF3d.invalidTriangles).toBeGreaterThan(0);
	});

	it('is found by the scanner and distinguished from F3D', () => {
		const c = cmds.f3dex;
		const list: Cmd[] = [c.vtx(0x0d000800, 16, 0)];
		for (let i = 0; i < 10; i++) {
			list.push(c.tri1(i % 14, (i + 1) % 14, (i + 2) % 14));
		}
		list.push(c.enddl());
		const buf = new Uint8Array(0x800 + 16 * 16);
		let seed = 77;
		for (let i = 0; i < buf.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			buf[i] = (seed >> 16) & 0xff;
		}
		buf.set(assemble(list), 0x100);
		for (let i = 0; i < 16; i++) {
			buf.set(
				vertex(i * 8 - 60, (i % 5) * 12, (i % 3) * 9),
				0x800 + i * 16,
			);
		}
		const refs = scanDisplayLists(buf, { minTriangles: 8 });
		const hit = refs.find((r) => r.offset <= 0x100 && r.offset > 0x80);
		expect(hit).toBeDefined();
		expect(hit!.microcode).toBe('f3dex');
		expect(hit!.triangleCount).toBe(10);
	});
});

describe('maxIdleCommands', () => {
	it('aborts a run of valid commands that never draws anything', () => {
		// 300 G_RDPPIPESYNC commands: all valid, none draw.
		const list: Cmd[] = [];
		for (let i = 0; i < 300; i++) list.push({ w0: 0xe7 << 24, w1: 0 });
		list.push(cmds.f3dex2.enddl());
		const buf = Uint8Array.from(assemble(list));
		const unlimited = interpretDisplayList(buf, 0, { microcode: 'f3dex2' });
		expect(unlimited.truncated).toBe(false);
		// 300 syncs plus the terminating G_ENDDL.
		expect(unlimited.commandCount).toBe(301);

		const capped = interpretDisplayList(buf, 0, {
			microcode: 'f3dex2',
			maxIdleCommands: 64,
		});
		expect(capped.truncated).toBe(true);
		expect(capped.truncationReason).toMatch(/without geometry/);
		expect(capped.commandCount).toBeLessThan(80);
	});

	it('does not abort a list that keeps drawing', () => {
		const c = cmds.f3dex2;
		const list: Cmd[] = [c.vtx(SEG6 | 0x1000, 3, 0)];
		// Interleave state commands with triangles: the idle counter
		// resets on every draw, so a long list survives a small cap.
		for (let i = 0; i < 100; i++) {
			list.push({ w0: 0xe7 << 24, w1: 0 });
			list.push({ w0: 0xe7 << 24, w1: 0 });
			list.push(c.tri1(0, 1, 2));
		}
		list.push(c.enddl());
		// The list is ~2.4 KB, so park the vertices well past it —
		// the default 0x400 would sit inside the command stream.
		const buf = buildBuffer(
			list,
			[vertex(0, 0, 0), vertex(5, 0, 0), vertex(0, 5, 0)],
			0x1000,
		);
		const m = interpretDisplayList(buf, 0, {
			microcode: 'f3dex2',
			maxIdleCommands: 16,
		});
		expect(m.truncated).toBe(false);
		expect(m.indices.length / 3).toBe(100);
	});
});
