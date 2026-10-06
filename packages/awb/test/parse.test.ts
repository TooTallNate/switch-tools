import { describe, expect, it } from 'vitest';
import { AWB_MAGIC, awbHeaderSize, isAwbMagic, parseAwb, parseAwbBlob, AwbParseError } from '../src/index.js';

/**
 * Synthetic AFS2 fixture builder. Constructs the smallest valid
 * header for a given track layout and pads the data section with
 * sentinel bytes so we can verify slice offsets.
 *
 * No commercial-game data — every byte is constructed here.
 */
function buildAwb(
	tracks: Array<{ id: number; size: number }>,
	options: {
		offsetSize?: 2 | 4;
		idSize?: 2 | 4;
		alignment?: number;
		subkey?: number;
		subtype?: number;
	} = {},
): { bytes: Uint8Array; trackStarts: number[] } {
	const offsetSize = options.offsetSize ?? 4;
	const idSize = options.idSize ?? 2;
	const alignment = options.alignment ?? 32;
	const subkey = options.subkey ?? 0;
	const subtype = options.subtype ?? 2;
	const trackCount = tracks.length;

	const headerBase = 0x10 + trackCount * idSize + (trackCount + 1) * offsetSize;

	// Compute aligned starts and unaligned offsets stored in the table.
	const offsets: number[] = [];
	let cursor = headerBase;
	for (const t of tracks) {
		const mod = cursor % alignment;
		const aligned = mod === 0 ? cursor : cursor + (alignment - mod);
		// The on-disk offset is the unaligned value; the parser will
		// re-apply alignment. Store the unaligned-rounded-down form
		// to match real-world AWBs.
		offsets.push(cursor);
		cursor = aligned + t.size;
	}
	offsets.push(cursor);

	const total = cursor;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	// Magic
	dv.setUint32(0, AWB_MAGIC, true);
	out[4] = subtype;
	out[5] = offsetSize;
	out[6] = idSize;
	out[7] = 0;
	dv.setUint32(8, trackCount, true);
	dv.setUint16(0x0c, alignment, true);
	dv.setUint16(0x0e, subkey, true);

	// Ids
	for (let i = 0; i < trackCount; i++) {
		if (idSize === 2) dv.setUint16(0x10 + i * 2, tracks[i]!.id, true);
		else dv.setUint32(0x10 + i * 4, tracks[i]!.id, true);
	}
	// Offsets
	const offsetTableStart = 0x10 + trackCount * idSize;
	for (let i = 0; i <= trackCount; i++) {
		if (offsetSize === 2) {
			dv.setUint16(offsetTableStart + i * 2, offsets[i]!, true);
		} else {
			dv.setUint32(offsetTableStart + i * 4, offsets[i]!, true);
		}
	}

	// Data — fill each track with sentinel bytes derived from its id.
	const trackStarts: number[] = [];
	let p = headerBase;
	for (const t of tracks) {
		const mod = p % alignment;
		if (mod !== 0) p += alignment - mod;
		trackStarts.push(p);
		for (let i = 0; i < t.size; i++) out[p + i] = (t.id + i) & 0xff;
		p += t.size;
	}
	return { bytes: out, trackStarts };
}

describe('isAwbMagic', () => {
	it('recognises "AFS2"', () => {
		expect(isAwbMagic(new Uint8Array([0x41, 0x46, 0x53, 0x32]))).toBe(true);
	});
	it('rejects other magics', () => {
		expect(isAwbMagic(new Uint8Array([0x48, 0x43, 0x41, 0x00]))).toBe(false);
		expect(isAwbMagic(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
	});
	it('returns false on short input', () => {
		expect(isAwbMagic(new Uint8Array([0x41, 0x46, 0x53]))).toBe(false);
		expect(isAwbMagic(new Uint8Array(0))).toBe(false);
	});
});

describe('parseAwb', () => {
	it('parses a 3-track bank with 4-byte offsets', () => {
		const { bytes, trackStarts } = buildAwb([
			{ id: 0, size: 100 },
			{ id: 1, size: 50 },
			{ id: 2, size: 200 },
		]);
		const parsed = parseAwb(bytes);
		expect(parsed.trackCount).toBe(3);
		expect(parsed.alignment).toBe(32);
		expect(parsed.subkey).toBe(0);
		expect(parsed.subtype).toBe(2);
		expect(parsed.offsetSize).toBe(4);
		expect(parsed.tracks).toHaveLength(3);
		expect(parsed.tracks[0]).toEqual({
			id: 0,
			offset: trackStarts[0],
			size: 100,
		});
		expect(parsed.tracks[1]).toEqual({
			id: 1,
			offset: trackStarts[1],
			size: 50,
		});
		expect(parsed.tracks[2]).toEqual({
			id: 2,
			offset: trackStarts[2],
			size: 200,
		});
	});

	it('parses an empty bank (trackCount=0)', () => {
		const { bytes } = buildAwb([]);
		const parsed = parseAwb(bytes);
		expect(parsed.trackCount).toBe(0);
		expect(parsed.tracks).toEqual([]);
	});

	it('rounds track starts up to the alignment boundary', () => {
		// alignment 16, first track at headerBase=0x10+2+8=0x1a → must round to 0x20.
		const { bytes } = buildAwb([{ id: 7, size: 4 }], { alignment: 16 });
		const parsed = parseAwb(bytes);
		expect(parsed.tracks[0]!.offset % 16).toBe(0);
		expect(parsed.tracks[0]!.size).toBe(4);
	});

	it('handles 2-byte offsets', () => {
		const { bytes } = buildAwb(
			[{ id: 0, size: 10 }, { id: 1, size: 10 }],
			{ offsetSize: 2 },
		);
		const parsed = parseAwb(bytes);
		expect(parsed.offsetSize).toBe(2);
		expect(parsed.trackCount).toBe(2);
		expect(parsed.tracks.every((t) => t.size === 10)).toBe(true);
	});

	it('surfaces the per-bank subkey for HCA decryption', () => {
		const { bytes } = buildAwb([{ id: 0, size: 8 }], { subkey: 0xabcd });
		const parsed = parseAwb(bytes);
		expect(parsed.subkey).toBe(0xabcd);
	});

	it('throws AwbParseError on bad magic', () => {
		const bytes = new Uint8Array(64);
		bytes[0] = 0x48; // "HCA"
		bytes[1] = 0x43;
		bytes[2] = 0x41;
		expect(() => parseAwb(bytes)).toThrow(AwbParseError);
	});

	it('throws on truncated header', () => {
		expect(() => parseAwb(new Uint8Array([0x41, 0x46, 0x53, 0x32]))).toThrow(
			/truncated/i,
		);
	});

	it('throws on implausible track count', () => {
		const bytes = new Uint8Array(64);
		new DataView(bytes.buffer).setUint32(0, AWB_MAGIC, true);
		bytes[4] = 2;
		bytes[5] = 4;
		bytes[6] = 2;
		bytes[7] = 0;
		new DataView(bytes.buffer).setUint32(8, 9_999_999, true);
		new DataView(bytes.buffer).setUint16(0x0c, 32, true);
		expect(() => parseAwb(bytes)).toThrow(/implausible/i);
	});

	it('throws on unsupported offset width', () => {
		const bytes = new Uint8Array(64);
		new DataView(bytes.buffer).setUint32(0, AWB_MAGIC, true);
		bytes[4] = 2;
		bytes[5] = 8; // bad width
		bytes[6] = 2;
		expect(() => parseAwb(bytes)).toThrow(/offset width/i);
	});

	it('handles 4-byte track ids', () => {
		// Super Mario RPG's BGM / SE banks use 32-bit ids.
		const { bytes, trackStarts } = buildAwb(
			[
				{ id: 0x12345, size: 40 },
				{ id: 7, size: 10 },
			],
			{ idSize: 4 },
		);
		const parsed = parseAwb(bytes);
		expect(parsed.idSize).toBe(4);
		expect(parsed.tracks.map((t) => [t.id, t.offset, t.size])).toEqual([
			[0x12345, trackStarts[0], 40],
			[7, trackStarts[1], 10],
		]);
	});

	it('throws on unsupported id width', () => {
		const { bytes } = buildAwb([{ id: 1, size: 4 }]);
		bytes[6] = 3;
		expect(() => parseAwb(bytes)).toThrow(/id width/i);
	});
});

describe('header sizing', () => {
	it('computes the header size from the first 16 bytes', () => {
		const { bytes } = buildAwb([{ id: 1, size: 4 }, { id: 2, size: 4 }], { idSize: 4 });
		expect(awbHeaderSize(bytes.subarray(0, 16))).toBe(0x10 + 2 * 4 + 3 * 4);
		expect(awbHeaderSize(new Uint8Array(16))).toBeNull();
	});

	it('parses banks whose tables exceed 64 KiB', async () => {
		// 12k tracks × (4-byte id + 4-byte offset) ≈ 96 KiB of table.
		const tracks = Array.from({ length: 12_000 }, (_, i) => ({ id: i * 3, size: 1 }));
		const { bytes } = buildAwb(tracks, { idSize: 4, alignment: 1 });
		const { parsed, tracks: out } = await parseAwbBlob(new Blob([bytes as BlobPart]));
		expect(parsed.trackCount).toBe(12_000);
		expect(out[11_999]!.id).toBe(11_999 * 3);
		expect(new Uint8Array(await out[11_999]!.blob.arrayBuffer())).toEqual(
			bytes.subarray(out[11_999]!.offset, out[11_999]!.offset + 1),
		);
	});
});

