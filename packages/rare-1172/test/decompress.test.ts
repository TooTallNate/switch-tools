import { describe, it, expect } from 'vitest';
import {
	RARE_1172_MAGIC,
	decompressRare1172,
	isRare1172,
	scanRare1172,
} from '../src/index.js';

/**
 * Build a Rare 1172 container around `payload` using the platform's
 * CompressionStream — the mirror of the decoder's
 * DecompressionStream, so no ROM data is needed.
 */
async function makeContainer(payload: Uint8Array): Promise<Uint8Array> {
	const stream = new CompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	void writer.write(payload);
	void writer.close();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.readable.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}
	const out = new Uint8Array(2 + total);
	out[0] = 0x11;
	out[1] = 0x72;
	let position = 2;
	for (const chunk of chunks) {
		out.set(chunk, position);
		position += chunk.length;
	}
	return out;
}

/** Deterministic, compressible test payload. */
function payload(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	let state = seed;
	for (let i = 0; i < size; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		// Restrict the alphabet so the data actually compresses.
		out[i] = (state >> 16) & 0x0f;
	}
	return out;
}

describe('isRare1172', () => {
	it('matches the two-byte magic', () => {
		expect(RARE_1172_MAGIC).toBe(0x1172);
		expect(isRare1172(Uint8Array.from([0x11, 0x72, 0x00]))).toBe(true);
		expect(isRare1172(Uint8Array.from([0x00, 0x11, 0x72]), 1)).toBe(true);
		expect(isRare1172(Uint8Array.from([0x11, 0x73]))).toBe(false);
		expect(isRare1172(Uint8Array.from([0x11]))).toBe(false);
		expect(isRare1172(new Uint8Array(0))).toBe(false);
	});
});

describe('decompressRare1172', () => {
	it('round-trips a payload', async () => {
		const original = payload(4096);
		const container = await makeContainer(original);
		const out = await decompressRare1172(container);
		expect(out.length).toBe(original.length);
		expect(Array.from(out.subarray(0, 64))).toEqual(
			Array.from(original.subarray(0, 64)),
		);
	});

	it('actually compresses (so the fixture is meaningful)', async () => {
		const container = await makeContainer(payload(8192));
		expect(container.length).toBeLessThan(8192);
	});

	it('decompresses at a non-zero offset', async () => {
		const original = payload(1024, 7);
		const container = await makeContainer(original);
		const buf = new Uint8Array(16 + container.length);
		buf.set(container, 16);
		const out = await decompressRare1172(buf, 16);
		expect(out.length).toBe(1024);
	});

	it('ignores trailing data after the stream', async () => {
		const original = payload(512, 3);
		const container = await makeContainer(original);
		const buf = new Uint8Array(container.length + 256);
		buf.set(container, 0);
		buf.fill(0xcd, container.length);
		const out = await decompressRare1172(buf);
		expect(out.length).toBe(512);
	});

	it('honours an explicit end bound', async () => {
		const a = await makeContainer(payload(300, 11));
		const b = await makeContainer(payload(300, 12));
		const buf = new Uint8Array(a.length + b.length);
		buf.set(a, 0);
		buf.set(b, a.length);
		// Bounding at the second file's offset must still fully
		// decode the first — the contiguity property the scanner
		// relies on.
		const out = await decompressRare1172(buf, 0, { end: a.length });
		expect(out.length).toBe(300);
	});

	it('rejects a bad magic', async () => {
		await expect(
			decompressRare1172(Uint8Array.from([0x00, 0x00, 0x00, 0x00])),
		).rejects.toThrow(/bad magic/i);
	});

	it('rejects an empty payload', async () => {
		await expect(
			decompressRare1172(Uint8Array.from([0x11, 0x72])),
		).rejects.toThrow(/empty payload/i);
	});

	it('rejects a corrupt stream without leaving an unhandled rejection', async () => {
		const container = await makeContainer(payload(2048));
		// Corrupt the middle of the DEFLATE data.
		for (let i = 8; i < Math.min(container.length, 40); i++) {
			container[i] ^= 0xff;
		}
		await expect(decompressRare1172(container)).rejects.toBeDefined();
	});

	it('rejects truncated input', async () => {
		const container = await makeContainer(payload(4096));
		await expect(
			decompressRare1172(container.subarray(0, container.length >> 1)),
		).rejects.toBeDefined();
	});
});

describe('scanRare1172', () => {
	it('finds a run of contiguous containers', async () => {
		const parts = await Promise.all([
			makeContainer(payload(1000, 1)),
			makeContainer(payload(2000, 2)),
			makeContainer(payload(3000, 3)),
		]);
		const total = parts.reduce((s, p) => s + p.length, 0);
		const buf = new Uint8Array(total);
		let position = 0;
		const offsets: number[] = [];
		for (const p of parts) {
			offsets.push(position);
			buf.set(p, position);
			position += p.length;
		}
		const files = await scanRare1172(buf);
		expect(files.map((f) => f.offset)).toEqual(offsets);
		expect(files.map((f) => f.size)).toEqual([1000, 2000, 3000]);
	});

	it('finds containers embedded in surrounding noise', async () => {
		const container = await makeContainer(payload(1500, 9));
		const buf = new Uint8Array(8192);
		let state = 4242;
		for (let i = 0; i < buf.length; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			buf[i] = (state >> 16) & 0xff;
		}
		buf.set(container, 0x400);
		// A lone container has no neighbour, so opt out of the
		// isolation filter (exercised separately below).
		const files = await scanRare1172(buf, { isolatedMinSize: 0 });
		const hit = files.find((f) => f.offset === 0x400);
		expect(hit).toBeDefined();
		expect(hit!.size).toBe(1500);
	});

	it('finds nothing in pure noise', async () => {
		const buf = new Uint8Array(16384);
		let state = 31337;
		for (let i = 0; i < buf.length; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			buf[i] = (state >> 16) & 0xff;
		}
		expect(await scanRare1172(buf)).toEqual([]);
	});

	it('respects minSize', async () => {
		const container = await makeContainer(payload(200, 5));
		const buf = new Uint8Array(container.length + 64);
		buf.set(container, 0);
		expect(
			await scanRare1172(buf, { minSize: 500, isolatedMinSize: 0 }),
		).toEqual([]);
		expect(
			(await scanRare1172(buf, { minSize: 100, isolatedMinSize: 0 })).length,
		).toBe(1);
	});

	it('respects limit', async () => {
		const parts = await Promise.all([
			makeContainer(payload(500, 1)),
			makeContainer(payload(500, 2)),
			makeContainer(payload(500, 3)),
		]);
		const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
		let position = 0;
		for (const p of parts) {
			buf.set(p, position);
			position += p.length;
		}
		expect((await scanRare1172(buf, { limit: 2 })).length).toBe(2);
	});

	it('drops a small isolated container but keeps a large one', async () => {
		const small = await makeContainer(payload(200, 21));
		const large = await makeContainer(payload(16384, 22));
		const mk = (c: Uint8Array) => {
			// Surround with noise so the container has no neighbour.
			const buf = new Uint8Array(c.length + 4096);
			let state = 5150;
			for (let i = 0; i < buf.length; i++) {
				state = (state * 1103515245 + 12345) & 0x7fffffff;
				buf[i] = (state >> 16) & 0xff;
			}
			buf.set(c, 2048);
			return buf;
		};
		// Default isolatedMinSize (4096) rejects the 200-byte file...
		expect(
			(await scanRare1172(mk(small))).find((f) => f.offset === 2048),
		).toBeUndefined();
		// ...but keeps the 16 KiB one, since a valid DEFLATE stream
		// that long cannot plausibly occur by chance.
		expect(
			(await scanRare1172(mk(large))).find((f) => f.offset === 2048),
		).toBeDefined();
	});

	it('keeps small files when they are adjacent to neighbours', async () => {
		// Three tiny contiguous files: each is far under
		// isolatedMinSize but they vouch for each other.
		const parts = await Promise.all([
			makeContainer(payload(200, 31)),
			makeContainer(payload(200, 32)),
			makeContainer(payload(200, 33)),
		]);
		const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
		let position = 0;
		for (const p of parts) {
			buf.set(p, position);
			position += p.length;
		}
		const files = await scanRare1172(buf);
		expect(files.length).toBe(3);
		expect(files.every((f) => f.size === 200)).toBe(true);
	});
});
