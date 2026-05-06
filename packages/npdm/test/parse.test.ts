import { describe, it, expect } from 'vitest';
import { isNpdm, parseNpdm } from '../src/index.js';

/**
 * Helpers for building synthetic NPDM blobs piece by piece.
 *
 * Layout we produce:
 *
 *   0x000  Meta (0x80 bytes)
 *   0x080  ACID  — header (0x240) + FAC + SAC + KC
 *   xxxx   ACI0  — header (0x40)  + FAC + SAC + KC
 */
function w8(buf: Uint8Array, off: number, v: number) {
	buf[off] = v & 0xff;
}
function w16(buf: Uint8Array, off: number, v: number) {
	new DataView(buf.buffer).setUint16(off, v, true);
}
function w32(buf: Uint8Array, off: number, v: number) {
	new DataView(buf.buffer).setUint32(off, v, true);
}
function w64(buf: Uint8Array, off: number, v: bigint) {
	new DataView(buf.buffer).setBigUint64(off, v, true);
}

interface NpdmFixtureOpts {
	flags?: number;
	threadPriority?: number;
	mainStack?: number;
	name?: string;
	productCode?: string;
	acidFlags?: number;
	programIdMin?: bigint;
	programIdMax?: bigint;
	acidFacFlag?: bigint;
	aci0ProgramId?: bigint;
	aci0FacFlag?: bigint;
	sacEntries?: Array<{ name: string; isServer: boolean }>;
	kcWords?: number[];
}

function buildNpdm(opts: NpdmFixtureOpts = {}): Uint8Array {
	const enc = new TextEncoder();
	const sacEntries = opts.sacEntries ?? [];
	const kcWords = opts.kcWords ?? [];

	// Build a minimal FAC payload (44 bytes is the minimum for ACID).
	const facLen = 0x2c;
	const sacBytes = sacEntries.reduce((s, e) => s + 1 + e.name.length, 0);
	const kcLen = kcWords.length * 4;

	// ACID layout: header (0x240) + FAC + SAC + KC
	const acidHeader = 0x240;
	const acidFacOff = acidHeader; // relative to ACID start
	const acidSacOff = acidFacOff + facLen;
	const acidKcOff = acidSacOff + sacBytes;
	const acidSize = acidKcOff + kcLen;

	// ACI0 layout: header (0x40) + FAC + SAC + KC
	const aci0Header = 0x40;
	const aci0FacLen = 0x1c;
	const aci0FacOff = aci0Header;
	const aci0SacOff = aci0FacOff + aci0FacLen;
	const aci0KcOff = aci0SacOff + sacBytes;
	const aci0Size = aci0KcOff + kcLen;

	const metaSize = 0x80;
	const acidStart = metaSize;
	const aci0Start = acidStart + acidSize;
	const totalSize = aci0Start + aci0Size;
	const buf = new Uint8Array(totalSize);

	// ----- Meta -----
	buf[0] = 0x4d; buf[1] = 0x45; buf[2] = 0x54; buf[3] = 0x41; // "META"
	w32(buf, 0x04, 0); // signature key generation
	w8(buf, 0x0c, opts.flags ?? 0);
	w8(buf, 0x0e, opts.threadPriority ?? 49);
	w8(buf, 0x0f, 0); // main thread core
	w32(buf, 0x14, 0); // SystemResourceSize
	w32(buf, 0x18, 0); // version
	w32(buf, 0x1c, opts.mainStack ?? 0x4000);
	const name = enc.encode(opts.name ?? 'Test');
	buf.set(name.subarray(0, Math.min(name.length, 0x10)), 0x20);
	const productCode = enc.encode(opts.productCode ?? '');
	buf.set(productCode.subarray(0, Math.min(productCode.length, 0x10)), 0x30);
	w32(buf, 0x70, aci0Start); // aciOffset
	w32(buf, 0x74, aci0Size);
	w32(buf, 0x78, acidStart); // acidOffset
	w32(buf, 0x7c, acidSize);

	// ----- ACID -----
	// Signature + public key are zero-filled.
	buf[acidStart + 0x200] = 0x41;
	buf[acidStart + 0x201] = 0x43;
	buf[acidStart + 0x202] = 0x49;
	buf[acidStart + 0x203] = 0x44; // "ACID"
	w32(buf, acidStart + 0x204, acidSize - 0x100);
	w8(buf, acidStart + 0x208, 1); // version
	w32(buf, acidStart + 0x20c, opts.acidFlags ?? 0);
	w64(buf, acidStart + 0x210, opts.programIdMin ?? 0x0100000000000001n);
	w64(buf, acidStart + 0x218, opts.programIdMax ?? 0x0100000000000001n);
	w32(buf, acidStart + 0x220, acidFacOff);
	w32(buf, acidStart + 0x224, facLen);
	w32(buf, acidStart + 0x228, acidSacOff);
	w32(buf, acidStart + 0x22c, sacBytes);
	w32(buf, acidStart + 0x230, acidKcOff);
	w32(buf, acidStart + 0x234, kcLen);

	// ACID FAC at acidStart + acidFacOff
	const facStart = acidStart + acidFacOff;
	w8(buf, facStart + 0x00, 1); // version
	w8(buf, facStart + 0x01, 0); // contentOwnerIdCount
	w8(buf, facStart + 0x02, 0); // saveDataOwnerIdCount
	w8(buf, facStart + 0x03, 0); // padding
	w64(buf, facStart + 0x04, opts.acidFacFlag ?? 0n);
	// 0x0c..0x2c: id min/max ranges (zero)

	// ACID SAC at acidStart + acidSacOff
	let sacCur = acidStart + acidSacOff;
	for (const e of sacEntries) {
		const nameBytes = enc.encode(e.name);
		const ctrl = (nameBytes.length - 1) | (e.isServer ? 0x80 : 0);
		buf[sacCur] = ctrl;
		buf.set(nameBytes, sacCur + 1);
		sacCur += 1 + nameBytes.length;
	}

	// ACID KC at acidStart + acidKcOff
	for (let i = 0; i < kcWords.length; i++) {
		w32(buf, acidStart + acidKcOff + i * 4, kcWords[i]);
	}

	// ----- ACI0 -----
	buf[aci0Start + 0x00] = 0x41;
	buf[aci0Start + 0x01] = 0x43;
	buf[aci0Start + 0x02] = 0x49;
	buf[aci0Start + 0x03] = 0x30; // "ACI0"
	w64(buf, aci0Start + 0x10, opts.aci0ProgramId ?? 0x0100000000000001n);
	w32(buf, aci0Start + 0x20, aci0FacOff);
	w32(buf, aci0Start + 0x24, aci0FacLen);
	w32(buf, aci0Start + 0x28, aci0SacOff);
	w32(buf, aci0Start + 0x2c, sacBytes);
	w32(buf, aci0Start + 0x30, aci0KcOff);
	w32(buf, aci0Start + 0x34, kcLen);

	// ACI0 FAC
	const aci0FacStart = aci0Start + aci0FacOff;
	w8(buf, aci0FacStart + 0x00, 1);
	w64(buf, aci0FacStart + 0x04, opts.aci0FacFlag ?? 0n);
	// content / save-data owner info offsets+sizes default to zero (no ids)

	// ACI0 SAC mirrors ACID SAC in this fixture
	let aci0SacCur = aci0Start + aci0SacOff;
	for (const e of sacEntries) {
		const nameBytes = enc.encode(e.name);
		const ctrl = (nameBytes.length - 1) | (e.isServer ? 0x80 : 0);
		buf[aci0SacCur] = ctrl;
		buf.set(nameBytes, aci0SacCur + 1);
		aci0SacCur += 1 + nameBytes.length;
	}

	// ACI0 KC mirrors ACID KC
	for (let i = 0; i < kcWords.length; i++) {
		w32(buf, aci0Start + aci0KcOff + i * 4, kcWords[i]);
	}

	return buf;
}

describe('isNpdm', () => {
	it('detects the META magic', async () => {
		const buf = buildNpdm();
		expect(await isNpdm(new Blob([buf]))).toBe(true);
		expect(await isNpdm(new Blob([new Uint8Array(0x80)]))).toBe(false);
		expect(await isNpdm(new Blob([new Uint8Array(2)]))).toBe(false);
	});
});

describe('parseNpdm — Meta', () => {
	it('parses a basic Meta header', async () => {
		const buf = buildNpdm({
			flags: 0x01 | (0x03 << 1), // 64-bit instructions, AddressSpace64Bit
			threadPriority: 44,
			mainStack: 0x10000,
			name: 'Application',
		});
		const parsed = await parseNpdm(new Blob([buf]));
		expect(parsed.meta.magic).toBe('META');
		expect(parsed.meta.is64Bit).toBe(true);
		expect(parsed.meta.addressSpace).toBe('AddressSpace64Bit');
		expect(parsed.meta.mainThreadPriority).toBe(44);
		expect(parsed.meta.mainThreadStackSize).toBe(0x10000);
		expect(parsed.meta.name).toBe('Application');
	});

	it('rejects a non-NPDM blob', async () => {
		const bad = new Uint8Array(0x100);
		bad[0] = 0x42; // 'B'
		await expect(parseNpdm(new Blob([bad]))).rejects.toThrow(/Invalid NPDM Meta magic/);
	});

	it('rejects a blob too small for a header', async () => {
		await expect(parseNpdm(new Blob([new Uint8Array(0x10)]))).rejects.toThrow(/too small/);
	});
});

describe('parseNpdm — ACID', () => {
	it('decodes basic ACID flags', async () => {
		const buf = buildNpdm({
			acidFlags: 0x01 | (1 << 2), // ProductionFlag=1, MemoryRegion=1 (Applet)
			programIdMin: 0x0100000000010000n,
			programIdMax: 0x01000000000fffffn,
		});
		const parsed = await parseNpdm(new Blob([buf]));
		expect(parsed.acid.magic).toBe('ACID');
		expect(parsed.acid.productionFlag).toBe(true);
		expect(parsed.acid.memoryRegion).toBe('Applet');
		expect(parsed.acid.programIdMin).toBe(0x0100000000010000n);
		expect(parsed.acid.programIdMax).toBe(0x01000000000fffffn);
	});

	it('decodes the ACID FsAccessFlag bitmap', async () => {
		// Set bit 0 (ApplicationInfo) + bit 4 (GameCard) + bit 63 (FullPermission).
		const flag = (1n << 0n) | (1n << 4n) | (1n << 63n);
		const buf = buildNpdm({ acidFacFlag: flag });
		const parsed = await parseNpdm(new Blob([buf]));
		expect(parsed.acid.fac.flagBits).toEqual([
			'ApplicationInfo',
			'GameCard',
			'FullPermission',
		]);
	});
});

describe('parseNpdm — ACI0', () => {
	it('decodes the program ID and FsAccessFlag', async () => {
		const flag = (1n << 3n) | (1n << 18n); // SystemSaveData + DeviceSaveData
		const buf = buildNpdm({
			aci0ProgramId: 0x0100afc018700000n,
			aci0FacFlag: flag,
		});
		const parsed = await parseNpdm(new Blob([buf]));
		expect(parsed.aci0.programId).toBe(0x0100afc018700000n);
		expect(parsed.aci0.fac.flagBits).toEqual([
			'SystemSaveData',
			'DeviceSaveData',
		]);
	});
});

describe('parseNpdm — ServiceAccessControl', () => {
	it('parses a list of service names with mixed wildcard/server flags', async () => {
		const buf = buildNpdm({
			sacEntries: [
				{ name: 'fsp-srv', isServer: false },
				{ name: 'set:sys', isServer: false },
				{ name: 'foo*', isServer: false },
				{ name: 'apm', isServer: true },
			],
		});
		const parsed = await parseNpdm(new Blob([buf]));
		expect(parsed.acid.sac.entries.map((e) => e.name)).toEqual([
			'fsp-srv',
			'set:sys',
			'foo*',
			'apm',
		]);
		expect(parsed.acid.sac.entries.find((e) => e.name === 'apm')!.isServer).toBe(true);
		expect(parsed.acid.sac.entries.find((e) => e.name === 'fsp-srv')!.isServer).toBe(false);
		// ACI0 mirrors ACID in our fixture.
		expect(parsed.aci0.sac.entries).toEqual(parsed.acid.sac.entries);
	});
});

describe('parseNpdm — KernelCapabilities', () => {
	function build(kind: string, fields: Record<string, number>): number {
		// Tiny helper to build canonical KC words for a few descriptor kinds.
		switch (kind) {
			case 'ThreadInfo': {
				// pattern: ...0111 (low 4 bits = 0111, with bit 3 = 0)
				let w = 0x07;
				w |= (fields.lowestPriority & 0x3f) << 4;
				w |= (fields.highestPriority & 0x3f) << 10;
				w |= (fields.minCore & 0xff) << 16;
				w |= (fields.maxCore & 0xff) << 24;
				return w;
			}
			case 'EnableSystemCalls': {
				let w = 0x0f;
				w |= (fields.mask & 0xffffff) << 5;
				w |= (fields.index & 0x07) << 29;
				return w >>> 0;
			}
			case 'KernelVersion': {
				let w = 0x3fff;
				w |= (fields.minor & 0x0f) << 15;
				w |= (fields.major & 0x1fff) << 19;
				return w >>> 0;
			}
			case 'HandleTableSize': {
				let w = 0x7fff;
				w |= (fields.size & 0x3ff) << 16;
				return w >>> 0;
			}
			case 'MiscFlags': {
				let w = 0xffff;
				if (fields.enableDebug) w |= 1 << 17;
				if (fields.forceDebugProd) w |= 1 << 18;
				if (fields.forceDebug) w |= 1 << 19;
				return w >>> 0;
			}
		}
		throw new Error(`Unknown kind: ${kind}`);
	}

	it('decodes ThreadInfo / KernelVersion / HandleTableSize / MiscFlags', async () => {
		const words = [
			build('ThreadInfo', { lowestPriority: 0x3b, highestPriority: 0x10, minCore: 0, maxCore: 3 }),
			build('KernelVersion', { major: 12, minor: 4 }),
			build('HandleTableSize', { size: 0x200 }),
			build('MiscFlags', { enableDebug: 1, forceDebugProd: 0, forceDebug: 0 }),
		];
		const buf = buildNpdm({ kcWords: words });
		const parsed = await parseNpdm(new Blob([buf]));
		const ds = parsed.acid.kc.descriptors;
		expect(ds[0]).toMatchObject({
			kind: 'ThreadInfo',
			lowestPriority: 0x3b,
			highestPriority: 0x10,
			minCoreNumber: 0,
			maxCoreNumber: 3,
		});
		expect(ds[1]).toMatchObject({ kind: 'KernelVersion', majorVersion: 12, minorVersion: 4 });
		expect(ds[2]).toMatchObject({ kind: 'HandleTableSize', handleTableSize: 0x200 });
		expect(ds[3]).toMatchObject({ kind: 'MiscFlags', enableDebug: true, forceDebugProd: false, forceDebug: false });
	});

	it('decodes EnableSystemCalls into individual syscall ids', async () => {
		// Index 1, mask = 0b0000...00010101 (syscalls 24, 26, 28)
		const word = build('EnableSystemCalls', { index: 1, mask: 0b10101 });
		const buf = buildNpdm({ kcWords: [word] });
		const parsed = await parseNpdm(new Blob([buf]));
		const d = parsed.acid.kc.descriptors[0];
		expect(d.kind).toBe('EnableSystemCalls');
		if (d.kind === 'EnableSystemCalls') {
			expect(d.index).toBe(1);
			expect(d.syscalls).toEqual([24, 26, 28]);
		}
	});
});

describe('parseNpdm — error reporting', () => {
	it('throws when ACID magic is wrong', async () => {
		const buf = buildNpdm();
		// Corrupt the ACID magic.
		const acidStart = 0x80;
		buf[acidStart + 0x200] = 0xff;
		await expect(parseNpdm(new Blob([buf]))).rejects.toThrow(/Invalid ACID magic/);
	});

	it('throws when ACI0 magic is wrong', async () => {
		const buf = buildNpdm();
		const acidSize = new DataView(buf.buffer).getUint32(0x7c, true);
		const aci0Start = 0x80 + acidSize;
		buf[aci0Start + 0x00] = 0xff;
		await expect(parseNpdm(new Blob([buf]))).rejects.toThrow(/Invalid ACI0 magic/);
	});
});
