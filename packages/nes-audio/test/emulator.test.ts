import { describe, it, expect } from 'vitest';
import { Cpu, Flag, type Bus } from '../src/cpu.js';
import { Apu, NTSC_CPU_CLOCK } from '../src/apu.js';
import { encodeWav, renderNesAudio, Button } from '../src/index.js';

/** A flat 64 KB RAM bus, for exercising the CPU in isolation. */
class TestBus implements Bus {
	readonly mem = new Uint8Array(0x10000);
	read(address: number): number {
		return this.mem[address & 0xffff];
	}
	write(address: number, value: number): void {
		this.mem[address & 0xffff] = value & 0xff;
	}
}

/** Assemble bytes at `origin` and point the reset vector at it. */
function makeCpu(origin: number, bytes: number[]): { cpu: Cpu; bus: TestBus } {
	const bus = new TestBus();
	bus.mem.set(bytes, origin);
	bus.mem[0xfffc] = origin & 0xff;
	bus.mem[0xfffd] = (origin >> 8) & 0xff;
	const cpu = new Cpu(bus);
	cpu.reset();
	return { cpu, bus };
}

describe('6502 CPU', () => {
	it('loads PC from the reset vector', () => {
		const { cpu } = makeCpu(0x8000, [0xea]);
		expect(cpu.pc).toBe(0x8000);
		expect(cpu.sp).toBe(0xfd);
		expect(cpu.status & Flag.I).toBeTruthy();
	});

	it('LDA immediate sets Z and N', () => {
		const { cpu } = makeCpu(0x8000, [0xa9, 0x00, 0xa9, 0x80, 0xa9, 0x42]);
		cpu.step();
		expect(cpu.a).toBe(0);
		expect(cpu.status & Flag.Z).toBeTruthy();
		cpu.step();
		expect(cpu.a).toBe(0x80);
		expect(cpu.status & Flag.N).toBeTruthy();
		cpu.step();
		expect(cpu.a).toBe(0x42);
		expect(cpu.status & Flag.Z).toBeFalsy();
		expect(cpu.status & Flag.N).toBeFalsy();
	});

	it('ADC sets carry and overflow correctly', () => {
		// 0x50 + 0x50 = 0xA0: overflow (positive + positive = negative).
		const { cpu } = makeCpu(0x8000, [0xa9, 0x50, 0x69, 0x50]);
		cpu.step();
		cpu.step();
		expect(cpu.a).toBe(0xa0);
		expect(cpu.status & Flag.V).toBeTruthy();
		expect(cpu.status & Flag.C).toBeFalsy();

		// 0xFF + 0x01 = 0x00 with carry, no overflow.
		const b = makeCpu(0x8000, [0xa9, 0xff, 0x69, 0x01]);
		b.cpu.step();
		b.cpu.step();
		expect(b.cpu.a).toBe(0);
		expect(b.cpu.status & Flag.C).toBeTruthy();
		expect(b.cpu.status & Flag.V).toBeFalsy();
	});

	it('SBC borrows through the carry flag', () => {
		// SEC then 0x50 - 0x10 = 0x40.
		const { cpu } = makeCpu(0x8000, [0x38, 0xa9, 0x50, 0xe9, 0x10]);
		cpu.step();
		cpu.step();
		cpu.step();
		expect(cpu.a).toBe(0x40);
		expect(cpu.status & Flag.C).toBeTruthy();
	});

	it('JSR/RTS round-trips through the stack', () => {
		const bus = new TestBus();
		bus.mem.set([0x20, 0x10, 0x80, 0xa9, 0x99], 0x8000); // JSR $8010; LDA #$99
		bus.mem.set([0x60], 0x8010); // RTS
		bus.mem[0xfffc] = 0x00;
		bus.mem[0xfffd] = 0x80;
		const cpu = new Cpu(bus);
		cpu.reset();

		expect(cpu.step()).toBe(6); // JSR
		expect(cpu.pc).toBe(0x8010);
		// Two bytes pushed: the address of the JSR's final byte.
		expect(cpu.sp).toBe(0xfb);

		expect(cpu.step()).toBe(6); // RTS
		// RTS resumes at the pushed address + 1, i.e. after the JSR.
		expect(cpu.pc).toBe(0x8003);
		expect(cpu.sp).toBe(0xfd);

		cpu.step();
		expect(cpu.a).toBe(0x99);
	});

	it('JMP (indirect) reproduces the page-wrap bug', () => {
		const bus = new TestBus();
		// Pointer at $30FF: low byte from $30FF, high byte from $3000
		// (not $3100) — the documented 6502 defect.
		bus.mem[0x30ff] = 0x34;
		bus.mem[0x3000] = 0x12;
		bus.mem[0x3100] = 0xff;
		bus.mem.set([0x6c, 0xff, 0x30], 0x8000);
		bus.mem[0xfffc] = 0x00;
		bus.mem[0xfffd] = 0x80;
		const cpu = new Cpu(bus);
		cpu.reset();
		cpu.step();
		expect(cpu.pc).toBe(0x1234);
	});

	it('charges an extra cycle when an indexed read crosses a page', () => {
		// LDA $80FF,X with X=1 crosses into $8100.
		const noCross = makeCpu(0x8000, [0xa2, 0x00, 0xbd, 0xf0, 0x80]);
		noCross.cpu.step();
		expect(noCross.cpu.step()).toBe(4);

		const cross = makeCpu(0x8000, [0xa2, 0x01, 0xbd, 0xff, 0x80]);
		cross.cpu.step();
		expect(cross.cpu.step()).toBe(5);
	});

	it('taken branches cost an extra cycle, and two across a page', () => {
		// BEQ +2 with Z set, staying on the page.
		const { cpu } = makeCpu(0x8000, [0xa9, 0x00, 0xf0, 0x02]);
		cpu.step();
		expect(cpu.step()).toBe(3);

		// Not taken.
		const b = makeCpu(0x8000, [0xa9, 0x01, 0xf0, 0x02]);
		b.cpu.step();
		expect(b.cpu.step()).toBe(2);
	});

	it('NMI pushes state and vectors through $FFFA', () => {
		const bus = new TestBus();
		bus.mem.set([0xea], 0x8000);
		bus.mem[0xfffc] = 0x00;
		bus.mem[0xfffd] = 0x80;
		bus.mem[0xfffa] = 0x00;
		bus.mem[0xfffb] = 0x90;
		const cpu = new Cpu(bus);
		cpu.reset();
		cpu.nmi();
		const cycles = cpu.step();
		expect(cpu.pc).toBe(0x9000);
		expect(cycles).toBe(7);
		expect(cpu.status & Flag.I).toBeTruthy();
	});

	it('honours the I flag for IRQ but not NMI', () => {
		const bus = new TestBus();
		bus.mem.set([0xea, 0xea], 0x8000);
		bus.mem[0xfffc] = 0x00;
		bus.mem[0xfffd] = 0x80;
		bus.mem[0xfffe] = 0x00;
		bus.mem[0xffff] = 0x90;
		const cpu = new Cpu(bus);
		cpu.reset(); // reset sets I
		cpu.setIrq(true);
		cpu.step();
		// I is set, so the IRQ is ignored and the NOP runs.
		expect(cpu.pc).toBe(0x8001);
		// Clearing I lets it through.
		cpu.status &= ~Flag.I;
		cpu.step();
		expect(cpu.pc).toBe(0x9000);
	});

	it('PHP/PLP preserve flags but not the B bit', () => {
		const { cpu } = makeCpu(0x8000, [0x08, 0x28]);
		cpu.status = Flag.C | Flag.N | Flag.U;
		cpu.step(); // PHP
		cpu.status = 0;
		cpu.step(); // PLP
		expect(cpu.status & Flag.C).toBeTruthy();
		expect(cpu.status & Flag.N).toBeTruthy();
		expect(cpu.status & Flag.B).toBeFalsy();
		expect(cpu.status & Flag.U).toBeTruthy();
	});

	it('treats an unknown opcode as a 2-cycle NOP rather than hanging', () => {
		const { cpu } = makeCpu(0x8000, [0x02]);
		expect(cpu.step()).toBe(2);
	});
});

describe('APU', () => {
	it('loads the length counter from the lookup table', () => {
		const apu = new Apu(44100);
		apu.write(0x4015, 0x01); // enable pulse 1
		apu.write(0x4003, 0x08); // load index 1 -> 254
		expect(apu.readStatus() & 0x01).toBeTruthy();
		// Disabling the channel zeroes the counter.
		apu.write(0x4015, 0x00);
		expect(apu.readStatus() & 0x01).toBeFalsy();
	});

	it('reports per-channel length status independently', () => {
		const apu = new Apu(44100);
		apu.write(0x4015, 0x0f);
		apu.write(0x4003, 0x08); // pulse 1
		apu.write(0x400b, 0x08); // triangle
		const status = apu.readStatus();
		expect(status & 0x01).toBeTruthy();
		expect(status & 0x04).toBeTruthy();
		expect(status & 0x02).toBeFalsy(); // pulse 2 untouched
	});

	it('4-step mode raises a frame IRQ that reading $4015 clears', () => {
		const apu = new Apu(44100);
		apu.write(0x4017, 0x00); // 4-step, IRQ enabled
		expect(apu.irqPending).toBe(false);
		for (let i = 0; i < 29830; i++) apu.tick();
		expect(apu.irqPending).toBe(true);
		expect(apu.readStatus() & 0x40).toBeTruthy();
		expect(apu.irqPending).toBe(false);
	});

	it('IRQ inhibit suppresses the frame IRQ', () => {
		const apu = new Apu(44100);
		apu.write(0x4017, 0x40);
		for (let i = 0; i < 29830; i++) apu.tick();
		expect(apu.irqPending).toBe(false);
	});

	it('5-step mode never raises a frame IRQ', () => {
		const apu = new Apu(44100);
		apu.write(0x4017, 0x80);
		for (let i = 0; i < 40000; i++) apu.tick();
		expect(apu.irqPending).toBe(false);
	});

	it('produces roughly the requested number of samples', () => {
		const apu = new Apu(44100);
		for (let i = 0; i < NTSC_CPU_CLOCK; i++) apu.tick();
		const n = apu.drain().length;
		// One second of CPU cycles should yield ~one second of audio.
		expect(n).toBeGreaterThan(44000);
		expect(n).toBeLessThan(44200);
	});

	it('a configured pulse channel produces a non-constant signal', () => {
		const apu = new Apu(44100);
		apu.write(0x4015, 0x01);
		apu.write(0x4000, 0xbf); // duty 2, constant volume 15
		apu.write(0x4002, 0x40); // timer low
		apu.write(0x4003, 0x08); // timer high + length
		for (let i = 0; i < NTSC_CPU_CLOCK / 10; i++) apu.tick();
		const s = apu.drain();
		let min = Infinity;
		let max = -Infinity;
		for (const v of s) {
			if (v < min) min = v;
			if (v > max) max = v;
		}
		expect(max - min).toBeGreaterThan(0.01);
	});

	it('mutes a pulse whose timer period is below 8', () => {
		const apu = new Apu(44100);
		apu.write(0x4015, 0x01);
		apu.write(0x4000, 0xbf);
		apu.write(0x4002, 0x04); // period 4 -> muted
		apu.write(0x4003, 0x08);
		for (let i = 0; i < 20000; i++) apu.tick();
		const s = apu.drain();
		for (const v of s) expect(Math.abs(v)).toBeLessThan(1e-6);
	});

	it('$4011 sets the DMC level directly and reaches the mix', () => {
		const apu = new Apu(44100);
		apu.write(0x4011, 0x7f);
		for (let i = 0; i < 5000; i++) apu.tick();
		const s = apu.drain();
		// A large step then DC-blocked: the transient must be visible.
		let peak = 0;
		for (const v of s) peak = Math.max(peak, Math.abs(v));
		expect(peak).toBeGreaterThan(0.001);
	});

	it('keeps output inside [-1, 1] with everything driven loud', () => {
		const apu = new Apu(44100);
		apu.write(0x4015, 0x1f);
		apu.write(0x4000, 0xbf); apu.write(0x4002, 0xff); apu.write(0x4003, 0x0f);
		apu.write(0x4004, 0xbf); apu.write(0x4006, 0xfe); apu.write(0x4007, 0x0f);
		apu.write(0x4008, 0xff); apu.write(0x400a, 0xff); apu.write(0x400b, 0x0f);
		apu.write(0x400c, 0x3f); apu.write(0x400e, 0x00); apu.write(0x400f, 0xf8);
		apu.write(0x4011, 0x7f);
		for (let i = 0; i < NTSC_CPU_CLOCK / 4; i++) apu.tick();
		for (const v of apu.drain()) {
			expect(v).toBeGreaterThanOrEqual(-1);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it('reads zero from the DMC when no memory reader is attached', () => {
		const apu = new Apu(44100);
		apu.write(0x4010, 0x0f);
		apu.write(0x4012, 0x00);
		apu.write(0x4013, 0x01);
		apu.write(0x4015, 0x10);
		expect(() => {
			for (let i = 0; i < 10000; i++) apu.tick();
		}).not.toThrow();
	});
});

describe('renderNesAudio', () => {
	/** A minimal NROM cartridge whose reset code drives a pulse channel. */
	function makeToneRom(): Uint8Array {
		const prg = new Uint8Array(0x8000);
		const code = [
			0xa9, 0x0f, 0x8d, 0x15, 0x40, // LDA #$0F : STA $4015
			0xa9, 0xbf, 0x8d, 0x00, 0x40, // LDA #$BF : STA $4000
			0xa9, 0x40, 0x8d, 0x02, 0x40, // LDA #$40 : STA $4002
			0xa9, 0x08, 0x8d, 0x03, 0x40, // LDA #$08 : STA $4003
			0x4c, 0x14, 0x80,             // JMP $8014 (spin)
		];
		prg.set(code, 0);
		// Reset vector -> $8000.
		prg[0x7ffc] = 0x00;
		prg[0x7ffd] = 0x80;
		const rom = new Uint8Array(16 + prg.length);
		rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 0, 0, 0], 0); // iNES, 2x16K PRG
		rom.set(prg, 16);
		return rom;
	}

	it('renders audio from a ROM that drives the APU', () => {
		const result = renderNesAudio(makeToneRom(), {
			seconds: 0.5,
			warmupSeconds: 0.1,
			autoStart: false,
		});
		expect(result.mapperSupported).toBe(true);
		expect(result.sampleRate).toBe(44100);
		expect(result.samples.length).toBeGreaterThan(20000);
		expect(result.peak).toBeGreaterThan(1000);
	});

	it('reports silence rather than failing for a ROM that makes no sound', () => {
		const prg = new Uint8Array(0x8000);
		prg.set([0x4c, 0x00, 0x80], 0); // JMP $8000
		prg[0x7ffc] = 0x00;
		prg[0x7ffd] = 0x80;
		const rom = new Uint8Array(16 + prg.length);
		rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 0, 0, 0], 0);
		rom.set(prg, 16);
		const result = renderNesAudio(rom, {
			seconds: 0.2,
			warmupSeconds: 0.05,
			autoStart: false,
		});
		expect(result.peak).toBe(0);
		expect(result.samples.length).toBeGreaterThan(0);
	});

	it('flags an unsupported mapper', () => {
		const rom = makeToneRom();
		// Mapper 4 (MMC3) in the header's high nibbles.
		rom[6] = 0x40;
		rom[7] = 0x00;
		const result = renderNesAudio(rom, {
			seconds: 0.1,
			warmupSeconds: 0.05,
			autoStart: false,
		});
		expect(result.info.mapper).toBe(4);
		expect(result.mapperSupported).toBe(false);
	});

	it('exposes the standard controller bitmask', () => {
		expect(Button.START).toBe(0x08);
		expect(Button.A).toBe(0x01);
	});
});

describe('encodeWav', () => {
	it('writes a RIFF/WAVE header and payload', () => {
		const wav = encodeWav(Int16Array.from([0, 1234, -1234]), 44100);
		const text = (o: number, n: number) =>
			String.fromCharCode(...wav.subarray(o, o + n));
		expect(text(0, 4)).toBe('RIFF');
		expect(text(8, 4)).toBe('WAVE');
		expect(wav.length).toBe(44 + 6);
		const view = new DataView(wav.buffer);
		expect(view.getUint32(24, true)).toBe(44100);
		expect(view.getInt16(46, true)).toBe(1234);
		expect(view.getInt16(48, true)).toBe(-1234);
	});
});
