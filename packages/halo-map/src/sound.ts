import { readReflexive, type HaloMap, type HaloTag } from './index.js';

/** `SoundFormat`. */
export const SOUND_FORMATS = [
	'pcm16',
	'xbox-adpcm',
	'ima-adpcm',
	'ogg-vorbis',
] as const;

/** `SoundClass` value for music tracks. */
export const SOUND_CLASS_MUSIC = 32;

/** A contiguous run of encoded samples in the map. */
export interface SoundPiece {
	offset: number;
	size: number;
}

/**
 * One playable permutation of a sound. Long sounds are split into a
 * chain of permutations (`next permutation index`); `pieces` holds
 * the whole chain in playback order.
 */
export interface HaloSoundClip {
	/** Pitch range name / permutation name. */
	name: string;
	pitchRange: number;
	permutation: number;
	format: (typeof SOUND_FORMATS)[number] | 'unknown';
	pieces: SoundPiece[];
	/** True when the samples live in sounds.map (PC). */
	external: boolean;
}

export interface HaloSound {
	soundClass: number;
	sampleRate: number;
	channels: number;
	format: (typeof SOUND_FORMATS)[number] | 'unknown';
	clips: HaloSoundClip[];
}

function cString(bytes: Uint8Array, start: number, max: number): string {
	let s = '';
	for (let i = start; i < start + max && bytes[i]; i++) {
		s += String.fromCharCode(bytes[i]);
	}
	return s;
}

/**
 * Parse a `snd!` tag. Offsets are from Xbox maps, which have 4 bytes
 * more padding before `zero skip fraction modifier` than Invader's
 * HEK definition suggests.
 */
export function parseSoundTag(map: HaloMap, tag: HaloTag): HaloSound | null {
	if (tag.tagClass !== 'snd!' || tag.dataOffset < 0) return null;
	const v = map.view;
	const o = tag.dataOffset;
	const soundClass = v.getUint16(o + 0x04, true);
	const sampleRate = v.getUint16(o + 0x06, true) === 1 ? 44100 : 22050;
	const channels = v.getUint16(o + 0x6c, true) === 1 ? 2 : 1;
	const format = SOUND_FORMATS[v.getUint16(o + 0x6e, true)] ?? 'unknown';
	const clips: HaloSoundClip[] = [];
	const ranges = readReflexive(map, o + 0x98);
	for (let r = 0; r < ranges.count; r++) {
		const ro = ranges.offset + r * 72;
		const rangeName = cString(map.bytes, ro, 32);
		const actual = v.getUint16(ro + 0x2c, true);
		const perms = readReflexive(map, ro + 0x3c);
		const permOffset = (i: number) => perms.offset + i * 124;
		const starts = Math.min(actual || perms.count, perms.count);
		for (let p = 0; p < starts; p++) {
			const pieces: SoundPiece[] = [];
			let external = false;
			let permFormat: HaloSoundClip['format'] = format;
			const seen = new Set<number>();
			let i = p;
			while (i >= 0 && i < perms.count && !seen.has(i)) {
				seen.add(i);
				const po = permOffset(i);
				permFormat = SOUND_FORMATS[v.getUint16(po + 0x28, true)] ?? 'unknown';
				const size = v.getUint32(po + 0x40, true);
				const flags = v.getUint32(po + 0x44, true);
				const offset = v.getUint32(po + 0x48, true);
				if (flags & 1) external = true;
				if (size) pieces.push({ offset, size });
				const next = v.getUint16(po + 0x2a, true);
				i = next === 0xffff ? -1 : next;
			}
			const permName = cString(map.bytes, permOffset(p), 32);
			clips.push({
				name: [rangeName, permName].filter(Boolean).join(' / '),
				pitchRange: r,
				permutation: p,
				format: permFormat,
				pieces,
				external,
			});
		}
	}
	return { soundClass, sampleRate, channels, format, clips };
}

const IMA_STEPS = [
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41,
	45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
	209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
	876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
	2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
	8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
	22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

/**
 * Decode Xbox ADPCM (IMA ADPCM with fixed 36-byte blocks per channel,
 * 65 samples per block) to interleaved signed 16-bit PCM.
 */
export function decodeXboxAdpcm(data: Uint8Array, channels: number): Int16Array {
	const blockSize = 36 * channels;
	const blocks = Math.floor(data.length / blockSize);
	const out = new Int16Array(blocks * 65 * channels);
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let o = 0;
	for (let b = 0; b < blocks; b++) {
		const base = b * blockSize;
		for (let c = 0; c < channels; c++) {
			let sample = dv.getInt16(base + c * 4, true);
			let index = Math.min(88, data[base + c * 4 + 2]);
			const dst = o + c;
			out[dst] = sample;
			let n = 1;
			// After the headers, each channel contributes 4 bytes (8 nibbles) per round.
			for (let round = 0; round < 8; round++) {
				const wordStart = base + 4 * channels + (round * channels + c) * 4;
				for (let k = 0; k < 8; k++) {
					const byte = data[wordStart + (k >> 1)];
					const nib = k & 1 ? byte >> 4 : byte & 0xf;
					const step = IMA_STEPS[index];
					let diff = step >> 3;
					if (nib & 1) diff += step >> 2;
					if (nib & 2) diff += step >> 1;
					if (nib & 4) diff += step;
					sample += nib & 8 ? -diff : diff;
					if (sample > 32767) sample = 32767;
					else if (sample < -32768) sample = -32768;
					index += IMA_INDEX[nib & 7];
					if (index < 0) index = 0;
					else if (index > 88) index = 88;
					out[dst + n * channels] = sample;
					n++;
				}
			}
		}
		o += 65 * channels;
	}
	return out;
}

/** Wrap interleaved PCM16 in a RIFF/WAVE container. */
export function pcm16ToWav(
	pcm: Int16Array,
	channels: number,
	sampleRate: number,
): Uint8Array {
	const dataSize = pcm.length * 2;
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
	for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
	return out;
}

/**
 * Decode a sound clip to a WAV file. Supports Xbox ADPCM and 16-bit
 * PCM; throws for Ogg Vorbis (PC) and external samples.
 */
export function decodeSoundClip(
	map: HaloMap,
	sound: HaloSound,
	clip: HaloSoundClip,
): Uint8Array {
	if (clip.external) throw new Error('Sound samples are stored in sounds.map');
	const total = clip.pieces.reduce((n, p) => n + p.size, 0);
	const raw = new Uint8Array(total);
	let pos = 0;
	for (const p of clip.pieces) {
		if (p.offset + p.size > map.bytes.length) {
			throw new Error('Sound samples are outside the map');
		}
		raw.set(map.bytes.subarray(p.offset, p.offset + p.size), pos);
		pos += p.size;
	}
	if (clip.format === 'xbox-adpcm' || clip.format === 'ima-adpcm') {
		return pcm16ToWav(
			decodeXboxAdpcm(raw, sound.channels),
			sound.channels,
			sound.sampleRate,
		);
	}
	if (clip.format === 'pcm16') {
		// Halo stores PCM big-endian.
		const pcm = new Int16Array(raw.length >> 1);
		const dv = new DataView(raw.buffer);
		for (let i = 0; i < pcm.length; i++) pcm[i] = dv.getInt16(i * 2, false);
		return pcm16ToWav(pcm, sound.channels, sound.sampleRate);
	}
	throw new Error(`Unsupported sound format ${clip.format}`);
}
