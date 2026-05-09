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
})
