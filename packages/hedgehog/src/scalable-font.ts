/**
 * Sonic Frontiers scalable fonts (`.scfnt`): a BINA 2.1 file whose
 * `KFCS1000` payload wraps a whole TrueType / OpenType font. Read from
 * the files: u64 0x10 is the font's size, and the font starts a little
 * after the header, so we look for the sfnt signature there.
 */

export function isScalableFont(bytes: Uint8Array): boolean {
	return bytes.length > 0x80 && String.fromCharCode(...bytes.subarray(0x40, 0x48)) === 'KFCS1000';
}

/** The embedded font file, or null. */
export function extractScalableFont(bytes: Uint8Array): Uint8Array | null {
	if (!isScalableFont(bytes)) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = Number(dv.getBigUint64(0x60, true));
	for (let o = 0x48; o + 12 <= Math.min(bytes.length, 0x200); o += 4) {
		const sig = dv.getUint32(o, false);
		if (sig !== 0x00010000 && sig !== 0x4f54544f /* OTTO */ && sig !== 0x74727565 /* true */) continue;
		const tables = dv.getUint16(o + 4, false);
		if (tables === 0 || tables > 64) continue;
		const end = size > 0 && o + size <= bytes.length ? o + size : bytes.length;
		return bytes.subarray(o, end);
	}
	return null;
}
