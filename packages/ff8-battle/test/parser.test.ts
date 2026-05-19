import { describe, it, expect } from 'vitest';
import {
	parseDatHeader,
	parseSkeleton,
	parseGeometry,
	parseAnimations,
	parseInformation,
	parseTextures,
	parseDat,
	BitReader,
	decodeFF8Text,
	BONE_SIZE,
	SKELETON_HEADER_SIZE,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

describe('parseDatHeader', () => {
	it('parses a 10-section header', () => {
		const nbSections = 10;
		const out = new Uint8Array(4 + nbSections * 4 + 4);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, nbSections, true);
		for (let i = 0; i < nbSections; i++) {
			// section i starts at offset 100 + i*10
			dv.setUint32(4 + i * 4, 100 + i * 10, true);
		}
		dv.setUint32(4 + nbSections * 4, 999, true); // fileSize
		const h = parseDatHeader(out);
		expect(h.nbSections).toBe(10);
		expect(h.sectionOffsets).toHaveLength(10);
		expect(h.sectionOffsets[0]).toBe(100);
		expect(h.sectionOffsets[9]).toBe(190);
		expect(h.fileSize).toBe(999);
	});

	it('parses a 2-section header (c0m127 case)', () => {
		const out = new Uint8Array(4 + 2 * 4 + 4);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, 2, true);
		dv.setUint32(4, 12, true);
		dv.setUint32(8, 200, true);
		dv.setUint32(12, 1000, true);
		const h = parseDatHeader(out);
		expect(h.nbSections).toBe(2);
		expect(h.sectionOffsets).toEqual([12, 200]);
		expect(h.fileSize).toBe(1000);
	});

	it('rejects an empty buffer', () => {
		expect(() => parseDatHeader(new Uint8Array(0))).toThrow(/too short/);
	});

	it('rejects implausibly large nbSections', () => {
		const out = new Uint8Array(8);
		new DataView(out.buffer).setUint32(0, 1000, true);
		expect(() => parseDatHeader(out)).toThrow(/implausible/);
	});
});

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

describe('parseSkeleton', () => {
	it('parses a 2-bone skeleton (parent + child)', () => {
		// header (16 bytes): cBones=2, scale=2048; then 2 bones of 48 bytes each.
		const total = SKELETON_HEADER_SIZE + 2 * BONE_SIZE;
		const buf = new Uint8Array(total);
		const dv = new DataView(buf.buffer);
		dv.setUint16(0, 2, true); // cBones
		dv.setUint16(2, 2048, true); // scale
		// Bone 0 (root): parentId=0xFFFF, boneSize=8192 (=2.0 units),
		// rot=(0,0,0).
		dv.setUint16(SKELETON_HEADER_SIZE + 0, 0xffff, true);
		dv.setInt16(SKELETON_HEADER_SIZE + 2, 8192, true);
		dv.setInt16(SKELETON_HEADER_SIZE + 4, 0, true);
		dv.setInt16(SKELETON_HEADER_SIZE + 6, 0, true);
		dv.setInt16(SKELETON_HEADER_SIZE + 8, 0, true);
		// Bone 1 (child of 0): parentId=0, boneSize=4096, rotZ=1024 → 90°
		const off1 = SKELETON_HEADER_SIZE + BONE_SIZE;
		dv.setUint16(off1 + 0, 0, true);
		dv.setInt16(off1 + 2, 4096, true);
		dv.setInt16(off1 + 4, 0, true);
		dv.setInt16(off1 + 6, 0, true);
		dv.setInt16(off1 + 8, 1024, true); // rotZ raw 1024 → 90°

		const sk = parseSkeleton(buf, 0);
		expect(sk.cBones).toBe(2);
		expect(sk.scale).toBe(2048);
		expect(sk.bones).toHaveLength(2);
		expect(sk.bones[0]!.parentId).toBe(0xffff);
		expect(sk.bones[0]!.boneSize).toBe(8192);
		expect(sk.bones[1]!.parentId).toBe(0);
		expect(sk.bones[1]!.rotZ).toBeCloseTo(90, 5);
	});
});

// ---------------------------------------------------------------------------
// BitReader
// ---------------------------------------------------------------------------

describe('BitReader', () => {
	it('reads 3 bits LSB-first', () => {
		// 0b101 (5) in the low 3 bits of byte 0 = 0x05.
		const br = new BitReader(new Uint8Array([0x05]));
		// readBits sign-extends; 0b101 as a 3-bit signed value = -3.
		expect(br.readBits(3)).toBe(-3);
		// Bit cursor should now be at 3.
		expect(br.position).toEqual({ byte: 0, bit: 3 });
	});

	it('reads positive 3-bit value', () => {
		// 0b011 = 3 (positive in 3-bit signed).
		const br = new BitReader(new Uint8Array([0x03]));
		expect(br.readBits(3)).toBe(3);
	});

	it('reads across a byte boundary', () => {
		// bytes: 0xFF, 0x01. After reading 6 bits LSB-first → 0b111111 (= -1 signed),
		// next 4 bits span the byte boundary: top 2 bits of byte 0 (0b11) + low
		// 2 bits of byte 1 (0b01) → 0b0111 = 7 (positive in 4-bit signed).
		const br = new BitReader(new Uint8Array([0xff, 0x01]));
		expect(br.readBits(6)).toBe(-1); // 0b111111 signed = -1
		expect(br.readBits(4)).toBe(7); // 0b0111 = 7
	});

	it('sign-extends negative values correctly', () => {
		// 0b1000_0000 → 1-byte read of 8 bits is -128.
		const br = new BitReader(new Uint8Array([0x80]));
		expect(br.readBits(8)).toBe(-128);
	});

	it('reads unsigned bits without sign extension', () => {
		const br = new BitReader(new Uint8Array([0xff]));
		expect(br.readUnsignedBits(4)).toBe(0x0f);
		expect(br.readUnsignedBits(4)).toBe(0x0f);
	});

	it('readPositionType: 2-bit selector then signed count', () => {
		// Selector bits = 00 (count=3), then 3 bits = 0b001 = 1.
		// In the low 5 bits of byte 0: bits 0-1 = 00 (selector),
		// bits 2-4 = 0b001 (value 1). So byte 0 = 0b00000_100 = 0x04.
		const br = new BitReader(new Uint8Array([0x04]));
		expect(br.readPositionType()).toBe(1);
	});

	it('readRotationType: absent flag returns 0 and consumes only 1 bit', () => {
		// Low bit 0 → absent. Then read another rotation type — same byte.
		// byte 0 = 0b0000_0000 → first call returns 0, advances 1 bit.
		const br = new BitReader(new Uint8Array([0x00]));
		expect(br.readRotationType()).toBe(0);
		expect(br.position).toEqual({ byte: 0, bit: 1 });
		expect(br.readRotationType()).toBe(0);
		expect(br.position).toEqual({ byte: 0, bit: 2 });
	});

	it('readRotationType: present flag reads selector and signed count', () => {
		// Build: present=1 (bit 0), selector=00 (bits 1-2, count=3), value=0b010=2.
		// Bits LSB-first: 1, 00, 010 → 0b010_00_1 → 0b0010001 = 0x11.
		const br = new BitReader(new Uint8Array([0x11]));
		expect(br.readRotationType()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// FF8 text decoder
// ---------------------------------------------------------------------------

describe('decodeFF8Text', () => {
	it('decodes the FF8 European codepage', () => {
		// 0x45 = 'A', 0x5F = 'a', 0x48 = 'D', 0x73 = 'u', 0x6b = 'm', 0x77 = 'y'.
		const bytes = new Uint8Array([0x48, 0x73, 0x6b, 0x6b, 0x77]);
		expect(decodeFF8Text(bytes)).toBe('Dummy');
	});

	it('stops at NUL terminator', () => {
		// 0x48 = 'D', 0x6c = 'n' (since 0x5F='a' → 0x6c is the 14th letter = 'n').
		// We just want any printable byte then NUL: use 'D' (0x48) and 'a' (0x5F).
		const bytes = new Uint8Array([0x48, 0x5f, 0x00, 0x48]);
		expect(decodeFF8Text(bytes)).toBe('Da');
	});

	it('falls back to <HH> for unknown bytes', () => {
		// 0xE0 is undefined in our partial table.
		const bytes = new Uint8Array([0x48, 0xe0, 0x5f]);
		expect(decodeFF8Text(bytes)).toBe('D<E0>a');
	});

	it('respects maxLen', () => {
		const bytes = new Uint8Array([0x48, 0x73, 0x6b]); // 'Dum'
		expect(decodeFF8Text(bytes, 2)).toBe('Du');
	});

	it('ascii passthrough mode works for the ASCII range', () => {
		const bytes = new Uint8Array([0x41, 0x42, 0x43]); // ABC
		expect(decodeFF8Text(bytes, undefined, { ascii: true })).toBe('ABC');
	});
});

// ---------------------------------------------------------------------------
// Information
// ---------------------------------------------------------------------------

describe('parseInformation', () => {
	it('reads a minimal 380-byte stats record', () => {
		const buf = new Uint8Array(380);
		// Name = "Bug\0" at 0x00 — using FF8 encoding:
		// 'B' = 0x46, 'u' = 0x73, 'g' = 0x65.
		buf[0x00] = 0x46; // B
		buf[0x01] = 0x73; // u
		buf[0x02] = 0x65; // g
		buf[0x03] = 0x00;

		// HP polynomial coefficients = [1, 2, 3, 4] at 0x18.
		buf[0x18] = 1;
		buf[0x19] = 2;
		buf[0x1a] = 3;
		buf[0x1b] = 4;
		// STR at 0x1C.
		buf[0x1c] = 10;
		buf[0x1d] = 20;
		buf[0x1e] = 30;
		buf[0x1f] = 40;

		// medLevelStart = 10 at 0xF4, highLevelStart = 30 at 0xF5.
		buf[0xf4] = 10;
		buf[0xf5] = 30;

		const dv = new DataView(buf.buffer);
		dv.setUint16(0x100, 250, true); // expExtra
		dv.setUint16(0x102, 100, true); // exp
		// ap = 5 at 0x14F.
		buf[0x14f] = 5;

		// mugRate, dropRate.
		buf[0x14c] = 50;
		buf[0x14d] = 25;

		// Elemental resistances: 8 bytes starting at 0x160.
		for (let i = 0; i < 8; i++) buf[0x160 + i] = i + 100;

		// Status resistances: 20 bytes at 0x168.
		for (let i = 0; i < 20; i++) buf[0x168 + i] = i + 200;

		// Flags.
		buf[0xf7] = 0xab;
		buf[0xfe] = 0xcd;

		const info = parseInformation(buf, 0);
		expect(info.name).toBe('Bug');
		expect(info.hp).toEqual([1, 2, 3, 4]);
		expect(info.str).toEqual([10, 20, 30, 40]);
		expect(info.medLevelStart).toBe(10);
		expect(info.highLevelStart).toBe(30);
		expect(info.exp).toBe(100);
		expect(info.expExtra).toBe(250);
		expect(info.ap).toBe(5);
		expect(info.mugRate).toBe(50);
		expect(info.dropRate).toBe(25);
		expect(info.elementalResistance).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
		expect(info.statusResistance).toHaveLength(20);
		expect(info.statusResistance[0]).toBe(200);
		expect(info.statusResistance[19]).toBe(219);
		expect(info.flag1).toBe(0xab);
		expect(info.flag2).toBe(0xcd);

		// All 16-entry ability arrays present even if zero.
		expect(info.abilitiesLow).toHaveLength(16);
		expect(info.abilitiesMed).toHaveLength(16);
		expect(info.abilitiesHigh).toHaveLength(16);
		expect(info.drawLow).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Textures (TIM 2x2 8bpp paletted)
// ---------------------------------------------------------------------------

describe('parseTextures', () => {
	it('decodes a 2x2 8bpp paletted TIM blob', () => {
		// Build a TIM:
		// magic 0x10, flags = 0x08|0x01 (hasCLUT + 8bpp)
		// CLUT: section size = 12 + 256*2 = 524, w=256, h=1, palette of 256 entries
		// Image: section size = 12 + (1 halfword) * 2 * 2 rows = 16, widthHalfwords = 1 (8bpp → 2 px wide), height = 2
		// Pixels: top row = [0, 1], bottom row = [2, 3]
		const clutSize = 12 + 256 * 2;
		const imgSize = 12 + 1 * 2 * 2; // 1 halfword/row × 2 bytes × 2 rows = 4 pixel bytes
		const timBytes = new Uint8Array(8 + clutSize + imgSize);
		const dv = new DataView(timBytes.buffer);
		dv.setUint32(0, 0x10, true); // magic
		dv.setUint32(4, 0x09, true); // flags: bpp=1 (8bpp), hasCLUT=bit 3
		// CLUT header at offset 8.
		dv.setUint32(8, clutSize, true);
		dv.setUint16(8 + 4, 0, true); // dx
		dv.setUint16(8 + 6, 0, true); // dy
		dv.setUint16(8 + 8, 256, true); // clutWidth
		dv.setUint16(8 + 10, 1, true); // clutHeight
		// Palette entries. Entry 0 = 0x0000 (transparent black), 1 = 0xFFFF (white-ish), 2 = bright red, 3 = bright green.
		// BGR555 layout: r in low 5, g in next 5, b in next 5.
		// 0xFFFF = all 1s = white (alpha mask bit set, RGB full).
		dv.setUint16(8 + 12 + 0 * 2, 0x0000, true);
		dv.setUint16(8 + 12 + 1 * 2, 0x7fff, true); // RGB full, mask 0
		dv.setUint16(8 + 12 + 2 * 2, 0x001f, true); // r = 31
		dv.setUint16(8 + 12 + 3 * 2, 0x03e0, true); // g = 31

		// Image header.
		const imgStart = 8 + clutSize;
		dv.setUint32(imgStart, imgSize, true);
		dv.setUint16(imgStart + 4, 0, true); // dx
		dv.setUint16(imgStart + 6, 0, true); // dy
		dv.setUint16(imgStart + 8, 1, true); // widthHalfwords → 2 px wide
		dv.setUint16(imgStart + 10, 2, true); // height
		// Pixels.
		timBytes[imgStart + 12 + 0] = 0; // (0,0)
		timBytes[imgStart + 12 + 1] = 1; // (1,0)
		timBytes[imgStart + 12 + 2] = 2; // (0,1)
		timBytes[imgStart + 12 + 3] = 3; // (1,1)

		// Build a Textures section: cTim=1, pTim[0]=4+4+4=12, eof=12+timBytes.length, then TIM blob.
		const sectionLen = 4 + 4 + 4 + timBytes.length;
		const section = new Uint8Array(sectionLen);
		const sdv = new DataView(section.buffer);
		sdv.setUint32(0, 1, true); // cTim
		sdv.setUint32(4, 4 + 4 + 4, true); // pTim[0]
		sdv.setUint32(8, 4 + 4 + 4 + timBytes.length, true); // eof
		section.set(timBytes, 12);

		const textures = parseTextures(section, 0);
		expect(textures).toHaveLength(1);
		const t = textures[0]!;
		expect(t.width).toBe(2);
		expect(t.height).toBe(2);
		expect(t.bpp).toBe(8);
		expect(t.pixels).toHaveLength(2 * 2 * 4);
		// Pixel (0,0) = palette entry 0 = (0,0,0,255).
		expect(t.pixels[0]).toBe(0);
		expect(t.pixels[1]).toBe(0);
		expect(t.pixels[2]).toBe(0);
		// Pixel (1,0) = palette entry 1 = (255, 255, 255, 255).
		expect(t.pixels[4]).toBe(255);
		expect(t.pixels[5]).toBe(255);
		expect(t.pixels[6]).toBe(255);
		// Pixel (0,1) = palette entry 2 = (255, 0, 0, 255).
		expect(t.pixels[8]).toBe(255);
		expect(t.pixels[9]).toBe(0);
		expect(t.pixels[10]).toBe(0);
		// Pixel (1,1) = palette entry 3 = (0, 255, 0, 255).
		expect(t.pixels[12]).toBe(0);
		expect(t.pixels[13]).toBe(255);
		expect(t.pixels[14]).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Geometry — minimal smoke test: 1 object, 1 vertex block, 1 triangle, 0 quads.
// ---------------------------------------------------------------------------

describe('parseGeometry', () => {
	it('parses a minimal 1-object scene with 1 triangle', () => {
		// Section layout (section-relative, starts at 0):
		//   0x00  u32 cObjects = 1
		//   0x04  u32 pObjects[0] = 8
		//   0x08  Object:
		//     0x00 u16 cVertexBlocks = 1
		//     0x02 VertexBlock: boneId=0, cVerts=3, then 3 × 6-byte vert = 18 bytes
		//     -> position at 0x02 + 4 + 18 = 0x18 (section-relative 0x08 + 0x18 = 0x20)
		//     Alignment: rel position = 0x20 = 32 → multiple of 4 → SKIP 4 bytes
		//     -> at rel 0x24
		//     u16 cTri = 1, u16 cQuad = 0, u32+u64 padding (12 bytes total after counts)
		//     -> at rel 0x24 + 4 + 8 = 0x30
		//     Triangle (16 bytes) → rel 0x40
		//   0x40  u32 totalVertices = 3
		const verticesData = new Uint8Array(18);
		const dv0 = new DataView(verticesData.buffer);
		// 3 vertices: (10,20,30), (40,50,60), (70,80,90)
		dv0.setInt16(0, 10, true); dv0.setInt16(2, 20, true); dv0.setInt16(4, 30, true);
		dv0.setInt16(6, 40, true); dv0.setInt16(8, 50, true); dv0.setInt16(10, 60, true);
		dv0.setInt16(12, 70, true); dv0.setInt16(14, 80, true); dv0.setInt16(16, 90, true);

		const triData = new Uint8Array(16);
		const tdv = new DataView(triData.buffer);
		tdv.setUint16(0, 0, true); // a
		tdv.setUint16(2, 1, true); // b
		tdv.setUint16(4, 2, true); // c
		// uvA at 0x06..0x07
		triData[6] = 10; triData[7] = 20;
		// uvB at 0x08..0x09
		triData[8] = 30; triData[9] = 40;
		// texUnk at 0x0A. To produce textureIndex=1: bits 6-8 = 0b001 → 0x40.
		tdv.setUint16(0x0a, 0x40, true);
		// uvC at 0x0C..0x0D
		triData[12] = 50; triData[13] = 60;

		const buf = new Uint8Array(0x44);
		const dv = new DataView(buf.buffer);
		dv.setUint32(0, 1, true); // cObjects
		dv.setUint32(4, 8, true); // pObjects[0] = 8 (section-relative)
		dv.setUint16(8, 1, true); // cVertexBlocks = 1
		dv.setUint16(0x0a, 0, true); // boneId
		dv.setUint16(0x0c, 3, true); // cVertsInBlock
		buf.set(verticesData, 0x0e);
		// rel after vertices = 0x0E + 18 = 0x20; mod 4 == 0 → SKIP 4 bytes → 0x24.
		dv.setUint16(0x24, 1, true); // cTriangles
		dv.setUint16(0x26, 0, true); // cQuads
		// 8 bytes u64 padding at 0x28..0x2F.
		buf.set(triData, 0x30);
		dv.setUint32(0x40, 3, true); // totalVertexCount

		const geom = parseGeometry(buf, 0);
		expect(geom.objects).toHaveLength(1);
		expect(geom.totalVertexCount).toBe(3);
		const obj = geom.objects[0]!;
		expect(obj.vertices).toHaveLength(3);
		expect(obj.vertices[0]).toEqual({ x: 10, y: 20, z: 30, boneId: 0 });
		expect(obj.triangles).toHaveLength(1);
		// Triangle reordered to (C, A, B) draw order:
		expect(obj.triangles[0]!.vertexIndexes).toEqual([2, 0, 1]);
		expect(obj.triangles[0]!.textureIndex).toBe(1);
		expect(obj.quads).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Animations — smoke test only. A single-frame animation with all zero bits
// reads back as one zero frame.
// ---------------------------------------------------------------------------

describe('parseAnimations', () => {
	it('parses a single 1-frame animation with 1 bone', () => {
		// Build section:
		//   u32 cAnim = 1
		//   u32 pAnim[0] = 8 (section-relative)
		//   Anim @8: u8 cFrames = 1, then bit stream.
		//   Bit stream for 1 frame, 1 bone, all zeros:
		//     3 × readPositionType (each: 2 bits selector + count bits, all 0) →
		//       selector 00 → count=3 → reads 3 bits → 5 bits total per pos.
		//       3 × 5 = 15 bits for the root translation.
		//     1 bit modeTest.
		//     3 × readRotationType (each: 1 bit presence — when 0, no further read).
		//       3 bits.
		//   Total bits = 15 + 1 + 3 = 19. With all zeros, the buffer just needs
		//   enough bytes for that — 3 bytes is plenty.
		const buf = new Uint8Array(4 + 4 + 1 + 4);
		const dv = new DataView(buf.buffer);
		dv.setUint32(0, 1, true); // cAnim
		dv.setUint32(4, 8, true); // pAnim[0]
		buf[8] = 1; // cFrames
		// bytes 9..12 = 0 → all reads return zero.
		const anims = parseAnimations(buf, 0, 1);
		expect(anims).toHaveLength(1);
		expect(anims[0]!.frames).toHaveLength(1);
		expect(anims[0]!.frames[0]!.rootTranslation).toEqual([0, 0, 0]);
		expect(anims[0]!.frames[0]!.boneRotations).toEqual([[0, 0, 0]]);
	});
});

// ---------------------------------------------------------------------------
// Top-level parseDat — wires header + sections together.
// ---------------------------------------------------------------------------

describe('parseDat', () => {
	it('handles c0m127-style 2-section variant (info + AI)', () => {
		// 380-byte info + a few bytes "AI".
		const infoLen = 380;
		const aiLen = 4;
		const headerLen = 4 + 2 * 4 + 4;
		const fileSize = headerLen + infoLen + aiLen;
		const buf = new Uint8Array(fileSize);
		const dv = new DataView(buf.buffer);
		dv.setUint32(0, 2, true); // nbSections
		dv.setUint32(4, headerLen, true); // info section starts here
		dv.setUint32(8, headerLen + infoLen, true); // AI section starts here
		dv.setUint32(12, fileSize, true); // fileSize
		// "Foo" in FF8 encoding: F=0x4a, o=0x6d, o=0x6d.
		buf[headerLen + 0] = 0x4a; // F
		buf[headerLen + 1] = 0x6d; // o
		buf[headerLen + 2] = 0x6d; // o
		buf[headerLen + 3] = 0x00;

		const dat = parseDat(buf);
		expect(dat.header.nbSections).toBe(2);
		expect(dat.information?.name).toBe('Foo');
		expect(dat.rawSections).toHaveLength(2);
		expect(dat.rawSections[1]?.length).toBe(aiLen);
	});
});
