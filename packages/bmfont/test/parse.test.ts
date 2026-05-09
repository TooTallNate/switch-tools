import { describe, expect, it } from "vitest"
import {
	isBmfontBinary,
	parseBmfontBinary,
} from "../src/index.js"

/**
 * Build a minimal but valid v3 BMF binary file in memory. Produces:
 *
 *   - Magic header `BMF\3`
 *   - Block 1 (info)    — face "Synthetic", size 32, all flags off
 *   - Block 2 (common)  — lineHeight 40, base 32, atlas 256×256, 1 page
 *   - Block 3 (pages)   — single page filename `synthetic_0.png\0`
 *   - Block 4 (chars)   — two glyphs (`A` and `B`)
 *   - Block 5 (kerning) — single pair (`A` → `B`, -2px)
 *
 * No commercial game data — every byte is constructed here.
 */
function buildSyntheticBmfont(): Uint8Array {
	const enc = new TextEncoder()

	// ----- Block 1: info -----
	const faceName = enc.encode("Synthetic")
	const infoSize = 14 + faceName.length + 1 // fixed-size fields + name + NUL
	const info = new Uint8Array(infoSize)
	const iv = new DataView(info.buffer)
	iv.setInt16(0, 32, true) // fontSize
	iv.setUint8(2, 0) // bitField
	iv.setUint8(3, 0) // charSet
	iv.setUint16(4, 100, true) // stretchH
	iv.setUint8(6, 1) // aa
	iv.setUint8(7, 1) // padding up
	iv.setUint8(8, 1) // padding right
	iv.setUint8(9, 1) // padding down
	iv.setUint8(10, 1) // padding left
	iv.setUint8(11, 0) // spacing horiz
	iv.setUint8(12, 0) // spacing vert
	iv.setUint8(13, 0) // outline
	info.set(faceName, 14)
	info[14 + faceName.length] = 0 // NUL

	// ----- Block 2: common -----
	const common = new Uint8Array(15)
	const cv = new DataView(common.buffer)
	cv.setUint16(0, 40, true) // lineHeight
	cv.setUint16(2, 32, true) // base
	cv.setUint16(4, 256, true) // scaleW
	cv.setUint16(6, 256, true) // scaleH
	cv.setUint16(8, 1, true) // pages
	cv.setUint8(10, 0) // bitField (packed=false)
	cv.setUint8(11, 0) // alphaChnl
	cv.setUint8(12, 0) // redChnl
	cv.setUint8(13, 0) // greenChnl
	cv.setUint8(14, 0) // blueChnl

	// ----- Block 3: pages -----
	const pageName = "synthetic_0.png"
	const pages = new Uint8Array(pageName.length + 1)
	pages.set(enc.encode(pageName), 0)
	// Trailing NUL is already 0 from Uint8Array init.

	// ----- Block 4: chars -----
	const charA = new Uint8Array(20)
	const av = new DataView(charA.buffer)
	av.setUint32(0, 65, true) // id 'A'
	av.setUint16(4, 0, true) // x
	av.setUint16(6, 0, true) // y
	av.setUint16(8, 24, true) // width
	av.setUint16(10, 32, true) // height
	av.setInt16(12, 0, true) // xoffset
	av.setInt16(14, 4, true) // yoffset
	av.setInt16(16, 26, true) // xadvance
	av.setUint8(18, 0) // page
	av.setUint8(19, 15) // chnl
	const charB = new Uint8Array(20)
	const bv = new DataView(charB.buffer)
	bv.setUint32(0, 66, true) // id 'B'
	bv.setUint16(4, 24, true) // x
	bv.setUint16(6, 0, true) // y
	bv.setUint16(8, 22, true) // width
	bv.setUint16(10, 32, true) // height
	bv.setInt16(12, 1, true) // xoffset
	bv.setInt16(14, 4, true) // yoffset
	bv.setInt16(16, 24, true) // xadvance
	bv.setUint8(18, 0)
	bv.setUint8(19, 15)
	const chars = new Uint8Array([...charA, ...charB])

	// ----- Block 5: kerning -----
	const kerning = new Uint8Array(10)
	const kv = new DataView(kerning.buffer)
	kv.setUint32(0, 65, true) // first 'A'
	kv.setUint32(4, 66, true) // second 'B'
	kv.setInt16(8, -2, true) // amount

	// Stitch all blocks together.
	const blocks: { type: number; payload: Uint8Array }[] = [
		{ type: 1, payload: info },
		{ type: 2, payload: common },
		{ type: 3, payload: pages },
		{ type: 4, payload: chars },
		{ type: 5, payload: kerning },
	]
	const totalSize =
		4 +
		blocks.reduce((s, b) => s + 1 + 4 + b.payload.length, 0)
	const out = new Uint8Array(totalSize)
	out[0] = 0x42 // B
	out[1] = 0x4d // M
	out[2] = 0x46 // F
	out[3] = 0x03 // version
	let off = 4
	for (const b of blocks) {
		out[off++] = b.type
		new DataView(out.buffer, off, 4).setInt32(0, b.payload.length, true)
		off += 4
		out.set(b.payload, off)
		off += b.payload.length
	}
	return out
}

describe("isBmfontBinary", () => {
	it("accepts a valid BMF\\3 header", () => {
		expect(isBmfontBinary(new Uint8Array([0x42, 0x4d, 0x46, 0x03]))).toBe(true)
	})
	it("rejects wrong magic", () => {
		expect(isBmfontBinary(new Uint8Array([0x50, 0x4e, 0x47, 0x0d]))).toBe(false)
	})
	it("rejects truncated input", () => {
		expect(isBmfontBinary(new Uint8Array([0x42, 0x4d, 0x46]))).toBe(false)
	})
})

describe("parseBmfontBinary", () => {
	it("decodes a synthetic v3 file", () => {
		const bytes = buildSyntheticBmfont()
		const f = parseBmfontBinary(bytes)
		expect(f.version).toBe(3)
		expect(f.info.face).toBe("Synthetic")
		expect(f.info.fontSize).toBe(32)
		expect(f.info.aa).toBe(1)
		expect(f.info.padding).toEqual({ up: 1, right: 1, down: 1, left: 1 })
		expect(f.common.lineHeight).toBe(40)
		expect(f.common.base).toBe(32)
		expect(f.common.scaleW).toBe(256)
		expect(f.common.scaleH).toBe(256)
		expect(f.common.pages).toBe(1)
		expect(f.pages).toEqual(["synthetic_0.png"])
		expect(f.chars).toHaveLength(2)
		expect(f.chars[0]).toMatchObject({
			id: 65,
			width: 24,
			height: 32,
			xadvance: 26,
		})
		expect(f.chars[1]).toMatchObject({
			id: 66,
			x: 24,
			width: 22,
			xadvance: 24,
		})
		expect(f.kernings).toHaveLength(1)
		expect(f.kernings[0]).toEqual({ first: 65, second: 66, amount: -2 })
	})

	it("rejects non-BMF input", () => {
		expect(() =>
			parseBmfontBinary(new Uint8Array([0x50, 0x4e, 0x47, 0x0d, 0x0a])),
		).toThrowError(/Not a BMFont binary file/)
	})

	it("rejects unsupported version", () => {
		const bytes = new Uint8Array([0x42, 0x4d, 0x46, 0x02])
		expect(() => parseBmfontBinary(bytes)).toThrowError(
			/Unsupported BMFont binary version 2/,
		)
	})
})
