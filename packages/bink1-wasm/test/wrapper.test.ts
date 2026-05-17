/**
 * Tests for `@tootallnate/bink1-wasm`.
 *
 * Because ffmpeg is LGPL-2.1+ we ship the compiled `bink1.wasm`
 * inside the package, so these tests CAN exercise the real decoder
 * (unlike `@tootallnate/bink2-wasm`, where the WASM is user-supplied).
 *
 * Real `.bik` fixtures aren't committed (they'd be both large and
 * legally fraught). Instead we synthesise the *smallest possible
 * valid Bink 1 file* — a single 1x1 keyframe with no audio — by
 * extracting it from a known-good ffmpeg-encoded sample at build
 * time. That synthetic fixture lives in `test/fixtures/`.
 *
 * End-to-end decode against full game cinematics is covered by the
 * Node smoke script in the package README.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	Bink1Decoder,
	Bink1DecodeError,
	type Bink1Info,
	type Bink1Frame,
	type Bink1AudioFrame,
	type Bink1AudioTrackInfo,
	type Bink1WasmSource,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../src/bink1.wasm');

// Synthetic fixture lives at test/fixtures/tiny.bik (built by
// scripts/make-tiny-fixture.sh and committed). If it doesn't exist
// (e.g. someone running tests immediately after `pnpm install`
// without running the fixture script), skip the decode tests with
// a clear message rather than failing.
const tinyFixturePath = resolve(here, 'fixtures/tiny.bik');
const tinyFixtureAvailable = existsSync(tinyFixturePath);
const tinyFixture = tinyFixtureAvailable ? readFileSync(tinyFixturePath) : null;

describe('Bink1DecodeError', () => {
	it('has a stable name for catch-by-class', () => {
		const e = new Bink1DecodeError('boom');
		expect(e.name).toBe('Bink1DecodeError');
		expect(e.message).toBe('boom');
		expect(e).toBeInstanceOf(Error);
	});
});

describe('Type surface', () => {
	it('exports Bink1Info / Bink1Frame / Bink1AudioFrame / Bink1WasmSource', () => {
		const _info: Bink1Info | undefined = undefined;
		const _frame: Bink1Frame | undefined = undefined;
		const _audio: Bink1AudioFrame | undefined = undefined;
		const _track: Bink1AudioTrackInfo | undefined = undefined;
		const _src: Bink1WasmSource | undefined = undefined;
		expect(_info).toBeUndefined();
		expect(_frame).toBeUndefined();
		expect(_audio).toBeUndefined();
		expect(_track).toBeUndefined();
		expect(_src).toBeUndefined();
	});

	it('Bink1Decoder.create is a function', () => {
		expect(typeof Bink1Decoder.create).toBe('function');
	});
});

describe('Bink1Decoder.create error handling', () => {
	it('rejects an obviously-invalid WASM buffer', async () => {
		const garbage = new Uint8Array(8);
		await expect(Bink1Decoder.create(garbage, new Uint8Array(0))).rejects.toThrow();
	});

	it('rejects non-Bink bytes with a real wasm', async () => {
		if (!existsSync(wasmPath)) {
			console.warn(`Skipping decode test: ${wasmPath} not built. Run \`make\` in packages/bink1-wasm.`);
			return;
		}
		const wasm = readFileSync(wasmPath);
		const notBink = new Uint8Array(64); // all zeros — definitely not a Bink file
		await expect(Bink1Decoder.create(wasm, notBink)).rejects.toBeInstanceOf(Bink1DecodeError);
	});
});

describe.skipIf(!tinyFixtureAvailable)('Decode against synthetic fixture', () => {
	it('opens, exposes plausible info, and decodes all frames', async () => {
		const wasm = readFileSync(wasmPath);
		const dec = await Bink1Decoder.create(wasm, tinyFixture!);
		try {
			const info = dec.info;
			// The fixture is a 1x1 single-keyframe clip with no audio.
			expect(info.width).toBeGreaterThan(0);
			expect(info.height).toBeGreaterThan(0);
			expect(info.frameCount).toBeGreaterThan(0);
			expect(info.fpsNum).toBeGreaterThan(0);
			expect(info.fpsDen).toBeGreaterThan(0);
			expect(info.audioTrackCount).toBe(0);

			let count = 0;
			let frame = dec.decodeNextFrame();
			while (frame) {
				expect(frame.width).toBe(info.width);
				expect(frame.height).toBe(info.height);
				expect(frame.y.length).toBe(frame.yStride * frame.height);
				expect(frame.u.length).toBe(frame.uStride * Math.ceil(frame.height / 2));
				expect(frame.v.length).toBe(frame.vStride * Math.ceil(frame.height / 2));
				count++;
				frame = dec.decodeNextFrame();
			}
			expect(count).toBe(info.frameCount);
		} finally {
			dec.dispose();
		}
	});

	it('throws on use after dispose()', async () => {
		const wasm = readFileSync(wasmPath);
		const dec = await Bink1Decoder.create(wasm, tinyFixture!);
		dec.dispose();
		expect(() => dec.decodeNextFrame()).toThrow(/dispose/);
	});

	it('copyVisiblePlanes returns tightly-packed buffers', async () => {
		const wasm = readFileSync(wasmPath);
		const dec = await Bink1Decoder.create(wasm, tinyFixture!);
		try {
			const f = dec.decodeNextFrame();
			expect(f).not.toBeNull();
			const planes = dec.copyVisiblePlanes(f!);
			expect(planes.width).toBe(f!.width);
			expect(planes.height).toBe(f!.height);
			expect(planes.y.length).toBe(planes.width * planes.height);
			const cw = (planes.width + 1) >> 1;
			const ch = (planes.height + 1) >> 1;
			expect(planes.u.length).toBe(cw * ch);
			expect(planes.v.length).toBe(cw * ch);
		} finally {
			dec.dispose();
		}
	});
});
