/**
 * PCM and ADPCM decoders for FSB5 samples.
 *
 * Codec coverage:
 *   - PCM8     (mode 1) — convert unsigned 8-bit to signed 16-bit
 *   - PCM16    (mode 2) — already 16-bit LE, just wrap
 *   - PCM32    (mode 4) — convert s32 LE to s16 (right-shift 16)
 *   - PCMFLOAT (mode 5) — convert float32 LE to s16 (clamp + scale)
 *   - IMAADPCM (mode 7) — FMOD's slightly-tweaked IMA ADPCM
 *
 * PCM24 (mode 3) and GCADPCM (mode 6, Wii/3DS DSP) aren't covered
 * here. PCM24 is rare in modern FSB5; GCADPCM uses the same
 * algorithm as our `@tootallnate/dsp-adpcm` package and could be
 * wired in if a sample shows up.
 */

import type { ParsedFsb5Sample } from './types.js';

/**
 * Decode a sample to interleaved 16-bit signed PCM. Throws if the
 * codec isn't one of PCM8/PCM16/PCM32/PCMFLOAT/IMAADPCM.
 */
export function decodeSampleToPcm16(sample: ParsedFsb5Sample, mode: number): Int16Array {
	switch (mode) {
		case 1:
			return decodePcm8(sample);
		case 2:
			return decodePcm16(sample);
		case 4:
			return decodePcm32(sample);
		case 5:
			return decodePcmFloat(sample);
		case 7:
			return decodeImaAdpcm(sample);
		default:
			throw new Error(
				`fsb5: codec ${mode} not supported by decodeSampleToPcm16`,
			);
	}
}

function decodePcm8(s: ParsedFsb5Sample): Int16Array {
	const out = new Int16Array(s.data.length);
	for (let i = 0; i < s.data.length; i++) {
		// FSB5 PCM8 is unsigned (0..255) → center at 128 → scale to s16.
		out[i] = (s.data[i] - 128) << 8;
	}
	return out;
}

function decodePcm16(s: ParsedFsb5Sample): Int16Array {
	const numSamples = (s.data.length / 2) | 0;
	const out = new Int16Array(numSamples);
	const dv = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
	for (let i = 0; i < numSamples; i++) {
		out[i] = dv.getInt16(i * 2, true);
	}
	return out;
}

function decodePcm32(s: ParsedFsb5Sample): Int16Array {
	const numSamples = (s.data.length / 4) | 0;
	const out = new Int16Array(numSamples);
	const dv = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
	for (let i = 0; i < numSamples; i++) {
		out[i] = dv.getInt32(i * 4, true) >> 16;
	}
	return out;
}

function decodePcmFloat(s: ParsedFsb5Sample): Int16Array {
	const numSamples = (s.data.length / 4) | 0;
	const out = new Int16Array(numSamples);
	const dv = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);
	for (let i = 0; i < numSamples; i++) {
		const f = dv.getFloat32(i * 4, true);
		const clamped = Math.max(-1, Math.min(1, f));
		out[i] = Math.round(clamped * 32767);
	}
	return out;
}

// IMA ADPCM step / index tables (RFC 8174).
const IMA_INDEX_TABLE = [
	-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];
const IMA_STEP_TABLE = [
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50,
	55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279,
	307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
	1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
	5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
	18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/**
 * Decode FSB5 IMA ADPCM. Layout: per-channel interleaved nibble
 * blocks. FMOD's framing is the standard 36-byte block (4 bytes
 * preamble: predictor s16 LE + step_index u8 + reserved u8, then
 * 32 bytes of nibble pairs producing 64 mono samples), interleaved
 * across channels.
 *
 * For channels==1 the data is just a sequence of 36-byte blocks.
 * For channels==2 each 36-byte block is followed by the other
 * channel's 36-byte block (FSB5 is little-endian, channel 0 first).
 */
function decodeImaAdpcm(s: ParsedFsb5Sample): Int16Array {
	const ch = s.channels;
	const blockBytes = 36;
	const numBlocks = (s.data.length / (blockBytes * ch)) | 0;
	const samplesPerBlock = 1 + (blockBytes - 4) * 2; // = 65
	const totalSamplesPerChannel = numBlocks * samplesPerBlock;
	const out = new Int16Array(totalSamplesPerChannel * ch);
	const dv = new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength);

	for (let block = 0; block < numBlocks; block++) {
		for (let c = 0; c < ch; c++) {
			const base = (block * ch + c) * blockBytes;
			let predictor = dv.getInt16(base, true);
			let stepIndex = s.data[base + 2];
			if (stepIndex < 0) stepIndex = 0;
			if (stepIndex > 88) stepIndex = 88;
			// Output the predictor as the first sample.
			let outIdx = block * samplesPerBlock * ch + c;
			out[outIdx] = predictor;
			outIdx += ch;
			// Decode 32 bytes of nibble pairs.
			for (let n = 0; n < 32; n++) {
				const byte = s.data[base + 4 + n];
				for (let half = 0; half < 2; half++) {
					const code = (half === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f);
					const step = IMA_STEP_TABLE[stepIndex];
					let diff = step >>> 3;
					if (code & 4) diff += step;
					if (code & 2) diff += step >>> 1;
					if (code & 1) diff += step >>> 2;
					if (code & 8) predictor -= diff;
					else predictor += diff;
					if (predictor > 32767) predictor = 32767;
					else if (predictor < -32768) predictor = -32768;
					stepIndex += IMA_INDEX_TABLE[code];
					if (stepIndex < 0) stepIndex = 0;
					else if (stepIndex > 88) stepIndex = 88;
					out[outIdx] = predictor;
					outIdx += ch;
				}
			}
		}
	}
	return out;
}

/**
 * Encode interleaved 16-bit signed PCM as a Blob with a minimal
 * 44-byte WAV header. Same encoder as in `@tootallnate/wem`.
 */
export function encodeWavBlob(
	pcm: Int16Array,
	channels: number,
	sampleRate: number,
): Blob {
	const dataBytes = pcm.length * 2;
	const header = new Uint8Array(44);
	const dv = new DataView(header.buffer);
	const enc = new TextEncoder();
	header.set(enc.encode('RIFF'), 0);
	dv.setUint32(4, 36 + dataBytes, true);
	header.set(enc.encode('WAVE'), 8);
	header.set(enc.encode('fmt '), 12);
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, channels, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * channels * 2, true);
	dv.setUint16(32, channels * 2, true);
	dv.setUint16(34, 16, true);
	header.set(enc.encode('data'), 36);
	dv.setUint32(40, dataBytes, true);
	// Slice the Int16Array to a Uint8Array view of the same bytes.
	const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	return new Blob([header as unknown as BlobPart, pcmBytes as unknown as BlobPart], {
		type: 'audio/wav',
	});
}
