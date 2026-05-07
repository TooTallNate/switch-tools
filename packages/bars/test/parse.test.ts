import { describe, it, expect } from 'vitest';
import {
	BARS_MAGIC,
	AMTA_MAGIC,
	FWAV_MAGIC,
	FSTP_MAGIC,
	isBars,
	parseBars,
} from '../src/index.js';

/**
 * Build a minimal little-endian BARS archive with `n` tracks. Each
 * track gets:
 *   - an AMTA block with empty MARK / EXT_ and a STRG containing the
 *     given track name,
 *   - either a real FWAV/FSTP payload of the given length and magic,
 *     or a "stub" entry whose audio offset is `0xFFFFFFFF` (matches
 *     real shipped BARS like Zelda: BotW's `AkkareLabBgm.bars`).
 *
 * The DATA sub-block is filled with deterministic-but-meaningful
 * fields so we can exercise the parser's `AmtaData` decoder.
 */
function writeBarsLE(
	tracks: {
		name: string;
		hash: number;
		audio?: { magic: 'FWAV' | 'FSTP'; size: number; fillByte: number };
		data?: {
			channelCount: number;
			loopFlag: number;
			volume: number;
			loopStart: number;
			loopEnd: number;
		};
	}[],
): Uint8Array {
	const enc = new TextEncoder();

	// Pre-build each AMTA block so we know its size.
	const amtaBlocks = tracks.map((t) => buildAmta(t.name, t.data));
	const audios = tracks.map((t) =>
		t.audio ? buildFwav(t.audio.magic, t.audio.size, t.audio.fillByte) : null,
	);

	const headerSize = 0x10;
	const tableSize = tracks.length * (4 + 8);
	let cursor = headerSize + tableSize;

	const amtaOffsets: number[] = [];
	for (const blk of amtaBlocks) {
		amtaOffsets.push(cursor);
		cursor += blk.length;
	}
	const audioOffsets: number[] = [];
	for (const audio of audios) {
		if (!audio) {
			audioOffsets.push(0xffffffff);
			continue;
		}
		audioOffsets.push(cursor);
		cursor += audio.length;
	}

	const fileSize = cursor;
	const out = new Uint8Array(fileSize);
	const v = new DataView(out.buffer);

	// BARS header
	out.set(enc.encode(BARS_MAGIC), 0);
	v.setUint32(4, fileSize, true);
	out[8] = 0xff;
	out[9] = 0xfe; // BOM = LE
	out[10] = 0x01;
	out[11] = 0x01;
	v.setUint32(0x0c, tracks.length, true);

	// CRC32 hash table
	for (let i = 0; i < tracks.length; i++) {
		v.setUint32(headerSize + i * 4, tracks[i].hash >>> 0, true);
	}
	// Offset table
	const offsetBase = headerSize + tracks.length * 4;
	for (let i = 0; i < tracks.length; i++) {
		v.setUint32(offsetBase + i * 8, amtaOffsets[i], true);
		v.setUint32(offsetBase + i * 8 + 4, audioOffsets[i], true);
	}

	// AMTA blocks
	for (let i = 0; i < amtaBlocks.length; i++) {
		out.set(amtaBlocks[i], amtaOffsets[i]);
	}
	// Audio blocks
	for (let i = 0; i < audios.length; i++) {
		const audio = audios[i];
		if (audio) out.set(audio, audioOffsets[i]);
	}

	return out;
}

function buildAmta(
	name: string,
	data?: {
		channelCount: number;
		loopFlag: number;
		volume: number;
		loopStart: number;
		loopEnd: number;
	},
): Uint8Array {
	const enc = new TextEncoder();
	// AMTA header: 28 bytes (magic, BOM, pad, length, 4 sub-offsets)
	const headerSize = 0x1c;
	// DATA sub-block: 8-byte sub-header + 0x1C payload = 36 bytes
	const dataPayloadSize = 0x1c;
	const dataBlockSize = 8 + dataPayloadSize;
	// Empty MARK + EXT_ sub-blocks: 8 bytes each (header only).
	const markBlockSize = 8;
	const extBlockSize = 8;
	// STRG sub-block: 8 bytes header + (name + NUL).
	const nameBytes = enc.encode(name);
	const strgPayloadSize = nameBytes.length + 1;
	const strgBlockSize = 8 + strgPayloadSize;

	// Sub-offsets are relative to AMTA start.
	const dataOff = headerSize;
	const markOff = dataOff + dataBlockSize;
	const extOff = markOff + markBlockSize;
	const strgOff = extOff + extBlockSize;

	const total = strgOff + strgBlockSize;
	const buf = new Uint8Array(total);
	const v = new DataView(buf.buffer);

	// Header
	buf.set(enc.encode(AMTA_MAGIC), 0);
	buf[4] = 0xff;
	buf[5] = 0xfe; // BOM = LE
	v.setUint32(8, total, true);
	v.setUint32(0x0c, dataOff, true);
	v.setUint32(0x10, markOff, true);
	v.setUint32(0x14, extOff, true);
	v.setUint32(0x18, strgOff, true);

	// DATA sub-block
	buf.set(enc.encode('DATA'), dataOff);
	v.setUint32(dataOff + 4, dataPayloadSize, true);
	if (data) {
		// Layout matches what the parser decodes.
		v.setUint32(dataOff + 8 + 0x00, 0xdeadbeef, true); // flags
		v.setUint32(dataOff + 8 + 0x04, 0x12345678, true); // flags2
		buf[dataOff + 8 + 0x08] = data.loopFlag;
		buf[dataOff + 8 + 0x09] = data.channelCount;
		buf[dataOff + 8 + 0x0a] = 0; // sampleFormat
		v.setFloat32(dataOff + 8 + 0x0c, data.volume, true);
		v.setUint32(dataOff + 8 + 0x14, data.loopStart, true);
		v.setUint32(dataOff + 8 + 0x18, data.loopEnd, true);
	}

	// MARK sub-block (empty)
	buf.set(enc.encode('MARK'), markOff);
	v.setUint32(markOff + 4, 0, true);

	// EXT_ sub-block (empty)
	buf.set(enc.encode('EXT_'), extOff);
	v.setUint32(extOff + 4, 0, true);

	// STRG sub-block
	buf.set(enc.encode('STRG'), strgOff);
	v.setUint32(strgOff + 4, strgPayloadSize, true);
	buf.set(nameBytes, strgOff + 8);
	// trailing NUL implicit (Uint8Array is zero-initialised)

	return buf;
}

function buildFwav(magic: 'FWAV' | 'FSTP', size: number, fillByte: number): Uint8Array {
	if (size < 0x10) throw new Error('FWAV must be at least 16 bytes');
	const enc = new TextEncoder();
	const buf = new Uint8Array(size);
	buf.set(enc.encode(magic), 0);
	buf[4] = 0xff; // BOM = LE
	buf[5] = 0xfe;
	const v = new DataView(buf.buffer);
	v.setUint32(0x0c, size, true);
	for (let i = 0x10; i < size; i++) buf[i] = fillByte;
	return buf;
}

describe('isBars', () => {
	it('detects the magic', async () => {
		const buf = writeBarsLE([
			{ name: 'foo', hash: 0x12345678 },
		]);
		expect(await isBars(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects non-BARS blobs', async () => {
		expect(
			await isBars(new Blob([new Uint8Array([0x59, 0x61, 0x7a, 0x30])])),
		).toBe(false);
		expect(await isBars(new Blob([]))).toBe(false);
	});
});

describe('parseBars', () => {
	it('parses a single-track stub archive (no audio)', async () => {
		const buf = writeBarsLE([
			{
				name: 'Bgm_Spot_AkkareAncientLabo',
				hash: 0x2079fde9,
			},
		]);
		const parsed = await parseBars(new Blob([buf as BlobPart]));
		expect(parsed.endian).toBe('little');
		expect(parsed.fileSize).toBe(buf.length);
		expect(parsed.trackCount).toBe(1);
		expect(parsed.entries).toHaveLength(1);
		const t = parsed.entries[0];
		expect(t.name).toBe('Bgm_Spot_AkkareAncientLabo');
		expect(t.hashId).toBe(0x2079fde9);
		expect(t.audioKind).toBeNull();
		expect(t.audio).toBeNull();
		expect(t.audioSize).toBe(0);
	});

	it('parses tracks with FWAV audio payloads', async () => {
		const buf = writeBarsLE([
			{
				name: 'BgmA',
				hash: 0x11111111,
				audio: { magic: 'FWAV', size: 64, fillByte: 0xab },
				data: {
					channelCount: 2,
					loopFlag: 1,
					volume: 0.75,
					loopStart: 1024,
					loopEnd: 8192,
				},
			},
			{
				name: 'SfxB',
				hash: 0x22222222,
				audio: { magic: 'FSTP', size: 32, fillByte: 0xcd },
			},
		]);
		const parsed = await parseBars(new Blob([buf as BlobPart]));
		expect(parsed.entries).toHaveLength(2);
		const a = parsed.entries[0];
		expect(a.name).toBe('BgmA');
		expect(a.audioKind).toBe('fwav');
		expect(a.audioSize).toBe(64);
		expect(a.audio?.size).toBe(64);
		const aBytes = new Uint8Array(await a.audio!.arrayBuffer());
		expect(aBytes[0]).toBe(0x46); // 'F'
		expect(aBytes[16]).toBe(0xab);
		expect(a.amta.data?.channelCount).toBe(2);
		expect(a.amta.data?.loopFlag).toBe(1);
		expect(a.amta.data?.volume).toBeCloseTo(0.75, 5);
		expect(a.amta.data?.loopStart).toBe(1024);
		expect(a.amta.data?.loopEnd).toBe(8192);

		const b = parsed.entries[1];
		expect(b.name).toBe('SfxB');
		expect(b.audioKind).toBe('fstp');
		expect(b.audioSize).toBe(32);
	});

	it('exposes lazy Blob slices for audio payloads', async () => {
		const buf = writeBarsLE([
			{
				name: 'X',
				hash: 0,
				audio: { magic: 'FWAV', size: 256, fillByte: 0x55 },
			},
		]);
		const parsed = await parseBars(new Blob([buf as BlobPart]));
		expect(parsed.entries[0].audio).toBeInstanceOf(Blob);
		expect(parsed.entries[0].audio!.size).toBe(256);
	});

	it('throws on bad BARS magic', async () => {
		const buf = new Uint8Array(0x10);
		await expect(parseBars(new Blob([buf as BlobPart]))).rejects.toThrow(
			/BARS magic/,
		);
	});

	it('throws on too-small blob', async () => {
		await expect(parseBars(new Blob([]))).rejects.toThrow(/too small/);
	});

	it('throws on bogus BOM', async () => {
		const buf = writeBarsLE([{ name: 'x', hash: 0 }]);
		buf[8] = 0xaa; // mangle BOM
		buf[9] = 0xbb;
		await expect(parseBars(new Blob([buf as BlobPart]))).rejects.toThrow(
			/byte-order mark/,
		);
	});
});

describe('exported magic strings', () => {
	it('match the on-disk values', () => {
		expect(BARS_MAGIC).toBe('BARS');
		expect(AMTA_MAGIC).toBe('AMTA');
		expect(FWAV_MAGIC).toBe('FWAV');
		expect(FSTP_MAGIC).toBe('FSTP');
	});
});
