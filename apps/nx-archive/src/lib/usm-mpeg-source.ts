/**
 * Adapts Sofdec2 USMs with MPEG-1 video (`mpeg_codec` 1, e.g. Sonic
 * Frontiers' movies) to the streaming MP4 encoder's frame source, the
 * way `psx-str-source.ts` does for PlayStation STR. Video decodes with
 * `@tootallnate/mpeg1`; HCA audio decodes block by block, downmixed to
 * stereo and kept level with the video.
 *
 * Multi-track movies keep effects, music and each language's dialog as
 * separate audio channels, named in the USM directory after their source
 * files (`…\wav\EFFECT\ev1020_se.wav`, `…\wav\DIALOG\EN\ev1020_en.wav`).
 * {@link pickUsmAudioTracks} mixes everything that isn't dialog with one
 * language's dialog, as the game plays them.
 */
import { createHcaDecoder, type HcaStreamDecoder } from '@tootallnate/hca';
import { Mpeg1VideoDecoder } from '@tootallnate/mpeg1';
import { parseUsm, type UsmAudioStream, type UsmFile, type UsmVideoStream } from '@tootallnate/usm';
import type { VideoFrameSource } from './bink-encode';

/** Interleaved PCM in `channels` channels down to stereo (5.1 / 3.0 as L R C …). */
export function downmixToStereo(pcm: Float32Array, channels: number): Float32Array {
	if (channels === 2) return pcm;
	const frames = pcm.length / channels;
	const out = new Float32Array(frames * 2);
	const k = Math.SQRT1_2;
	for (let i = 0; i < frames; i++) {
		const s = i * channels;
		let l: number, r: number;
		if (channels === 1) l = r = pcm[s]!;
		else if (channels >= 6) {
			// L R C LFE Ls Rs
			const c = pcm[s + 2]! * k;
			l = pcm[s]! + c + pcm[s + 4]! * k;
			r = pcm[s + 1]! + c + pcm[s + 5]! * k;
		} else {
			// L R C (+ surround) for 3-5 channels
			const c = pcm[s + 2]! * k;
			l = pcm[s]! + c;
			r = pcm[s + 1]! + c;
		}
		out[i * 2] = l;
		out[i * 2 + 1] = r;
	}
	return out;
}

/** Dialog language of a track from its source path (`…\DIALOG\EN\…`), or null. */
export function usmDialogLanguage(track: Pick<UsmAudioStream, 'sourceName'>): string | null {
	const m = /[\\/]DIALOG[\\/]([^\\/]+)[\\/]/i.exec(track.sourceName ?? '');
	return m ? m[1]!.toUpperCase() : null;
}

/**
 * The HCA tracks to mix: every non-dialog track plus one language's
 * dialog (`language`, else English, else the first). Without source
 * names, just the first track.
 */
export function pickUsmAudioTracks(usm: UsmFile, language?: string): UsmAudioStream[] {
	const hca = usm.streams.filter((s): s is UsmAudioStream => s.type === 'audio' && s.codec === 'hca');
	if (!hca.some((t) => t.sourceName)) return hca.slice(0, 1);
	const dialog = hca.filter((t) => usmDialogLanguage(t));
	const want = [language?.toUpperCase(), 'EN'].find((l) => l && dialog.some((t) => usmDialogLanguage(t) === l));
	const voice = want ? dialog.find((t) => usmDialogLanguage(t) === want) : dialog[0];
	return [...hca.filter((t) => !usmDialogLanguage(t)), ...(voice ? [voice] : [])];
}

export interface UsmMpegSourceOptions {
	/** Pre-parsed USM, to skip parsing again. */
	usm?: UsmFile;
	/** Dialog language for multi-language movies (`EN`, `JA`, …). */
	language?: string;
}

export async function usmMpegFrameSource(blob: Blob, options: UsmMpegSourceOptions = {}): Promise<VideoFrameSource> {
	const usm = options.usm ?? (await parseUsm(blob));
	const video = usm.streams.find((s): s is UsmVideoStream => s.type === 'video');
	if (!video) throw new Error('USM contains no video stream.');
	const dec = new Mpeg1VideoDecoder(new Uint8Array(await video.data.arrayBuffer()), {
		dcPrecision: video.dcPrecision ? video.dcPrecision - 8 : undefined,
	});
	const info = dec.info;
	if (!info) throw new Error('This USM video has no MPEG-1 sequence header.');

	const tracks: HcaStreamDecoder[] = [];
	for (const t of pickUsmAudioTracks(usm, options.language)) {
		try {
			tracks.push(createHcaDecoder(new Uint8Array(await t.data.arrayBuffer())));
		} catch {
			// Leave out a track that won't decode rather than the movie.
		}
	}
	const rate = tracks[0]?.header.samplingRate ?? 48000;
	const mixed = tracks.filter((t) => t.header.samplingRate === rate);
	const fps = info.frameRate || video.fps || 30;
	let framesOut = 0;
	let samplesOut = 0;
	let ended = false;

	// H.264 needs at least a macroblock; the planes are padded to one, so
	// audio-only movies' 8×8 placeholder video plays at 16×16.
	const width = Math.max(16, info.width), height = Math.max(16, info.height);

	return {
		info: {
			width,
			height,
			frameCount: video.totalFrames || 0,
			fpsNum: Math.round(fps * 1000),
			fpsDen: 1000,
			pixelFormat: 0,
			audioTracks: mixed.length ? [{ channels: 2, sampleRate: rate }] : [],
		},
		decodeFrame: () => {
			const f = dec.decode();
			if (!f) {
				ended = true;
				return null;
			}
			framesOut++;
			return { width, height, y: f.y, u: f.cb, v: f.cr, yStride: f.yStride, uStride: f.cStride, vStride: f.cStride };
		},
		drainAudio: () => {
			if (!mixed.length) return null;
			// Decode up to the end of the frames handed out so far (all of it at the end).
			const target = ended ? Infinity : (framesOut / fps) * rate;
			const parts: Float32Array[] = [];
			while (samplesOut < target && mixed.some((t) => t.remaining > 0)) {
				let sum: Float32Array | null = null;
				for (const t of mixed) {
					const pcm = t.decodeBlocks(1);
					if (!pcm) continue;
					const stereo = downmixToStereo(pcm, t.header.channelCount);
					if (!sum || stereo.length > sum.length) {
						const bigger: Float32Array = new Float32Array(stereo.length);
						if (sum) bigger.set(sum);
						sum = bigger;
					}
					for (let i = 0; i < stereo.length; i++) sum[i]! += stereo[i]!;
				}
				if (!sum) break;
				parts.push(sum);
				samplesOut += sum.length / 2;
			}
			if (!parts.length) return null;
			const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
			let o = 0;
			for (const p of parts) {
				for (let i = 0; i < p.length; i++) samples[o + i] = Math.max(-1, Math.min(1, p[i]!));
				o += p.length;
			}
			return { samples, sampleFrames: samples.length / 2 };
		},
		dispose: () => {},
	};
}
