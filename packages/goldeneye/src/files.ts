/**
 * GoldenEye 007's file resource table.
 *
 * The game's assets are named files (`CbondZ`, `Gak47Z`, `PdoorZ`,
 * `bg/bg_dam_all_p.seg`, `UsetupdamZ`, …) listed in a table inside
 * the main code/data segment, itself the first Rare-1172 (DEFLATE)
 * container in the ROM. Each 12-byte entry is
 *
 *   u32 index   (0, 1, 2, … — entry 0 is an empty placeholder)
 *   u32 name    (virtual address of a NUL-terminated string)
 *   u32 rom     (ROM offset of the file)
 *
 * Names ending in `Z` are Rare-1172 compressed. Name prefixes are the
 * decomp's asset categories: `C` characters, `G` guns, `P` props,
 * `U` level setups, `T` clipping, `L` text, `bg/` level geometry.
 *
 * Neither the table's offset nor the data segment's load address is
 * hard-coded: {@link findGoldeneyeFileTable} looks for an ascending
 * index sequence at a 12-byte stride, then recovers the string base as
 * the one delta that makes every name pointer land on a printable
 * NUL-terminated string. Layout from the n64decomp/007 decompilation
 * (`file_resource_table`).
 */

export interface GoldeneyeFile {
	index: number;
	name: string;
	/** ROM offset of the file (a Rare-1172 container when `compressed`). */
	romOffset: number;
	/** Bytes up to the next file in the ROM. */
	romSize: number;
	compressed: boolean;
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

function cString(b: Uint8Array, o: number, max = 96): string | null {
	if (o <= 0 || o >= b.length || b[o - 1] !== 0) return null;
	let s = '';
	for (let i = o; i < b.length && b[i] !== 0; i++) {
		const c = b[i]!;
		if (c < 0x20 || c > 0x7e || s.length >= max) return null;
		s += String.fromCharCode(c);
	}
	return s.length > 0 ? s : null;
}

/**
 * Find the file table in the decompressed main segment. Returns null
 * when the segment doesn't contain one. `romSize` bounds the last file.
 */
export function findGoldeneyeFileTable(code: Uint8Array, romSize = Infinity): GoldeneyeFile[] | null {
	for (let t = 0; t + 12 * 16 <= code.length; t += 4) {
		let ok = true;
		for (let i = 0; i < 16; i++) {
			if (u32(code, t + i * 12) !== i) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		let n = 0;
		while (t + n * 12 + 12 <= code.length && u32(code, t + n * 12) === n) n++;
		const namePtr = (i: number) => u32(code, t + i * 12 + 4);
		// Recover the string base from entry 1's name.
		const first = namePtr(1);
		for (let o = 1; o < code.length; o++) {
			if (code[o - 1] !== 0) continue;
			const delta = (first - o) >>> 0;
			let good = true;
			for (let i = 1; i < Math.min(n, 64) && good; i++) if (cString(code, (namePtr(i) - delta) >>> 0) === null) good = false;
			if (!good) continue;
			const files: GoldeneyeFile[] = [];
			for (let i = 1; i < n; i++) {
				const name = cString(code, (namePtr(i) - delta) >>> 0);
				if (!name) continue;
				files.push({ index: i, name, romOffset: u32(code, t + i * 12 + 8), romSize: 0, compressed: /Z$/.test(name) });
			}
			const sorted = [...files].sort((a, b) => a.romOffset - b.romOffset);
			sorted.forEach((f, i) => {
				const next = sorted[i + 1]?.romOffset ?? romSize;
				f.romSize = Number.isFinite(next) ? Math.max(0, next - f.romOffset) : 0;
			});
			return files;
		}
		return null;
	}
	return null;
}

export type GoldeneyeFileKind = 'character' | 'gun' | 'prop' | 'setup' | 'clipping' | 'text' | 'level' | 'other';

/** The asset category a file name belongs to. */
export function goldeneyeFileKind(name: string): GoldeneyeFileKind {
	if (name.startsWith('bg/')) return 'level';
	switch (name[0]) {
		case 'C':
			return 'character';
		case 'G':
			return 'gun';
		case 'P':
			return 'prop';
		case 'U':
			return 'setup';
		case 'T':
			return 'clipping';
		case 'L':
			return 'text';
		default:
			return 'other';
	}
}
