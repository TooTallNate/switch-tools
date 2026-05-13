import { describe, expect, it } from 'vitest';
import {
	FMappedNameType,
	isZenPackage,
	parseZenPackage,
	ZenPackageParseError,
} from '../src/index.js';

/**
 * Synthetic Zen-package builder. We assemble a minimal legacy
 * `FPackageSummary`-layout package with one name, no imports, one
 * export — just enough to exercise the parser without any
 * commercial-game bytes.
 *
 * Layout we produce (offsets in the resulting buffer):
 *   0x00  FMappedName Name          (8)
 *   0x08  FMappedName SourceName    (8)
 *   0x10  u32 PackageFlags
 *   0x14  u32 CookedHeaderSize
 *   0x18  i32 NameMapNamesOffset       = 0x40
 *   0x1C  i32 NameMapNamesSize         = computed
 *   0x20  i32 NameMapHashesOffset      = NameMapNamesOffset + NamesSize
 *   0x24  i32 NameMapHashesSize        = 8 + 8 * nameCount
 *   0x28  i32 ImportMapOffset          = hashes end
 *   0x2C  i32 ExportMapOffset          = importMap end
 *   0x30  i32 ExportBundlesOffset      = exportMap end (one entry = 72 bytes)
 *   0x34  i32 GraphDataOffset          = bundles end (header 8 + entries 16 = 24)
 *   0x38  i32 GraphDataSize            = 4
 *   0x3C  i32 _Pad                     = 0
 *   ...   name batch (legacy: u16-BE-prefixed names, no padding when ASCII)
 *   ...   name hashes (u64 HashVersion + u64[nameCount])
 *   ...   import map (empty for our fixture)
 *   ...   export map (1 entry × 72 bytes)
 *   ...   export bundles (1 header + 2 entries)
 *   ...   graph data (4 bytes of zeros)
 *   ...   export body bytes
 */

function buildSyntheticZenLegacy(names: string[]): Uint8Array {
	if (names.length === 0) throw new Error('need at least one name');
	const enc = new TextEncoder();
	// Name batch payload: 2 BE bytes header + name bytes per entry.
	const nameBatch = (() => {
		const parts: Uint8Array[] = [];
		let total = 0;
		for (const n of names) {
			const bytes = enc.encode(n);
			const hdr = new Uint8Array(2);
			// length up to 0x7FFF, ASCII (top bit cleared)
			hdr[0] = (bytes.length >> 8) & 0x7f;
			hdr[1] = bytes.length & 0xff;
			parts.push(hdr, bytes);
			total += hdr.length + bytes.length;
		}
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	})();
	const hashesBlob = new Uint8Array(8 + 8 * names.length);
	new DataView(hashesBlob.buffer).setBigUint64(0, 0xc1640000n, true);
	// Per-name hashes left zero — the parser doesn't validate them.

	const importMap = new Uint8Array(0); // 0 imports
	const exportMap = new Uint8Array(72); // 1 export, content patched below
	// export bundle header (8) + entries (2 × 8 = 16) = 24 bytes
	const bundles = new Uint8Array(24);
	{
		const dv = new DataView(bundles.buffer);
		dv.setUint32(0, 0, true); // FirstEntryIndex
		dv.setUint32(4, 2, true); // EntryCount
		// entries:
		dv.setUint32(8, 0, true); // entry 0: LocalExportIndex=0
		dv.setUint32(12, 0, true); // CommandType=Create
		dv.setUint32(16, 0, true); // entry 1: LocalExportIndex=0
		dv.setUint32(20, 1, true); // CommandType=Serialize
	}
	const graphData = new Uint8Array(4); // legacy graph data: ReferencedPackageCount=0
	const exportBodyBytes = enc.encode('export-body-test-content'); // 24 bytes

	// Compute offsets
	const summaryFixedSize = 0x40;
	const nameMapNamesOffset = summaryFixedSize;
	const nameMapNamesSize = nameBatch.length;
	const nameMapHashesOffset = nameMapNamesOffset + nameMapNamesSize;
	const nameMapHashesSize = hashesBlob.length;
	const importMapOffset = nameMapHashesOffset + nameMapHashesSize;
	const exportMapOffset = importMapOffset + importMap.length;
	const exportBundlesOffset = exportMapOffset + exportMap.length;
	const graphDataOffset = exportBundlesOffset + bundles.length;
	const graphDataSize = graphData.length;
	const headerSize = graphDataOffset + graphDataSize;
	const totalSize = headerSize + exportBodyBytes.length;

	// Patch the single export entry — CookedSerialOffset is informational
	// for legacy mode but should still be the actual offset relative to
	// CookedHeaderSize.
	{
		const dv = new DataView(exportMap.buffer);
		dv.setBigUint64(0, BigInt(headerSize), true); // CookedSerialOffset
		dv.setBigUint64(8, BigInt(exportBodyBytes.length), true); // CookedSerialSize
		// ObjectName FMappedName: index 0, number 0 — first name in batch.
		dv.setUint32(16, 0, true);
		dv.setUint32(20, 0, true);
		// OuterIndex, ClassIndex, SuperIndex, TemplateIndex — set to Null.
		for (let off = 24; off < 56; off += 8) {
			dv.setBigUint64(off, 0xffffffffffffffffn, true);
		}
		dv.setBigUint64(56, 0x123456789abcdef0n, true); // PublicExportHash
		dv.setUint32(64, 0x11, true); // ObjectFlags (Public | ClassDefaultObject)
		exportMap[68] = 0; // FilterFlags
	}

	const out = new Uint8Array(totalSize);
	const dv = new DataView(out.buffer);
	// Summary
	dv.setUint32(0x00, 0, true); // Name idx | type
	dv.setUint32(0x04, 0, true); // Name number
	dv.setUint32(0x08, 0, true); // SourceName idx | type
	dv.setUint32(0x0c, 0, true); // SourceName number
	dv.setUint32(0x10, 0x80002000, true); // PackageFlags
	dv.setUint32(0x14, headerSize + 16, true); // CookedHeaderSize (arbitrary > headerSize)
	dv.setInt32(0x18, nameMapNamesOffset, true);
	dv.setInt32(0x1c, nameMapNamesSize, true);
	dv.setInt32(0x20, nameMapHashesOffset, true);
	dv.setInt32(0x24, nameMapHashesSize, true);
	dv.setInt32(0x28, importMapOffset, true);
	dv.setInt32(0x2c, exportMapOffset, true);
	dv.setInt32(0x30, exportBundlesOffset, true);
	dv.setInt32(0x34, graphDataOffset, true);
	dv.setInt32(0x38, graphDataSize, true);
	dv.setInt32(0x3c, 0, true); // pad

	out.set(nameBatch, nameMapNamesOffset);
	out.set(hashesBlob, nameMapHashesOffset);
	out.set(importMap, importMapOffset);
	out.set(exportMap, exportMapOffset);
	out.set(bundles, exportBundlesOffset);
	out.set(graphData, graphDataOffset);
	out.set(exportBodyBytes, headerSize);
	return out;
}

describe('isZenPackage', () => {
	it('returns false for the legacy .uasset magic', () => {
		const bytes = new Uint8Array(60);
		new DataView(bytes.buffer).setUint32(0, 0x9e2a83c1, true);
		expect(isZenPackage(bytes)).toBe(false);
	});

	it('returns true for a buffer without the legacy magic', () => {
		const bytes = buildSyntheticZenLegacy(['First', 'Second']);
		expect(isZenPackage(bytes)).toBe(true);
	});

	it('returns false for very short input', () => {
		expect(isZenPackage(new Uint8Array(10))).toBe(false);
	});
});

describe('parseZenPackage — legacy variant', () => {
	it('decodes a minimal one-name one-export fixture', () => {
		const bytes = buildSyntheticZenLegacy(['MyPackageName']);
		const parsed = parseZenPackage(bytes);
		expect(parsed.summary.variant).toBe('legacy');
		expect(parsed.summary.name).toBe('MyPackageName');
		expect(parsed.summary.packageFlags).toBe(0x80002000);
		expect(parsed.names).toEqual(['MyPackageName']);
		expect(parsed.imports).toHaveLength(0);
		expect(parsed.exports).toHaveLength(1);
	});

	it('exposes export body offset + size for downstream readers', () => {
		const bytes = buildSyntheticZenLegacy(['One']);
		const parsed = parseZenPackage(bytes);
		const exp = parsed.exports[0]!;
		expect(exp.objectName).toBe('One');
		expect(exp.cookedSerialSize).toBe(24); // 'export-body-test-content'
		// bodyOffset must point at the start of the body region (headerSize).
		const bodySlice = bytes.subarray(exp.bodyOffset, exp.bodyOffset + exp.cookedSerialSize);
		expect(new TextDecoder().decode(bodySlice)).toBe('export-body-test-content');
	});

	it('decodes multiple names from the legacy split name batch', () => {
		const bytes = buildSyntheticZenLegacy(['A', 'BB', 'CCC', 'DDDD']);
		const parsed = parseZenPackage(bytes);
		expect(parsed.names).toEqual(['A', 'BB', 'CCC', 'DDDD']);
	});

	it('parses FMappedName fields correctly', () => {
		const bytes = buildSyntheticZenLegacy(['Foo']);
		const parsed = parseZenPackage(bytes);
		expect(parsed.summary.nameMappedName.nameIndex).toBe(0);
		expect(parsed.summary.nameMappedName.number).toBe(0);
		expect(parsed.summary.nameMappedName.mapType).toBe(FMappedNameType.Package);
	});
});

describe('parseZenPackage — error handling', () => {
	it('throws ZenPackageParseError on completely invalid input', () => {
		const garbage = new Uint8Array(60);
		// Fill with values that won't pass either parser's offset checks.
		for (let i = 0; i < garbage.length; i++) garbage[i] = 0xff;
		expect(() => parseZenPackage(garbage)).toThrowError(ZenPackageParseError);
	});

	it('throws on truncated input', () => {
		expect(() => parseZenPackage(new Uint8Array(0))).toThrowError(ZenPackageParseError);
	});
});
