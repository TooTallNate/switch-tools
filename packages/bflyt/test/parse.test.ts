import { describe, expect, it } from 'vitest';
import { parseBflan, parseBflyt } from '../src/index.js';

/** Assemble an NW binary (LE) from `[magic, payload]` sections. */
function nwFile(magic: string, sections: [string, Uint8Array][], version = 0x08060000): Uint8Array {
	const enc = new TextEncoder();
	const total = 0x14 + sections.reduce((s, [, p]) => s + 8 + p.length, 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	out.set(enc.encode(magic));
	out.set([0xff, 0xfe], 4);
	dv.setUint16(6, 0x14, true);
	dv.setUint32(8, version, true);
	dv.setUint32(12, total, true);
	dv.setUint16(16, sections.length, true);
	let o = 0x14;
	for (const [m, p] of sections) {
		out.set(enc.encode(m), o);
		dv.setUint32(o + 4, 8 + p.length, true);
		out.set(p, o + 8);
		o += 8 + p.length;
	}
	return out;
}

class Buf {
	b: number[] = [];
	u8(v: number) {
		this.b.push(v & 0xff);
		return this;
	}
	u16(v: number) {
		return this.u8(v).u8(v >> 8);
	}
	u32(v: number) {
		return this.u16(v).u16(v >>> 16);
	}
	f32(v: number) {
		const x = new Uint8Array(new Float32Array([v]).buffer);
		x.forEach((c) => this.u8(c));
		return this;
	}
	str(s: string, size: number) {
		const e = new TextEncoder().encode(s);
		for (let i = 0; i < size; i++) this.u8(e[i] ?? 0);
		return this;
	}
	cstr(s: string) {
		new TextEncoder().encode(s).forEach((c) => this.u8(c));
		return this.u8(0);
	}
	pad4() {
		while (this.b.length % 4) this.u8(0);
		return this;
	}
	get bytes() {
		return new Uint8Array(this.b);
	}
}

/** The 0x4C-byte common pane header. */
function pane(name: string, w: number, h: number, visible = true): Buf {
	const b = new Buf().u8(visible ? 1 : 0).u8(0).u8(255).u8(0).str(name, 0x18).str('', 8);
	[10, 20, 0, 0, 0, 0, 1, 1, w, h].forEach((v) => b.f32(v));
	return b;
}

function nameList(names: string[]): Uint8Array {
	const b = new Buf().u16(names.length).u16(0);
	let off = names.length * 4;
	const offs: number[] = [];
	for (const n of names) {
		offs.push(off);
		off += n.length + 1;
	}
	offs.forEach((o) => b.u32(o));
	names.forEach((n) => b.cstr(n));
	return b.pad4().bytes;
}

describe('parseBflyt', () => {
	const lyt1 = new Buf().u8(1).u8(0).u8(0).u8(0).f32(1280).f32(720).f32(0).f32(0).cstr('menu').pad4().bytes;
	const mat1 = new Buf().u16(1).u16(0).u32(16).str('P_bg_mat', 0x1c).bytes;
	const pic = pane('P_bg', 512, 256);
	for (let i = 0; i < 4; i++) pic.u32(0xffffffff);
	pic.u16(0).u8(0).u8(0);
	const file = nwFile('FLYT', [
		['lyt1', lyt1],
		['txl1', nameList(['bg_00^t'])],
		['fnl1', nameList(['Font.bffnt'])],
		['mat1', mat1],
		['pan1', pane('RootPane', 1280, 720).bytes],
		['pas1', new Uint8Array(0)],
		['pic1', pic.bytes],
		['pan1', pane('N_hidden', 0, 0, false).bytes],
		['pae1', new Uint8Array(0)],
		['grp1', new Buf().str('RootGroup', 34).u16(1).str('P_bg', 24).bytes],
	]);

	it('reads the canvas, lists and pane tree', () => {
		const l = parseBflyt(file);
		expect(l.header.version).toBe('8.6.0.0');
		expect(l).toMatchObject({ name: 'menu', width: 1280, height: 720, textures: ['bg_00^t'], fonts: ['Font.bffnt'], materials: ['P_bg_mat'] });
		expect(l.paneCount).toBe(3);
		expect(l.panes).toHaveLength(1);
		const root = l.panes[0];
		expect(root.name).toBe('RootPane');
		expect(root.children.map((p) => [p.kind, p.name, p.visible])).toEqual([
			['pic1', 'P_bg', true],
			['pan1', 'N_hidden', false],
		]);
		expect(root.children[0]).toMatchObject({ width: 512, height: 256, translate: [10, 20, 0], material: 'P_bg_mat' });
		expect(l.groups).toEqual([{ name: 'RootGroup', panes: ['P_bg'], children: [] }]);
	});

	it('rejects other files', () => {
		expect(() => parseBflyt(new Uint8Array(0x20))).toThrow(/FLYT/);
	});
});

describe('parseBflan', () => {
	// pat1: order, groupCount, nameOffset, groupsOffset, (v8) unk, start, end, childBinding.
	const pat1 = new Buf().u16(2).u16(1).u32(32).u32(36).u32(0).u16(0).u16(30).u8(0).u8(0).u8(0).u8(0).cstr('in').pad4().str('G_all', 28).bytes;
	// pai1: frameSize, loop, pad, texCount, entryCount, entryTable(rel. section) — then
	// textures, then the entry table and one entry with one FLPA tag and one curve of 2 keys.
	const pai = new Buf().u16(30).u8(1).u8(0).u16(1).u16(1).u32(0);
	pai.u32(4).cstr('tex0').pad4(); // tex offsets (rel. table) + name
	const entryTable = 8 + pai.b.length;
	pai.b.splice(8, 4, ...new Buf().u32(entryTable).b);
	const entryAt = entryTable + 4;
	pai.u32(entryAt);
	// entry: name[28], tagCount, target, pad2, tagOffsets (rel. entry)
	pai.str('P_bg', 28).u8(1).u8(0).u16(0).u32(36);
	// tag: magic, count, pad3, entryOffsets (rel. tag)
	pai.str('FLPA', 4).u8(1).u8(0).u8(0).u8(0).u32(12);
	// curve: index, target, type, pad, keyCount, pad, keyOffset
	pai.u8(0).u8(0).u8(2).u8(0).u16(2).u16(0).u32(0);
	const file = nwFile('FLAN', [
		['pat1', pat1],
		['pai1', pai.bytes],
	]);

	it('reads the tag and animated targets', () => {
		const a = parseBflan(file);
		expect(a.tag).toMatchObject({ name: 'in', order: 2, startFrame: 0, endFrame: 30, groups: ['G_all'] });
		expect(a.frameSize).toBe(30);
		expect(a.loop).toBe(true);
		expect(a.textures).toEqual(['tex0']);
		expect(a.entries).toEqual([{ name: 'P_bg', target: 0, tags: [{ tag: 'FLPA', curves: 1, keys: 2 }] }]);
	});
});
