/**
 * N64 texel decoding for Stadium model textures (RGBA8 out, rows
 * top-down). Formats are the RDP's `G_IM_FMT_*` / `G_IM_SIZ_*` codes;
 * colour-indexed images read a TLUT of RGBA5551 entries (CI4 selects
 * a 16-entry palette). Bytes outside the module read as zero, as in
 * the importer, so a bad pointer yields a blank texture rather than
 * a crash.
 */

export interface StadiumTextureSource {
	fmt: number;
	siz: number;
	width: number;
	height: number;
	/** Module offset of the texels, or null. */
	data: number | null;
}

function rgba5551(p: number, out: Uint8Array, o: number): void {
	out[o] = Math.floor((((p >> 11) & 31) * 255) / 31);
	out[o + 1] = Math.floor((((p >> 6) & 31) * 255) / 31);
	out[o + 2] = Math.floor((((p >> 1) & 31) * 255) / 31);
	out[o + 3] = p & 1 ? 255 : 0;
}

/**
 * Decode `tex` from module bytes `d`. `tlut` is the module offset of
 * its palette (colour-indexed formats), `palette` the CI4 bank.
 */
export function decodeStadiumTexture(d: Uint8Array, tex: StadiumTextureSource, tlut: number | null, palette = 0): Uint8Array {
	const { width: w, height: h, fmt, siz } = tex;
	const n = Math.max(0, w * h);
	const out = new Uint8Array(n * 4);
	const addr = tex.data;
	if (addr === null) {
		for (let i = 0; i < n; i++) out.set([255, 0, 255, 255], i * 4);
		return out;
	}
	const at = (o: number) => (o >= 0 && o < d.length ? d[o]! : 0);
	const nibble = (i: number) => {
		const v = at(addr + (i >> 1));
		return i & 1 ? v & 15 : v >> 4;
	};
	if (fmt === 0 && siz === 2) {
		for (let i = 0; i < n; i++) rgba5551((at(addr + i * 2) << 8) | at(addr + i * 2 + 1), out, i * 4);
	} else if (fmt === 0 && siz === 3) {
		for (let i = 0; i < n * 4; i++) out[i] = at(addr + i);
	} else if (fmt === 2) {
		const entries = siz === 0 ? 16 : 256;
		const pal = new Uint8Array(entries * 4);
		if (tlut !== null) {
			const base = tlut + (siz === 0 ? palette * 32 : 0);
			for (let i = 0; i < entries; i++) rgba5551((at(base + i * 2) << 8) | at(base + i * 2 + 1), pal, i * 4);
		} else {
			for (let i = 0; i < entries; i++) pal.set([255, 0, 255, 255], i * 4);
		}
		for (let i = 0; i < n; i++) {
			const idx = (siz === 0 ? nibble(i) : at(addr + i)) % entries;
			out.set(pal.subarray(idx * 4, idx * 4 + 4), i * 4);
		}
	} else if (fmt === 3) {
		for (let i = 0; i < n; i++) {
			let l: number, a: number;
			if (siz === 2) {
				l = at(addr + i * 2);
				a = at(addr + i * 2 + 1);
			} else if (siz === 1) {
				const v = at(addr + i);
				l = (v >> 4) * 17;
				a = (v & 15) * 17;
			} else {
				const v = nibble(i);
				l = Math.floor(((v >> 1) * 255) / 7);
				a = v & 1 ? 255 : 0;
			}
			out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = l;
			out[i * 4 + 3] = a;
		}
	} else if (fmt === 4) {
		for (let i = 0; i < n; i++) {
			const l = siz === 1 ? at(addr + i) : nibble(i) * 17;
			out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = l;
			out[i * 4 + 3] = 255;
		}
	} else {
		for (let i = 0; i < n; i++) out.set([255, 0, 255, 255], i * 4);
	}
	return out;
}
