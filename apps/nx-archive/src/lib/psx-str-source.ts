/**
 * Adapts {@link StrDecoder} to the streaming MP4 encoder's frame
 * source, so PlayStation STR movies play through the same WebCodecs
 * pipeline as Bink.
 */
import { cookedStrToRaw, isCookedStr, StrDecoder } from '@tootallnate/psx-str';
import type { VideoFrameSource } from './bink-encode';

/** Raw-sector STR bytes, converting cooked (Form 1) STRs. */
export function strRawBytes(bytes: Uint8Array): Uint8Array {
	return isCookedStr(bytes) ? cookedStrToRaw(bytes) : bytes;
}

/**
 * XA audio is 37 800 or 18 900 Hz. Browsers' AAC encoders may accept
 * those rates, but MSE playback of the result fails, so resample to
 * 44.1 kHz.
 */
const OUTPUT_RATE = 44100;

/** Streaming linear-interpolation resampler for interleaved float audio. */
class LinearResampler {
	private pos = 0; // fractional read position into `buf`, in frames
	private buf = new Float32Array(0);
	constructor(
		private readonly inRate: number,
		private readonly outRate: number,
		private readonly channels: number,
	) {}

	push(input: Float32Array): { samples: Float32Array; sampleFrames: number } {
		const ch = this.channels;
		const merged = new Float32Array(this.buf.length + input.length);
		merged.set(this.buf);
		merged.set(input, this.buf.length);
		const frames = merged.length / ch;
		const step = this.inRate / this.outRate;
		const out: number[] = [];
		let pos = this.pos;
		while (pos + 1 < frames) {
			const i = Math.floor(pos);
			const t = pos - i;
			for (let c = 0; c < ch; c++) out.push(merged[i * ch + c] * (1 - t) + merged[(i + 1) * ch + c] * t);
			pos += step;
		}
		// Keep the frame the next interpolation starts from.
		const keep = Math.floor(pos);
		this.buf = merged.slice(keep * ch);
		this.pos = pos - keep;
		return { samples: Float32Array.from(out), sampleFrames: out.length / ch };
	}
}

export function strFrameSource(bytes: Uint8Array): VideoFrameSource {
	const dec = new StrDecoder(strRawBytes(bytes));
	const { width, height, frameCount, fps, audio, version } = dec.info;
	if (version < 1 || version > 3) {
		throw new Error(`This STR uses MDEC version ${version}; only versions 1–3 can be decoded.`);
	}
	const resampler = audio ? new LinearResampler(audio.sampleRate, OUTPUT_RATE, audio.channels) : null;
	return {
		info: {
			width,
			height,
			frameCount,
			fpsNum: Math.round(fps * 1000),
			fpsDen: 1000,
			pixelFormat: 0,
			audioTracks: audio ? [{ channels: audio.channels, sampleRate: OUTPUT_RATE }] : [],
		},
		decodeFrame: () => {
			const f = dec.nextFrame();
			return f && { width: f.width, height: f.height, y: f.y, u: f.u, v: f.v, yStride: f.yStride, uStride: f.uStride, vStride: f.vStride };
		},
		drainAudio: () => {
			const chunk = dec.drainAudio();
			return chunk && resampler ? resampler.push(chunk.samples) : chunk;
		},
		dispose: () => {},
	};
}
