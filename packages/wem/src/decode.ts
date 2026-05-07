/**
 * Top-level WEM decode dispatch — turns a `ParsedWem` into a Blob
 * the browser can play directly via `<audio>`.
 */

import type { ParsedWem } from './parse.js';
import { wemSwitchOpusToOggOpus } from './opusnx.js';
import {
	parseWemVorbisV62,
	wemVorbisToOggVorbis,
	codebookLibraryFromBytes,
	type CodebookLibrary,
} from '@tootallnate/wem-vorbis';

export interface WemDecodeResult {
	/** A Blob with a usable MIME type (`audio/wav`, `audio/ogg; codecs=opus`, …). */
	blob: Blob;
	/** Suggested file extension WITHOUT the leading dot (`wav`, `ogg`, …). */
	extension: string;
	/** What kind of decode happened, for UI labels. */
	kind:
		| 'pcm-wav'
		| 'opus-passthrough'
		| 'switch-opus-to-ogg-opus'
		| 'wwise-vorbis-to-ogg-vorbis';
}

/**
 * Optional decode-time inputs. Specifically: Wwise Vorbis playback
 * needs an external codebook library that the consumer must supply
 * (typically by fetching `packed_codebooks_aoTuV_603.bin` from the
 * `@tootallnate/wem-vorbis` package's `assets/` directory at runtime).
 *
 * Either pass raw codebook bytes, a pre-parsed library, or omit
 * entirely — Vorbis WEMs surface a friendly "needs codebooks" error
 * if the library isn't available.
 */
export interface WemDecodeOptions {
	/** Raw codebook file bytes (e.g. fetched at runtime). */
	vorbisCodebookBytes?: Uint8Array;
	/** Pre-parsed codebook library (cache between calls). */
	vorbisCodebookLibrary?: CodebookLibrary;
}

/**
 * Decode a parsed WEM into a browser-friendly Blob, if its codec
 * is supported. Throws a clear error for unsupported codecs.
 */
export async function decodeWemToBlob(
	parsed: ParsedWem,
	options: WemDecodeOptions = {},
): Promise<WemDecodeResult> {
	const { fmt, dataChunk } = parsed;
	if (!dataChunk) throw new Error('WEM has no data chunk to decode');

	switch (fmt.codecId) {
		case 0x0001:
		case 0xfffe: {
			// PCM 16-bit LE (or PCMEX, same byte layout for our purposes).
			if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 0) {
				throw new Error(
					`PCM WEM has unsupported bits_per_sample=${fmt.bitsPerSample}`,
				);
			}
			const pcm = new Uint8Array(await dataChunk.data.arrayBuffer());
			const blob = encodeWavBlobFromPcm16(pcm, fmt.channels, fmt.sampleRate);
			return { blob, extension: 'wav', kind: 'pcm-wav' };
		}

		case 0x3039: {
			// Switch-Opus → Ogg-Opus muxer.
			const blob = await wemSwitchOpusToOggOpus(parsed);
			return { blob, extension: 'ogg', kind: 'switch-opus-to-ogg-opus' };
		}

		case 0x3040: {
			// Standard Ogg-Opus already — the data chunk *is* the .ogg.
			const data = await dataChunk.data.arrayBuffer();
			return {
				blob: new Blob([data], { type: 'audio/ogg; codecs=opus' }),
				extension: 'ogg',
				kind: 'opus-passthrough',
			};
		}

		case 0xffff: {
			// Wwise Vorbis. We need the external aoTuV-603 codebook
			// library — surface a clear instruction if the caller didn't
			// supply one.
			let lib = options.vorbisCodebookLibrary;
			if (!lib) {
				if (!options.vorbisCodebookBytes) {
					throw new Error(
						`Wwise Vorbis playback needs the aoTuV-603 codebook library. Pass \`vorbisCodebookBytes\` or \`vorbisCodebookLibrary\` to decodeWemToBlob — fetch \`packed_codebooks_aoTuV_603.bin\` from the @tootallnate/wem-vorbis assets/ directory.`,
					);
				}
				lib = codebookLibraryFromBytes(options.vorbisCodebookBytes);
			}
			const dataAll = new Uint8Array(await dataChunk.data.arrayBuffer());
			const v = parseWemVorbisV62(fmt.rawPayload, dataAll);
			const blob = await wemVorbisToOggVorbis(v, lib);
			return {
				blob,
				extension: 'ogg',
				kind: 'wwise-vorbis-to-ogg-vorbis',
			};
		}

		case 0x3041:
			throw new Error(
				`Wwise-Opus (OPUSWW, 0x3041) playback isn't supported yet — this is the post-2019.2 Wwise Opus framing with an explicit seek table.`,
			);

		default:
			throw new Error(
				`No browser playback path for WEM codec 0x${fmt.codecId.toString(16)} (${fmt.codecName})`,
			);
	}
}

/**
 * Wrap raw little-endian 16-bit interleaved PCM in a minimal WAV
 * header. The browser's `<audio>` element plays the result with no
 * extra steps.
 */
export function encodeWavBlobFromPcm16(
	pcm: Uint8Array,
	channels: number,
	sampleRate: number,
): Blob {
	const dataSize = pcm.length;
	const header = new Uint8Array(44);
	const dv = new DataView(header.buffer);
	const enc = new TextEncoder();
	header.set(enc.encode('RIFF'), 0);
	dv.setUint32(4, 36 + dataSize, true);
	header.set(enc.encode('WAVE'), 8);
	header.set(enc.encode('fmt '), 12);
	dv.setUint32(16, 16, true);          // fmt chunk size
	dv.setUint16(20, 1, true);           // PCM
	dv.setUint16(22, channels, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * channels * 2, true); // byte rate
	dv.setUint16(32, channels * 2, true);              // block align
	dv.setUint16(34, 16, true);                         // bits per sample
	header.set(enc.encode('data'), 36);
	dv.setUint32(40, dataSize, true);
	return new Blob([header as unknown as BlobPart, pcm as unknown as BlobPart], {
		type: 'audio/wav',
	});
}
