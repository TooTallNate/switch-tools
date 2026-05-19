import { describe, it, expect } from 'vitest';
import {
	parseSead,
	findSeadMagic,
	isSead,
	SEAD_MAGIC_SAB,
	SEAD_MAGIC_MAB,
	SeadParseError,
} from '../src/sead.js';
import { codecName, SEAD_CODEC } from '../src/codec-table.js';

describe('findSeadMagic', () => {
	it('finds sabf at offset 0', () => {
		const buf = new Uint8Array(64);
		buf[0] = 0x73;
		buf[1] = 0x61;
		buf[2] = 0x62;
		buf[3] = 0x66;
		// fileSize must equal buffer length for the strict check
		new DataView(buf.buffer).setUint32(0x0c, buf.length, true);
		expect(findSeadMagic(buf)).toBe(0);
	});

	it('finds mabf at offset 16 (Unity wrap)', () => {
		const buf = new Uint8Array(80);
		// fill leading 16 bytes with some metadata
		buf[16] = 0x6d;
		buf[17] = 0x61;
		buf[18] = 0x62;
		buf[19] = 0x66;
		new DataView(buf.buffer).setUint32(16 + 0x0c, buf.length - 16, true);
		expect(findSeadMagic(buf)).toBe(16);
	});

	it('returns -1 when the magic is absent', () => {
		expect(findSeadMagic(new Uint8Array(64))).toBe(-1);
	});

	it('falls back to looser match when fileSize disagrees', () => {
		const buf = new Uint8Array(64);
		buf[0] = 0x73;
		buf[1] = 0x61;
		buf[2] = 0x62;
		buf[3] = 0x66;
		// Wrong fileSize on purpose — still finds it via fallback.
		expect(findSeadMagic(buf)).toBe(0);
	});
});

describe('isSead', () => {
	it('accepts a valid header', () => {
		const buf = new Uint8Array(64);
		buf[0] = 0x73;
		buf[1] = 0x61;
		buf[2] = 0x62;
		buf[3] = 0x66;
		expect(isSead(buf)).toBe(true);
	});
	it('rejects an empty buffer', () => {
		expect(isSead(new Uint8Array(0))).toBe(false);
	});
});

describe('codecName', () => {
	it('maps the documented codecs', () => {
		expect(codecName(SEAD_CODEC.HCA)).toBe('hca');
		expect(codecName(SEAD_CODEC.OGG_VORBIS)).toBe('ogg-vorbis');
		expect(codecName(SEAD_CODEC.PCM16LE)).toBe('pcm16le');
		expect(codecName(SEAD_CODEC.MSADPCM)).toBe('ms-adpcm');
		expect(codecName(SEAD_CODEC.DUMMY)).toBe('dummy');
	});
	it('returns an unknown-NN label for unrecognised values', () => {
		expect(codecName(0xff)).toBe('unknown-ff');
	});
});

describe('parseSead', () => {
	it('rejects buffers without the magic', () => {
		expect(() => parseSead(new Uint8Array(64))).toThrow(SeadParseError);
	});

	it('parses a minimal synthetic SAB with one HCA material', () => {
		// Build a SAB with:
		//   header 16 bytes + descriptor "TST" padded to 16 → headerSize = 32
		//   4 sections × 16 = 64 bytes  →  section start at 32, ends at 96
		//   "mtrl" section starts at 96:
		//     0x00 version u8, 0x01 reserved, 0x02 size u16,
		//     0x04 entryCount u16 = 1, 0x06 reserved, 0x08 -- 0x0F unused?
		//     0x10 mtrl[0] relative offset u32 = 16
		//     mtrl[0] at 96+16=112:
		//       0x00 ver, 0x02 size, 0x04 ch=1, 0x05 codec=7 (HCA),
		//       0x06 num, 0x08 rate=22050, 0x14 extraSize=0x14, 0x18 streamSize=4
		//       0x20 extra: 0x02 hcaHeaderSize=0x0C, 0x04 frameSize=0x40,
		//                   0x0D encrypted=0
		//       0x30 stream: 4 bytes
		// Buffer layout:
		//   0..32   file header + descriptor "TST" padded to 16
		//   32..96  section table (4 × 16 byte entries; only mtrl filled)
		//   96..112 mtrl chunk header + 1 entry (16 bytes)
		//   112+    mtrl[0] data starts. To avoid colliding with the
		//   entry offset table at 96..112, the material's relOff is
		//   set to 32 (giving mtrl[0] absolute pos = 96 + 32 = 128).
		// Total = 128 + 0x20 + 0x14 + 4 = 192 bytes.
		const buf = new Uint8Array(192);
		const v = new DataView(buf.buffer);
		// Magic "sabf"
		v.setUint32(0, SEAD_MAGIC_SAB, true);
		v.setUint8(0x04, 2); // versionMain
		v.setUint8(0x06, 0); // LE
		v.setUint8(0x08, 4); // sectionsCount = 4 (we'll only fill mtrl)
		v.setUint8(0x09, 3); // descriptorLen = 3 ("TST")
		v.setUint32(0x0c, buf.length, true); // fileSize must match real size
		// (note: parseSead validates this in findSeadMagic)
		// Descriptor "TST" at +0x10
		buf[0x10] = 0x54; // T
		buf[0x11] = 0x53; // S
		buf[0x12] = 0x54; // T
		// header pad to 32

		// Section table starts at offset 32. Only "mtrl" entry needed.
		// Three other entries are zero (will surface as empty magic strings,
		// which is fine — parseSead skips by magic.startsWith("mtrl")).
		const mtrlSectionStart = 96;
		v.setUint8(32 + 3 * 16 + 0x00, 0x6d); // 'm'
		v.setUint8(32 + 3 * 16 + 0x01, 0x74); // 't'
		v.setUint8(32 + 3 * 16 + 0x02, 0x72); // 'r'
		v.setUint8(32 + 3 * 16 + 0x03, 0x6c); // 'l'
		v.setUint16(32 + 3 * 16 + 0x06, 16, true);
		v.setUint32(32 + 3 * 16 + 0x08, mtrlSectionStart, true);

		// mtrl section header
		v.setUint16(mtrlSectionStart + 0x04, 1, true); // entryCount
		v.setUint32(mtrlSectionStart + 0x10, 32, true); // mtrl[0] rel-off

		// mtrl[0] at offset 96 + 32 = 128
		const m = 128;
		v.setUint8(m + 0x02, 0x20); // size low byte
		v.setUint8(m + 0x04, 1); // channels
		v.setUint8(m + 0x05, SEAD_CODEC.HCA);
		v.setUint16(m + 0x06, 0, true); // mtrlNumber
		v.setUint32(m + 0x08, 22050, true); // sampleRate
		v.setUint32(m + 0x14, 0x14, true); // extraDataSize
		v.setUint32(m + 0x18, 4, true); // streamSize
		// HCA extras at m + 0x20
		v.setUint16(m + 0x20 + 0x02, 0x0c, true); // hcaHeaderSize
		v.setUint16(m + 0x20 + 0x04, 0x40, true); // frameSize
		v.setUint8(m + 0x20 + 0x0d, 0); // encrypted=0
		// streamData (4 bytes) — leave zero

		const sead = parseSead(buf);
		expect(sead.header.magic).toBe('sabf');
		expect(sead.header.descriptor).toBe('TST');
		expect(sead.materials).toHaveLength(1);
		const mat = sead.materials[0]!;
		expect(mat.codec).toBe(SEAD_CODEC.HCA);
		expect(mat.codecLabel).toBe('hca');
		expect(mat.channelCount).toBe(1);
		expect(mat.sampleRate).toBe(22050);
		expect(mat.hasLoop).toBe(false);
		expect(mat.extras.codec).toBe('hca');
	});

	it('skips materials whose offset is beyond the file (deleted slot sentinel)', () => {
		const buf = new Uint8Array(128);
		const v = new DataView(buf.buffer);
		v.setUint32(0, SEAD_MAGIC_SAB, true);
		v.setUint8(0x04, 2);
		v.setUint8(0x08, 4);
		v.setUint8(0x09, 1);
		v.setUint32(0x0c, buf.length, true);
		// Section table at +32 — only mtrl at slot 3
		const tableStart = 32;
		v.setUint8(tableStart + 3 * 16 + 0x00, 0x6d);
		v.setUint8(tableStart + 3 * 16 + 0x01, 0x74);
		v.setUint8(tableStart + 3 * 16 + 0x02, 0x72);
		v.setUint8(tableStart + 3 * 16 + 0x03, 0x6c);
		v.setUint16(tableStart + 3 * 16 + 0x06, 16, true);
		v.setUint32(tableStart + 3 * 16 + 0x08, 96, true);
		// mtrl section header
		v.setUint16(96 + 0x04, 1, true);
		// mtrl[0] offset = file size = sentinel
		v.setUint32(96 + 0x10, buf.length + 0x1000, true);
		const sead = parseSead(buf);
		expect(sead.materials).toHaveLength(0);
	});
});
