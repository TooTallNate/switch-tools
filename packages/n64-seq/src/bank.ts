/**
 * Super Mario 64-family sound banks (`.ctl` entries, the format of
 * SM64 and Mario Kart 64's audio library), parsed for playback.
 *
 * After a ctl entry's 16-byte header (u32 instrument count, u32 drum
 * count, u32 shared, u32 date) every offset is relative to the data
 * that follows (n64decomp/sm64 `tools/disassemble_sound.py`):
 *
 *   +0          u32 → drum pointer list (numDrums entries), 0 if none
 *   +4          u32 instrument pointers[numInstruments] (0 = empty)
 *   Instrument  u8 loaded, u8 normalRangeLo, u8 normalRangeHi,
 *               u8 releaseRate, u32 envelope, 3 × Sound (low/normal/high)
 *   Drum        u8 releaseRate, u8 pan, u8 loaded, u8 pad, Sound, u32 envelope
 *   Sound       u32 sample (0 = none), f32 tuning
 *   Sample      u32 0, u32 tbl offset, u32 loop, u32 book, u32 size
 *   Loop        u32 start, u32 end, s32 count (−1 forever), u32 pad
 *   Envelope    (u16 delay, u16 arg)…, ending in delay 0 / 0xFFFF / 0xFFFE / 0xFFFD
 */

import { decodeVadpcm, parseVadpcmBook } from '@tootallnate/vadpcm';

export interface SeqSample {
	/** Decoded PCM (lazily filled by the synth). */
	pcm: Int16Array;
	loopStart: number;
	loopEnd: number;
	/** −1 loops forever, 0 not at all. */
	loopCount: number;
}

export interface SeqSound {
	sample: SeqSample;
	tuning: number;
}

export interface SeqEnvelopePoint {
	delay: number;
	arg: number;
}

export interface SeqInstrument {
	releaseRate: number;
	normalRangeLo: number;
	normalRangeHi: number;
	envelope: SeqEnvelopePoint[];
	low: SeqSound | null;
	normal: SeqSound | null;
	high: SeqSound | null;
}

export interface SeqDrum {
	releaseRate: number;
	pan: number;
	envelope: SeqEnvelopePoint[];
	sound: SeqSound | null;
}

export interface SeqBank {
	instruments: (SeqInstrument | null)[];
	drums: (SeqDrum | null)[];
}

const u8 = (b: Uint8Array, o: number) => b[o] ?? 0;
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const u32 = (b: Uint8Array, o: number) => ((u16(b, o) << 16) | u16(b, o + 2)) >>> 0;
const s32 = (b: Uint8Array, o: number) => u32(b, o) | 0;
const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getFloat32(o);

/**
 * Parse one ctl entry (header included) against its tbl entry. Samples
 * decode on first use (VADPCM), shared between instruments.
 */
export function parseSeqBank(entry: Uint8Array, tbl: Uint8Array): SeqBank {
	const numInst = u32(entry, 0), numDrums = u32(entry, 4);
	const d = entry.subarray(16);
	const samples = new Map<number, SeqSample | null>();
	const envelopes = new Map<number, SeqEnvelopePoint[]>();
	const inBank = (p: number, size: number) => p > 0 && p + size <= d.length;
	const envelope = (p: number): SeqEnvelopePoint[] => {
		let e = envelopes.get(p);
		if (!e) {
			e = [];
			for (let o = p; inBank(o, 4) && e.length < 64; o += 4) {
				const delay = u16(d, o), arg = u16(d, o + 2);
				e.push({ delay, arg });
				if (delay === 0 || delay >= 0xfffd) break;
			}
			envelopes.set(p, e);
		}
		return e;
	};
	const sample = (p: number): SeqSample | null => {
		if (samples.has(p)) return samples.get(p)!;
		let s: SeqSample | null = null;
		if (inBank(p, 20)) {
			const addr = u32(d, p + 4), loopAt = u32(d, p + 8), bookAt = u32(d, p + 12), size = u32(d, p + 16);
			const book = inBank(bookAt, 8) ? parseVadpcmBook(d, bookAt) : null;
			if (book && addr + size <= tbl.length) {
				let pcm: Int16Array | null = null;
				const loop = inBank(loopAt, 16) ? { start: u32(d, loopAt), end: u32(d, loopAt + 4), count: s32(d, loopAt + 8) } : { start: 0, end: 0, count: 0 };
				s = {
					get pcm() {
						pcm ??= decodeVadpcm(tbl.subarray(addr, addr + size), book).samples;
						return pcm;
					},
					loopStart: loop.start,
					loopEnd: loop.end,
					loopCount: loop.count,
				};
			}
		}
		samples.set(p, s);
		return s;
	};
	const sound = (o: number): SeqSound | null => {
		const p = u32(d, o);
		if (!p) return null;
		const s = sample(p);
		return s ? { sample: s, tuning: f32(d, o + 4) || 1 } : null;
	};
	const instruments: (SeqInstrument | null)[] = [];
	for (let i = 0; i < numInst && i < 256; i++) {
		const p = u32(d, 4 + i * 4);
		if (!inBank(p, 32)) {
			instruments.push(null);
			continue;
		}
		instruments.push({
			normalRangeLo: u8(d, p + 1),
			normalRangeHi: u8(d, p + 2),
			releaseRate: u8(d, p + 3),
			envelope: envelope(u32(d, p + 4)),
			low: sound(p + 8),
			normal: sound(p + 16),
			high: sound(p + 24),
		});
	}
	const drums: (SeqDrum | null)[] = [];
	const list = u32(d, 0);
	for (let i = 0; i < numDrums && i < 256 && inBank(list, (i + 1) * 4); i++) {
		const p = u32(d, list + i * 4);
		if (!inBank(p, 16)) {
			drums.push(null);
			continue;
		}
		drums.push({ releaseRate: u8(d, p), pan: u8(d, p + 1), sound: sound(p + 4), envelope: envelope(u32(d, p + 12)) });
	}
	return { instruments, drums };
}
