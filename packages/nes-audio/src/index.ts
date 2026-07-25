/**
 * Render NES ROM audio to PCM by emulating the machine.
 *
 * NES music is not data that can be decoded — it is 6502 code
 * driving the APU's five synthesiser channels in real time. The only
 * way to hear a game's soundtrack is therefore to run the game.
 *
 * This module boots a cartridge, runs it at NTSC timing with a
 * minimal PPU stand-in, and records what the APU produces. No
 * picture is generated: the PPU is emulated only as far as the
 * handful of behaviours a game's main loop blocks on (the VBlank
 * flag, sprite-zero, and the write-toggle reset), which is enough to
 * get past initialisation and into the attract-mode loop where music
 * plays.
 *
 * ## What works, and what does not
 *
 * Most title screens and attract modes play music with no input at
 * all, so a plain "boot and listen" capture is often enough. Games
 * that wait for a button press can be nudged with the `buttons`
 * option, which holds a controller state for the whole capture.
 *
 * Only mapper 0 (NROM) and the trivial bank-switching mappers are
 * supported. A game using an unsupported mapper will usually boot to
 * silence rather than misbehave, and {@link renderNesAudio} reports
 * the mapper so callers can say so.
 *
 * References:
 *   - NESdev wiki (CPU memory map, PPU registers, controller ports)
 */

import { parseNesHeader, type NesRomInfo } from '@tootallnate/nes-rom';
import { Cpu, type Bus } from './cpu.js';
import { Apu, NTSC_CPU_CLOCK } from './apu.js';

export { Cpu, Flag, type Bus } from './cpu.js';
export { Apu, NTSC_CPU_CLOCK } from './apu.js';

/** NTSC frame rate. */
export const NTSC_FRAME_RATE = 60.0988;
/** CPU cycles in one NTSC frame. */
export const CYCLES_PER_FRAME = NTSC_CPU_CLOCK / NTSC_FRAME_RATE;

/** Standard controller buttons, as the $4016 shift register order. */
export const Button = {
	A: 0x01,
	B: 0x02,
	SELECT: 0x04,
	START: 0x08,
	UP: 0x10,
	DOWN: 0x20,
	LEFT: 0x40,
	RIGHT: 0x80,
} as const;

/**
 * The CPU bus: 2 KB of internal RAM, a PPU stub, the APU, the
 * controller ports, and cartridge PRG-ROM.
 */
class NesBus implements Bus {
	readonly ram = new Uint8Array(0x800);
	readonly apu: Apu;
	/** Held controller state for port 1. */
	buttons = 0;

	private readonly prg: Uint8Array;
	private readonly prgMask: number;
	/** Latched controller shift register. */
	private controllerShift = 0;
	private controllerStrobe = false;
	/** PPUSTATUS VBlank flag ($2002 bit 7), toggled by the frame loop. */
	vblank = false;
	/**
	 * PPUSTATUS sprite-zero hit ($2002 bit 6).
	 *
	 * Games with a split screen — a status bar over a scrolling
	 * playfield — poll this to know when the raster has reached the
	 * split. Super Mario Bros. spins on it during initialisation and
	 * never reaches its main loop without it, so a stub that omits it
	 * boots to silence. Unlike VBlank, reading $2002 does *not* clear
	 * it; the PPU clears it at the end of VBlank.
	 */
	sprite0 = false;
	/** PPU address/scroll write toggle, cleared by reading $2002. */
	private ppuLatch = false;
	/** Scratch PPU registers so writes/reads behave consistently. */
	private readonly ppuRegs = new Uint8Array(8);

	constructor(prg: Uint8Array) {
		this.prg = prg;
		// NROM mirrors a single 16 KB bank across the whole $8000-$FFFF
		// window; 32 KB fills it exactly.
		this.prgMask = prg.length >= 0x8000 ? 0x7fff : 0x3fff;
		this.apu = new Apu(0, NTSC_CPU_CLOCK);
	}

	/** Replace the APU (used so the caller can pick a sample rate). */
	withApu(apu: Apu): NesBus {
		(this as { apu: Apu }).apu = apu;
		apu.setMemoryReader((address) => this.read(address));
		return this;
	}

	read(address: number): number {
		const a = address & 0xffff;
		if (a < 0x2000) return this.ram[a & 0x7ff];
		if (a < 0x4000) {
			const reg = a & 7;
			if (reg === 2) {
				// PPUSTATUS. Reading clears VBlank and the address
				// latch, but leaves sprite-zero alone.
				const value =
					(this.vblank ? 0x80 : 0) | (this.sprite0 ? 0x40 : 0);
				this.vblank = false;
				this.ppuLatch = false;
				return value;
			}
			return this.ppuRegs[reg];
		}
		if (a === 0x4015) return this.apu.readStatus();
		if (a === 0x4016) {
			// Serial controller read, one button per read, LSB first.
			const bit = this.controllerShift & 1;
			this.controllerShift = (this.controllerShift >> 1) | 0x80;
			return bit | 0x40;
		}
		if (a === 0x4017) return 0x40; // no second controller
		if (a >= 0x8000) return this.prg[(a - 0x8000) & this.prgMask];
		return 0;
	}

	write(address: number, value: number): void {
		const a = address & 0xffff;
		const v = value & 0xff;
		if (a < 0x2000) {
			this.ram[a & 0x7ff] = v;
			return;
		}
		if (a < 0x4000) {
			const reg = a & 7;
			// $2005/$2006 are two-write registers; track the toggle so
			// reads of $2002 can reset it as hardware does.
			if (reg === 5 || reg === 6) this.ppuLatch = !this.ppuLatch;
			this.ppuRegs[reg] = v;
			return;
		}
		if (a === 0x4014) {
			// OAM DMA: 256 bytes from a CPU page. Nothing consumes the
			// data here, but the 513-cycle stall is real and affects
			// APU timing, so the caller accounts for it.
			return;
		}
		if (a === 0x4016) {
			const strobe = (v & 1) !== 0;
			if (this.controllerStrobe && !strobe) {
				// Falling edge latches the current button state.
				this.controllerShift = this.buttons;
			}
			this.controllerStrobe = strobe;
			if (strobe) this.controllerShift = this.buttons;
			return;
		}
		if (a >= 0x4000 && a <= 0x4017) {
			this.apu.write(a, v);
			return;
		}
		// Cartridge space: NROM has no registers, so ignore.
	}
}

export interface RenderNesAudioOptions {
	/** Seconds of audio to capture (default 30). */
	seconds?: number;
	/** Output sample rate (default 44100). */
	sampleRate?: number;
	/**
	 * Seconds to run before recording starts (default 2).
	 *
	 * Games spend the first moments clearing RAM and waiting on the
	 * PPU warm-up, which is silence; skipping it means the capture
	 * starts closer to the music.
	 */
	warmupSeconds?: number;
	/**
	 * Controller buttons held for the whole run (a bitmask of
	 * {@link Button}).
	 */
	buttons?: number;
	/**
	 * Tap START a few times early in the run (default true).
	 *
	 * Many titles sit silently on a menu until a button is pressed —
	 * Super Mario Bros. is one, and captures nothing at all without
	 * this. Games ignore a button that is merely *held*, because they
	 * edge-detect newly-pressed buttons, so this presses and releases
	 * rather than holding. Two attempts at different times cover
	 * titles whose menu is not ready for the first.
	 *
	 * Turn it off to capture a title screen that does play music.
	 */
	autoStart?: boolean;
	/**
	 * Abort after this many CPU cycles regardless (default: enough
	 * for `warmupSeconds + seconds`). A guard against a ROM that
	 * wedges in a tight loop.
	 */
	maxCycles?: number;
}

export interface NesAudioResult {
	samples: Int16Array;
	sampleRate: number;
	/** Header of the ROM that was run. */
	info: NesRomInfo;
	/** True when the mapper is one this emulator implements. */
	mapperSupported: boolean;
	/** Peak absolute amplitude, 0..32767. Zero means the ROM stayed silent. */
	peak: number;
}

/** Mappers with no bank switching, so plain PRG mirroring suffices. */
const SUPPORTED_MAPPERS = new Set([0]);

/**
 * Boot a NES ROM and record its audio.
 *
 * The capture is a plain "let it run" — no attempt is made to locate
 * a sound engine or drive it directly, because that entry point is
 * game-specific. What comes out is whatever the game itself decides
 * to play, which for most titles is the title-screen or attract-mode
 * music.
 */
export function renderNesAudio(
	rom: Uint8Array,
	options: RenderNesAudioOptions = {},
): NesAudioResult {
	const seconds = options.seconds ?? 30;
	const sampleRate = options.sampleRate ?? 44100;
	const warmupSeconds = options.warmupSeconds ?? 2;
	const autoStart = options.autoStart ?? true;

	const info = parseNesHeader(rom.subarray(0, 16));
	const prg = rom.subarray(
		info.prgRomOffset,
		info.prgRomOffset + info.prgRomSize,
	);
	const mapperSupported = SUPPORTED_MAPPERS.has(info.mapper);

	const apu = new Apu(sampleRate, NTSC_CPU_CLOCK);
	const bus = new NesBus(prg).withApu(apu);
	bus.buttons = options.buttons ?? 0;
	const cpu = new Cpu(bus);
	cpu.reset();

	const totalCycles =
		options.maxCycles ?? Math.ceil((warmupSeconds + seconds) * NTSC_CPU_CLOCK);
	const warmupCycles = Math.ceil(warmupSeconds * NTSC_CPU_CLOCK);

	// VBlank occupies roughly the last 20 scanlines of a 262-line
	// frame; games poll $2002 or rely on the NMI, so both are driven.
	const vblankStart = Math.floor(CYCLES_PER_FRAME * (241 / 262));
	// Sprite-zero hit fires where the split lands. A status bar
	// occupies the top of the screen on most games that use it, so
	// scanline 32 is a reasonable stand-in for the real collision.
	const sprite0Line = Math.floor(CYCLES_PER_FRAME * (32 / 262));

	const collected: Float32Array[] = [];
	let cycleInFrame = 0;
	let nmiFired = false;
	let sprite0Set = false;
	let elapsed = 0;
	let frame = 0;
	// Frames on which START is held. Short taps, because games look
	// for the press edge.
	const startTaps: Array<[number, number]> = autoStart
		? [
				[90, 6],
				[240, 6],
			]
		: [];
	const heldButtons = options.buttons ?? 0;

	while (elapsed < totalCycles) {
		const used = cpu.step();
		for (let i = 0; i < used; i++) apu.tick();
		elapsed += used;
		cycleInFrame += used;

		if (!sprite0Set && cycleInFrame >= sprite0Line) {
			bus.sprite0 = true;
			sprite0Set = true;
		}
		if (!nmiFired && cycleInFrame >= vblankStart) {
			bus.vblank = true;
			nmiFired = true;
			// $2000 bit 7 enables the VBlank NMI.
			if ((bus.read(0x2000) & 0x80) !== 0) cpu.nmi();
		}
		if (cycleInFrame >= CYCLES_PER_FRAME) {
			cycleInFrame -= CYCLES_PER_FRAME;
			nmiFired = false;
			sprite0Set = false;
			bus.vblank = false;
			// The PPU clears sprite-zero at the end of VBlank.
			bus.sprite0 = false;
			frame++;
			let pressed = heldButtons;
			for (const [at, hold] of startTaps) {
				if (frame >= at && frame < at + hold) pressed |= Button.START;
			}
			bus.buttons = pressed;
		}

		cpu.setIrq(apu.irqPending);

		const chunk = apu.drain();
		if (chunk.length > 0 && elapsed > warmupCycles) collected.push(chunk);
	}

	let total = 0;
	for (const c of collected) total += c.length;
	const wanted = Math.min(total, Math.ceil(seconds * sampleRate));

	// Normalise rather than apply a fixed gain. The mixer's output
	// level depends entirely on how many channels a game drives and
	// how loud it drives them, so any constant would clip some ROMs
	// and leave others inaudible.
	let floatPeak = 0;
	{
		let seen = 0;
		for (const chunk of collected) {
			for (let i = 0; i < chunk.length && seen < wanted; i++, seen++) {
				const a = chunk[i] < 0 ? -chunk[i] : chunk[i];
				if (a > floatPeak) floatPeak = a;
			}
		}
	}
	// Leave a little headroom so the waveform's peaks stay rounded.
	const gain = floatPeak > 0 ? (0.92 * 32767) / floatPeak : 0;

	const out = new Int16Array(wanted);
	let position = 0;
	let peak = 0;
	for (const chunk of collected) {
		for (let i = 0; i < chunk.length && position < wanted; i++) {
			let v = Math.round(chunk[i] * gain);
			if (v > 32767) v = 32767;
			else if (v < -32768) v = -32768;
			const a = v < 0 ? -v : v;
			if (a > peak) peak = a;
			out[position++] = v;
		}
	}

	return { samples: out, sampleRate, info, mapperSupported, peak };
}

/** Encode 16-bit mono PCM as a RIFF/WAVE file. */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const tag = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
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
