import { describe, expect, it } from "vitest"
import { isUpak, isUpakV11, parseUpak, readUpakEntry } from "../src/index.js"

const PAK_MAGIC = 0x5a6f12e1

/** Writer for little-endian UE serialisation. */
class W {
	bytes: number[] = []
	u8(v: number) { this.bytes.push(v & 0xff) }
	u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (i * 8)) }
	i64(v: number) { this.u32(v); this.u32(Math.floor(v / 2 ** 32)) }
	raw(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.u8(b[i]!) }
	fstring(s: string) { this.u32(s.length + 1); this.raw(new TextEncoder().encode(s)); this.u8(0) }
	/** Uncompressed FPakEntry (used both in the index and before the payload). */
	entry(offset: number, size: number) {
		this.i64(offset); this.i64(size); this.i64(size)
		this.u32(0) // compression flags
		this.raw(new Uint8Array(20)) // sha1
		this.u8(0) // encrypted
		this.u32(0) // compression block size
	}
}

/** A v4 PAK (UE 4.16–4.19, e.g. Octopath Traveler) with two uncompressed files. */
function buildV4Pak(): Uint8Array {
	const w = new W()
	const files = [["Game/Content/a.txt", "alpha\n"], ["Game/Content/sub/b.txt", "bravo!\n"]] as const
	const offsets: number[] = []
	for (const [, body] of files) {
		offsets.push(w.bytes.length)
		w.entry(0, body.length)
		w.raw(new TextEncoder().encode(body))
	}
	const indexOffset = w.bytes.length
	w.fstring("../../../")
	w.u32(files.length)
	files.forEach(([name, body], i) => { w.fstring(name); w.entry(offsets[i]!, body.length) })
	const indexSize = w.bytes.length - indexOffset
	// Footer (45 bytes): encrypted flag, magic, version, index offset/size, sha1.
	w.u8(0); w.u32(PAK_MAGIC); w.u32(4); w.i64(indexOffset); w.i64(indexSize); w.raw(new Uint8Array(20))
	return Uint8Array.from(w.bytes)
}

describe("legacy PAK (v3–v9)", () => {
	it("detects v4 footers", async () => {
		const blob = new Blob([buildV4Pak() as BlobPart])
		expect(await isUpakV11(blob)).toBe(false)
		expect(await isUpak(blob)).toBe(true)
	})

	it("parses the index and reads uncompressed entries", async () => {
		const blob = new Blob([buildV4Pak() as BlobPart])
		const pak = await parseUpak(blob)
		expect(pak.footer.version).toBe(4)
		expect(pak.footer.encryptedIndex).toBe(false)
		expect(pak.entries.map((e) => [e.path, e.uncompressedSize])).toEqual([
			["Game/Content/a.txt", 6],
			["Game/Content/sub/b.txt", 7],
		])
		const texts = await Promise.all(pak.entries.map(async (e) => (await readUpakEntry(blob, e, pak.footer)).text()))
		expect(texts).toEqual(["alpha\n", "bravo!\n"])
	})

	it("rejects an encrypted v4 index", async () => {
		const bytes = buildV4Pak()
		bytes[bytes.length - 45] = 1
		await expect(parseUpak(new Blob([bytes as BlobPart]))).rejects.toThrow(/encrypted index/)
	})
})
