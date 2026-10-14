/**
 * Cursor over idTech BFG binary files. BFG's `idFile` mixes byte
 * orders: `ReadBig*` swaps from big-endian, while `ReadInt`,
 * `ReadFloat`, `ReadVec3` and string lengths are little-endian
 * (`framework/File.cpp`).
 */
export class Reader {
	pos = 0;
	readonly dv: DataView;
	constructor(readonly bytes: Uint8Array, pos = 0) {
		this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.pos = pos;
	}
	get remaining(): number {
		return this.bytes.length - this.pos;
	}
	private need(n: number): number {
		if (n < 0 || this.pos + n > this.bytes.length) throw new RangeError(`Read past end (${this.pos} + ${n} > ${this.bytes.length})`);
		const p = this.pos;
		this.pos += n;
		return p;
	}
	u8(): number {
		return this.bytes[this.need(1)]!;
	}
	bool(): boolean {
		return this.u8() !== 0;
	}
	/** `ReadBig(int)`. */
	i32be(): number {
		return this.dv.getInt32(this.need(4), false);
	}
	u32be(): number {
		return this.dv.getUint32(this.need(4), false);
	}
	u16be(): number {
		return this.dv.getUint16(this.need(2), false);
	}
	i16be(): number {
		return this.dv.getInt16(this.need(2), false);
	}
	f32be(): number {
		return this.dv.getFloat32(this.need(4), false);
	}
	/** `ReadInt` / `ReadFloat`. */
	i32le(): number {
		return this.dv.getInt32(this.need(4), true);
	}
	f32le(): number {
		return this.dv.getFloat32(this.need(4), true);
	}
	/** `ReadVec3`: three little-endian floats. */
	vec3le(): [number, number, number] {
		return [this.f32le(), this.f32le(), this.f32le()];
	}
	vec3be(): [number, number, number] {
		return [this.f32be(), this.f32be(), this.f32be()];
	}
	/** `ID_TIME_T` (64-bit, big-endian): returned as a number. */
	time64be(): number {
		const hi = this.u32be();
		const lo = this.u32be();
		return hi * 2 ** 32 + lo;
	}
	/** `ReadString`: little-endian i32 length, then bytes. */
	string(): string {
		const n = this.i32le();
		if (n < 0 || n > 1 << 20) throw new RangeError(`Bad string length ${n}`);
		const p = this.need(n);
		return new TextDecoder().decode(this.bytes.subarray(p, p + n));
	}
	skip(n: number): void {
		this.need(n);
	}
}

export function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}
