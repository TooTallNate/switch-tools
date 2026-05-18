import { describe, it, expect } from 'vitest';
import {
	parsePhyre,
	findTexture,
	extractTexturePixels,
	encodeAsDds,
	findClass,
	findMember,
	bytesForMipLevel,
	flipDdsRowsInPlace,
	phyreNvnBlockHeight,
	deswizzleNvnMip,
	findMesh,
	PHYRE_MAGIC,
	PhyreParseError,
} from '../src/index.js';

/**
 * Hand-build the *minimum* viable phyre file: a top-level
 * header, a namespace with one trivial class, no instances, no
 * fixups. Used to exercise parsing paths without committing
 * thousands of bytes of test data.
 *
 * Layout:
 *   0x00 header (80 bytes) — DX11-style
 *   0x50 namespace (0x80 bytes)
 *   ...  (zero instances, zero fixups, zero payload)
 */
function makeMinimalPhyre(): Uint8Array {
	const HEADER_SIZE = 0x50;
	const NAMESPACE_HEADER_SIZE = 0x20;
	const NUM_CLASSES = 1;
	const NUM_MEMBERS = 0;
	const TYPE_TABLE_SIZE = 0; // no types
	const CLASS_TABLE_SIZE = NUM_CLASSES * 36;
	const MEMBER_TABLE_SIZE = NUM_MEMBERS * 24;
	// String table: "PFoo\0" (5 bytes)
	const stringTable = new TextEncoder().encode('PFoo\0');
	const NAMESPACE_SIZE =
		NAMESPACE_HEADER_SIZE +
		TYPE_TABLE_SIZE +
		CLASS_TABLE_SIZE +
		MEMBER_TABLE_SIZE +
		stringTable.byteLength;
	const total = HEADER_SIZE + NAMESPACE_SIZE;
	const buf = new Uint8Array(total);
	const v = new DataView(buf.buffer);

	// Top-level header
	v.setUint32(0x00, PHYRE_MAGIC, true);
	v.setUint32(0x04, HEADER_SIZE, true);
	v.setUint32(0x08, NAMESPACE_SIZE, true);
	// platformId = "DX11" (4 ASCII bytes at 0x0c)
	buf.set(new TextEncoder().encode('DX11'), 0x0c);
	// Remaining header fields default to zero (no instances, no fixups).

	// Namespace header (at offset HEADER_SIZE):
	const nsOff = HEADER_SIZE;
	v.setUint32(nsOff + 0x00, 0x01020304, true); // magic
	v.setUint32(nsOff + 0x04, NAMESPACE_SIZE, true); // size
	v.setUint32(nsOff + 0x08, 0, true); // typeCount
	v.setUint32(nsOff + 0x0c, NUM_CLASSES, true); // classCount
	v.setUint32(nsOff + 0x10, NUM_MEMBERS, true); // dataMemberCount
	v.setUint32(nsOff + 0x14, stringTable.byteLength, true); // stringTableSize
	v.setUint32(nsOff + 0x18, 0, true); // defaultBufferCount
	v.setUint32(nsOff + 0x1c, 0, true); // defaultBufferSize

	// Class table at nsOff + 0x20:
	const classTableStart = nsOff + 0x20;
	// PFoo: baseClassId=0, size=0, nameOffset=0 (points at start
	// of string table), 0 members
	v.setUint32(classTableStart + 0, 0, true); // baseClassId
	v.setUint32(classTableStart + 4, 0, true); // sizeAndAlign
	v.setUint32(classTableStart + 8, 0, true); // nameOffset
	v.setUint32(classTableStart + 12, 0, true); // dataMemberCount
	// rest of class descriptor stays zero

	// String table at end of namespace
	const stringTableStart = nsOff + NAMESPACE_SIZE - stringTable.byteLength;
	buf.set(stringTable, stringTableStart);
	return buf;
}

describe('parsePhyre — minimal synthetic file', () => {
	it('parses header + namespace with one class', () => {
		const buf = makeMinimalPhyre();
		const parsed = parsePhyre(buf);
		expect(parsed.header.magic).toBe(PHYRE_MAGIC);
		expect(parsed.header.size).toBe(0x50);
		expect(parsed.header.platformId).toBe('DX11');
		expect(parsed.header.instanceListCount).toBe(0);
		expect(parsed.header.userFixupCount).toBe(0);
		expect(parsed.namespace.classCount).toBe(1);
		expect(parsed.namespace.classes[0].name).toBe('PFoo');
		expect(parsed.namespace.classes[0].members).toEqual([]);
		expect(parsed.instances).toEqual([]);
		expect(parsed.userFixups).toEqual([]);
	});

	it('reports zero payload for a no-asset file', () => {
		const buf = makeMinimalPhyre();
		const parsed = parsePhyre(buf);
		expect(parsed.payloadSize).toBe(0);
		expect(parsed.payloadOffset).toBe(buf.length);
	});
});

describe('parsePhyre — error paths', () => {
	it('rejects files shorter than the magic', () => {
		expect(() => parsePhyre(new Uint8Array(8))).toThrow(PhyreParseError);
	});

	it('rejects wrong magic', () => {
		const buf = new Uint8Array(100);
		buf[0] = 0xff;
		expect(() => parsePhyre(buf)).toThrow(/bad magic/);
	});

	it('rejects big-endian magic with a clear message', () => {
		const buf = new Uint8Array(100);
		const v = new DataView(buf.buffer);
		v.setUint32(0, 0x52594850, true); // PHYRE_MAGIC_BE
		expect(() => parsePhyre(buf)).toThrow(/big-endian/);
	});

	it('rejects implausible header sizes', () => {
		const buf = makeMinimalPhyre();
		const v = new DataView(buf.buffer);
		v.setUint32(0x04, 0x1234, true); // way too big
		expect(() => parsePhyre(buf)).toThrow(/implausible header size/);
	});
});

describe('findClass / findMember', () => {
	it('finds an existing class', () => {
		const parsed = parsePhyre(makeMinimalPhyre());
		const cls = findClass(parsed.namespace, 'PFoo');
		expect(cls).not.toBeNull();
		expect(cls!.name).toBe('PFoo');
	});

	it('returns null for an unknown class', () => {
		const parsed = parsePhyre(makeMinimalPhyre());
		expect(findClass(parsed.namespace, 'PBar')).toBeNull();
	});

	it('returns null for an unknown member', () => {
		const parsed = parsePhyre(makeMinimalPhyre());
		const cls = findClass(parsed.namespace, 'PFoo')!;
		expect(findMember(cls, 'm_x')).toBeNull();
	});
});

describe('findTexture', () => {
	it('returns null when texture classes are absent', () => {
		const parsed = parsePhyre(makeMinimalPhyre());
		expect(findTexture(parsed)).toBeNull();
	});
});

describe('encodeAsDds — synthetic DXT1 texture', () => {
	it('produces a 128-byte standard DDS header', () => {
		const tex = {
			width: 64,
			height: 32,
			mipmapCount: 0,
			maxMipLevel: 0,
			textureFlags: 0,
			format: 'DXT1' as const,
			formatRaw: 'DXT1',
			pixelDataOffset: 0,
			pixelDataSize: 1024,
		};
		const pixels = new Uint8Array(1024); // empty body fine for header check
		const dds = encodeAsDds(tex, pixels);
		expect(dds.length).toBe(128 + 1024);
		const dec = new TextDecoder();
		expect(dec.decode(dds.slice(0, 4))).toBe('DDS ');
		const v = new DataView(dds.buffer);
		expect(v.getUint32(4, true)).toBe(124); // dwSize
		expect(v.getUint32(12, true)).toBe(32); // height
		expect(v.getUint32(16, true)).toBe(64); // width
		expect(v.getUint32(28, true)).toBe(1); // mip count (no mips → 1)
		// FourCC at offset 84 = 'DXT1'
		expect(dec.decode(dds.slice(84, 88))).toBe('DXT1');
	});

	it('adds DX10 extension header for BC7', () => {
		const tex = {
			width: 256,
			height: 256,
			mipmapCount: 1,
			maxMipLevel: 0,
			textureFlags: 0,
			format: 'BC7' as const,
			formatRaw: 'BC7',
			pixelDataOffset: 0,
			pixelDataSize: 65536,
		};
		const pixels = new Uint8Array(65536);
		const dds = encodeAsDds(tex, pixels);
		expect(dds.length).toBe(128 + 20 + 65536);
		const dec = new TextDecoder();
		expect(dec.decode(dds.slice(84, 88))).toBe('DX10');
		const v = new DataView(dds.buffer);
		expect(v.getUint32(128, true)).toBe(98); // DXGI_FORMAT_BC7_UNORM
	});

	it('encodes RGBA8 with the right pixel-format masks', () => {
		const tex = {
			width: 16,
			height: 16,
			mipmapCount: 0,
			maxMipLevel: 0,
			textureFlags: 0,
			format: 'RGBA8' as const,
			formatRaw: 'RGBA8',
			pixelDataOffset: 0,
			pixelDataSize: 16 * 16 * 4,
		};
		const dds = encodeAsDds(tex, new Uint8Array(16 * 16 * 4));
		const v = new DataView(dds.buffer);
		// RGB+ALPHA flags
		expect(v.getUint32(80, true)).toBe(0x1 | 0x40);
		expect(v.getUint32(88, true)).toBe(32); // dwRGBBitCount
		expect(v.getUint32(92, true)).toBe(0x000000ff); // rMask
		expect(v.getUint32(96, true)).toBe(0x0000ff00); // gMask
		expect(v.getUint32(100, true)).toBe(0x00ff0000); // bMask
		expect(v.getUint32(104, true)).toBe(0xff000000); // aMask
	});
});

describe('bytesForMipLevel', () => {
	it('DXT1 = 0.5 bytes per pixel (block-aligned)', () => {
		expect(bytesForMipLevel('DXT1', 64, 32)).toBe(1024); // 16*8*8
		expect(bytesForMipLevel('DXT1', 16, 16)).toBe(128); // 4*4*8
	});

	it('DXT5 / BC7 = 1 byte per pixel (block-aligned)', () => {
		expect(bytesForMipLevel('DXT5', 256, 256)).toBe(65536);
		expect(bytesForMipLevel('BC7', 256, 256)).toBe(65536);
	});

	it('RGBA8 = 4 bytes per pixel', () => {
		expect(bytesForMipLevel('RGBA8', 4096, 2048)).toBe(33554432);
	});

	it('rounds up to 4-pixel blocks for compressed formats', () => {
		// 5x5 in DXT1: 2 blocks × 2 blocks × 8 bytes = 32
		expect(bytesForMipLevel('DXT1', 5, 5)).toBe(32);
	});
});

describe('flipDdsRowsInPlace', () => {
	it('flips rows of a 4×4 RGBA8 texture', () => {
		// 4 rows of 4 RGBA pixels = 16 bytes per row, 64 bytes total
		const pixels = new Uint8Array(64);
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 16; x++) {
				pixels[y * 16 + x] = y; // row N filled with byte value N
			}
		}
		flipDdsRowsInPlace(pixels, 'RGBA8', 4, 4);
		// After flip: row 0 should be old row 3, row 3 should be old row 0
		expect(pixels[0]).toBe(3);
		expect(pixels[16]).toBe(2);
		expect(pixels[32]).toBe(1);
		expect(pixels[48]).toBe(0);
	});

	it('flips block rows for compressed formats', () => {
		// DXT1: 8×8 texture = 2×2 blocks × 8 bytes = 32 bytes
		const pixels = new Uint8Array(32);
		for (let row = 0; row < 2; row++) {
			for (let x = 0; x < 16; x++) {
				pixels[row * 16 + x] = row;
			}
		}
		flipDdsRowsInPlace(pixels, 'DXT1', 8, 8);
		expect(pixels[0]).toBe(1);
		expect(pixels[16]).toBe(0);
	});

	it('is a no-op for a 1-row texture', () => {
		const pixels = new Uint8Array(4);
		pixels[0] = 7;
		flipDdsRowsInPlace(pixels, 'RGBA8', 1, 1);
		expect(pixels[0]).toBe(7);
	});
});

describe('phyreNvnBlockHeight', () => {
	it('returns 1 for small textures (heightInBlocks < 8)', () => {
		expect(phyreNvnBlockHeight(1)).toBe(1);
		expect(phyreNvnBlockHeight(4)).toBe(1);
		expect(phyreNvnBlockHeight(7)).toBe(1);
	});

	it('matches the empirically verified FFX HD Switch samples', () => {
		// n349_anim: 64x32 DXT1 -> heightInBlocks = 8
		expect(phyreNvnBlockHeight(8)).toBe(1);
		// pause_it_es / guide_circle: 256x64 / 64x64 DXT5 -> hib = 16
		expect(phyreNvnBlockHeight(16)).toBe(2);
		// skip_*: 255x40 ARGB8 -> hib = 40 -> prev_pow2(5) = 4
		expect(phyreNvnBlockHeight(40)).toBe(4);
		// magic_0446: 256x256 DXT5 -> hib = 64
		expect(phyreNvnBlockHeight(64)).toBe(8);
		// font_0_0: 128x256 ARGB8 -> hib = 256, capped at 16
		expect(phyreNvnBlockHeight(256)).toBe(16);
	});

	it('caps at 16 for very tall surfaces', () => {
		expect(phyreNvnBlockHeight(128)).toBe(16);
		expect(phyreNvnBlockHeight(1024)).toBe(16);
		expect(phyreNvnBlockHeight(2048)).toBe(16);
	});

	it('rounds DOWN to the previous power of two (not up)', () => {
		// Critical: skip_* is hib=40 -> gobRows=5 -> bh=4 (not 8).
		// vgmstream's "next pow2" would give 8 here, which is wrong.
		expect(phyreNvnBlockHeight(40)).toBe(4);
		expect(phyreNvnBlockHeight(48)).toBe(4); // 48/8=6 -> 4
		expect(phyreNvnBlockHeight(56)).toBe(4); // 56/8=7 -> 4
	});
});

describe('deswizzleNvnMip', () => {
	it('is identity for a tiny texture (hib<8 -> bh=1, no swizzling)', () => {
		// 8x8 DXT1 = 2x2 blocks. With blockHeight=1 the swizzle
		// pattern collapses to row-major (one GOB covers everything).
		const data = new Uint8Array(2 * 2 * 8);
		for (let i = 0; i < data.length; i++) data[i] = i + 1;
		const out = deswizzleNvnMip({
			format: 'DXT1',
			width: 8,
			height: 8,
			data,
		});
		expect(out.byteLength).toBe(2 * 2 * 8);
		// Block (0,0) at start
		expect(out[0]).toBe(1);
	});

	it('produces the expected linear byte count for ARGB8', () => {
		// 128x256 ARGB8 = 131072 bytes linear
		const data = new Uint8Array(131072);
		const out = deswizzleNvnMip({
			format: 'ARGB8',
			width: 128,
			height: 256,
			data,
		});
		expect(out.byteLength).toBe(131072);
	});

	it('honors an explicit blockHeight override', () => {
		const data = new Uint8Array(16384);
		// Same input, different blockHeight -> different output
		const a = deswizzleNvnMip({
			format: 'DXT5',
			width: 256,
			height: 64,
			data: data.map((_, i) => i & 0xff),
			blockHeight: 2,
		});
		const b = deswizzleNvnMip({
			format: 'DXT5',
			width: 256,
			height: 64,
			data: data.map((_, i) => i & 0xff),
			blockHeight: 4,
		});
		expect(a.byteLength).toBe(b.byteLength);
		// Different swizzle => different byte ordering
		let differs = false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) {
				differs = true;
				break;
			}
		}
		expect(differs).toBe(true);
	});
});

describe('findMesh', () => {
	it('returns null for a phyre with no PMesh instance', () => {
		// The synthetic minimal phyre has no PMesh.
		const bytes = makeMinimalPhyre();
		const parsed = parsePhyre(bytes);
		expect(findMesh(parsed)).toBeNull();
	});
});
