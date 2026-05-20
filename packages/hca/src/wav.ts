/*
 * Tiny RIFF/WAVE encoder for Float32 PCM samples.
 *
 * Mirrors CriTools' `writeWavFile`:
 *
 *   bitDepth = 0   IEEE-754 float (fmtType = 3)
 *            = 8   unsigned 8-bit PCM
 *            = 16  signed 16-bit PCM (default; what most consumers want)
 *            = 24  signed 24-bit packed LE PCM
 *            = 32  signed 32-bit PCM
 *
 * Ported from kohos/CriTools (MIT) — https://github.com/kohos/CriTools
 */

/** Options for {@link encodeToWav}. */
export interface WavEncodeOptions {
	/**
	 * Output bit depth. `0` = 32-bit IEEE-754 float (fmtType=3);
	 * any other value = signed PCM (fmtType=1). Default is 16.
	 */
	bitDepth?: 0 | 8 | 16 | 24 | 32;
}

/**
 * Encode interleaved Float32 PCM samples (range nominally
 * `[-1.0, +1.0]`) into a RIFF/WAVE byte buffer. Samples outside
 * the range are clipped.
 */
export function encodeToWav(
	channelCount: number,
	samplingRate: number,
	pcm: Float32Array,
	options: WavEncodeOptions = {},
): Uint8Array {
	const bitDepth = options.bitDepth ?? 16;
	if (channelCount < 1) {
		throw new RangeError(`channelCount must be >= 1, got ${channelCount}`);
	}
	if (samplingRate < 1) {
		throw new RangeError(`samplingRate must be >= 1, got ${samplingRate}`);
	}
	if (pcm.length % channelCount !== 0) {
		throw new RangeError(
			`pcm length (${pcm.length}) is not a multiple of channelCount (${channelCount})`,
		);
	}

	const isFloat = bitDepth === 0;
	const bitCount = isFloat ? 32 : bitDepth;
	const fmtType = isFloat ? 3 : 1;
	const bytesPerSample = Math.floor(bitCount / 8);
	const blockAlign = bytesPerSample * channelCount;
	const byteRate = samplingRate * blockAlign;
	const dataSize = pcm.length * bytesPerSample;
	const out = new Uint8Array(44 + dataSize);
	const dv = new DataView(out.buffer);

	// RIFF/WAVE header (44 bytes — fmt sub-chunk size = 16).
	out[0] = 0x52; // 'R'
	out[1] = 0x49; // 'I'
	out[2] = 0x46; // 'F'
	out[3] = 0x46; // 'F'
	dv.setUint32(4, 36 + dataSize, true);
	out[8] = 0x57; // 'W'
	out[9] = 0x41; // 'A'
	out[10] = 0x56; // 'V'
	out[11] = 0x45; // 'E'
	out[12] = 0x66; // 'f'
	out[13] = 0x6d; // 'm'
	out[14] = 0x74; // 't'
	out[15] = 0x20; // ' '
	dv.setUint32(16, 16, true); // fmt chunk size
	dv.setUint16(20, fmtType, true);
	dv.setUint16(22, channelCount, true);
	dv.setUint32(24, samplingRate, true);
	dv.setUint32(28, byteRate, true);
	dv.setUint16(32, blockAlign, true);
	dv.setUint16(34, bitCount, true);
	out[36] = 0x64; // 'd'
	out[37] = 0x61; // 'a'
	out[38] = 0x74; // 't'
	out[39] = 0x61; // 'a'
	dv.setUint32(40, dataSize, true);

	// Samples.
	let p = 44;
	switch (bitDepth) {
		case 0: {
			// 32-bit IEEE-754 float, little-endian.
			for (let i = 0; i < pcm.length; i++) {
				let f = pcm[i]!;
				if (f > 1) f = 1;
				else if (f < -1) f = -1;
				dv.setFloat32(p, f, true);
				p += 4;
			}
			break;
		}
		case 8: {
			for (let i = 0; i < pcm.length; i++) {
				let f = pcm[i]!;
				if (f > 1) f = 1;
				else if (f < -1) f = -1;
				out[p++] = (Math.floor(f * 0x7f) + 0x80) & 0xff;
			}
			break;
		}
		case 16: {
			for (let i = 0; i < pcm.length; i++) {
				let f = pcm[i]!;
				if (f > 1) f = 1;
				else if (f < -1) f = -1;
				dv.setInt16(p, Math.floor(f * 0x7fff), true);
				p += 2;
			}
			break;
		}
		case 24: {
			// 24-bit signed PCM, packed LE.
			for (let i = 0; i < pcm.length; i++) {
				let f = pcm[i]!;
				if (f > 1) f = 1;
				else if (f < -1) f = -1;
				const s = Math.floor(f * 0x7fffff) | 0;
				out[p++] = s & 0xff;
				out[p++] = (s >> 8) & 0xff;
				out[p++] = (s >> 16) & 0xff;
			}
			break;
		}
		case 32: {
			for (let i = 0; i < pcm.length; i++) {
				let f = pcm[i]!;
				if (f > 1) f = 1;
				else if (f < -1) f = -1;
				dv.setInt32(p, Math.floor(f * 0x7fffffff), true);
				p += 4;
			}
			break;
		}
		default: {
			throw new RangeError(
				`Unsupported bitDepth: ${bitDepth} (must be 0, 8, 16, 24, or 32)`,
			);
		}
	}
	return out;
}
