import { describe, it, expect } from 'vitest';
import { decodeNutTexture, parseNud, parseNut, parseVbn, vbnWorldMatrices } from '../src/index.js';

/** One 4×4 RGBA8 (format 14, stored ARGB) texture in an NTWD v2 pack. */
function buildNut(hash: number): Uint8Array {
	const header = 0x50;
	const data = 4 * 4 * 4;
	const out = new Uint8Array(0x10 + header + data);
	const dv = new DataView(out.buffer);
	out.set([0x4e, 0x54, 0x57, 0x44]);
	dv.setUint16(4, 0x0200, false);
	dv.setUint16(6, 1, true);
	const h = 0x10;
	dv.setUint32(h, header + data, true);
	dv.setUint32(h + 0x08, data, true);
	dv.setUint16(h + 0x0c, header, true);
	out[h + 0x11] = 1;
	out[h + 0x13] = 14;
	dv.setUint16(h + 0x14, 4, true);
	dv.setUint16(h + 0x16, 4, true);
	dv.setInt32(h + 0x20, header, true);
	out.set([0x65, 0x58, 0x74, 0x00], h + 0x30);
	out.set([0x47, 0x49, 0x44, 0x58], h + 0x40);
	dv.setUint32(h + 0x44, 0x10, true);
	dv.setUint32(h + 0x48, hash, true);
	for (let i = 0; i < 16; i++) out.set([0xff, i * 16, 0x80, 0x40], h + header + i * 4); // A R G B
	return out;
}

/** A NUD with one unskinned, float-normal triangle-strip quad. */
function buildNud(): Uint8Array {
	const vertexStride = 12 + 20 + 4 + 4; // pos, normal (type 1), colour, one half UV
	const verts = 4;
	const index = new Uint16Array([0, 1, 2, 3]);
	const indexClump = 8;
	const vertClump = verts * vertexStride;
	const names = new TextEncoder().encode('quad\0');
	const meshOff = 0x30;
	const polyOff = meshOff + 0x30;
	const matOff = polyOff + 0x30;
	const matSize = 0x20 + 0x18;
	const clumpStart = matOff + matSize;
	const total = clumpStart + indexClump + vertClump + names.byteLength;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	out.set([0x4e, 0x44, 0x57, 0x44]);
	dv.setUint32(4, total, true);
	dv.setUint16(8, 0x0200, false);
	dv.setUint16(0x0a, 1, true);
	dv.setInt32(0x10, clumpStart - 0x30, true);
	dv.setInt32(0x14, indexClump, true);
	dv.setInt32(0x18, vertClump, true);
	dv.setInt32(0x1c, 0, true);
	dv.setInt32(meshOff + 0x20, 0, true); // name offset
	dv.setInt16(meshOff + 0x28, -1, true);
	dv.setUint16(meshOff + 0x2a, 1, true);
	dv.setInt32(polyOff, 0, true);
	dv.setInt32(polyOff + 4, 0, true);
	dv.setInt32(polyOff + 8, 0, true);
	dv.setUint16(polyOff + 0x0c, verts, true);
	out[polyOff + 0x0e] = 0x01; // no bones, float normals
	out[polyOff + 0x0f] = 0x12; // 1 UV, byte colours, half UVs
	dv.setInt32(polyOff + 0x10, matOff, true);
	dv.setUint16(polyOff + 0x20, index.length, true);
	dv.setUint16(polyOff + 0x22, 0x0004, true); // strips
	dv.setUint16(matOff + 0x0a, 1, true);
	dv.setUint32(matOff + 0x20, 0x40001234, true);
	new Uint8Array(out.buffer, clumpStart, 8).set(new Uint8Array(index.buffer));
	const corners = [
		[0, 0],
		[1, 0],
		[0, 1],
		[1, 1],
	];
	corners.forEach(([x, y], v) => {
		const o = clumpStart + indexClump + v * vertexStride;
		dv.setFloat32(o, x!, true);
		dv.setFloat32(o + 4, y!, true);
		dv.setFloat32(o + 8, 0, true);
		dv.setFloat32(o + 12 + 4, 0, true);
		dv.setFloat32(o + 12 + 8, 0, true);
		dv.setFloat32(o + 12 + 12, 1, true);
		out.set([0x80, 0x40, 0x00, 0x80], o + 32);
		dv.setUint16(o + 36, x ? 0x3c00 : 0, true); // half 1.0
		dv.setUint16(o + 38, y ? 0x3800 : 0, true); // half 0.5
	});
	out.set(names, clumpStart + indexClump + vertClump);
	return out;
}

describe('NUT', () => {
	it('parses NTWD headers and decodes ARGB pixels', () => {
		const bytes = buildNut(0x20001006);
		const nut = parseNut(bytes);
		expect(nut.littleEndian).toBe(true);
		expect(nut.textures).toHaveLength(1);
		const [t] = nut.textures;
		expect(t).toMatchObject({ hashId: 0x20001006, width: 4, height: 4, format: 14, mipCount: 1, cubemap: false });
		const img = decodeNutTexture(bytes, t!);
		expect(Array.from(img.pixels.subarray(4, 8))).toEqual([16, 0x80, 0x40, 0xff]);
	});
});

describe('NUD', () => {
	it('reads vertices, strips and material texture hashes', () => {
		const nud = parseNud(buildNud());
		expect(nud.meshes).toHaveLength(1);
		const [m] = nud.meshes;
		expect(m!.name).toBe('quad');
		const [p] = m!.polygons;
		expect(p!.vertexCount).toBe(4);
		expect(Array.from(p!.positions.subarray(9, 12))).toEqual([1, 1, 0]);
		expect(Array.from(p!.normals!.subarray(0, 3))).toEqual([0, 0, 1]);
		expect(Array.from(p!.uvs!.subarray(6, 8))).toEqual([1, 0.5]);
		expect(Array.from(p!.colors!.subarray(0, 4))).toEqual([1, 0.5, 0, 1]);
		// Strip 0 1 2 3 → two triangles, alternating winding.
		expect(Array.from(p!.indices)).toEqual([1, 2, 0, 3, 2, 1]);
		expect(p!.materials[0]!.textures[0]!.hash).toBe(0x40001234);
	});
});

describe('VBN', () => {
	it('parses big-endian bones and composes world matrices', () => {
		const count = 2;
		const out = new Uint8Array(0x18 + count * 0x4c + count * 36);
		const dv = new DataView(out.buffer);
		out.set(new TextEncoder().encode('VBN '));
		dv.setUint32(8, count, false);
		const names = ['root', 'child'];
		names.forEach((n, i) => {
			const o = 0x18 + i * 0x4c;
			out.set(new TextEncoder().encode(n), o);
			dv.setInt32(o + 0x44, i === 0 ? 0x0fffffff : 0, false);
			dv.setUint32(o + 0x48, i, false);
		});
		const t = 0x18 + count * 0x4c;
		// root: translate (1,0,0), rotate 90° about Z; child: translate (1,0,0).
		const values = [
			[1, 0, 0, 0, 0, Math.PI / 2, 1, 1, 1],
			[1, 0, 0, 0, 0, 0, 1, 1, 1],
		];
		values.forEach((v, i) => v.forEach((f, k) => dv.setFloat32(t + i * 36 + k * 4, f, false)));
		const bones = parseVbn(out);
		expect(bones.map((b) => [b.name, b.parent])).toEqual([
			['root', -1],
			['child', 0],
		]);
		const world = vbnWorldMatrices(bones);
		// The child's origin: root's (1,0,0) plus its +X rotated onto +Y.
		expect(world[1]![12]).toBeCloseTo(1);
		expect(world[1]![13]).toBeCloseTo(1);
		expect(world[1]![14]).toBeCloseTo(0);
	});
});
