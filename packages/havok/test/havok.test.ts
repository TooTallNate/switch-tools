import { describe, expect, it } from 'vitest';
import { HAVOK_MAGIC0, HAVOK_MAGIC1, isHavokPackfile, parseHavok } from '../src/index.js';

/**
 * Minimal version-11 packfile: `__classnames__` with two classes, and
 * `__data__` with two objects (virtual fixups) plus an object name.
 */
function buildPackfile(predicatePad: number): Uint8Array {
	const out = new Uint8Array(0x400);
	const v = new DataView(out.buffer);
	v.setUint32(0, HAVOK_MAGIC0, true);
	v.setUint32(4, HAVOK_MAGIC1, true);
	v.setInt32(0x0c, 11, true);
	out.set([8, 1, 1, 1], 0x10);
	v.setInt32(0x14, 2, true);
	v.setInt32(0x18, 1, true); // contents: section 1, offset 0
	v.setInt32(0x1c, 0, true);
	out.set(new TextEncoder().encode('hk_2014.2.0-r1'), 0x28);
	v.setUint16(0x3e, predicatePad, true);
	const hdr = (i: number, tag: string, start: number, local: number, virt: number, exports: number) => {
		const o = 0x40 + predicatePad + i * 0x40;
		out.set(new TextEncoder().encode(tag), o);
		out[o + 0x13] = 0xff;
		v.setUint32(o + 0x14, start, true);
		v.setUint32(o + 0x18, local, true);
		v.setUint32(o + 0x1c, local, true);
		v.setUint32(o + 0x20, virt, true);
		v.setUint32(o + 0x24, exports, true);
		v.setUint32(o + 0x28, exports, true);
		v.setUint32(o + 0x2c, exports, true);
	};
	// __classnames__ at 0x200: two records.
	const cn = 0x200;
	const rec = (o: number, name: string) => {
		out[o + 4] = 0x09;
		out.set(new TextEncoder().encode(name), o + 5);
		return o + 5;
	};
	const rootName = rec(cn, 'hkRootLevelContainer') - cn;
	const bodyName = rec(cn + 0x20, 'hkpRigidBody') - cn;
	hdr(0, '__classnames__', cn, 0x40, 0x40, 0x40);
	// __data__ at 0x280: name string, then virtual fixups at +0x40.
	const data = 0x280;
	out.set(new TextEncoder().encode('Collision_Box'), data + 0x10);
	const fix = data + 0x40;
	[[0, rootName], [0x20, bodyName], [0x30, bodyName]].forEach(([src, name], i) => {
		v.setUint32(fix + i * 12, src!, true);
		v.setUint32(fix + i * 12 + 4, 0, true);
		v.setUint32(fix + i * 12 + 8, name!, true);
	});
	v.setUint32(fix + 36, 0xffffffff, true);
	hdr(1, '__data__', data, 0x40, 0x40, 0x40 + 48);
	return out;
}

describe('havok packfile', () => {
	it('checks the magic', () => {
		expect(isHavokPackfile(buildPackfile(0))).toBe(true);
		expect(isHavokPackfile(new Uint8Array(8))).toBe(false);
	});

	for (const pad of [0, 0x10]) {
		it(`reads sections, classes and names (predicate padding ${pad})`, () => {
			const p = parseHavok(buildPackfile(pad));
			expect(p.fileVersion).toBe(11);
			expect(p.contentsVersion).toBe('hk_2014.2.0-r1');
			expect(p.sections.map((s) => s.tag)).toEqual(['__classnames__', '__data__']);
			expect(p.contentsClass).toBe('hkRootLevelContainer');
			expect(p.classCounts).toEqual([
				['hkpRigidBody', 2],
				['hkRootLevelContainer', 1],
			]);
			expect(p.names).toEqual(['Collision_Box']);
		});
	}
});
