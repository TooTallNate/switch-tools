import { describe, expect, it } from 'vitest';
import {
	parseUtf,
	isUtfMagic,
	UtfStorage,
	UtfType,
	UtfParseError,
} from '../src/utf.js';
import { buildUtfForTesting as buildUtf } from './fixture.js';

describe('isUtfMagic', () => {
	it('recognises "@UTF"', () => {
		expect(isUtfMagic(new Uint8Array([0x40, 0x55, 0x54, 0x46]))).toBe(true);
	});
	it('rejects other magics', () => {
		expect(isUtfMagic(new Uint8Array([0x41, 0x46, 0x53, 0x32]))).toBe(false);
		expect(isUtfMagic(new Uint8Array(0))).toBe(false);
	});
});

describe('parseUtf — primitive columns', () => {
	it('decodes integer and string columns across multiple rows', () => {
		const bytes = buildUtf(
			'TestTable',
			[
				{ name: 'Id', type: UtfType.U32, storage: UtfStorage.PerRow },
				{ name: 'Volume', type: UtfType.U16, storage: UtfStorage.PerRow },
				{ name: 'Name', type: UtfType.String, storage: UtfStorage.PerRow },
			],
			[
				{ Id: 7, Volume: 100, Name: 'Boss' },
				{ Id: 8, Volume: 80, Name: 'Menu' },
				{ Id: 9, Volume: 120, Name: 'Ambient' },
			],
		);
		const utf = parseUtf(bytes);
		expect(utf.name).toBe('TestTable');
		expect(utf.columns).toHaveLength(3);
		expect(utf.columns.map((c) => c.name)).toEqual(['Id', 'Volume', 'Name']);
		expect(utf.rows).toHaveLength(3);
		expect(utf.rows[0]).toEqual({ Id: 7, Volume: 100, Name: 'Boss' });
		expect(utf.rows[1]).toEqual({ Id: 8, Volume: 80, Name: 'Menu' });
		expect(utf.rows[2]).toEqual({ Id: 9, Volume: 120, Name: 'Ambient' });
	});

	it('decodes signed integer types', () => {
		const bytes = buildUtf(
			'Signed',
			[
				{ name: 'A', type: UtfType.S8, storage: UtfStorage.PerRow },
				{ name: 'B', type: UtfType.S16, storage: UtfStorage.PerRow },
				{ name: 'C', type: UtfType.S32, storage: UtfStorage.PerRow },
			],
			[{ A: -1 & 0xff, B: -2 & 0xffff, C: -3 >>> 0 }],
		);
		const utf = parseUtf(bytes);
		const row = utf.rows[0]!;
		expect(row['A']).toBe(-1);
		expect(row['B']).toBe(-2);
		expect(row['C']).toBe(-3);
	});

	it('decodes an empty table (zero rows)', () => {
		const bytes = buildUtf(
			'Empty',
			[{ name: 'X', type: UtfType.U32, storage: UtfStorage.PerRow }],
			[],
		);
		const utf = parseUtf(bytes);
		expect(utf.rows).toHaveLength(0);
		expect(utf.columns).toHaveLength(1);
	});

	it('decodes a Bytes blob and recursively parses nested @UTF', () => {
		const inner = buildUtf(
			'InnerTable',
			[{ name: 'Value', type: UtfType.U16, storage: UtfStorage.PerRow }],
			[{ Value: 42 }, { Value: 1337 }],
		);
		const outer = buildUtf(
			'OuterTable',
			[{ name: 'Child', type: UtfType.Bytes, storage: UtfStorage.PerRow }],
			[{ Child: inner }],
		);
		const utf = parseUtf(outer);
		const child = utf.rows[0]!['Child'];
		expect(child).not.toBeNull();
		expect(typeof child).toBe('object');
		if (
			child &&
			typeof child === 'object' &&
			'rows' in child &&
			'name' in child
		) {
			expect(child.name).toBe('InnerTable');
			expect(child.rows[0]).toEqual({ Value: 42 });
			expect(child.rows[1]).toEqual({ Value: 1337 });
		} else {
			throw new Error('expected nested ParsedUtf');
		}
	});

	it('passes through raw Bytes when the blob is not a @UTF table', () => {
		const blob = new Uint8Array([1, 2, 3, 4, 5]);
		const bytes = buildUtf(
			'BinaryHolder',
			[{ name: 'Payload', type: UtfType.Bytes, storage: UtfStorage.PerRow }],
			[{ Payload: blob }],
		);
		const utf = parseUtf(bytes);
		const v = utf.rows[0]!['Payload'];
		expect(v).toBeInstanceOf(Uint8Array);
		expect(Array.from(v as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe('parseUtf — errors', () => {
	it('throws on bad magic', () => {
		expect(() => parseUtf(new Uint8Array([0x42, 0x43, 0x44, 0x45]))).toThrow(
			UtfParseError,
		);
	});

	it('throws when too short (after the magic)', () => {
		const justMagic = new Uint8Array([0x40, 0x55, 0x54, 0x46]);
		expect(() => parseUtf(justMagic)).toThrow(/truncated/i);
	});
});
