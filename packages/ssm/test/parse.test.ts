import { describe, expect, it } from 'vitest';

import {
	SSM_CHANNEL_HEADER_SIZE,
	SSM_ENTRY_PREFIX_SIZE,
	SSM_HEADER_SIZE,
	decodeSsmSound,
	isSsm,
	parseSsm,
	ssmDataOffset,
	ssmNibbleToFrameByte,
	ssmNibbleToSample,
} from '../src/index.js';

/**
 * Synthetic SSM builder.
 *
 * Sounds are given a mix of mono and stereo so the variable-length descriptor
 * walk is genuinely exercised — a fixed stride would desynchronise on the first
 * stereo entry and the tests would catch it.
 */

interface SoundSpec {
	channelCount: 1 | 2;
	sampleRate?: number;
	/** Samples per channel. */
	samples: number;
	looped?: boolean;
	/** Per-channel history. */
	history?: [number, number][];
	/** Per-channel coefficients; defaults to a distinguishable ramp. */
	coefficients?: (channel: number) => Int16Array;
	/** Per-channel frame bytes. */
	frames?: (channel: number) => Uint8Array;
}

interface BuildSpec {
	sounds: SoundSpec[];
	baseSoundId?: number;
	/** Override the declared data size, to test rejection. */
	dataSize?: number;
}

/** A DSP-ADPCM frame selecting coefficient pair 0 with scale 0. */
function flatFrame(nibbles: number[]): Uint8Array {
	const out = new Uint8Array(8);
	out[0] = 0x00;
	for (let i = 0; i < 14; i += 2) {
		out[1 + i / 2] = ((nibbles[i] & 0x0f) << 4) | (nibbles[i + 1] & 0x0f);
	}
	return out;
}

function buildSsm(spec: BuildSpec): Uint8Array {
	const framesFor = (samples: number) => Math.ceil(samples / 14);

	// Lay every channel out contiguously, as the real format does.
	type Laid = { spec: SoundSpec; channels: { startNibble: number; endNibble: number; byteAt: number; bytes: number }[] };
	const laid: Laid[] = [];
	let nibble = 2; // audio starts at nibble 2 of frame 0
	let byteAt = 0;
	for (const s of spec.sounds) {
		const channels = [];
		for (let c = 0; c < s.channelCount; c++) {
			const frames = framesFor(s.samples);
			const start = nibble;
			const end = start + (s.samples - 1) + Math.floor((s.samples - 1) / 14) * 2;
			channels.push({ startNibble: start, endNibble: end, byteAt, bytes: frames * 8 });
			byteAt += frames * 8;
			nibble = byteAt * 2 + 2;
		}
		laid.push({ spec: s, channels });
	}

	const entryTableSize = spec.sounds.reduce(
			(a, s) => a + SSM_ENTRY_PREFIX_SIZE + s.channelCount * SSM_CHANNEL_HEADER_SIZE,
		0,
	);
	const dataOffset = ssmDataOffset(entryTableSize);
	const dataSize = spec.dataSize ?? byteAt;

	const out = new Uint8Array(dataOffset + dataSize);
	const view = new DataView(out.buffer);
	view.setUint32(0x00, entryTableSize, false);
	view.setUint32(0x04, dataSize, false);
	view.setUint32(0x08, spec.sounds.length, false);
	view.setUint32(0x0c, spec.baseSoundId ?? 100, false);

	let at = SSM_HEADER_SIZE;
	laid.forEach((l) => {
		view.setUint32(at + 0x00, l.spec.channelCount, false);
		view.setUint32(at + 0x04, l.spec.sampleRate ?? 32000, false);
		l.channels.forEach((ch, c) => {
			const cb = at + SSM_ENTRY_PREFIX_SIZE + c * SSM_CHANNEL_HEADER_SIZE;
			view.setUint16(cb + 0x00, l.spec.looped ? 1 : 0, false);
			view.setUint16(cb + 0x02, 0, false);
			view.setUint32(cb + 0x04, ch.startNibble, false); // loopStart
			view.setUint32(cb + 0x08, ch.endNibble, false);
			view.setUint32(cb + 0x0c, ch.startNibble, false); // current
			const coefs =
				l.spec.coefficients?.(c) ??
				Int16Array.from({ length: 16 }, (_, k) => c * 500 + k);
			for (let k = 0; k < 16; k++) {
				view.setInt16(cb + 0x10 + k * 2, coefs[k], false);
			}
			const h = l.spec.history?.[c] ?? [0, 0];
			view.setUint16(cb + 0x30, 0, false); // gain
			view.setUint16(cb + 0x32, 0, false); // ps
			view.setInt16(cb + 0x34, h[0], false);
			view.setInt16(cb + 0x36, h[1], false);
			const chunk = l.spec.frames?.(c);
			if (chunk) {
				for (let f = 0; f * 8 < ch.bytes; f++) {
					out.set(chunk.subarray(0, 8), dataOffset + ch.byteAt + f * 8);
				}
			}
		});
		at += SSM_ENTRY_PREFIX_SIZE + l.spec.channelCount * SSM_CHANNEL_HEADER_SIZE;
	});

	return out;
}

const MIXED: BuildSpec = {
	sounds: [
		{ channelCount: 1, samples: 28 },
		{ channelCount: 2, samples: 14 },
		{ channelCount: 1, samples: 14, sampleRate: 16000 },
	],
};

describe('nibble addressing', () => {
	it('skips the two header nibbles of every frame', () => {
		// A sound starts at nibble 2 because nibbles 0 and 1 are the frame's
		// predictor/scale byte. Treating a nibble as byte*2 shifts every sound.
		expect(ssmNibbleToSample(2)).toBe(0);
		expect(ssmNibbleToSample(15)).toBe(13);
		// Frame 1 begins at nibble 16, whose first audio nibble is 18.
		expect(ssmNibbleToSample(18)).toBe(14);
		expect(ssmNibbleToSample(16 + 15)).toBe(27);
	});

	it('maps a nibble to its frame boundary', () => {
		expect(ssmNibbleToFrameByte(2)).toBe(0);
		expect(ssmNibbleToFrameByte(15)).toBe(0);
		expect(ssmNibbleToFrameByte(16)).toBe(8);
		expect(ssmNibbleToFrameByte(33)).toBe(16);
	});
});

describe('ssmDataOffset', () => {
	it('aligns the payload up to 32 bytes', () => {
		// Without this the computed start is short by 8-24 bytes and every sound
		// decodes to noise.
		expect(ssmDataOffset(0x120)).toBe(0x140);
		expect(ssmDataOffset(208)).toBe(224);
		expect(ssmDataOffset(0x10)).toBe(0x20);
		// Already aligned inputs are left alone.
		expect(ssmDataOffset(0x30)).toBe(0x40);
	});
});

describe('parseSsm', () => {
	it('reads the header and every descriptor', () => {
		const bank = parseSsm(buildSsm(MIXED))!;
		expect(bank).not.toBeNull();
		expect(bank.soundCount).toBe(3);
		expect(bank.baseSoundId).toBe(100);
		expect(bank.sounds.map((s) => s.id)).toEqual([100, 101, 102]);
		expect(bank.sounds.map((s) => s.channelCount)).toEqual([1, 2, 1]);
		expect(bank.sounds[2].sampleRate).toBe(16000);
	});

	it('walks variable-length descriptors rather than using a fixed stride', () => {
		// Mono is 72 bytes, stereo 136. A fixed stride desynchronises at the
		// stereo entry, which would show up as a wrong channel count or rate on
		// every later sound.
		const bank = parseSsm(buildSsm(MIXED))!;
		const mono = SSM_ENTRY_PREFIX_SIZE + SSM_CHANNEL_HEADER_SIZE;
		const stereo = SSM_ENTRY_PREFIX_SIZE + 2 * SSM_CHANNEL_HEADER_SIZE;
		expect(mono).toBe(72);
		expect(stereo).toBe(136);
		expect(bank.sounds[0].offset).toBe(SSM_HEADER_SIZE);
		expect(bank.sounds[1].offset).toBe(SSM_HEADER_SIZE + mono);
		expect(bank.sounds[2].offset).toBe(SSM_HEADER_SIZE + mono + stereo);
	});

	it('places channel headers after the descriptor prefix', () => {
		const bank = parseSsm(buildSsm(MIXED))!;
		const stereo = bank.sounds[1];
		expect(stereo.channels).toHaveLength(2);
		expect(stereo.channels[0].coefficientsOffset).toBe(
			stereo.offset + SSM_ENTRY_PREFIX_SIZE + 0x10,
		);
		expect(stereo.channels[1].coefficientsOffset).toBe(
			stereo.offset + SSM_ENTRY_PREFIX_SIZE + SSM_CHANNEL_HEADER_SIZE + 0x10,
		);
		// Distinguishable ramps prove the two weren't read from the same place.
		expect([...stereo.channels[0].coefficients].slice(0, 2)).toEqual([0, 1]);
		expect([...stereo.channels[1].coefficients].slice(0, 2)).toEqual([500, 501]);
	});

	it('lays channels out contiguously, one after another', () => {
		const bank = parseSsm(buildSsm(MIXED))!;
		const all = bank.sounds.flatMap((s) => s.channels);
		for (let i = 1; i < all.length; i++) {
			expect(all[i].startNibble).toBeGreaterThan(all[i - 1].endNibble - 1);
			expect(all[i].dataOffset).toBeGreaterThanOrEqual(all[i - 1].dataOffset);
		}
	});

	it('derives sample counts and durations', () => {
		const bank = parseSsm(buildSsm(MIXED))!;
		expect(bank.sounds[0].sampleCount).toBe(28);
		expect(bank.sounds[1].sampleCount).toBe(14);
		expect(bank.sounds[0].durationSeconds).toBeCloseTo(28 / 32000, 6);
	});

	it('rejects a header that does not account for the file exactly', () => {
		// This identity is what makes a magic-less format recognisable, so it has
		// to be enforced rather than assumed.
		const bytes = buildSsm(MIXED);
		const bad = bytes.slice();
		new DataView(bad.buffer).setUint32(0x04, 999999, false);
		expect(parseSsm(bad)).toBeNull();
		expect(parseSsm(bytes.subarray(0, bytes.length - 8))).toBeNull();
	});

	it('rejects implausible counts, channel counts and rates', () => {
		expect(parseSsm(new Uint8Array(SSM_HEADER_SIZE))).toBeNull();
		const zero = buildSsm(MIXED);
		new DataView(zero.buffer).setUint32(0x08, 0, false);
		expect(parseSsm(zero)).toBeNull();

		const badCh = buildSsm(MIXED);
		new DataView(badCh.buffer).setUint32(SSM_HEADER_SIZE, 7, false);
		expect(parseSsm(badCh)).toBeNull();

		const badRate = buildSsm(MIXED);
		new DataView(badRate.buffer).setUint32(SSM_HEADER_SIZE + 4, 10, false);
		expect(parseSsm(badRate)).toBeNull();
	});

	it('rejects a channel whose nibble range escapes the payload', () => {
		const bytes = buildSsm(MIXED);
		const bad = bytes.slice();
		// Push the first channel's end far past the data.
		new DataView(bad.buffer).setUint32(SSM_HEADER_SIZE + SSM_ENTRY_PREFIX_SIZE + 0x08, 0x7ffffff0, false);
		expect(parseSsm(bad)).toBeNull();
	});

	it('rejects an entry table too small for its sound count', () => {
		// Claim more sounds than the declared table could possibly describe. The
		// size identity is untouched, so this exercises the minimum-table check
		// specifically rather than tripping an earlier guard.
		const bad = buildSsm(MIXED);
		new DataView(bad.buffer).setUint32(0x08, 500, false);
		expect(parseSsm(bad)).toBeNull();
	});
});

describe('isSsm', () => {
	it('accepts a consistent bank and rejects other data', () => {
		expect(isSsm(buildSsm(MIXED))).toBe(true);
		const hps = new Uint8Array(256);
		for (let i = 0; i < 8; i++) hps[i] = ' HALPST\0'.charCodeAt(i);
		expect(isSsm(hps)).toBe(false);
		expect(isSsm(new Uint8Array(256))).toBe(false);
		expect(isSsm(new Uint8Array(256).fill(0xff))).toBe(false);
	});
});

describe('decodeSsmSound', () => {
	const zeroCoefs = () => new Int16Array(16);

	it('decodes to interleaved PCM and keeps channels distinct', () => {
		// Zeroed coefficients with scale 0 make each output sample the
		// sign-extended nibble, so the expected PCM is exact.
		const bytes = buildSsm({
			sounds: [
				{
					channelCount: 2,
					samples: 14,
					coefficients: zeroCoefs,
					frames: (c) =>
						flatFrame(
							c === 0
								? [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]
								: [7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1],
						),
				},
			],
		});
		const bank = parseSsm(bytes)!;
		const d = decodeSsmSound(bytes, bank.sounds[0])!;
		expect(d.channelCount).toBe(2);
		expect(d.sampleCount).toBe(14);
		expect(d.samples).toHaveLength(28);
		expect(d.samples[0]).toBe(1);
		expect(d.samples[1]).toBe(7);
		expect(d.samples[2]).toBe(2);
		expect(d.samples[3]).toBe(6);
	});

	it('honours the stored history', () => {
		const bytes = buildSsm({
			sounds: [
				{
					channelCount: 1,
					samples: 14,
					coefficients: () =>
						Int16Array.from({ length: 16 }, (_, k) => (k === 0 ? 2048 : 0)),
					history: [[100, 0]],
					frames: () => flatFrame(new Array(14).fill(0)),
				},
			],
		});
		const bank = parseSsm(bytes)!;
		expect(bank.sounds[0].channels[0].yn1).toBe(100);
		const d = decodeSsmSound(bytes, bank.sounds[0])!;
		// Coefficient pair 0 is [1.0, 0] and the nibbles are zero, so output
		// holds at the seeded history.
		expect(d.samples[0]).toBe(100);
	});

	it('returns a mono buffer without interleaving', () => {
		const bytes = buildSsm({ sounds: [{ channelCount: 1, samples: 28 }] });
		const bank = parseSsm(bytes)!;
		const d = decodeSsmSound(bytes, bank.sounds[0])!;
		expect(d.channelCount).toBe(1);
		expect(d.samples).toHaveLength(d.sampleCount);
	});

	it('keeps the sample buffer divisible by the channel count', () => {
		// The invariant `encodeWav` enforces.
		const bytes = buildSsm(MIXED);
		const bank = parseSsm(bytes)!;
		for (const sound of bank.sounds) {
			const d = decodeSsmSound(bytes, sound)!;
			expect(d.samples.length % d.channelCount).toBe(0);
			expect(d.samples.length).toBe(d.sampleCount * d.channelCount);
		}
	});
});
