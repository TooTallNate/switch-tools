/**
 * SNES ROM header parser + BRR sample scanner.
 *
 * SNES ROMs are headerless memory images; there is no file magic.
 * Instead each cartridge carries an "internal header" whose file
 * offset depends on the memory mapping of the board:
 *
 *   LoROM   → 0x7FC0
 *   HiROM   → 0xFFC0
 *   ExHiROM → 0x40FFC0
 *
 * Additionally, many dumps have a 512-byte "copier header" prepended
 * by old backup units; it's detected via `fileSize % 1024 === 512`
 * and stripped before header candidates are considered.
 *
 * Internal header layout (offsets relative to the header base):
 *
 *   0x00-0x14 = title, 21 bytes, JIS X 0201, space-padded
 *               (ASCII + half-width katakana in 0xA1-0xDF)
 *   0x15      = map mode
 *                 bits 0-3: 0=LoROM, 1=HiROM, 5=ExHiROM,
 *                           2=LoROM+S-DD1, 3=SA-1
 *                 bit 4:    FastROM
 *   0x16      = cartridge type (see decodeCartridgeType below)
 *   0x17      = ROM size (`1 << n` KB)
 *   0x18      = RAM size (`1 << n` KB, 0 → 0 KB)
 *   0x19      = destination / region code
 *   0x1A      = developer ID (0x33 → expanded header present at
 *               base-0x10..base-0x01: maker code, game code, etc.)
 *   0x1B      = version
 *   0x1C-0x1D = checksum complement (u16 LE)
 *   0x1E-0x1F = checksum (u16 LE)
 *
 * Because none of this is self-identifying, detection scores each
 * candidate offset on checksum validity, map-mode agreement, title
 * printability, and ROM-size plausibility, and picks the best. A
 * best score below 4 means the file is probably not a SNES ROM.
 *
 * This package also ships a heuristic scanner for BRR audio samples
 * (the S-DSP sample format — see `@tootallnate/brr` for a decoder)
 * embedded in ROM images.
 *
 * References:
 *   - https://problemkaputt.de/fullsnes.htm#snescartridgeromheader
 *   - https://snes.nesdev.org/wiki/ROM_header
 */

import { decodeBrr } from '@tootallnate/brr';

export interface SnesRomInfo {
	mapping: 'lorom' | 'hirom' | 'exhirom' | 'sa1' | 'sdd1' | 'unknown';
	mapMode: number;
	fastRom: boolean;
	/**
	 * File offset of the internal header within the bytes passed in
	 * (i.e. includes the 512-byte copier-header shift, when present).
	 */
	headerOffset: number;
	copierHeader: boolean;
	title: string;
	cartridgeType: number;
	cartridgeTypeName: string;
	coprocessor?: string;
	romSizeKb: number;
	ramSizeKb: number;
	region: number;
	regionName: string;
	developerId: number;
	/** Maker code from the expanded header (developer ID 0x33). */
	makerCode?: string;
	/** Game code from the expanded header (developer ID 0x33). */
	gameCode?: string;
	version: number;
	checksum: number;
	checksumComplement: number;
	checksumValid: boolean;
	/** checksum + complement === 0xFFFF */
	complementValid: boolean;
	score: number;
}

const HEADER_LENGTH = 0x20;

interface Candidate {
	offset: number;
	mapping: 'lorom' | 'hirom' | 'exhirom';
}

const CANDIDATES: Candidate[] = [
	{ offset: 0x7fc0, mapping: 'lorom' },
	{ offset: 0xffc0, mapping: 'hirom' },
	{ offset: 0x40ffc0, mapping: 'exhirom' },
];

const REGION_NAMES: string[] = [
	'Japan',
	'North America',
	'Europe',
	'Sweden/Scandinavia',
	'Finland',
	'Denmark',
	'France',
	'Netherlands',
	'Spain',
	'Germany',
	'Italy',
	'China',
	'Indonesia',
	'South Korea',
	'Global',
	'Canada',
	'Brazil',
	'Australia',
];

const CARTRIDGE_TYPE_NAMES: string[] = [
	'ROM',
	'ROM+RAM',
	'ROM+RAM+Battery',
	'ROM+Coprocessor',
	'ROM+Coprocessor+RAM',
	'ROM+Coprocessor+RAM+Battery',
	'ROM+Coprocessor+Battery',
];

const COPROCESSOR_NAMES: Record<number, string> = {
	0x0: 'DSP',
	0x1: 'GSU',
	0x2: 'OBC1',
	0x3: 'SA-1',
	0x4: 'S-DD1',
	0x5: 'S-RTC',
	0xe: 'Other',
};

const CUSTOM_COPROCESSOR_NAMES: Record<number, string> = {
	0x00: 'SPC7110',
	0x01: 'ST010/ST011',
	0x02: 'ST018',
	0x03: 'CX4',
};

/** True for printable JIS X 0201 bytes (ASCII or half-width katakana). */
function isPrintable(b: number): boolean {
	return (b >= 0x20 && b <= 0x7e) || (b >= 0xa1 && b <= 0xdf);
}

/**
 * Decode a JIS X 0201 title: ASCII passes through, 0xA1-0xDF maps to
 * the Unicode half-width katakana block (U+FF61 + b - 0xA1), anything
 * else becomes '?'. Trailing padding spaces are stripped.
 */
function decodeTitle(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) {
		if (b >= 0x20 && b <= 0x7e) {
			out += String.fromCharCode(b);
		} else if (b >= 0xa1 && b <= 0xdf) {
			out += String.fromCharCode(0xff61 + (b - 0xa1));
		} else {
			out += '?';
		}
	}
	return out.replace(/ +$/, '');
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

/**
 * Compute the ROM checksum: the u16 sum of every ROM byte.
 *
 * For a power-of-two ROM this is a plain sum. Non-power-of-two ROMs
 * (2.5 MB, 3 MB, ...) are checksummed on hardware/emulators by
 * mirroring the trailing remainder region up to the next power of
 * two. We implement the common `sum(P) + k * sum(R)` form, where P
 * is the largest power-of-two prefix, R the remainder, and
 * `k = (nextPow2(total) - P.length) / R.length`.
 *
 * LIMITATION: when `k` is not an integer (an unusual, irregularly
 * sized image), we fall back to the plain sum of all bytes, which
 * may not match what a particular emulator computes.
 */
function computeChecksum(rom: Uint8Array): number {
	const len = rom.length;
	const target = nextPow2(len);
	const p = target === len ? len : target / 2;
	const sumRange = (start: number, end: number): number => {
		let sum = 0;
		for (let i = start; i < end; i++) sum = (sum + rom[i]) & 0xffff;
		return sum;
	};
	if (p === len) {
		// Power-of-two ROM: plain sum.
		return sumRange(0, len);
	}
	const rLen = len - p;
	if (rLen > 0 && (target - p) % rLen === 0) {
		const k = (target - p) / rLen;
		return (sumRange(0, p) + k * sumRange(p, len)) & 0xffff;
	}
	// Fallback: plain sum (see LIMITATION above).
	return sumRange(0, len);
}

function mappingFromMapMode(
	mapMode: number,
): SnesRomInfo['mapping'] {
	switch (mapMode & 0x0f) {
		case 0:
			return 'lorom';
		case 1:
			return 'hirom';
		case 2:
			return 'sdd1';
		case 3:
			return 'sa1';
		case 5:
			return 'exhirom';
		default:
			return 'unknown';
	}
}

function decodeCartridgeType(
	cartridgeType: number,
	chipSubtype: number,
): { name: string; coprocessor?: string } {
	const low = cartridgeType & 0x0f;
	const high = cartridgeType >> 4;
	const name =
		low < CARTRIDGE_TYPE_NAMES.length
			? CARTRIDGE_TYPE_NAMES[low]
			: `Unknown (0x${cartridgeType.toString(16).padStart(2, '0')})`;
	if (low < 3 || low >= CARTRIDGE_TYPE_NAMES.length) {
		return { name };
	}
	let coprocessor: string | undefined;
	if (high === 0xf) {
		coprocessor =
			CUSTOM_COPROCESSOR_NAMES[chipSubtype] ??
			`Custom (0x${chipSubtype.toString(16).padStart(2, '0')})`;
	} else {
		coprocessor =
			COPROCESSOR_NAMES[high] ??
			`Unknown (0x${high.toString(16)})`;
	}
	return { name, coprocessor };
}

/** Score a header candidate; higher is more likely to be the real one. */
function scoreCandidate(
	rom: Uint8Array,
	cand: Candidate,
	computedChecksum: number,
): number {
	const base = cand.offset;
	const view = new DataView(rom.buffer, rom.byteOffset + base, HEADER_LENGTH);
	const complement = view.getUint16(0x1c, true);
	const checksum = view.getUint16(0x1e, true);
	const mapMode = rom[base + 0x15];
	const romSizeCode = rom[base + 0x17];

	let score = 0;
	if (((checksum + complement) & 0xffff) === 0xffff) score += 8;
	if (computedChecksum === checksum) score += 4;

	const mapLow = mapMode & 0x0f;
	if (
		(cand.mapping === 'lorom' &&
			(mapLow === 0 || mapLow === 2 || mapLow === 3)) ||
		(cand.mapping === 'hirom' && mapLow === 1) ||
		(cand.mapping === 'exhirom' && mapLow === 5)
	) {
		score += 3;
	}

	let printable = true;
	for (let i = 0; i < 21; i++) {
		if (!isPrintable(rom[base + i])) {
			printable = false;
			break;
		}
	}
	if (printable) score += 2;

	if (romSizeCode >= 0x05 && romSizeCode <= 0x0f) score += 1;

	return score;
}

/**
 * Parse a SNES ROM image. Returns `null` when the bytes don't look
 * confidently like a SNES ROM (best candidate score < 4).
 */
export function parseSnesRom(bytes: Uint8Array): SnesRomInfo | null {
	const copierHeader = bytes.length % 1024 === 512;
	const rom = copierHeader ? bytes.subarray(512) : bytes;

	const computedChecksum = computeChecksum(rom);

	let best: Candidate | null = null;
	let bestScore = -1;
	for (const cand of CANDIDATES) {
		if (cand.offset + HEADER_LENGTH > rom.length) continue;
		const score = scoreCandidate(rom, cand, computedChecksum);
		if (score > bestScore) {
			bestScore = score;
			best = cand;
		}
	}
	if (best === null || bestScore < 4) return null;

	const base = best.offset;
	const view = new DataView(rom.buffer, rom.byteOffset + base, HEADER_LENGTH);

	const title = decodeTitle(rom.subarray(base, base + 0x15));
	const mapMode = rom[base + 0x15];
	const cartridgeType = rom[base + 0x16];
	const romSizeCode = rom[base + 0x17];
	const ramSizeCode = rom[base + 0x18];
	const region = rom[base + 0x19];
	const developerId = rom[base + 0x1a];
	const version = rom[base + 0x1b];
	const checksumComplement = view.getUint16(0x1c, true);
	const checksum = view.getUint16(0x1e, true);

	// Expanded header (developer ID 0x33) sits just below the base.
	const chipSubtype = base >= 0x01 ? rom[base - 0x01] : 0;
	let makerCode: string | undefined;
	let gameCode: string | undefined;
	if (developerId === 0x33 && base >= 0x10) {
		const dec = new TextDecoder('latin1');
		makerCode = dec.decode(rom.subarray(base - 0x10, base - 0x0e));
		gameCode = dec.decode(rom.subarray(base - 0x0e, base - 0x0a));
	}

	const { name: cartridgeTypeName, coprocessor } = decodeCartridgeType(
		cartridgeType,
		chipSubtype,
	);

	const info: SnesRomInfo = {
		mapping: mappingFromMapMode(mapMode),
		mapMode,
		fastRom: (mapMode & 0x10) !== 0,
		headerOffset: base + (copierHeader ? 512 : 0),
		copierHeader,
		title,
		cartridgeType,
		cartridgeTypeName,
		romSizeKb: 1 << romSizeCode,
		ramSizeKb: ramSizeCode === 0 ? 0 : 1 << ramSizeCode,
		region,
		regionName: REGION_NAMES[region] ?? 'Unknown',
		developerId,
		version,
		checksum,
		checksumComplement,
		checksumValid: computedChecksum === checksum,
		complementValid: ((checksum + checksumComplement) & 0xffff) === 0xffff,
		score: bestScore,
	};
	if (coprocessor !== undefined) info.coprocessor = coprocessor;
	if (makerCode !== undefined) info.makerCode = makerCode;
	if (gameCode !== undefined) info.gameCode = gameCode;
	return info;
}

/** Parse a SNES ROM from a `Blob`. */
export async function parseSnes(blob: Blob): Promise<SnesRomInfo | null> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return parseSnesRom(bytes);
}

/** True when the `Blob` confidently parses as a SNES ROM. */
export async function isSnes(blob: Blob): Promise<boolean> {
	return (await parseSnes(blob)) !== null;
}

/**
 * BRR sample scanner.
 *
 * BRR data is a sequence of 9-byte blocks; each block's header byte
 * encodes END (bit 0), LOOP (bit 1), filter (bits 2-3) and shift /
 * "range" (bits 4-7, valid 0-12). Two structural facts make embedded
 * samples findable heuristically:
 *
 *   1. every block header must have range <= 12, and
 *   2. the FIRST block of a sample must use filter 0, because the
 *      DSP's previous-sample state (p1/p2) starts at 0 — filters
 *      1-3 on the first block would reference garbage.
 *
 * The scanner walks forward one byte at a time, attempting to read a
 * chain of valid blocks at every offset, and accepts a chain when it
 * terminates with an END flag and has a plausible block count.
 *
 * Additionally, all-zero 9-byte blocks ("digital silence") are
 * structurally valid filter-0 blocks, so zero-filled padding regions
 * (ubiquitous in ROMs) would chain up to the next real sample's END
 * flag and produce giant false positives. Two guards handle this:
 * the first block's data bytes must not all be zero, and a chain is
 * killed after {@link MAX_ZERO_RUN} consecutive all-zero blocks
 * (real samples contain brief silence, not multi-KB stretches of
 * digital zero).
 *
 * Structural checks alone still pass plenty of code/data regions
 * (~5% of random offsets start a plausible chain), so accepted
 * chains are then DECODED and validated by amplitude statistics:
 *
 *   • Garbage explodes through the BRR IIR filters and rides the
 *     ±32767 clamps almost continuously; real audio essentially
 *     never does. Chains whose clamped-sample ratio exceeds
 *     `maxClampRatio` (default 1%) are rejected.
 *   • Sparse data tables decode to inaudible noise-floor output;
 *     chains whose peak amplitude is below `minAmplitude`
 *     (default 256 of 32767) are rejected.
 *
 * Measured on Super Mario World (512 KB): 89 structural candidates
 * → ~50 after validation, retaining all of the game's real
 * instrument samples (which show 0% clamping and peaks well above
 * 1000).
 */
export interface BrrSampleRef {
	/** File offset (scan is over the raw bytes given). */
	offset: number;
	/** blocks * 9 */
	byteLength: number;
	blocks: number;
	/** Any block had the LOOP flag. */
	loop: boolean;
}

export interface ScanBrrOptions {
	/** Minimum blocks to accept (default 16, ~0.5 KB — filters noise). */
	minBlocks?: number;
	/** Maximum blocks to accept (default 7282, 64 KB of sample data). */
	maxBlocks?: number;
	/**
	 * Decode-validate candidates (default true). Disable to get the
	 * raw structural matches (useful for debugging the heuristic).
	 */
	validate?: boolean;
	/**
	 * Maximum fraction of decoded samples allowed at/near the
	 * 16-bit clamps (default 0.01). Garbage data explodes through
	 * the IIR filters and clips constantly; real audio doesn't.
	 */
	maxClampRatio?: number;
	/**
	 * Minimum decoded peak amplitude (default 256 of 32767).
	 * Rejects noise-floor chains decoded from sparse data tables.
	 */
	minAmplitude?: number;
}

/**
 * Consecutive all-zero blocks tolerated inside a BRR chain (~16
 * blocks = 256 samples ≈ 8 ms of digital silence at 32 kHz).
 */
const MAX_ZERO_RUN = 16;

/**
 * Decode a structurally-valid chain and check whether the audio it
 * produces is plausible (see the scanner doc comment).
 */
function chainSoundsPlausible(
	chunk: Uint8Array,
	maxClampRatio: number,
	minAmplitude: number,
): boolean {
	const { samples } = decodeBrr(chunk);
	const n = samples.length;
	if (n === 0) return false;
	let clamped = 0;
	let maxAbs = 0;
	for (let i = 0; i < n; i++) {
		const a = samples[i] < 0 ? -samples[i] : samples[i];
		if (a > maxAbs) maxAbs = a;
		// Count samples riding the clamps. Use a slightly-inside
		// threshold: filter feedback that saturates oscillates in
		// the 32000+ zone even when individual samples don't hit
		// exactly ±32767.
		if (a >= 32000) clamped++;
	}
	if (maxAbs < minAmplitude) return false;
	return clamped / n <= maxClampRatio;
}

/** Heuristically scan raw bytes for embedded BRR samples. */
export function scanBrrSamples(
	bytes: Uint8Array,
	opts: ScanBrrOptions = {},
): BrrSampleRef[] {
	const minBlocks = opts.minBlocks ?? 16;
	const maxBlocks = opts.maxBlocks ?? 7282;
	const validate = opts.validate ?? true;
	const maxClampRatio = opts.maxClampRatio ?? 0.01;
	const minAmplitude = opts.minAmplitude ?? 256;
	const refs: BrrSampleRef[] = [];
	const len = bytes.length;

	let o = 0;
	while (o + 9 <= len) {
		const first = bytes[o];
		// Fast bail: first block must have a valid range AND filter 0.
		if (first >> 4 > 12 || ((first >> 2) & 3) !== 0) {
			o++;
			continue;
		}
		// Reject silent first blocks — see doc comment above.
		let anyData = 0;
		for (let i = 1; i < 9; i++) anyData |= bytes[o + i];
		if (anyData === 0) {
			o++;
			continue;
		}

		let pos = o;
		let blocks = 0;
		let loop = false;
		let ended = false;
		let zeroRun = 0;
		while (pos + 9 <= len && blocks < maxBlocks) {
			const header = bytes[pos];
			if (header >> 4 > 12) break; // invalid range → chain dies
			let nonZero = header;
			for (let i = 1; i < 9; i++) nonZero |= bytes[pos + i];
			if (nonZero === 0) {
				if (++zeroRun > MAX_ZERO_RUN) break;
			} else {
				zeroRun = 0;
			}
			blocks++;
			pos += 9;
			if (header & 0x02) loop = true;
			if (header & 0x01) {
				ended = true;
				break;
			}
		}

		if (
			ended &&
			blocks >= minBlocks &&
			blocks <= maxBlocks &&
			(!validate ||
				chainSoundsPlausible(
					bytes.subarray(o, o + blocks * 9),
					maxClampRatio,
					minAmplitude,
				))
		) {
			refs.push({
				offset: o,
				byteLength: blocks * 9,
				blocks,
				loop,
			});
			o = pos; // advance past the accepted sample
		} else {
			o++;
		}
	}

	return refs;
}
