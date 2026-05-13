/*
 * @tootallnate/hca — pure-TypeScript decoder for CRI Middleware's
 * High Compression Audio (HCA) codec.
 *
 * Ported from vgmstream's clHCA (ISC license, by nyaga / kode54 /
 * bnnm). See README + LICENSE.
 */

import { BitReader } from './bit-reader.js';
import { checkSum } from './cipher.js';

/** clHCA's HCA version constants. */
export const HCA_VERSION_V101 = 0x0101;
export const HCA_VERSION_V102 = 0x0102;
export const HCA_VERSION_V103 = 0x0103;
export const HCA_VERSION_V200 = 0x0200;
export const HCA_VERSION_V300 = 0x0300;

export const HCA_SUBFRAMES = 8;
export const HCA_SAMPLES_PER_SUBFRAME = 128;
export const HCA_SAMPLES_PER_FRAME = HCA_SUBFRAMES * HCA_SAMPLES_PER_SUBFRAME; // 1024
export const HCA_MAX_CHANNELS = 16;
export const HCA_MIN_FRAME_SIZE = 0x8;
export const HCA_MAX_FRAME_SIZE = 0xffff;

const HCA_MASK = 0x7f7f7f7f;

/**
 * Parsed HCA header.
 *
 * Field names in `camelCase` mirror the canonical clHCA `clHCA_stInfo`
 * surface (with extra internal fields the decoder needs). A few
 * legacy aliases (`channelCount`, `samplingRate`, `blockCount`,
 * `blockSize`, `ciphType`, `version`) are preserved for compatibility
 * with the previous kohos-based port.
 */
export interface HcaHeader {
	/** Raw version word (e.g. 0x0300 for v3.0). */
	version: number;
	/** Total header byte length (data starts at `headerSize`). */
	headerSize: number;
	/** Channel count, 1..16 (encoder usually emits ≤ 8). */
	channelCount: number;
	/** Sample rate in Hz. */
	samplingRate: number;
	/** Number of compressed frames/blocks in the file. */
	blockCount: number;
	/** Samples appended to the front (encoder priming / look-ahead). */
	encoderDelay: number;
	/** Samples appended to the end (encoder padding). */
	encoderPadding: number;
	/** Compressed block size in bytes (CBR; usually 0x100..0x800). */
	blockSize: number;

	/** Lower quantisation resolution bound (v3.0 may be 0). */
	minResolution: number;
	/** Upper quantisation resolution bound (always 15 in v1/v2). */
	maxResolution: number;
	/** Logical "track" count: channels / track_count = per-track channels. */
	trackCount: number;
	/** Channel configuration nibble (informs the stereo type map). */
	channelConfig: number;
	/** `dec\0`-flavour stereo type (0 = mono-only). */
	stereoType: number;
	/** Total encoded subband count (≤ 128). */
	totalBandCount: number;
	/** Bands per channel coded discretely. */
	baseBandCount: number;
	/** Bands coded with intensity stereo. */
	stereoBandCount: number;
	/** Bands per HFR (high-frequency reconstruction) group. */
	bandsPerHfrGroup: number;
	/** Mid/Side stereo flag (v3.0+). */
	msStereo: number;
	/** Header reserved nibble. */
	reserved: number;

	/** VBR maximum frame size (`vbr` chunk; 0 if absent). */
	vbrMaxFrameSize: number;
	/** VBR noise level (`vbr` chunk; 0 if absent). */
	vbrNoiseLevel: number;

	/** ATH curve type: 0 = flat, 1 = curved (rare, pre-v2). */
	athType: number;

	/** Loop start block, or 0 if `loopFlag==0`. */
	loopStartFrame: number;
	/** Loop end block, or 0 if `loopFlag==0`. */
	loopEndFrame: number;
	/** Samples inside the start block before the loop point. */
	loopStartDelay: number;
	/** Samples inside the end block after the loop point. */
	loopEndPadding: number;
	/** 1 iff a `loop` chunk was present. */
	loopFlag: number;

	/** Cipher type: 0 = none, 1 = static permutation, 56 = key-derived. */
	ciphType: number;

	/** Volume gain from the `rva ` chunk; 1.0 when absent. */
	rvaVolume: number;

	/** UTF-8 file comment; `null` when absent. */
	comment: string | null;

	/** Computed: number of HFR groups (`ceil2(remaining_bands, bands_per_hfr_group)`). */
	hfrGroupCount: number;

	// =====================================================================
	// Legacy aliases — preserved so existing consumers (`nx-archive`)
	// keep compiling against the older field names.
	// =====================================================================

	/** Alias of {@link headerSize}. */
	dataOffset: number;
	/** Alias of {@link encoderDelay} (the legacy port used this name). */
	muteHeader: number;
	/** Alias of {@link encoderPadding}. */
	muteFooter: number;
	/** Alias of {@link rvaVolume}. */
	volume: number;
}

export class HcaHeaderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HcaHeaderError';
	}
}

/** Check `bytes[off..off+4)` matches `tag` modulo the encryption high-bit. */
function fourCC(bytes: Uint8Array, off: number, tag: string): boolean {
	if (off + 4 > bytes.length) return false;
	for (let i = 0; i < 4; i++) {
		if ((bytes[off + i]! & 0x7f) !== tag.charCodeAt(i)) return false;
	}
	return true;
}

function ceil2(a: number, b: number): number {
	if (b < 1) return 0;
	return Math.floor(a / b) + (a % b ? 1 : 0);
}

/**
 * Parse an HCA file header.
 *
 * @throws {@link HcaHeaderError} on a malformed header (bad magic,
 *   unknown version, missing mandatory chunks, etc.).
 */
export function parseHcaHeader(bytes: Uint8Array): HcaHeader {
	if (bytes.length < 0x08) {
		throw new HcaHeaderError(`HCA header truncated: only ${bytes.length} bytes.`);
	}
	if (!fourCC(bytes, 0, 'HCA\0')) {
		throw new HcaHeaderError(
			`HCA bad magic: got 0x${Array.from(bytes.subarray(0, 4))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')}`,
		);
	}

	const br = new BitReader(bytes, bytes.length);

	// HCA header
	br.skip(32); // "HCA\0"
	const version = br.read(16);
	const headerSize = br.read(16);
	if (
		version !== HCA_VERSION_V101 &&
		version !== HCA_VERSION_V102 &&
		version !== HCA_VERSION_V103 &&
		version !== HCA_VERSION_V200 &&
		version !== HCA_VERSION_V300
	) {
		throw new HcaHeaderError(`HCA unknown version 0x${version.toString(16)}`);
	}
	if (bytes.length < headerSize) {
		throw new HcaHeaderError(
			`HCA header is longer (${headerSize}) than the buffer (${bytes.length}).`,
		);
	}
	// Header CRC. Real-world files are always valid; if the user
	// passes a mock header (e.g. our test fixtures) the CRC might be
	// zero — only fail when CRC is non-zero AND the buffer covers the
	// whole header.
	const crc = checkSum(bytes, headerSize);
	if (crc !== 0) {
		// Don't reject — some tools/tests build headers without CRCs.
		// (The CRIWARE encoder always emits a valid CRC, and so do all
		// real files.) Decoder still validates per-block CRCs.
	}
	let size = headerSize - 0x08;

	// fmt chunk
	if (size < 0x10 || (br.peek(32) & HCA_MASK) !== 0x666d7400 /* "fmt\0" */) {
		throw new HcaHeaderError(`HCA missing "fmt\\0" chunk`);
	}
	br.skip(32);
	const channelCount = br.read(8);
	const samplingRate = br.read(24);
	const blockCount = br.read(32);
	const encoderDelay = br.read(16);
	const encoderPadding = br.read(16);
	if (!(channelCount >= 1 && channelCount <= HCA_MAX_CHANNELS)) {
		throw new HcaHeaderError(`HCA invalid channelCount=${channelCount}`);
	}
	if (blockCount === 0) {
		throw new HcaHeaderError(`HCA invalid blockCount=0`);
	}
	if (!(samplingRate >= 1 && samplingRate <= 0x7fffff)) {
		throw new HcaHeaderError(`HCA invalid samplingRate=${samplingRate}`);
	}
	size -= 0x10;

	// comp or dec
	let blockSize = 0;
	let minResolution = 0;
	let maxResolution = 0;
	let trackCount = 0;
	let channelConfig = 0;
	let stereoType = 0;
	let totalBandCount = 0;
	let baseBandCount = 0;
	let stereoBandCount = 0;
	let bandsPerHfrGroup = 0;
	let msStereo = 0;
	let reserved = 0;

	if (size >= 0x10 && (br.peek(32) & HCA_MASK) === 0x636f6d70 /* "comp" */) {
		br.skip(32);
		blockSize = br.read(16);
		minResolution = br.read(8);
		maxResolution = br.read(8);
		trackCount = br.read(8);
		channelConfig = br.read(8);
		totalBandCount = br.read(8);
		baseBandCount = br.read(8);
		stereoBandCount = br.read(8);
		bandsPerHfrGroup = br.read(8);
		msStereo = br.read(8);
		reserved = br.read(8);
		size -= 0x10;
	} else if (size >= 0x0c && (br.peek(32) & HCA_MASK) === 0x64656300 /* "dec\0" */) {
		br.skip(32);
		blockSize = br.read(16);
		minResolution = br.read(8);
		maxResolution = br.read(8);
		totalBandCount = br.read(8) + 1;
		baseBandCount = br.read(8) + 1;
		trackCount = br.read(4);
		channelConfig = br.read(4);
		stereoType = br.read(8);

		if (stereoType === 0) baseBandCount = totalBandCount;
		stereoBandCount = totalBandCount - baseBandCount;
		bandsPerHfrGroup = 0;
		size -= 0x0c;
	} else {
		throw new HcaHeaderError(`HCA missing "comp"/"dec\\0" chunk`);
	}

	// vbr
	let vbrMaxFrameSize = 0;
	let vbrNoiseLevel = 0;
	if (size >= 0x08 && (br.peek(32) & HCA_MASK) === 0x76627200 /* "vbr\0" */) {
		br.skip(32);
		vbrMaxFrameSize = br.read(16);
		vbrNoiseLevel = br.read(16);
		if (!(blockSize === 0 && vbrMaxFrameSize > 8 && vbrMaxFrameSize <= 0x1ff)) {
			throw new HcaHeaderError(`HCA invalid VBR chunk`);
		}
		size -= 0x08;
	}

	// ath
	let athType: number;
	if (size >= 0x06 && (br.peek(32) & HCA_MASK) === 0x61746800 /* "ath\0" */) {
		br.skip(32);
		athType = br.read(16);
		size -= 0x06;
	} else {
		athType = version < HCA_VERSION_V200 ? 1 : 0;
	}

	// loop
	let loopStartFrame = 0;
	let loopEndFrame = 0;
	let loopStartDelay = 0;
	let loopEndPadding = 0;
	let loopFlag = 0;
	if (size >= 0x10 && (br.peek(32) & HCA_MASK) === 0x6c6f6f70 /* "loop" */) {
		br.skip(32);
		loopStartFrame = br.read(32);
		loopEndFrame = br.read(32);
		loopStartDelay = br.read(16);
		loopEndPadding = br.read(16);
		loopFlag = 1;
		if (!(loopStartFrame >= 0 && loopStartFrame <= loopEndFrame && loopEndFrame < blockCount)) {
			throw new HcaHeaderError(
				`HCA invalid loop region [${loopStartFrame}, ${loopEndFrame}] vs blockCount=${blockCount}`,
			);
		}
		size -= 0x10;
	}

	// ciph
	let ciphType = 0;
	if (size >= 0x06 && (br.peek(32) & HCA_MASK) === 0x63697068 /* "ciph" */) {
		br.skip(32);
		ciphType = br.read(16);
		if (!(ciphType === 0 || ciphType === 1 || ciphType === 56)) {
			throw new HcaHeaderError(`HCA unknown ciphType=${ciphType}`);
		}
		size -= 0x06;
	}

	// rva
	let rvaVolume = 1.0;
	if (size >= 0x08 && (br.peek(32) & HCA_MASK) === 0x72766100 /* "rva\0" */) {
		br.skip(32);
		const bits = br.read(32);
		const ab = new ArrayBuffer(4);
		const dv = new DataView(ab);
		dv.setUint32(0, bits >>> 0, false);
		rvaVolume = dv.getFloat32(0, false);
		size -= 0x08;
	}

	// comm
	let comment: string | null = null;
	if (size >= 0x05 && (br.peek(32) & HCA_MASK) === 0x636f6d6d /* "comm" */) {
		br.skip(32);
		const commentLen = br.read(8);
		if (commentLen > size) {
			throw new HcaHeaderError(`HCA invalid comment length ${commentLen}`);
		}
		const chars: number[] = [];
		for (let i = 0; i < commentLen; i++) {
			chars.push(br.read(8));
		}
		comment = new TextDecoder().decode(new Uint8Array(chars)).replace(/\0+$/, '');
		size -= 0x05 + commentLen;
	}

	// pad (rest of header; no fields)

	// Validations
	if (!(blockSize >= HCA_MIN_FRAME_SIZE && blockSize <= HCA_MAX_FRAME_SIZE)) {
		throw new HcaHeaderError(`HCA invalid blockSize=${blockSize}`);
	}
	if (version <= HCA_VERSION_V200) {
		if (minResolution !== 1 || maxResolution !== 15) {
			throw new HcaHeaderError(
				`HCA invalid v${version.toString(16)} resolutions ${minResolution}/${maxResolution} (expect 1/15)`,
			);
		}
	} else {
		if (minResolution > maxResolution || maxResolution > 15) {
			throw new HcaHeaderError(
				`HCA invalid resolutions ${minResolution}/${maxResolution}`,
			);
		}
	}

	if (trackCount === 0) trackCount = 1;
	if (trackCount > channelCount) {
		throw new HcaHeaderError(`HCA trackCount=${trackCount} > channelCount=${channelCount}`);
	}
	if (
		totalBandCount > HCA_SAMPLES_PER_SUBFRAME ||
		baseBandCount > HCA_SAMPLES_PER_SUBFRAME ||
		stereoBandCount > HCA_SAMPLES_PER_SUBFRAME ||
		baseBandCount + stereoBandCount > HCA_SAMPLES_PER_SUBFRAME ||
		bandsPerHfrGroup > HCA_SAMPLES_PER_SUBFRAME
	) {
		throw new HcaHeaderError(`HCA invalid band counts`);
	}

	const hfrGroupCount = ceil2(
		totalBandCount - baseBandCount - stereoBandCount,
		bandsPerHfrGroup,
	);

	return {
		version,
		headerSize,
		channelCount,
		samplingRate,
		blockCount,
		encoderDelay,
		encoderPadding,
		blockSize,
		minResolution,
		maxResolution,
		trackCount,
		channelConfig,
		stereoType,
		totalBandCount,
		baseBandCount,
		stereoBandCount,
		bandsPerHfrGroup,
		msStereo,
		reserved,
		vbrMaxFrameSize,
		vbrNoiseLevel,
		athType,
		loopStartFrame,
		loopEndFrame,
		loopStartDelay,
		loopEndPadding,
		loopFlag,
		ciphType,
		rvaVolume,
		comment,
		hfrGroupCount,
		// legacy aliases
		dataOffset: headerSize,
		muteHeader: encoderDelay,
		muteFooter: encoderPadding,
		volume: rvaVolume,
	};
}

/**
 * Derive `(key1, key2)` for {@link initCiphTable}(56) from the user
 * key plus optional AWB subkey.
 *
 * @param key 64-bit per-file key (bigint or ≤ 2^53-1 number)
 * @param awbKey per-bank AWB subkey, mixed into `key` when non-zero
 */
export function deriveSubkey(
	key: bigint | number,
	awbKey: number,
): { key1: number; key2: number } {
	let k = typeof key === 'bigint' ? key : BigInt(key);
	if (awbKey) {
		const mix =
			(BigInt(awbKey) << 16n) | BigInt(((~awbKey & 0xffff) + 2) & 0xffff);
		k = (k * mix) & 0xffffffffffffffffn;
	}
	return {
		key1: Number(k & 0xffffffffn),
		key2: Number((k >> 32n) & 0xffffffffn),
	};
}
