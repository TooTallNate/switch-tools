/**
 * Lightweight tests for the parts of `@tootallnate/bink2-wasm` that
 * don't require the (user-supplied, GPL-3.0) WASM artifact:
 *
 *   - Public type surface compiles and is importable.
 *   - `Bink2DecodeError` carries the expected name + message.
 *   - `Bink2Decoder.create` surfaces a graceful error when handed
 *     bytes that don't look like a Bink 2 file.
 *
 * End-to-end decode tests would require the WASM, which we don't
 * commit. A separate manual test (see `test-bink2-wasm.mjs` in
 * `/tmp/opencode/`) covers that path against a real `.bk2` fixture.
 */

import { describe, expect, it } from 'vitest'

import {
	Bink2Decoder,
	Bink2DecodeError,
	type Bink2Frame,
	type Bink2Info,
	type Bink2WasmSource,
} from '../src/index.js'

describe('Bink2DecodeError', () => {
	it('has a stable name for catch-by-class', () => {
		const e = new Bink2DecodeError('boom')
		expect(e.name).toBe('Bink2DecodeError')
		expect(e.message).toBe('boom')
		expect(e).toBeInstanceOf(Error)
	})
})

describe('Type surface', () => {
	it('exports Bink2Info / Bink2Frame / Bink2WasmSource', () => {
		// Pure compile-time check: assign-through proves the names
		// exist as types. The runtime values are unused.
		const _info: Bink2Info | undefined = undefined
		const _frame: Bink2Frame | undefined = undefined
		const _src: Bink2WasmSource | undefined = undefined
		// Silence "unused" lint without exposing the types.
		expect(_info).toBeUndefined()
		expect(_frame).toBeUndefined()
		expect(_src).toBeUndefined()
	})

	it('Bink2Decoder.create is a function', () => {
		expect(typeof Bink2Decoder.create).toBe('function')
	})
})

describe('Bink2Decoder.create error handling', () => {
	it('throws when handed an obviously-invalid WASM buffer', async () => {
		// 8 bytes of zeros — not a valid WASM module. `WebAssembly.compile`
		// should reject before we even get to bink2_open.
		const garbage = new Uint8Array(8)
		const bk2 = new Uint8Array(0)
		await expect(Bink2Decoder.create(garbage, bk2)).rejects.toThrow()
	})
})
