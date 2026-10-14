import { describe, it, expect } from 'vitest';
import {
	aesCtrEncrypt,
	buildNcaCtr,
	createPatchedSectionReader,
	readPatchInfo,
} from '../src/index.js';

const NODE = 0x4000;

/** One BucketTree (L1 node + a single entry set) as `2 * NODE` bytes. */
function bucketTree(entries: Uint8Array[], endVirt: bigint, virtOf: (e: Uint8Array) => bigint) {
	const out = new Uint8Array(2 * NODE);
	const dv = new DataView(out.buffer);
	dv.setInt32(0, 0, true);
	dv.setInt32(4, 1, true);
	dv.setBigInt64(8, endVirt, true);
	dv.setBigInt64(16, virtOf(entries[0]), true);
	dv.setInt32(NODE + 0, 0, true);
	dv.setInt32(NODE + 4, entries.length, true);
	dv.setBigInt64(NODE + 8, endVirt, true);
	let p = NODE + 16;
	for (const e of entries) {
		out.set(e, p);
		p += e.byteLength;
	}
	return out;
}

function indirectEntry(virt: number, phys: number, storage: number) {
	const e = new Uint8Array(0x14);
	const dv = new DataView(e.buffer);
	dv.setBigInt64(0, BigInt(virt), true);
	dv.setBigInt64(8, BigInt(phys), true);
	dv.setInt32(16, storage, true);
	return e;
}

function aesCtrExEntry(offset: number, notEncrypted: boolean, generation: number) {
	const e = new Uint8Array(0x10);
	const dv = new DataView(e.buffer);
	dv.setBigInt64(0, BigInt(offset), true);
	e[8] = notEncrypted ? 1 : 0;
	dv.setUint32(12, generation, true);
	return e;
}

function bktrHeader(entryCount: number) {
	const h = new Uint8Array(16);
	const dv = new DataView(h.buffer);
	dv.setUint32(0, 0x52544b42, true);
	dv.setUint32(4, 1, true);
	dv.setInt32(8, entryCount, true);
	return h;
}

function withGeneration(sectionCtr: Uint8Array, generation: number) {
	const c = new Uint8Array(sectionCtr);
	new DataView(c.buffer).setUint32(0, generation, true);
	return c;
}

describe('BKTR patched sections', () => {
	it('merges base and patch data through the indirect and AesCtrEx tables', async () => {
		const sectionKey = new Uint8Array(16).map((_, i) => 0x30 + i);
		const sectionCtr = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const sectionStart = 0x4000;

		const base = new Uint8Array(0x1000).map((_, i) => (i * 7) & 0xff);
		const patchPlain = new Uint8Array(0x200).map((_, i) => 0x80 ^ (i & 0xff));

		// Virtual layout: base[0, 0x80) + patch[0, 0x200) + base[0x280, 0x1000).
		const indirect = bucketTree(
			[indirectEntry(0, 0, 0), indirectEntry(0x80, 0, 1), indirectEntry(0x280, 0x280, 0)],
			0x1000n,
			(e) => new DataView(e.buffer).getBigInt64(0, true),
		);
		// Patch data: [0, 0x100) encrypted with generation 5, [0x100, 0x200) in the clear.
		const aesCtrEx = bucketTree(
			[aesCtrExEntry(0, false, 5), aesCtrExEntry(0x100, true, 0)],
			0x200n,
			(e) => new DataView(e.buffer).getBigInt64(0, true),
		);
		const indirectOffset = 0x200;
		const aesCtrExOffset = indirectOffset + indirect.byteLength;
		const sectionSize = aesCtrExOffset + aesCtrEx.byteLength;

		const section = new Uint8Array(sectionSize);
		const encrypt = (bytes: Uint8Array, at: number, upper: Uint8Array) =>
			aesCtrEncrypt(sectionKey, bytes, buildNcaCtr(upper, sectionStart + at));
		section.set(await encrypt(patchPlain.subarray(0, 0x100), 0, withGeneration(sectionCtr, 5)), 0);
		section.set(patchPlain.subarray(0x100, 0x200), 0x100);
		section.set(await encrypt(indirect, indirectOffset, sectionCtr), indirectOffset);
		section.set(await encrypt(aesCtrEx, aesCtrExOffset, sectionCtr), aesCtrExOffset);

		const fsHeader = new Uint8Array(0x200);
		const fdv = new DataView(fsHeader.buffer);
		fdv.setBigUint64(0x100, BigInt(indirectOffset), true);
		fdv.setBigUint64(0x108, BigInt(indirect.byteLength), true);
		fsHeader.set(bktrHeader(3), 0x110);
		fdv.setBigUint64(0x120, BigInt(aesCtrExOffset), true);
		fdv.setBigUint64(0x128, BigInt(aesCtrEx.byteLength), true);
		fsHeader.set(bktrHeader(2), 0x130);

		expect(readPatchInfo(fsHeader)).toMatchObject({
			indirectOffset,
			indirectEntryCount: 3,
			aesCtrExOffset,
			aesCtrExEntryCount: 2,
		});

		const source = new Blob([new Uint8Array(sectionStart), section]);
		const { reader, size } = createPatchedSectionReader({
			source,
			sectionStart,
			sectionSize,
			fsHeader,
			sectionCtr,
			sectionKey,
			base: new Blob([base]),
		});
		expect(await size()).toBe(0x1000);

		const expected = new Uint8Array(0x1000);
		expected.set(base.subarray(0, 0x80), 0);
		expected.set(patchPlain, 0x80);
		expected.set(base.subarray(0x280), 0x280);
		expect(await reader(0, 0x1000)).toEqual(expected);
		// Unaligned reads that straddle every boundary.
		expect(await reader(0x77, 0x2a3)).toEqual(expected.subarray(0x77, 0x2a3));
		expect(await reader(0x17f, 0x181)).toEqual(expected.subarray(0x17f, 0x181));
	});
});
