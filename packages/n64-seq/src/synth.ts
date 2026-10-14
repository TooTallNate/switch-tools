/**
 * Renders {@link SeqNoteEvent}s to 32 kHz stereo PCM, approximating the
 * SM64 audio library's voices (`src/audio/synthesis.c`, `effects.c`):
 * the sample plays at `freq` frames per output frame (1 = 32 kHz), loops
 * between its loop points, and is shaped by the instrument ADSR envelope
 * (points of `delay` updates at 240 Hz ramping to `arg` / 32767), then on
 * release falls by `releaseRate × 24` per update. Pan is equal-power.
 * Reverb, vibrato and portamento are not modelled.
 */

import type { SeqEnvelopePoint } from './bank.js';
import type { SeqNoteEvent } from './m64.js';

export const SEQ_SAMPLE_RATE = 32000;
const UPDATE = SEQ_SAMPLE_RATE / 240; // output frames per envelope update

/** Envelope level (0–1) per update until it ends or hangs, plus whether it hangs. */
function envelopeLevels(env: SeqEnvelopePoint[], maxUpdates: number): Float32Array {
	const out = new Float32Array(maxUpdates);
	let level = 0, i = 0, u = 0, guard = 0;
	while (u < maxUpdates && guard++ < 10000) {
		const p = env[i];
		if (!p || p.delay === 0) {
			// disabled: silence
			out.fill(0, u);
			return out;
		}
		if (p.delay === 0xffff) {
			out.fill(level, u);
			return out;
		}
		if (p.delay === 0xfffe) {
			i = p.arg;
			continue;
		}
		if (p.delay === 0xfffd) {
			i = 0;
			level = 0;
			continue;
		}
		const target = p.arg / 32767, step = (target - level) / p.delay;
		for (let k = 0; k < p.delay && u < maxUpdates; k++, u++) {
			level += step;
			out[u] = level;
		}
		level = target;
		i++;
	}
	return out;
}

export interface RenderedAudio {
	left: Float32Array;
	right: Float32Array;
}

/** Mix events into `seconds` of audio (fading out the last `fade` seconds). */
export function renderSeqEvents(events: SeqNoteEvent[], seconds: number, fade = 0): RenderedAudio {
	const n = Math.max(1, Math.ceil(seconds * SEQ_SAMPLE_RATE));
	const left = new Float32Array(n), right = new Float32Array(n);
	for (const e of events) {
		const pcm = e.sound.sample.pcm;
		if (!pcm.length) continue;
		const start = Math.floor(e.time * SEQ_SAMPLE_RATE);
		if (start >= n) continue;
		const gateFrames = Math.max(1, Math.floor(e.duration * SEQ_SAMPLE_RATE));
		const releaseUpdates = Math.ceil(32767 / Math.max(1, e.release * 24));
		const totalUpdates = Math.ceil(gateFrames / UPDATE) + releaseUpdates + 1;
		const env = envelopeLevels(e.envelope, Math.ceil(gateFrames / UPDATE) + 1);
		const gL = Math.cos((e.pan * Math.PI) / 2) * e.volume, gR = Math.sin((e.pan * Math.PI) / 2) * e.volume;
		const { loopStart, loopEnd, loopCount } = e.sound.sample;
		const loops = loopCount !== 0 && loopEnd > loopStart && loopEnd <= pcm.length;
		let pos = 0, remaining = loopCount < 0 ? Infinity : loopCount;
		let releaseLevel = 1;
		const gateUpdates = Math.ceil(gateFrames / UPDATE);
		for (let f = 0; start + f < n; f++) {
			const u = Math.floor(f / UPDATE);
			if (u >= totalUpdates) break;
			let amp: number;
			if (u < gateUpdates) amp = env[u] ?? 0;
			else {
				const base = env[gateUpdates - 1] ?? 0;
				releaseLevel = Math.max(0, 1 - ((u - gateUpdates) * e.release * 24) / 32767);
				amp = base * releaseLevel;
				if (amp <= 0) break;
			}
			// Advance through the sample, looping.
			if (loops && pos >= loopEnd && remaining > 0) {
				pos -= loopEnd - loopStart;
				remaining--;
			}
			if (pos >= pcm.length - 1) break;
			const i = Math.floor(pos), t = pos - i;
			const s = ((pcm[i]! * (1 - t) + pcm[i + 1]! * t) / 32768) * amp;
			left[start + f]! += s * gL;
			right[start + f]! += s * gR;
			pos += e.freq;
		}
	}
	if (fade > 0) {
		const fs = Math.min(n, Math.floor(fade * SEQ_SAMPLE_RATE));
		for (let i = 0; i < fs; i++) {
			const g = 1 - i / fs;
			left[n - fs + i]! *= g;
			right[n - fs + i]! *= g;
		}
	}
	return { left, right };
}

/** Normalise and pack to 16-bit stereo WAV. */
export function encodeStereoWav(audio: RenderedAudio, sampleRate = SEQ_SAMPLE_RATE, headroom = 0.9): Uint8Array {
	const n = audio.left.length;
	let peak = 1e-6;
	for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(audio.left[i]!), Math.abs(audio.right[i]!));
	const gain = Math.min(4, headroom / peak);
	const out = new Uint8Array(44 + n * 4);
	const dv = new DataView(out.buffer);
	const tag = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
	tag(0, 'RIFF');
	dv.setUint32(4, 36 + n * 4, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, 2, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * 4, true);
	dv.setUint16(32, 4, true);
	dv.setUint16(34, 16, true);
	tag(36, 'data');
	dv.setUint32(40, n * 4, true);
	for (let i = 0; i < n; i++) {
		dv.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, Math.round(audio.left[i]! * gain * 32767))), true);
		dv.setInt16(46 + i * 4, Math.max(-32768, Math.min(32767, Math.round(audio.right[i]! * gain * 32767))), true);
	}
	return out;
}
