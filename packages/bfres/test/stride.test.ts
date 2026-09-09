import { describe, it, expect } from 'vitest';
import { extractGeometry, extractMaterials } from '../src/index.js';

const shapeNames = ['trunk', 'branches', 'canopy'];
const materialNames = ['bark', 'leaves'];
const textureNames = ['bark_albedo', 'leaves_albedo'];
const samplerNames = ['_a0', '_a1'];
const materialIndices = [0, 0, 1];
const triangles = [
	[0, 0, 0, 1, 0, 0, 0, 1, 0],
	[2, 3, 4, 3, 3, 4, 2, 4, 4],
	[-2, 5, -1, -1, 5, -1, -2, 6, -1],
];

// One FMDL, three inline FSHP records, two inline FMAT records.
// Only the fields needed to extract positions, indices and bindings are populated.
function buildFixture(version: number, shapeStride: number, materialStride: number) {
	const data = new Uint8Array(0x1900);
	const v = new DataView(data.buffer);
	const enc = new TextEncoder();
	const text = (off: number, value: string) => data.set(enc.encode(value), off);
	const ptr = (off: number, value: number) => v.setBigUint64(off, BigInt(value), true);
	const u16 = (off: number, value: number) => v.setUint16(off, value, true);
	const u32 = (off: number, value: number) => v.setUint32(off, value, true);
	let pool = 0x1000;
	function string(value: string) {
		const off = pool;
		pool += (value.length + 4) & ~1;
		u16(off, value.length);
		text(off + 2, value);
		return off;
	}
	function dict(names: string[]) {
		const off = pool;
		pool += 8 + (names.length + 1) * 16;
		text(off, '_DIC');
		u32(off + 4, names.length);
		names.forEach((name, i) => ptr(off + 0x20 + i * 16, string(name)));
		return off;
	}

	const modern = (version >>> 16) >= 9;
	const headerSize = modern ? 0x08 : 0x10;
	text(0, 'FRES    ');
	u32(0x08, version);
	u16(0x0c, 0xfeff);
	data[0x0e] = 0x0c;
	u32(0x1c, data.length);
	ptr(0x28, 0x100);
	ptr(0x30, dict(['tree']));
	ptr(modern ? 0xb0 : 0x90, 0x180); // BufferInfo
	u32(0x184, 0x100);
	ptr(0x188, 0x1800); // GPU data base

	text(0x100, 'FMDL');
	const model = 0x100 + headerSize;
	ptr(model, string('tree'));
	ptr(model + 0x18, 0x800);
	ptr(model + 0x20, 0x200);
	ptr(model + 0x28, dict(shapeNames));
	ptr(model + 0x30, 0x400);
	ptr(model + 0x38, dict(materialNames));
	u16(0x168, 3);
	u16(0x16a, 3);
	u16(0x16c, 2);

	shapeNames.forEach((name, i) => {
		const shape = 0x200 + i * shapeStride;
		const vertex = 0x800 + i * 0x180;
		const mesh = vertex + 0x80;
		const attrib = vertex + 0xc0;
		text(shape, 'FSHP');
		ptr(shape + headerSize, string(name));
		ptr(shape + headerSize + 8, vertex);
		ptr(shape + headerSize + 16, mesh);
		const counts = shape + (modern ? 0x50 : 0x5c);
		u16(counts, i);
		u16(counts + 2, materialIndices[i]);
		u16(counts + 6, i);
		data[counts + 11] = 1; // One Mesh LOD, not the FSHP record stride.

		text(vertex, 'FVTX');
		const fields = vertex + headerSize;
		ptr(fields, attrib);
		ptr(fields + 0x28, vertex + 0xd0); // buffer size array
		ptr(fields + 0x30, vertex + 0xe0); // vertex stride array
		u32(fields + 0x40, i * 0x40);
		data[fields + 0x44] = 1; // attribute count
		data[fields + 0x45] = 1; // buffer count
		u16(fields + 0x46, i);
		u32(fields + 0x48, 3);
		ptr(attrib, string('_p0'));
		v.setUint16(attrib + 8, 0x0518, false); // float32 XYZ, format is big-endian
		u32(vertex + 0xd0, 36);
		u32(vertex + 0xe0, 12);

		u32(mesh + 0x20, i * 0x40 + 0x28);
		u32(mesh + 0x24, 3); // triangles
		u32(mesh + 0x28, 1); // uint16 indices
		u32(mesh + 0x2c, 3);
		triangles[i].forEach((value, j) => v.setFloat32(0x1800 + i * 0x40 + j * 4, value, true));
		[0, 1, 2].forEach((value, j) => u16(0x1828 + i * 0x40 + j * 2, value));
	});

	materialNames.forEach((name, i) => {
		const material = 0x400 + i * materialStride;
		const textures = 0x700 + i * 8;
		text(material, 'FMAT');
		ptr(material + headerSize, string(name));
		ptr(material + (modern ? 0x30 : 0x38), textures);
		ptr(textures, string(textureNames[i]));
		ptr(material + (modern ? 0x48 : 0x50), dict([samplerNames[i]]));
		data[material + (modern ? 0x9c : 0xa8)] = 1;
		data[material + (modern ? 0x9d : 0xa9)] = 1;
	});
	return data;
}

describe('BFRES inline record strides', () => {
	it.each([
		{ layout: 'v9.1 FSHP 0x60 / FMAT 0xa8', version: 0x00090100, shapeStride: 0x60, materialStride: 0xa8 },
		{ layout: 'v9.1 FSHP 0x60 / FMAT 0xa0', version: 0x00090100, shapeStride: 0x60, materialStride: 0xa0 },
		{ layout: 'v9 FSHP 0x68 / FMAT 0xa8', version: 0x00090000, shapeStride: 0x68, materialStride: 0xa8 },
		{ layout: 'v9 FSHP 0x68 / FMAT 0xa0', version: 0x00090000, shapeStride: 0x68, materialStride: 0xa0 },
		{ layout: 'v9 FSHP 0x68 / FMAT 0xb0', version: 0x00090000, shapeStride: 0x68, materialStride: 0xb0 },
		{ layout: 'v9 FSHP 0x68 / FMAT 0xb8', version: 0x00090000, shapeStride: 0x68, materialStride: 0xb8 },
		{ layout: 'v5 FSHP 0x70 / FMAT 0xb8', version: 0x00050003, shapeStride: 0x70, materialStride: 0xb8 },
	])('extracts all shapes and material bindings: $layout', async ({ version, shapeStride, materialStride }) => {
		const data = buildFixture(version, shapeStride, materialStride);
		const blob = new Blob([data as BlobPart]);
		const geometry = await extractGeometry(blob);
		const materials = await extractMaterials(blob);
		expect(geometry).toHaveLength(3);
		expect(geometry.map((shape) => shape.name)).toEqual(shapeNames);
		expect(geometry.map((shape) => shape.materialIndex)).toEqual(materialIndices);
		expect(materials).toEqual([materialNames.map((name, i) => ({
			name,
			textureRefs: [textureNames[i]],
			samplers: [samplerNames[i]],
			bindings: [{ samplerName: samplerNames[i], textureName: textureNames[i] }],
		}))]);
		geometry.forEach((shape, i) => {
			expect(shape.modelIndex).toBe(0);
			expect(shape.vertexCount).toBe(3);
			expect(shape.primitiveType).toBe('triangles');
			expect(shape.positions).toEqual(new Float32Array(triangles[i]));
			expect(shape.indices).toEqual(new Uint16Array([0, 1, 2]));
			expect(materials[shape.modelIndex][shape.materialIndex].name).toBe(materialNames[materialIndices[i]]);
		});
	});

	it('keeps earlier geometry when the final FSHP signature is missing', async () => {
		const data = buildFixture(0x00090100, 0x60, 0xa8);
		data.fill(0, 0x200 + 2 * 0x60, 0x200 + 2 * 0x60 + 4);
		const geometry = await extractGeometry(new Blob([data as BlobPart]));
		expect(geometry.map((shape) => shape.name)).toEqual(['trunk', 'branches']);
		expect(geometry[1].positions).toEqual(new Float32Array(triangles[1]));
	});
});
