/**
 * Locating a Super Mario 64-family game's music: the `sequences.bin`
 * container (magic 3, same layout as the ctl / tbl containers: u16
 * magic, u16 count, then (u32 offset, u32 length) pairs) and the bank
 * sets that follow it (u16 offset per sequence, then at each offset
 * u8 count and that many bank ids, listed last-first; the last is the
 * sequence's default bank).
 *
 * Source: n64decomp/sm64 `tools/assemble_sound.py`
 * (`serialize_seqfile`, bank set serialisation) and `src/audio/load.c`.
 */

import { BANK_HEADER_SIZE, findSoundBanks, type SoundBankPair } from '@tootallnate/n64-soundbank';
import { parseSeqBank, type SeqBank } from './bank.js';
import { runM64, type SeqRenderOptions } from './m64.js';
import { encodeStereoWav, renderSeqEvents } from './synth.js';

export interface SeqLibrary {
	pair: SoundBankPair;
	seqOffset: number;
	sequences: { offset: number; length: number }[];
	/** Bank ids per sequence (serialized order; the last is the default). */
	bankSets: number[][];
}

const u16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u32 = (b: Uint8Array, o: number) => ((u16(b, o) << 16) | u16(b, o + 2)) >>> 0;

/** Find the sequence container + bank sets near a ROM's sound banks. */
export function findSeqLibrary(rom: Uint8Array): SeqLibrary | null {
	const pair = findSoundBanks(rom);
	if (!pair) return null;
	const bankCount = pair.ctl.entries.length;
	for (let o = 0; o + 8 <= rom.length; o += 4) {
		if (u16(rom, o) !== 3) continue;
		const count = u16(rom, o + 2);
		if (count < 4 || count > 256) continue;
		const seqs: { offset: number; length: number }[] = [];
		let ok = true, end = 0;
		for (let i = 0; i < count && ok; i++) {
			const off = u32(rom, o + 4 + i * 8), len = u32(rom, o + 8 + i * 8);
			if (off < 4 + count * 8 || len === 0 || len > 0x40000 || o + off + len > rom.length) ok = false;
			seqs.push({ offset: off, length: len });
			end = Math.max(end, off + len);
		}
		if (!ok) continue;
		// Bank sets follow, after alignment padding: the first offset is
		// always count × 2 (the table itself).
		let bs = o + Math.ceil(end / 16) * 16;
		for (let k = 0; k < 64 && u16(rom, bs) !== count * 2; k += 16) bs += 16;
		if (u16(rom, bs) !== count * 2) continue;
		const sets: number[][] = [];
		for (let i = 0; i < count && ok; i++) {
			const at = bs + u16(rom, bs + i * 2);
			const n = rom[at] ?? 0;
			if (n === 0 || n > 16) ok = false;
			const ids = Array.from({ length: n }, (_, k) => rom[at + 1 + k] ?? 0xff);
			if (ids.some((id) => id >= bankCount)) ok = false;
			sets.push(ids);
		}
		if (ok) return { pair, seqOffset: o, sequences: seqs, bankSets: sets };
	}
	return null;
}

/** Banks are parsed once and shared between sequences. */
export class SeqBankCache {
	private banks = new Map<number, SeqBank>();
	constructor(private readonly rom: Uint8Array, private readonly lib: SeqLibrary) {}
	get(id: number): SeqBank {
		let b = this.banks.get(id);
		if (!b) {
			const { pair } = this.lib;
			const c = pair.ctl.entries[id]!, t = pair.tbl.entries[id]!;
			const entry = this.rom.subarray(pair.ctlOffset + c.offset, pair.ctlOffset + c.offset + c.length);
			const tbl = this.rom.subarray(pair.tblOffset + t.offset, pair.tblOffset + t.offset + t.length);
			b = parseSeqBank(entry, tbl);
			this.banks.set(id, b);
		}
		return b;
	}
}
void BANK_HEADER_SIZE;

/** Render sequence `index` to a stereo WAV (one pass of its loop, then a fade). */
export function renderSeqWav(rom: Uint8Array, lib: SeqLibrary, index: number, cache = new SeqBankCache(rom, lib), options: SeqRenderOptions = {}): { wav: Uint8Array; seconds: number; notes: number } | null {
	const s = lib.sequences[index];
	if (!s) return null;
	const seq = rom.subarray(lib.seqOffset + s.offset, lib.seqOffset + s.offset + s.length);
	const banks = (lib.bankSets[index] ?? []).map((id) => cache.get(id));
	const fade = 4;
	const r = runM64(seq, banks, { maxSeconds: options.maxSeconds ?? 240, afterLoopSeconds: options.afterLoopSeconds ?? fade });
	if (r.events.length === 0) return null;
	const seconds = Math.max(1, r.length + (r.looped ? 0 : 1.5));
	const audio = renderSeqEvents(r.events, seconds, r.looped ? fade : 0);
	return { wav: encodeStereoWav(audio), seconds, notes: r.events.length };
}
