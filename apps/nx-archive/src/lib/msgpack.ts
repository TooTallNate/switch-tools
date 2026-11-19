/**
 * Minimal MessagePack decoder (https://github.com/msgpack/msgpack/blob/master/spec.md),
 * for config files shown as JSON: Super Mario Party Jamboree's `.msgpack`
 * audio settings and the Bezel engine's `rtts_file_format` files
 * (`.nbgllt`, `.nbfcpxset`, `.nbrspfb`). Binary values become
 * `"<N bytes>"`, extension values `{ ext, bytes }`.
 */

export function decodeMsgpack(bytes: Uint8Array): unknown {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const td = new TextDecoder();
	let o = 0;
	const str = (n: number) => {
		const s = td.decode(bytes.subarray(o, o + n));
		o += n;
		return s;
	};
	const bin = (n: number) => {
		o += n;
		return `<${n} bytes>`;
	};
	const arr = (n: number, depth: number) => {
		const out: unknown[] = [];
		for (let i = 0; i < n; i++) out.push(read(depth + 1));
		return out;
	};
	const map = (n: number, depth: number) => {
		const out: Record<string, unknown> = {};
		for (let i = 0; i < n; i++) {
			const k = read(depth + 1);
			out[typeof k === 'string' ? k : JSON.stringify(k)] = read(depth + 1);
		}
		return out;
	};
	const ext = (n: number) => {
		const type = dv.getInt8(o++);
		o += n;
		return { ext: type, bytes: n };
	};
	const read = (depth: number): unknown => {
		if (depth > 256) throw new Error('MessagePack: nesting too deep');
		if (o >= bytes.length) throw new Error('MessagePack: truncated');
		const b = bytes[o++]!;
		if (b <= 0x7f) return b;
		if (b >= 0xe0) return b - 0x100;
		if ((b & 0xf0) === 0x80) return map(b & 0x0f, depth);
		if ((b & 0xf0) === 0x90) return arr(b & 0x0f, depth);
		if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
		const u8 = () => bytes[o++]!;
		const u16 = () => ((o += 2), dv.getUint16(o - 2, false));
		const u32 = () => ((o += 4), dv.getUint32(o - 4, false));
		switch (b) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return bin(u8());
			case 0xc5:
				return bin(u16());
			case 0xc6:
				return bin(u32());
			case 0xc7:
				return ext(u8());
			case 0xc8:
				return ext(u16());
			case 0xc9:
				return ext(u32());
			case 0xca:
				return (o += 4), dv.getFloat32(o - 4, false);
			case 0xcb:
				return (o += 8), dv.getFloat64(o - 8, false);
			case 0xcc:
				return u8();
			case 0xcd:
				return u16();
			case 0xce:
				return u32();
			case 0xcf:
				return (o += 8), Number(dv.getBigUint64(o - 8, false));
			case 0xd0:
				return (o += 1), dv.getInt8(o - 1);
			case 0xd1:
				return (o += 2), dv.getInt16(o - 2, false);
			case 0xd2:
				return (o += 4), dv.getInt32(o - 4, false);
			case 0xd3:
				return (o += 8), Number(dv.getBigInt64(o - 8, false));
			case 0xd4:
				return ext(1);
			case 0xd5:
				return ext(2);
			case 0xd6:
				return ext(4);
			case 0xd7:
				return ext(8);
			case 0xd8:
				return ext(16);
			case 0xd9:
				return str(u8());
			case 0xda:
				return str(u16());
			case 0xdb:
				return str(u32());
			case 0xdc:
				return arr(u16(), depth);
			case 0xdd:
				return arr(u32(), depth);
			case 0xde:
				return map(u16(), depth);
			case 0xdf:
				return map(u32(), depth);
			default:
				throw new Error(`MessagePack: unknown type 0x${b.toString(16)}`);
		}
	};
	const value = read(0);
	if (o !== bytes.length) throw new Error(`MessagePack: ${bytes.length - o} trailing bytes`);
	return value;
}

/** Bezel `rtts_file_format…` files: a MessagePack map whose first key starts with that. */
export function isRttsMsgpack(head: Uint8Array): boolean {
	return head.length >= 18 && (head[0]! & 0xf0) === 0x80 && (head[1]! & 0xe0) === 0xa0 && (head[1]! & 0x1f) >= 16 && String.fromCharCode(...head.subarray(2, 18)) === 'rtts_file_format';
}
