/**
 * PlayStation STR movies: MDEC video frames split across CD-XA
 * sectors, interleaved with XA audio.
 *
 * A video sector's user data (raw sector offset 24) starts with a
 * 32-byte header — u16 0x0160, u16 0x8001, u16 chunk index, u16
 * chunk count, u32 frame number, u32 frame size, u16 width,
 * u16 height — followed by 2016 bytes of the frame. The chunks of a
 * frame are concatenated in chunk order. The CD runs at double speed
 * (150 sectors / s), so the frame rate follows from how many sectors
 * each frame spans.
 */
import { decodeMdecFrame, mdecFrameVersion, type MdecFrame } from './mdec.js';
import { isXaAudioSector, RAW_SECTOR_SIZE, scanXaStreams, XaDecoder, type XaStream } from './xa.js';

const CHUNK = 2016;
const SECTORS_PER_SECOND = 150;

export interface StrVideoInfo {
	width: number;
	height: number;
	frameCount: number;
	fps: number;
	/** MDEC version of the first frame (1–3; others can't be decoded). */
	version: number;
	/** Audio stream played with the video, if any. */
	audio: XaStream | null;
}

interface VideoHeader {
	chunk: number;
	chunks: number;
	frame: number;
	size: number;
	width: number;
	height: number;
}

function videoHeader(sector: Uint8Array): VideoHeader | null {
	if (sector.length < 24 + 32) return null;
	if (isXaAudioSector(sector)) return null;
	const u = 24;
	if (sector[u] !== 0x60 || sector[u + 1] !== 0x01) return null;
	if (sector[u + 2] !== 0x01 || sector[u + 3] !== 0x80) return null;
	const dv = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
	const h = {
		chunk: dv.getUint16(u + 4, true),
		chunks: dv.getUint16(u + 6, true),
		frame: dv.getUint32(u + 8, true),
		size: dv.getUint32(u + 12, true),
		width: dv.getUint16(u + 16, true),
		height: dv.getUint16(u + 18, true),
	};
	if (!h.chunks || h.chunk >= h.chunks || h.size > h.chunks * CHUNK || !h.width || !h.height) return null;
	return h;
}

/**
 * Lay out a cooked STR (2048-byte sectors, as read from a Form 1
 * file) as raw 2352-byte data sectors, so the raw-sector decoder can
 * read it. Cooked files carry no audio.
 */
export function cookedStrToRaw(cooked: Uint8Array): Uint8Array {
	const count = Math.floor(cooked.length / 2048);
	const raw = new Uint8Array(count * RAW_SECTOR_SIZE);
	for (let i = 0; i < count; i++) {
		const o = i * RAW_SECTOR_SIZE;
		raw[o + 15] = 2; // mode 2
		raw[o + 18] = raw[o + 22] = 0x08; // submode: data
		raw.set(cooked.subarray(i * 2048, (i + 1) * 2048), o + 24);
	}
	return raw;
}

/** True when cooked (2048-byte sector) data starts with an STR video header. */
export function isCookedStr(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x60 && head[1] === 0x01 && head[2] === 0x01 && head[3] === 0x80;
}

/** True when a run of raw sectors contains STR video frames. */
export function hasStrVideo(raw: Uint8Array, maxSectors = 64): boolean {
	for (let o = 0, n = 0; o + RAW_SECTOR_SIZE <= raw.length && n < maxSectors; o += RAW_SECTOR_SIZE, n++) {
		if (videoHeader(raw.subarray(o, o + RAW_SECTOR_SIZE))) return true;
	}
	return false;
}

/** Describe the video (and its audio) in a run of raw STR sectors. */
export function probeStr(raw: Uint8Array): StrVideoInfo | null {
	let first: VideoHeader | null = null;
	let firstSector = -1;
	let lastFrameStart = -1;
	let lastFrame = -1;
	let frames = 0;
	let version = -1;
	for (let o = 0, s = 0; o + RAW_SECTOR_SIZE <= raw.length; o += RAW_SECTOR_SIZE, s++) {
		const sector = raw.subarray(o, o + RAW_SECTOR_SIZE);
		const h = videoHeader(sector);
		if (!h) continue;
		if (!first) {
			first = h;
			firstSector = s;
		}
		if (h.chunk === 0) {
			if (version < 0) version = mdecFrameVersion(sector.subarray(24 + 32, 24 + 32 + CHUNK));
			if (h.frame !== lastFrame) {
				frames++;
				lastFrame = h.frame;
				lastFrameStart = s;
			}
		}
	}
	if (!first) return null;
	const spf = frames > 1 ? (lastFrameStart - firstSector) / (frames - 1) : 10;
	const fps = spf > 0 ? Math.round((SECTORS_PER_SECOND / spf) * 1000) / 1000 : 15;
	const audio = scanXaStreams(raw)[0] ?? null;
	return { width: first.width, height: first.height, frameCount: frames, fps, version, audio };
}

/**
 * Sequential STR decoder: `nextFrame()` returns the next decoded
 * frame, and `drainAudio()` the interleaved audio read so far
 * (as float samples), so audio stays in step with the video.
 */
export class StrDecoder {
	readonly info: StrVideoInfo;
	private pos = 0;
	private chunks: Uint8Array | null = null;
	private chunkFrame = -1;
	private received = 0;
	private audioDecoder: XaDecoder | null;
	private audioQueue: Int16Array[] = [];

	constructor(private readonly raw: Uint8Array) {
		const info = probeStr(raw);
		if (!info) throw new Error('No STR video sectors');
		this.info = info;
		this.audioDecoder = info.audio ? new XaDecoder(info.audio.channels, info.audio.bitsPerSample) : null;
	}

	/** Decode the next video frame, or null at the end. */
	nextFrame(): MdecFrame | null {
		const raw = this.raw;
		while (this.pos + RAW_SECTOR_SIZE <= raw.length) {
			const sector = raw.subarray(this.pos, this.pos + RAW_SECTOR_SIZE);
			this.pos += RAW_SECTOR_SIZE;
			const audio = this.info.audio;
			if (audio && this.audioDecoder && isXaAudioSector(sector) && sector[16] === audio.file && sector[17] === audio.channel) {
				this.audioQueue.push(this.audioDecoder.decodeSector(sector.subarray(24, 24 + 2304)));
				continue;
			}
			const h = videoHeader(sector);
			if (!h) continue;
			if (!this.chunks || this.chunkFrame !== h.frame || this.chunks.length !== h.chunks * CHUNK) {
				this.chunks = new Uint8Array(h.chunks * CHUNK);
				this.chunkFrame = h.frame;
				this.received = 0;
			}
			this.chunks.set(sector.subarray(24 + 32, 24 + 32 + CHUNK), h.chunk * CHUNK);
			this.received++;
			if (h.chunk === h.chunks - 1) {
				const data = this.chunks.subarray(0, h.size);
				this.chunks = null;
				try {
					return decodeMdecFrame(data, h.width, h.height);
				} catch {
					continue; // unsupported / broken frame: skip it
				}
			}
		}
		return null;
	}

	/** Interleaved float samples decoded since the last call (null when none). */
	drainAudio(): { samples: Float32Array; sampleFrames: number; channels: number; sampleRate: number } | null {
		if (!this.audioQueue.length || !this.info.audio) return null;
		const total = this.audioQueue.reduce((n, a) => n + a.length, 0);
		const samples = new Float32Array(total);
		let o = 0;
		for (const a of this.audioQueue) {
			for (let i = 0; i < a.length; i++) samples[o + i] = a[i] / 32768;
			o += a.length;
		}
		this.audioQueue = [];
		const { channels, sampleRate } = this.info.audio;
		return { samples, sampleFrames: total / channels, channels, sampleRate };
	}
}
