/**
 * Top-level WEM decode dispatch — turns a `ParsedWem` into a Blob
 * the browser can play directly via `<audio>`.
 */

import type { ParsedWem } from './parse.js';
import { wemSwitchOpusToOggOpus } from './opusnx.js';

export interface WemDecodeResult {
	/** A Blob with a usable MIME type (`audio/wav`, `audio/ogg; codecs=opus`, …). */
	blob: Blob;
	/** Suggested file extension WITHOUT the leading dot (`wav`, `ogg`, …). */
	extension: string;
	/** What kind of decode happened, for UI labels. */
	kind: 'pcm-wav' | 'opus-passthrough' | 'switch-opus-to-ogg-opus';
}

/**
 * Decode a parsed WEM into a browser-friendly Blob, if its codec
 * is supported. Throws a clear error for unsupported codecs.
 */
export async function decodeWemToBlob(parsed: ParsedWem): Promise<WemDecodeResult> {
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

		case 0xffff:
			throw new Error(
				`Wwise Vorbis (0xFFFF) playback isn't supported yet — needs a ww2ogg-style codebook reconstruction. The .wem can still be downloaded for offline conversion.`,
			);

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
