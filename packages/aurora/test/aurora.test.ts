import { describe, expect, it } from 'vitest';

import { decodeTpc, nameBifEntries, parseBif, parseErf, parseKey } from '../src/index.js';

class W {
	buf = new Uint8Array(2048);
	dv = new DataView(this.buf.buffer);
	str(o: number, s: string) {
		for (let i = 0; i < s.length; i++) this.buf[o + i] = s.charCodeAt(i);
	}
	u32(o: number, v: number) {
		this.dv.setUint32(o, v, true);
	}
	u16(o: number, v: number) {
		this.dv.setUint16(o, v, true);
	}
}

describe('KEY + BIF', () => {
	it('names BIF resources from the KEY', () => {
		const k = new W();
		k.str(0, 'KEY V1  ');
		k.u32(8, 1); // bifs
		k.u32(12, 2); // resources
		k.u32(16, 64); // file table
		k.u32(20, 100); // res table
		k.u32(64 + 4, 80);
		k.u16(64 + 8, 15);
		k.str(80, 'data\\models.bif');
		k.str(100, 'c_rancor');
		k.u16(116, 2002);
		k.u32(118, (0 << 20) | 1);
		k.str(122, 'c_rancor');
		k.u16(138, 3008);
		k.u32(140, (0 << 20) | 0);
		const key = parseKey(k.buf);
		expect(key.bifs).toEqual(['data/models.bif']);
		expect(key.resources[0]).toEqual({ resref: 'c_rancor', type: 2002, bif: 0, index: 1 });

		const b = new W();
		b.str(0, 'BIFFV1  ');
		b.u32(8, 2);
		b.u32(16, 20);
		[[100, 4, 3008], [104, 8, 2002]].forEach(([off, size, type], i) => {
			b.u32(20 + i * 16 + 4, off!);
			b.u32(20 + i * 16 + 8, size!);
			b.u32(20 + i * 16 + 12, type!);
		});
		const named = nameBifEntries(parseBif(b.buf), key, 0);
		expect(named.map((r) => r.name)).toEqual(['c_rancor.mdx', 'c_rancor.mdl']);
		expect(named[1]).toMatchObject({ offset: 104, size: 8 });
	});
});

describe('ERF / RIM', () => {
	it('lists an ERF', () => {
		const w = new W();
		w.str(0, 'ERF V1.0');
		w.u32(16, 1);
		w.u32(24, 160);
		w.u32(28, 200);
		w.str(160, 'PLC_Beer2');
		w.u16(180, 3007);
		w.u32(200, 300);
		w.u32(204, 42);
		expect(parseErf(w.buf)).toEqual([{ name: 'plc_beer2.tpc', resref: 'plc_beer2', type: 3007, offset: 300, size: 42 }]);
	});

	it('lists a RIM', () => {
		const w = new W();
		w.str(0, 'RIM V1.0');
		w.u32(12, 1);
		w.u32(16, 120);
		w.str(120, 'module');
		w.u16(136, 2014);
		w.u32(144, 400);
		w.u32(148, 10);
		expect(parseErf(w.buf)).toEqual([{ name: 'module.ifo', resref: 'module', type: 2014, offset: 400, size: 10 }]);
	});
});

describe('TPC', () => {
	it('decodes an uncompressed RGB texture', () => {
		const w = new W();
		w.u16(8, 2);
		w.u16(10, 1);
		w.buf[12] = 2; // RGB
		w.buf[13] = 1;
		w.buf.set([255, 0, 0, 0, 0, 255], 128);
		const t = decodeTpc(w.buf.slice(0, 134));
		expect([...t.pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
		expect(t.hasAlpha).toBe(false);
	});
});
