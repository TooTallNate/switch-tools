/**
 * FF8 text decoder for enemy names (and short strings in general).
 *
 * FF8 uses a custom 256-entry codepage indexed by byte value. This decoder
 * embeds the European table extracted from OpenVIII's
 * `FF8TextEncodingCodepage.cs:CreateEuropeanCodepage()`, with the
 * non-printable / placeholder entries replaced by `?`.
 *
 * Termination:
 *   - 0x00 → end-of-string
 *   - 0x02 → newline (decoded as `'\n'`, doesn't terminate)
 *   - The optional `maxLen` parameter also bounds the loop.
 *
 * Reference: https://wiki.ffrtt.ru/index.php/FF8/String_Encoding
 *            https://github.com/MaKiPL/OpenVIII-monogame
 */

// European codepage (256 entries). `''` (empty) means "no defined glyph".
// Compiled from OpenVIII's CreateEuropeanCodepage table:
//   0x02 = '\n', 0x20 = ' ', 0x21-0x2A = '0'-'9', 0x2B-0x2F = '%/:!?',
//   0x30-0x3D = '&+-=*&_'(unused/special), then printable punctuation,
//   0x45-0x5E = 'A'-'Z', 0x5F = 'a', 0x60-0x78 = 'b'-'z'.
const FF8_EUROPEAN_TABLE: readonly string[] = (() => {
	const tbl: string[] = new Array(256).fill('');
	tbl[0x02] = '\n';
	tbl[0x20] = ' ';
	// 0x21..0x2A = digits 0..9.
	const digits = '0123456789';
	for (let i = 0; i < 10; i++) tbl[0x21 + i] = digits[i]!;
	// 0x2B..0x2F.
	tbl[0x2b] = '%';
	tbl[0x2c] = '/';
	tbl[0x2d] = ':';
	tbl[0x2e] = '!';
	tbl[0x2f] = '?';
	// 0x30..0x37 = &+-=*& 0 0  — six are unambiguous, the last two are
	// special glyphs (Japanese half-width katakana spacers in the original
	// table). Keep them blank.
	tbl[0x30] = '&';
	tbl[0x31] = '+';
	tbl[0x32] = '-';
	tbl[0x33] = '=';
	tbl[0x34] = '*';
	tbl[0x35] = '&';
	// 0x36, 0x37: leave blank.
	tbl[0x38] = '(';
	tbl[0x39] = ')';
	tbl[0x3a] = '°';
	tbl[0x3b] = '.';
	tbl[0x3c] = ',';
	tbl[0x3d] = '~';
	// 0x3e, 0x3f, 0x40: special bullets — blank.
	tbl[0x41] = '#';
	tbl[0x42] = '$';
	tbl[0x43] = '"';
	tbl[0x44] = '_';
	// 0x45..0x5E = 'A'..'Z'.
	for (let i = 0; i < 26; i++) tbl[0x45 + i] = String.fromCharCode(0x41 + i);
	// 0x5F = 'a', 0x60..0x78 = 'b'..'z'.
	for (let i = 0; i < 26; i++) tbl[0x5f + i] = String.fromCharCode(0x61 + i);
	// 0x79..0x7F: accented uppercase (À, Á, Â, Ã, Ä, Å, Æ, Ç in OpenVIII).
	tbl[0x79] = 'À';
	tbl[0x7a] = 'Á';
	tbl[0x7b] = 'Â';
	tbl[0x7c] = 'Ã';
	tbl[0x7d] = 'Ä';
	tbl[0x7e] = 'Å';
	tbl[0x7f] = 'Æ';
	// 0x80+: more accented uppercase, then accented lowercase. Sketch a small
	// extension — enough for European enemy names.
	tbl[0x80] = 'Ç';
	tbl[0x81] = 'È';
	tbl[0x82] = 'É';
	tbl[0x83] = 'Ê';
	tbl[0x84] = 'Ë';
	tbl[0x85] = 'Ì';
	tbl[0x86] = 'Í';
	tbl[0x87] = 'Î';
	tbl[0x88] = 'Ï';
	tbl[0x89] = 'Ñ';
	tbl[0x8a] = 'Ò';
	tbl[0x8b] = 'Ó';
	tbl[0x8c] = 'Ô';
	tbl[0x8d] = 'Õ';
	tbl[0x8e] = 'Ö';
	tbl[0x8f] = 'Ù';
	tbl[0x90] = 'Ú';
	tbl[0x91] = 'Û';
	tbl[0x92] = 'Ü';
	// 0x94+: lowercase accented.
	tbl[0x94] = 'à';
	tbl[0x95] = 'á';
	tbl[0x96] = 'â';
	tbl[0x97] = 'ã';
	tbl[0x98] = 'ä';
	tbl[0x99] = 'å';
	tbl[0x9a] = 'æ';
	tbl[0x9b] = 'ç';
	tbl[0x9c] = 'è';
	tbl[0x9d] = 'é';
	tbl[0x9e] = 'ê';
	tbl[0x9f] = 'ë';
	tbl[0xa0] = 'ì';
	tbl[0xa1] = 'í';
	tbl[0xa2] = 'î';
	tbl[0xa3] = 'ï';
	tbl[0xa4] = 'ñ';
	tbl[0xa5] = 'ò';
	tbl[0xa6] = 'ó';
	tbl[0xa7] = 'ô';
	tbl[0xa8] = 'õ';
	tbl[0xa9] = 'ö';
	tbl[0xaa] = 'ù';
	tbl[0xab] = 'ú';
	tbl[0xac] = 'û';
	tbl[0xad] = 'ü';
	return tbl;
})();

export interface DecodeFF8TextOptions {
	/** Use ASCII passthrough for any byte 0x20..0x7E (legacy mode). */
	ascii?: boolean;
}

export function decodeFF8Text(
	bytes: Uint8Array,
	maxLen?: number,
	opts: DecodeFF8TextOptions = {},
): string {
	const end = Math.min(bytes.length, maxLen ?? bytes.length);
	let out = '';
	for (let i = 0; i < end; i++) {
		const b = bytes[i]!;
		if (b === 0x00) break;
		const glyph = opts.ascii
			? b >= 0x20 && b <= 0x7e
				? String.fromCharCode(b)
				: ''
			: FF8_EUROPEAN_TABLE[b]!;
		if (glyph === '') {
			out += '<' + b.toString(16).toUpperCase().padStart(2, '0') + '>';
		} else {
			out += glyph;
		}
	}
	return out;
}
