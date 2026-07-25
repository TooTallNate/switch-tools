/**
 * JAudio `AAF` archive and `WSYS` wave index.
 *
 * Nintendo's JAudio engine splits a game's sound data across several files, and
 * on its own none of them is browsable:
 *
 *   • `*.aaf` (or `*.baa`) — the archive. A flat list of typed sections
 *     pointing at instrument banks (`IBNK`) and wave indices (`WSYS`).
 *   • `*.aw`  — raw waveform data. No header, no index, nothing: just
 *     concatenated AFC blocks.
 *   • `*.bms` — sequence bytecode, usually bundled in a separate RARC.
 *
 * The consequence is that an `.aw` cannot be interpreted in isolation. Every
 * fact you need to play a sound out of one — where it starts, how long it is,
 * its sample rate, its loop points, even *which* `.aw` it lives in — is stored
 * in a `WSYS` inside the `.aaf`. This module parses that index so a caller
 * holding both files can pair them up.
 *
 * Everything is big-endian.
 *
 * ## Two container dialects
 *
 * The same logical archive ships in two incompatible encodings, and which one a
 * game uses is not signalled by the extension:
 *
 *   • **Numeric AAF** (`.aaf`, Wind Waker) — sections are `u32` type numbers.
 *   • **Tagged BAA** (`.baa`, Mario Kart: Double Dash!!) — sections are
 *     four-character ASCII tags, opening with `AA_<` and closing with `>_AA`.
 *
 * They are told apart by that opening marker. Getting this wrong is quiet rather
 * than loud: reading a tagged file numerically makes each ASCII tag look like a
 * huge type number, the walk falls into the single-record branch, and it happens
 * to stumble onto *one* valid `WSYS` out of three — so the file appears to parse
 * while most of its banks silently vanish.
 *
 * ## Numeric AAF sections
 *
 * A sequence of `u32` type tags, each followed by records whose shape depends on
 * the tag, terminated by a tag of 0. Two record shapes appear:
 *
 *   • single:    `u32 offset, u32 size`, then a `u32` 0 terminator
 *   • repeating: `u32 offset, u32 size, u32 id` … until an offset of 0
 *
 * Tags 2..4 use the repeating shape (banks and wave indices); the others are
 * single. Rather than trusting a tag-to-meaning table — they differ between
 * games — we identify each record by the magic at the offset it points to,
 * which is unambiguous and self-validating.
 *
 * ## WSYS
 *
 *   0x00 u32 'WSYS'
 *   0x04 u32 size
 *   0x08 u32 id
 *   0x0C u32 padding
 *   0x10 u32 winfOffset   — relative to the WSYS start
 *   0x14 u32 wbctOffset   — relative to the WSYS start
 *
 * `WINF` lists the wave *groups*; `WBCT` lists, in the same order, a matching
 * `SCNE` per group. Note the two are laid out inconsistently — `WINF` puts its
 * count immediately after the magic, while `WBCT` has a padding word first:
 *
 *   WINF: u32 magic, u32 count, u32 offset[count]
 *   WBCT: u32 magic, u32 padding, u32 count, u32 offset[count]
 *
 * A group is the pairing of one `.aw` file with the waves inside it:
 *
 *   char[112] awFileName   — NUL-padded
 *   u32       waveCount
 *   u32       waveInfoOffset[waveCount]
 *
 * The corresponding `SCNE` is almost entirely padding; the only field that
 * matters is a pointer to a `C-DF` table, which supplies each wave's *id* — the
 * number instrument banks use to reference it:
 *
 *   SCNE: u32 magic, u64 unused, u32 cdfOffset
 *   C-DF: u32 magic, u32 count, u32 offset[count]
 *         each entry: s16 awId, s16 waveId
 *
 * ## Wave info
 *
 *   0x00 u8  unknown
 *   0x01 u8  format
 *   0x02 u8  baseKey        — MIDI note the sample was recorded at
 *   0x03 u8  unknown
 *   0x04 f32 sampleRate     — a float, not an integer
 *   0x08 u32 start          — byte offset into the `.aw`
 *   0x0C u32 size           — byte length in the `.aw`
 *   0x10 u32 loopFlag       — 0xFFFFFFFF when looped
 *   0x14 u32 loopStart
 *   0x18 u32 loopEnd
 *   0x1C u32 sampleCount
 *
 * Two things worth knowing before you decode anything:
 *
 *  1. **The waveform data is AFC**, the same 16-samples-per-9-bytes ADPCM used
 *     by `.afc` streams — so `@tootallnate/afc` decodes it. This holds despite
 *     the `format` byte reading 0 rather than the 5 that some documentation
 *     associates with AFC; it was established by checking `size` against
 *     `sampleCount` across a retail index, where the AFC relation held for
 *     every wave and the DSP-ADPCM one for none.
 *  2. **`sampleCount` is not always reachable.** For a minority of waves the
 *     declared count needs more bytes than `size` provides. `size` is the
 *     authoritative figure — see {@link wsysWaveDecodableSamples}.
 */

export const WSYS_MAGIC = 'WSYS';

/** Length of the NUL-padded `.aw` filename field in a wave group. */
export const WSYS_AW_NAME_SIZE = 112;

/** Size of one wave-info record. */
export const WSYS_WAVE_INFO_SIZE = 0x20;

/** Every AFC block, of either variant, decodes to 16 samples. */
const AFC_SAMPLES_PER_BLOCK = 16;
/** 4-bit AFC: a 1-byte block header plus 16 nibbles. */
const AFC_4BIT_BLOCK_SIZE = 9;
/** 2-bit AFC: a 1-byte block header plus 16 two-bit samples. */
const AFC_2BIT_BLOCK_SIZE = 5;

/** `loopFlag` value meaning "this wave loops". */
export const WSYS_LOOPED = 0xffffffff;

/**
 * Values of a wave's `format` byte.
 *
 * Wind Waker uses only {@link AFC_4BIT}, which is why it is easy to assume the
 * field is vestigial. Mario Kart: Double Dash!! mixes in {@link PCM8}, and
 * decoding those 15 waves as AFC yields 39% clipped samples against 0.004% for
 * the rest — so the field must be honoured rather than ignored.
 *
 * Super Mario Sunshine uses three of the four, and its 1680 waves let the
 * meaning of each value be measured rather than assumed. Dividing every wave's
 * byte length by its declared sample count gives, per format value:
 *
 *     format 0  (1500 waves)  0.5625 bytes/sample = 9/16
 *     format 1  ( 152 waves)  0.3125 bytes/sample = 5/16
 *     format 3  (  28 waves)  2.0000 bytes/sample exactly
 *
 * 9/16 and 5/16 are precisely the two AFC block layouts, and an exact 2.0
 * settles PCM16 with no room for interpretation. That also fixes 2 as PCM8 by
 * elimination, matching what Double Dash independently showed.
 */
export const WsysWaveFormat = {
	/** 4-bit AFC ADPCM: 16 samples per 9 bytes. */
	AFC_4BIT: 0,
	/** 2-bit AFC ADPCM: 16 samples per 5 bytes. */
	AFC_2BIT: 1,
	/** Signed 8-bit PCM: one byte per sample. */
	PCM8: 2,
	/** Signed 16-bit big-endian PCM: two bytes per sample. */
	PCM16: 3,
} as const;

/**
 * Block size in bytes for the AFC variants, or 0 when the format is not a
 * block codec. This doubles as the value `@tootallnate/afc` uses to identify a
 * variant, since AFC is distinguished by nothing but its block size.
 */
export function wsysWaveAfcBlockSize(format: number): 0 | 5 | 9 {
	if (format === WsysWaveFormat.AFC_4BIT) return AFC_4BIT_BLOCK_SIZE;
	if (format === WsysWaveFormat.AFC_2BIT) return AFC_2BIT_BLOCK_SIZE;
	return 0;
}

/** Bytes one sample of a given format occupies, or 0 for block codecs. */
function bytesPerSample(format: number): number {
	if (format === WsysWaveFormat.PCM8) return 1;
	if (format === WsysWaveFormat.PCM16) return 2;
	return 0;
}

export interface WsysWave {
	/** Index within its group. */
	index: number;
	/**
	 * Global wave id from the `C-DF` table — what instrument banks reference.
	 * -1 when the table is missing or shorter than the wave list.
	 */
	id: number;
	/** Which `.aw` the `C-DF` table claims this wave is in. -1 when unknown. */
	awId: number;
	/** Raw format byte. 0 across retail Wind Waker data; the payload is AFC. */
	format: number;
	/** MIDI note the sample was recorded at, for pitch-correct playback. */
	baseKey: number;
	sampleRate: number;
	/** Byte offset into the group's `.aw`. */
	start: number;
	/** Byte length in the `.aw`. */
	size: number;
	looped: boolean;
	loopStart: number;
	loopEnd: number;
	/** Declared sample count; may exceed what `size` can supply. */
	sampleCount: number;
}

export interface WsysGroup {
	index: number;
	/** Filename of the `.aw` holding this group's waves. */
	awFileName: string;
	waves: WsysWave[];
}

export interface Wsys {
	id: number;
	/** Absolute offset of the `WSYS` block. */
	offset: number;
	size: number;
	groups: WsysGroup[];
}

export interface AafSection {
	/** The section's `u32` type tag. */
	type: number;
	/** Absolute offset of the payload. */
	offset: number;
	size: number;
	/** Id from the repeating record shape, or -1 for single records. */
	id: number;
	/** 4-character magic found at `offset`, for identification. */
	magic: string;
}

export interface Aaf {
	sections: AafSection[];
	/** Sections whose payload starts with `IBNK`. */
	banks: AafSection[];
	/** Parsed `WSYS` wave indices. */
	wsys: Wsys[];
}

function magicAt(bytes: Uint8Array, offset: number): string {
	if (offset < 0 || offset + 4 > bytes.length) return '';
	let s = '';
	for (let i = 0; i < 4; i++) {
		const c = bytes[offset + i];
		s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
	}
	return s;
}

/** Read a NUL-padded fixed-width name. */
function fixedName(bytes: Uint8Array, offset: number, width: number): string {
	const end = Math.min(offset + width, bytes.length);
	let stop = end;
	for (let i = offset; i < end; i++) {
		if (bytes[i] === 0) {
			stop = i;
			break;
		}
	}
	let s = '';
	for (let i = offset; i < stop; i++) s += String.fromCharCode(bytes[i]);
	return s;
}

/**
 * Parse a single `WSYS` block at `offset`.
 *
 * Returns `null` when the magic or either sub-table is wrong. Individual groups
 * that don't validate are skipped rather than failing the whole index — a
 * partially-understood bank is still worth browsing.
 */
export function parseWsys(bytes: Uint8Array, offset: number): Wsys | null {
	if (offset < 0 || offset + 0x18 > bytes.length) return null;
	if (magicAt(bytes, offset) !== WSYS_MAGIC) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(o, false);

	const size = u32(offset + 0x04);
	const id = u32(offset + 0x08);
	// Both sub-table offsets are relative to the WSYS block, not the file.
	const winf = offset + u32(offset + 0x10);
	const wbct = offset + u32(offset + 0x14);
	if (magicAt(bytes, winf) !== 'WINF') return null;
	if (magicAt(bytes, wbct) !== 'WBCT') return null;

	const groupCount = u32(winf + 4);
	if (groupCount > 0xffff) return null;
	if (winf + 8 + groupCount * 4 > bytes.length) return null;

	// WBCT carries a padding word before its count; WINF does not.
	const scneCount = u32(wbct + 8);
	const scneOffsets: number[] = [];
	if (wbct + 12 + scneCount * 4 <= bytes.length) {
		for (let i = 0; i < scneCount; i++) {
			scneOffsets.push(offset + u32(wbct + 12 + i * 4));
		}
	}

	const groups: WsysGroup[] = [];
	for (let g = 0; g < groupCount; g++) {
		const groupAt = offset + u32(winf + 8 + g * 4);
		if (groupAt < 0 || groupAt + WSYS_AW_NAME_SIZE + 4 > bytes.length) continue;
		const awFileName = fixedName(bytes, groupAt, WSYS_AW_NAME_SIZE);
		const waveCount = u32(groupAt + WSYS_AW_NAME_SIZE);
		if (waveCount > 0xffff) continue;
		const listAt = groupAt + WSYS_AW_NAME_SIZE + 4;
		if (listAt + waveCount * 4 > bytes.length) continue;

		// The matching SCNE supplies wave ids via a C-DF table. It's optional:
		// without it the waves are still fully described, they just have no
		// bank-facing id.
		const ids: { awId: number; id: number }[] = [];
		const scne = scneOffsets[g];
		if (scne !== undefined && magicAt(bytes, scne) === 'SCNE') {
			const cdf = offset + u32(scne + 12);
			if (magicAt(bytes, cdf) === 'C-DF') {
				const n = u32(cdf + 4);
				if (n <= 0xffff && cdf + 8 + n * 4 <= bytes.length) {
					for (let i = 0; i < n; i++) {
						const e = offset + u32(cdf + 8 + i * 4);
						if (e + 4 > bytes.length) break;
						ids.push({
							awId: view.getInt16(e, false),
							id: view.getInt16(e + 2, false),
						});
					}
				}
			}
		}

		const waves: WsysWave[] = [];
		for (let i = 0; i < waveCount; i++) {
			const at = offset + u32(listAt + i * 4);
			if (at < 0 || at + WSYS_WAVE_INFO_SIZE > bytes.length) continue;
			waves.push({
				index: i,
				id: ids[i]?.id ?? -1,
				awId: ids[i]?.awId ?? -1,
				format: bytes[at + 1],
				baseKey: bytes[at + 2],
				sampleRate: view.getFloat32(at + 4, false),
				start: u32(at + 8),
				size: u32(at + 12),
				looped: u32(at + 16) === WSYS_LOOPED,
				loopStart: u32(at + 20),
				loopEnd: u32(at + 24),
				sampleCount: u32(at + 28),
			});
		}
		groups.push({ index: g, awFileName, waves });
	}

	return { id, offset, size, groups };
}

/**
 * Parse an `.aaf` / `.baa` archive.
 *
 * The walk is driven by the section tags but every record is *identified* by the
 * magic at its target, so a game whose tag numbering differs still yields the
 * right banks and wave indices. Returns `null` only when nothing recognisable
 * is found at all.
 */
/** Four-character tag at `offset`, or `''`. */
function tagAt(bytes: Uint8Array, offset: number): string {
	if (offset < 0 || offset + 4 > bytes.length) return '';
	let s = '';
	for (let i = 0; i < 4; i++) s += String.fromCharCode(bytes[offset + i]);
	return s;
}

/**
 * Bytes each tagged-BAA section record occupies, including its tag.
 *
 * `ws  ` is the odd one out at 16: it carries an id, an offset and a flag, where
 * the others carry two words. Using a uniform stride desynchronises the walk at
 * the first wave-index section.
 */
const BAA_SECTION_SIZE: Record<string, number> = {
	'bst ': 12,
	bstn: 12,
	'bsc ': 12,
	// `bms ` carries an id plus a start/end pair, so it is 16 rather than the
	// 12 its neighbours use. Retail files happen to place every `ws  ` before
	// the first `bms `, so an undersized stride here corrupts only the tail of
	// the walk — which is exactly the kind of error that hides.
	'bms ': 16,
	'bnk ': 12,
	bsft: 8,
	baac: 12,
	'ws  ': 16,
};

/** Which word of a tagged section holds a file offset. */
const BAA_OFFSET_WORD: Record<string, number> = {
	'bnk ': 2,
	'ws  ': 2,
};

/**
 * Parse the tagged (`AA_<`) dialect.
 *
 * Sections are identified by their ASCII tag, but each one's *payload* is still
 * confirmed by the magic at the offset it points to, so a tag we mis-size shows
 * up as a missing section rather than a bogus one.
 */
function parseBaa(bytes: Uint8Array): Aaf | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const sections: AafSection[] = [];
	let p = 4; // past 'AA_<'
	for (let guard = 0; guard < 4096 && p + 4 <= bytes.length; guard++) {
		const tag = tagAt(bytes, p);
		if (tag === '>_AA' || tag === '') break;
		const size = BAA_SECTION_SIZE[tag];
		if (size === undefined) break; // unknown tag: stop rather than guess
		if (p + size > bytes.length) break;
		const word = BAA_OFFSET_WORD[tag];
		if (word !== undefined) {
			const offset = view.getUint32(p + word * 4, false);
			if (offset > 0 && offset < bytes.length) {
				sections.push({
					type: 0,
					offset,
					size: 0,
					id: view.getUint32(p + 4, false),
					magic: magicAt(bytes, offset),
				});
			}
		}
		p += size;
	}
	if (sections.length === 0) return null;
	const banks = sections.filter((s) => s.magic === 'IBNK');
	const wsys: Wsys[] = [];
	for (const s of sections) {
		if (s.magic !== WSYS_MAGIC) continue;
		const parsed = parseWsys(bytes, s.offset);
		if (parsed) wsys.push(parsed);
	}
	return { sections, banks, wsys };
}

/**
 * Whether a tagged BAA's section walk reaches its `>_AA` terminator.
 *
 * A stride that is wrong for any tag desynchronises the walk and it stops on
 * garbage instead. Reaching the terminator is therefore a cheap, decisive check
 * that every stride in {@link BAA_SECTION_SIZE} is right — much stronger than
 * "we found some sections".
 */
export function baaWalkIsComplete(bytes: Uint8Array): boolean {
	if (tagAt(bytes, 0) !== 'AA_<') return false;
	let p = 4;
	for (let guard = 0; guard < 4096 && p + 4 <= bytes.length; guard++) {
		const tag = tagAt(bytes, p);
		if (tag === '>_AA') return true;
		const size = BAA_SECTION_SIZE[tag];
		if (size === undefined) return false;
		p += size;
	}
	return false;
}

export function parseAaf(bytes: Uint8Array): Aaf | null {
	if (bytes.length < 12) return null;
	// The tagged dialect announces itself; everything else is numeric.
	if (tagAt(bytes, 0) === 'AA_<') return parseBaa(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(o, false);

	const sections: AafSection[] = [];
	let p = 0;
	// Bounded so a malformed file can't spin: each iteration consumes at least
	// four bytes, and no real archive has thousands of sections.
	for (let guard = 0; guard < 4096 && p + 4 <= bytes.length; guard++) {
		const type = u32(p);
		p += 4;
		if (type === 0) break;
		// Tags 2..4 use the repeating (offset, size, id) shape; everything else
		// is a single (offset, size) followed by a terminator.
		const repeating = type >= 2 && type <= 4;
		if (repeating) {
			for (let guard2 = 0; guard2 < 4096; guard2++) {
				if (p + 4 > bytes.length) break;
				const offset = u32(p);
				if (offset === 0) {
					p += 4;
					break;
				}
				if (p + 12 > bytes.length) break;
				const size = u32(p + 4);
				const id = u32(p + 8);
				p += 12;
				sections.push({ type, offset, size, id, magic: magicAt(bytes, offset) });
			}
		} else {
			if (p + 8 > bytes.length) break;
			const offset = u32(p);
			const size = u32(p + 4);
			p += 8;
			sections.push({ type, offset, size, id: -1, magic: magicAt(bytes, offset) });
			// A zero terminator follows a single record.
			if (p + 4 <= bytes.length && u32(p) === 0) p += 4;
		}
	}

	if (sections.length === 0) return null;

	const banks = sections.filter((s) => s.magic === 'IBNK');
	const wsys: Wsys[] = [];
	for (const s of sections) {
		if (s.magic !== WSYS_MAGIC) continue;
		const parsed = parseWsys(bytes, s.offset);
		if (parsed) wsys.push(parsed);
	}

	return { sections, banks, wsys };
}

/**
 * How many samples of a wave are actually decodable.
 *
 * The declared `sampleCount` sometimes exceeds what `size` bytes of AFC can
 * supply, so the byte length wins. Using `sampleCount` blindly would run the
 * decoder off the end of the wave and into its neighbour.
 */
export function wsysWaveDecodableSamples(wave: WsysWave): number {
	const perSample = bytesPerSample(wave.format);
	// An unrecognised format byte is treated as 4-bit AFC, which is what the
	// overwhelming majority of waves are; that keeps a bad byte from zeroing
	// out a wave that would otherwise decode.
	const blockSize = wsysWaveAfcBlockSize(wave.format) || AFC_4BIT_BLOCK_SIZE;
	const fromBytes =
		perSample > 0
			? Math.floor(wave.size / perSample)
			: Math.floor(wave.size / blockSize) * AFC_SAMPLES_PER_BLOCK;
	if (wave.sampleCount <= 0) return Math.max(0, fromBytes);
	return Math.max(0, Math.min(wave.sampleCount, fromBytes));
}

/**
 * Decode a signed 8-bit PCM wave to PCM16.
 *
 * Returns `null` unless the wave really is {@link WsysWaveFormat.PCM8}, so a
 * caller can branch on the result rather than having to pre-check the format.
 */
export function decodeWsysPcm8(
	bytes: Uint8Array,
	wave: WsysWave,
	base: number,
): Int16Array | null {
	if (wave.format !== WsysWaveFormat.PCM8) return null;
	const count = wsysWaveDecodableSamples(wave);
	const start = base + wave.start;
	if (count <= 0 || start + count > bytes.length) return null;
	const out = new Int16Array(count);
	for (let i = 0; i < count; i++) {
		// Sign-extend, then scale by 256. The tempting 257 (0x101) maps 127 to
		// full scale but sends -128 to -32896, which is outside int16 and wraps
		// to a large positive value — turning the loudest negative samples into
		// loud positive ones.
		out[i] = ((bytes[start + i] << 24) >> 24) << 8;
	}
	return out;
}

/**
 * Decode a signed 16-bit PCM wave.
 *
 * Big-endian, because the GameCube is. These are the handful of sounds a game
 * refuses to let the ADPCM encoder near — on Sunshine all 28 of them.
 *
 * Returns `null` unless the wave really is {@link WsysWaveFormat.PCM16}, so a
 * caller can branch on the result rather than having to pre-check the format.
 */
export function decodeWsysPcm16(
	bytes: Uint8Array,
	wave: WsysWave,
	base: number,
): Int16Array | null {
	if (wave.format !== WsysWaveFormat.PCM16) return null;
	const count = wsysWaveDecodableSamples(wave);
	const start = base + wave.start;
	if (count <= 0 || start + count * 2 > bytes.length) return null;
	const out = new Int16Array(count);
	for (let i = 0; i < count; i++) {
		const at = start + i * 2;
		out[i] = ((bytes[at] << 8) | bytes[at + 1]) << 16 >> 16;
	}
	return out;
}

/** Duration in seconds of a wave's decodable portion. */
export function wsysWaveDuration(wave: WsysWave): number {
	if (wave.sampleRate <= 0) return 0;
	return wsysWaveDecodableSamples(wave) / wave.sampleRate;
}

/** Every group across every `WSYS`, flattened. */
export function aafWaveGroups(aaf: Aaf): WsysGroup[] {
	const out: WsysGroup[] = [];
	for (const w of aaf.wsys) out.push(...w.groups);
	return out;
}

/**
 * Find the group belonging to a given `.aw` filename, case-insensitively.
 *
 * This is the lookup that makes an `.aw` interpretable: given the file's own
 * name, it recovers the index describing its contents.
 */
export function findWaveGroupForAw(aaf: Aaf, awFileName: string): WsysGroup | null {
	const want = awFileName.toLowerCase();
	for (const group of aafWaveGroups(aaf)) {
		if (group.awFileName.toLowerCase() === want) return group;
	}
	return null;
}
