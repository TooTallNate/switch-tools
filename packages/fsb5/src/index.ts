/**
 * `@tootallnate/fsb5` — parser + decoder for FMOD Sample Banks
 * (FSB5 format).
 *
 * Top-level usage:
 *
 *   ```ts
 *   import { parseFsb5, decodeSampleToBlob, loadFmodVorbisSetupPackets } from '@tootallnate/fsb5';
 *
 *   const fsb5 = parseFsb5(rawBytes);
 *   for (const sample of fsb5.samples) {
 *     console.log(sample.name, sample.frequency, sample.channels);
 *     const result = await decodeSampleToBlob(sample, fsb5.header.mode, vorbisLibrary);
 *     audio.src = URL.createObjectURL(result.blob);
 *   }
 *   ```
 *
 * Codec coverage:
 *   - PCM8 / PCM16 / PCM32 / PCMFLOAT → WAV
 *   - IMA-ADPCM → WAV
 *   - VORBIS → Ogg-Vorbis (needs a `FmodVorbisSetupPackets` library)
 *   - Other codecs (PCM24, GCADPCM, MPEG, CELT, AT9, XMA, XWMA,
 *     VAG, HEVAG) — surface a clear "not supported" error.
 */

export {
	parseFsb5,
	isFsb5,
	SOUND_FORMAT,
	SOUND_FORMAT_NAMES,
	METADATA_CHUNK_TYPE,
	FREQUENCY_VALUES,
	type ParsedFsb5,
	type ParsedFsb5Header,
	type SoundFormat,
	type MetadataChunkType,
} from './parse.js';
export type { ParsedFsb5Sample } from './types.js';
export {
	decodeSampleToPcm16,
	encodeWavBlob,
} from './decode-pcm.js';
export {
	FmodVorbisSetupPackets,
	loadFmodVorbisSetupPackets,
	type FmodVorbisSetup,
} from './setup-packets.js';
export {
	decodeFmodVorbisSample,
	findVorbisSetup,
} from './decode-vorbis.js';

import { SOUND_FORMAT } from './parse.js';
import type { ParsedFsb5Sample } from './types.js';
import { decodeSampleToPcm16, encodeWavBlob } from './decode-pcm.js';
import { decodeFmodVorbisSample } from './decode-vorbis.js';
import type { FmodVorbisSetupPackets } from './setup-packets.js';

export interface DecodeSampleResult {
	/** Browser-playable Blob with proper MIME (`audio/wav` or `audio/ogg; codecs=vorbis`). */
	blob: Blob;
	/** File extension (without leading dot). */
	extension: 'wav' | 'ogg';
	/** Decode path, for UI labels. */
	kind:
		| 'pcm-wav'
		| 'ima-adpcm-wav'
		| 'fmod-vorbis-to-ogg-vorbis';
}

/**
 * Decode an FSB5 sample to a browser-playable Blob, dispatching by
 * the bank's `mode` field.
 *
 * For Vorbis samples, supply a `FmodVorbisSetupPackets` library
 * (load the bundled `assets/fmod_vorbis_setup_packets.bin` once
 * and reuse). Without it, Vorbis samples throw a clear error.
 */
export async function decodeSampleToBlob(
	sample: ParsedFsb5Sample,
	mode: number,
	vorbisLibrary?: FmodVorbisSetupPackets,
): Promise<DecodeSampleResult> {
	switch (mode) {
		case SOUND_FORMAT.PCM8:
		case SOUND_FORMAT.PCM16:
		case SOUND_FORMAT.PCM32:
		case SOUND_FORMAT.PCMFLOAT: {
			const pcm = decodeSampleToPcm16(sample, mode);
			const blob = encodeWavBlob(pcm, sample.channels, sample.frequency);
			return { blob, extension: 'wav', kind: 'pcm-wav' };
		}
		case SOUND_FORMAT.IMAADPCM: {
			const pcm = decodeSampleToPcm16(sample, mode);
			const blob = encodeWavBlob(pcm, sample.channels, sample.frequency);
			return { blob, extension: 'wav', kind: 'ima-adpcm-wav' };
		}
		case SOUND_FORMAT.VORBIS: {
			if (!vorbisLibrary) {
				throw new Error(
					`FSB5 Vorbis playback needs the setup-packet library. Pass \`vorbisLibrary\` to decodeSampleToBlob — load \`assets/fmod_vorbis_setup_packets.bin\` from @tootallnate/fsb5.`,
				);
			}
			const blob = decodeFmodVorbisSample(sample, vorbisLibrary);
			return {
				blob,
				extension: 'ogg',
				kind: 'fmod-vorbis-to-ogg-vorbis',
			};
		}
		default:
			throw new Error(
				`FSB5 codec ${mode} (${(SOUND_FORMAT as Record<string, number>)[mode] ?? `mode_${mode}`}) is not supported for browser playback yet.`,
			);
	}
}
