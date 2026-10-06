import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { AstcDecoder, decodeAstcBytes } from "../src/index.js"

const wasmPath = fileURLToPath(new URL("../src/astc.wasm", import.meta.url))
async function loadWasm(): Promise<Uint8Array> {
	return new Uint8Array(await readFile(wasmPath))
}

// A safe, well-formed-but-trivial 16-byte block to use for input
// validation tests where we don't actually care about decoding it.
const STUB_BLOCK = new Uint8Array(16)

describe("AstcDecoder", () => {
	it("instantiates without error", async () => {
		const wasm = await loadWasm()
		const decoder = await AstcDecoder.create(wasm)
		expect(decoder).toBeDefined()
		decoder.dispose()
	})

	it("rejects undersized inputs", async () => {
		const wasm = await loadWasm()
		const decoder = await AstcDecoder.create(wasm)
		try {
			expect(() =>
				decoder.decode(8, 8, 4, 4, new Uint8Array(8)),
			).toThrowError(/source too short/)
		} finally {
			decoder.dispose()
		}
	})

	it("rejects out-of-range block sizes", async () => {
		const wasm = await loadWasm()
		const decoder = await AstcDecoder.create(wasm)
		try {
			expect(() => decoder.decode(4, 4, 3, 4, STUB_BLOCK)).toThrowError(
				/unsupported block size/,
			)
		} finally {
			decoder.dispose()
		}
	})

	it("rejects non-positive dimensions", async () => {
		const wasm = await loadWasm()
		const decoder = await AstcDecoder.create(wasm)
		try {
			expect(() =>
				decoder.decode(0, 4, 4, 4, STUB_BLOCK),
			).toThrowError(/must be positive/)
		} finally {
			decoder.dispose()
		}
	})

	it("exposes a one-shot decodeAstcBytes helper", async () => {
		// Smoke-test the helper without exercising real decode logic
		// (input-validation path).
		const wasm = await loadWasm()
		await expect(
			decodeAstcBytes(wasm, 8, 8, 4, 4, new Uint8Array(8)),
		).rejects.toThrowError(/source too short/)
	})

	it("decodes images larger than the WASM arena in strips", async () => {
		// 4096×2050 RGBA = 32 MiB of output, more than the 32 MiB arena
		// can hold alongside the input. Each block row is a solid
		// void-extent block whose red channel encodes the row index, so
		// stitching mistakes show up as wrong rows.
		const wasm = await loadWasm()
		const decoder = await AstcDecoder.create(wasm)
		try {
			const width = 4096
			const height = 2050 // not a multiple of the block height
			const blocksX = width / 4
			const blocksY = Math.ceil(height / 4)
			const src = new Uint8Array(blocksX * blocksY * 16)
			for (let by = 0; by < blocksY; by++) {
				const red = (by % 256) * 0x101 // UNORM16 so the 8-bit result is `by % 256`
				for (let bx = 0; bx < blocksX; bx++) {
					const o = (by * blocksX + bx) * 16
					// LDR void-extent block: mode 0x1FC, all-ones extent, then RGBA16.
					src.set([0xfc, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], o)
					src.set([red & 0xff, red >> 8, 0, 0, 0, 0, 0xff, 0xff], o + 8)
				}
			}
			const out = decoder.decode(width, height, 4, 4, src)
			expect(out.length).toBe(width * height * 4)
			for (const y of [0, 3, 4, 1000, 1023, 1024, 1025, 2047, 2049]) {
				const by = Math.floor(y / 4)
				const px = (y * width + 1234) * 4
				expect([out[px], out[px + 1], out[px + 2], out[px + 3]], `row ${y}`).toEqual([by % 256, 0, 0, 255])
			}
		} finally {
			decoder.dispose()
		}
	})
})

