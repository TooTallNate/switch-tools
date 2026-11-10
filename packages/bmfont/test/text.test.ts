import { describe, expect, it } from "vitest"
import {
	isBmfont,
	isBmfontText,
	isBmfontXml,
	parseBmfont,
	parseBmfontText,
	parseBmfontXml,
	writeBmfontText,
} from "../src/index.js"

const TEXT = [
	'info face="My Font" size=-32 bold=1 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=1,2,3,4 spacing=1,1 outline=0',
	"common lineHeight=40 base=32 scaleW=256 scaleH=128 pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4",
	'page id=0 file="my font_0.png"',
	"chars count=2",
	"char id=65   x=1  y=2  width=20 height=24 xoffset=-1 yoffset=8 xadvance=21 page=0 chnl=15",
	"char id=66 x=22 y=2 width=18 height=24 xoffset=1 yoffset=8 xadvance=20 page=0 chnl=15",
	"kernings count=1",
	"kerning first=65 second=66 amount=-2",
].join("\r\n")

const XML = `<?xml version="1.0"?>
<font>
  <info face="My &amp; Font" size="32" bold="0" italic="1" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="0,0,0,0" spacing="1,1" />
  <common lineHeight="40" base="32" scaleW="256" scaleH="128" pages="1" packed="0" />
  <pages>
    <page id="0" file="font_0.png" />
  </pages>
  <chars count="1">
    <char id="65" x="1" y="2" width="20" height="24" xoffset="0" yoffset="8" xadvance="21" page="0" chnl="15" />
  </chars>
</font>`

const enc = (s: string) => new TextEncoder().encode(s)

describe("text descriptors", () => {
	it("detects and parses them", () => {
		expect(isBmfontText(enc(TEXT))).toBe(true)
		expect(isBmfontXml(enc(TEXT))).toBe(false)
		const f = parseBmfontText(TEXT)
		expect(f.info.face).toBe("My Font")
		expect(f.info.fontSize).toBe(-32)
		expect(f.info.flags.bold).toBe(true)
		expect(f.info.padding).toEqual({ up: 1, right: 2, down: 3, left: 4 })
		expect(f.common).toMatchObject({ lineHeight: 40, base: 32, scaleW: 256, scaleH: 128, pages: 1 })
		expect(f.pages).toEqual(["my font_0.png"])
		expect(f.chars).toHaveLength(2)
		expect(f.chars[0]).toEqual({ id: 65, x: 1, y: 2, width: 20, height: 24, xoffset: -1, yoffset: 8, xadvance: 21, page: 0, chnl: 15 })
		expect(f.kernings).toEqual([{ first: 65, second: 66, amount: -2 }])
	})

	it("round-trips through writeBmfontText", () => {
		const f = parseBmfontText(TEXT)
		expect(parseBmfontText(writeBmfontText(f))).toEqual(f)
	})
})

describe("XML descriptors", () => {
	it("detects and parses them, decoding entities", () => {
		expect(isBmfontXml(enc(XML))).toBe(true)
		const f = parseBmfontXml(XML)
		expect(f.info.face).toBe("My & Font")
		expect(f.info.flags.italic).toBe(true)
		expect(f.pages).toEqual(["font_0.png"])
		expect(f.chars[0]!.xadvance).toBe(21)
	})
})

describe("parseBmfont", () => {
	it("picks the encoding", () => {
		expect(parseBmfont(enc(TEXT)).info.face).toBe("My Font")
		expect(parseBmfont(enc(XML)).info.face).toBe("My & Font")
		expect(isBmfont(enc("hello"))).toBe(false)
		expect(() => parseBmfont(enc("hello"))).toThrow(/Not a BMFont/)
	})
})
