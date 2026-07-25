/**
 * NES APU (audio processing unit).
 *
 * The NES has no sampled music. Its audio is a five-channel
 * synthesiser driven directly by 6502 code: two pulse (square)
 * channels, a triangle, a noise generator, and a DMC that plays
 * 1-bit delta-modulated samples out of cartridge memory. A game's
 * "music" is therefore a program, not data — which is why rendering
 * NES audio means running the CPU rather than decoding a file.
 *
 * Everything is clocked from the CPU (NTSC: 1,789,773 Hz):
 *
 *   • Pulse and noise timers tick every *second* CPU cycle (the "APU
 *     cycle"), while the triangle ticks every cycle — which is why
 *     the triangle can reach an octave higher than the pulses for the
 *     same timer value.
 *   • A frame counter divides the clock to ~240 Hz and drives the
 *     envelopes, sweeps, length counters and the linear counter. It
 *     runs in either a 4-step mode (which can raise an IRQ) or a
 *     5-step mode (which cannot).
 *
 * The channels are mixed non-linearly, as the hardware's resistor
 * ladder does; the standard closed-form approximation is used here.
 *
 * References:
 *   - NESdev wiki, APU reference
 *   - blargg's APU behaviour notes
 */

/** NTSC CPU/APU master clock. */
export const NTSC_CPU_CLOCK = 1789773;

/** Length counter values, indexed by the 5-bit load field. */
const LENGTH_TABLE = [
	10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
	12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];

/** Pulse duty cycles: 12.5%, 25%, 50%, and 25% negated. */
const DUTY_TABLE = [
	[0, 1, 0, 0, 0, 0, 0, 0],
	[0, 1, 1, 0, 0, 0, 0, 0],
	[0, 1, 1, 1, 1, 0, 0, 0],
	[1, 0, 0, 1, 1, 1, 1, 1],
];

/** The triangle's 32-step ramp, up then back down. */
const TRIANGLE_TABLE = [
	15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

/** Noise timer periods (NTSC), indexed by the 4-bit period field. */
const NOISE_PERIODS = [
	4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
];

/**
 * Pole of the DC-blocking high-pass applied to the mixer output.
 *
 * 0.995 at 44.1 kHz puts the corner near 35 Hz — below anything the
 * APU produces musically, so it removes the offset without thinning
 * the bass.
 */
const DC_BLOCKER_POLE = 0.995;

/** DMC rates in CPU cycles per output bit (NTSC). */
const DMC_RATES = [
	428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
];

/** Shared envelope generator used by the pulse and noise channels. */
class Envelope {
	start = false;
	loop = false;
	constantVolume = false;
	/** Doubles as the divider period and, in constant mode, the volume. */
	volume = 0;
	private divider = 0;
	private decay = 0;

	clock(): void {
		if (this.start) {
			this.start = false;
			this.decay = 15;
			this.divider = this.volume;
			return;
		}
		if (this.divider > 0) {
			this.divider--;
			return;
		}
		this.divider = this.volume;
		if (this.decay > 0) this.decay--;
		else if (this.loop) this.decay = 15;
	}

	output(): number {
		return this.constantVolume ? this.volume : this.decay;
	}
}

/** A pulse channel, including its sweep unit. */
class Pulse {
	enabled = false;
	duty = 0;
	lengthHalt = false;
	lengthCounter = 0;
	timer = 0;
	private timerCounter = 0;
	private sequence = 0;
	readonly envelope = new Envelope();

	sweepEnabled = false;
	sweepPeriod = 0;
	sweepNegate = false;
	sweepShift = 0;
	sweepReload = false;
	private sweepDivider = 0;

	/**
	 * Pulse 1 negates with one's complement (an extra -1), pulse 2
	 * with two's complement. This asymmetry is a hardware quirk and
	 * makes the two channels sweep to subtly different pitches.
	 */
	constructor(private readonly isPulse1: boolean) {}

	private targetPeriod(): number {
		const change = this.timer >> this.sweepShift;
		if (this.sweepNegate) {
			return this.timer - change - (this.isPulse1 ? 1 : 0);
		}
		return this.timer + change;
	}

	private muted(): boolean {
		return this.timer < 8 || this.targetPeriod() > 0x7ff;
	}

	tickTimer(): void {
		if (this.timerCounter > 0) {
			this.timerCounter--;
			return;
		}
		this.timerCounter = this.timer;
		this.sequence = (this.sequence + 1) & 7;
	}

	clockSweep(): void {
		if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0) {
			if (!this.muted()) {
				const target = this.targetPeriod();
				if (target >= 0) this.timer = target & 0x7ff;
			}
		}
		if (this.sweepDivider === 0 || this.sweepReload) {
			this.sweepDivider = this.sweepPeriod;
			this.sweepReload = false;
		} else {
			this.sweepDivider--;
		}
	}

	clockLength(): void {
		if (!this.lengthHalt && this.lengthCounter > 0) this.lengthCounter--;
	}

	/** Restart the duty sequencer (a $4003/$4007 write). */
	restart(): void {
		this.sequence = 0;
	}

	output(): number {
		if (!this.enabled || this.lengthCounter === 0) return 0;
		if (this.muted()) return 0;
		if (DUTY_TABLE[this.duty][this.sequence] === 0) return 0;
		return this.envelope.output();
	}
}

/** The triangle channel. */
class Triangle {
	enabled = false;
	lengthCounter = 0;
	lengthHalt = false;
	timer = 0;
	private timerCounter = 0;
	private sequence = 0;
	linearReloadValue = 0;
	linearReload = false;
	private linearCounter = 0;

	tickTimer(): void {
		if (this.timerCounter > 0) {
			this.timerCounter--;
			return;
		}
		this.timerCounter = this.timer;
		// The sequencer only advances while both counters are alive.
		// When they aren't, the last value is *held* rather than
		// forced to zero — silencing it outright would click.
		if (this.lengthCounter > 0 && this.linearCounter > 0) {
			this.sequence = (this.sequence + 1) & 31;
		}
	}

	clockLinear(): void {
		if (this.linearReload) this.linearCounter = this.linearReloadValue;
		else if (this.linearCounter > 0) this.linearCounter--;
		if (!this.lengthHalt) this.linearReload = false;
	}

	clockLength(): void {
		if (!this.lengthHalt && this.lengthCounter > 0) this.lengthCounter--;
	}

	output(): number {
		if (!this.enabled) return 0;
		// Very high frequencies (timer < 2) produce a supersonic buzz
		// on hardware; emulators conventionally mute it.
		if (this.timer < 2) return 0;
		return TRIANGLE_TABLE[this.sequence];
	}
}

/** The noise channel. */
class Noise {
	enabled = false;
	lengthCounter = 0;
	lengthHalt = false;
	mode = false;
	period = 0;
	private timerCounter = 0;
	/** 15-bit LFSR; hardware powers up with it set to 1. */
	private shift = 1;
	readonly envelope = new Envelope();

	tickTimer(): void {
		if (this.timerCounter > 0) {
			this.timerCounter--;
			return;
		}
		this.timerCounter = NOISE_PERIODS[this.period];
		const bit = this.mode ? (this.shift >> 6) & 1 : (this.shift >> 1) & 1;
		const feedback = (this.shift & 1) ^ bit;
		this.shift = (this.shift >> 1) | (feedback << 14);
	}

	clockLength(): void {
		if (!this.lengthHalt && this.lengthCounter > 0) this.lengthCounter--;
	}

	output(): number {
		if (!this.enabled || this.lengthCounter === 0) return 0;
		if ((this.shift & 1) !== 0) return 0;
		return this.envelope.output();
	}
}

/** The delta-modulation channel. */
class Dmc {
	enabled = false;
	irqEnabled = false;
	loop = false;
	rate = 0;
	level = 0;
	sampleAddress = 0xc000;
	sampleLength = 1;
	currentAddress = 0xc000;
	bytesRemaining = 0;
	irqFlag = false;
	private timerCounter = 0;
	private shiftRegister = 0;
	private bitsRemaining = 0;
	private silence = true;
	private readMemory: ((address: number) => number) | null = null;

	setMemoryReader(read: (address: number) => number): void {
		this.readMemory = read;
	}

	restart(): void {
		this.currentAddress = this.sampleAddress;
		this.bytesRemaining = this.sampleLength;
	}

	private fetch(): void {
		if (this.bytesRemaining === 0) return;
		// Without a bus the DMC reads silence rather than crashing.
		this.shiftRegister = this.readMemory
			? this.readMemory(this.currentAddress) & 0xff
			: 0;
		this.silence = false;
		this.bitsRemaining = 8;
		this.currentAddress =
			this.currentAddress === 0xffff ? 0x8000 : this.currentAddress + 1;
		this.bytesRemaining--;
		if (this.bytesRemaining === 0) {
			if (this.loop) this.restart();
			else if (this.irqEnabled) this.irqFlag = true;
		}
	}

	tickTimer(): void {
		if (this.timerCounter > 0) {
			this.timerCounter--;
			return;
		}
		this.timerCounter = DMC_RATES[this.rate];
		if (this.bitsRemaining === 0) {
			if (this.bytesRemaining > 0) this.fetch();
			else this.silence = true;
		}
		if (this.bitsRemaining > 0) {
			if (!this.silence) {
				// Each bit nudges the level by 2, but only when the
				// result stays inside the 7-bit range.
				if ((this.shiftRegister & 1) !== 0) {
					if (this.level <= 125) this.level += 2;
				} else if (this.level >= 2) {
					this.level -= 2;
				}
			}
			this.shiftRegister >>= 1;
			this.bitsRemaining--;
		}
	}

	output(): number {
		return this.level;
	}
}

/**
 * The APU.
 *
 * Feed it one {@link tick} per CPU cycle and collect audio with
 * {@link drain}.
 */
export class Apu {
	private readonly pulse1 = new Pulse(true);
	private readonly pulse2 = new Pulse(false);
	private readonly triangle = new Triangle();
	private readonly noise = new Noise();
	private readonly dmc = new Dmc();

	/** Toggles every CPU cycle; pulse/noise timers run on the false→true edge. */
	private apuCycleToggle = false;
	private frameCycle = 0;
	private frameMode5 = false;
	private frameIrqInhibit = false;
	private frameIrqFlag = false;

	private readonly cyclesPerSample: number;
	private sampleAccumulator = 0;
	private boxSum = 0;
	private boxCount = 0;
	private samples: number[] = [];
	/** DC-blocker state (see the filter note in `tick`). */
	private dcLastIn = 0;
	private dcLastOut = 0;

	constructor(sampleRate: number, cpuClock = NTSC_CPU_CLOCK) {
		this.cyclesPerSample = cpuClock / sampleRate;
	}

	/** Give the DMC access to CPU memory so it can fetch sample bytes. */
	setMemoryReader(read: (address: number) => number): void {
		this.dmc.setMemoryReader(read);
	}

	get irqPending(): boolean {
		return this.frameIrqFlag || this.dmc.irqFlag;
	}

	write(address: number, value: number): void {
		const v = value & 0xff;
		switch (address & 0xffff) {
			// ---- Pulse 1 ----
			case 0x4000:
				this.pulse1.duty = (v >> 6) & 3;
				this.pulse1.lengthHalt = (v & 0x20) !== 0;
				this.pulse1.envelope.loop = (v & 0x20) !== 0;
				this.pulse1.envelope.constantVolume = (v & 0x10) !== 0;
				this.pulse1.envelope.volume = v & 0x0f;
				break;
			case 0x4001:
				this.pulse1.sweepEnabled = (v & 0x80) !== 0;
				this.pulse1.sweepPeriod = (v >> 4) & 7;
				this.pulse1.sweepNegate = (v & 0x08) !== 0;
				this.pulse1.sweepShift = v & 7;
				this.pulse1.sweepReload = true;
				break;
			case 0x4002:
				this.pulse1.timer = (this.pulse1.timer & 0x700) | v;
				break;
			case 0x4003:
				this.pulse1.timer = (this.pulse1.timer & 0xff) | ((v & 7) << 8);
				if (this.pulse1.enabled) {
					this.pulse1.lengthCounter = LENGTH_TABLE[(v >> 3) & 0x1f];
				}
				this.pulse1.envelope.start = true;
				this.pulse1.restart();
				break;

			// ---- Pulse 2 ----
			case 0x4004:
				this.pulse2.duty = (v >> 6) & 3;
				this.pulse2.lengthHalt = (v & 0x20) !== 0;
				this.pulse2.envelope.loop = (v & 0x20) !== 0;
				this.pulse2.envelope.constantVolume = (v & 0x10) !== 0;
				this.pulse2.envelope.volume = v & 0x0f;
				break;
			case 0x4005:
				this.pulse2.sweepEnabled = (v & 0x80) !== 0;
				this.pulse2.sweepPeriod = (v >> 4) & 7;
				this.pulse2.sweepNegate = (v & 0x08) !== 0;
				this.pulse2.sweepShift = v & 7;
				this.pulse2.sweepReload = true;
				break;
			case 0x4006:
				this.pulse2.timer = (this.pulse2.timer & 0x700) | v;
				break;
			case 0x4007:
				this.pulse2.timer = (this.pulse2.timer & 0xff) | ((v & 7) << 8);
				if (this.pulse2.enabled) {
					this.pulse2.lengthCounter = LENGTH_TABLE[(v >> 3) & 0x1f];
				}
				this.pulse2.envelope.start = true;
				this.pulse2.restart();
				break;

			// ---- Triangle ----
			case 0x4008:
				this.triangle.lengthHalt = (v & 0x80) !== 0;
				this.triangle.linearReloadValue = v & 0x7f;
				break;
			case 0x400a:
				this.triangle.timer = (this.triangle.timer & 0x700) | v;
				break;
			case 0x400b:
				this.triangle.timer = (this.triangle.timer & 0xff) | ((v & 7) << 8);
				if (this.triangle.enabled) {
					this.triangle.lengthCounter = LENGTH_TABLE[(v >> 3) & 0x1f];
				}
				this.triangle.linearReload = true;
				break;

			// ---- Noise ----
			case 0x400c:
				this.noise.lengthHalt = (v & 0x20) !== 0;
				this.noise.envelope.loop = (v & 0x20) !== 0;
				this.noise.envelope.constantVolume = (v & 0x10) !== 0;
				this.noise.envelope.volume = v & 0x0f;
				break;
			case 0x400e:
				this.noise.mode = (v & 0x80) !== 0;
				this.noise.period = v & 0x0f;
				break;
			case 0x400f:
				if (this.noise.enabled) {
					this.noise.lengthCounter = LENGTH_TABLE[(v >> 3) & 0x1f];
				}
				this.noise.envelope.start = true;
				break;

			// ---- DMC ----
			case 0x4010:
				this.dmc.irqEnabled = (v & 0x80) !== 0;
				this.dmc.loop = (v & 0x40) !== 0;
				this.dmc.rate = v & 0x0f;
				if (!this.dmc.irqEnabled) this.dmc.irqFlag = false;
				break;
			case 0x4011:
				this.dmc.level = v & 0x7f;
				break;
			case 0x4012:
				this.dmc.sampleAddress = 0xc000 + v * 64;
				break;
			case 0x4013:
				this.dmc.sampleLength = v * 16 + 1;
				break;

			// ---- Status / enable ----
			case 0x4015: {
				this.pulse1.enabled = (v & 0x01) !== 0;
				if (!this.pulse1.enabled) this.pulse1.lengthCounter = 0;
				this.pulse2.enabled = (v & 0x02) !== 0;
				if (!this.pulse2.enabled) this.pulse2.lengthCounter = 0;
				this.triangle.enabled = (v & 0x04) !== 0;
				if (!this.triangle.enabled) this.triangle.lengthCounter = 0;
				this.noise.enabled = (v & 0x08) !== 0;
				if (!this.noise.enabled) this.noise.lengthCounter = 0;
				this.dmc.enabled = (v & 0x10) !== 0;
				if (!this.dmc.enabled) this.dmc.bytesRemaining = 0;
				else if (this.dmc.bytesRemaining === 0) this.dmc.restart();
				this.dmc.irqFlag = false;
				break;
			}

			// ---- Frame counter ----
			case 0x4017:
				this.frameMode5 = (v & 0x80) !== 0;
				this.frameIrqInhibit = (v & 0x40) !== 0;
				if (this.frameIrqInhibit) this.frameIrqFlag = false;
				this.frameCycle = 0;
				// 5-step mode clocks everything immediately on write.
				if (this.frameMode5) {
					this.quarterFrame();
					this.halfFrame();
				}
				break;
		}
	}

	readStatus(): number {
		let status = 0;
		if (this.pulse1.lengthCounter > 0) status |= 0x01;
		if (this.pulse2.lengthCounter > 0) status |= 0x02;
		if (this.triangle.lengthCounter > 0) status |= 0x04;
		if (this.noise.lengthCounter > 0) status |= 0x08;
		if (this.dmc.bytesRemaining > 0) status |= 0x10;
		if (this.frameIrqFlag) status |= 0x40;
		if (this.dmc.irqFlag) status |= 0x80;
		// Reading acknowledges the frame IRQ.
		this.frameIrqFlag = false;
		return status;
	}

	private quarterFrame(): void {
		this.pulse1.envelope.clock();
		this.pulse2.envelope.clock();
		this.noise.envelope.clock();
		this.triangle.clockLinear();
	}

	private halfFrame(): void {
		this.pulse1.clockLength();
		this.pulse2.clockLength();
		this.triangle.clockLength();
		this.noise.clockLength();
		this.pulse1.clockSweep();
		this.pulse2.clockSweep();
	}

	private clockFrameCounter(): void {
		this.frameCycle++;
		if (!this.frameMode5) {
			switch (this.frameCycle) {
				case 7457: this.quarterFrame(); break;
				case 14913: this.quarterFrame(); this.halfFrame(); break;
				case 22371: this.quarterFrame(); break;
				case 29829:
					this.quarterFrame();
					this.halfFrame();
					if (!this.frameIrqInhibit) this.frameIrqFlag = true;
					this.frameCycle = 0;
					break;
			}
		} else {
			switch (this.frameCycle) {
				case 7457: this.quarterFrame(); break;
				case 14913: this.quarterFrame(); this.halfFrame(); break;
				case 22371: this.quarterFrame(); break;
				case 37281:
					this.quarterFrame();
					this.halfFrame();
					this.frameCycle = 0;
					break;
			}
		}
	}

	/**
	 * Mix the current channel outputs.
	 *
	 * The hardware sums the channels through a resistor ladder, which
	 * is decidedly non-linear; these are the standard closed-form
	 * approximations from the NESdev wiki. The result lands in
	 * roughly 0..1.
	 */
	private mix(): number {
		const p = this.pulse1.output() + this.pulse2.output();
		const pulseOut = p === 0 ? 0 : 95.88 / (8128 / p + 100);
		const t = this.triangle.output();
		const n = this.noise.output();
		const d = this.dmc.output();
		const tnd = t / 8227 + n / 12241 + d / 22638;
		const tndOut = tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
		return pulseOut + tndOut;
	}

	/** Advance one CPU cycle. */
	tick(): void {
		// Pulse and noise run at half the CPU rate; the triangle and
		// DMC run at the full rate.
		this.apuCycleToggle = !this.apuCycleToggle;
		if (this.apuCycleToggle) {
			this.pulse1.tickTimer();
			this.pulse2.tickTimer();
			this.noise.tickTimer();
		}
		this.triangle.tickTimer();
		this.dmc.tickTimer();
		this.clockFrameCounter();

		// Box-filter the mixer between output samples. Averaging every
		// CPU cycle in the window instead of point-sampling removes
		// most of the aliasing that would otherwise fold the pulse
		// channels' harmonics down into the audible band.
		this.boxSum += this.mix();
		this.boxCount++;
		this.sampleAccumulator++;
		if (this.sampleAccumulator >= this.cyclesPerSample) {
			this.sampleAccumulator -= this.cyclesPerSample;
			const raw = this.boxSum / this.boxCount;
			// Remove DC with a one-pole high-pass rather than a fixed
			// offset. The mixer is unipolar and its resting level moves
			// with the DMC level and how many channels are active, so
			// subtracting a constant would pin silence to a rail
			// instead of centring it.
			const filtered =
				raw - this.dcLastIn + DC_BLOCKER_POLE * this.dcLastOut;
			this.dcLastIn = raw;
			this.dcLastOut = filtered;
			this.samples.push(filtered);
			this.boxSum = 0;
			this.boxCount = 0;
		}
	}

	/** Remove and return everything generated since the last call. */
	drain(): Float32Array {
		const out = Float32Array.from(this.samples);
		this.samples = [];
		return out;
	}
}
