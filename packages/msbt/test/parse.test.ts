/**
 * Synthetic-fixture tests for the MSBT parser.
 *
 * Builds tiny but format-correct MSBT bodies in code and checks
 * round-trip read-back of label / text data, plus the error paths
 * for malformed inputs.
 */

import { describe, expect, it } from 'vitest';

import {
	MSBT_ENCODING_UTF16,
	MSBT_ENCODING_UTF8,
	MSBT_HEADER_SIZE,
	MSBT_SECTION_HEADER_SIZE,
	MsbtParseError,
	isMsbtMagic,
	parseMsbt,
} from '../src/index.js';

function alignUp16(n: number): number {
	return (n + 15) & ~15;
}

/**
 * Build a single MSBT section block (10-byte header + payload + pad).
 * Returns the bytes; caller concatenates these.
 */
function makeSection(magic: string, payload: Uint8Array): Uint8Array {
	if (magic.length !== 4) throw new Error('magic must be 4 chars');
	const sectionSize = payload.length;
	const total = alignUp16(MSBT_SECTION_HEADER_SIZE + sectionSize);
	const out = new Uint8Array(total);
	for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
	new DataView(out.buffer).setUint32(0x04, sectionSize, true);
	out.set(payload, MSBT_SECTION_HEADER_SIZE);
	// pad bytes after the payload remain 0; spec uses 0xab but parsers
	// shouldn't care.
	return out;
}

function buildLbl1(labels: Array<{ name: string; textIndex: number }>): Uint8Array {
	// One bucket holding every entry — simplest valid layout.
	const bucketCount = 1;
	const headerSize = 4 + bucketCount * 8;
	let entryBytes = 0;
	for (const l of labels) entryBytes += 1 + l.name.length + 4;
	const out = new Uint8Array(headerSize + entryBytes);
	const dv = new DataView(out.buffer);
	dv.setUint32(0x00, bucketCount, true);
	dv.setUint32(0x04, labels.length, true); // bucket 0 entry count
	dv.setUint32(0x08, headerSize, true);    // first entry offset
	let off = headerSize;
	for (const l of labels) {
		out[off++] = l.name.length;
		for (let i = 0; i < l.name.length; i++) out[off + i] = l.name.charCodeAt(i);
		off += l.name.length;
		dv.setUint32(off, l.textIndex, true);
		off += 4;
	}
	return out;
}

function buildTxt2Utf8(strings: string[]): Uint8Array {
	const stringCount = strings.length;
	const tableSize = 4 + stringCount * 4;
	// Encode each string as UTF-8 + trailing null terminator.
	const enc = new TextEncoder();
	const bodies = strings.map((s) => {
		const bytes = enc.encode(s);
		const out = new Uint8Array(bytes.length + 1);
		out.set(bytes);
		out[bytes.length] = 0;
		return out;
	});
	const totalBodies = bodies.reduce((s, b) => s + b.length, 0);
	const out = new Uint8Array(tableSize + totalBodies);
	const dv = new DataView(out.buffer);
	dv.setUint32(0x00, stringCount, true);
	let off = tableSize;
	for (let i = 0; i < stringCount; i++) {
		dv.setUint32(4 + i * 4, off, true);
		out.set(bodies[i], off);
		off += bodies[i].length;
	}
	return out;
}

function buildMsbt(
	sections: Array<{ magic: string; payload: Uint8Array }>,
	options: { encoding?: 0 | 1; version?: number } = {},
): Uint8Array {
	const enc = options.encoding ?? MSBT_ENCODING_UTF8;
	const ver = options.version ?? 3;
	const sectionBytes = sections.map((s) => makeSection(s.magic, s.payload));
	const totalSize =
		MSBT_HEADER_SIZE + sectionBytes.reduce((sum, b) => sum + b.length, 0);
	const out = new Uint8Array(totalSize);
	const magic = 'MsgStdBn';
	for (let i = 0; i < 8; i++) out[i] = magic.charCodeAt(i);
	const dv = new DataView(out.buffer);
	dv.setUint16(0x08, 0xfffe, true);
	dv.setUint16(0x0a, 0, true);
	out[0x0c] = enc;
	out[0x0d] = ver;
	dv.setUint16(0x0e, sections.length, true);
	dv.setUint16(0x10, 0, true);
	dv.setUint32(0x12, totalSize, true);
	let off = MSBT_HEADER_SIZE;
	for (const sb of sectionBytes) {
		out.set(sb, off);
		off += sb.length;
	}
	return out;
}

describe('isMsbtMagic', () => {
	it('accepts MsgStdBn', () => {
		const m = new TextEncoder().encode('MsgStdBn');
		expect(isMsbtMagic(m)).toBe(true);
	});

	it('rejects others', () => {
		expect(isMsbtMagic(new TextEncoder().encode('MsgStdBnxxxx'))).toBe(true);
		expect(isMsbtMagic(new TextEncoder().encode('NotMSBT!'))).toBe(false);
		expect(isMsbtMagic(new Uint8Array(4))).toBe(false);
	});
});

describe('parseMsbt', () => {
	it('reads a small UTF-8 file with labels + texts', () => {
		const lbl = buildLbl1([
			{ name: 'Greeting', textIndex: 0 },
			{ name: 'Farewell', textIndex: 1 },
		]);
		const txt = buildTxt2Utf8(['Hello, world!', 'Goodbye!']);
		const bytes = buildMsbt([
			{ magic: 'LBL1', payload: lbl },
			{ magic: 'TXT2', payload: txt },
		]);
		const parsed = parseMsbt(bytes);
		expect(parsed.encoding).toBe('utf8');
		expect(parsed.version).toBe(3);
		expect(parsed.sectionCount).toBe(2);
		expect(parsed.sectionsPresent).toEqual(['LBL1', 'TXT2']);
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.entries[0]).toEqual({
			label: 'Greeting',
			textIndex: 0,
			text: 'Hello, world!',
		});
		expect(parsed.entries[1]).toEqual({
			label: 'Farewell',
			textIndex: 1,
			text: 'Goodbye!',
		});
		expect(parsed.unlabeledTexts).toEqual([]);
	});

	it('surfaces texts without labels as unlabeledTexts', () => {
		const lbl = buildLbl1([{ name: 'NamedOne', textIndex: 1 }]);
		const txt = buildTxt2Utf8(['first', 'second', 'third']);
		const bytes = buildMsbt([
			{ magic: 'LBL1', payload: lbl },
			{ magic: 'TXT2', payload: txt },
		]);
		const parsed = parseMsbt(bytes);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0]).toEqual({
			label: 'NamedOne',
			textIndex: 1,
			text: 'second',
		});
		expect(parsed.unlabeledTexts).toHaveLength(2);
		expect(parsed.unlabeledTexts[0]).toEqual({ textIndex: 0, text: 'first' });
		expect(parsed.unlabeledTexts[1]).toEqual({ textIndex: 2, text: 'third' });
	});

	it('tolerates files with no LBL1 (texts surface as unlabeled)', () => {
		const txt = buildTxt2Utf8(['lone string']);
		const bytes = buildMsbt([{ magic: 'TXT2', payload: txt }]);
		const parsed = parseMsbt(bytes);
		expect(parsed.entries).toHaveLength(0);
		expect(parsed.unlabeledTexts).toEqual([{ textIndex: 0, text: 'lone string' }]);
	});

	it('throws on missing TXT2', () => {
		const lbl = buildLbl1([{ name: 'OnlyLabel', textIndex: 0 }]);
		const bytes = buildMsbt([{ magic: 'LBL1', payload: lbl }]);
		expect(() => parseMsbt(bytes)).toThrowError(/no TXT2 section/);
	});

	it('throws on missing MsgStdBn magic', () => {
		expect(() => parseMsbt(new TextEncoder().encode('NotMSBT!'))).toThrowError(
			MsbtParseError,
		);
	});

	it('throws on truncated header', () => {
		expect(() =>
			parseMsbt(new TextEncoder().encode('MsgStdBn').subarray(0, 8)),
		).toThrowError(/header truncated/);
	});

	it('throws on bad BOM', () => {
		const lbl = buildLbl1([{ name: 'X', textIndex: 0 }]);
		const txt = buildTxt2Utf8(['x']);
		const bytes = buildMsbt([
			{ magic: 'LBL1', payload: lbl },
			{ magic: 'TXT2', payload: txt },
		]);
		// Corrupt the BOM.
		bytes[0x08] = 0x00;
		bytes[0x09] = 0x00;
		expect(() => parseMsbt(bytes)).toThrowError(/BOM/);
	});

	it('decodes UTF-16-LE strings', () => {
		const lbl = buildLbl1([{ name: 'Hi', textIndex: 0 }]);
		// Build a TXT2 payload manually with UTF-16-LE.
		const stringCount = 1;
		const tableSize = 4 + stringCount * 4;
		// "Hi\0" in UTF-16-LE.
		const body = new Uint8Array([
			0x48, 0x00, // 'H'
			0x69, 0x00, // 'i'
			0x00, 0x00, // '\0'
		]);
		const txt = new Uint8Array(tableSize + body.length);
		const dv = new DataView(txt.buffer);
		dv.setUint32(0, 1, true);
		dv.setUint32(4, tableSize, true);
		txt.set(body, tableSize);
		const bytes = buildMsbt(
			[
				{ magic: 'LBL1', payload: lbl },
				{ magic: 'TXT2', payload: txt },
			],
			{ encoding: MSBT_ENCODING_UTF16 },
		);
		const parsed = parseMsbt(bytes);
		expect(parsed.encoding).toBe('utf16le');
		expect(parsed.entries[0].text).toBe('Hi');
	});
});
