import { describe, expect, it } from 'vitest';
import { isVfxb, parseVfxb } from '../src/index.js';

const NONE = 0xffffffff;

/**
 * ESTA → ESET "Smoke" → EMTR "Puff"; then GRTF (embedded BNTX) with a
 * GTNT child whose "next" points at padding, as in real files.
 */
function buildVfxb(): Uint8Array {
	const out = new Uint8Array(0x400);
	const v = new DataView(out.buffer);
	out.set(new TextEncoder().encode('VFXB    '));
	v.setUint16(0x0a, 20, true);
	v.setUint16(0x0c, 0xfeff, true);
	v.setUint16(0x16, 0x40, true);
	out.set(new TextEncoder().encode('Game'), 0x20);
	const section = (off: number, magic: string, child: number, next: number, bin: number, count: number) => {
		out.set(new TextEncoder().encode(magic), off);
		v.setUint32(off + 4, 0x20, true);
		v.setUint32(off + 8, child, true);
		v.setUint32(off + 0x0c, next, true);
		v.setUint32(off + 0x10, NONE, true);
		v.setUint32(off + 0x14, bin, true);
		v.setUint16(off + 0x1c, count, true);
	};
	section(0x40, 'ESTA', 0x20, 0x100, NONE, 1);
	section(0x60, 'ESET', 0x60, 0x20, 0x20, 1); // "next" past the chain: bounded by count
	out.set(new TextEncoder().encode('Smoke'), 0x60 + 0x20 + 0x10);
	section(0xc0, 'EMTR', NONE, 0x60, 0x20, 0);
	out.set(new TextEncoder().encode('Puff'), 0xc0 + 0x20 + 0x10);
	section(0x140, 'GRTF', 0x20, NONE, 0x100, 1);
	section(0x160, 'GTNT', NONE, 0x40, 0x20, 0); // next → padding
	out.set(new TextEncoder().encode('BNTX'), 0x240);
	v.setUint32(0x240 + 0x1c, 0x40, true);
	return out;
}

describe('vfxb', () => {
	it('checks the magic', () => {
		expect(isVfxb(buildVfxb())).toBe(true);
		expect(isVfxb(new TextEncoder().encode('VFXA    '))).toBe(false);
	});

	it('reads the section tree, names and embedded resources', () => {
		const p = parseVfxb(buildVfxb());
		expect(p.vfxVersion).toBe(20);
		expect(p.name).toBe('Game');
		expect(p.sections.map((s) => s.magic)).toEqual(['ESTA', 'GRTF']);
		expect(p.emitterSets).toEqual([{ name: 'Smoke', emitters: ['Puff'] }]);
		expect(p.resources).toEqual([{ section: 'GRTF', kind: 'BNTX', offset: 0x240, size: 0x40 }]);
	});
});
