/**
 * FF7 PC text encoding decoder.
 *
 * FF7 uses a bespoke 8-bit character table (NOT ASCII / Shift-JIS).
 * Bytes 0x00..0xDF map to printable Unicode glyphs; 0xE0..0xFE are
 * special escapes (newlines, character-name placeholders, color
 * codes); 0xFF is the string terminator AND the padding byte for
 * fixed-width name fields.
 *
 * This decoder is intentionally lossy for the rare advanced escapes:
 * unknown codes render as `<XX>` so callers can spot them but the
 * surrounding text still reads. Battle scene strings rarely use
 * anything beyond plain ASCII + the occasional newline / color.
 *
 * Reference: niemasd/PyFF7's `text.py` (English/PC table), plus the
 * Qhimm wiki "FF Text" page for the 0xE0+ escape semantics.
 */

/** Single-byte char map. Indexed 0..0xDF. */
const NORMAL_CHARS: readonly string[] = [
	// 0x00..0x1F: space + ASCII punctuation/digits
	' ', '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
	'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
	// 0x20..0x3F: @ A..Z [ \ ] ^ _
	'@', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
	'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '[', '\\', ']', '^', '_',
	// 0x40..0x5F: ` a..z { | } ~ (last is a non-breaking space)
	'`', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
	'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '{', '|', '}', '~', ' ',
	// 0x60..0x6F: extended Latin (Ä Å Ç É Ñ ...)
	'Ä', 'Å', 'Ç', 'É', 'Ñ', 'Ö', 'Ü', 'á', 'à', 'â', 'ä', 'ã', 'å', 'ç', 'é', 'è',
	// 0x70..0x7F
	'ê', 'ë', 'í', 'ì', 'î', 'ï', 'ñ', 'ó', 'ò', 'ô', 'ö', 'õ', 'ú', 'ù', 'û', 'ü',
	// 0x80..0x8F
	'♥', '°', '¢', '£', '↔', '→', '♪', 'ß', 'α', ' ', ' ', '´', '¨', '≠', 'Æ', 'Ø',
	// 0x90..0x9F
	'∞', '±', '≤', '≥', '¥', 'µ', '∂', 'Σ', 'Π', 'π', '⌡', 'ª', 'º', 'Ω', 'æ', 'ø',
	// 0xA0..0xAF
	'¿', '¡', '¬', '√', 'ƒ', '≈', '∆', '«', '»', '…', ' ', 'À', 'Ã', 'Õ', 'Œ', 'œ',
	// 0xB0..0xBF
	'–', '—', '“', '”', '‘', '’', '÷', '◊', 'ÿ', 'Ÿ', '⁄', ' ', '‹', '›', 'ﬁ', 'ﬂ',
	// 0xC0..0xCF
	'■', '·', '‚', '„', '‰', 'Â', 'Ê', 'Á', 'Ë', 'È', 'Í', 'Î', 'Ï', 'Ì', 'Ó', 'Ô',
	// 0xD0..0xDF
	' ', 'Ò', 'Ú', 'Û', 'Ù', 'ı', 'ˆ', '˜', '¯', '˘', '˙', '˚', '¸', '˝', '˛', 'ˇ',
];

/** Character-name escape codes 0xEA..0xF2 → display names. */
const NAME_ESCAPES: Record<number, string> = {
	0xea: 'Cloud',
	0xeb: 'Barret',
	0xec: 'Tifa',
	0xed: 'Aerith',
	0xee: 'Red XIII',
	0xef: 'Yuffie',
	0xf0: 'Cait Sith',
	0xf1: 'Vincent',
	0xf2: 'Cid',
};

/**
 * Decode an FF7-encoded byte buffer up to the first 0xFF terminator
 * (or the end of the buffer, whichever comes first).
 *
 * @param bytes — raw bytes to decode.
 * @param maxLen — optional cap on bytes read (e.g. 32 for fixed-
 *                 width name fields). Defaults to `bytes.length`.
 * @returns The decoded UTF-8 string. Trailing whitespace is NOT
 *          trimmed — caller decides.
 */
export function decodeFF7Text(bytes: Uint8Array, maxLen?: number): string {
	const end = Math.min(bytes.length, maxLen ?? bytes.length);
	let out = '';
	let i = 0;
	while (i < end) {
		const b = bytes[i]!;
		if (b === 0xff) break; // terminator / pad
		if (b < 0xe0) {
			out += NORMAL_CHARS[b] ?? '?';
			i++;
			continue;
		}
		// 0xE0..0xFE: escapes
		switch (b) {
			case 0xe0:
				out += '{CHOICE}';
				i++;
				break;
			case 0xe1:
				out += '\t';
				i++;
				break;
			case 0xe2:
				out += ', ';
				i++;
				break;
			case 0xe3:
				out += '."';
				i++;
				break;
			case 0xe4:
				out += '..."';
				i++;
				break;
			case 0xe6:
				out += '⑬';
				i++;
				break;
			case 0xe7:
				out += '\n';
				i++;
				break;
			case 0xe8:
				out += '\f';
				i++;
				break;
			case 0xea:
			case 0xeb:
			case 0xec:
			case 0xed:
			case 0xee:
			case 0xef:
			case 0xf0:
			case 0xf1:
			case 0xf2:
				out += NAME_ESCAPES[b]!;
				i++;
				break;
			case 0xf3:
				out += '{PARTY1}';
				i++;
				break;
			case 0xf4:
				out += '{PARTY2}';
				i++;
				break;
			case 0xf5:
				out += '{PARTY3}';
				i++;
				break;
			case 0xf6:
				out += '〇';
				i++;
				break;
			case 0xf7:
				out += '△';
				i++;
				break;
			case 0xf8:
				out += '☐';
				i++;
				break;
			case 0xf9:
				out += '✕';
				i++;
				break;
			case 0xfe: {
				// Extended control: 0xFE XX [args]. We only know the most
				// common color-code subset; everything else renders as
				// `<FE XX>` so the caller can spot it.
				const sub = bytes[i + 1] ?? 0;
				if (sub >= 0xd2 && sub <= 0xdb) {
					// Color/flash codes — purely cosmetic, drop them.
					i += 2;
				} else if (sub === 0xdd) {
					// {WAIT n} — 2-byte u16 arg
					i += 4;
				} else if (sub === 0xe2) {
					// {STR offset length} — 4 more arg bytes
					i += 6;
				} else {
					out += `<FE ${sub.toString(16).padStart(2, '0').toUpperCase()}>`;
					i += 2;
				}
				break;
			}
			default:
				out += `<${b.toString(16).padStart(2, '0').toUpperCase()}>`;
				i++;
				break;
		}
	}
	return out;
}
