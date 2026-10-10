/**
 * Minimal read-only FlatBuffers table reader (little-endian).
 *
 * Game Freak's GFLX formats are plain FlatBuffers with no file magic.
 * Rather than depend on the `flatbuffers` runtime plus generated code
 * for a schema we'd have to maintain anyway, we read tables by field
 * slot directly: slot `n` lives at vtable offset `4 + 2n`. All
 * accessors bounds-check, so a malformed buffer throws a `RangeError`
 * from `DataView` rather than reading garbage silently.
 */

const utf8 = new TextDecoder();

export class FlatBuffer {
	readonly bytes: Uint8Array;
	readonly view: DataView;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	/** The root table (u32 offset at byte 0). */
	root(): Table {
		return new Table(this, this.view.getUint32(0, true));
	}

	/** Read a FlatBuffers string (u32 length + UTF-8 bytes) at `pos`. */
	stringAt(pos: number): string {
		const n = this.view.getUint32(pos, true);
		if (pos + 4 + n > this.bytes.length) throw new RangeError('String out of bounds');
		return utf8.decode(this.bytes.subarray(pos + 4, pos + 4 + n));
	}
}

/** A vector's element count and the absolute position of element 0. */
export interface VectorRef {
	length: number;
	start: number;
}

export class Table {
	readonly fb: FlatBuffer;
	readonly view: DataView;
	/** Absolute position of the table. */
	readonly pos: number;
	/** Absolute position of the table's vtable. */
	readonly vtable: number;
	/** vtable size in bytes. */
	readonly vtableSize: number;
	/** Inline object size in bytes. */
	readonly objectSize: number;

	constructor(fb: FlatBuffer, pos: number) {
		this.fb = fb;
		this.view = fb.view;
		this.pos = pos;
		this.vtable = pos - this.view.getInt32(pos, true);
		this.vtableSize = this.view.getUint16(this.vtable, true);
		this.objectSize = this.view.getUint16(this.vtable + 2, true);
	}

	/** Number of field slots in the (possibly trimmed) vtable. */
	get slotCount(): number {
		return Math.max(0, (this.vtableSize - 4) >> 1);
	}

	/** Structural sanity: vtable + inline object lie within the buffer. */
	isSane(): boolean {
		const len = this.fb.bytes.length;
		return (
			this.vtableSize >= 4 &&
			(this.vtableSize & 1) === 0 &&
			this.objectSize >= 4 &&
			this.vtable !== this.pos &&
			this.vtable >= 0 &&
			this.vtable + this.vtableSize <= len &&
			this.pos + this.objectSize <= len
		);
	}

	/** Field offset relative to the table, or 0 if absent. */
	offset(slot: number): number {
		const o = 4 + slot * 2;
		if (o >= this.vtableSize) return 0;
		return this.view.getUint16(this.vtable + o, true);
	}

	has(slot: number): boolean {
		return this.offset(slot) !== 0;
	}

	u8(slot: number, def = 0): number {
		const o = this.offset(slot);
		return o ? this.view.getUint8(this.pos + o) : def;
	}

	i8(slot: number, def = 0): number {
		const o = this.offset(slot);
		return o ? this.view.getInt8(this.pos + o) : def;
	}

	bool(slot: number, def = false): boolean {
		const o = this.offset(slot);
		return o ? this.view.getUint8(this.pos + o) !== 0 : def;
	}

	u16(slot: number, def = 0): number {
		const o = this.offset(slot);
		return o ? this.view.getUint16(this.pos + o, true) : def;
	}

	u32(slot: number, def = 0): number {
		const o = this.offset(slot);
		return o ? this.view.getUint32(this.pos + o, true) : def;
	}

	i32(slot: number, def = 0): number {
		const o = this.offset(slot);
		return o ? this.view.getInt32(this.pos + o, true) : def;
	}

	f32(slot: number, def = 0): number {
		const o = this.offset(slot);
		return o ? this.view.getFloat32(this.pos + o, true) : def;
	}

	/** Absolute position of an inline struct field, or -1 if absent. */
	struct(slot: number): number {
		const o = this.offset(slot);
		return o ? this.pos + o : -1;
	}

	/** `n` consecutive f32s from an inline struct, or `null` if absent. */
	floats(slot: number, n: number): number[] | null {
		const p = this.struct(slot);
		if (p < 0) return null;
		const out: number[] = new Array(n);
		for (let i = 0; i < n; i++) out[i] = this.view.getFloat32(p + i * 4, true);
		return out;
	}

	/** Absolute target of an offset field (table / vector / string), or 0. */
	private indirect(slot: number): number {
		const o = this.offset(slot);
		if (!o) return 0;
		const p = this.pos + o;
		return p + this.view.getUint32(p, true);
	}

	table(slot: number): Table | null {
		const p = this.indirect(slot);
		return p ? new Table(this.fb, p) : null;
	}

	str(slot: number): string | null {
		const p = this.indirect(slot);
		return p ? this.fb.stringAt(p) : null;
	}

	vector(slot: number): VectorRef | null {
		const p = this.indirect(slot);
		return p ? { length: this.view.getUint32(p, true), start: p + 4 } : null;
	}

	vectorLength(slot: number): number {
		return this.vector(slot)?.length ?? 0;
	}

	tables(slot: number): Table[] {
		const v = this.vector(slot);
		if (!v) return [];
		const out: Table[] = new Array(v.length);
		for (let i = 0; i < v.length; i++) {
			const e = v.start + i * 4;
			out[i] = new Table(this.fb, e + this.view.getUint32(e, true));
		}
		return out;
	}

	strings(slot: number): string[] {
		const v = this.vector(slot);
		if (!v) return [];
		const out: string[] = new Array(v.length);
		for (let i = 0; i < v.length; i++) {
			const e = v.start + i * 4;
			out[i] = this.fb.stringAt(e + this.view.getUint32(e, true));
		}
		return out;
	}

	bytes(slot: number): Uint8Array | null {
		const v = this.vector(slot);
		if (!v) return null;
		if (v.start + v.length > this.fb.bytes.length) throw new RangeError('Vector out of bounds');
		return this.fb.bytes.subarray(v.start, v.start + v.length);
	}

	u16s(slot: number): Uint16Array | null {
		const v = this.vector(slot);
		if (!v) return null;
		const out = new Uint16Array(v.length);
		for (let i = 0; i < v.length; i++) out[i] = this.view.getUint16(v.start + i * 2, true);
		return out;
	}

	u32s(slot: number): Uint32Array | null {
		const v = this.vector(slot);
		if (!v) return null;
		const out = new Uint32Array(v.length);
		for (let i = 0; i < v.length; i++) out[i] = this.view.getUint32(v.start + i * 4, true);
		return out;
	}

	f32s(slot: number): Float32Array | null {
		const v = this.vector(slot);
		if (!v) return null;
		const out = new Float32Array(v.length);
		for (let i = 0; i < v.length; i++) out[i] = this.view.getFloat32(v.start + i * 4, true);
		return out;
	}
}
