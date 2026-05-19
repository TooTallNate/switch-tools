import { describe, it, expect } from 'vitest';
import {
	parseCharaOne,
	isDummyCharaOne,
	parseMch,
	parseTim,
	isTim,
	unpackRotationRaw,
	unpackRotationSigned,
	unpackRotationDegrees,
	MCH_HEADER_SIZE,
	MCH_BONE_SIZE,
	MCH_VERTEX_SIZE,
	MCH_FACE_SIZE,
	MCH_SKIN_SIZE,
	triangulateMchFace,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Rotation packing — the bug-fixed `>> 0/2/4` formula
// ---------------------------------------------------------------------------

describe('unpackRotation', () => {
	it('returns all-zero for all-zero input', () => {
		expect(unpackRotationRaw(0, 0, 0, 0)).toEqual([0, 0, 0]);
		expect(unpackRotationSigned(0, 0, 0, 0)).toEqual([0, 0, 0]);
		expect(unpackRotationDegrees(0, 0, 0, 0)).toEqual([0, 0, 0]);
	});

	it('shifts b0/b1/b2 left by 2 when b3 == 0', () => {
		// b0 = 1 → x raw = (1 << 2) | 0 = 4
		expect(unpackRotationRaw(1, 2, 3, 0)).toEqual([4, 8, 12]);
	});

	it('packs the high 2 bits per axis from b3 at offsets 0/2/4', () => {
		// b3 = 0b00010101  →  x=(>>0)&3 = 0b01 = 1; y=(>>2)&3 = 0b01 = 1; z=(>>4)&3 = 0b01 = 1.
		// → all three should have their high bits set to 1 << 10 = 1024.
		const [x, y, z] = unpackRotationRaw(0, 0, 0, 0b00010101);
		expect(x).toBe(1024);
		expect(y).toBe(1024);
		expect(z).toBe(1024);
	});

	it('combines b0 and b3 correctly for x axis', () => {
		// b0 = 0xFF, b3 bit0-1 = 0b11 → x = (0xFF << 2) | (3 << 10) = 0xFFF + ? 
		// (0xFF << 2) = 0x3FC; (3 << 10) = 0xC00; OR = 0xFFC.
		const [x] = unpackRotationRaw(0xff, 0, 0, 0b00000011);
		expect(x).toBe(0xffc);
	});

	it('sign-extends 12-bit values', () => {
		// Maximum positive: 0x7FF (2047). Above that wraps negative.
		// 0x800 should become -2048.
		// Build a 12-bit signed value via raw: pick b0=0, b3 bit0-1 = 0b10 → x = 2 << 10 = 2048.
		const [x] = unpackRotationSigned(0, 0, 0, 0b00000010);
		expect(x).toBe(-2048);
	});

	it('converts to degrees with 4096 → 360 scale', () => {
		// Raw signed = 1024 → degrees = 1024/4096*360 = 90.
		// Construct: b0=0, b3 bit0-1 = 0b01 → x = 1024.
		const [x] = unpackRotationDegrees(0, 0, 0, 0b00000001);
		expect(x).toBeCloseTo(90);
	});

	it('rejects the deling bug pattern: shifts (not multiplies) b3', () => {
		// If we had used `b3 * 1` (deling's bug for the y axis) on
		// b3 = 0b100 = 4, y would get (4 & 3) = 0. The correct
		// `(b3 >> 2) & 3` of the same byte is (1 & 3) = 1.
		const [_, y] = unpackRotationRaw(0, 0, 0, 0b00000100);
		expect(y).toBe(1024); // 1 << 10
	});
});

// ---------------------------------------------------------------------------
// TIM 8bpp 2×2 paletted decode
// ---------------------------------------------------------------------------

describe('parseTim', () => {
	it('decodes a minimal 2×2 8bpp paletted image', () => {
		// CLUT: 4 entries, 1 palette
		//   index 0 = pure red    (BGR555: r=31, g=0, b=0)
		//   index 1 = pure green
		//   index 2 = pure blue
		//   index 3 = white
		// Pixels (2x2): top row [0,1] bottom row [2,3]
		const paletteEntries = [
			0x001f, // red
			0x03e0, // green
			0x7c00, // blue
			0x7fff, // white
		];

		const buf = new Uint8Array(8 + 12 + paletteEntries.length * 2 + 12 + 4);
		const view = new DataView(buf.buffer);
		// File header
		view.setUint32(0, 0x00000010, true); // magic
		view.setUint32(4, 0b1001, true); // bpp=1 (8bpp), hasCLUT
		// CLUT section
		view.setUint32(8, 12 + paletteEntries.length * 2, true);
		view.setUint16(12, 0, true); // clutDX
		view.setUint16(14, 0, true); // clutDY
		view.setUint16(16, 4, true); // paletteWidth (entries per palette)
		view.setUint16(18, 1, true); // paletteHeight (palettes)
		for (let i = 0; i < paletteEntries.length; i++) {
			view.setUint16(20 + i * 2, paletteEntries[i]!, true);
		}
		// Image section
		const imgOff = 20 + paletteEntries.length * 2;
		view.setUint32(imgOff + 0, 12 + 4, true); // section size
		view.setUint16(imgOff + 4, 0, true); // dx
		view.setUint16(imgOff + 6, 0, true); // dy
		view.setUint16(imgOff + 8, 1, true); // width in halfwords (8bpp → 2 px)
		view.setUint16(imgOff + 10, 2, true); // height in pixels
		// Pixels: row 0 = [0,1], row 1 = [2,3]
		buf[imgOff + 12 + 0] = 0;
		buf[imgOff + 12 + 1] = 1;
		buf[imgOff + 12 + 2] = 2;
		buf[imgOff + 12 + 3] = 3;

		expect(isTim(buf)).toBe(true);
		const tim = parseTim(buf);
		expect(tim.width).toBe(2);
		expect(tim.height).toBe(2);
		expect(tim.bpp).toBe(8);
		expect(tim.paletteCount).toBe(1);

		// Row 0, pixel 0: red
		expect(tim.pixels[0]).toBe(0xff); // r
		expect(tim.pixels[1]).toBe(0); // g
		expect(tim.pixels[2]).toBe(0); // b
		expect(tim.pixels[3]).toBe(0xff); // a

		// Row 0, pixel 1: green
		expect(tim.pixels[4]).toBe(0);
		expect(tim.pixels[5]).toBe(0xff);
		expect(tim.pixels[6]).toBe(0);

		// Row 1, pixel 0: blue
		expect(tim.pixels[8]).toBe(0);
		expect(tim.pixels[9]).toBe(0);
		expect(tim.pixels[10]).toBe(0xff);

		// Row 1, pixel 1: white
		expect(tim.pixels[12]).toBe(0xff);
		expect(tim.pixels[13]).toBe(0xff);
		expect(tim.pixels[14]).toBe(0xff);
	});

	it('isTim rejects non-TIM data', () => {
		expect(isTim(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
		expect(isTim(new Uint8Array(4))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Dummy-file detection
// ---------------------------------------------------------------------------

describe('isDummyCharaOne', () => {
	it('detects the 33-byte sentinel', () => {
		const sentinel = new TextEncoder().encode(
			'This is dummy file. Kazuo Suzuki\n',
		);
		expect(sentinel.length).toBe(33);
		expect(isDummyCharaOne(sentinel)).toBe(true);
	});

	it('treats sub-0x100 files as dummies', () => {
		expect(isDummyCharaOne(new Uint8Array(100))).toBe(true);
		expect(isDummyCharaOne(new Uint8Array(0xff))).toBe(true);
	});

	it('accepts files at or above 0x100 bytes', () => {
		expect(isDummyCharaOne(new Uint8Array(0x100))).toBe(false);
	});

	it('parseCharaOne returns isDummy for sub-0x100 input', () => {
		const r = parseCharaOne(new Uint8Array(20));
		expect(r.isDummy).toBe(true);
		expect(r.entries).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Synthetic MCH (1 bone, 1 vertex, 1 triangle face, 1 anim 1 frame)
// ---------------------------------------------------------------------------

interface SyntheticMchOpts {
	boneCount?: number;
	vertexCount?: number;
	triangleCount?: number;
	quadCount?: number;
	skinObjectCount?: number;
	animation?: { framesCount: number };
}

/**
 * Build a minimal MCH body starting at offset 0. Returns bytes.
 */
function buildSyntheticMchBody(opts: SyntheticMchOpts = {}): Uint8Array {
	const boneCount = opts.boneCount ?? 1;
	const vertexCount = opts.vertexCount ?? 1;
	const triangleCount = opts.triangleCount ?? 1;
	const quadCount = opts.quadCount ?? 0;
	const faceCount = triangleCount + quadCount;
	const skinObjectCount = opts.skinObjectCount ?? 1;
	const framesCount = opts.animation?.framesCount ?? 1;
	// Default: include one animation. Set `animation: undefined` to force-omit.
	const includeAnim = 'animation' in opts ? opts.animation !== undefined : true;
	const animCount = includeAnim ? 1 : 0;

	const bonesOff = MCH_HEADER_SIZE;
	const vertsOff = bonesOff + boneCount * MCH_BONE_SIZE;
	const facesOff = vertsOff + vertexCount * MCH_VERTEX_SIZE;
	const skinOff = facesOff + faceCount * MCH_FACE_SIZE;
	let animOff = skinOff + skinObjectCount * MCH_SKIN_SIZE;
	let animBlockSize = 0;
	if (animCount > 0) {
		// 2 (animCount) + 4 (per-anim header) + framesCount * (6 + boneCount*4)
		animBlockSize = 2 + 4 + framesCount * (6 + boneCount * 4);
	}
	const totalSize = animOff + animBlockSize;
	const buf = new Uint8Array(totalSize);
	const view = new DataView(buf.buffer);

	// Header
	view.setUint32(0x00, boneCount, true);
	view.setUint32(0x04, vertexCount, true);
	view.setUint32(0x08, 0, true);
	view.setUint32(0x0c, faceCount, true);
	view.setUint32(0x10, 0, true);
	view.setUint32(0x14, skinObjectCount, true);
	view.setUint32(0x18, 0, true); // padding
	view.setUint16(0x1c, triangleCount, true);
	view.setUint16(0x1e, quadCount, true);
	view.setUint32(0x20, bonesOff, true);
	view.setUint32(0x24, vertsOff, true);
	view.setUint32(0x28, 0, true);
	view.setUint32(0x2c, facesOff, true);
	view.setUint32(0x30, 0, true);
	view.setUint32(0x34, skinOff, true);
	view.setUint32(0x38, animCount > 0 ? animOff : 0, true);
	view.setUint16(0x3c, 0, true);
	view.setUint16(0x3e, 0, true);

	// Bone 0: parentId=0 (root), size=42
	view.setUint16(bonesOff + 0, 0, true);
	view.setInt16(bonesOff + 8, 42, true);

	// Vertex 0: (10, 20, 30)
	view.setInt16(vertsOff + 0, 10, true);
	view.setInt16(vertsOff + 2, 20, true);
	view.setInt16(vertsOff + 4, 30, true);

	// Face 0 (triangle): polyType 0x07060125 (tri), vert idx 0/0/0.
	view.setUint32(facesOff + 0x00, 0x07060125, true);
	// All other fields zero.

	// Skin 0: vertexIndex=0, vertexCount=1, boneId=1
	view.setUint16(skinOff + 0, 0, true);
	view.setUint16(skinOff + 2, 1, true);
	view.setUint16(skinOff + 4, 1, true);

	// Animation
	if (animCount > 0) {
		view.setUint16(animOff, 1, true); // animCount
		view.setUint16(animOff + 2, framesCount, true);
		view.setUint16(animOff + 4, boneCount, true);
		let cur = animOff + 6;
		for (let f = 0; f < framesCount; f++) {
			view.setInt16(cur + 0, 1, true); // tx
			view.setInt16(cur + 2, 2, true); // ty
			view.setInt16(cur + 4, 3, true); // tz
			cur += 6;
			for (let b = 0; b < boneCount; b++) {
				// Make bone 0 rotation read back as roughly (90°, 0°, 0°).
				// 1024 in raw → 90° on x axis.
				// Build: b0=0, b1=0, b2=0, b3 = 0b00000001 → x bits = 01 → 1<<10 = 1024.
				buf[cur + 0] = 0;
				buf[cur + 1] = 0;
				buf[cur + 2] = 0;
				buf[cur + 3] = 0b00000001;
				cur += 4;
			}
		}
	}

	return buf;
}

describe('parseMch (synthetic)', () => {
	it('parses a minimal MCH (1 bone, 1 vertex, 1 tri, 1 anim with 1 frame)', () => {
		const buf = buildSyntheticMchBody();
		const mch = parseMch(buf, { bodyOffset: 0 });
		expect(mch.bones).toHaveLength(1);
		expect(mch.bones[0]!.parentId).toBe(0);
		expect(mch.bones[0]!.logicalParent).toBe(-1);
		expect(mch.bones[0]!.size).toBe(42);

		expect(mch.vertices).toEqual([[10, 20, 30]]);
		expect(mch.faces).toHaveLength(1);
		expect(mch.faces[0]!.isQuad).toBe(false);
		expect(mch.faces[0]!.vertexIndexes).toEqual([0, 0, 0, 0]);

		expect(mch.skinObjects).toHaveLength(1);
		expect(mch.skinObjects[0]!.boneId).toBe(1);
		expect(mch.skinObjects[0]!.logicalBone).toBe(0);
		expect(mch.skinObjects[0]!.vertexCount).toBe(1);

		expect(mch.animations).toHaveLength(1);
		const anim = mch.animations[0]!;
		expect(anim.framesCount).toBe(1);
		expect(anim.bonesCount).toBe(1);
		expect(anim.frames).toHaveLength(1);
		expect(anim.frames[0]!.rootTranslation).toEqual([1, 2, 3]);
		const rot = anim.frames[0]!.boneRotations[0]!;
		expect(rot[0]).toBeCloseTo(90); // x
		expect(rot[1]).toBeCloseTo(0); // y
		expect(rot[2]).toBeCloseTo(0); // z
	});

	it('rejects header padding != 0', () => {
		const buf = buildSyntheticMchBody();
		const view = new DataView(buf.buffer);
		view.setUint32(0x18, 1, true); // poison padding
		expect(() => parseMch(buf, { bodyOffset: 0 })).toThrow(/padding/);
	});

	it('parses standalone MCH with TIM TOC + modelOffset prefix', () => {
		// Build a body, then prepend a TIM TOC: a single TIM offset
		// (faked as 0xCAFEBABE since we won't decode it) + sentinel
		// + modelOffset.
		const body = buildSyntheticMchBody();
		const prefix = new Uint8Array(0x100);
		const view = new DataView(prefix.buffer);
		// TIM offset entry (single).
		view.setUint32(0, 0x10, true); // arbitrary
		// Sentinel
		view.setUint32(4, 0xffffffff, true);
		// modelOffset (relative to start)
		view.setUint32(8, 0x100, true);
		const full = new Uint8Array(prefix.length + body.length);
		full.set(prefix, 0);
		full.set(body, prefix.length);
		const mch = parseMch(full);
		expect(mch.embeddedTimOffsets).toEqual([0x10]);
		expect(mch.bodyOffset).toBe(0x100);
		expect(mch.bones).toHaveLength(1);
	});

	it('triangulates triangles in PSX (C,A,B) winding', () => {
		const tri = triangulateMchFace({
			isQuad: false,
			vertexIndexes: [10, 20, 30, 0],
			normalIndexes: [0, 0, 0, 0],
			colors: [0, 0, 0, 0],
			texCoords: [
				[0, 0],
				[0, 0],
				[0, 0],
				[0, 0],
			],
			textureIndex: 0,
		});
		expect(tri).toEqual([30, 10, 20]);
	});

	it('triangulates quads in PSX Z-pattern (0,1,3) + (0,2,3) reordered to (C,A,B)', () => {
		const tri = triangulateMchFace({
			isQuad: true,
			vertexIndexes: [10, 20, 30, 40],
			normalIndexes: [0, 0, 0, 0],
			colors: [0, 0, 0, 0],
			texCoords: [
				[0, 0],
				[0, 0],
				[0, 0],
				[0, 0],
			],
			textureIndex: 0,
		});
		// Tri 1 (0,1,3) → (C,A,B) = (v3, v0, v1) = (40, 10, 20)
		// Tri 2 (0,2,3) → (C,A,B) = (v3, v0, v2) = (40, 10, 30)
		expect(tri).toEqual([40, 10, 20, 40, 10, 30]);
	});
});

// ---------------------------------------------------------------------------
// Synthetic chara.one — embedded + shared-texture + external
// ---------------------------------------------------------------------------

/**
 * Build a chara.one with one entry of each variant. Returns
 * the full byte buffer.
 *
 * Layout (offsets relative to chara.one start):
 *
 *   +0x0000  u32  modelCount = 3
 *   +0x0004  variable-size entry headers (packed back-to-back):
 *
 *     entry 0 (embedded):
 *       u32 rawDataOffset  (= 0x800)
 *       u32 dataSize
 *       u32 modelID = (first TIM offset) = 0x40
 *       u32 nextTimOffset = 0x80000000  (sign-bit terminator)
 *       u32 mchOffset = 0x80
 *       u8[4] name "a000"
 *       u8[3] rgb
 *       u8 pad
 *       u32 extLoaderId
 *
 *     entry 1 (shared-texture):
 *       u32 rawDataOffset
 *       u32 dataSize
 *       u32 modelID = 0xA0000000
 *       u32 0xFFFFFFFF (sentinel)
 *       u32 mchOffset = 0x40
 *       u8[4] name "b000"
 *       u8[3] rgb + u8 pad + u32 extId
 *
 *     entry 2 (external d042):
 *       u32 rawDataOffset
 *       u32 dataSize
 *       u32 modelID = 0xD0000000 | 42
 *       u32 animationOffset = 0
 *       (NO trailer — testno-style)
 *
 *   +0x0800 onward: payloads (each starts with 4-byte filler).
 */
function buildSyntheticCharaOne(): {
	bytes: Uint8Array;
	embeddedTimAbs: number;
	embeddedModelAbs: number;
	sharedModelAbs: number;
	externalAnimAbs: number;
} {
	const PAY_START = 0x800;

	// Entry 0 payload: 4-byte filler + TIM stub at +0x40 + MCH stub at +0x80.
	const e0TimRel = 0x40;
	const e0MchRel = 0x80;
	const e0PayloadSize = 4 + 0x80 + 64;
	const e0Payload = new Uint8Array(e0PayloadSize);
	// TIM stub magic bytes
	e0Payload[4 + e0TimRel] = 0x10;

	// Entry 1 payload: filler + MCH at +0x40.
	const e1MchRel = 0x40;
	const e1PayloadSize = 4 + e1MchRel + 64;
	const e1Payload = new Uint8Array(e1PayloadSize);

	// Entry 2 payload (external): minimal filler + 4 bytes of animation data.
	const e2PayloadSize = 16;
	const e2Payload = new Uint8Array(e2PayloadSize);

	const total = PAY_START + e0PayloadSize + e1PayloadSize + e2PayloadSize;
	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 3, true); // modelCount

	let p = 4;
	let payOff = PAY_START;

	// --- Entry 0: embedded ---
	const e0RawOff = payOff;
	view.setUint32(p + 0, e0RawOff, true);
	view.setUint32(p + 4, e0PayloadSize, true);
	view.setUint32(p + 8, e0TimRel, true); // modelID = first TIM offset
	view.setUint32(p + 12, 0x80000000, true); // sign-bit terminator
	view.setUint32(p + 16, e0MchRel, true); // mchOffset
	p += 20;
	// Trailer
	bytes[p + 0] = 'a'.charCodeAt(0);
	bytes[p + 1] = '0'.charCodeAt(0);
	bytes[p + 2] = '0'.charCodeAt(0);
	bytes[p + 3] = '0'.charCodeAt(0);
	bytes[p + 4] = 11;
	bytes[p + 5] = 22;
	bytes[p + 6] = 33;
	bytes[p + 7] = 0;
	view.setUint32(p + 8, 42, true);
	p += 12;
	bytes.set(e0Payload, payOff);
	payOff += e0PayloadSize;

	// --- Entry 1: shared-texture ---
	const e1RawOff = payOff;
	view.setUint32(p + 0, e1RawOff, true);
	view.setUint32(p + 4, e1PayloadSize, true);
	view.setUint32(p + 8, 0xa0000000, true); // shared-texture, sibling=0
	view.setUint32(p + 12, 0xffffffff, true); // sentinel
	view.setUint32(p + 16, e1MchRel, true);
	p += 20;
	bytes[p + 0] = 'b'.charCodeAt(0);
	bytes[p + 1] = '0'.charCodeAt(0);
	bytes[p + 2] = '0'.charCodeAt(0);
	bytes[p + 3] = '0'.charCodeAt(0);
	bytes[p + 4] = 99;
	bytes[p + 5] = 88;
	bytes[p + 6] = 77;
	bytes[p + 7] = 0;
	view.setUint32(p + 8, 7, true);
	p += 12;
	bytes.set(e1Payload, payOff);
	payOff += e1PayloadSize;

	// --- Entry 2: external (d042). No trailer (back-to-back). ---
	const e2RawOff = payOff;
	view.setUint32(p + 0, e2RawOff, true);
	view.setUint32(p + 4, e2PayloadSize, true);
	view.setUint32(p + 8, 0xd0000000 | 42, true);
	view.setUint32(p + 12, 0, true); // animationOffset rel = 0
	p += 16;
	// No trailer; ensure next-offset reads as 0 so trailer is skipped.
	bytes.set(e2Payload, payOff);

	return {
		bytes,
		embeddedTimAbs: e0RawOff + 4 + e0TimRel,
		embeddedModelAbs: e0RawOff + 4 + e0MchRel,
		sharedModelAbs: e1RawOff + 4 + e1MchRel,
		externalAnimAbs: e2RawOff + 4,
	};
}

describe('parseCharaOne (synthetic)', () => {
	it('parses one entry of each variant', () => {
		const built = buildSyntheticCharaOne();
		const out = parseCharaOne(built.bytes);
		expect(out.isDummy).toBe(false);
		expect(out.modelCount).toBe(3);
		expect(out.entries).toHaveLength(3);

		const [e0, e1, e2] = out.entries;

		// Entry 0: embedded
		expect(e0!.variant).toBe('embedded');
		expect(e0!.name).toBe('a000');
		expect(e0!.lightColor).toEqual([11, 22, 33]);
		expect(e0!.extLoaderId).toBe(42);
		expect(e0!.timOffsets).toEqual([built.embeddedTimAbs]);
		expect(e0!.modelOffset).toBe(built.embeddedModelAbs);

		// Entry 1: shared-texture
		expect(e1!.variant).toBe('shared-texture');
		expect(e1!.name).toBe('b000');
		expect(e1!.modelOffset).toBe(built.sharedModelAbs);
		// shared-texture entries don't have a TIM list of their own
		expect(e1!.timOffsets).toBeUndefined();
		expect(e1!.sharedTextureModelIndex).toBe(0);

		// Entry 2: external (d042)
		expect(e2!.variant).toBe('external');
		expect(e2!.name).toBe('d042');
		expect(e2!.externalRefId).toBe(42);
		expect(e2!.modelOffset).toBeUndefined();
		expect(e2!.timOffsets).toBeUndefined();
		expect(e2!.animationOffset).toBe(built.externalAnimAbs);
	});

	it('strips a leading 4-byte file-size prefix when present', () => {
		const built = buildSyntheticCharaOne();
		// Wrap: prepend a u32 = total length-of-wrapped-buffer.
		const wrapped = new Uint8Array(built.bytes.length + 4);
		const wv = new DataView(wrapped.buffer);
		wv.setUint32(0, wrapped.length, true);
		wrapped.set(built.bytes, 4);
		const out = parseCharaOne(wrapped);
		expect(out.modelCount).toBe(3);
		expect(out.entries).toHaveLength(3);
		// Absolute offsets should be shifted by 4.
		expect(out.entries[0]!.timOffsets).toEqual([built.embeddedTimAbs + 4]);
	});

	it('does not strip the prefix when option is disabled', () => {
		const built = buildSyntheticCharaOne();
		const wrapped = new Uint8Array(built.bytes.length + 4);
		const wv = new DataView(wrapped.buffer);
		wv.setUint32(0, wrapped.length, true);
		wrapped.set(built.bytes, 4);
		// With stripping disabled, the modelCount is read as the
		// file size — bogus, throws.
		expect(() => parseCharaOne(wrapped, { stripFileSizePrefix: false })).toThrow(
			/Implausible modelCount/,
		);
	});
});
