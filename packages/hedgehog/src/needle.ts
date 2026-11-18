/**
 * Needle archives (Sonic Frontiers), after HedgeLib++ `hl_hh_needle.h`:
 * `NEDARCV1`, a big-endian u32 size (counted from itself), the archive's
 * extension (`arc`) and then entries, each an 8-byte signature
 * (`NEDLDIV1` LOD info, `NEDMDLV5` model), its extension, padding to 4,
 * a big-endian u32 size and the payload. A `.model` archive holds one
 * model per level of detail, highest first.
 */

export interface NeedleEntry {
	signature: string;
	ext: string;
	data: Uint8Array;
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function isNeedleArchive(bytes: Uint8Array): boolean {
	return bytes.length >= 12 && ascii(bytes, 0, 8) === 'NEDARCV1';
}

export function readNeedleArchive(bytes: Uint8Array): NeedleEntry[] {
	if (!isNeedleArchive(bytes)) throw new Error('Not a Needle archive');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = Math.min(bytes.length, 8 + dv.getUint32(8, false));
	const cstrEnd = (o: number) => {
		while (o < end && bytes[o] !== 0) o++;
		return o;
	};
	let o = (cstrEnd(12) + 1 + 3) & ~3;
	const out: NeedleEntry[] = [];
	while (o + 12 <= end) {
		const signature = ascii(bytes, o, 8);
		const e = cstrEnd(o + 8);
		const ext = ascii(bytes, o + 8, e - o - 8);
		const p = (e + 1 + 3) & ~3;
		const size = dv.getUint32(p, false);
		out.push({ signature, ext, data: bytes.subarray(p + 4, Math.min(end, p + 4 + size)) });
		o = p + 4 + size;
	}
	return out;
}

/** The highest-detail model of a `.model` file (a Needle archive or a bare mirage model). */
export function primaryModelData(bytes: Uint8Array): Uint8Array {
	if (!isNeedleArchive(bytes)) return bytes;
	const m = readNeedleArchive(bytes).find((e) => e.signature.startsWith('NEDMDL'));
	if (!m) throw new Error('Needle archive has no model');
	return m.data;
}
