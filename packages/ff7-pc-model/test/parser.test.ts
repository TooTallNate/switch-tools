import { describe, it, expect } from 'vitest';
import { parseHrc, isHrc } from '../src/hrc.js';
import { parseRsd, isRsd } from '../src/rsd.js';
import { parsePMesh, isPMesh, extractTrianglesForGroup } from '../src/p.js';
import { parseTex, isTex } from '../src/tex.js';
import { parseAnim, isAnim, AnimParseError } from '../src/a.js';

const enc = new TextEncoder();

describe('HRC parser', () => {
	it('recognises an HRC header', () => {
		expect(isHrc(enc.encode(':HEADER_BLOCK 2\n'))).toBe(true);
		expect(isHrc(enc.encode('@RSD940102\n'))).toBe(false);
		expect(isHrc(new Uint8Array(0))).toBe(false);
	});

	it('parses a minimal one-bone skeleton', () => {
		const text = `:HEADER_BLOCK 2
:SKELETON n_test_sk
:BONES 1

hip
root
1.7457236
1 AAAB
`;
		const parsed = parseHrc(enc.encode(text));
		expect(parsed.headerBlock).toBe(2);
		expect(parsed.skeletonName).toBe('n_test_sk');
		expect(parsed.boneCount).toBe(1);
		expect(parsed.bones).toHaveLength(1);
		expect(parsed.bones[0]).toEqual({
			name: 'hip',
			parent: 'root',
			length: 1.7457236,
			rsds: ['AAAB'],
		});
	});

	it('handles bones without attached RSDs', () => {
		const text = `:HEADER_BLOCK 2
:SKELETON test
:BONES 2

hip
root
2.5
0

chest
hip
3.0
1 AAAB
`;
		const parsed = parseHrc(enc.encode(text));
		expect(parsed.bones).toHaveLength(2);
		expect(parsed.bones[0]!.rsds).toEqual([]);
		expect(parsed.bones[1]!.rsds).toEqual(['AAAB']);
	});

	it('tolerates CRLF line endings', () => {
		const text = ':HEADER_BLOCK 2\r\n:SKELETON test\r\n:BONES 1\r\n\r\nhip\r\nroot\r\n1.5\r\n1 AAAB\r\n';
		const parsed = parseHrc(enc.encode(text));
		expect(parsed.bones[0]!.name).toBe('hip');
		expect(parsed.bones[0]!.length).toBe(1.5);
	});
});

describe('RSD parser', () => {
	it('recognises an RSD header', () => {
		expect(isRsd(enc.encode('@RSD940102\n'))).toBe(true);
		expect(isRsd(enc.encode(':HEADER_BLOCK 2\n'))).toBe(false);
	});

	it('parses PLY/MAT/GRP + textures', () => {
		const text = `@RSD940102
PLY=AAAC.PLY
MAT=AAAC.MAT
GRP=AAAC.GRP
NTEX=2
TEX[0]=CLOUD0
TEX[1]=CLOUD1
`;
		const parsed = parseRsd(enc.encode(text));
		expect(parsed.version).toBe('@RSD940102');
		expect(parsed.ply).toBe('AAAC');
		expect(parsed.mat).toBe('AAAC');
		expect(parsed.grp).toBe('AAAC');
		expect(parsed.textures).toEqual(['CLOUD0', 'CLOUD1']);
	});

	it('handles NTEX=0', () => {
		const text = `@RSD940102
PLY=AAAC.PLY
MAT=AAAC.MAT
GRP=AAAC.GRP
NTEX=0
`;
		const parsed = parseRsd(enc.encode(text));
		expect(parsed.textures).toHaveLength(0);
	});
});

describe('P mesh parser', () => {
	/** Build a tiny P file: 1 group with 1 triangle, 3 vertices, no normals. */
	function makeMinimalP(): Uint8Array {
		// Header (128 bytes)
		const out = new Uint8Array(
			0x80 + // header
				3 * 12 + // 3 vertices
				0 * 12 + // 0 normals
				0 * 12 + // 0 unknown1
				0 * 8 + // 0 texcoords
				0 * 4 + // 0 vertex colors
				1 * 4 + // 1 polygon color
				0 * 4 + // 0 edges
				1 * 24 + // 1 polygon
				1 * 56, // 1 group
		);
		const v = new DataView(out.buffer);
		v.setUint32(0, 1, true); // version
		v.setUint32(4, 1, true); // constant 1
		v.setUint32(8, 1, true); // vertexType (LVERTEX)
		v.setUint32(0x0c, 3, true); // numVertices
		v.setUint32(0x10, 0, true); // numNormals
		v.setUint32(0x14, 0, true); // numUnknown1
		v.setUint32(0x18, 0, true); // numTexCoords
		v.setUint32(0x1c, 0, true); // numVertexColors
		v.setUint32(0x20, 0, true); // numEdges
		v.setUint32(0x24, 1, true); // numPolygons
		v.setUint32(0x28, 0, true); // numUnknown2
		v.setUint32(0x2c, 0, true); // numUnknown3
		v.setUint32(0x30, 0, true); // numHundreds
		v.setUint32(0x34, 1, true); // numGroups
		v.setUint32(0x38, 0, true); // numBoundingBoxes
		v.setUint32(0x3c, 0, true); // normIndexTableFlag

		let cursor = 0x80;
		// Vertices
		const verts = [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
		];
		for (const [x, y, z] of verts) {
			v.setFloat32(cursor + 0, x, true);
			v.setFloat32(cursor + 4, y, true);
			v.setFloat32(cursor + 8, z, true);
			cursor += 12;
		}
		// Polygon color (BGRA) — 1 polygon
		out.set([0, 0, 255, 255], cursor);
		cursor += 4;
		// Polygon: 2 bytes pad, 3× u16 vertex indices, 3× u16 normal, 3× u16 edge, 2× u16 u
		v.setUint16(cursor + 2, 0, true); // v0
		v.setUint16(cursor + 4, 1, true); // v1
		v.setUint16(cursor + 6, 2, true); // v2
		// Normals and edges left zero
		cursor += 24;
		// Group: PrimitiveType=4 (tris), polyStart=0, polyCount=1,
		// vertStart=0, vertCount=3, no edges, no texcoords, no
		// textures.
		v.setUint32(cursor + 0, 4, true);
		v.setUint32(cursor + 4, 0, true);
		v.setUint32(cursor + 8, 1, true);
		v.setUint32(cursor + 12, 0, true);
		v.setUint32(cursor + 16, 3, true);
		// Edges section
		v.setUint32(cursor + 20, 0, true);
		v.setUint32(cursor + 24, 0, true);
		// u1..u4 zero
		// TexCoordStart 0
		v.setUint32(cursor + 0x2c, 0, true);
		v.setUint32(cursor + 0x30, 0, true); // areTexturesUsed = 0
		v.setUint32(cursor + 0x34, 0, true); // textureNumber
		return out;
	}

	it('parses a minimal P file', () => {
		const bytes = makeMinimalP();
		expect(isPMesh(bytes)).toBe(true);
		const parsed = parsePMesh(bytes);
		expect(parsed.positions).toHaveLength(9);
		expect(parsed.polygons).toHaveLength(1);
		expect(parsed.groups).toHaveLength(1);
		expect(parsed.groups[0]!.numPolygons).toBe(1);
	});

	it('extracts triangles for a group', () => {
		const bytes = makeMinimalP();
		const parsed = parsePMesh(bytes);
		const tris = extractTrianglesForGroup(parsed, parsed.groups[0]!);
		expect(tris.positions).toHaveLength(9);
		expect(tris.indices).toHaveLength(3);
		expect(Array.from(tris.indices)).toEqual([0, 1, 2]);
		// First vertex should be (0, 0, 0)
		expect(tris.positions[0]).toBe(0);
		expect(tris.positions[1]).toBe(0);
		expect(tris.positions[2]).toBe(0);
	});
});

describe('TEX parser', () => {
	/** Build a tiny TEX: 2×2 paletted with 4 colors. */
	function makeMinimalTex(): Uint8Array {
		const HEADER = 0xec;
		const paletteSize = 4;
		const width = 2;
		const height = 2;
		const bpp = 8;
		const bytesPerPixel = 1;
		const out = new Uint8Array(
			HEADER + paletteSize * 4 + width * height * bytesPerPixel,
		);
		const v = new DataView(out.buffer);
		v.setUint32(0, 1, true); // version
		v.setUint32(0x08, 0, true); // colorKeyFlag = 0
		v.setUint32(0x30, 1, true); // paletteCount
		v.setUint32(0x34, 4, true); // colorsPerPalette
		v.setUint32(0x3c, width, true);
		v.setUint32(0x40, height, true);
		v.setUint32(0x4c, 1, true); // paletteFlag = 1
		v.setUint32(0x58, paletteSize, true); // paletteSize
		v.setUint32(0x64, bpp, true);
		v.setUint32(0x68, bytesPerPixel, true);
		// Palette (BGRA): black, red, green, blue
		const pal = HEADER;
		out.set([0, 0, 0, 255], pal + 0); // 0: black
		out.set([0, 0, 255, 255], pal + 4); // 1: red (B=0, G=0, R=255)
		out.set([0, 255, 0, 255], pal + 8); // 2: green
		out.set([255, 0, 0, 255], pal + 12); // 3: blue
		// Pixels: 0=black, 1=red, 2=green, 3=blue
		const pix = HEADER + paletteSize * 4;
		out[pix + 0] = 0;
		out[pix + 1] = 1;
		out[pix + 2] = 2;
		out[pix + 3] = 3;
		return out;
	}

	it('parses a paletted 2x2', () => {
		const bytes = makeMinimalTex();
		expect(isTex(bytes)).toBe(true);
		const parsed = parseTex(bytes);
		expect(parsed.width).toBe(2);
		expect(parsed.height).toBe(2);
		expect(parsed.paletted).toBe(true);
		expect(parsed.bitsPerPixel).toBe(8);
		// Decoded pixels in RGBA (top-down): black, red, green, blue
		expect(Array.from(parsed.pixels.subarray(0, 16))).toEqual([
			0, 0, 0, 255,
			255, 0, 0, 255,
			0, 255, 0, 255,
			0, 0, 255, 255,
		]);
	});
});

describe('Animation parser', () => {
	/** Build a minimal 1-frame, 2-bone .a file. */
	function makeMinimalA(): Uint8Array {
		const HEADER = 36;
		const FRAME = 24 + 2 * 12;
		const out = new Uint8Array(HEADER + FRAME);
		const v = new DataView(out.buffer);
		v.setUint32(0, 1, true); // version
		v.setUint32(4, 1, true); // frames
		v.setUint32(8, 2, true); // bones
		out[12] = 1; // rotation order Y
		out[13] = 0; // X
		out[14] = 2; // Z
		out[15] = 0; // unused
		// Frame 0
		let off = HEADER;
		v.setFloat32(off + 0, 10, true); // root rot α
		v.setFloat32(off + 4, 20, true); // root rot β
		v.setFloat32(off + 8, 30, true); // root rot γ
		v.setFloat32(off + 12, 1, true); // root trans x
		v.setFloat32(off + 16, 2, true); // root trans y
		v.setFloat32(off + 20, 3, true); // root trans z
		// Bone 0
		v.setFloat32(off + 24, 45, true);
		v.setFloat32(off + 28, 0, true);
		v.setFloat32(off + 32, 0, true);
		// Bone 1
		v.setFloat32(off + 36, 0, true);
		v.setFloat32(off + 40, 90, true);
		v.setFloat32(off + 44, 0, true);
		return out;
	}

	it('recognises a valid .a animation', () => {
		const bytes = makeMinimalA();
		expect(isAnim(bytes)).toBe(true);
		expect(isAnim(new Uint8Array(10))).toBe(false);
	});

	it('parses header + per-frame bone rotations', () => {
		const bytes = makeMinimalA();
		const parsed = parseAnim(bytes);
		expect(parsed.framesCount).toBe(1);
		expect(parsed.bonesCount).toBe(2);
		expect(parsed.rotationOrder).toEqual([1, 0, 2]);
		expect(parsed.frames).toHaveLength(1);
		const f = parsed.frames[0]!;
		expect(f.rootRotation).toEqual([10, 20, 30]);
		expect(f.rootTranslation).toEqual([1, 2, 3]);
		expect(f.boneRotations).toHaveLength(2);
		expect(f.boneRotations[0]).toEqual([45, 0, 0]);
		expect(f.boneRotations[1]).toEqual([0, 90, 0]);
	});

	it('throws on size mismatch', () => {
		const bytes = makeMinimalA().slice(0, 30);
		expect(() => parseAnim(bytes)).toThrowError(AnimParseError);
	});
});
