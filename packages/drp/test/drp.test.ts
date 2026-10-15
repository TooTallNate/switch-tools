import { describe, it, expect } from 'vitest';
import { zlibSync } from 'fflate';
import { decryptDrp, isDrp, parseDrp, peekDrpPart, readDrpPart } from '../src/index.js';

/** Build a plaintext DRP with the given entries (each a list of part payloads). */
function buildDrp(entries: { name: string; parts: Uint8Array[]; compressed: boolean }[], seed: number) {
	const chunks: Uint8Array[] = [];
	const header = new Uint8Array(0x60);
	const hv = new DataView(header.buffer);
	hv.setUint32(0, 0x12345678, false);
	hv.setInt16(0x14, 4, false);
	hv.setInt16(0x16, entries.length, false);
	hv.setUint32(0x1c, seed, false);
	chunks.push(header);
	for (const e of entries) {
		const parts = e.parts.map((p) => {
			const payload = e.compressed ? zlibSync(p) : p;
			const len = 4 + payload.byteLength;
			const padded = new Uint8Array(len + ((16 - (len % 16)) % 16));
			new DataView(padded.buffer).setUint32(0, p.byteLength, false);
			padded.set(payload, 4);
			return padded;
		});
		const eh = new Uint8Array(0x60);
		const ev = new DataView(eh.buffer);
		eh.set(new TextEncoder().encode(e.name));
		ev.setInt16(0x40, 4096, false);
		ev.setInt16(0x42, 1, false);
		ev.setInt32(0x44, 0x60 + parts.reduce((s, p) => s + p.byteLength, 0), false);
		ev.setInt16(0x48, e.compressed ? 1 : 0, false);
		ev.setInt16(0x4a, parts.length, false);
		let end = 0;
		for (let k = 0; k < 4; k++) {
			if (k < parts.length) end += parts[k]!.byteLength;
			ev.setInt32(0x50 + k * 4, end, false);
		}
		chunks.push(eh, ...parts);
	}
	const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.byteLength;
	}
	return out;
}

describe('DRP', () => {
	it('round-trips the xorshift cipher and parses multi-part, nested-zlib entries', () => {
		const a = new TextEncoder().encode('NTWD texture bytes '.repeat(20));
		const b = new TextEncoder().encode('NDWD model bytes '.repeat(30));
		const nested = zlibSync(new TextEncoder().encode('inner layout '.repeat(10)));
		const plain = buildDrp(
			[
				{ name: 'model', parts: [a, b], compressed: true },
				{ name: 'layout_cs', parts: [nested], compressed: true },
				{ name: 'raw', parts: [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], compressed: false },
			],
			0x6d093648,
		);
		const encrypted = decryptDrp(plain);
		expect(isDrp(encrypted)).toBe(false);
		// The seed word stays in the clear.
		expect(encrypted.subarray(0x1c, 0x20)).toEqual(plain.subarray(0x1c, 0x20));

		const decrypted = decryptDrp(encrypted);
		expect(decrypted).toEqual(plain);
		const drp = parseDrp(decrypted);
		expect(drp.seed).toBe(0x6d093648);
		expect(drp.entries.map((e) => e.name)).toEqual(['model', 'layout_cs', 'raw']);
		const [model, layout, raw] = drp.entries;
		expect(readDrpPart(decrypted, model!, model!.parts[0]!)).toEqual(a);
		expect(readDrpPart(decrypted, model!, model!.parts[1]!)).toEqual(b);
		expect(new TextDecoder().decode(readDrpPart(decrypted, layout!, layout!.parts[0]!))).toBe('inner layout '.repeat(10));
		expect(readDrpPart(decrypted, layout!, layout!.parts[0]!, { unwrapNested: false })).toEqual(nested);
		expect(readDrpPart(decrypted, raw!, raw!.parts[0]!)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(new TextDecoder().decode(peekDrpPart(decrypted, model!, model!.parts[1]!, 4))).toBe('NDWD');
		expect(new TextDecoder().decode(peekDrpPart(decrypted, layout!, layout!.parts[0]!, 5))).toBe('inner');
		expect(peekDrpPart(decrypted, raw!, raw!.parts[0]!, 3)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('matches the known keystream for seed 0x6D093648', () => {
		// First 16 bytes of a real Pokkén DX avatar texture DRP decrypt to
		// a CRC and 12 zero bytes under this seed.
		const enc = new Uint8Array(0x20);
		enc.set([0x49, 0x57, 0x0f, 0x8a, 0xbf, 0x44, 0x84, 0x55, 0x95, 0x1b, 0x93, 0x21, 0x5b, 0x94, 0x64, 0x57]);
		new DataView(enc.buffer).setUint32(0x1c, 0x6d093648, false);
		const dec = decryptDrp(enc);
		expect(Array.from(dec.subarray(0, 16))).toEqual([0x16, 0xb9, 0x1a, 0xb5, ...new Array(12).fill(0)]);
	});
});
