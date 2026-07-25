import { describe, it, expect } from 'vitest';
import {
	BANK_HEADER_SIZE,
	CTL_MAGIC,
	NOMINAL_SAMPLE_RATE,
	SAMPLE_ENTRY_SIZE,
	TBL_MAGIC,
	decodeBankSample,
	encodeWav,
	findSoundBanks,
	parseBankHeader,
	parseContainer,
	parseSampleLoop,
	scanAllSamples,
	scanBankSamples,
} from '../src/index.js';

const w32 = (buf: Uint8Array, o: number, v: number) => {
	buf[o] = (v >>> 24) & 0xff;
	buf[o + 1] = (v >>> 16) & 0xff;
	buf[o + 2] = (v >>> 8) & 0xff;
	buf[o + 3] = v & 0xff;
};
const w16 = (buf: Uint8Array, o: number, v: number) => {
	buf[o] = (v >>> 8) & 0xff;
	buf[o + 1] = v & 0xff;
};
const alignUp = (v: number, a: number) => Math.ceil(v / a) * a;

/**
 * Build a container index. `contiguous` mirrors the ctl rule (each
 * entry starts at the running end); otherwise entries are written
 * verbatim, as the looser tbl rule allows.
 */
function writeContainer(
	buf: Uint8Array,
	base: number,
	magic: number,
	lengths: number[],
): number[] {
	w16(buf, base, magic);
	w16(buf, base + 2, lengths.length);
	let cursor = alignUp(4 + lengths.length * 8, 16);
	const offsets: number[] = [];
	lengths.forEach((len, i) => {
		w32(buf, base + 4 + i * 8, cursor);
		w32(buf, base + 8 + i * 8, len);
		offsets.push(cursor);
		cursor += len;
	});
	return offsets;
}

/**
 * Build a ctl/tbl pair inside a fake ROM.
 *
 * Bank layout (offsets relative to just past the 16-byte header):
 *   0x40  sample entries (20 bytes each)
 *   0x200 codebooks
 *   0x300 loop descriptors
 *
 * Codebooks are all-zero, so a decoded sample is exactly
 * `residual << scale` and the decode path is checkable.
 */
function buildRom(opts: {
	banks?: number;
	samplesPerBank?: number;
	frames?: number;
	loopCount?: number;
} = {}) {
	const banks = opts.banks ?? 2;
	const samplesPerBank = opts.samplesPerBank ?? 2;
	const frames = opts.frames ?? 4;
	const sampleBytes = frames * 9;

	const bankLen = 0x400;
	const waveLen = alignUp(samplesPerBank * sampleBytes + 0x40, 16);
	const ctlBase = 0x1000;
	const ctlSpan = alignUp(4 + banks * 8, 16) + banks * bankLen;
	const tblBase = ctlBase + ctlSpan + 0x1000;
	const tblSpan = alignUp(4 + banks * 8, 16) + banks * waveLen;
	const rom = new Uint8Array(tblBase + tblSpan + 0x1000);

	const ctlOffsets = writeContainer(
		rom,
		ctlBase,
		CTL_MAGIC,
		new Array(banks).fill(bankLen),
	);
	const tblOffsets = writeContainer(
		rom,
		tblBase,
		TBL_MAGIC,
		new Array(banks).fill(waveLen),
	);

	for (let b = 0; b < banks; b++) {
		const entryBase = ctlBase + ctlOffsets[b];
		// Bank header: instruments, drums, shared, date.
		w32(rom, entryBase, samplesPerBank);
		w32(rom, entryBase + 4, 0);
		w32(rom, entryBase + 8, 0);
		const bank = entryBase + BANK_HEADER_SIZE;
		const wave = tblBase + tblOffsets[b];

		for (let s = 0; s < samplesPerBank; s++) {
			const entry = 0x40 + s * SAMPLE_ENTRY_SIZE;
			const bookOff = 0x200 + s * 0x40;
			const loopOff = 0x300 + s * 0x40;
			const dataOff = 0x40 + s * sampleBytes;

			// Sample entry: zero, addr, loop, book, size.
			w32(rom, bank + entry, 0);
			w32(rom, bank + entry + 4, dataOff);
			w32(rom, bank + entry + 8, loopOff);
			w32(rom, bank + entry + 12, bookOff);
			w32(rom, bank + entry + 16, sampleBytes);

			// Codebook: order 2, 1 predictor, zero coefficients.
			w32(rom, bank + bookOff, 2);
			w32(rom, bank + bookOff + 4, 1);

			// Loop descriptor.
			w32(rom, bank + loopOff, 0);
			w32(rom, bank + loopOff + 4, frames * 16);
			w32(rom, bank + loopOff + 8, opts.loopCount ?? 0);

			// Frames: scale 1, predictor 0, residual 2 everywhere →
			// every decoded sample is 4.
			for (let f = 0; f < frames; f++) {
				const o = wave + dataOff + f * 9;
				rom[o] = 0x10;
				for (let k = 1; k < 9; k++) rom[o + k] = 0x22;
			}
		}
	}
	return { rom, ctlBase, tblBase, banks, samplesPerBank, frames };
}

describe('parseContainer', () => {
	it('parses a ctl container', () => {
		const { rom, ctlBase, banks } = buildRom();
		const c = parseContainer(rom, ctlBase, CTL_MAGIC)!;
		expect(c.magic).toBe(CTL_MAGIC);
		expect(c.entries.length).toBe(banks);
		expect(c.entries[0].offset).toBe(alignUp(4 + banks * 8, 16));
	});

	it('parses a tbl container', () => {
		const { rom, tblBase, banks } = buildRom();
		expect(parseContainer(rom, tblBase, TBL_MAGIC)!.entries.length).toBe(banks);
	});

	it('rejects the wrong magic', () => {
		const { rom, ctlBase } = buildRom();
		expect(parseContainer(rom, ctlBase, TBL_MAGIC)).toBeNull();
	});

	it('enforces ctl contiguity but allows tbl sharing', () => {
		const { rom, ctlBase, banks } = buildRom({ banks: 2 });
		// Point entry 1 back at entry 0's data — two banks sharing one
		// waveform set. Legal for a tbl, illegal for a ctl (whose
		// entries must each start at the running end).
		const firstOffset = alignUp(4 + banks * 8, 16);
		w32(rom, ctlBase + 4 + 8, firstOffset);
		expect(parseContainer(rom, ctlBase, CTL_MAGIC)).toBeNull();
		w16(rom, ctlBase, TBL_MAGIC);
		expect(parseContainer(rom, ctlBase, TBL_MAGIC)).not.toBeNull();
	});

	it('rejects a tbl entry that starts past the running end', () => {
		const { rom, tblBase, banks } = buildRom({ banks: 2 });
		const firstOffset = alignUp(4 + banks * 8, 16);
		// A gap is not allowed even under the looser tbl rule.
		w32(rom, tblBase + 4 + 8, firstOffset + 0x10000);
		expect(parseContainer(rom, tblBase, TBL_MAGIC)).toBeNull();
	});

	it('rejects an entry that runs past the buffer', () => {
		const { rom, ctlBase } = buildRom({ banks: 1 });
		w32(rom, ctlBase + 8, 0x7fffffff);
		expect(parseContainer(rom, ctlBase, CTL_MAGIC)).toBeNull();
	});

	it('rejects implausible entry counts', () => {
		const buf = new Uint8Array(256);
		w16(buf, 0, CTL_MAGIC);
		w16(buf, 2, 0);
		expect(parseContainer(buf, 0, CTL_MAGIC)).toBeNull();
		w16(buf, 2, 999);
		expect(parseContainer(buf, 0, CTL_MAGIC)).toBeNull();
	});
});

describe('findSoundBanks', () => {
	it('locates a ctl/tbl pair and matches them by bank count', () => {
		const { rom, ctlBase, tblBase, banks } = buildRom({ banks: 3 });
		const pair = findSoundBanks(rom, { minSize: 64 })!;
		expect(pair.ctlOffset).toBe(ctlBase);
		expect(pair.tblOffset).toBe(tblBase);
		expect(pair.ctl.entries.length).toBe(banks);
		expect(pair.tbl.entries.length).toBe(banks);
	});

	it('returns null when there is no ctl', () => {
		const rom = new Uint8Array(4096);
		expect(findSoundBanks(rom)).toBeNull();
	});

	it('returns null when no tbl has a matching bank count', () => {
		const { rom, tblBase } = buildRom({ banks: 3 });
		// Corrupt the tbl's magic so no candidate can pair.
		w16(rom, tblBase, 0x1234);
		expect(findSoundBanks(rom, { minSize: 64 })).toBeNull();
	});
});

describe('parseBankHeader', () => {
	it('reads counts and the shared flag', () => {
		const buf = new Uint8Array(32);
		w32(buf, 0, 12);
		w32(buf, 4, 3);
		w32(buf, 8, 1);
		const h = parseBankHeader(buf)!;
		expect(h.instrumentCount).toBe(12);
		expect(h.drumCount).toBe(3);
		expect(h.shared).toBe(true);
	});

	it('rejects an implausible header', () => {
		const buf = new Uint8Array(32);
		w32(buf, 8, 7); // shared must be 0 or 1
		expect(parseBankHeader(buf)).toBeNull();
		w32(buf, 8, 0);
		w32(buf, 0, 9999); // absurd instrument count
		expect(parseBankHeader(buf)).toBeNull();
	});

	it('returns null when truncated', () => {
		expect(parseBankHeader(new Uint8Array(8))).toBeNull();
	});
});

describe('parseSampleLoop', () => {
	it('reads a one-shot descriptor', () => {
		const { rom, ctlBase } = buildRom({ loopCount: 0 });
		const bank = rom.subarray(
			ctlBase + alignUp(4 + 2 * 8, 16) + BANK_HEADER_SIZE,
		);
		const loop = parseSampleLoop(bank, 0x300)!;
		expect(loop.count).toBe(0);
		expect(loop.state).toBeNull();
	});

	it('reads loop state when the sample loops', () => {
		const { rom, ctlBase } = buildRom({ loopCount: 3 });
		const bankStart = ctlBase + alignUp(4 + 2 * 8, 16) + BANK_HEADER_SIZE;
		rom[bankStart + 0x300 + 16] = 0x0a;
		rom[bankStart + 0x300 + 17] = 0x0b;
		const loop = parseSampleLoop(rom.subarray(bankStart), 0x300)!;
		expect(loop.count).toBe(3);
		expect(loop.state!.length).toBe(16);
		expect(loop.state![0]).toBe(0x0a0b);
	});

	it('returns null when out of range', () => {
		expect(parseSampleLoop(new Uint8Array(8), 0)).toBeNull();
	});
});

describe('scanBankSamples', () => {
	function bankAndWaves(built: ReturnType<typeof buildRom>, index = 0) {
		const { rom, ctlBase, tblBase, banks } = built;
		const idxSize = alignUp(4 + banks * 8, 16);
		const bankLen = 0x400;
		const waveLen = alignUp(built.samplesPerBank * built.frames * 9 + 0x40, 16);
		const bankStart = ctlBase + idxSize + index * bankLen;
		const waveStart = tblBase + idxSize + index * waveLen;
		return {
			bank: rom.subarray(bankStart + BANK_HEADER_SIZE, bankStart + bankLen),
			waves: rom.subarray(waveStart, waveStart + waveLen),
		};
	}

	it('finds the 20-byte sample entries', () => {
		const built = buildRom({ samplesPerBank: 3 });
		const { bank, waves } = bankAndWaves(built);
		const samples = scanBankSamples(bank, waves);
		expect(samples.length).toBe(3);
		for (const s of samples) {
			expect(s.book.order).toBe(2);
			expect(s.sampleCount).toBe(built.frames * 16);
		}
	});

	it('requires the leading zero word', () => {
		const built = buildRom({ samplesPerBank: 1 });
		const { bank, waves } = bankAndWaves(built);
		// Non-zero first word disqualifies the entry.
		bank[0x40] = 1;
		expect(scanBankSamples(bank, waves)).toEqual([]);
	});

	it('rejects null loop or book pointers', () => {
		for (const field of [8, 12]) {
			const built = buildRom({ samplesPerBank: 1 });
			const { bank, waves } = bankAndWaves(built);
			bank.fill(0, 0x40 + field, 0x40 + field + 4);
			expect(scanBankSamples(bank, waves)).toEqual([]);
		}
	});

	it('rejects data that overruns the waveform bank', () => {
		const built = buildRom({ samplesPerBank: 1 });
		const { bank } = bankAndWaves(built);
		expect(scanBankSamples(bank, new Uint8Array(8))).toEqual([]);
	});

	it('rejects a codebook offset that is not a codebook', () => {
		const built = buildRom({ samplesPerBank: 1 });
		const { bank, waves } = bankAndWaves(built);
		bank.fill(0, 0x200, 0x208);
		expect(scanBankSamples(bank, waves)).toEqual([]);
	});

	it('honours size bounds', () => {
		const built = buildRom({ samplesPerBank: 1, frames: 4 });
		const { bank, waves } = bankAndWaves(built);
		expect(scanBankSamples(bank, waves, { minSize: 1000 })).toEqual([]);
		expect(scanBankSamples(bank, waves, { maxSize: 4 })).toEqual([]);
	});

	it('sanitises an implausible loop instead of dropping the sample', () => {
		const built = buildRom({ samplesPerBank: 1 });
		const { bank, waves } = bankAndWaves(built);
		// A loop count in the hundreds of millions is nonsense, but
		// the audio itself is fine and must survive.
		w32(bank, 0x300 + 8, 0x0f400f12);
		const samples = scanBankSamples(bank, waves);
		expect(samples.length).toBe(1);
		expect(samples[0].loop).toBeNull();
	});
});

describe('decodeBankSample', () => {
	it('decodes through the sample codebook', () => {
		const built = buildRom({ samplesPerBank: 1, frames: 4 });
		const idxSize = alignUp(4 + built.banks * 8, 16);
		const bankStart = built.ctlBase + idxSize;
		const waveStart = built.tblBase + idxSize;
		const bank = built.rom.subarray(
			bankStart + BANK_HEADER_SIZE,
			bankStart + 0x400,
		);
		const waves = built.rom.subarray(waveStart, waveStart + 0x200);
		const sample = scanBankSamples(bank, waves)[0];
		const decoded = decodeBankSample(waves, sample);
		expect(decoded.samples.length).toBe(64);
		// Zero codebook, scale 1, residual 2 → 4 everywhere.
		expect(Array.from(decoded.samples.subarray(0, 8))).toEqual(
			new Array(8).fill(4),
		);
		expect(decoded.clamped).toBe(0);
	});
});

describe('scanAllSamples', () => {
	it('walks every bank in a located pair', () => {
		const built = buildRom({ banks: 3, samplesPerBank: 2 });
		const pair = findSoundBanks(built.rom, { minSize: 64 })!;
		const samples = scanAllSamples(built.rom, pair);
		expect(samples.length).toBe(6);
		expect(new Set(samples.map((s) => s.bankIndex))).toEqual(
			new Set([0, 1, 2]),
		);
		// Each carries the waveform slice it decodes against.
		for (const s of samples) {
			expect(decodeBankSample(s.waveforms, s).samples.length).toBeGreaterThan(0);
		}
	});
});

describe('encodeWav', () => {
	it('writes a RIFF/WAVE header', () => {
		const wav = encodeWav(Int16Array.from([0, 500, -500]));
		const text = (o: number, n: number) =>
			String.fromCharCode(...wav.subarray(o, o + n));
		expect(text(0, 4)).toBe('RIFF');
		expect(text(8, 4)).toBe('WAVE');
		expect(wav.length).toBe(44 + 6);
		const view = new DataView(wav.buffer);
		expect(view.getUint32(24, true)).toBe(NOMINAL_SAMPLE_RATE);
		expect(view.getInt16(46, true)).toBe(500);
		expect(view.getInt16(48, true)).toBe(-500);
	});
});
