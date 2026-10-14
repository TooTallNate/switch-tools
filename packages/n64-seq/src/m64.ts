/**
 * M64 sequence interpreter (Super Mario 64 / Mario Kart 64 audio library,
 * n64decomp/sm64 `include/seq_macros.inc`, `src/audio/seqplayer.c`, US
 * encodings). Turns a sequence into timed note events for the synth.
 *
 * Three levels of bytecode, each with its own pc, call / loop stack and
 * delay counter, stepped once per tick (tatum, 48 per beat):
 *
 *   sequence  tempo, volume, transposition, starts channels (0x90 + n)
 *   channel   instrument / bank / volume / pan / transposition, starts
 *             layers (0x90 + n), large-note mode (0xC4)
 *   layer     notes: 0x00 (delay, velocity, gate) / 0x40 (delay, velocity)
 *             / 0x80 (velocity, gate; last delay) in large-note mode,
 *             delays only in short-note mode (velocity and gate from
 *             0xC1 / 0xC9 or the short-note tables)
 *
 * Variable-length numbers ("var") are one byte, or two when the first
 * has bit 7 set (15 bits). Instrument 0x7F selects the bank's drums,
 * indexed by note. Branches test the script's value register.
 */

import type { SeqBank, SeqEnvelopePoint, SeqSound } from './bank.js';

export interface SeqNoteEvent {
	/** Start, in seconds. */
	time: number;
	/** Gate length, in seconds. */
	duration: number;
	sound: SeqSound;
	/** Playback step at 32 kHz (1 = native rate). */
	freq: number;
	/** 0–1 (velocity² × channel and sequence volume). */
	volume: number;
	/** 0 (left) – 1 (right). */
	pan: number;
	envelope: SeqEnvelopePoint[];
	/** ADSR release decrement per 1/240 s (out of 32767). */
	release: number;
	channel: number;
}

export interface SeqRenderOptions {
	/** Stop after this many seconds (default 180). */
	maxSeconds?: number;
	/** Seconds to keep playing after the sequence loops (default 0 = stop at the loop). */
	afterLoopSeconds?: number;
	/** Called when a script stops on a command it doesn't know (diagnostics). */
	onUnknown?: (level: 'seq' | 'channel' | 'layer', cmd: number, pc: number) => void;
}

const VEL_TABLE = [12, 25, 38, 51, 57, 64, 71, 76, 83, 89, 96, 102, 109, 115, 121, 127];
const DUR_TABLE = [229, 203, 177, 151, 139, 126, 113, 100, 87, 74, 61, 48, 36, 23, 10, 0];
const DEFAULT_ENVELOPE: SeqEnvelopePoint[] = [
	{ delay: 4, arg: 32000 },
	{ delay: 1000, arg: 32000 },
	{ delay: 0xffff, arg: 0 },
];
const noteFrequency = (k: number) => (k < 117 ? 2 ** ((k - 39) / 12) : 0.5 * 2 ** ((k - 39) / 12));

interface Script {
	pc: number;
	stack: { pc: number; loop: number; loopPc: number }[];
	delay: number;
	value: number;
	done: boolean;
}

interface Layer {
	s: Script;
	transpose: number;
	velocity: number;
	noteDuration: number;
	playPercentage: number;
	shortDefault: number;
	pan: number | null;
	instrument: number | null;
	lastDelay: number;
}

interface Channel {
	s: Script;
	layers: (Layer | null)[];
	instrument: number;
	bank: number;
	volume: number;
	volumeScale: number;
	pan: number;
	transpose: number;
	largeNotes: boolean;
	releaseRate: number;
	bend: number;
	envelope: SeqEnvelopePoint[] | null;
}

const newScript = (pc: number): Script => ({ pc, stack: [], delay: 0, value: 0, done: false });

/**
 * Run a sequence and collect its notes. `banks` are the sequence's bank
 * set (the default bank is the last one), `bankSet` maps
 * `chan_setbank` indices to banks.
 */
export function runM64(seq: Uint8Array, banks: SeqBank[], options: SeqRenderOptions = {}): { events: SeqNoteEvent[]; length: number; looped: boolean } {
	const maxSeconds = options.maxSeconds ?? 180;
	const after = options.afterLoopSeconds ?? 0;
	const events: SeqNoteEvent[] = [];
	const rd = (o: number) => seq[o] ?? 0;
	const u16 = (o: number) => (rd(o) << 8) | rd(o + 1);
	const s8 = (v: number) => (v << 24) >> 24;
	const readVar = (s: Script) => {
		const a = rd(s.pc++);
		return a & 0x80 ? ((a & 0x7f) << 8) | rd(s.pc++) : a;
	};
	const defaultBank = banks.length - 1;
	const seqState = { s: newScript(0), tempo: 120, volume: 127, transpose: 0, velTable: VEL_TABLE as readonly number[], durTable: DUR_TABLE as readonly number[] };
	const channels: (Channel | null)[] = new Array(16).fill(null);
	let time = 0;
	let looped = false;
	let stopAt = maxSeconds;
	const visited = new Set<number>();

	/** Shared flow commands; returns true when handled. */
	const flow = (s: Script, cmd: number, seqLevel = false): boolean => {
		switch (cmd) {
			case 0xf5: { const t = u16(s.pc); s.pc += 2; if (s.value >= 0) s.pc = t; return true; }
			case 0xf9: { const t = u16(s.pc); s.pc += 2; if (s.value < 0) s.pc = t; return true; }
			case 0xfa: { const t = u16(s.pc); s.pc += 2; if (s.value === 0) s.pc = t; return true; }
			case 0xfb: {
				const t = u16(s.pc);
				if (seqLevel && t <= s.pc && visited.has(t) && !looped) {
					looped = true;
					stopAt = Math.min(stopAt, time + after);
				}
				s.pc = t;
				return true;
			}
			case 0xfc: { const t = u16(s.pc); s.stack.push({ pc: s.pc + 2, loop: 0, loopPc: 0 }); s.pc = t; return true; }
			case 0xf8: { const n = rd(s.pc++); s.stack.push({ pc: 0, loop: n === 0 ? 256 : n, loopPc: s.pc }); return true; }
			case 0xf7: {
				const top = s.stack[s.stack.length - 1];
				if (top && top.loop > 0 && --top.loop > 0) s.pc = top.loopPc;
				else s.stack.pop();
				return true;
			}
			case 0xf6: s.stack.pop(); return true; // break out of a loop
			case 0xff: {
				const top = s.stack.pop();
				if (top && top.loop === 0) s.pc = top.pc;
				else s.done = true;
				return true;
			}
			case 0xfd: s.delay = readVar(s); return true;
			case 0xfe: s.delay = 1; return true;
		}
		return false;
	};

	const stepLayer = (ch: Channel, ci: number, L: Layer) => {
		const s = L.s;
		for (let guard = 0; guard < 512 && !s.done && s.delay === 0; guard++) {
			const cmd = rd(s.pc++);
			if (flow(s, cmd)) continue;
			if (cmd < 0xc0) {
				// Note.
				let delay: number, vel = L.velocity, gate = L.noteDuration;
				const kind = cmd & 0xc0;
				if (ch.largeNotes) {
					if (kind === 0x00) { delay = readVar(s); vel = rd(s.pc++); gate = rd(s.pc++); }
					else if (kind === 0x40) { delay = readVar(s); vel = rd(s.pc++); gate = 0; }
					else { delay = L.playPercentage; vel = rd(s.pc++); gate = rd(s.pc++); }
					L.velocity = vel;
					L.noteDuration = gate;
				} else {
					if (kind === 0x00) delay = readVar(s);
					else if (kind === 0x40) delay = L.shortDefault;
					else delay = L.playPercentage;
				}
				L.playPercentage = delay;
				s.delay = delay;
				const key = cmd & 0x3f;
				const ticks = gate === 0 ? delay : (gate * delay) / 256;
				const tickSec = 60 / (seqState.tempo * 48);
				let sound: SeqSound | null = null, freq = 1, pan = ch.pan, envelope = ch.envelope ?? DEFAULT_ENVELOPE, release = ch.releaseRate;
				const bank = banks[ch.bank] ?? banks[defaultBank];
				const inst = L.instrument ?? ch.instrument;
				if (inst === 0x7f) {
					const k = key + ch.transpose + L.transpose;
					const drum = bank?.drums[Math.min(k, (bank?.drums.length ?? 1) - 1)];
					if (drum?.sound) {
						sound = drum.sound;
						freq = drum.sound.tuning;
						pan = drum.pan / 128;
						envelope = drum.envelope.length ? drum.envelope : envelope;
						release = drum.releaseRate || release;
					}
				} else {
					const k = key + seqState.transpose + ch.transpose + L.transpose;
					const ins = bank?.instruments[inst];
					if (ins && k >= 0 && k < 128) {
						sound = k < ins.normalRangeLo ? ins.low : k <= ins.normalRangeHi ? ins.normal : ins.high;
						sound ??= ins.normal;
						if (sound) freq = noteFrequency(k) * sound.tuning;
						envelope = ins.envelope.length ? ins.envelope : envelope;
						release = ins.releaseRate || release;
					}
				}
				if (L.pan !== null) pan = L.pan / 128;
				if (sound && vel > 0 && time < stopAt) {
					events.push({
						time,
						duration: ticks * tickSec,
						sound,
						freq: freq * 2 ** ((ch.bend / 127) * (2 / 12)),
						volume: ((vel * vel) / (127 * 127)) * ch.volume * ch.volumeScale * (seqState.volume / 127),
						pan,
						envelope,
						release,
						channel: ci,
					});
				}
				continue;
			}
			switch (cmd) {
				case 0xc0: s.delay = readVar(s); break; // rest
				case 0xc1: L.velocity = rd(s.pc++); break;
				case 0xc2: L.transpose = s8(rd(s.pc++)); break;
				case 0xc3: L.shortDefault = readVar(s); break;
				case 0xc4: case 0xc5: case 0xc8: case 0xcc: break;
				case 0xc6: { const v = rd(s.pc++); L.instrument = v === 0xff ? null : v; break; }
				case 0xc7: { const mode = rd(s.pc++); s.pc++; if (mode & 0x80) s.pc++; else readVar(s); break; } // portamento
				case 0xc9: L.noteDuration = rd(s.pc++); break;
				case 0xca: L.pan = rd(s.pc++); break;
				case 0xcb: s.pc += 2; break; // envelope + release (US: setenvelope / release)
				default:
					if ((cmd & 0xf0) === 0xd0) L.velocity = seqState.velTable[cmd & 0xf] ?? 127;
					else if ((cmd & 0xf0) === 0xe0) L.noteDuration = seqState.durTable[cmd & 0xf] ?? 0x80;
					else {
						options.onUnknown?.('layer', cmd, s.pc - 1);
						s.done = true; // unknown: stop this layer
					}
			}
		}
		if (s.delay > 0) s.delay--;
	};

	const stepChannel = (ch: Channel, ci: number) => {
		const s = ch.s;
		for (let guard = 0; guard < 512 && !s.done && s.delay === 0; guard++) {
			const cmd = rd(s.pc++);
			if (flow(s, cmd)) continue;
			const hi = cmd & 0xf0, lo = cmd & 0x0f;
			if (cmd < 0x10) { s.value = ch.layers[lo & 3]?.s.done !== false ? 1 : 0; continue; }
			if (hi === 0x10) { const t = u16(s.pc); s.pc += 2; startChannel(lo, t); continue; }
			if (hi === 0x20) { channels[lo] = null; continue; }
			if (hi === 0x30 || hi === 0x40) { s.pc++; continue; }
			if (hi === 0x50 || hi === 0x60 || hi === 0x70 || hi === 0x80) { if (hi === 0x80) s.value = 0; continue; }
			if (hi === 0x90) {
				const t = u16(s.pc);
				s.pc += 2;
				ch.layers[lo & 3] = { s: newScript(t), transpose: 0, velocity: 0, noteDuration: 0x80, playPercentage: 0, shortDefault: 0x80, pan: null, instrument: null, lastDelay: 0 };
				continue;
			}
			if (hi === 0xa0) { ch.layers[lo & 3] = null; continue; }
			if (hi === 0xb0) continue;
			switch (cmd) {
				case 0xc1: ch.instrument = rd(s.pc++); break;
				case 0xc2: s.pc += 2; break;
				case 0xc3: ch.largeNotes = false; break;
				case 0xc4: ch.largeNotes = true; break;
				case 0xc5: break;
				case 0xc6: {
					const idx = rd(s.pc++);
					ch.bank = Math.max(0, banks.length - 1 - idx);
					break;
				}
				case 0xc7: s.pc += 3; break;
				case 0xc8: s.value -= rd(s.pc++); break;
				case 0xc9: s.value &= rd(s.pc++); break;
				case 0xca: s.pc++; break;
				case 0xcb: { const t = u16(s.pc); s.pc += 2; s.value = rd(t + s.value); break; }
				case 0xcc: s.value = rd(s.pc++); break;
				case 0xd0: case 0xd1: case 0xd4: case 0xd6: case 0xd7: case 0xd8: case 0xe3: s.pc++; break;
				case 0xd2: s.pc++; break; // sustain
				case 0xd3: ch.bend = s8(rd(s.pc++)); break;
				case 0xd9: ch.releaseRate = rd(s.pc++); break;
				case 0xda: { const t = u16(s.pc); s.pc += 2; const e: SeqEnvelopePoint[] = []; for (let o = t; e.length < 32; o += 4) { const delay = u16(o), arg = u16(o + 2); e.push({ delay, arg }); if (delay === 0 || delay >= 0xfffd) break; } ch.envelope = e; break; }
				case 0xdb: ch.transpose = s8(rd(s.pc++)); break;
				case 0xdc: s.pc++; break;
				case 0xdd: ch.pan = rd(s.pc++) / 128; break;
				case 0xde: s.pc += 2; break;
				case 0xdf: ch.volume = rd(s.pc++) / 127; break;
				case 0xe0: ch.volumeScale = rd(s.pc++) / 128; break;
				case 0xe1: case 0xe2: s.pc += 3; break;
				case 0xe4: break;
				case 0xf1: break;
				case 0xf2: s.pc++; break;
				case 0xf3: s.done = true; break;
				default:
					options.onUnknown?.('channel', cmd, s.pc - 1);
					s.done = true;
			}
		}
		if (s.delay > 0) s.delay--;
		for (const L of ch.layers) if (L && !L.s.done) stepLayer(ch, ci, L);
	};

	const startChannel = (n: number, pc: number) => {
		// sequence_channel_enable: a restarted channel keeps its state
		// (instrument, volume, pan, note mode); only the script restarts
		// and its layers are freed.
		const prev = channels[n];
		if (prev) {
			prev.s = newScript(pc);
			prev.layers = [null, null, null, null];
			return;
		}
		channels[n] = { s: newScript(pc), layers: [null, null, null, null], instrument: 0, bank: defaultBank, volume: 1, volumeScale: 1, pan: 0.5, transpose: 0, largeNotes: false, releaseRate: 0x20, bend: 0, envelope: null };
	};

	const stepSeq = () => {
		const s = seqState.s;
		for (let guard = 0; guard < 512 && !s.done && s.delay === 0; guard++) {
			visited.add(s.pc);
			const cmd = rd(s.pc++);
			if (flow(s, cmd, true)) continue;
			const hi = cmd & 0xf0, lo = cmd & 0x0f;
			if (cmd < 0x10) { s.value = channels[lo] ? 0 : 1; continue; }
			if (hi === 0x50) { s.value -= 0; continue; }
			if (hi === 0x70 || hi === 0x80) { if (hi === 0x80) s.value = 0; continue; }
			if (hi === 0x90) { const t = u16(s.pc); s.pc += 2; startChannel(lo, t); continue; }
			switch (cmd) {
				case 0xc8: s.value -= rd(s.pc++); break;
				case 0xc9: s.value &= rd(s.pc++); break;
				case 0xcc: s.value = rd(s.pc++); break;
				case 0xd0: case 0xd3: case 0xd5: s.pc++; break;
				case 0xd1: { const t = u16(s.pc); s.pc += 2; seqState.durTable = Array.from({ length: 16 }, (_, i) => rd(t + i)); break; }
				case 0xd2: { const t = u16(s.pc); s.pc += 2; seqState.velTable = Array.from({ length: 16 }, (_, i) => rd(t + i)); break; }
				case 0xd4: break;
				case 0xd6: { const m = u16(s.pc); s.pc += 2; for (let i = 0; i < 16; i++) if (m & (1 << i)) channels[i] = null; break; }
				case 0xd7: s.pc += 2; break;
				case 0xda: s.pc++; break;
				case 0xdb: seqState.volume = rd(s.pc++); break;
				case 0xdc: seqState.tempo = Math.max(1, seqState.tempo + s8(rd(s.pc++))); break;
				case 0xdd: seqState.tempo = Math.max(1, rd(s.pc++)); break;
				case 0xde: seqState.transpose += s8(rd(s.pc++)); break;
				case 0xdf: seqState.transpose = s8(rd(s.pc++)); break;
				case 0xf1: break;
				case 0xf2: s.pc++; break;
				default:
					options.onUnknown?.('seq', cmd, s.pc - 1);
					s.done = true;
			}
		}
		if (s.delay > 0) s.delay--;
	};

	for (let ticks = 0; ticks < 1_000_000 && time < stopAt; ticks++) {
		stepSeq();
		// A channel's layers keep playing after its own script ends.
		channels.forEach((ch, i) => ch && stepChannel(ch, i));
		const anyActive = !seqState.s.done || channels.some((c) => c && (!c.s.done || c.layers.some((l) => l && !l.s.done)));
		if (!anyActive) break;
		time += 60 / (seqState.tempo * 48);
	}
	return { events, length: Math.min(time, stopAt), looped };
}
