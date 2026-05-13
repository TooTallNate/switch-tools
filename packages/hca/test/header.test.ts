import { describe, expect, it } from 'vitest';
import { parseHcaHeader, HcaHeaderError, deriveSubkey } from '../src/header.js';

/**
 * Hand-built HCA header bytes for a minimal, unencrypted v3 stereo
 * 48 kHz stream. No data section — just the header chunks. Mirrors
 * the layout we observed in BGM.awb track 0 but constructed here
 * from scratch.
 */
function buildHcaHeader(options: {
	version?: number;
	dataOffset?: number;
	channelCount?: number;
	samplingRate?: number;
	blockCount?: number;
	blockSize?: number;
	r01?: number;
	r02?: number;
	r03?: number;
	includeAth?: boolean;
	includeLoop?: boolean;
	ciphType?: number;
	includeRva?: boolean;
	comment?: string;
} = {}): Uint8Array {
	const {
		version = 0x0300,
		dataOffset = 0x80,
		channelCount = 2,
		samplingRate = 48000,
		blockCount = 100,
		blockSize = 682,
		r01 = 0,
		r02 = 15,
		r03 = 1,
		includeAth = false,
		includeLoop = false,
		ciphType = 0,
		includeRva = false,
		comment,
	} = options;
	const bytes: number[] = [];
	const enc = new TextEncoder();
	const writeFourCC = (s: string) => {
		const buf = enc.encode(s);
		for (let i = 0; i < 4; i++) bytes.push(i < buf.length ? buf[i]! : 0);
	};
	const writeU16BE = (v: number) => {
		bytes.push((v >>> 8) & 0xff, v & 0xff);
	};
	const writeU32BE = (v: number) => {
		bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
	};
	const writeF32BE = (f: number) => {
		const buf = new ArrayBuffer(4);
		new DataView(buf).setFloat32(0, f, false);
		const u = new Uint8Array(buf);
		bytes.push(u[0]!, u[1]!, u[2]!, u[3]!);
	};

	// Magic + version + dataOffset
	writeFourCC('HCA\0');
	writeU16BE(version);
	writeU16BE(dataOffset);

	// fmt\0 chunk
	writeFourCC('fmt\0');
	bytes.push(channelCount);
	// 24-bit BE samplingRate
	bytes.push((samplingRate >>> 16) & 0xff, (samplingRate >>> 8) & 0xff, samplingRate & 0xff);
	writeU32BE(blockCount);
	writeU16BE(0); // muteHeader
	writeU16BE(0); // muteFooter

	// comp chunk
	writeFourCC('comp');
	writeU16BE(blockSize);
	bytes.push(r01, r02, r03, 0, 0, 0, 0, 0, 0, 0);

	if (includeAth) {
		writeFourCC('ath\0');
		writeU16BE(0); // athType 0 → flat zero table
	}
	if (includeLoop) {
		writeFourCC('loop');
		writeU32BE(10); // loopStart
		writeU32BE(20); // loopEnd
		writeU16BE(0); // loopCount
		writeU16BE(0); // loopR1
	}
	if (ciphType > 0) {
		writeFourCC('ciph');
		writeU16BE(ciphType);
	}
	if (includeRva) {
		writeFourCC('rva\0');
		writeF32BE(0.5);
	}
	if (comment) {
		writeFourCC('comm');
		const buf = enc.encode(comment);
		bytes.push(buf.length);
		for (const b of buf) bytes.push(b);
	}

	// Pad up to dataOffset - 2 (we leave room for the trailing CRC bytes).
	while (bytes.length < dataOffset - 2) bytes.push(0);
	// CRC bytes (we don't compute a real CRC for the header tests — the
	// parser doesn't verify it).
	bytes.push(0, 0);
	return new Uint8Array(bytes);
}

describe('parseHcaHeader', () => {
	it('decodes a minimal v3 stereo HCA header', () => {
		const bytes = buildHcaHeader();
		const h = parseHcaHeader(bytes);
		expect(h.version).toBe(0x0300);
		expect(h.channelCount).toBe(2);
		expect(h.samplingRate).toBe(48000);
		expect(h.blockCount).toBe(100);
		expect(h.blockSize).toBe(682);
		expect(h.minResolution).toBe(0);
		expect(h.maxResolution).toBe(15);
		expect(h.ciphType).toBe(0);
		expect(h.athType).toBe(0); // v3 default
		expect(h.loopFlag).toBe(0);
		expect(h.loopStartFrame).toBe(0);
		expect(h.volume).toBe(1);
		expect(h.rvaVolume).toBe(1);
		expect(h.comment).toBeNull();
	});

	it('reads the optional ath / loop / ciph / rva / comm chunks', () => {
		const bytes = buildHcaHeader({
			includeAth: true,
			includeLoop: true,
			ciphType: 1,
			includeRva: true,
			comment: 'test',
		});
		const h = parseHcaHeader(bytes);
		expect(h.athType).toBe(0); // chunk overrides the version default
		expect(h.loopFlag).toBe(1);
		expect(h.loopStartFrame).toBe(10);
		expect(h.loopEndFrame).toBe(20);
		expect(h.ciphType).toBe(1);
		expect(h.volume).toBeCloseTo(0.5);
		expect(h.comment).toBe('test');
	});

	it('falls back to athType=1 on pre-v2 streams when ath\\0 chunk is absent', () => {
		// Pre-v2.0 official version (v1.3); clHCA hardcodes ath_type=1
		// for any version < 0x0200 when no ath\0 chunk is present.
		const bytes = buildHcaHeader({ version: 0x0103, r01: 1 });
		const h = parseHcaHeader(bytes);
		expect(h.athType).toBe(1);
	});

	it('throws on truncated input', () => {
		expect(() => parseHcaHeader(new Uint8Array(8))).toThrow(HcaHeaderError);
	});

	it('throws on bad magic', () => {
		const b = new Uint8Array(64);
		b.set(new Uint8Array([0x41, 0x42, 0x43, 0x44])); // "ABCD"
		expect(() => parseHcaHeader(b)).toThrow(/magic/i);
	});

	it('throws when the "fmt\\0" chunk is missing', () => {
		const b = buildHcaHeader();
		// Stomp the chunk magic to something else.
		b[0x08] = 0x58; // 'X'
		expect(() => parseHcaHeader(b)).toThrow(/fmt/);
	});

	it('handles encrypted (high-bit-set) FOURCCs', () => {
		// Real encrypted HCAs flip the high bit of every chunk magic
		// byte. The parser strips it before comparing.
		const b = buildHcaHeader();
		for (const off of [0x00, 0x08, 0x18]) {
			for (let i = 0; i < 4; i++) {
				if (b[off + i] !== 0) b[off + i]! |= 0x80;
			}
		}
		const h = parseHcaHeader(b);
		expect(h.channelCount).toBe(2);
	});
});

describe('deriveSubkey', () => {
	it('returns key1/key2 unchanged when awbKey=0', () => {
		const { key1, key2 } = deriveSubkey(0x1234567890abcdefn, 0);
		expect(key1).toBe(0x90abcdef >>> 0);
		expect(key2).toBe(0x12345678);
	});

	it('mixes in awbKey via the canonical formula', () => {
		// awbKey != 0 ⇒ key = key * ((awbKey << 16) | ((~awbKey & 0xFFFF) + 2))
		const { key1, key2 } = deriveSubkey(1n, 0x1234);
		// Manual: mix = (0x12340000) | ((~0x1234 & 0xFFFF) + 2) = 0x12340000 | 0xEDCD = 0x1234EDCD
		// key * mix = 0x1234EDCD
		expect(key1).toBe(0x1234edcd >>> 0);
		expect(key2).toBe(0);
	});

	it('accepts plain numbers as the key', () => {
		const { key1, key2 } = deriveSubkey(0xdeadbeef, 0);
		expect(key1).toBe(0xdeadbeef >>> 0);
		expect(key2).toBe(0);
	});
});
