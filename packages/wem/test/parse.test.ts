import { describe, expect, it } from 'vitest';
import {
	parseWem,
	isWem,
	WEM_RIFF_MAGIC,
	WEM_CODEC_NAMES,
	decodeWemToBlob,
	encodeWavBlobFromPcm16,
} from '../src/index.js';

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts.
 */

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

/**
 * Build a minimal valid RIFF/WAVE WEM:
 *
 *   "RIFF" / size / "WAVE"
 *   "fmt " / size / fmtPayload
 *   "data" / size / data
 */
function buildWem(fmtPayload: Uint8Array, data: Uint8Array): Uint8Array {
	const fmtChunk = new Uint8Array(8 + fmtPayload.length);
	new TextEncoder().encodeInto('fmt ', fmtChunk);
	new DataView(fmtChunk.buffer).setUint32(4, fmtPayload.length, true);
	fmtChunk.set(fmtPayload, 8);

	const dataChunk = new Uint8Array(8 + data.length);
	new TextEncoder().encodeInto('data', dataChunk);
	new DataView(dataChunk.buffer).setUint32(4, data.length, true);
	dataChunk.set(data, 8);

	const total = 4 /* "RIFF" */ + 4 /* size */ + 4 /* "WAVE" */ + fmtChunk.length + dataChunk.length;
	const out = new Uint8Array(total);
	new TextEncoder().encodeInto('RIFF', out);
	new DataView(out.buffer).setUint32(4, total - 8, true);
	new TextEncoder().encodeInto('WAVE', out.subarray(8));
	out.set(fmtChunk, 12);
	out.set(dataChunk, 12 + fmtChunk.length);
	return out;
}

/** Build a 0x10-byte WAVEFORMATEX-style fmt payload for a given codec id. */
function buildFmtPayload(opts: {
	codecId: number;
	channels: number;
	sampleRate: number;
	avgBytesPerSec: number;
	blockAlign?: number;
	bitsPerSample?: number;
	extraSize?: number;
	extra?: Uint8Array;
}): Uint8Array {
	const baseLen = 0x10;
	const extra = opts.extra ?? new Uint8Array(0);
	const total = baseLen + (opts.extraSize !== undefined ? 2 : 0) + extra.length;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint16(0, opts.codecId, true);
	dv.setUint16(2, opts.channels, true);
	dv.setUint32(4, opts.sampleRate, true);
	dv.setUint32(8, opts.avgBytesPerSec, true);
	dv.setUint16(12, opts.blockAlign ?? 0, true);
	dv.setUint16(14, opts.bitsPerSample ?? 0, true);
	if (opts.extraSize !== undefined) {
		dv.setUint16(0x10, opts.extraSize, true);
		if (extra.length > 0) out.set(extra, 0x12);
	}
	return out;
}

describe('parse', () => {
	it('exposes the canonical magic + codec name table', () => {
		expect(WEM_RIFF_MAGIC).toBe('RIFF');
		expect(WEM_CODEC_NAMES[0xffff]).toContain('Vorbis');
		expect(WEM_CODEC_NAMES[0x3039]).toContain('Switch-Opus');
		expect(WEM_CODEC_NAMES[0x0001]).toContain('PCM');
	});

	it('isWem requires both RIFF and WAVE', async () => {
		const yes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
		]);
		expect(await isWem(blob(yes))).toBe(true);
		const no = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x4f, 0x47, 0x47, 0x53,
		]);
		expect(await isWem(blob(no))).toBe(false);
	});

	it('parses a synthetic PCM WEM and reads codec metadata', async () => {
		const fmt = buildFmtPayload({
			codecId: 0x0001,
			channels: 1,
			sampleRate: 48000,
			avgBytesPerSec: 96000,
			blockAlign: 2,
			bitsPerSample: 16,
		});
		const pcm = new Uint8Array([0, 0, 0x10, 0, 0xff, 0xff, 0x20, 0]);
		const wem = buildWem(fmt, pcm);
		const parsed = await parseWem(blob(wem));
		expect(parsed.fmt.codecId).toBe(0x0001);
		expect(parsed.fmt.channels).toBe(1);
		expect(parsed.fmt.sampleRate).toBe(48000);
		expect(parsed.dataChunk?.size).toBe(8);
	});

	it('rejects junk', async () => {
		await expect(parseWem(blob(new Uint8Array(8)))).rejects.toThrow();
		await expect(
			parseWem(blob(new TextEncoder().encode('RIFF\0\0\0\0NOPE'))),
		).rejects.toThrow();
	});
});

describe('PCM → WAV', () => {
	it('produces a valid 44-byte WAV header', () => {
		const pcm = new Uint8Array([0, 0, 0xff, 0x7f, 0, 0x80]);
		const b = encodeWavBlobFromPcm16(pcm, 1, 48000);
		expect(b.type).toBe('audio/wav');
		expect(b.size).toBe(44 + 6);
	});

	it('decodes a synthetic PCM WEM to WAV', async () => {
		const pcm = new Uint8Array(16); // 8 stereo samples of zeros
		const fmt = buildFmtPayload({
			codecId: 0x0001,
			channels: 2,
			sampleRate: 44100,
			avgBytesPerSec: 44100 * 4,
			blockAlign: 4,
			bitsPerSample: 16,
		});
		const wem = buildWem(fmt, pcm);
		const parsed = await parseWem(blob(wem));
		const result = await decodeWemToBlob(parsed);
		expect(result.kind).toBe('pcm-wav');
		expect(result.extension).toBe('wav');
		expect(result.blob.type).toBe('audio/wav');
		// 44-byte header + 16 PCM bytes
		expect(result.blob.size).toBe(60);
		const head = new Uint8Array(await result.blob.slice(0, 4).arrayBuffer());
		expect(String.fromCharCode(...head)).toBe('RIFF');
	});
});

describe('Switch-Opus dispatch', () => {
	/**
	 * Build a synthetic minimal OPUSNX (codec 0x3039) WEM. The fmt
	 * chunk needs to be 0x28 bytes (size 40) per our parser's check:
	 *
	 *   0x00..0x0f: standard WAVEFORMATEX (16 bytes)
	 *   0x10..0x11: extra_size
	 *   0x12..0x17: padding / channel layout (we use zeros)
	 *   0x18..0x1b: num_samples (s32 LE)
	 *   0x1c..0x1f: null
	 *   0x20..0x23: data_size_minus_seek
	 *   0x24..0x27: seek_size
	 *
	 * The data payload starts with `seek_size` bytes of seek table
	 * (we use zeros), then concatenated framed Opus packets:
	 *   `(BE u32 packet_size, BE u32 final_range, packet_bytes...)`.
	 */
	function buildSyntheticSwitchOpusWem(opts: {
		channels: number;
		sampleRate: number;
		numSamples: number;
		seekSize: number;
		opusPackets: Uint8Array[];
	}): Uint8Array {
		const fmt = new Uint8Array(0x28);
		const dv = new DataView(fmt.buffer);
		dv.setUint16(0, 0x3039, true); // codec
		dv.setUint16(2, opts.channels, true);
		dv.setUint32(4, opts.sampleRate, true);
		dv.setUint32(8, opts.sampleRate * opts.channels * 2, true); // avg_bps
		dv.setUint16(12, 4, true); // block_align (constant for OPUSNX)
		dv.setUint16(14, 16, true); // bits_per_sample (constant for OPUSNX)
		dv.setUint16(16, 6, true); // extra_size
		// 0x12-0x17: zeros (channel layout, etc.)
		dv.setInt32(0x18, opts.numSamples, true);
		// 0x1c: null
		// 0x20: data_size_minus_seek (the parser recomputes from data length, so we leave 0)
		dv.setUint32(0x24, opts.seekSize, true);

		// Build framed audio data.
		let payloadSize = opts.seekSize;
		for (const p of opts.opusPackets) payloadSize += 8 + p.length;
		const dataPayload = new Uint8Array(payloadSize);
		const ddv = new DataView(dataPayload.buffer);
		// Leave seek table as zeros.
		let off = opts.seekSize;
		for (const p of opts.opusPackets) {
			ddv.setUint32(off, p.length, false); // BE!
			ddv.setUint32(off + 4, 0, false); // final_range (ignored)
			off += 8;
			dataPayload.set(p, off);
			off += p.length;
		}

		return buildWem(fmt, dataPayload);
	}

	/**
	 * Build a fake "Opus packet" — we don't need a valid Opus stream
	 * (the muxer only looks at the TOC byte to count samples). A
	 * single byte with config=0 (SILK NB, 10ms) and code=0 (1 frame)
	 * + ~10 bytes of payload is enough to exercise the muxer.
	 */
	function fakeOpusPacket(payloadLen: number): Uint8Array {
		const out = new Uint8Array(1 + payloadLen);
		// TOC byte: config=0 (SILK NB, 10ms), c=0 (mono), code=0 (1 frame).
		// Bits: ccccc  s  code  →  00000 0 00 = 0x00.
		out[0] = 0x00;
		// Fill payload deterministically.
		for (let i = 0; i < payloadLen; i++) out[1 + i] = (i + 1) & 0xff;
		return out;
	}

	it('parses a synthetic OPUSNX WEM', async () => {
		const wem = buildSyntheticSwitchOpusWem({
			channels: 2,
			sampleRate: 48000,
			numSamples: 9600, // 200 ms @ 48 kHz
			seekSize: 0,
			opusPackets: [fakeOpusPacket(20), fakeOpusPacket(20)],
		});
		const parsed = await parseWem(blob(wem));
		expect(parsed.fmt.codecId).toBe(0x3039);
		expect(parsed.fmt.channels).toBe(2);
		expect(parsed.fmt.sampleRate).toBe(48000);
		expect(parsed.fmt.rawPayload.length).toBe(0x28);
	});

	it('decodes a synthetic OPUSNX WEM into a structurally-valid Ogg-Opus blob', async () => {
		const wem = buildSyntheticSwitchOpusWem({
			channels: 1,
			sampleRate: 48000,
			numSamples: 480, // 10 ms @ 48 kHz = one SILK NB frame
			seekSize: 0,
			opusPackets: [fakeOpusPacket(10)],
		});
		const parsed = await parseWem(blob(wem));
		const result = await decodeWemToBlob(parsed);
		expect(result.kind).toBe('switch-opus-to-ogg-opus');
		expect(result.extension).toBe('ogg');
		expect(result.blob.type).toBe('audio/ogg; codecs=opus');
		expect(result.blob.size).toBeGreaterThan(40);
		// First page is BOS with OpusHead.
		const head = new Uint8Array(await result.blob.slice(0, 64).arrayBuffer());
		expect(String.fromCharCode(...head.slice(0, 4))).toBe('OggS');
		expect(head[4]).toBe(0); // version
		expect(head[5] & 0x02).toBe(0x02); // BOS
		const numSegs = head[26];
		const opusHeadStart = 27 + numSegs;
		const opusHeadMagic = new Uint8Array(
			await result.blob.slice(opusHeadStart, opusHeadStart + 8).arrayBuffer(),
		);
		expect(String.fromCharCode(...opusHeadMagic)).toBe('OpusHead');
	});

	it('reports a clear error when codec is unsupported', async () => {
		// Codec 0x0162 = XWMA, not currently supported.
		const fmt = buildFmtPayload({
			codecId: 0x0162,
			channels: 2,
			sampleRate: 44100,
			avgBytesPerSec: 4000,
			blockAlign: 0,
			bitsPerSample: 16,
		});
		const wem = buildWem(fmt, new Uint8Array(8));
		const parsed = await parseWem(blob(wem));
		await expect(decodeWemToBlob(parsed)).rejects.toThrow(/codec/);
	});
});

describe('Vorbis dispatch (without codebooks)', () => {
	it('reports a clear, actionable error when codebooks are absent', async () => {
		// Synthetic 0x42-byte Vorbis fmt — we don't need a valid setup
		// packet, just the codec id; the error fires before parsing.
		const fmt = new Uint8Array(0x42);
		const dv = new DataView(fmt.buffer);
		dv.setUint16(0, 0xffff, true); // VORBIS
		dv.setUint16(2, 1, true); // mono
		dv.setUint32(4, 48000, true);
		dv.setUint32(8, 8000, true);
		dv.setUint16(0x10, 0x30, true); // extra_size = 0x30 (V62)
		const wem = buildWem(fmt, new Uint8Array(64));
		const parsed = await parseWem(blob(wem));
		expect(parsed.fmt.codecId).toBe(0xffff);
		await expect(decodeWemToBlob(parsed)).rejects.toThrow(/codebook/i);
	});
});
