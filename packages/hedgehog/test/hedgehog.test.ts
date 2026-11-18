import { describe, expect, it } from 'vitest';
import { assembleDds, ntspNameHash, parseHhMaterial, parseHhModel, parseNtsi, parseNtsp, readNeedleArchive } from '../src/index.js';

/** A growable big-endian buffer with offset fix-ups. */
class W {
	b = new Uint8Array(0x2000);
	dv = new DataView(this.b.buffer);
	o = 0;
	offsets: number[] = [];
	u8(v: number) {
		this.b[this.o++] = v;
	}
	u16(v: number) {
		this.dv.setUint16(this.o, v, false);
		this.o += 2;
	}
	u32(v: number) {
		this.dv.setUint32(this.o, v >>> 0, false);
		this.o += 4;
	}
	f32(v: number) {
		this.dv.setFloat32(this.o, v, false);
		this.o += 4;
	}
	str(s: string) {
		for (const c of s) this.u8(c.charCodeAt(0));
		this.u8(0);
		while (this.o % 4) this.u8(0);
	}
	/** Reserve an offset slot; returns a setter for its target. */
	ptr(): (target: number) => void {
		const at = this.o;
		this.offsets.push(at);
		this.u32(0);
		return (target) => this.slots.set(at, target);
	}
	slots = new Map<number, number>();
	/** Write offsets: standard (BE, relative to base) or self-relative LE (Frontiers). */
	finish(base: number, selfRelative: boolean) {
		for (const [at, target] of this.slots) {
			if (selfRelative) this.dv.setInt32(at, target - at, true);
			else this.dv.setUint32(at, target - base, false);
		}
		return this.b.slice(0, this.o);
	}
}

/** Sample chunk header + Model { Topology, Contexts } around a writer callback. */
function sampleChunk(version: number, topology: number, body: (w: W) => void, selfRelative = false): Uint8Array {
	const w = new W();
	w.o = 16;
	const modelAt = w.o;
	w.u32(0); // flags | size, patched below
	w.u32(1);
	w.str('Model\0\0'.padEnd(7, ' '));
	// name fields are exactly 8 bytes
	w.o = modelAt + 16;
	const node = (name: string, value: number, flags: number) => {
		w.u32(flags | 16);
		w.u32(value);
		for (let i = 0; i < 8; i++) w.u8(name.charCodeAt(i) || 0x20);
	};
	node('Topology', topology, 0x20000000);
	node('Contexts', version, 0x20000000 | 0x40000000);
	body(w);
	while (w.o % 4) w.u8(0);
	const tableAt = w.o;
	for (const at of w.offsets) w.u32(at - 16);
	w.dv.setUint32(modelAt, 0x40000000 | (tableAt - modelAt), false);
	w.dv.setUint32(modelAt + 8, 0x4d6f6465, false); // "Mode"
	w.dv.setUint32(modelAt + 12, 0x6c202020, false); // "l   "
	w.dv.setUint32(0, 0x80000000 | w.o, false);
	w.dv.setUint32(4, 0x0133054a, false);
	w.dv.setUint32(8, tableAt - 16, false);
	w.dv.setUint32(12, w.offsets.length, false);
	return w.finish(16, selfRelative);
}

/** One triangle, one bone, skeletal v5. */
function triangleModel(selfRelative: boolean): Uint8Array {
	return sampleChunk(
		5,
		3,
		(w) => {
			const d = w.o;
			w.u32(1);
			const groups = w.ptr();
			w.u32(0);
			w.u32(0);
			w.u32(1); // nodeCount
			const nodes = w.ptr();
			const mats = w.ptr();
			w.u32(0); // bounds
			void d;
			// group table
			const gt = w.o;
			groups(gt);
			const g0 = w.ptr();
			const g = w.o;
			g0(g);
			w.u32(1);
			const opaque = w.ptr();
			for (let i = 0; i < 2; i++) {
				w.u32(0);
				w.u32(0);
			}
			w.u32(0);
			w.u32(0);
			w.u32(0);
			w.u32(0);
			w.str('Body');
			const ol = w.o;
			opaque(ol);
			const m0 = w.ptr();
			const m = w.o;
			m0(m);
			const matName = w.ptr();
			w.u32(3);
			const faces = w.ptr();
			w.u32(3); // vertex count
			w.u32(16); // vertex size
			const verts = w.ptr();
			const els = w.ptr();
			w.u32(1);
			const bones = w.ptr();
			w.u32(0);
			w.u32(0);
			matName(w.o);
			w.str('chr_test_body');
			faces(w.o);
			w.u16(0);
			w.u16(1);
			w.u16(2);
			w.u16(0);
			verts(w.o);
			for (const [x, y] of [[0, 0], [1, 0], [0, 1]] as const) {
				w.f32(x);
				w.f32(y);
				w.f32(0);
				w.u16(0x3c00); // u = 1.0 (half)
				w.u16(0x3800); // v = 0.5
			}
			els(w.o);
			const el = (offset: number, format: number, usage: number) => {
				w.u16(0);
				w.u16(offset);
				w.u32(format);
				w.u8(0);
				w.u8(usage);
				w.u8(0);
				w.u8(0);
			};
			el(0, 0x2a23b9, 0);
			el(12, 0x2c235f, 5);
			w.u16(0xff);
			w.u16(0);
			w.u32(0xffffffff);
			w.u32(0);
			bones(w.o);
			w.u8(0);
			while (w.o % 4) w.u8(0);
			const nt = w.o;
			nodes(nt);
			const n0 = w.ptr();
			n0(w.o);
			w.u32(0xffffffff);
			const nn = w.ptr();
			nn(w.o);
			w.str('Root');
			mats(w.o);
			const rows = [1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1, 0, 0, 0, 0, 1];
			for (const v of rows) w.f32(v);
		},
		selfRelative,
	);
}

describe('Hedgehog Engine models', () => {
	for (const selfRelative of [false, true]) {
		it(`reads a skeletal v5 model (${selfRelative ? 'Frontiers self-relative' : 'standard'} offsets)`, () => {
			const m = parseHhModel(triangleModel(selfRelative));
			expect(m.version).toBe(5);
			expect(m.meshes).toHaveLength(1);
			const mesh = m.meshes[0]!;
			expect(mesh.group).toBe('Body');
			expect(mesh.material).toBe('chr_test_body');
			expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
			expect(Array.from(mesh.uvs[0]!)).toEqual([1, 0.5, 1, 0.5, 1, 0.5]);
			expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
			expect(m.nodes.map((n) => [n.name, n.parent])).toEqual([['Root', -1]]);
			// Row-major input; column-major out: translation in [12..14].
			expect(m.nodes[0]!.inverseBind[13]).toBe(-2);
		});
	}

	it('unwraps a Needle archive', () => {
		const model = triangleModel(true);
		const enc = new TextEncoder();
		const lod = Uint8Array.from([...enc.encode('NEDLDIV1lodinfo\0'), 0, 0, 0, 4, 1, 2, 3, 4]);
		const mdl = Uint8Array.from([...enc.encode('NEDMDLV5model\0\0\0'), (model.length >>> 24) & 255, (model.length >>> 16) & 255, (model.length >>> 8) & 255, model.length & 255, ...model]);
		const body = Uint8Array.from([...enc.encode('arc\0'), ...lod, ...mdl]);
		const size = body.length + 4;
		const arc = Uint8Array.from([...enc.encode('NEDARCV1'), (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...body]);
		expect(readNeedleArchive(arc).map((e) => [e.signature, e.ext])).toEqual([
			['NEDLDIV1', 'lodinfo'],
			['NEDMDLV5', 'model'],
		]);
		expect(parseHhModel(arc).meshes[0]!.material).toBe('chr_test_body');
	});
});

describe('Hedgehog Engine materials', () => {
	it('lists texture entries by type', () => {
		const mat = sampleChunk(3, 0, (w) => {
			const shader = w.ptr();
			const sub = w.ptr();
			const names = w.ptr();
			const entries = w.ptr();
			w.u8(0x80);
			w.u8(1);
			w.u8(0);
			w.u8(0);
			w.u8(0);
			w.u8(0);
			w.u8(0);
			w.u8(2);
			w.u32(0);
			w.u32(0);
			w.u32(0);
			shader(w.o);
			w.str('ChrSkin');
			sub(w.o);
			w.str('ChrSkin');
			names(w.o);
			w.u32(0);
			entries(w.o);
			const e0 = w.ptr();
			const e1 = w.ptr();
			const entry = (set: (t: number) => void, tex: string, type: string) => {
				set(w.o);
				const n = w.ptr();
				w.u32(0);
				const t = w.ptr();
				n(w.o);
				w.str(tex);
				t(w.o);
				w.str(type);
			};
			entry(e0, 'chr_test_abd', 'diffuse');
			entry(e1, 'chr_test_cyb_abd', 'diffuse');
		});
		const m = parseHhMaterial(mat);
		expect(m.shader).toBe('ChrSkin');
		expect(m.doubleSided).toBe(true);
		expect(m.alphaThreshold).toBe(0x80);
		expect(m.textures.map((t) => [t.texture, t.type])).toEqual([
			['chr_test_abd', 'diffuse'],
			['chr_test_cyb_abd', 'diffuse'],
		]);
	});
});

describe('Needle texture streaming', () => {
	it('rebuilds a DDS from an NTSI stub and a PSTN package', () => {
		const enc = new TextEncoder();
		const dds = new Uint8Array(0x80);
		const ddv = new DataView(dds.buffer);
		dds.set(enc.encode('DDS '), 0);
		ddv.setUint32(4, 124, true);
		ddv.setUint32(12, 8, true);
		ddv.setUint32(16, 8, true);
		ddv.setUint32(28, 4, true);
		const mip4 = new Uint8Array(8).fill(7);
		const stub = new Uint8Array(24 + 10 + 8 + 0x80);
		const sdv = new DataView(stub.buffer);
		stub.set(enc.encode('NTSI'), 0);
		sdv.setUint32(4, 1, true);
		sdv.setUint32(12, 10, true);
		sdv.setUint32(16, 8, true);
		sdv.setUint32(20, 1, true);
		stub.set(enc.encode('character'), 24);
		stub.set(mip4, 34);
		stub.set(dds, 42);
		const s = parseNtsi(stub);
		expect(s.packageName).toBe('character');
		expect(s.mip4x4).toEqual(mip4);

		// Package: one entry, two mips.
		const name = 'chr_test_abd';
		const pkg = new Uint8Array(24 + 24 + 32 + 16);
		const pdv = new DataView(pkg.buffer);
		pkg.set(enc.encode('PSTN'), 0);
		pdv.setUint32(4, 1, true);
		pdv.setUint32(8, 1, true);
		pdv.setUint32(12, 2, true);
		pdv.setBigUint64(16, BigInt(pkg.length), true);
		pdv.setUint32(24, ntspNameHash(name), true);
		pdv.setUint32(28, 0, true);
		pdv.setUint32(32, 2, true);
		pdv.setUint16(36, 8, true);
		pdv.setUint16(38, 8, true);
		pdv.setBigUint64(40, 80n, true);
		pdv.setBigUint64(48, 1000n, true);
		pdv.setBigUint64(56, 32n, true);
		pdv.setBigUint64(64, 1032n, true);
		pdv.setBigUint64(72, 8n, true);
		pkg.set(enc.encode(name), 80);
		const p = parseNtsp(pkg);
		const e = p.find(`${name}.dds`)!;
		expect(e.mips).toEqual([
			{ offset: 1000, size: 32 },
			{ offset: 1032, size: 8 },
		]);
		const out = assembleDds(s, [new Uint8Array(32)], 8, 8);
		expect(out.length).toBe(0x80 + 32);
		expect(new DataView(out.buffer).getUint32(28, true)).toBe(1);
	});

	it('hashes names like the game', () => {
		// Java String.hashCode("chr_amy_fur_abd") & 0x7fffffff, as stored in character.ntsp.
		expect(ntspNameHash('chr_amy_fur_abd')).toBe(65274531);
	});
});
