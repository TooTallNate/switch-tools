import { describe, expect, it } from 'vitest';

import { gfFnv64, packRange, parseTrpak, parseTrpfd, parseTrpfsIndex, POKEMON_CATALOG_PATH, TrinityNames } from '../src/index.js';

/**
 * Tiny FlatBuffers writer. FlatBuffers offsets only point forward, so
 * objects go into regions laid out in reference order: root tables, then
 * offset vectors, then element tables, then leaf data (scalar vectors,
 * strings). Every reference therefore points to a later region.
 */
type Region = 'root' | 'vectors' | 'tables' | 'leaf';
const REGION_START: Record<Region, number> = { root: 8, vectors: 0x2000, tables: 0x4000, leaf: 0x8000 };
class Fbw {
	buf = new Uint8Array(1 << 17);
	dv = new DataView(this.buf.buffer);
	at: Record<Region, number> = { ...REGION_START };
	private take(r: Region, n: number, align: number): number {
		while (this.at[r] % align) this.at[r]++;
		const p = this.at[r];
		this.at[r] += n;
		return p;
	}
	u64Vector(vals: bigint[]): number {
		while ((this.at.leaf + 4) % 8) this.at.leaf++;
		const at = this.take('leaf', 4 + vals.length * 8, 4);
		this.dv.setUint32(at, vals.length, true);
		vals.forEach((v, i) => this.dv.setBigUint64(at + 4 + i * 8, v, true));
		return at;
	}
	bytesVector(b: Uint8Array): number {
		const at = this.take('leaf', 4 + b.length, 4);
		this.dv.setUint32(at, b.length, true);
		this.buf.set(b, at + 4);
		return at;
	}
	string(s: string): number {
		const bytes = new TextEncoder().encode(s);
		const at = this.take('leaf', 4 + bytes.length + 1, 4);
		this.dv.setUint32(at, bytes.length, true);
		this.buf.set(bytes, at + 4);
		return at;
	}
	offsetVector(targets: number[]): number {
		const at = this.take('vectors', 4 + targets.length * 4, 4);
		this.dv.setUint32(at, targets.length, true);
		targets.forEach((t, i) => this.dv.setUint32(at + 4 + i * 4, t - (at + 4 + i * 4), true));
		return at;
	}
	/** Table with u64 / i8 / offset fields (null = absent); vtable placed just before it. */
	table(fields: ({ kind: 'u64' | 'i8' | 'off'; v: number | bigint } | null)[], region: Region = 'tables'): number {
		const vlen = 4 + fields.length * 2;
		let size = 8;
		const offs: number[] = [];
		for (const f of fields) {
			if (!f) {
				offs.push(0);
				continue;
			}
			const w = f.kind === 'u64' ? 8 : f.kind === 'i8' ? 1 : 4;
			while (size % w) size++;
			offs.push(size);
			size += w;
		}
		while (size % 8) size++;
		const vt = this.take(region, vlen, 2);
		const t = this.take(region, size, 8);
		this.dv.setUint16(vt, vlen, true);
		this.dv.setUint16(vt + 2, size, true);
		offs.forEach((o, i) => this.dv.setUint16(vt + 4 + i * 2, o, true));
		this.dv.setInt32(t, t - vt, true);
		fields.forEach((f, i) => {
			if (!f) return;
			const at = t + offs[i]!;
			if (f.kind === 'u64') this.dv.setBigUint64(at, BigInt(f.v), true);
			else if (f.kind === 'i8') this.dv.setInt8(at, Number(f.v));
			else this.dv.setUint32(at, Number(f.v) - at, true);
		});
		return t;
	}
	finish(root: number): Uint8Array {
		this.dv.setUint32(0, root, true);
		return this.buf.slice(0, this.at.leaf);
	}
}

describe('GF FNV-1a 64', () => {
	it('uses the Game Freak basis', () => {
		// The catalog's hash as it appears in the Scarlet / Violet descriptor.
		expect(gfFnv64(POKEMON_CATALOG_PATH)).toBe(0xec4c32a758998312n);
		expect(gfFnv64('')).toBe(0xcbf29ce484222645n);
	});
});

describe('TRPFD', () => {
	it('maps files to packs', () => {
		const w = new Fbw();
		const hashes = w.u64Vector([gfFnv64('a/b.trmdl'), gfFnv64('a/b.trmsh')]);
		const n0 = w.string('arc/abb.trmdl.trpak');
		const names = w.offsetVector([n0]);
		const fi0 = w.table([{ kind: 'u64', v: 0n }]);
		const fi1 = w.table([{ kind: 'u64', v: 0n }]);
		const infos = w.offsetVector([fi0, fi1]);
		const pi0 = w.table([{ kind: 'u64', v: 1234n }, { kind: 'u64', v: 2n }]);
		const packs = w.offsetVector([pi0]);
		const root = w.table(
			[
				{ kind: 'off', v: hashes },
				{ kind: 'off', v: names },
				{ kind: 'off', v: infos },
				{ kind: 'off', v: packs },
			],
			'root',
		);
		const fd = parseTrpfd(w.finish(root));
		expect(fd.packNames).toEqual(['arc/abb.trmdl.trpak']);
		expect([...fd.filePack]).toEqual([0, 0]);
		expect(fd.packs[0]).toEqual({ size: 1234, fileCount: 2 });
		expect(fd.fileHashes[1]).toBe(gfFnv64('a/b.trmsh'));
	});
});

describe('TRPFS index + TRPAK', () => {
	it('locates packs and reads their files', () => {
		const iw = new Fbw();
		const h = iw.u64Vector([gfFnv64('arc/p0.trpak'), gfFnv64('arc/p1.trpak')]);
		const o = iw.u64Vector([16n, 4096n]);
		const index = parseTrpfsIndex(iw.finish(iw.table([{ kind: 'off', v: h }, { kind: 'off', v: o }], 'root')), 8192);
		expect(packRange(index, 'arc/p0.trpak')).toEqual({ start: 16, end: 4096 });
		expect(packRange(index, 'arc/p1.trpak')).toEqual({ start: 4096, end: 8192 });
		expect(packRange(index, 'arc/none.trpak')).toBeNull();

		const pw = new Fbw();
		const fh = pw.u64Vector([42n]);
		const data = pw.bytesVector(new Uint8Array([1, 2, 3]));
		const f0 = pw.table([null, { kind: 'i8', v: -1 }, null, { kind: 'u64', v: 3n }, { kind: 'off', v: data }]);
		const files = pw.offsetVector([f0]);
		const pak = parseTrpak(pw.finish(pw.table([{ kind: 'off', v: fh }, { kind: 'off', v: files }], 'root')));
		expect(pak).toHaveLength(1);
		expect(pak[0]!.hash).toBe(42n);
		expect(pak[0]!.encryption).toBe(-1);
		expect([...pak[0]!.data]).toEqual([1, 2, 3]);
	});
});

describe('name recovery', () => {
	it('accepts only paths whose hash is a known file', () => {
		const names = new TrinityNames(new Set([gfFnv64('pokemon/data/pm0025/pm0025_00_00/pm0025_00_00.trmsh')]));
		expect(names.proposeIn('pokemon/data/pm0025/pm0025_00_00/', ['pm0025_00_00.trmsh', 'pm0025_00_00.trskl'])).toBe(1);
		expect(names.get(gfFnv64('pokemon/data/pm0025/pm0025_00_00/pm0025_00_00.trmsh'))).toMatch(/trmsh$/);
	});
});
