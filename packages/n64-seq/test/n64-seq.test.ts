import { describe, expect, it } from 'vitest';
import { encodeStereoWav, parseSeqBank, renderSeqEvents, runM64 } from '../src/index.js';

/**
 * A bank with one instrument whose normal sound is a 2-frame VADPCM
 * sample (order 2, 1 predictor, zero coefficients: frames decode to
 * their raw nibbles × scale).
 */
function bankFixture(): { entry: Uint8Array; tbl: Uint8Array } {
	const entry = new Uint8Array(16 + 0x100);
	const dv = new DataView(entry.buffer);
	dv.setUint32(0, 1); // instruments
	dv.setUint32(4, 0); // drums
	const D = 16;
	dv.setUint32(D + 4, 0x10); // inst[0]
	// instrument @0x10: loaded, lo 0, hi 127, release 0x20, envelope @0x40, sounds
	entry.set([0, 0, 127, 0x20], D + 0x10);
	dv.setUint32(D + 0x14, 0x40);
	dv.setUint32(D + 0x20, 0x50); // normal sound: sample @0x50
	dv.setFloat32(D + 0x24, 1);
	// envelope: ramp to full over 1 update, hang
	dv.setUint16(D + 0x40, 1);
	dv.setUint16(D + 0x42, 32767);
	dv.setUint16(D + 0x44, 0xffff);
	// sample @0x50: 0, tbl offset 0, loop @0x70, book @0x80, size 18
	dv.setUint32(D + 0x54, 0);
	dv.setUint32(D + 0x58, 0x70);
	dv.setUint32(D + 0x5c, 0x80);
	dv.setUint32(D + 0x60, 18);
	dv.setUint32(D + 0x80, 2); // order
	dv.setUint32(D + 0x84, 1); // npredictors
	const tbl = new Uint8Array(18);
	tbl[0] = 0x40; // scale 2^4, predictor 0
	tbl.fill(0x77, 1, 9);
	tbl[9] = 0x40;
	tbl.fill(0x77, 10, 18);
	return { entry, tbl };
}

/**
 * Sequence: tempo 120, start channel 0 at 0x20, delay 96, end.
 * Channel: large notes, instrument 0, layer 0 at 0x40, end.
 * Layer: note0 key 39 (C, frequency 1.0), delay 48 ticks, velocity 127, gate 0x80, end.
 */
function seqFixture(): Uint8Array {
	const s = new Uint8Array(0x60);
	s.set([0xdd, 120, 0x90, 0x00, 0x20, 0xfd, 96, 0xff], 0);
	s.set([0xc4, 0xc1, 0x00, 0x90, 0x00, 0x40, 0xff], 0x20);
	s.set([39, 48, 127, 0x80, 0xff], 0x40);
	return s;
}

describe('n64-seq', () => {
	it('parses an SM64-style bank', () => {
		const { entry, tbl } = bankFixture();
		const bank = parseSeqBank(entry, tbl);
		expect(bank.instruments).toHaveLength(1);
		const inst = bank.instruments[0]!;
		expect(inst.releaseRate).toBe(0x20);
		expect(inst.normal?.tuning).toBe(1);
		expect(inst.normal?.sample.pcm.length).toBe(32);
	});

	it('plays notes with tempo-derived timing and key-derived frequency', () => {
		const { entry, tbl } = bankFixture();
		const r = runM64(seqFixture(), [parseSeqBank(entry, tbl)]);
		expect(r.events).toHaveLength(1);
		const e = r.events[0]!;
		expect(e.time).toBe(0);
		// 48 ticks at 120 BPM (48 per beat) = 0.5 s; gate 0x80 halves it.
		expect(e.duration).toBeCloseTo(0.25);
		expect(e.freq).toBeCloseTo(1);
		expect(e.volume).toBeCloseTo(1);
		const wav = encodeStereoWav(renderSeqEvents(r.events, 0.5));
		expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
	});
});

describe('z64 dialect', () => {
	it('loads layers with 0x88, follows relative jumps and uses decay-index releases', async () => {
		const { z64DecayRate } = await import('../src/index.js');
		const { entry, tbl } = bankFixture();
		const s = new Uint8Array(0x60);
		// seq: tempo 120; ldchan 0 @0x20; rjump +1 (skip a 0xff); delay 96; end
		s.set([0xdd, 120, 0x90, 0x00, 0x20, 0xf4, 0x01, 0xff, 0xfd, 96, 0xff], 0);
		// chan: noshort (large notes), instr 0, ldlayer 0 @0x40, end
		s.set([0xc4, 0xc1, 0x00, 0x88, 0x00, 0x40, 0xff], 0x20);
		// layer: release (decay index 0x20), note key 39, delay 48, vel 127, gate 0; end
		s.set([0xcf, 0x20, 39, 48, 127, 0, 0xff], 0x40);
		const r = runM64(s, [parseSeqBank(entry, tbl)], { dialect: 'z64' });
		expect(r.events).toHaveLength(1);
		expect(r.events[0]!.release).toBeCloseTo(z64DecayRate(0x20));
		expect(r.events[0]!.duration).toBeCloseTo(0.5); // gate 0 = the whole delay
	});
});
