import { describe, expect, it } from 'vitest';
import { AampParamType, aampToText, crc32, isAamp, parseAamp } from '../src/index.js';

/**
 * Build a tiny AAMP: param_root (1 object "Settings") with a bool, an
 * f32, a string64, a vec3 and an int buffer, plus one child list.
 */
function buildAamp(): Uint8Array {
	const out = new Uint8Array(0x200);
	const v = new DataView(out.buffer);
	out.set([0x41, 0x41, 0x4d, 0x50]);
	v.setUint32(0x04, 2, true);
	v.setUint32(0x08, 3, true); // LE + UTF-8
	v.setUint32(0x10, 7, true);
	v.setUint32(0x14, 4, true); // root at 0x34
	out.set([0x78, 0x6d, 0x6c, 0], 0x30); // "xml"
	const root = 0x34;
	const child = 0x40;
	const obj = 0x4c;
	const params = 0x54;
	const data = 0x80;
	// root list: 1 child list, 1 object
	v.setUint32(root, crc32('param_root'), true);
	v.setUint16(root + 4, (child - root) / 4, true);
	v.setUint16(root + 6, 1, true);
	v.setUint16(root + 8, (obj - root) / 4, true);
	v.setUint16(root + 10, 1, true);
	// child list: empty, named after a string value in the file
	v.setUint32(child, crc32('Hello'), true);
	// object
	v.setUint32(obj, crc32('Settings'), true);
	v.setUint16(obj + 4, (params - obj) / 4, true);
	v.setUint16(obj + 6, 5, true);
	const param = (i: number, name: string, type: AampParamType, dataOff: number) => {
		const p = params + i * 8;
		v.setUint32(p, crc32(name), true);
		v.setUint32(p + 4, (((dataOff - p) / 4) | (type << 24)) >>> 0, true);
	};
	param(0, 'Enable', AampParamType.Bool, data);
	v.setUint32(data, 1, true);
	param(1, 'Speed', AampParamType.F32, data + 4);
	v.setFloat32(data + 4, 1.5, true);
	param(2, 'Name', AampParamType.String64, data + 8);
	out.set(new TextEncoder().encode('Hello'), data + 8);
	param(3, 'Position', AampParamType.Vec3, data + 0x48);
	[1, 2, 3].forEach((x, i) => v.setFloat32(data + 0x48 + i * 4, x, true));
	param(4, 'Table', AampParamType.BufferInt, data + 0x58);
	v.setUint32(data + 0x54, 3, true);
	[7, -8, 9].forEach((x, i) => v.setInt32(data + 0x58 + i * 4, x, true));
	v.setUint32(0x0c, out.length, true);
	return out;
}

describe('aamp', () => {
	it('checks the magic', () => {
		expect(isAamp(buildAamp())).toBe(true);
		expect(isAamp(new Uint8Array([0x59, 0x42, 2, 0]))).toBe(false);
	});

	it('parses lists, objects and typed parameters', () => {
		const p = parseAamp(buildAamp(), ['Settings', 'Speed', 'Position', 'Table']);
		expect(p.pioVersion).toBe(7);
		expect(p.dataType).toBe('xml');
		expect(p.root.name).toBe('param_root');
		// Resolved from the file's own string value.
		expect(p.root.lists[0]!.name).toBe('Hello');
		const o = p.root.objects[0]!;
		expect(o.name).toBe('Settings');
		expect(o.params.map((x) => [x.name, x.value])).toEqual([
			['Enable', true],
			['Speed', 1.5],
			['Name', 'Hello'],
			['Position', [1, 2, 3]],
			['Table', [7, -8, 9]],
		]);
	});

	it('shows unresolved names as hashes and renders text', () => {
		const p = parseAamp(buildAamp());
		expect(p.root.objects[0]!.name).toBe(`0x${crc32('Settings').toString(16).padStart(8, '0')}`);
		const txt = aampToText(parseAamp(buildAamp(), ['Settings', 'Position', 'Table']));
		expect(txt).toContain('Settings: !obj');
		expect(txt).toContain('Position: !vec3 [1, 2, 3]');
		expect(txt).toContain('Table: !bufferint [7, -8, 9]');
	});
});
