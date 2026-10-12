/**
 * Tiny FlatBuffers *writer* for test fixtures. Objects are laid out
 * front-to-back: vtable, then table, then any children it references
 * (so every uoffset points forward, as FlatBuffers requires).
 * Every inline field occupies a 4-byte-aligned slot.
 */

export type Field =
	| { k: 'u8' | 'u32' | 'i32' | 'f32' | 'u16'; v: number }
	| { k: 'struct'; bytes: Uint8Array }
	| { k: 'table'; fields: (Field | null)[] }
	| { k: 'str'; v: string }
	| { k: 'tables'; v: (Field | null)[][] }
	| { k: 'strs'; v: string[] }
	| { k: 'bytes'; v: Uint8Array }
	| { k: 'u16s'; v: number[] }
	| { k: 'f32v'; v: number[] }
	| { k: 'structs'; bytes: Uint8Array; count: number };

export const F = {
	u8: (v: number): Field => ({ k: 'u8', v }),
	bool: (v: boolean): Field => ({ k: 'u8', v: v ? 1 : 0 }),
	u16: (v: number): Field => ({ k: 'u16', v }),
	u32: (v: number): Field => ({ k: 'u32', v }),
	i32: (v: number): Field => ({ k: 'i32', v }),
	f32: (v: number): Field => ({ k: 'f32', v }),
	floats: (v: number[]): Field => ({ k: 'struct', bytes: new Uint8Array(new Float32Array(v).buffer) }),
	struct: (bytes: Uint8Array): Field => ({ k: 'struct', bytes }),
	table: (fields: (Field | null)[]): Field => ({ k: 'table', fields }),
	str: (v: string): Field => ({ k: 'str', v }),
	tables: (v: (Field | null)[][]): Field => ({ k: 'tables', v }),
	strs: (v: string[]): Field => ({ k: 'strs', v }),
	bytes: (v: Uint8Array): Field => ({ k: 'bytes', v }),
	u16s: (v: number[]): Field => ({ k: 'u16s', v }),
	f32v: (v: number[]): Field => ({ k: 'f32v', v }),
	/** Vector of `count` inline structs packed in `bytes`. */
	structs: (bytes: Uint8Array, count: number): Field => ({ k: 'structs', bytes, count }),
};

class Writer {
	buf = new Uint8Array(1 << 16);
	len = 0;
	get dv() {
		return new DataView(this.buf.buffer);
	}
	reserve(n: number): number {
		while (this.len + n > this.buf.length) {
			const b = new Uint8Array(this.buf.length * 2);
			b.set(this.buf);
			this.buf = b;
		}
		const p = this.len;
		this.len += n;
		return p;
	}
	align() {
		while (this.len % 4) this.reserve(1);
	}
}

function writeTable(w: Writer, fields: (Field | null)[]): number {
	w.align();
	const vt = w.reserve(4 + 2 * fields.length);
	w.align();
	const pos = w.reserve(4);
	const slots: { field: Field; at: number }[] = [];
	fields.forEach((f, i) => {
		if (!f) {
			w.dv.setUint16(vt + 4 + i * 2, 0, true);
			return;
		}
		const size = f.k === 'struct' ? (f.bytes.length + 3) & ~3 : 4;
		const at = w.reserve(size);
		w.dv.setUint16(vt + 4 + i * 2, at - pos, true);
		const dv = w.dv;
		switch (f.k) {
			case 'u8':
				dv.setUint8(at, f.v);
				break;
			case 'u16':
				dv.setUint16(at, f.v, true);
				break;
			case 'u32':
				dv.setUint32(at, f.v, true);
				break;
			case 'i32':
				dv.setInt32(at, f.v, true);
				break;
			case 'f32':
				dv.setFloat32(at, f.v, true);
				break;
			case 'struct':
				w.buf.set(f.bytes, at);
				break;
			default:
				slots.push({ field: f, at });
		}
	});
	w.dv.setUint16(vt, 4 + 2 * fields.length, true);
	w.dv.setUint16(vt + 2, w.len - pos, true);
	w.dv.setInt32(pos, pos - vt, true);
	for (const { field, at } of slots) {
		const child = writeChild(w, field);
		w.dv.setUint32(at, child - at, true);
	}
	return pos;
}

function writeString(w: Writer, s: string): number {
	w.align();
	const b = new TextEncoder().encode(s);
	const p = w.reserve(4 + b.length + 1);
	w.dv.setUint32(p, b.length, true);
	w.buf.set(b, p + 4);
	return p;
}

function writeChild(w: Writer, f: Field): number {
	switch (f.k) {
		case 'table':
			return writeTable(w, f.fields);
		case 'str':
			return writeString(w, f.v);
		case 'bytes':
		case 'structs': {
			const data = f.k === 'bytes' ? f.v : f.bytes;
			w.align();
			const p = w.reserve(4 + data.length);
			w.dv.setUint32(p, f.k === 'bytes' ? data.length : f.count, true);
			w.buf.set(data, p + 4);
			return p;
		}
		case 'u16s': {
			w.align();
			const p = w.reserve(4 + f.v.length * 2);
			w.dv.setUint32(p, f.v.length, true);
			f.v.forEach((x, i) => w.dv.setUint16(p + 4 + i * 2, x, true));
			return p;
		}
		case 'f32v': {
			w.align();
			const p = w.reserve(4 + f.v.length * 4);
			w.dv.setUint32(p, f.v.length, true);
			f.v.forEach((x, i) => w.dv.setFloat32(p + 4 + i * 4, x, true));
			return p;
		}
		case 'tables':
		case 'strs': {
			w.align();
			const n = f.v.length;
			const p = w.reserve(4 + n * 4);
			w.dv.setUint32(p, n, true);
			for (let i = 0; i < n; i++) {
				const at = p + 4 + i * 4;
				const child = f.k === 'tables' ? writeTable(w, f.v[i] as (Field | null)[]) : writeString(w, f.v[i] as string);
				w.dv.setUint32(at, child - at, true);
			}
			return p;
		}
		default:
			throw new Error(`not an offset field: ${f.k}`);
	}
}

/** Serialize a root table. */
export function buildFlatBuffer(root: (Field | null)[]): Uint8Array {
	const w = new Writer();
	w.reserve(4);
	const pos = writeTable(w, root);
	w.dv.setUint32(0, pos, true);
	return w.buf.slice(0, w.len);
}

export function f32Bytes(v: number[]): Uint8Array {
	return new Uint8Array(new Float32Array(v).buffer);
}

export function u16Bytes(v: number[]): Uint8Array {
	return new Uint8Array(new Uint16Array(v).buffer);
}

