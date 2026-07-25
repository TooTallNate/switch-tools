/**
 * MOS 6502 CPU core (NES variant).
 *
 * The NES uses a Ricoh 2A03, which is a 6502 with decimal mode
 * disabled and an APU bolted on. This core implements the documented
 * instruction set plus the handful of undocumented opcodes that
 * commercial games actually rely on (mostly multi-byte NOPs used for
 * timing padding), which is enough to run a game's sound engine.
 *
 * Cycle counting matters here: the APU is clocked from the CPU, so
 * an instruction that reports the wrong duration detunes the music.
 * Two subtleties are therefore modelled explicitly:
 *
 *   • Page-crossing penalties. Indexed reads (`abs,X` / `abs,Y` /
 *     `(zp),Y`) cost an extra cycle when the index carries into a new
 *     256-byte page, because the 6502 speculatively reads from the
 *     un-carried address first. Read-modify-write and store forms
 *     always pay the cycle, so they are flagged separately.
 *
 *   • The `JMP (indirect)` page-wrap bug. When the pointer's low byte
 *     is $FF, the high byte is fetched from the *start* of the same
 *     page rather than the next one. Real games depend on this.
 *
 * Decimal mode (the `D` flag) is honoured as a flag but has no effect
 * on ADC/SBC, matching the 2A03.
 */

/** Anything the CPU can read and write. */
export interface Bus {
	read(address: number): number;
	write(address: number, value: number): void;
}

/** Status register bits. */
export const Flag = {
	C: 0x01,
	Z: 0x02,
	I: 0x04,
	D: 0x08,
	B: 0x10,
	U: 0x20,
	V: 0x40,
	N: 0x80,
} as const;

/** How an instruction forms its effective address. */
type Mode =
	| 'imp'
	| 'acc'
	| 'imm'
	| 'zp'
	| 'zpx'
	| 'zpy'
	| 'abs'
	| 'absx'
	| 'absy'
	| 'ind'
	| 'indx'
	| 'indy'
	| 'rel';

interface OpInfo {
	name: string;
	mode: Mode;
	cycles: number;
	/**
	 * True when the instruction pays the page-cross penalty on an
	 * indexed read. Stores and read-modify-writes do not, because
	 * they always take the extra cycle, which is already folded into
	 * their base count.
	 */
	pageCross: boolean;
}

/** Build the 256-entry opcode table. */
function buildTable(): Array<OpInfo | null> {
	const t: Array<OpInfo | null> = new Array(256).fill(null);
	const set = (
		opcode: number,
		name: string,
		mode: Mode,
		cycles: number,
		pageCross = false,
	) => {
		t[opcode] = { name, mode, cycles, pageCross };
	};

	// Load / store
	set(0xa9, 'LDA', 'imm', 2); set(0xa5, 'LDA', 'zp', 3);
	set(0xb5, 'LDA', 'zpx', 4); set(0xad, 'LDA', 'abs', 4);
	set(0xbd, 'LDA', 'absx', 4, true); set(0xb9, 'LDA', 'absy', 4, true);
	set(0xa1, 'LDA', 'indx', 6); set(0xb1, 'LDA', 'indy', 5, true);
	set(0xa2, 'LDX', 'imm', 2); set(0xa6, 'LDX', 'zp', 3);
	set(0xb6, 'LDX', 'zpy', 4); set(0xae, 'LDX', 'abs', 4);
	set(0xbe, 'LDX', 'absy', 4, true);
	set(0xa0, 'LDY', 'imm', 2); set(0xa4, 'LDY', 'zp', 3);
	set(0xb4, 'LDY', 'zpx', 4); set(0xac, 'LDY', 'abs', 4);
	set(0xbc, 'LDY', 'absx', 4, true);
	set(0x85, 'STA', 'zp', 3); set(0x95, 'STA', 'zpx', 4);
	set(0x8d, 'STA', 'abs', 4); set(0x9d, 'STA', 'absx', 5);
	set(0x99, 'STA', 'absy', 5); set(0x81, 'STA', 'indx', 6);
	set(0x91, 'STA', 'indy', 6);
	set(0x86, 'STX', 'zp', 3); set(0x96, 'STX', 'zpy', 4);
	set(0x8e, 'STX', 'abs', 4);
	set(0x84, 'STY', 'zp', 3); set(0x94, 'STY', 'zpx', 4);
	set(0x8c, 'STY', 'abs', 4);

	// Transfers / stack
	set(0xaa, 'TAX', 'imp', 2); set(0xa8, 'TAY', 'imp', 2);
	set(0xba, 'TSX', 'imp', 2); set(0x8a, 'TXA', 'imp', 2);
	set(0x9a, 'TXS', 'imp', 2); set(0x98, 'TYA', 'imp', 2);
	set(0x48, 'PHA', 'imp', 3); set(0x08, 'PHP', 'imp', 3);
	set(0x68, 'PLA', 'imp', 4); set(0x28, 'PLP', 'imp', 4);

	// Logic
	for (const [op, mode, cyc, pc] of [
		[0x29, 'imm', 2, false], [0x25, 'zp', 3, false], [0x35, 'zpx', 4, false],
		[0x2d, 'abs', 4, false], [0x3d, 'absx', 4, true], [0x39, 'absy', 4, true],
		[0x21, 'indx', 6, false], [0x31, 'indy', 5, true],
	] as const) set(op, 'AND', mode, cyc, pc);
	for (const [op, mode, cyc, pc] of [
		[0x49, 'imm', 2, false], [0x45, 'zp', 3, false], [0x55, 'zpx', 4, false],
		[0x4d, 'abs', 4, false], [0x5d, 'absx', 4, true], [0x59, 'absy', 4, true],
		[0x41, 'indx', 6, false], [0x51, 'indy', 5, true],
	] as const) set(op, 'EOR', mode, cyc, pc);
	for (const [op, mode, cyc, pc] of [
		[0x09, 'imm', 2, false], [0x05, 'zp', 3, false], [0x15, 'zpx', 4, false],
		[0x0d, 'abs', 4, false], [0x1d, 'absx', 4, true], [0x19, 'absy', 4, true],
		[0x01, 'indx', 6, false], [0x11, 'indy', 5, true],
	] as const) set(op, 'ORA', mode, cyc, pc);
	set(0x24, 'BIT', 'zp', 3); set(0x2c, 'BIT', 'abs', 4);

	// Arithmetic
	for (const [op, mode, cyc, pc] of [
		[0x69, 'imm', 2, false], [0x65, 'zp', 3, false], [0x75, 'zpx', 4, false],
		[0x6d, 'abs', 4, false], [0x7d, 'absx', 4, true], [0x79, 'absy', 4, true],
		[0x61, 'indx', 6, false], [0x71, 'indy', 5, true],
	] as const) set(op, 'ADC', mode, cyc, pc);
	for (const [op, mode, cyc, pc] of [
		[0xe9, 'imm', 2, false], [0xe5, 'zp', 3, false], [0xf5, 'zpx', 4, false],
		[0xed, 'abs', 4, false], [0xfd, 'absx', 4, true], [0xf9, 'absy', 4, true],
		[0xe1, 'indx', 6, false], [0xf1, 'indy', 5, true],
	] as const) set(op, 'SBC', mode, cyc, pc);
	for (const [op, mode, cyc, pc] of [
		[0xc9, 'imm', 2, false], [0xc5, 'zp', 3, false], [0xd5, 'zpx', 4, false],
		[0xcd, 'abs', 4, false], [0xdd, 'absx', 4, true], [0xd9, 'absy', 4, true],
		[0xc1, 'indx', 6, false], [0xd1, 'indy', 5, true],
	] as const) set(op, 'CMP', mode, cyc, pc);
	set(0xe0, 'CPX', 'imm', 2); set(0xe4, 'CPX', 'zp', 3);
	set(0xec, 'CPX', 'abs', 4);
	set(0xc0, 'CPY', 'imm', 2); set(0xc4, 'CPY', 'zp', 3);
	set(0xcc, 'CPY', 'abs', 4);

	// Increment / decrement
	set(0xe6, 'INC', 'zp', 5); set(0xf6, 'INC', 'zpx', 6);
	set(0xee, 'INC', 'abs', 6); set(0xfe, 'INC', 'absx', 7);
	set(0xc6, 'DEC', 'zp', 5); set(0xd6, 'DEC', 'zpx', 6);
	set(0xce, 'DEC', 'abs', 6); set(0xde, 'DEC', 'absx', 7);
	set(0xe8, 'INX', 'imp', 2); set(0xc8, 'INY', 'imp', 2);
	set(0xca, 'DEX', 'imp', 2); set(0x88, 'DEY', 'imp', 2);

	// Shifts
	set(0x0a, 'ASL', 'acc', 2); set(0x06, 'ASL', 'zp', 5);
	set(0x16, 'ASL', 'zpx', 6); set(0x0e, 'ASL', 'abs', 6);
	set(0x1e, 'ASL', 'absx', 7);
	set(0x4a, 'LSR', 'acc', 2); set(0x46, 'LSR', 'zp', 5);
	set(0x56, 'LSR', 'zpx', 6); set(0x4e, 'LSR', 'abs', 6);
	set(0x5e, 'LSR', 'absx', 7);
	set(0x2a, 'ROL', 'acc', 2); set(0x26, 'ROL', 'zp', 5);
	set(0x36, 'ROL', 'zpx', 6); set(0x2e, 'ROL', 'abs', 6);
	set(0x3e, 'ROL', 'absx', 7);
	set(0x6a, 'ROR', 'acc', 2); set(0x66, 'ROR', 'zp', 5);
	set(0x76, 'ROR', 'zpx', 6); set(0x6e, 'ROR', 'abs', 6);
	set(0x7e, 'ROR', 'absx', 7);

	// Jumps / branches
	set(0x4c, 'JMP', 'abs', 3); set(0x6c, 'JMP', 'ind', 5);
	set(0x20, 'JSR', 'abs', 6); set(0x60, 'RTS', 'imp', 6);
	set(0x40, 'RTI', 'imp', 6); set(0x00, 'BRK', 'imp', 7);
	set(0x10, 'BPL', 'rel', 2); set(0x30, 'BMI', 'rel', 2);
	set(0x50, 'BVC', 'rel', 2); set(0x70, 'BVS', 'rel', 2);
	set(0x90, 'BCC', 'rel', 2); set(0xb0, 'BCS', 'rel', 2);
	set(0xd0, 'BNE', 'rel', 2); set(0xf0, 'BEQ', 'rel', 2);

	// Flags
	set(0x18, 'CLC', 'imp', 2); set(0x38, 'SEC', 'imp', 2);
	set(0x58, 'CLI', 'imp', 2); set(0x78, 'SEI', 'imp', 2);
	set(0xb8, 'CLV', 'imp', 2); set(0xd8, 'CLD', 'imp', 2);
	set(0xf8, 'SED', 'imp', 2);
	set(0xea, 'NOP', 'imp', 2);

	// Undocumented opcodes that retail games actually execute. The
	// multi-byte NOPs are used as timing padding; LAX/SAX/DCP/ISB/
	// SLO/RLA/SRE/RRA show up in a handful of titles.
	for (const op of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) {
		set(op, 'NOP', 'imp', 2);
	}
	for (const op of [0x80, 0x82, 0x89, 0xc2, 0xe2]) set(op, 'NOP', 'imm', 2);
	for (const op of [0x04, 0x44, 0x64]) set(op, 'NOP', 'zp', 3);
	for (const op of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) {
		set(op, 'NOP', 'zpx', 4);
	}
	set(0x0c, 'NOP', 'abs', 4);
	for (const op of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) {
		set(op, 'NOP', 'absx', 4, true);
	}
	set(0xa7, 'LAX', 'zp', 3); set(0xb7, 'LAX', 'zpy', 4);
	set(0xaf, 'LAX', 'abs', 4); set(0xbf, 'LAX', 'absy', 4, true);
	set(0xa3, 'LAX', 'indx', 6); set(0xb3, 'LAX', 'indy', 5, true);
	set(0x87, 'SAX', 'zp', 3); set(0x97, 'SAX', 'zpy', 4);
	set(0x8f, 'SAX', 'abs', 4); set(0x83, 'SAX', 'indx', 6);
	set(0xeb, 'SBC', 'imm', 2);
	for (const [op, mode, cyc] of [
		[0xc7, 'zp', 5], [0xd7, 'zpx', 6], [0xcf, 'abs', 6],
		[0xdf, 'absx', 7], [0xdb, 'absy', 7], [0xc3, 'indx', 8], [0xd3, 'indy', 8],
	] as const) set(op, 'DCP', mode, cyc);
	for (const [op, mode, cyc] of [
		[0xe7, 'zp', 5], [0xf7, 'zpx', 6], [0xef, 'abs', 6],
		[0xff, 'absx', 7], [0xfb, 'absy', 7], [0xe3, 'indx', 8], [0xf3, 'indy', 8],
	] as const) set(op, 'ISB', mode, cyc);
	for (const [op, mode, cyc] of [
		[0x07, 'zp', 5], [0x17, 'zpx', 6], [0x0f, 'abs', 6],
		[0x1f, 'absx', 7], [0x1b, 'absy', 7], [0x03, 'indx', 8], [0x13, 'indy', 8],
	] as const) set(op, 'SLO', mode, cyc);
	for (const [op, mode, cyc] of [
		[0x27, 'zp', 5], [0x37, 'zpx', 6], [0x2f, 'abs', 6],
		[0x3f, 'absx', 7], [0x3b, 'absy', 7], [0x23, 'indx', 8], [0x33, 'indy', 8],
	] as const) set(op, 'RLA', mode, cyc);
	for (const [op, mode, cyc] of [
		[0x47, 'zp', 5], [0x57, 'zpx', 6], [0x4f, 'abs', 6],
		[0x5f, 'absx', 7], [0x5b, 'absy', 7], [0x43, 'indx', 8], [0x53, 'indy', 8],
	] as const) set(op, 'SRE', mode, cyc);
	for (const [op, mode, cyc] of [
		[0x67, 'zp', 5], [0x77, 'zpx', 6], [0x6f, 'abs', 6],
		[0x7f, 'absx', 7], [0x7b, 'absy', 7], [0x63, 'indx', 8], [0x73, 'indy', 8],
	] as const) set(op, 'RRA', mode, cyc);

	return t;
}

const TABLE = buildTable();

/** A 6502 CPU. */
export class Cpu {
	a = 0;
	x = 0;
	y = 0;
	sp = 0xfd;
	pc = 0;
	status = Flag.I | Flag.U;
	/** Total cycles executed since construction. */
	cycles = 0;

	private nmiLine = false;
	private irqLine = false;
	private readonly bus: Bus;

	constructor(bus: Bus) {
		this.bus = bus;
	}

	/** Load PC from the reset vector and re-initialise registers. */
	reset(): void {
		this.a = 0;
		this.x = 0;
		this.y = 0;
		this.sp = 0xfd;
		this.status = Flag.I | Flag.U;
		this.pc = this.read16(0xfffc);
	}

	/** Assert the non-maskable interrupt line (edge-triggered). */
	nmi(): void {
		this.nmiLine = true;
	}

	/** Level-triggered IRQ; ignored while the I flag is set. */
	setIrq(active: boolean): void {
		this.irqLine = active;
	}

	private read(address: number): number {
		return this.bus.read(address & 0xffff) & 0xff;
	}

	private write(address: number, value: number): void {
		this.bus.write(address & 0xffff, value & 0xff);
	}

	private read16(address: number): number {
		return this.read(address) | (this.read(address + 1) << 8);
	}

	private push(value: number): void {
		this.write(0x100 + this.sp, value);
		this.sp = (this.sp - 1) & 0xff;
	}

	private pull(): number {
		this.sp = (this.sp + 1) & 0xff;
		return this.read(0x100 + this.sp);
	}

	private setFlag(mask: number, on: boolean): void {
		if (on) this.status |= mask;
		else this.status &= ~mask & 0xff;
	}

	private setZN(value: number): void {
		this.setFlag(Flag.Z, (value & 0xff) === 0);
		this.setFlag(Flag.N, (value & 0x80) !== 0);
	}

	private interrupt(vector: number, brk: boolean): void {
		this.push((this.pc >> 8) & 0xff);
		this.push(this.pc & 0xff);
		// The B flag is only set in the copy pushed by BRK/PHP.
		this.push((this.status | Flag.U | (brk ? Flag.B : 0)) & 0xff);
		this.status |= Flag.I;
		this.pc = this.read16(vector);
		this.cycles += 7;
	}

	/**
	 * Execute one instruction (or service a pending interrupt) and
	 * return the number of cycles it consumed.
	 */
	step(): number {
		const before = this.cycles;

		if (this.nmiLine) {
			this.nmiLine = false;
			this.interrupt(0xfffa, false);
			return this.cycles - before;
		}
		if (this.irqLine && (this.status & Flag.I) === 0) {
			this.interrupt(0xfffe, false);
			return this.cycles - before;
		}

		const opcode = this.read(this.pc);
		this.pc = (this.pc + 1) & 0xffff;
		const op = TABLE[opcode];
		if (!op) {
			// Unknown opcode: treat as a 2-cycle NOP so a stray byte
			// cannot wedge the emulator.
			this.cycles += 2;
			return 2;
		}

		let extra = 0;
		let address = 0;
		let crossed = false;

		switch (op.mode) {
			case 'imp':
			case 'acc':
				break;
			case 'imm':
				address = this.pc;
				this.pc = (this.pc + 1) & 0xffff;
				break;
			case 'zp':
				address = this.read(this.pc);
				this.pc = (this.pc + 1) & 0xffff;
				break;
			case 'zpx':
				address = (this.read(this.pc) + this.x) & 0xff;
				this.pc = (this.pc + 1) & 0xffff;
				break;
			case 'zpy':
				address = (this.read(this.pc) + this.y) & 0xff;
				this.pc = (this.pc + 1) & 0xffff;
				break;
			case 'abs':
				address = this.read16(this.pc);
				this.pc = (this.pc + 2) & 0xffff;
				break;
			case 'absx': {
				const base = this.read16(this.pc);
				this.pc = (this.pc + 2) & 0xffff;
				address = (base + this.x) & 0xffff;
				crossed = (base & 0xff00) !== (address & 0xff00);
				break;
			}
			case 'absy': {
				const base = this.read16(this.pc);
				this.pc = (this.pc + 2) & 0xffff;
				address = (base + this.y) & 0xffff;
				crossed = (base & 0xff00) !== (address & 0xff00);
				break;
			}
			case 'ind': {
				const ptr = this.read16(this.pc);
				this.pc = (this.pc + 2) & 0xffff;
				// The infamous page-wrap bug: the high byte comes from
				// the same page when the low byte is $FF.
				const hi = (ptr & 0xff00) | ((ptr + 1) & 0xff);
				address = this.read(ptr) | (this.read(hi) << 8);
				break;
			}
			case 'indx': {
				const zp = (this.read(this.pc) + this.x) & 0xff;
				this.pc = (this.pc + 1) & 0xffff;
				address = this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
				break;
			}
			case 'indy': {
				const zp = this.read(this.pc);
				this.pc = (this.pc + 1) & 0xffff;
				const base = this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
				address = (base + this.y) & 0xffff;
				crossed = (base & 0xff00) !== (address & 0xff00);
				break;
			}
			case 'rel': {
				const offset = this.read(this.pc);
				this.pc = (this.pc + 1) & 0xffff;
				address = (this.pc + (offset < 0x80 ? offset : offset - 256)) & 0xffff;
				break;
			}
		}

		if (op.pageCross && crossed) extra++;

		const load = () => (op.mode === 'acc' ? this.a : this.read(address));
		const store = (v: number) => {
			if (op.mode === 'acc') this.a = v & 0xff;
			else this.write(address, v);
		};
		const branch = (take: boolean) => {
			if (!take) return;
			extra++;
			// Taken branches cost another cycle when they leave the page.
			if ((this.pc & 0xff00) !== (address & 0xff00)) extra++;
			this.pc = address;
		};
		const compare = (reg: number) => {
			const value = load();
			const diff = (reg - value) & 0xff;
			this.setFlag(Flag.C, reg >= value);
			this.setZN(diff);
		};
		const adc = (value: number) => {
			const carry = this.status & Flag.C ? 1 : 0;
			const sum = this.a + value + carry;
			// Overflow when both operands share a sign that differs
			// from the result's.
			this.setFlag(
				Flag.V,
				((~(this.a ^ value) & (this.a ^ sum)) & 0x80) !== 0,
			);
			this.setFlag(Flag.C, sum > 0xff);
			this.a = sum & 0xff;
			this.setZN(this.a);
		};

		switch (op.name) {
			case 'LDA': this.a = load(); this.setZN(this.a); break;
			case 'LDX': this.x = load(); this.setZN(this.x); break;
			case 'LDY': this.y = load(); this.setZN(this.y); break;
			case 'STA': this.write(address, this.a); break;
			case 'STX': this.write(address, this.x); break;
			case 'STY': this.write(address, this.y); break;
			case 'TAX': this.x = this.a; this.setZN(this.x); break;
			case 'TAY': this.y = this.a; this.setZN(this.y); break;
			case 'TSX': this.x = this.sp; this.setZN(this.x); break;
			case 'TXA': this.a = this.x; this.setZN(this.a); break;
			case 'TXS': this.sp = this.x; break;
			case 'TYA': this.a = this.y; this.setZN(this.a); break;
			case 'PHA': this.push(this.a); break;
			case 'PHP': this.push(this.status | Flag.B | Flag.U); break;
			case 'PLA': this.a = this.pull(); this.setZN(this.a); break;
			case 'PLP':
				// B is not a real bit; U always reads as set.
				this.status = (this.pull() & ~Flag.B & 0xff) | Flag.U;
				break;
			case 'AND': this.a &= load(); this.setZN(this.a); break;
			case 'EOR': this.a ^= load(); this.setZN(this.a); break;
			case 'ORA': this.a |= load(); this.setZN(this.a); break;
			case 'BIT': {
				const value = load();
				this.setFlag(Flag.Z, (this.a & value) === 0);
				this.setFlag(Flag.N, (value & 0x80) !== 0);
				this.setFlag(Flag.V, (value & 0x40) !== 0);
				break;
			}
			case 'ADC': adc(load()); break;
			case 'SBC': adc(load() ^ 0xff); break;
			case 'CMP': compare(this.a); break;
			case 'CPX': compare(this.x); break;
			case 'CPY': compare(this.y); break;
			case 'INC': { const v = (load() + 1) & 0xff; store(v); this.setZN(v); break; }
			case 'DEC': { const v = (load() - 1) & 0xff; store(v); this.setZN(v); break; }
			case 'INX': this.x = (this.x + 1) & 0xff; this.setZN(this.x); break;
			case 'INY': this.y = (this.y + 1) & 0xff; this.setZN(this.y); break;
			case 'DEX': this.x = (this.x - 1) & 0xff; this.setZN(this.x); break;
			case 'DEY': this.y = (this.y - 1) & 0xff; this.setZN(this.y); break;
			case 'ASL': {
				const v = load();
				this.setFlag(Flag.C, (v & 0x80) !== 0);
				const r = (v << 1) & 0xff;
				store(r); this.setZN(r); break;
			}
			case 'LSR': {
				const v = load();
				this.setFlag(Flag.C, (v & 1) !== 0);
				const r = v >> 1;
				store(r); this.setZN(r); break;
			}
			case 'ROL': {
				const v = load();
				const carry = this.status & Flag.C ? 1 : 0;
				this.setFlag(Flag.C, (v & 0x80) !== 0);
				const r = ((v << 1) | carry) & 0xff;
				store(r); this.setZN(r); break;
			}
			case 'ROR': {
				const v = load();
				const carry = this.status & Flag.C ? 0x80 : 0;
				this.setFlag(Flag.C, (v & 1) !== 0);
				const r = (v >> 1) | carry;
				store(r); this.setZN(r); break;
			}
			case 'JMP': this.pc = address; break;
			case 'JSR': {
				// The pushed address is the last byte of this
				// instruction, so RTS adds one to resume.
				const ret = (this.pc - 1) & 0xffff;
				this.push((ret >> 8) & 0xff);
				this.push(ret & 0xff);
				this.pc = address;
				break;
			}
			case 'RTS': this.pc = ((this.pull() | (this.pull() << 8)) + 1) & 0xffff; break;
			case 'RTI':
				this.status = (this.pull() & ~Flag.B & 0xff) | Flag.U;
				this.pc = this.pull() | (this.pull() << 8);
				break;
			case 'BRK':
				this.pc = (this.pc + 1) & 0xffff;
				this.interrupt(0xfffe, true);
				// interrupt() already charged 7 cycles.
				return this.cycles - before;
			case 'BPL': branch((this.status & Flag.N) === 0); break;
			case 'BMI': branch((this.status & Flag.N) !== 0); break;
			case 'BVC': branch((this.status & Flag.V) === 0); break;
			case 'BVS': branch((this.status & Flag.V) !== 0); break;
			case 'BCC': branch((this.status & Flag.C) === 0); break;
			case 'BCS': branch((this.status & Flag.C) !== 0); break;
			case 'BNE': branch((this.status & Flag.Z) === 0); break;
			case 'BEQ': branch((this.status & Flag.Z) !== 0); break;
			case 'CLC': this.setFlag(Flag.C, false); break;
			case 'SEC': this.setFlag(Flag.C, true); break;
			case 'CLI': this.setFlag(Flag.I, false); break;
			case 'SEI': this.setFlag(Flag.I, true); break;
			case 'CLV': this.setFlag(Flag.V, false); break;
			case 'CLD': this.setFlag(Flag.D, false); break;
			case 'SED': this.setFlag(Flag.D, true); break;
			case 'NOP': break;
			// --- undocumented ---
			case 'LAX': this.a = load(); this.x = this.a; this.setZN(this.a); break;
			case 'SAX': this.write(address, this.a & this.x); break;
			case 'DCP': {
				const v = (load() - 1) & 0xff;
				store(v);
				this.setFlag(Flag.C, this.a >= v);
				this.setZN((this.a - v) & 0xff);
				break;
			}
			case 'ISB': { const v = (load() + 1) & 0xff; store(v); adc(v ^ 0xff); break; }
			case 'SLO': {
				const v = load();
				this.setFlag(Flag.C, (v & 0x80) !== 0);
				const r = (v << 1) & 0xff;
				store(r); this.a |= r; this.setZN(this.a); break;
			}
			case 'RLA': {
				const v = load();
				const carry = this.status & Flag.C ? 1 : 0;
				this.setFlag(Flag.C, (v & 0x80) !== 0);
				const r = ((v << 1) | carry) & 0xff;
				store(r); this.a &= r; this.setZN(this.a); break;
			}
			case 'SRE': {
				const v = load();
				this.setFlag(Flag.C, (v & 1) !== 0);
				const r = v >> 1;
				store(r); this.a ^= r; this.setZN(this.a); break;
			}
			case 'RRA': {
				const v = load();
				const carry = this.status & Flag.C ? 0x80 : 0;
				this.setFlag(Flag.C, (v & 1) !== 0);
				const r = (v >> 1) | carry;
				store(r); adc(r); break;
			}
		}

		const used = op.cycles + extra;
		this.cycles += used;
		return used;
	}
}
