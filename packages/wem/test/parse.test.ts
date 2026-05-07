import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	parseWem,
	isWem,
	WEM_RIFF_MAGIC,
	WEM_CODEC_NAMES,
	decodeWemToBlob,
	encodeWavBlobFromPcm16,
} from '../src/index.js';

const WEM_DIR = '/tmp/samples/wem';
const VORBIS_WEM = resolve(WEM_DIR, 'pla__BATTLE_SYSTEM__0_16d39e.wem');
const OPUS_WEM = resolve(WEM_DIR, 'pla__BGM__0_3432be60.wem');

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

describe('parse', () => {
	it('exposes the canonical magic + codec name table', () => {
		expect(WEM_RIFF_MAGIC).toBe('RIFF');
		expect(WEM_CODEC_NAMES[0xffff]).toContain('Vorbis');
		expect(WEM_CODEC_NAMES[0x3039]).toContain('Switch-Opus');
		expect(WEM_CODEC_NAMES[0x0001]).toContain('PCM');
	});

	it('isWem requires both RIFF and WAVE', async () => {
		const yesBytes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
		]);
		expect(await isWem(blob(yesBytes))).toBe(true);
		const noBytes = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x4f, 0x47, 0x47, 0x53,
		]);
		expect(await isWem(blob(noBytes))).toBe(false);
	});

	it('parses a hand-built PCM WEM', async () => {
		// "RIFF"<size>"WAVE" + fmt(16) + data(8 bytes of PCM)
		const pcm = new Uint8Array([0, 0, 0x10, 0, 0xff, 0xff, 0x20, 0]);
		const fmtPayload = new Uint8Array(16);
		const fdv = new DataView(fmtPayload.buffer);
		fdv.setUint16(0, 1, true);    // codec PCM
		fdv.setUint16(2, 1, true);    // mono
		fdv.setUint32(4, 48000, true);
		fdv.setUint32(8, 96000, true);
		fdv.setUint16(12, 2, true);
		fdv.setUint16(14, 16, true);
		const fmtChunk = new Uint8Array(8 + fmtPayload.length);
		new TextEncoder().encodeInto('fmt ', fmtChunk);
		new DataView(fmtChunk.buffer).setUint32(4, fmtPayload.length, true);
		fmtChunk.set(fmtPayload, 8);
		const dataChunk = new Uint8Array(8 + pcm.length);
		new TextEncoder().encodeInto('data', dataChunk);
		new DataView(dataChunk.buffer).setUint32(4, pcm.length, true);
		dataChunk.set(pcm, 8);
		const total = 4 + 4 + 4 + fmtChunk.length + dataChunk.length;
		const out = new Uint8Array(total);
		new TextEncoder().encodeInto('RIFF', out);
		new DataView(out.buffer).setUint32(4, total - 8, true);
		new TextEncoder().encodeInto('WAVE', out.subarray(8));
		out.set(fmtChunk, 12);
		out.set(dataChunk, 12 + fmtChunk.length);

		const parsed = await parseWem(blob(out));
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
});

describe.runIf(existsSync(OPUS_WEM))('Switch-Opus → Ogg-Opus', () => {
	it('parses BGM Opus WEM and reads codec metadata', async () => {
		const bytes = readFileSync(OPUS_WEM);
		const parsed = await parseWem(blob(new Uint8Array(bytes)));
		expect(parsed.fmt.codecId).toBe(0x3039);
		expect(parsed.fmt.channels).toBe(2);
		expect(parsed.fmt.sampleRate).toBe(48000);
		expect(parsed.fmt.rawPayload.length).toBeGreaterThanOrEqual(0x28);
	});

	it('decodes BGM Opus WEM to an Ogg-Opus Blob', async () => {
		const bytes = readFileSync(OPUS_WEM);
		const parsed = await parseWem(blob(new Uint8Array(bytes)));
		const result = await decodeWemToBlob(parsed);
		expect(result.kind).toBe('switch-opus-to-ogg-opus');
		expect(result.extension).toBe('ogg');
		expect(result.blob.type).toBe('audio/ogg; codecs=opus');
		expect(result.blob.size).toBeGreaterThan(1024);

		// Verify the Ogg-Opus header is well-formed: starts with "OggS",
		// version 0, header_type 0x02 (BOS), then the 19-byte OpusHead
		// payload starting with "OpusHead".
		const head = new Uint8Array(await result.blob.slice(0, 64).arrayBuffer());
		expect(String.fromCharCode(...head.slice(0, 4))).toBe('OggS');
		expect(head[4]).toBe(0); // version
		expect(head[5] & 0x02).toBe(0x02); // BOS
		// Locate OpusHead in the page payload (segment_table starts at byte 27).
		const numSegs = head[26];
		const headerSize = 27 + numSegs;
		const opusHeadStart = headerSize;
		const opusHeadMagic = new Uint8Array(
			await result.blob.slice(opusHeadStart, opusHeadStart + 8).arrayBuffer(),
		);
		expect(String.fromCharCode(...opusHeadMagic)).toBe('OpusHead');

		// Save a copy for manual playback verification — picked up by
		// the dev workflow but not required for the test to pass.
		try {
			writeFileSync('/tmp/samples/wem/__derived_bgm.ogg', new Uint8Array(await result.blob.arrayBuffer()));
		} catch {}
	});
});

describe.runIf(existsSync(VORBIS_WEM))('Vorbis WEM', () => {
	it('reports a clear, actionable error when codebooks are absent', async () => {
		const bytes = readFileSync(VORBIS_WEM);
		const parsed = await parseWem(blob(new Uint8Array(bytes)));
		expect(parsed.fmt.codecId).toBe(0xffff);
		// Without codebooks: should throw a friendly "needs codebooks" error.
		await expect(decodeWemToBlob(parsed)).rejects.toThrow(/codebook/i);
	});

	it('decodes to Ogg-Vorbis when the codebook library is supplied', async () => {
		const bytes = readFileSync(VORBIS_WEM);
		const parsed = await parseWem(blob(new Uint8Array(bytes)));
		// Load the bundled codebook library from @tootallnate/wem-vorbis.
		const cbPath = resolve(
			__dirname,
			'..',
			'..',
			'wem-vorbis',
			'assets',
			'packed_codebooks_aoTuV_603.bin',
		);
		if (!existsSync(cbPath)) {
			// Codebook asset missing — skip rather than fail (e.g. fresh clone before deps installed).
			return;
		}
		const cbBytes = new Uint8Array(readFileSync(cbPath));
		const result = await decodeWemToBlob(parsed, { vorbisCodebookBytes: cbBytes });
		expect(result.kind).toBe('wwise-vorbis-to-ogg-vorbis');
		expect(result.extension).toBe('ogg');
		expect(result.blob.type).toBe('audio/ogg; codecs=vorbis');
		expect(result.blob.size).toBeGreaterThan(1024);
		// First bytes should be "OggS" capture pattern.
		const head = new Uint8Array(await result.blob.slice(0, 4).arrayBuffer());
		expect(String.fromCharCode(...head)).toBe('OggS');
	});
});
