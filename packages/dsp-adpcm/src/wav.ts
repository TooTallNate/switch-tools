/**
 * Build a RIFF/WAVE-format byte buffer from interleaved PCM16
 * samples. The output is the smallest valid WAV stream that the
 * HTML5 `<audio>` element / `AudioContext.decodeAudioData()` will
 * accept: a `RIFF` header, a 16-byte `fmt ` chunk declaring
 * `WAVE_FORMAT_PCM` (1) at 16-bit depth, and a `data` chunk with
 * the interleaved samples.
 *
 * For multi-channel streams, samples must already be interleaved
 * frame-by-frame: `[ch0[0], ch1[0], …, chN[0], ch0[1], ch1[1], …]`.
 *
 * Reference: Microsoft's "RIFF Waveform Audio File Format"
 * specification (the canonical PCM layout). 44 bytes of header,
 * then `numFrames * numChannels * 2` bytes of payload.
 */
export function encodeWav(
	samples: Int16Array,
	sampleRate: number,
	numChannels: number,
): Uint8Array {
	if (numChannels < 1) throw new Error('numChannels must be ≥ 1');
	if (sampleRate < 1) throw new Error('sampleRate must be ≥ 1');
	if (samples.length % numChannels !== 0) {
		throw new Error(
			`samples.length (${samples.length}) is not a multiple of numChannels (${numChannels})`,
		);
	}
	const bytesPerSample = 2;
	const byteRate = sampleRate * numChannels * bytesPerSample;
	const blockAlign = numChannels * bytesPerSample;
	const dataSize = samples.length * bytesPerSample;
	const out = new Uint8Array(44 + dataSize);
	const v = new DataView(out.buffer);
	const enc = new TextEncoder();
	// "RIFF" header
	out.set(enc.encode('RIFF'), 0);
	v.setUint32(4, 36 + dataSize, true);
	out.set(enc.encode('WAVE'), 8);
	// "fmt " chunk
	out.set(enc.encode('fmt '), 12);
	v.setUint32(16, 16, true); // chunk size
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, numChannels, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, byteRate, true);
	v.setUint16(32, blockAlign, true);
	v.setUint16(34, 16, true); // bits per sample
	// "data" chunk
	out.set(enc.encode('data'), 36);
	v.setUint32(40, dataSize, true);
	// Sample payload
	const sampleView = new DataView(out.buffer, 44, dataSize);
	for (let i = 0; i < samples.length; i++) {
		sampleView.setInt16(i * 2, samples[i], true);
	}
	return out;
}

/**
 * Convenience: build a `Blob` MIME-tagged as `audio/wav`, ready to
 * hand to `URL.createObjectURL()` for `<audio src=…>` playback.
 */
export function encodeWavBlob(
	samples: Int16Array,
	sampleRate: number,
	numChannels: number,
): Blob {
	return new Blob([encodeWav(samples, sampleRate, numChannels) as BlobPart], {
		type: 'audio/wav',
	});
}
