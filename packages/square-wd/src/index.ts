/**
 * Square `.WD` wave-bank parser.
 *
 * `.WD` files ship sound effects and voice samples for early
 * Square PlayStation / GameCube titles:
 *
 *   - Final Fantasy XI (PS2, little-endian, PS-ADPCM)
 *   - Final Fantasy X (HD Remaster, PS2/PSP/Vita lineage,
 *     little-endian, PS-ADPCM) — also the Switch port we care
 *     about, since the asset pipeline was kept intact
 *   - Final Fantasy X-2 (PS2/Vita, little-endian, PS-ADPCM)
 *   - Final Fantasy: Crystal Chronicles (GameCube,
 *     big-endian, DSP-ADPCM)
 *
 * The bank is a flat list of `instruments` (musical mappings)
 * and `waves` (raw audio samples). We only care about the
 * `waves` side — each entry has a stream offset into the data
 * section, a key encoding the sample rate as 8.24 fixed-point,
 * and (LE only) a loop-start position. The bytes after the
 * entry table are mono ADPCM frames; PS-ADPCM is 16 bytes per
 * 28 samples, DSP-ADPCM is 8 bytes per 14 samples.
 *
 * # Layout
 *
 *   0x00  magic 'WD\0\0'                              (4 bytes)
 *   0x04  data_size                                   (u32 LE/BE)
 *   0x08  instrument count                            (s32 LE/BE)
 *   0x0C  wave count                                  (s32 LE/BE)
 *   0x10  reserved (zero)                             (16 bytes)
 *   0x20  waves_offset (pointer to wave table)        (u32 LE/BE)
 *   ...   instrument table (per-format, we skip)
 *   waves_offset:
 *         wave entries × wave count
 *           LE entry size = 0x20:
 *             0x00 flags
 *             0x04 stream_offset within data
 *             0x08 loop_start (in bytes)
 *             0x10 key (s32, 8.24 fixed-point sample-rate delta)
 *             rest: ADSR + velocity + pan + unused
 *           BE entry size = 0x60:
 *             0x04 stream_offset
 *             0x10 stream_size
 *             0x14 key (s32)
 *             0x22 DSP coefficient table (32 bytes) + history
 *   waves_offset + waves * entry_size:
 *         raw ADPCM data
 *
 * # Endianness sniffing
 *
 * The magic is `WD\0\0`, which reads `0x57440000` regardless of
 * endianness — useless for sniffing. vgmstream sniffs the
 * `wave count` field at offset 0x0c: whichever endian produces
 * the smaller positive value (and matches the file structure) wins.
 *
 * # References
 *   - https://github.com/vgmstream/vgmstream/blob/master/src/meta/wd.c
 *   - https://github.com/BlackFurniture/ffcc/blob/master/ffcc/audio.py
 *   - https://github.com/vgmtrans/vgmtrans/blob/master/src/main/formats/SquarePS2/WD.cpp
 */

import {
	decodePsAdpcm,
	encodeWav as encodeWavPs,
	PS_ADPCM_FRAME_SIZE,
	psAdpcmBytesToSamples,
	squareKeyToSampleRate,
} from '@tootallnate/ps-adpcm';

/** Magic bytes at offset 0: ASCII `WD\0\0`. */
export const WD_MAGIC = 0x57440000;

/**
 * One audio entry inside a `.WD` bank, ready to decode.
 */
export interface WdWave {
	/** 0-based index in the bank. */
	index: number;
	/** Sample rate in Hz, derived from the entry's 8.24 fixed-point key. */
	sampleRate: number;
	/** Loop start in samples (LE files only; BE waves use a different mechanism). */
	loopStart: number;
	/**
	 * Raw ADPCM bytes for this wave, sliced lazily out of the
	 * parent bank's buffer. Always whole frames — partial trailing
	 * bytes from the source are dropped.
	 *
	 * For PS-ADPCM (LE) each 16-byte frame yields 28 mono samples.
	 * For DSP-ADPCM (BE) each 8-byte frame yields 14 mono samples.
	 */
	data: Uint8Array;
	/**
	 * For BE banks only: the 16-entry DSP-ADPCM coefficient table
	 * (32 bytes, 16 × s16). Undefined for LE banks.
	 */
	dspCoefs?: Uint8Array;
}

export interface WdBank {
	/**
	 * True if the file uses big-endian byte order (GameCube
	 * variant, DSP-ADPCM payload). False for the PS2/PSP/Vita/
	 * Switch variant (PS-ADPCM payload, little-endian).
	 */
	bigEndian: boolean;
	/** Codec used for every wave in this bank. */
	codec: 'ps-adpcm' | 'dsp-adpcm';
	/** Number of "instruments" (musical mappings). We don't read them; included for completeness. */
	instrumentCount: number;
	/** Decoded wave entries. */
	waves: WdWave[];
}

export class WdParseError extends Error {
	readonly fileLength?: number;
	constructor(message: string, info?: { fileLength?: number }) {
		super(message);
		this.name = 'WdParseError';
		this.fileLength = info?.fileLength;
	}
}

/** Read a u32 with the given endianness from a DataView. */
function readU32(v: DataView, off: number, bigEndian: boolean): number {
	return v.getUint32(off, !bigEndian);
}

/** Read a signed 32-bit int with the given endianness. */
function readS32(v: DataView, off: number, bigEndian: boolean): number {
	return v.getInt32(off, !bigEndian);
}

/**
 * Sniff endianness by trying both interpretations of the
 * wave-count field and picking whichever produces a sensible
 * positive value that matches the file's layout. vgmstream uses
 * the same heuristic.
 */
function guessEndian(v: DataView): boolean {
	const fileSize = v.byteLength;
	const leWaves = v.getInt32(0x0c, true);
	const beWaves = v.getInt32(0x0c, false);
	// Both endianness candidates should be in [1, 0x200] (the
	// vgmstream sanity bound). Whichever has the smaller positive
	// magnitude is almost certainly the correct one. If only one
	// candidate is valid, that wins.
	const leValid = leWaves > 0 && leWaves <= 0x200;
	const beValid = beWaves > 0 && beWaves <= 0x200;
	if (leValid && !beValid) return false;
	if (!leValid && beValid) return true;
	if (!leValid && !beValid) {
		throw new WdParseError(
			`unable to detect endianness: wave count is ${leWaves} (LE) / ${beWaves} (BE)`,
			{ fileLength: fileSize },
		);
	}
	// Both valid: prefer LE (the common case) unless BE produces
	// a more plausible smaller value.
	return beWaves < leWaves;
}

/**
 * Parse a `.WD` wave bank from raw bytes.
 *
 * Returns a {@link WdBank} with the per-wave metadata + sliced
 * ADPCM payload for each entry. Use {@link decodeWaveToPcm} or
 * {@link decodeWaveToWav} to turn an entry's bytes into something
 * playable.
 *
 * Throws {@link WdParseError} for malformed input.
 */
export function parseWd(bytes: Uint8Array): WdBank {
	if (bytes.byteLength < 0x40) {
		throw new WdParseError(
			`file too small to be a WD bank (${bytes.byteLength} bytes; need ≥ 64)`,
			{ fileLength: bytes.byteLength },
		);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Magic check: 'WD\0\0' at offset 0. Same byte pattern either
	// endianness, so we always read it big-endian.
	const magic = v.getUint32(0x00, false);
	if ((magic & 0xffff0000) !== WD_MAGIC) {
		throw new WdParseError(
			`bad magic at offset 0: expected 'WD\\0\\0', got 0x${magic.toString(16)}`,
			{ fileLength: bytes.byteLength },
		);
	}

	const bigEndian = guessEndian(v);

	// Reserved bytes at 0x14-0x1f must be zero (vgmstream check).
	if (
		readU32(v, 0x14, false) !== 0 ||
		readU32(v, 0x18, false) !== 0 ||
		readU32(v, 0x1c, false) !== 0
	) {
		throw new WdParseError(
			'reserved bytes at offset 0x14-0x1f are non-zero; not a Square WD bank',
			{ fileLength: bytes.byteLength },
		);
	}

	const instrumentCount = readS32(v, 0x08, bigEndian);
	const waveCount = readS32(v, 0x0c, bigEndian);
	if (instrumentCount > waveCount || waveCount > 0x200) {
		throw new WdParseError(
			`implausible counts: instruments=${instrumentCount}, waves=${waveCount}`,
			{ fileLength: bytes.byteLength },
		);
	}

	const wavesOffset = readU32(v, 0x20, bigEndian);
	if (wavesOffset >= bytes.byteLength) {
		throw new WdParseError(
			`wavesOffset 0x${wavesOffset.toString(16)} is outside the file`,
			{ fileLength: bytes.byteLength },
		);
	}

	const entrySize = bigEndian ? 0x60 : 0x20;
	const tableEnd = wavesOffset + waveCount * entrySize;
	if (tableEnd > bytes.byteLength) {
		throw new WdParseError(
			`wave table extends past EOF (table ends at 0x${tableEnd.toString(16)}, file is 0x${bytes.byteLength.toString(16)})`,
			{ fileLength: bytes.byteLength },
		);
	}
	const dataOffset = tableEnd;

	// Pass 1: read all entries to capture their raw streamOffset.
	interface RawEntry {
		index: number;
		streamOffset: number;
		keyRaw: number;
		streamSize: number;
		loopStart: number;
		dspCoefs?: Uint8Array;
	}
	const raw: RawEntry[] = [];
	for (let i = 0; i < waveCount; i++) {
		const head = wavesOffset + i * entrySize;
		let streamOffset = readU32(v, head + 0x04, bigEndian);
		// vgmstream's "FFXI quirk": LE banks sometimes encode
		// `stream_offset` with the low byte holding an irrelevant
		// frame-marker. The real offset is the 256-byte-aligned
		// version. Detected by checking `% 0x10`; correction is
		// `& 0xFFFFFF00`. Observed in FFX HD on Switch as well.
		if (!bigEndian && streamOffset % 0x10) {
			streamOffset = streamOffset & 0xffffff00;
		}
		const keyRaw = readS32(v, head + (bigEndian ? 0x14 : 0x10), bigEndian);
		let streamSize = 0;
		let loopStart = 0;
		let dspCoefs: Uint8Array | undefined;
		if (bigEndian) {
			streamSize = readU32(v, head + 0x10, bigEndian);
			dspCoefs = bytes.subarray(head + 0x22, head + 0x22 + 32);
		} else {
			loopStart = readU32(v, head + 0x08, bigEndian);
		}
		raw.push({ index: i, streamOffset, keyRaw, streamSize, loopStart, dspCoefs });
	}

	// Pass 2: when streamSize is zero (PS-ADPCM has no per-entry
	// size since the codec self-terminates via flags), derive each
	// wave's size from the next-larger streamOffset.
	if (!bigEndian) {
		const sortedOffsets = raw
			.map((r) => r.streamOffset)
			.filter((o, idx, arr) => arr.indexOf(o) === idx)
			.sort((a, b) => a - b);
		const dataLen = bytes.byteLength - dataOffset;
		for (const e of raw) {
			let next = dataLen;
			for (const o of sortedOffsets) {
				if (o > e.streamOffset && o < next) next = o;
			}
			e.streamSize = next - e.streamOffset;
		}
	}

	const waves: WdWave[] = [];
	const baseSampleRate = bigEndian ? 32000 : 48000;
	for (const e of raw) {
		const start = dataOffset + e.streamOffset;
		const end = Math.min(start + e.streamSize, bytes.byteLength);
		const data = bytes.subarray(start, end);
		const sampleRate = squareKeyToSampleRate(e.keyRaw, baseSampleRate);
		waves.push({
			index: e.index,
			sampleRate,
			loopStart: e.loopStart,
			data,
			dspCoefs: e.dspCoefs,
		});
	}

	return {
		bigEndian,
		codec: bigEndian ? 'dsp-adpcm' : 'ps-adpcm',
		instrumentCount,
		waves,
	};
}

/**
 * Decode a single wave entry to s16 PCM samples (mono).
 */
export function decodeWaveToPcm(
	wave: WdWave,
	bank: Pick<WdBank, 'codec'>,
): Int16Array {
	if (bank.codec === 'ps-adpcm') {
		return decodePsAdpcm(wave.data);
	}
	// DSP-ADPCM (GameCube) — lazy-load the decoder via dynamic
	// import to avoid pulling the BE codec into PS-ADPCM-only
	// builds. The dynamic shape is gated on a known-true bool so
	// tree-shakers strip the BE branch when only LE is used.
	// (Synchronous require would force the dep at build time even
	// for callers that never see a BE file.)
	throw new WdParseError(
		'DSP-ADPCM decoding requires the async decodeWaveToPcmAsync entry point',
	);
}

/**
 * Async decoder that handles both LE (PS-ADPCM) and BE
 * (DSP-ADPCM) banks. Use this when you don't know upfront which
 * codec the bank uses.
 */
export async function decodeWaveToPcmAsync(
	wave: WdWave,
	bank: Pick<WdBank, 'codec'>,
): Promise<Int16Array> {
	if (bank.codec === 'ps-adpcm') {
		return decodePsAdpcm(wave.data);
	}
	if (!wave.dspCoefs) {
		throw new WdParseError(
			`BE wave ${wave.index} has no DSP-ADPCM coefficient table`,
		);
	}
	const { decodeChannel, makeDspState } = await import('@tootallnate/dsp-adpcm');
	// BE banks are GameCube → big-endian coef bytes.
	const state = makeDspState(wave.dspCoefs, { littleEndian: false });
	// DSP-ADPCM samples = bytes / 8 frames × 14 samples
	const samples = Math.floor(wave.data.length / 8) * 14;
	return decodeChannel(wave.data, samples, state);
}

/**
 * Decode a wave to a complete RIFF/WAV byte buffer (mono PCM16).
 * Convenient for hand-off to `<audio src=…>` / `URL.createObjectURL`.
 */
export async function decodeWaveToWav(
	wave: WdWave,
	bank: Pick<WdBank, 'codec'>,
): Promise<Uint8Array> {
	const pcm = await decodeWaveToPcmAsync(wave, bank);
	return encodeWavPs(pcm, wave.sampleRate, 1);
}

/**
 * Convenience: total PCM-sample duration of a wave in seconds.
 */
export function waveDurationSeconds(wave: WdWave, bank: Pick<WdBank, 'codec'>): number {
	const samples =
		bank.codec === 'ps-adpcm'
			? psAdpcmBytesToSamples(wave.data.byteLength)
			: Math.floor(wave.data.byteLength / 8) * 14;
	return samples / wave.sampleRate;
}

// Re-export so consumers don't need a separate dependency on
// @tootallnate/ps-adpcm just to grab frame-size constants.
export { PS_ADPCM_FRAME_SIZE, squareKeyToSampleRate };
