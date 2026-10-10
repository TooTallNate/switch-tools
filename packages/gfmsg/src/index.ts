/**
 * Game Freak message text (`.dat`) and AHTB hash tables (`.tbl`).
 *
 * ## Message text
 *
 *   0x00 u16 sectionCount (1)
 *   0x02 u16 lineCount
 *   0x04 u32 totalLength (section bytes; file size − 0x10)
 *   0x08 u32 initialKey (0)
 *   0x0C u32 sectionDataOffset (0x10)
 *   section: u32 length, then lineCount × { i32 offset, u16 charCount, u16 flags },
 *            offsets relative to the section start.
 *
 * Each line is UTF-16LE XOR'd with a rolling key: it starts at
 * `0x7C89 + i·0x2983` and rotates left by 3 bits after every char.
 * `0x0010` introduces a variable: `0x10, n, code, n−1 args`.
 *
 * ## AHTB
 *
 *   "AHTB", u32 count, count × { u64 fnv1a64(name), u16 len (incl. NUL), char name[len] }
 *
 * A message `.dat`'s sibling `.tbl` names its lines (index-aligned;
 * the final `*_max` entry is a sentinel with no line).
 *
 * Reference: kwsch/pkNX `TextFile` (GPL; format facts only).
 */

export interface GfMessageVariable {
	code: number;
	/** Known name for `code` (e.g. `PKNAME`), or `null`. */
	name: string | null;
	args: number[];
}

/** One decoded token: literal text or a variable / control code. */
export type GfMessageToken = { text: string } | { variable: GfMessageVariable };

export interface GfMessageLine {
	/** Human-readable rendering (variables as `[NAME(args)]`). */
	text: string;
	tokens: GfMessageToken[];
	flags: number;
}

export interface GfMessageFile {
	lines: GfMessageLine[];
}

const KEY_BASE = 0x7c89;
const KEY_ADVANCE = 0x2983;
const VAR_MARKER = 0x0010;

/** Variable codes whose meaning is well established (pkNX). */
const VARIABLE_NAMES: Record<number, string> = {
	0xbe00: 'SCROLL',
	0xbe01: 'CLEAR',
	0xbe02: 'WAIT',
	0xbdff: 'NULL',
	0xff00: 'COLOR',
	0xff01: 'RUBY',
	0x0100: 'TRNAME',
	0x0101: 'PKNAME',
	0x0102: 'PKNICK',
	0x0103: 'TYPE',
	0x0105: 'LOCATION',
	0x0106: 'ABILITY',
	0x0107: 'MOVE',
	0x0108: 'ITEM1',
	0x0109: 'ITEM2',
	0x1100: 'GENDBR',
	0x1101: 'NUMBRNCH',
};
for (let i = 0; i < 10; i++) VARIABLE_NAMES[0x0200 + i] = `NUM${i + 1}`;

/** Private-use glyphs in GF fonts with a sensible Unicode stand-in. */
const SPECIAL_CHARS: Record<number, string> = {
	0xe07f: '\u202f',
	0xe08d: '…',
	0xe08e: '♂',
	0xe08f: '♀',
	0xe300: '₽',
};

/**
 * Cheap structural check: section count 1, initial key 0, section at
 * 0x10, and `totalLength + 0x10 === size`.
 */
export function isGfMessage(bytes: Uint8Array): boolean {
	return isGfMessageHeader(bytes, bytes.length);
}

/** Header-only variant: `head` is the first ≥ 0x10 bytes of a file of `size` bytes. */
export function isGfMessageHeader(head: Uint8Array, size: number): boolean {
	if (head.length < 0x10 || size < 0x14) return false;
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	return (
		dv.getUint16(0, true) === 1 &&
		dv.getUint16(2, true) > 0 &&
		dv.getUint32(8, true) === 0 &&
		dv.getUint32(12, true) === 0x10 &&
		dv.getUint32(4, true) + 0x10 === size
	);
}

export function parseGfMessage(bytes: Uint8Array): GfMessageFile {
	if (bytes.length < 0x14) throw new Error('Buffer too small to be a Game Freak message file');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const sections = dv.getUint16(0, true);
	if (sections !== 1) throw new Error(`Unsupported section count ${sections}`);
	const lineCount = dv.getUint16(2, true);
	const sec = dv.getUint32(12, true);
	if (sec + 4 + lineCount * 8 > bytes.length) throw new Error('Line table out of bounds');
	const lines: GfMessageLine[] = [];
	for (let i = 0; i < lineCount; i++) {
		const off = sec + dv.getInt32(sec + 4 + i * 8, true);
		const len = dv.getUint16(sec + 8 + i * 8, true);
		const flags = dv.getUint16(sec + 10 + i * 8, true);
		if (off < 0 || off + len * 2 > bytes.length) throw new Error(`Line ${i} out of bounds`);
		const chars = new Uint16Array(len);
		let key = (KEY_BASE + i * KEY_ADVANCE) & 0xffff;
		for (let j = 0; j < len; j++) {
			chars[j] = dv.getUint16(off + j * 2, true) ^ key;
			key = ((key << 3) | (key >>> 13)) & 0xffff;
		}
		lines.push(decodeLine(chars, flags));
	}
	return { lines };
}

function decodeLine(chars: Uint16Array, flags: number): GfMessageLine {
	const tokens: GfMessageToken[] = [];
	let buf = '';
	const flush = () => {
		if (buf) tokens.push({ text: buf });
		buf = '';
	};
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (c === 0) break;
		if (c === VAR_MARKER && i + 2 < chars.length) {
			const count = chars[i + 1];
			const code = chars[i + 2];
			const args = Array.from(chars.subarray(i + 3, i + 2 + Math.max(1, count)));
			i += 1 + Math.max(1, count);
			flush();
			tokens.push({ variable: { code, name: VARIABLE_NAMES[code] ?? null, args } });
			continue;
		}
		buf += SPECIAL_CHARS[c] ?? String.fromCharCode(c);
	}
	flush();
	const text = tokens
		.map((t) => {
			if ('text' in t) return t.text;
			const v = t.variable;
			if (v.code === 0xbe00) return '\n';
			if (v.code === 0xbe01) return '\n\n';
			const name = v.name ?? `VAR 0x${v.code.toString(16).padStart(4, '0')}`;
			return v.args.length ? `[${name}(${v.args.join(',')})]` : `[${name}]`;
		})
		.join('');
	return { text, tokens, flags };
}

// ----- AHTB -----

export interface AhtbEntry {
	hash: bigint;
	name: string;
}

export function isAhtb(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && bytes[0] === 0x41 && bytes[1] === 0x48 && bytes[2] === 0x54 && bytes[3] === 0x42;
}

export function parseAhtb(bytes: Uint8Array): AhtbEntry[] {
	if (!isAhtb(bytes)) throw new Error('Not an AHTB table (missing magic)');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(4, true);
	const td = new TextDecoder();
	const out: AhtbEntry[] = [];
	let o = 8;
	for (let i = 0; i < count; i++) {
		if (o + 10 > bytes.length) throw new Error(`AHTB entry ${i} out of bounds`);
		const hash = dv.getBigUint64(o, true);
		const len = dv.getUint16(o + 8, true);
		if (o + 10 + len > bytes.length) throw new Error(`AHTB entry ${i} name out of bounds`);
		let end = o + 10 + len;
		while (end > o + 10 && bytes[end - 1] === 0) end--;
		out.push({ hash, name: td.decode(bytes.subarray(o + 10, end)) });
		o += 10 + len;
	}
	return out;
}

/**
 * 64-bit FNV-1a of a string's UTF-8 bytes, as Game Freak computes it
 * (AHTB label hash): standard prime, offset basis `0xCBF29CE484222645`
 * rather than the standard `…2325`.
 */
export function fnv1a64(s: string): bigint {
	let h = 0xcbf29ce484222645n;
	for (const b of new TextEncoder().encode(s)) {
		h ^= BigInt(b);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h;
}
