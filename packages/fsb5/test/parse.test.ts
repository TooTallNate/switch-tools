import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	parseFsb5,
	isFsb5,
	SOUND_FORMAT,
	SOUND_FORMAT_NAMES,
	METADATA_CHUNK_TYPE,
	loadFmodVorbisSetupPackets,
	decodeSampleToBlob,
	encodeWavBlob,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP_BIN = resolve(HERE, '..', 'assets', 'fmod_vorbis_setup_packets.bin');

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 *
 * The bundled `fmod_vorbis_setup_packets.bin` asset is BSD/MIT-
 * licensed reference data derived from python-fsb5's `vorbis_headers.py`
 * lookup table; we test it at the parse-table level (verifying entry
 * count + format contract) but never against game-extracted FSB5s.
 */

/**
 * Build a synthetic FSB5 with the given header + samples + per-sample
 * data payloads. The sample header packing matches the spec exactly:
 *   bit 0      : has_more_chunks
 *   bits 1-4   : frequency code
 *   bit 5      : channels (0=1, 1=2)
 *   bits 6-33  : dataOffset / 16  (28 bits)
 *   bits 34-63 : numSamples (30 bits)
 */
function buildFsb5(opts: {
	mode: number;
	samples: Array<{
		freqCode: number;
		channels: number;
		numSamples: number;
		data: Uint8Array;
		name?: string;
		metadata?: Array<{ type: number; payload: Uint8Array }>;
	}>;
}): Uint8Array {
	const { mode, samples } = opts;

	// Sample headers: each is 8 bytes + optional metadata chunks.
	const sampleHeaderParts: Uint8Array[] = [];
	const sampleDataParts: Uint8Array[] = [];
	let dataAreaSize = 0;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i];
		const dataOffset = dataAreaSize; // bytes from start of data area
		dataAreaSize += alignTo(s.data.length, 16);

		// Pack the 64-bit header.
		const meta = s.metadata ?? [];
		const hasMore = meta.length > 0 ? 1 : 0;
		// Build (lo, hi) u32 pair from bit fields.
		// lo: bits 0..31 → bit0=hasMore, bits1-4=freq, bit5=channels-1, bits6-31=dataOffset/16 low 26
		const dataOffShifted = dataOffset / 16;
		if (!Number.isInteger(dataOffShifted) || dataOffShifted < 0) {
			throw new Error('dataOffset must be 16-byte-aligned and >=0');
		}
		const lo =
			(hasMore & 0x1) |
			((s.freqCode & 0xf) << 1) |
			(((s.channels - 1) & 0x1) << 5) |
			((dataOffShifted & 0x3ffffff) << 6); // 26 of 28 bits
		// hi: bits 0..1 = top 2 bits of dataOffset/16, bits 2..31 = numSamples (30 bits)
		const dataOffHigh = (dataOffShifted >>> 26) & 0x3;
		const hi = (dataOffHigh & 0x3) | ((s.numSamples & 0x3fffffff) << 2);

		const headerParts: Uint8Array[] = [];
		const baseHeader = new Uint8Array(8);
		const dv = new DataView(baseHeader.buffer);
		dv.setUint32(0, lo >>> 0, true);
		dv.setUint32(4, hi >>> 0, true);
		headerParts.push(baseHeader);

		// Metadata chunks: each is u32 packed (next u1, size u24, type u7) + payload.
		for (let m = 0; m < meta.length; m++) {
			const isLast = m === meta.length - 1;
			const next = isLast ? 0 : 1;
			const chunk = new Uint8Array(4 + meta[m].payload.length);
			const cdv = new DataView(chunk.buffer);
			const word =
				(next & 0x1) |
				((meta[m].payload.length & 0xffffff) << 1) |
				((meta[m].type & 0x7f) << 25);
			cdv.setUint32(0, word >>> 0, true);
			chunk.set(meta[m].payload, 4);
			headerParts.push(chunk);
		}

		// Concat into a single per-sample header.
		const headerLen = headerParts.reduce((a, p) => a + p.length, 0);
		const sampleHeader = new Uint8Array(headerLen);
		let off = 0;
		for (const p of headerParts) {
			sampleHeader.set(p, off);
			off += p.length;
		}
		sampleHeaderParts.push(sampleHeader);

		// Pad data to 16 bytes.
		const padded = new Uint8Array(alignTo(s.data.length, 16));
		padded.set(s.data, 0);
		sampleDataParts.push(padded);
	}

	const sampleHeadersBlob = concat(sampleHeaderParts);
	const dataBlob = concat(sampleDataParts);

	// Optional name table.
	let nameTable = new Uint8Array(0);
	if (samples.some((s) => s.name)) {
		const offsets = new Uint8Array(samples.length * 4);
		const names: Uint8Array[] = [];
		const offsetsDv = new DataView(offsets.buffer);
		let nameAreaOffset = samples.length * 4;
		for (let i = 0; i < samples.length; i++) {
			offsetsDv.setUint32(i * 4, nameAreaOffset, true);
			const enc = new TextEncoder().encode((samples[i].name ?? `${i}`) + '\0');
			names.push(enc);
			nameAreaOffset += enc.length;
		}
		nameTable = concat([offsets, ...names]);
	}

	const header = new Uint8Array(60);
	const hdv = new DataView(header.buffer);
	header.set([0x46, 0x53, 0x42, 0x35], 0); // "FSB5"
	hdv.setUint32(4, 1, true); // version=1 → 60-byte header
	hdv.setUint32(8, samples.length, true);
	hdv.setUint32(12, sampleHeadersBlob.length, true);
	hdv.setUint32(16, nameTable.length, true);
	hdv.setUint32(20, dataBlob.length, true);
	hdv.setUint32(24, mode, true);
	// 28..52 = zero/hash/dummy fields (we leave zeros).

	return concat([header, sampleHeadersBlob, nameTable, dataBlob]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((a, p) => a + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

function alignTo(n: number, align: number): number {
	const r = n % align;
	return r === 0 ? n : n + align - r;
}

describe('basics', () => {
	it('isFsb5 checks magic bytes', () => {
		expect(isFsb5(new Uint8Array([0x46, 0x53, 0x42, 0x35]))).toBe(true);
		expect(isFsb5(new Uint8Array([0x46, 0x53, 0x42, 0x34]))).toBe(false);
		expect(isFsb5(new Uint8Array([0x46, 0x53]))).toBe(false);
	});

	it('exposes the canonical SoundFormat enum', () => {
		expect(SOUND_FORMAT.PCM16).toBe(2);
		expect(SOUND_FORMAT.IMAADPCM).toBe(7);
		expect(SOUND_FORMAT.VORBIS).toBe(15);
		expect(SOUND_FORMAT_NAMES[15]).toBe('VORBIS');
	});
});

describe('synthetic FSB5 — header + sample table parsing', () => {
	it('parses a single-sample PCM16 FSB5 with no name table', () => {
		// 16 mono PCM16 samples = 32 bytes
		const pcm = new Uint8Array(32);
		for (let i = 0; i < 16; i++) {
			new DataView(pcm.buffer).setInt16(i * 2, i * 100, true);
		}
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.PCM16,
			samples: [{ freqCode: 9, channels: 1, numSamples: 16, data: pcm }],
		});
		const parsed = parseFsb5(fsb5);
		expect(parsed.header.mode).toBe(SOUND_FORMAT.PCM16);
		expect(parsed.samples.length).toBe(1);
		const s = parsed.samples[0];
		expect(s.frequency).toBe(48000);
		expect(s.channels).toBe(1);
		expect(s.numSamples).toBe(16);
		expect(s.name).toBe('0000'); // fallback when no name table
		expect(s.data.length).toBe(32);
	});

	it('parses a multi-sample FSB5 with a name table', () => {
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.PCM16,
			samples: [
				{ freqCode: 9, channels: 1, numSamples: 4, data: new Uint8Array(8), name: 'first' },
				{ freqCode: 8, channels: 2, numSamples: 8, data: new Uint8Array(32), name: 'second' },
				{ freqCode: 4, channels: 1, numSamples: 16, data: new Uint8Array(32), name: 'third' },
			],
		});
		const parsed = parseFsb5(fsb5);
		expect(parsed.samples.length).toBe(3);
		expect(parsed.samples[0].name).toBe('first');
		expect(parsed.samples[1].name).toBe('second');
		expect(parsed.samples[2].name).toBe('third');
		// Frequencies and channels per sample
		expect(parsed.samples[0].frequency).toBe(48000); // freqCode 9
		expect(parsed.samples[1].frequency).toBe(44100); // freqCode 8
		expect(parsed.samples[2].frequency).toBe(16000); // freqCode 4
		expect(parsed.samples[0].channels).toBe(1);
		expect(parsed.samples[1].channels).toBe(2);
	});

	it('honours the FREQUENCY metadata chunk when set', () => {
		// freqCode = 0 (no preset) + FREQUENCY chunk = explicit rate 33000.
		const freqChunk = new Uint8Array(4);
		new DataView(freqChunk.buffer).setUint32(0, 33000, true);
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.PCM16,
			samples: [
				{
					freqCode: 9, // 48000 default — should be overridden
					channels: 1,
					numSamples: 4,
					data: new Uint8Array(8),
					metadata: [{ type: METADATA_CHUNK_TYPE.FREQUENCY, payload: freqChunk }],
				},
			],
		});
		const parsed = parseFsb5(fsb5);
		expect(parsed.samples[0].frequency).toBe(33000);
	});

	it('honours the CHANNELS metadata chunk for >2-channel samples', () => {
		const chunkPayload = new Uint8Array([6]); // 6-channel
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.PCM16,
			samples: [
				{
					freqCode: 9,
					channels: 2, // bit-packed: max 2 — must use chunk for 6
					numSamples: 4,
					data: new Uint8Array(8),
					metadata: [{ type: METADATA_CHUNK_TYPE.CHANNELS, payload: chunkPayload }],
				},
			],
		});
		const parsed = parseFsb5(fsb5);
		expect(parsed.samples[0].channels).toBe(6);
	});

	it('rejects non-FSB5 input', () => {
		expect(() => parseFsb5(new Uint8Array([0x46, 0x53, 0x42, 0x33, 0, 0, 0, 0]))).toThrow(/magic/);
		expect(() => parseFsb5(new Uint8Array(8))).toThrow();
	});
});

describe('synthetic PCM decoding', () => {
	it('decodes a PCM16 sample to a WAV blob via decodeSampleToBlob', async () => {
		// 8 stereo PCM16 frames = 32 bytes
		const pcm = new Uint8Array(32);
		const dv = new DataView(pcm.buffer);
		for (let i = 0; i < 16; i++) dv.setInt16(i * 2, i * 1000 - 8000, true);
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.PCM16,
			samples: [{ freqCode: 9, channels: 2, numSamples: 8, data: pcm }],
		});
		const parsed = parseFsb5(fsb5);
		const result = await decodeSampleToBlob(parsed.samples[0], parsed.header.mode);
		expect(result.kind).toBe('pcm-wav');
		expect(result.extension).toBe('wav');
		expect(result.blob.type).toBe('audio/wav');
		// 44-byte WAV header + 32 PCM bytes
		expect(result.blob.size).toBe(44 + 32);
		const head = new Uint8Array(await result.blob.slice(0, 4).arrayBuffer());
		expect(String.fromCharCode(...head)).toBe('RIFF');
	});

	it('decodes a PCM8 sample (unsigned → signed) to WAV', async () => {
		// 16 unsigned PCM8 samples (16-byte-aligned to avoid padding).
		const pcm = new Uint8Array(16);
		for (let i = 0; i < 16; i++) pcm[i] = i * 16;
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.PCM8,
			samples: [{ freqCode: 9, channels: 1, numSamples: 16, data: pcm }],
		});
		const parsed = parseFsb5(fsb5);
		const result = await decodeSampleToBlob(parsed.samples[0], parsed.header.mode);
		expect(result.kind).toBe('pcm-wav');
		// 44-byte header + 16 samples × 2 bytes (PCM8 → PCM16 expansion).
		expect(result.blob.size).toBe(44 + 32);
	});

	it('reports a clear error for codecs we don\'t support yet', async () => {
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.MPEG, // not supported
			samples: [{ freqCode: 9, channels: 1, numSamples: 4, data: new Uint8Array(8) }],
		});
		const parsed = parseFsb5(fsb5);
		await expect(
			decodeSampleToBlob(parsed.samples[0], parsed.header.mode),
		).rejects.toThrow(/not supported/i);
	});

	it('reports an actionable error for Vorbis without a setup library', async () => {
		const fsb5 = buildFsb5({
			mode: SOUND_FORMAT.VORBIS,
			samples: [{ freqCode: 9, channels: 1, numSamples: 4, data: new Uint8Array(8) }],
		});
		const parsed = parseFsb5(fsb5);
		await expect(
			decodeSampleToBlob(parsed.samples[0], parsed.header.mode),
		).rejects.toThrow(/setup/i);
	});
});

describe('WAV encoder', () => {
	it('produces a valid RIFF/WAVE header', () => {
		const pcm = new Int16Array([0, 100, 200, 300]);
		const wav = encodeWavBlob(pcm, 1, 44100);
		expect(wav.type).toBe('audio/wav');
		expect(wav.size).toBe(44 + 8);
	});
});

describe.runIf(existsSync(SETUP_BIN))(
	'FmodVorbisSetupPackets (bundled OSS reference asset)',
	() => {
		it('loads the bundled lookup table and exposes its entry count', () => {
			const lib = loadFmodVorbisSetupPackets(new Uint8Array(readFileSync(SETUP_BIN)));
			expect(lib.count).toBe(161);
		});

		it('returns null for unknown CRC32', () => {
			const lib = loadFmodVorbisSetupPackets(new Uint8Array(readFileSync(SETUP_BIN)));
			expect(lib.lookup(0xdeadbeef)).toBeNull();
		});

		it('throws on a too-small / corrupted lookup file', () => {
			expect(() => loadFmodVorbisSetupPackets(new Uint8Array([0]))).toThrow();
		});
	},
);
