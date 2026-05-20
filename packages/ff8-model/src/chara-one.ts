/**
 * FFVIII `chara.one` outer-container parser.
 *
 * `chara.one` is a small file that ships in every FFVIII field
 * map and lists the field-character models the map uses. The
 * file is a flat directory of fixed-size entry headers followed
 * by variable-size per-entry bodies starting at a 0x800 boundary.
 *
 * On-disk layout (verified against 873 chara.one files from the
 * FFVIII Switch Remastered build — 862 / 873 ≈ 98.7 % match this
 * exact format; the remaining ~11 are size-prefixed dev/test
 * leftovers that this parser surfaces as a typed error so callers
 * can ignore them):
 *
 *   offset  type   field
 *     0x00  u32    entryCount
 *     0x04  …      `entryCount × 32`-byte EntryRecord array
 *     0x800 …      payload data (offsets in EntryRecord are
 *                  absolute, but start at 0x800 by convention)
 *
 * Each 32-byte EntryRecord:
 *
 *     0x00  u32  payloadOffset      (absolute, normally 0x800+)
 *     0x04  u32  payloadLength
 *     0x08  u32  payloadLengthDup   (== payloadLength)
 *     0x0C  u16  characterId
 *     0x0E  u16  characterFlag      (0xd010 / 0xd0NN = chara
 *                                    entry; other values seen)
 *     0x10  u32  typeMark           (0 = CharD; -1 = CharPO_neg;
 *                                    other = CharPO_pos)
 *
 *   …followed by a variable 12 / 16 / 24-byte trailer depending
 *   on `typeMark` (taken inline in the same EntryRecord; this is
 *   what makes the records variable-size despite the constant
 *   0x800-aligned payload section):
 *
 *     typeMark == 0           CharD       (12 bytes)
 *       +0x00  char[4]  name              ("d042", "p001", …)
 *       +0x04  u32      reserved          (typically 0)
 *       +0x08  u32      extLoaderId       (lighting / loader id)
 *     typeMark == -1          CharPO_neg  (16 bytes)
 *       +0x00  u32      unknown1
 *       +0x04  char[4]  name
 *       +0x08  u32      unknown2
 *       +0x0C  u32      unknown3
 *     other                   CharPO_pos  (24 bytes — typeMark is
 *                                          actually part of the
 *                                          body; CharHeader
 *                                          consumes 16 bytes not 20)
 *       +0x00  u32      unknown0          (already inside record)
 *       +0x04  u32      unknown1
 *       +0x08  char[4]  name
 *       +0x0C  u32      unknown2
 *       +0x10  u32      unknown3
 *
 * Reference: MaKiPL/test_bootstrap_fs (CharaOne.cs) — the only
 * cross-platform implementation we located that matches the
 * Switch Remastered layout. The earlier deling-derived spec
 * (which described 12-byte entry headers + +4 fudge factor +
 * page-based offsets) describes the *PSX* on-disk format and
 * does not apply to the PC / Switch builds — those builds were
 * untangled into the flat layout above.
 *
 * Dummy-file detection: empty or sub-0x100-byte `chara.one`
 * files are sentinels for maps that ship no characters.
 */

/** Error raised when `chara.one` cannot be parsed. */
export class CharaOneParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CharaOneParseError';
	}
}

/**
 * Which body shape follows the 16-byte common header (and how
 * many bytes the variable trailer occupies).
 */
export type CharaOneVariant = 'chard' | 'charpo-neg' | 'charpo-pos';

/** One entry in a `chara.one` directory. */
export interface CharaOneEntry {
	/** Zero-based index of this entry in the file. */
	index: number;
	/**
	 * Absolute byte offset (from the start of the chara.one
	 * file) of this entry's payload data — the start of the
	 * embedded MCH body (and any preceding TIM textures).
	 */
	payloadOffset: number;
	/** Size of the payload in bytes. */
	payloadLength: number;
	/** Per-entry character id (game-specific u16). */
	characterId: number;
	/**
	 * Per-entry character flag. `0xd010` (or `0xd000`-family
	 * values) is the well-known marker for a "character" entry;
	 * other values exist (zero on some special entries).
	 */
	characterFlag: number;
	/**
	 * Raw 32-bit `typeMark` value as it appears on-disk. Drives
	 * the choice of variant body.
	 */
	typeMark: number;
	variant: CharaOneVariant;
	/**
	 * ASCII name parsed from the variant body — usually a
	 * d-reference like `"d042"` for a sibling `d###.mch` file,
	 * `"p###"` for party members, `"xxxx"` for unused slots, or
	 * a 4-letter ASCII tag.
	 */
	name: string;
	/**
	 * Best-effort numeric id parsed out of `name` if it follows
	 * the `<letter><3 digits>` convention (e.g. `"d042"` →
	 * `42`). `undefined` for non-numeric names.
	 */
	externalRefId?: number;
	/** Extension-loader / lighting id from the variant body. */
	extLoaderId?: number;
	/**
	 * Raw bytes of the variant body (12 / 16 / 24 bytes), kept
	 * for callers that want to inspect unknown fields without
	 * re-reading the file.
	 */
	bodyBytes: Uint8Array;
}

/** Result of {@link parseCharaOne}. */
export interface ParsedCharaOne {
	entryCount: number;
	entries: CharaOneEntry[];
	/**
	 * True if the file is the sentinel / sub-0x100 placeholder
	 * shipped by maps with no characters. In that case
	 * `entries` is empty.
	 */
	isDummy: boolean;
	/**
	 * True if the file starts with a `[u32 fileSize]` prefix
	 * that does NOT match the documented layout. Such files
	 * appear to be Square's leftover dev / test data; the
	 * parser returns the empty entry list for them so callers
	 * can skip without error. (11 of 873 files in the Switch
	 * Remastered build trip this flag.)
	 */
	isOddball: boolean;
}

/**
 * Detect FFVIII's "no characters" placeholders.
 *
 * Two known shapes:
 *   1. The 33-byte ASCII sentinel `"This is dummy file. Kazuo Suzuki\n"`.
 *   2. A small filler block under 0x100 bytes.
 */
export function isDummyCharaOne(bytes: Uint8Array): boolean {
	if (bytes.length === 33) return true;
	if (bytes.length < 0x100) return true;
	return false;
}

/** Options for {@link parseCharaOne}. */
export interface ParseCharaOneOptions {
	/**
	 * If true (default), files whose first u32 equals the file
	 * length are flagged as oddball / dev-test leftovers and
	 * returned with `entries: []` and `isOddball: true` instead
	 * of throwing. Set false to opt into strict parsing.
	 */
	tolerateOddballs?: boolean;
}

/**
 * Parse a chara.one entry directory. The MCH bodies inside each
 * entry are NOT decoded here — pass `payloadOffset` to
 * {@link parseMch} for that.
 */
export function parseCharaOne(
	bytes: Uint8Array,
	opts: ParseCharaOneOptions = {},
): ParsedCharaOne {
	if (isDummyCharaOne(bytes)) {
		return { entryCount: 0, entries: [], isDummy: true, isOddball: false };
	}
	if (bytes.length < 4) {
		throw new CharaOneParseError(
			`chara.one too short (${bytes.length} bytes)`,
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	);

	// "Oddball" detection: ~11 files in the Switch Remastered
	// build begin with `[u32 fileLength]` and use a layout we
	// haven't been able to map. They appear to be Square's
	// leftover dev / test data (`test10.chara.one`,
	// `test11.chara.one`, `test12.chara.one` are all 421744-byte
	// duplicates of each other; `glsta3` / `glsta4` likewise).
	// We tolerate them by returning empty entries.
	const u0 = view.getUint32(0, true);
	const tolerateOddballs = opts.tolerateOddballs !== false;
	if (u0 === bytes.length) {
		if (!tolerateOddballs) {
			throw new CharaOneParseError(
				`Oddball chara.one with leading file-size prefix (size=${bytes.length}); pass {tolerateOddballs:true} to skip`,
			);
		}
		return { entryCount: 0, entries: [], isDummy: false, isOddball: true };
	}

	const entryCount = u0;
	// Sanity bound — real files have at most ~25 entries.
	if (entryCount === 0 || entryCount > 256) {
		throw new CharaOneParseError(
			`Implausible entryCount ${entryCount} (file likely not a chara.one)`,
		);
	}

	const entries: CharaOneEntry[] = [];
	let p = 4;
	for (let i = 0; i < entryCount; i++) {
		if (p + 16 > bytes.length) {
			throw new CharaOneParseError(
				`Truncated entry header at index ${i} (offset 0x${p.toString(16)})`,
			);
		}
		const payloadOffset = view.getUint32(p, true);
		const payloadLength = view.getUint32(p + 4, true);
		// payloadLengthDup at +8 is ignored (validated to match
		// in real files; we don't fail on mismatch to stay
		// tolerant of off-spec dumps).
		const characterId = view.getUint16(p + 12, true);
		const characterFlag = view.getUint16(p + 14, true);
		const typeMark = view.getInt32(p + 16, true);
		p += 20;

		// Variant-body shape & length:
		let variant: CharaOneVariant;
		let bodyLen: number;
		if (typeMark === 0) {
			variant = 'chard';
			bodyLen = 12;
		} else if (typeMark === -1) {
			variant = 'charpo-neg';
			bodyLen = 16;
		} else {
			// Other non-zero values consume 24 bytes (we already
			// read 4 of those as `typeMark`; consume the
			// remaining 20).
			variant = 'charpo-pos';
			bodyLen = 20;
		}
		if (p + bodyLen > bytes.length) {
			throw new CharaOneParseError(
				`Truncated entry body at index ${i} (offset 0x${p.toString(16)}, want ${bodyLen} bytes)`,
			);
		}
		const bodyBytes = bytes.slice(p, p + bodyLen);
		p += bodyLen;

		// Extract `name` per variant — always a 4-char ASCII run.
		let nameOffset: number;
		let extLoaderId: number | undefined;
		if (variant === 'chard') {
			nameOffset = 0;
			extLoaderId = readU32LE(bodyBytes, 8);
		} else if (variant === 'charpo-neg') {
			nameOffset = 4;
			extLoaderId = readU32LE(bodyBytes, 12);
		} else {
			// charpo-pos: u32 unknown0 (we already consumed
			// typeMark as that u32), then u32 unknown1,
			// char[4] name at +4 within bodyBytes
			// (because bodyLen here is 20 not 24).
			nameOffset = 4;
			extLoaderId = readU32LE(bodyBytes, 16);
		}
		const name = decodeAsciiName(bodyBytes, nameOffset, 4);
		const externalRefId = parseRefIdFromName(name);

		entries.push({
			index: i,
			payloadOffset,
			payloadLength,
			characterId,
			characterFlag,
			typeMark,
			variant,
			name,
			externalRefId,
			extLoaderId,
			bodyBytes,
		});
	}

	return { entryCount, entries, isDummy: false, isOddball: false };
}

function readU32LE(bytes: Uint8Array, offset: number): number | undefined {
	if (offset + 4 > bytes.length) return undefined;
	return (
		bytes[offset]! |
		(bytes[offset + 1]! << 8) |
		(bytes[offset + 2]! << 16) |
		(bytes[offset + 3]! << 24)
	) >>> 0;
}

function decodeAsciiName(
	bytes: Uint8Array,
	offset: number,
	maxLen: number,
): string {
	let out = '';
	for (let i = 0; i < maxLen; i++) {
		const c = bytes[offset + i];
		if (c === undefined) break;
		if (c === 0) break;
		// Only emit printable ASCII; anything else terminates so
		// junk bytes don't make their way into UIs.
		if (c < 0x20 || c > 0x7e) break;
		out += String.fromCharCode(c);
	}
	return out;
}

/**
 * Parse `<letter><3 digits>` style names into the numeric id.
 * Returns `undefined` for any other shape.
 */
function parseRefIdFromName(name: string): number | undefined {
	const m = name.match(/^[A-Za-z](\d{3})$/);
	return m ? Number(m[1]) : undefined;
}
