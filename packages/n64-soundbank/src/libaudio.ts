/**
 * Classic libultra sound banks: `ALBankFile` (`.ctl`) + `.tbl`.
 *
 * The N64 SDK's `libaudio` (used by Rare's GoldenEye 007 and Perfect
 * Dark, and many third-party games) keeps instruments in a
 * pointer-linked bank file and the raw sample data in a header-less
 * table linked right after it. Structures (`PR/libaudio.h`), with
 * every pointer an offset from the start of the ctl file:
 *
 *   ALBankFile   s16 revision ('B1' = 0x4231), s16 bankCount, ALBank* banks[]
 *   ALBank       s16 instCount, u8 flags, u8 pad, s32 sampleRate,
 *                ALInstrument* percussion, ALInstrument* inst[]
 *   ALInstrument u8 volume, pan, priority, flags, 8 × u8 trem/vib,
 *                s16 bendRange, s16 soundCount, ALSound* sounds[]
 *   ALSound      ALEnvelope*, ALKeyMap*, ALWaveTable*, u8 pan, vol, flags, pad
 *   ALWaveTable  u32 base (tbl offset), s32 len, u8 type (0 ADPCM, 1 RAW16),
 *                u8 flags, u16 pad, then ADPCM: loop*, book* / RAW: loop*
 *   ALADPCMBook  s32 order, s32 npredictors, s16 book[order·npredictors·8]
 *
 * Distinct from the Super Mario 64 audio library's ctl/tbl containers
 * (`index.ts`), which index banks by a magic-1/2 header instead. GoldenEye
 * 007 (USA) has two: `sfx.ctl` and `instruments.ctl` (n64decomp/007
 * `ge007.ld`, `assets/music`).
 *
 * The tbl has no header, so {@link findAlBankFiles} places it after the
 * ctl's extent (rounded to its alignment) and keeps the candidate whose
 * samples decode cleanly.
 */

import { decodeVadpcm, parseVadpcmBook, type VadpcmBook } from '@tootallnate/vadpcm';

export const AL_BANK_REVISION = 0x4231; // 'B1'

export interface AlSample {
	/** Offset of the wavetable struct within the ctl (a stable identity). */
	wavetable: number;
	/** Offset of the sample data within the tbl. */
	base: number;
	length: number;
	type: 'adpcm' | 'raw16';
	book: VadpcmBook | null;
	/** The owning bank's sample rate. */
	sampleRate: number;
	bank: number;
	/** Instrument index, or -1 for the percussion instrument. */
	instrument: number;
	sound: number;
}

export interface AlBankFile {
	samples: AlSample[];
	/** Bytes the ctl's structures span (where its tbl can start). */
	extent: number;
}

const u8 = (b: Uint8Array, o: number) => b[o]!;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Parse an `ALBankFile` at the start of `ctl` (which may run past the
 * file). Returns null unless every pointer and count is plausible.
 */
export function parseAlBankFile(ctl: Uint8Array, maxSize = 1 << 20): AlBankFile | null {
	const limit = Math.min(ctl.length, maxSize);
	if (limit < 16 || u16(ctl, 0) !== AL_BANK_REVISION) return null;
	const bankCount = s16(ctl, 2);
	if (bankCount < 1 || bankCount > 64) return null;
	let extent = 4 + bankCount * 4;
	const ptr = (o: number, size: number): number | null => {
		if (o + 4 > limit) return null;
		const p = u32(ctl, o);
		if (p === 0 || p % 4 !== 0 || p + size > limit) return null;
		extent = Math.max(extent, p + size);
		return p;
	};
	const samples: AlSample[] = [];
	const seen = new Set<number>();
	for (let b = 0; b < bankCount; b++) {
		const bank = ptr(4 + b * 4, 12);
		if (bank === null) return null;
		const instCount = s16(ctl, bank);
		if (instCount < 0 || instCount > 256) return null;
		const sampleRate = u32(ctl, bank + 4);
		extent = Math.max(extent, bank + 12 + instCount * 4);
		const instruments: [number, number][] = [];
		if (u32(ctl, bank + 8) !== 0) {
			const perc = ptr(bank + 8, 16);
			if (perc === null) return null;
			instruments.push([-1, perc]);
		}
		for (let i = 0; i < instCount; i++) {
			if (u32(ctl, bank + 12 + i * 4) === 0) continue;
			const inst = ptr(bank + 12 + i * 4, 16);
			if (inst === null) return null;
			instruments.push([i, inst]);
		}
		for (const [index, inst] of instruments) {
			const soundCount = s16(ctl, inst + 14);
			if (soundCount < 0 || soundCount > 512) return null;
			extent = Math.max(extent, inst + 16 + soundCount * 4);
			for (let s = 0; s < soundCount; s++) {
				const sound = ptr(inst + 16 + s * 4, 16);
				if (sound === null) return null;
				const wave = ptr(sound + 8, 20);
				if (wave === null) return null;
				if (ptr(sound, 16) === null || ptr(sound + 4, 6) === null) return null; // envelope, key map
				if (seen.has(wave)) continue;
				const type = u8(ctl, wave + 8);
				if (type > 1) return null;
				const length = u32(ctl, wave + 4);
				if (length === 0 || length > 16 << 20) return null;
				let book: VadpcmBook | null = null;
				if (type === 0) {
					const bookAt = ptr(wave + 16, 8);
					if (bookAt === null) return null;
					book = parseVadpcmBook(ctl, bookAt);
					if (!book) return null;
					extent = Math.max(extent, bookAt + 8 + book.order * book.npredictors * 16);
					if (u32(ctl, wave + 12) !== 0 && ptr(wave + 12, 44) === null) return null;
				}
				seen.add(wave);
				samples.push({ wavetable: wave, base: u32(ctl, wave), length, type: type === 0 ? 'adpcm' : 'raw16', book, sampleRate, bank: b, instrument: index, sound: s });
			}
		}
	}
	return samples.length > 0 ? { samples, extent } : null;
}

/** Decode a sample to 16-bit PCM from its tbl. */
export function decodeAlSample(tbl: Uint8Array, sample: AlSample): { samples: Int16Array; clamped: number } {
	const data = tbl.subarray(sample.base, Math.min(tbl.length, sample.base + sample.length));
	if (sample.type === 'raw16') {
		const out = new Int16Array(data.length >> 1);
		for (let i = 0; i < out.length; i++) out[i] = s16(data, i * 2);
		return { samples: out, clamped: 0 };
	}
	const r = decodeVadpcm(data, sample.book!);
	return { samples: r.samples, clamped: r.clamped };
}

export interface LocatedAlBank extends AlBankFile {
	ctlOffset: number;
	tblOffset: number;
	/** Bytes the tbl spans (the furthest sample end). */
	tblSize: number;
}

/**
 * Find `ALBankFile`s in a (big-endian) ROM, each paired with the tbl
 * that follows it.
 */
export function findAlBankFiles(rom: Uint8Array): LocatedAlBank[] {
	const out: LocatedAlBank[] = [];
	for (let o = 0; o + 16 <= rom.length; o += 4) {
		if (rom[o] !== 0x42 || rom[o + 1] !== 0x31) continue;
		const ctl = parseAlBankFile(rom.subarray(o));
		if (!ctl) continue;
		const tblSize = Math.max(...ctl.samples.map((s) => s.base + s.length));
		const probe = ctl.samples.filter((s) => s.type === 'adpcm').slice(0, 6);
		// The tbl follows the ctl, padded to some alignment; take the first clean decode.
		const starts = new Set<number>();
		for (const a of [1, 2, 4, 8, 16]) starts.add(Math.ceil((o + ctl.extent) / a) * a);
		for (let pad = 16; pad <= 256; pad += 16) starts.add(Math.ceil((o + ctl.extent) / 16) * 16 + pad);
		for (const start of [...starts].sort((a, b) => a - b)) {
			if (start + tblSize > rom.length) continue;
			const tbl = rom.subarray(start, start + tblSize);
			const clean = probe.every((s) => {
				const r = decodeAlSample(tbl, s);
				// A misaligned tbl clamps 15–30% of samples; real audio stays near 0.
				return r.samples.length > 0 && r.clamped / r.samples.length < 0.03;
			});
			if (clean) {
				out.push({ ...ctl, ctlOffset: o, tblOffset: start, tblSize });
				o = ((start + tblSize) & ~3) - 4; // resume past the tbl, keeping 4-byte alignment
				break;
			}
		}
	}
	return out;
}
