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
} from '../src/index.js';
import { rebuildCompactCodebook } from '../src/codebook.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEBOOKS_BIN = resolve(HERE, '..', 'assets', 'packed_codebooks_aoTuV_603.bin');

/**
 * Tests use only synthetic / hand-crafted byte streams. No
 * commercial-game extracts. We do exercise the bundled aoTuV-603
 * codebook library at the parse-table level (verifying its format
 * contract — entry count, sentinel, etc.), since that file ships
 * with the package and is BSD-licensed reference data, not
 * extracted from any commercial title.
 */

function blob(buf: Uint8Array): Blob {
	return new Blob([buf as unknown as BlobPart]);
}

describe('bit-stream primitives', () => {
	it('round-trips bits LSB-first', () => {
		const w = new BitWriter();
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

describe.runIf(existsSync(CODEBOOKS_BIN))('CodebookLibrary (bundled aoTuV-603 reference asset)', () => {
	it('parses the file structure and exposes expected entry count', () => {
		const lib = codebookLibraryFromBytes(new Uint8Array(readFileSync(CODEBOOKS_BIN)));
		// aoTuV-603 ships 597 codebooks (598 offset-table entries; the last is
		// a sentinel marking end-of-data).
		expect(lib.count).toBe(597);
		const cb0 = lib.getCodebook(0);
		expect(cb0.length).toBeGreaterThan(0);
	});
});

/**
 * Build a synthetic compact Wwise codebook and verify it round-trips
 * through `rebuildCompactCodebook` to a standard Vorbis codebook.
 *
 * Compact codebook format (all bits LSB-first):
 *   - dimensions u4
 *   - entries u14
 *   - ordered u1
 *   - if !ordered: codeword_length_length u3, sparse u1
 *     for each entry: [present u1 if sparse], codeword_length-1 u<lenlen>
 *   - lookup_type u1 (0 or 1)
 *   ... type 1 only: min/max/value_length/sequence + quantvals
 */
function buildCompactCodebook(): Uint8Array {
	const w = new BitWriter();
	w.writeUint(2, 4); // dimensions = 2
	w.writeUint(4, 14); // entries = 4
	w.writeBit(0); // not ordered
	w.writeUint(3, 3); // codeword_length_length = 3 bits
	w.writeBit(0); // not sparse
	// 4 entries, each a 3-bit codeword length-1
	w.writeUint(0, 3);
	w.writeUint(1, 3);
	w.writeUint(1, 3);
	w.writeUint(2, 3);
	w.writeBit(0); // lookup_type = 0 (no lookup table)
	w.flushByte();
	return w.toUint8Array().slice();
}

describe('rebuildCompactCodebook', () => {
	it('expands a synthetic 4-entry codebook to spec form', () => {
		const compact = buildCompactCodebook();
		const r = new BitReader(compact);
		const w = new BitWriter();
		rebuildCompactCodebook(r, compact.length, w);
		w.flushByte();
		const out = w.toUint8Array();
		// First 24 bits should be the BCV identifier 0x564342, LSB-first.
		const rr = new BitReader(out);
		expect(rr.readUint(24)).toBe(0x564342);
		// Next 16 bits: dimensions (2).
		expect(rr.readUint(16)).toBe(2);
		// Next 24 bits: entries (4).
		expect(rr.readUint(24)).toBe(4);
		// ordered = 0
		expect(rr.readBit()).toBe(0);
		// sparse = 0
		expect(rr.readBit()).toBe(0);
		// 4 × 5-bit codeword lengths
		expect(rr.readUint(5)).toBe(0);
		expect(rr.readUint(5)).toBe(1);
		expect(rr.readUint(5)).toBe(1);
		expect(rr.readUint(5)).toBe(2);
		// lookup_type = 0 (4 bits)
		expect(rr.readUint(4)).toBe(0);
	});
});

describe('error paths', () => {
	it('rejects non-V62 fmt sizes', () => {
		const fmt = new Uint8Array(0x18);
		fmt[0] = 0xff;
		fmt[1] = 0xff;
		expect(() => parseWemVorbisV62(fmt, new Uint8Array(64))).toThrow(/V62/);
	});

	it('rejects non-Vorbis codec ids', () => {
		const fmt = new Uint8Array(0x42);
		const dv = new DataView(fmt.buffer);
		dv.setUint16(0, 0x3039, true); // OPUSNX
		expect(() => parseWemVorbisV62(fmt, new Uint8Array(64))).toThrow(/not a Vorbis/);
	});

	it('rejects fmt with wrong block_align / bps', () => {
		const fmt = new Uint8Array(0x42);
		const dv = new DataView(fmt.buffer);
		dv.setUint16(0, 0xffff, true);
		dv.setUint16(2, 1, true);
		dv.setUint32(4, 48000, true);
		dv.setUint16(12, 4, true); // block_align should be 0 for Vorbis
		dv.setUint16(0x10, 0x30, true);
		expect(() => parseWemVorbisV62(fmt, new Uint8Array(64))).toThrow(/block_align/);
	});

	it('rejects fmt with wrong extra_size (not V62)', () => {
		const fmt = new Uint8Array(0x42);
		const dv = new DataView(fmt.buffer);
		dv.setUint16(0, 0xffff, true);
		dv.setUint16(2, 1, true);
		dv.setUint32(4, 48000, true);
		dv.setUint16(0x10, 0x28, true); // V53 size, not V62
		expect(() => parseWemVorbisV62(fmt, new Uint8Array(64))).toThrow(/extra_size/);
	});
});

/**
 * Synthetic V62 WEM builder — only enough of the format to exercise
 * `parseWemVorbisV62`'s field extraction. The `setupPacket` and
 * `audioPackets` are arbitrary bytes (we don't decode them in this
 * test, since that requires a real codebook library that we don't
 * want to derive from any specific commercial title).
 */
function buildSyntheticV62Fmt(opts: {
	channels: number;
	sampleRate: number;
	avgBytesPerSec: number;
	sampleCount: number;
	modSignal: number;
	setupPacketOffset: number;
	firstAudioPacketOffset: number;
	blocksize0Pow: number;
	blocksize1Pow: number;
}): Uint8Array {
	const fmt = new Uint8Array(0x42);
	const dv = new DataView(fmt.buffer);
	dv.setUint16(0, 0xffff, true); // codec
	dv.setUint16(2, opts.channels, true);
	dv.setUint32(4, opts.sampleRate, true);
	dv.setUint32(8, opts.avgBytesPerSec, true);
	dv.setUint16(12, 0, true); // block_align
	dv.setUint16(14, 0, true); // bits_per_sample
	dv.setUint16(0x10, 0x30, true); // extra_size
	// vorb data is "faked" at fmt+0x18:
	const VORB = 0x18;
	dv.setUint32(VORB + 0x00, opts.sampleCount, true);
	dv.setUint32(VORB + 0x04, opts.modSignal, true); // mod_signal
	dv.setUint32(VORB + 0x10, opts.setupPacketOffset, true);
	dv.setUint32(VORB + 0x14, opts.firstAudioPacketOffset, true);
	// 0x24 = uid (we use 0)
	fmt[VORB + 0x28] = opts.blocksize0Pow;
	fmt[VORB + 0x29] = opts.blocksize1Pow;
	return fmt;
}

describe('parseWemVorbisV62 (synthetic)', () => {
	it('extracts all V62 fmt fields and locates setup + audio offsets', () => {
		// Build a data chunk: setup-packet at offset 0, audio-packets at offset 12.
		// Setup format: u16 size_le, then packet bytes. We use 10-byte packet.
		const setupBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const data = new Uint8Array(2 + setupBytes.length + 16);
		new DataView(data.buffer).setUint16(0, setupBytes.length, true);
		data.set(setupBytes, 2);
		// Then 16 bytes of "audio".
		for (let i = 0; i < 16; i++) data[2 + setupBytes.length + i] = i;

		const fmt = buildSyntheticV62Fmt({
			channels: 1,
			sampleRate: 48000,
			avgBytesPerSec: 8000,
			sampleCount: 1000,
			modSignal: 0xdd, // not in {0x4A,0x4B,0x69,0x70} → mod_packets = true
			setupPacketOffset: 0,
			firstAudioPacketOffset: 2 + setupBytes.length,
			blocksize0Pow: 8,
			blocksize1Pow: 11,
		});
		const parsed = parseWemVorbisV62(fmt, data);
		expect(parsed.channels).toBe(1);
		expect(parsed.sampleRate).toBe(48000);
		expect(parsed.blocksize0Pow).toBe(8);
		expect(parsed.blocksize1Pow).toBe(11);
		expect(parsed.sampleCount).toBe(1000);
		expect(parsed.modPackets).toBe(true);
		expect(parsed.setupPacket.length).toBe(setupBytes.length);
		expect(Array.from(parsed.setupPacket)).toEqual(Array.from(setupBytes));
		expect(parsed.audioPackets.length).toBe(16);
	});

	it('correctly clears mod_packets for known unset signals', () => {
		const setupBytes = new Uint8Array([0]);
		const data = new Uint8Array(3);
		new DataView(data.buffer).setUint16(0, 1, true);

		const fmt = buildSyntheticV62Fmt({
			channels: 1,
			sampleRate: 48000,
			avgBytesPerSec: 8000,
			sampleCount: 100,
			modSignal: 0x4a, // explicitly in unset list
			setupPacketOffset: 0,
			firstAudioPacketOffset: 3,
			blocksize0Pow: 8,
			blocksize1Pow: 11,
		});
		const parsed = parseWemVorbisV62(fmt, data);
		expect(parsed.modPackets).toBe(false);
	});

	it('throws when setup + first-audio offsets are inconsistent', () => {
		const data = new Uint8Array(20);
		new DataView(data.buffer).setUint16(0, 5, true); // 5-byte setup payload
		const fmt = buildSyntheticV62Fmt({
			channels: 1,
			sampleRate: 48000,
			avgBytesPerSec: 8000,
			sampleCount: 100,
			modSignal: 0xdd,
			setupPacketOffset: 0,
			firstAudioPacketOffset: 17, // wrong: should be 2 + 5 = 7
			blocksize0Pow: 8,
			blocksize1Pow: 11,
		});
		expect(() => parseWemVorbisV62(fmt, data)).toThrow(/first audio packet/);
	});
});

/**
 * Direct test of the Ogg page builder via the public muxer API.
 *
 * Constructing a fully-valid synthetic Vorbis Setup packet requires
 * walking the codebook table (whose contents we deliberately don't
 * derive from any commercial title), so we don't attempt full
 * end-to-end mux here. Instead we verify:
 *
 *   - `parseWemVorbisV62` correctly partitions a synthetic data
 *     chunk into setup + audio packets (covered above).
 *   - The standalone bit-stream + codebook primitives behave per
 *     spec (covered above).
 *
 * Real-world end-to-end verification (bank → audio in a browser)
 * is exercised by the nx-archive app's manual workflow, NOT by
 * unit tests, deliberately.
 */
