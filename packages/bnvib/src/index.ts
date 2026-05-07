/**
 * BNVIB — Switch HD Rumble vibration patterns.
 *
 * BNVIB is Nintendo's binary haptic format. Shipped first-party
 * games (Mario Kart 8 Deluxe, Splatoon, etc.) drop one file per
 * named rumble cue under `/Common/Controller/Vibration/`. The
 * format has *no magic string* — the first byte is the
 * vibration type, which doubles as a discriminator:
 *
 *   - 0x04 = Normal (one-shot)
 *   - 0x0C = Loop
 *   - 0x10 = Loop + Wait (silence between iterations)
 *
 * Wire layout (little-endian, samples big-endian — yes, really):
 *
 *   0x00  u32       vibration_type (0x04 / 0x0C / 0x10)
 *   0x04  u8        format magic (always 0x03)
 *   0x05  u8        reserved
 *   0x06  u16       sample_rate (Hz; 200 in retail content)
 *   ----------------------------------------------------------------
 *   Type 0x04 (Normal):
 *   0x08  u32       vib_size (bytes of sample data)
 *   0x0C  ...       sample data (vib_size / 4 samples)
 *   ----------------------------------------------------------------
 *   Type 0x0C (Loop):
 *   0x08  u32       loop_start (sample index)
 *   0x0C  u32       loop_end   (sample index)
 *   0x10  u32       vib_size
 *   0x14  ...       sample data
 *   ----------------------------------------------------------------
 *   Type 0x10 (Loop + Wait):
 *   0x08  u32       loop_start
 *   0x0C  u32       loop_end
 *   0x10  u32       loop_wait (samples of silence between iterations)
 *   0x14  u32       vib_size
 *   0x18  ...       sample data
 *
 * Each sample is **4 bytes**: two big-endian u16 words, one for
 * the low-frequency band and one for the high-frequency band.
 * Each word packs an amplitude (top 7 bits, 0..127) and a
 * frequency code (bottom 9 bits, 0..511). The frequency codes are
 * Nintendo's HD-rumble table — for visualisation purposes the amp
 * channel is what matters.
 *
 * References (read line-by-line):
 *   - https://switchbrew.org/wiki/BNVIB
 *   - librempeg's `bnvib{dec,enc}.c`
 *   - Moddimation/bnvib2yml
 *   - MrCheeze/dread-tools `bnvib_analysis.py`
 */

/** Vibration type discriminator at file offset 0x00. */
export enum BnvibType {
	Normal = 0x04,
	Loop = 0x0c,
	LoopAndWait = 0x10,
}

const HEADER_PREAMBLE = 0x08; // magic-ish bytes + sample_rate

export interface BnvibSample {
	/** Low-band amplitude, normalised to 0..1. */
	ampLow: number;
	/** Low-band raw frequency code (0..511). */
	freqLow: number;
	/** High-band amplitude, normalised to 0..1. */
	ampHigh: number;
	/** High-band raw frequency code (0..511). */
	freqHigh: number;
}

export interface ParsedBnvib {
	type: BnvibType;
	typeName: string;
	/** Always 0x03 in shipped files. */
	formatMagic: number;
	/** Sample rate in Hz. Always 200 in retail content. */
	sampleRate: number;
	/** Bytes of raw sample data declared by the header. */
	vibSize: number;
	/** Total number of vibration samples (vib_size / 4). */
	sampleCount: number;
	/** Duration in seconds, derived from `sampleCount / sampleRate`. */
	durationSeconds: number;
	/** Loop start sample index, or `null` for type 0x04. */
	loopStart: number | null;
	/** Loop end sample index, or `null` for type 0x04. */
	loopEnd: number | null;
	/** Wait period (in samples) between loop iterations, or `null` unless type 0x10. */
	loopWait: number | null;
	/** Decoded samples, each with both bands' amp/freq fields. */
	samples: BnvibSample[];
}

/**
 * Quick check: a BNVIB file starts with one of the three known
 * type IDs at offset 0, magic byte 0x03 at offset 4, and a non-zero
 * `sample_rate` at offset 6. We use that triple as a sniff because
 * the format has no string magic to look for.
 */
export async function isBnvib(blob: Blob): Promise<boolean> {
	if (blob.size < HEADER_PREAMBLE) return false;
	const head = new Uint8Array(await blob.slice(0, HEADER_PREAMBLE).arrayBuffer());
	const type = head[0];
	if (type !== 0x04 && type !== 0x0c && type !== 0x10) return false;
	if (head[1] !== 0 || head[2] !== 0 || head[3] !== 0) return false;
	if (head[4] !== 0x03) return false;
	if (head[5] !== 0) return false;
	const rate = head[6] | (head[7] << 8);
	if (rate === 0) return false;
	return true;
}

/**
 * Parse a BNVIB file into a structured view including every
 * vibration sample. Sample data is decoded eagerly — typical
 * rumble cues are well under 100 KB.
 */
export async function parseBnvib(blob: Blob): Promise<ParsedBnvib> {
	if (blob.size < HEADER_PREAMBLE + 4) {
		throw new Error(
			`Blob too small to be a BNVIB (${blob.size} bytes, need at least ${HEADER_PREAMBLE + 4})`,
		);
	}
	const all = new Uint8Array(await blob.arrayBuffer());
	const v = new DataView(all.buffer, all.byteOffset, all.byteLength);
	const type = v.getUint32(0x00, true);
	if (type !== BnvibType.Normal && type !== BnvibType.Loop && type !== BnvibType.LoopAndWait) {
		throw new Error(`Unsupported BNVIB type: 0x${type.toString(16)}`);
	}
	const formatMagic = v.getUint8(0x04);
	if (formatMagic !== 0x03) {
		throw new Error(`Unsupported BNVIB format magic: 0x${formatMagic.toString(16)}`);
	}
	const sampleRate = v.getUint16(0x06, true);
	if (sampleRate === 0) {
		throw new Error('BNVIB sample rate is zero');
	}

	let cursor = HEADER_PREAMBLE;
	let loopStart: number | null = null;
	let loopEnd: number | null = null;
	let loopWait: number | null = null;
	if (type === BnvibType.Loop || type === BnvibType.LoopAndWait) {
		loopStart = v.getUint32(cursor, true);
		cursor += 4;
		loopEnd = v.getUint32(cursor, true);
		cursor += 4;
	}
	if (type === BnvibType.LoopAndWait) {
		loopWait = v.getUint32(cursor, true);
		cursor += 4;
	}
	const vibSize = v.getUint32(cursor, true);
	cursor += 4;
	if (vibSize % 4 !== 0) {
		throw new Error(`BNVIB vib_size (${vibSize}) is not a multiple of 4`);
	}
	if (cursor + vibSize > all.length) {
		throw new Error(
			`BNVIB sample data (${vibSize} bytes from 0x${cursor.toString(16)}) overruns blob (${all.length})`,
		);
	}

	const sampleCount = vibSize >>> 2;
	const samples: BnvibSample[] = new Array(sampleCount);
	for (let i = 0; i < sampleCount; i++) {
		// Each sample: low-band u16 BE, then high-band u16 BE.
		const lo = (all[cursor + i * 4] << 8) | all[cursor + i * 4 + 1];
		const hi = (all[cursor + i * 4 + 2] << 8) | all[cursor + i * 4 + 3];
		samples[i] = {
			ampLow: ((lo >> 9) & 0x7f) / 127,
			freqLow: lo & 0x1ff,
			ampHigh: ((hi >> 9) & 0x7f) / 127,
			freqHigh: hi & 0x1ff,
		};
	}

	return {
		type,
		typeName: typeName(type),
		formatMagic,
		sampleRate,
		vibSize,
		sampleCount,
		durationSeconds: sampleCount / sampleRate,
		loopStart,
		loopEnd,
		loopWait,
		samples,
	};
}

/**
 * Map a BNVIB frequency code (0..511) to its real-world Hz value.
 * The mapping follows Nintendo's HD-rumble frequency table — for
 * the high band, code 0x100 ≈ 320 Hz; for the low band, the same
 * code is one octave down (160 Hz). This is the same approximation
 * dekuNukem's Joy-Con reverse-engineering notes use, accurate to
 * within a percent or two over the typical playback range.
 *
 * If `band === 'low'` the returned frequency is halved relative to
 * the high band's code → Hz mapping.
 */
export function freqCodeToHz(code: number, band: 'low' | 'high'): number {
	// The encoded high-band frequency is approximately:
	//   f = 320 * 2^((code - 0x100) / 96)
	// So code 0x100 → 320 Hz, code 0x100+96 → 640 Hz, etc.
	const baseHz = 320 * Math.pow(2, (code - 0x100) / 96);
	return band === 'low' ? baseHz / 2 : baseHz;
}

/**
 * Render a parsed BNVIB to a stereo PCM16 audio waveform that you
 * can wrap in a WAV blob and feed to `<audio>`. This is for
 * preview/playback only — it's an audible analogue of the rumble,
 * not a faithful tactile reproduction.
 *
 * Each channel is built by stepping through the BNVIB samples at
 * the file's `sample_rate` (200 Hz), holding amp + freq for the
 * sample's duration, and synthesising a band-limited sine at that
 * frequency. The two RGB channels carry the low / high bands so
 * stereo headphones approximate the dual-band feel.
 *
 * `outputSampleRate` defaults to 48 kHz — fine for browser audio.
 */
export function renderBnvibToPcm16(
	parsed: ParsedBnvib,
	outputSampleRate: number = 48000,
): { samples: Int16Array; numChannels: number; sampleRate: number } {
	if (parsed.sampleCount === 0) {
		return { samples: new Int16Array(0), numChannels: 2, sampleRate: outputSampleRate };
	}
	const upsample = outputSampleRate / parsed.sampleRate;
	if (!isFinite(upsample) || upsample < 1) {
		throw new Error(
			`outputSampleRate (${outputSampleRate}) must be ≥ source sample_rate (${parsed.sampleRate})`,
		);
	}
	const totalFrames = Math.round(parsed.sampleCount * upsample);
	const out = new Int16Array(totalFrames * 2);
	let phaseLo = 0;
	let phaseHi = 0;
	for (let f = 0; f < totalFrames; f++) {
		const srcIdx = (f / upsample) | 0;
		const s =
			parsed.samples[srcIdx >= parsed.sampleCount ? parsed.sampleCount - 1 : srcIdx];
		const fLo = freqCodeToHz(s.freqLow, 'low');
		const fHi = freqCodeToHz(s.freqHigh, 'high');
		// Sine generators with continuous phase to avoid clicks at
		// sample boundaries. Output amplitude scaled to 0.5 to leave
		// headroom for the two-band sum if we ever go mono.
		phaseLo += (2 * Math.PI * fLo) / outputSampleRate;
		phaseHi += (2 * Math.PI * fHi) / outputSampleRate;
		// Normalise phases so they don't grow unboundedly (loses
		// precision on long files); take mod 2π every ~1 K samples.
		if ((f & 0x3ff) === 0) {
			phaseLo = phaseLo % (2 * Math.PI);
			phaseHi = phaseHi % (2 * Math.PI);
		}
		const lo = Math.sin(phaseLo) * s.ampLow * 0.5;
		const hi = Math.sin(phaseHi) * s.ampHigh * 0.5;
		out[f * 2 + 0] = clamp16(lo * 32767);
		out[f * 2 + 1] = clamp16(hi * 32767);
	}
	return { samples: out, numChannels: 2, sampleRate: outputSampleRate };
}

function clamp16(x: number): number {
	x = x | 0;
	if (x > 32767) return 32767;
	if (x < -32768) return -32768;
	return x;
}

function typeName(type: number): string {
	switch (type) {
		case BnvibType.Normal:
			return 'Normal';
		case BnvibType.Loop:
			return 'Loop';
		case BnvibType.LoopAndWait:
			return 'Loop+Wait';
		default:
			return `Unknown(0x${type.toString(16)})`;
	}
}
