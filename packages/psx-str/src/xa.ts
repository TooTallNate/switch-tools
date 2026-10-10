/**
 * CD-XA ADPCM audio (PlayStation "XA" streams).
 *
 * XA audio lives in Mode 2 Form 2 sectors whose subheader submode has
 * the audio bit (0x04). Several streams are usually interleaved in one
 * file, told apart by the subheader's file and channel numbers. Each
 * sector holds 18 sound groups of 128 bytes; in 4-bit mode a group is
 * 8 sound units of 28 samples (alternating left / right for stereo).
 * The subheader's coding byte gives stereo (bit 0), 18 900 Hz instead
 * of 37 800 Hz (bit 2) and 8-bit samples (bit 4).
 *
 * Decoding follows FFmpeg's `adpcm_xa` (libavcodec/adpcm.c).
 */

export const RAW_SECTOR_SIZE = 2352;

const SUBMODE_VIDEO = 0x02;
const SUBMODE_AUDIO = 0x04;
const SUBMODE_DATA = 0x08;

const FILTERS: [number, number][] = [
	[0, 0],
	[60, 0],
	[115, -52],
	[98, -55],
	[122, -60],
];

export interface XaStream {
	/** Subheader file number. */
	file: number;
	/** Subheader channel number. */
	channel: number;
	channels: 1 | 2;
	sampleRate: number;
	bitsPerSample: 4 | 8;
	/** Audio sectors in the stream. */
	sectors: number;
	/** Decoded sample frames (per channel). */
	sampleFrames: number;
}

/** True when a raw sector's subheader marks it as XA audio. */
export function isXaAudioSector(sector: Uint8Array): boolean {
	return sector.length >= 24 && (sector[18] & SUBMODE_AUDIO) !== 0 && (sector[18] & (SUBMODE_VIDEO | SUBMODE_DATA)) === 0;
}

function samplesPerSector(channels: number, bits: number): number {
	// 18 groups × 8 units × 28 samples (4-bit) or 18 × 4 × 28 (8-bit).
	return ((18 * (bits === 4 ? 224 : 112)) / channels) | 0;
}

/** List the XA audio streams in a run of raw 2352-byte sectors. */
export function scanXaStreams(raw: Uint8Array): XaStream[] {
	const streams = new Map<number, XaStream>();
	for (let o = 0; o + RAW_SECTOR_SIZE <= raw.length; o += RAW_SECTOR_SIZE) {
		const s = raw.subarray(o, o + RAW_SECTOR_SIZE);
		if (!isXaAudioSector(s)) continue;
		const key = (s[16] << 8) | s[17];
		let st = streams.get(key);
		if (!st) {
			const coding = s[19];
			const channels = (coding & 1 ? 2 : 1) as 1 | 2;
			const bitsPerSample = (coding & 0x10 ? 8 : 4) as 4 | 8;
			st = {
				file: s[16],
				channel: s[17],
				channels,
				sampleRate: coding & 4 ? 18900 : 37800,
				bitsPerSample,
				sectors: 0,
				sampleFrames: 0,
			};
			streams.set(key, st);
		}
		st.sectors++;
		st.sampleFrames += samplesPerSector(st.channels, st.bitsPerSample);
	}
	return [...streams.values()].sort((a, b) => a.file - b.file || a.channel - b.channel);
}

/** Running decoder state for one XA stream (prediction history per channel). */
export class XaDecoder {
	private s1 = [0, 0];
	private s2 = [0, 0];
	constructor(readonly channels: 1 | 2, readonly bitsPerSample: 4 | 8 = 4) {}

	/**
	 * Decode the 2304-byte payload of one audio sector (starting at
	 * raw sector offset 24). Returns interleaved 16-bit samples.
	 */
	decodeSector(data: Uint8Array): Int16Array {
		const stereo = this.channels === 2;
		const units = this.bitsPerSample === 4 ? 8 : 4;
		const perGroup = units * 28;
		const out = new Int16Array(18 * perGroup);
		let o = 0;
		for (let g = 0; g < 18; g++) {
			const group = data.subarray(g * 128, g * 128 + 128);
			if (group.length < 128) break;
			for (let u = 0; u < units; u++) {
				const ch = stereo ? u & 1 : 0;
				const header = group[4 + u];
				const shift = Math.max(0, (this.bitsPerSample === 4 ? 12 : 8) - (header & 15));
				const filter = Math.min(header >> 4, 4);
				const [f0, f1] = FILTERS[filter];
				let s1 = this.s1[ch];
				let s2 = this.s2[ch];
				for (let j = 0; j < 28; j++) {
					let t: number;
					if (this.bitsPerSample === 4) {
						const byte = group[16 + (u >> 1) + j * 4];
						const nib = u & 1 ? byte >> 4 : byte & 15;
						t = (nib << 28) >> 28;
					} else {
						t = (group[16 + u + j * 4] << 24) >> 24;
					}
					let s = t * (1 << shift) + ((s1 * f0 + s2 * f1 + 32) >> 6);
					if (s > 32767) s = 32767;
					else if (s < -32768) s = -32768;
					s2 = s1;
					s1 = s;
					if (stereo) {
						// Units alternate L/R: unit u covers samples (u >> 1) * 28 + j.
						out[o + (((u >> 1) * 28 + j) << 1) + ch] = s;
					} else {
						out[o + u * 28 + j] = s;
					}
				}
				this.s1[ch] = s1;
				this.s2[ch] = s2;
			}
			o += perGroup;
		}
		return out;
	}
}

/** Decode one stream of a raw sector run to interleaved PCM. */
export function decodeXaStream(raw: Uint8Array, file: number, channel: number): { samples: Int16Array; channels: 1 | 2; sampleRate: number } {
	const info = scanXaStreams(raw).find((s) => s.file === file && s.channel === channel);
	if (!info) throw new Error(`No XA audio for file ${file} channel ${channel}`);
	const dec = new XaDecoder(info.channels, info.bitsPerSample);
	const perSector = samplesPerSector(info.channels, info.bitsPerSample) * info.channels;
	const samples = new Int16Array(info.sectors * perSector);
	let pos = 0;
	for (let o = 0; o + RAW_SECTOR_SIZE <= raw.length; o += RAW_SECTOR_SIZE) {
		const s = raw.subarray(o, o + RAW_SECTOR_SIZE);
		if (!isXaAudioSector(s) || s[16] !== file || s[17] !== channel) continue;
		samples.set(dec.decodeSector(s.subarray(24, 24 + 2304)), pos);
		pos += perSector;
	}
	return { samples, channels: info.channels, sampleRate: info.sampleRate };
}

/** Wrap interleaved PCM16 in a RIFF/WAVE container. */
export function pcm16ToWav(samples: Int16Array, channels: number, sampleRate: number): Uint8Array {
	const dataSize = samples.length * 2;
	const out = new Uint8Array(44 + dataSize);
	const dv = new DataView(out.buffer);
	const ascii = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
	};
	ascii(0, 'RIFF');
	dv.setUint32(4, 36 + dataSize, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, channels, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * channels * 2, true);
	dv.setUint16(32, channels * 2, true);
	dv.setUint16(34, 16, true);
	ascii(36, 'data');
	dv.setUint32(40, dataSize, true);
	for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
	return out;
}
