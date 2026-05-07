import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BitReader,
	BitWriter,
	ilog,
	codebookLibraryFromBytes,
	parseWemVorbisV62,
	wemVorbisToOggVorbis,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEBOOKS_BIN = resolve(HERE, '..', 'assets', 'packed_codebooks_aoTuV_603.bin');

const WEM_DIR = '/tmp/samples/wem';
const SFX_WEM = resolve(WEM_DIR, 'pla__BATTLE_SYSTEM__0_16d39e.wem');
const BGM_VORBIS_WEM = resolve(WEM_DIR, 'pla__BGM__1_38aa0809.wem');

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

function walkRiff(wem: Uint8Array): { fmt: Uint8Array; data: Uint8Array } {
	const dv = new DataView(wem.buffer, wem.byteOffset, wem.byteLength);
	let off = 12;
	let fmt: Uint8Array | undefined;
	let data: Uint8Array | undefined;
	while (off + 8 <= wem.length) {
		const id = String.fromCharCode(wem[off], wem[off + 1], wem[off + 2], wem[off + 3]);
		const sz = dv.getUint32(off + 4, true);
		if (id === 'fmt ') fmt = wem.subarray(off + 8, off + 8 + sz);
		if (id === 'data') data = wem.subarray(off + 8, off + 8 + sz);
		off += 8 + sz;
		if (off & 1) off++;
	}
	if (!fmt || !data) throw new Error('no fmt/data');
	return { fmt, data };
}

describe('bit-stream primitives', () => {
	it('round-trips bits LSB-first', () => {
		const w = new BitWriter();
		// Pattern: write bits 1, 0, 1, 1, 0 (= 0b01101 = 13 if read back as 5-bit value)
		w.writeBit(1);
		w.writeBit(0);
		w.writeBit(1);
		w.writeBit(1);
		w.writeBit(0);
		w.flushByte();
		const out = w.toUint8Array();
		expect(out.length).toBe(1);
		// LSB-first: bit 0 = 1, bit 1 = 0, bit 2 = 1, bit 3 = 1, bit 4 = 0 → 0b00001101 = 13
		expect(out[0]).toBe(0b00001101);
		const r = new BitReader(out);
		expect(r.readUint(5)).toBe(0b01101);
	});

	it('round-trips multi-bit values', () => {
		const w = new BitWriter();
		w.writeUint(0xcafe, 16);
		w.writeUint(0xdeadbeef, 32);
		w.writeUint(7, 3);
		w.flushByte();
		const r = new BitReader(w.toUint8Array());
		expect(r.readUint(16)).toBe(0xcafe);
		expect(r.readUint(32)).toBe(0xdeadbeef);
		expect(r.readUint(3)).toBe(7);
	});

	it('ilog matches Tremor reference', () => {
		expect(ilog(0)).toBe(0);
		expect(ilog(1)).toBe(1);
		expect(ilog(2)).toBe(2);
		expect(ilog(3)).toBe(2);
		expect(ilog(4)).toBe(3);
		expect(ilog(7)).toBe(3);
		expect(ilog(8)).toBe(4);
		expect(ilog(255)).toBe(8);
		expect(ilog(256)).toBe(9);
	});

	it('throws on out-of-bits read', () => {
		const r = new BitReader(new Uint8Array([0xff]));
		r.readUint(8);
		expect(() => r.readBit()).toThrow();
	});
});

describe.runIf(existsSync(CODEBOOKS_BIN))('CodebookLibrary', () => {
	it('parses the aoTuV-603 codebook library', () => {
		const lib = codebookLibraryFromBytes(new Uint8Array(readFileSync(CODEBOOKS_BIN)));
		// aoTuV 603 ships 597 codebooks (598 entries in the offset table; the
		// last is a sentinel pointing past the data area).
		expect(lib.count).toBe(597);
		const cb0 = lib.getCodebook(0);
		expect(cb0.length).toBeGreaterThan(0);
	});
});

describe.runIf(existsSync(SFX_WEM) && existsSync(CODEBOOKS_BIN))(
	'BATTLE_SYSTEM mono SFX (Vorbis V62)',
	() => {
		it('parses the V62 fmt + vorb-faked layout', () => {
			const wem = new Uint8Array(readFileSync(SFX_WEM));
			const { fmt, data } = walkRiff(wem);
			const parsed = parseWemVorbisV62(fmt, data);
			expect(parsed.channels).toBe(1);
			expect(parsed.sampleRate).toBe(48000);
			expect(parsed.blocksize0Pow).toBe(8);
			expect(parsed.blocksize1Pow).toBe(11);
			expect(parsed.sampleCount).toBe(58470);
			expect(parsed.modPackets).toBe(true);
			// Setup packet should be non-trivial.
			expect(parsed.setupPacket.length).toBeGreaterThan(100);
			// Audio packets should be a substantial portion of the file.
			expect(parsed.audioPackets.length).toBeGreaterThan(15000);
		});

		it('rebuilds an Ogg-Vorbis stream', async () => {
			const wem = new Uint8Array(readFileSync(SFX_WEM));
			const { fmt, data } = walkRiff(wem);
			const parsed = parseWemVorbisV62(fmt, data);
			const lib = codebookLibraryFromBytes(
				new Uint8Array(readFileSync(CODEBOOKS_BIN)),
			);
			const oggBlob = await wemVorbisToOggVorbis(parsed, lib);
			expect(oggBlob.type).toBe('audio/ogg; codecs=vorbis');
			expect(oggBlob.size).toBeGreaterThan(1024);
			// Verify "OggS" magic + Vorbis ID-packet "\x01vorbis" pattern
			// in the first page payload.
			const head = new Uint8Array(await oggBlob.slice(0, 80).arrayBuffer());
			expect(String.fromCharCode(...head.slice(0, 4))).toBe('OggS');
			expect(head[4]).toBe(0); // version
			expect(head[5] & 0x02).toBe(0x02); // BOS
			const numSegs = head[26];
			const payloadStart = 27 + numSegs;
			expect(head[payloadStart]).toBe(1); // Vorbis ID packet type
			expect(
				String.fromCharCode(
					...head.slice(payloadStart + 1, payloadStart + 7),
				),
			).toBe('vorbis');
		});
	},
);

describe.runIf(existsSync(BGM_VORBIS_WEM) && existsSync(CODEBOOKS_BIN))(
	'BGM stereo Vorbis (V62)',
	() => {
		it('rebuilds Ogg-Vorbis with the right channel count', async () => {
			const wem = new Uint8Array(readFileSync(BGM_VORBIS_WEM));
			const { fmt, data } = walkRiff(wem);
			const parsed = parseWemVorbisV62(fmt, data);
			expect(parsed.channels).toBe(2);
			expect(parsed.sampleCount).toBe(150766);
			const lib = codebookLibraryFromBytes(
				new Uint8Array(readFileSync(CODEBOOKS_BIN)),
			);
			const oggBlob = await wemVorbisToOggVorbis(parsed, lib);
			expect(oggBlob.size).toBeGreaterThan(1024);
		});
	},
);

describe('error paths', () => {
	it('rejects non-V62 fmt sizes', () => {
		const fmt = new Uint8Array(0x18); // too small
		fmt[0] = 0xff;
		fmt[1] = 0xff; // codec id
		expect(() => parseWemVorbisV62(fmt, new Uint8Array(64))).toThrow(/V62/);
	});

	it('rejects non-Vorbis codec ids', () => {
		const fmt = new Uint8Array(0x42);
		const dv = new DataView(fmt.buffer);
		dv.setUint16(0, 0x3039, true); // OPUSNX
		expect(() => parseWemVorbisV62(fmt, new Uint8Array(64))).toThrow(/not a Vorbis/);
	});
});

void blob; // exported helper, mark used
