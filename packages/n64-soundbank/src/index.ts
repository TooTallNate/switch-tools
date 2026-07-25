/**
 * N64 SDK sound banks (`.ctl` / `.tbl`).
 *
 * Games built on the stock N64 audio library keep their sampled
 * audio in a pair of parallel files, usually embedded directly in
 * the ROM:
 *
 *   ctl   bank definitions — instruments, drums, envelopes, and per
 *         sample a VADPCM codebook and loop descriptor
 *   tbl   the raw VADPCM frames the ctl's samples point into
 *
 * Both are *self-describing containers*, which is what makes them
 * findable without hardcoding per-region ROM offsets:
 *
 *   +0x00  u16  magic — 1 for ctl, 2 for tbl
 *   +0x02  u16  entry count
 *   +0x04  (u32 offset, u32 length) per entry
 *
 * Entry *i* of the ctl is a bank, and entry *i* of the tbl holds
 * that bank's waveform data. The ctl's offsets are strictly
 * contiguous (each equals the running end, 16-byte aligned), while
 * the tbl's may repeat because banks can share a waveform set — a
 * distinction worth honouring, since it makes the ctl's header a
 * very precise signature.
 *
 * Each ctl entry begins with a 16-byte bank header:
 *
 *   +0x00  u32  instrument count
 *   +0x04  u32  drum count
 *   +0x08  u32  shared flag (0 or 1)
 *   +0x0C  u32  build date, BCD
 *
 * and all offsets inside the bank are relative to the byte *after*
 * that header.
 *
 * ## Sample entries
 *
 * This is where the format bites: the sample struct differs between
 * game families even though both use the same codec.
 *
 *   Super Mario 64 (and other stock-library titles) — 20 bytes:
 *     +0x00  u32  always zero
 *     +0x04  u32  offset of the frames within the tbl bank
 *     +0x08  u32  offset of the loop descriptor within the ctl bank
 *     +0x0C  u32  offset of the codebook within the ctl bank
 *     +0x10  u32  size of the frames in bytes
 *
 *   Zelda 64 — 16 bytes, with codec/size packed into the first word
 *   and no trailing size. Handled by `@tootallnate/z64-audio`.
 *
 * The leading zero word is a useful anchor when scanning, and is
 * asserted by the Super Mario 64 decompilation's own extraction
 * tooling.
 *
 * Verified against Super Mario 64 (USA): the ctl container is
 * uniquely identifiable in the ROM, and the 38 bank pairs yield 462
 * samples / ~260 seconds of audio that decode with essentially no
 * clamping.
 *
 * References:
 *   - N64 SDK audio library (`ALBank`, `ALWaveTable`, `ALADPCMBook`)
 *   - n64decomp/sm64 `tools/disassemble_sound.py` (container and
 *     struct layouts), `assets.json` (per-region ROM offsets)
 */

import {
	VADPCM_FRAME_SIZE,
	VADPCM_SAMPLES_PER_FRAME,
	decodeVadpcm,
	parseVadpcmBook,
	type VadpcmBook,
	type VadpcmDecodeResult,
} from '@tootallnate/vadpcm';

/** Container magic for a bank-definition (`.ctl`) file. */
export const CTL_MAGIC = 1;
/** Container magic for a waveform-data (`.tbl`) file. */
export const TBL_MAGIC = 2;

/** Bytes in a Super Mario 64-style sample entry. */
export const SAMPLE_ENTRY_SIZE = 20;

/** Bytes in the per-bank header at the start of each ctl entry. */
export const BANK_HEADER_SIZE = 16;

/**
 * Nominal playback rate.
 *
 * Individual samples are resampled at runtime to whatever pitch the
 * instrument requests — the recorded rate lives in the instrument's
 * tuning field, not the sample. 32 kHz (the RSP's mix rate) is a
 * convention for previewing, so a sample may sound transposed.
 */
export const NOMINAL_SAMPLE_RATE = 32000;

function readU16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] << 24) |
			(bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) |
			bytes[offset + 3]) >>>
		0
	);
}

function alignUp(value: number, alignment: number): number {
	return Math.ceil(value / alignment) * alignment;
}

/** One entry in a ctl or tbl container. */
export interface BankEntry {
	offset: number;
	length: number;
}

/** A parsed ctl or tbl container. */
export interface SoundBankContainer {
	magic: number;
	entries: BankEntry[];
	/** Total bytes spanned, including the index. */
	size: number;
}

/**
 * Parse a container at `offset`.
 *
 * Returns `null` when the bytes are not a container of the requested
 * kind. The structural rules are strict enough to serve as a
 * detector: the entry count is bounded, every entry must fit inside
 * the buffer, and the offsets must follow the contiguity rule for
 * the container's kind.
 */
export function parseContainer(
	bytes: Uint8Array,
	offset: number,
	magic: number,
): SoundBankContainer | null {
	if (offset < 0 || offset + 4 > bytes.length) return null;
	if (readU16(bytes, offset) !== magic) return null;
	const count = readU16(bytes, offset + 2);
	// A stock ROM has a few dozen banks; anything wilder is noise.
	if (count < 1 || count > 128) return null;
	if (offset + 4 + count * 8 > bytes.length) return null;

	let runningEnd = alignUp(4 + count * 8, 16);
	const entries: BankEntry[] = [];
	const available = bytes.length - offset;
	for (let i = 0; i < count; i++) {
		const entryOffset = readU32(bytes, offset + 4 + i * 8);
		const entryLength = readU32(bytes, offset + 8 + i * 8);
		if (magic === CTL_MAGIC) {
			// ctl entries are strictly contiguous.
			if (entryOffset !== runningEnd) return null;
		} else {
			// tbl entries may repeat when banks share waveforms.
			if (entryOffset > runningEnd) return null;
		}
		if (entryLength === 0) return null;
		if (entryOffset + entryLength > available) return null;
		runningEnd = Math.max(runningEnd, entryOffset + entryLength);
		entries.push({ offset: entryOffset, length: entryLength });
	}
	return { magic, entries, size: runningEnd };
}

/** A located ctl/tbl pair. */
export interface SoundBankPair {
	ctlOffset: number;
	ctl: SoundBankContainer;
	tblOffset: number;
	tbl: SoundBankContainer;
}

export interface FindSoundBanksOptions {
	/** Scan stride in bytes (default 4; containers are word-aligned). */
	alignment?: number;
	/** Ignore containers with fewer entries than this (default 2). */
	minBanks?: number;
	/** Ignore containers smaller than this many bytes (default 4096). */
	minSize?: number;
}

/**
 * Locate the ctl/tbl pair in a ROM.
 *
 * Both containers are found by their magic, then matched on entry
 * count — a bank definition must have exactly one waveform set per
 * bank. That pairing is what disambiguates the tbl, whose looser
 * offset rule admits occasional false positives on its own.
 *
 * Returns `null` when no consistent pair exists, which is the
 * expected outcome for games that don't use the stock library.
 */
export function findSoundBanks(
	rom: Uint8Array,
	options: FindSoundBanksOptions = {},
): SoundBankPair | null {
	const alignment = Math.max(1, options.alignment ?? 4);
	const minBanks = options.minBanks ?? 2;
	const minSize = options.minSize ?? 4096;

	const collect = (magic: number) => {
		const found: Array<{ offset: number; container: SoundBankContainer }> = [];
		for (let offset = 0; offset + 4 <= rom.length; offset += alignment) {
			if (readU16(rom, offset) !== magic) continue;
			const container = parseContainer(rom, offset, magic);
			if (!container) continue;
			if (container.entries.length < minBanks) continue;
			if (container.size < minSize) continue;
			found.push({ offset, container });
		}
		return found;
	};

	const ctls = collect(CTL_MAGIC);
	if (ctls.length === 0) return null;
	const tbls = collect(TBL_MAGIC);
	if (tbls.length === 0) return null;

	// Prefer the largest ctl, then the tbl with a matching bank count.
	ctls.sort((a, b) => b.container.size - a.container.size);
	for (const ctl of ctls) {
		const wanted = ctl.container.entries.length;
		const matches = tbls.filter(
			(t) => t.container.entries.length === wanted,
		);
		if (matches.length === 0) continue;
		// The waveform data dwarfs the definitions, so on a tie take
		// the biggest.
		matches.sort((a, b) => b.container.size - a.container.size);
		return {
			ctlOffset: ctl.offset,
			ctl: ctl.container,
			tblOffset: matches[0].offset,
			tbl: matches[0].container,
		};
	}
	return null;
}

/** Header at the start of each ctl entry. */
export interface BankHeader {
	instrumentCount: number;
	drumCount: number;
	shared: boolean;
}

/** Read a bank's 16-byte header. */
export function parseBankHeader(
	bytes: Uint8Array,
	offset = 0,
): BankHeader | null {
	if (offset + BANK_HEADER_SIZE > bytes.length) return null;
	const instrumentCount = readU32(bytes, offset);
	const drumCount = readU32(bytes, offset + 4);
	const shared = readU32(bytes, offset + 8);
	if (shared > 1) return null;
	if (instrumentCount > 256 || drumCount > 256) return null;
	return { instrumentCount, drumCount, shared: shared === 1 };
}

/** A loop descriptor. */
export interface SampleLoop {
	start: number;
	end: number;
	/** 0 for a one-shot sample. */
	count: number;
	/** Decoder state priming the loop point, when the sample loops. */
	state: Int16Array | null;
}

/** Read a loop descriptor from bank data. */
export function parseSampleLoop(
	bank: Uint8Array,
	offset: number,
): SampleLoop | null {
	if (offset < 0 || offset + 16 > bank.length) return null;
	const start = readU32(bank, offset);
	const end = readU32(bank, offset + 4);
	const count = readU32(bank, offset + 8);
	let state: Int16Array | null = null;
	if (count !== 0 && offset + 16 + 32 <= bank.length) {
		state = new Int16Array(16);
		for (let i = 0; i < 16; i++) {
			const o = offset + 16 + i * 2;
			const v = (bank[o] << 8) | bank[o + 1];
			state[i] = v >= 0x8000 ? v - 0x10000 : v;
		}
	}
	return { start, end, count, state };
}

/** A sample found in a bank. */
export interface BankSample {
	/** Offset of the sample entry within the bank data. */
	entryOffset: number;
	/** Offset of the frames within the bank's waveform data. */
	dataOffset: number;
	/** Compressed size in bytes. */
	size: number;
	book: VadpcmBook;
	bookOffset: number;
	loop: SampleLoop | null;
	loopOffset: number;
	/** Decoded sample count implied by `size`. */
	sampleCount: number;
}

export interface ScanBankSamplesOptions {
	/** Smallest compressed size to accept (default 32). */
	minSize?: number;
	/** Largest compressed size to accept (default 1 MiB). */
	maxSize?: number;
	/**
	 * Verify each candidate by decoding it (default true).
	 *
	 * VADPCM paired with the wrong codebook saturates rather than
	 * failing, and since it barely clamps at all when correct, the
	 * clamp ratio is a decisive filter.
	 */
	validate?: boolean;
	/** Maximum tolerated clamped-sample fraction (default 0.005). */
	maxClampRatio?: number;
}

/**
 * Find the samples in one bank.
 *
 * `bank` is a ctl entry with its 16-byte header already removed —
 * all offsets inside a bank are relative to that point. `waveforms`
 * is the paired tbl entry.
 */
export function scanBankSamples(
	bank: Uint8Array,
	waveforms: Uint8Array,
	options: ScanBankSamplesOptions = {},
): BankSample[] {
	const minSize = options.minSize ?? 32;
	const maxSize = options.maxSize ?? 1024 * 1024;
	const validate = options.validate ?? true;
	const maxClampRatio = options.maxClampRatio ?? 0.005;

	const out: BankSample[] = [];
	const seen = new Set<number>();

	for (let offset = 0; offset + SAMPLE_ENTRY_SIZE <= bank.length; offset += 4) {
		// The leading word of a sample entry is always zero.
		if (readU32(bank, offset) !== 0) continue;
		const dataOffset = readU32(bank, offset + 4);
		const loopOffset = readU32(bank, offset + 8);
		const bookOffset = readU32(bank, offset + 12);
		const size = readU32(bank, offset + 16);

		if (size < minSize || size > maxSize) continue;
		if (dataOffset + size > waveforms.length) continue;
		// Neither pointer is ever null on a usable sample.
		if (loopOffset === 0 || loopOffset + 16 > bank.length) continue;
		if (bookOffset === 0 || bookOffset + 8 > bank.length) continue;

		const book = parseVadpcmBook(bank, bookOffset);
		if (!book || book.order !== 2) continue;
		if (seen.has(dataOffset)) continue;

		const sampleCount =
			Math.floor(size / VADPCM_FRAME_SIZE) * VADPCM_SAMPLES_PER_FRAME;

		// Sanitise rather than reject a bad loop descriptor: the loop
		// pointer is the weakest field, and discarding samples over it
		// throws away audio that decodes perfectly.
		let loop = parseSampleLoop(bank, loopOffset);
		if (
			loop &&
			(loop.start > loop.end ||
				loop.end > sampleCount ||
				(loop.count > 0xffff && loop.count !== 0xffffffff))
		) {
			loop = null;
		}

		const candidate: BankSample = {
			entryOffset: offset,
			dataOffset,
			size,
			book,
			bookOffset,
			loop,
			loopOffset,
			sampleCount,
		};

		if (validate) {
			const decoded = decodeBankSample(waveforms, candidate);
			if (decoded.samples.length === 0) continue;
			if (decoded.clamped / decoded.samples.length > maxClampRatio) continue;
		}

		seen.add(dataOffset);
		out.push(candidate);
	}
	return out;
}

/** Decode one sample's frames from its bank's waveform data. */
export function decodeBankSample(
	waveforms: Uint8Array,
	sample: BankSample,
): VadpcmDecodeResult {
	const end = Math.min(waveforms.length, sample.dataOffset + sample.size);
	return decodeVadpcm(waveforms.subarray(sample.dataOffset, end), sample.book);
}

/** A sample together with the bank it came from. */
export interface LocatedSample extends BankSample {
	/** Index of the bank within the ctl/tbl containers. */
	bankIndex: number;
	/** The bank's waveform data, for decoding. */
	waveforms: Uint8Array;
}

/**
 * Walk every bank in a located ctl/tbl pair and return all samples.
 *
 * Each result carries the waveform slice it decodes against, so
 * callers can decode lazily without re-deriving bank boundaries.
 */
export function scanAllSamples(
	rom: Uint8Array,
	pair: SoundBankPair,
	options: ScanBankSamplesOptions = {},
): LocatedSample[] {
	const out: LocatedSample[] = [];
	const bankCount = Math.min(pair.ctl.entries.length, pair.tbl.entries.length);
	for (let i = 0; i < bankCount; i++) {
		const ctlEntry = pair.ctl.entries[i];
		const tblEntry = pair.tbl.entries[i];
		const bankStart = pair.ctlOffset + ctlEntry.offset;
		// Offsets inside a bank are relative to just past its header.
		const bank = rom.subarray(
			bankStart + BANK_HEADER_SIZE,
			bankStart + ctlEntry.length,
		);
		const waveforms = rom.subarray(
			pair.tblOffset + tblEntry.offset,
			pair.tblOffset + tblEntry.offset + tblEntry.length,
		);
		for (const sample of scanBankSamples(bank, waveforms, options)) {
			out.push({ ...sample, bankIndex: i, waveforms });
		}
	}
	return out;
}

/** Encode 16-bit mono PCM as a RIFF/WAVE file. */
export function encodeWav(
	samples: Int16Array,
	sampleRate = NOMINAL_SAMPLE_RATE,
): Uint8Array {
	const dataBytes = samples.length * 2;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const tag = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			out[offset + i] = text.charCodeAt(i);
		}
	};
	tag(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, 'data');
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < samples.length; i++) {
		view.setInt16(44 + i * 2, samples[i], true);
	}
	return out;
}
