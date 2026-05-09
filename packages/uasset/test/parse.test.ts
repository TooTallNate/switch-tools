import { describe, expect, it } from "vitest"
import {
	UASSET_MAGIC,
	inferAssetClassName,
	isUasset,
	parseUasset,
	resolveFName,
	resolvePackageIndex,
} from "../src/index.js"

/**
 * Build a minimal valid UE 4.27-style `.uasset` header in
 * memory with two names, one import (the asset's class), and
 * one export (the asset itself).
 *
 * Layout:
 *
 *   FPackageFileSummary (fixed-size header)
 *   Name table
 *   Import table
 *   Export table
 *
 * We only need enough fields populated for `parseUasset` to
 * walk every section without erroring; the per-table values are
 * tested for correctness via `parseUasset(...).{names,imports,exports}`.
 *
 * No commercial-game data — every byte is constructed here.
 */
function buildSyntheticUasset(): Uint8Array {
	const enc = new TextEncoder()
	function fstring(s: string): Uint8Array {
		const bytes = enc.encode(s + "\0")
		const out = new Uint8Array(4 + bytes.length)
		new DataView(out.buffer).setInt32(0, bytes.length, true)
		out.set(bytes, 4)
		return out
	}
	function nameEntry(name: string): Uint8Array {
		const s = fstring(name)
		const out = new Uint8Array(s.length + 4) // +2 hashes
		out.set(s, 0)
		// hashes left zero
		return out
	}

	// ---- Names ----
	const names = [
		"None", // 0
		"/Script/Synthetic", // 1 — asset class package
		"SyntheticAsset", // 2 — asset class name
		"MyAsset", // 3 — instance name
	]
	const nameTableParts: Uint8Array[] = names.map(nameEntry)
	let nameTableSize = 0
	for (const p of nameTableParts) nameTableSize += p.length
	const nameTable = new Uint8Array(nameTableSize)
	{
		let o = 0
		for (const p of nameTableParts) {
			nameTable.set(p, o)
			o += p.length
		}
	}

	// ---- Imports ----
	// Single import: the asset's class.
	//   classPackage: FName(idx=1, number=0) → "/Script/CoreUObject"-style (we use /Script/Synthetic)
	//   className:    FName(idx=0, number=0) → "Class" — but we'll use idx=2 (SyntheticAsset)
	//   outerIndex:   0
	//   objectName:   FName(idx=2, number=0)
	function importEntry(
		classPackage: number,
		className: number,
		outerIndex: number,
		objectName: number,
	): Uint8Array {
		const out = new Uint8Array(28)
		const v = new DataView(out.buffer)
		v.setUint32(0, classPackage, true)
		v.setUint32(4, 0, true) // classPackage.number
		v.setUint32(8, className, true)
		v.setUint32(12, 0, true)
		v.setInt32(16, outerIndex, true)
		v.setUint32(20, objectName, true)
		v.setUint32(24, 0, true)
		return out
	}
	const importTable = importEntry(1, 2, 0, 2)

	// ---- Exports (single export) ----
	// 104 bytes per entry (fixed stride). Most fields zero.
	function exportEntry(
		classIndex: number,
		objectName: number,
	): Uint8Array {
		const out = new Uint8Array(104)
		const v = new DataView(out.buffer)
		v.setInt32(0, classIndex, true) // classIndex (negative = import)
		v.setInt32(4, 0, true) // superIndex
		v.setInt32(8, 0, true) // templateIndex
		v.setInt32(12, 0, true) // outerIndex
		v.setUint32(16, objectName, true) // objectName.nameIndex
		v.setUint32(20, 0, true) // objectName.number
		v.setUint32(24, 0, true) // objectFlags
		v.setBigInt64(28, 100n, true) // serialSize
		v.setBigInt64(36, 1000n, true) // serialOffset
		v.setUint32(44, 0, true) // forcedExport
		v.setUint32(48, 0, true) // notForClient
		v.setUint32(52, 0, true) // notForServer
		// 16 bytes packageGuid + remaining fields all zero
		return out
	}
	const exportTable = exportEntry(-1, 3) // classIndex=-1 → import 0; objectName=3 → "MyAsset"

	// ---- FPackageFileSummary (build it incrementally so we can
	// emit the offsets correctly) ----
	// Header layout (no UE5 fields, no custom versions):
	//   u32 magic
	//   i32 legacyFileVersion = -7   (UE 4.27)
	//   i32 legacyUE3Version = 0
	//   i32 fileVersionUE4 = 0       (unversioned)
	//   i32 fileVersionLicensee = 0
	//   u32 customVersionCount = 0
	//   u32 totalHeaderSize           ← patched
	//   fstring folderName ("None")
	//   u32 packageFlags
	//   u32 nameCount, u32 nameOffset  ← patched
	//   u32 gatherableTextCount, u32 gatherableTextOffset = 0
	//   u32 exportCount, u32 exportOffset  ← patched
	//   u32 importCount, u32 importOffset  ← patched
	//   u32 dependsOffset = 0
	//   u32 softPackageRefCount = 0, u32 softPackageRefOffset = 0
	//   u32 searchableNamesOffset = 0
	//   u32 thumbnailTableOffset = 0
	//   u8[16] guid
	//   u32 generationCount = 1
	//   per gen: u32 exports, u32 names

	const folderName = fstring("None")
	const headerFixedSize =
		4 + // magic
		4 + // legacyFileVersion
		4 + // legacyUE3
		4 + // fileVersionUE4
		4 + // fileVersionLicensee
		4 + // customVersionCount
		4 + // totalHeaderSize
		folderName.length +
		4 + // packageFlags
		4 + 4 + // nameCount, nameOffset
		4 + 4 + // gatherable count, offset
		4 + 4 + // exportCount, exportOffset
		4 + 4 + // importCount, importOffset
		4 + // dependsOffset
		4 + 4 + // softPkg count, offset
		4 + // searchableNamesOffset
		4 + // thumbnailTableOffset
		16 + // guid
		4 + // generationCount
		8 // gen[0]
	const nameOffset = headerFixedSize
	const importOffset = nameOffset + nameTable.length
	const exportOffset = importOffset + importTable.length
	const totalSize = exportOffset + exportTable.length

	const out = new Uint8Array(totalSize)
	const v = new DataView(out.buffer)
	let off = 0
	v.setUint32(off, UASSET_MAGIC, true); off += 4
	v.setInt32(off, -7, true); off += 4
	v.setInt32(off, 0, true); off += 4
	v.setInt32(off, 0, true); off += 4
	v.setInt32(off, 0, true); off += 4
	v.setUint32(off, 0, true); off += 4 // customVersionCount
	v.setUint32(off, totalSize, true); off += 4 // totalHeaderSize
	out.set(folderName, off); off += folderName.length
	v.setUint32(off, 0, true); off += 4 // packageFlags
	v.setUint32(off, names.length, true); off += 4
	v.setUint32(off, nameOffset, true); off += 4
	v.setUint32(off, 0, true); off += 4 // gatherable count
	v.setUint32(off, 0, true); off += 4 // gatherable offset
	v.setUint32(off, 1, true); off += 4 // exportCount
	v.setUint32(off, exportOffset, true); off += 4
	v.setUint32(off, 1, true); off += 4 // importCount
	v.setUint32(off, importOffset, true); off += 4
	v.setUint32(off, 0, true); off += 4 // dependsOffset
	v.setUint32(off, 0, true); off += 4 // softPkg count
	v.setUint32(off, 0, true); off += 4 // softPkg offset
	v.setUint32(off, 0, true); off += 4 // searchableNamesOffset
	v.setUint32(off, 0, true); off += 4 // thumbnailTableOffset
	off += 16 // guid (left zero)
	v.setUint32(off, 1, true); off += 4 // generationCount
	v.setUint32(off, 1, true); off += 4 // gen[0].exports
	v.setUint32(off, names.length, true); off += 4 // gen[0].names

	out.set(nameTable, nameOffset)
	out.set(importTable, importOffset)
	out.set(exportTable, exportOffset)

	return out
}

describe("isUasset", () => {
	it("accepts a valid magic", () => {
		expect(isUasset(new Uint8Array([0xc1, 0x83, 0x2a, 0x9e]))).toBe(true)
	})
	it("rejects wrong magic", () => {
		expect(isUasset(new Uint8Array([0x50, 0x4e, 0x47, 0x0d]))).toBe(false)
	})
})

describe("parseUasset", () => {
	const bytes = buildSyntheticUasset()
	const parsed = parseUasset(bytes)

	it("decodes the package summary", () => {
		expect(parsed.summary.magic).toBe(UASSET_MAGIC)
		expect(parsed.summary.legacyFileVersion).toBe(-7)
		expect(parsed.summary.fileVersionUE5).toBeNull()
		expect(parsed.summary.folderName).toBe("None")
		expect(parsed.summary.nameCount).toBe(4)
		expect(parsed.summary.exportCount).toBe(1)
		expect(parsed.summary.importCount).toBe(1)
		expect(parsed.summary.totalHeaderSize).toBe(bytes.length)
	})

	it("reads the name table", () => {
		expect(parsed.names.map((n) => n.value)).toEqual([
			"None",
			"/Script/Synthetic",
			"SyntheticAsset",
			"MyAsset",
		])
	})

	it("reads the import table", () => {
		expect(parsed.imports).toHaveLength(1)
		const imp = parsed.imports[0]!
		expect(resolveFName(imp.classPackage, parsed.names)).toBe("/Script/Synthetic")
		expect(resolveFName(imp.objectName, parsed.names)).toBe("SyntheticAsset")
	})

	it("reads the export table", () => {
		expect(parsed.exports).toHaveLength(1)
		const exp = parsed.exports[0]!
		expect(resolveFName(exp.objectName, parsed.names)).toBe("MyAsset")
		expect(exp.serialSize).toBe(100)
		expect(exp.serialOffset).toBe(1000)
		expect(exp.classIndex).toBe(-1)
	})

	it("infers the asset class name from imports", () => {
		expect(inferAssetClassName(parsed)).toBe("SyntheticAsset")
	})

	it("resolves package indices to display strings", () => {
		expect(
			resolvePackageIndex(0, parsed.imports, parsed.exports, parsed.names),
		).toBe("None")
		expect(
			resolvePackageIndex(-1, parsed.imports, parsed.exports, parsed.names),
		).toBe("SyntheticAsset")
		expect(
			resolvePackageIndex(1, parsed.imports, parsed.exports, parsed.names),
		).toBe("MyAsset")
	})

	it("rejects non-uasset input", () => {
		expect(() => parseUasset(new Uint8Array(20))).toThrowError(/Not a UE/)
	})
})
