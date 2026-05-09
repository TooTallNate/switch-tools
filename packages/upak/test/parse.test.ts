import { describe, expect, it } from "vitest"
import { isUpakV11, parseUpak } from "../src/index.js"

/**
 * Build a minimal but valid v11 PAK in memory containing two
 * uncompressed files. The on-disk layout we produce:
 *
 *   [0x000]              file_a per-file header (53 bytes, uncompressed)
 *   [0x035]              file_a payload "Hello, world!\n"
 *   [0x043]              file_b per-file header (53 bytes, uncompressed)
 *   [0x078]              file_b payload "second\n"
 *   [0x07F]              encoded pak entries (two entries, 4-byte flags +
 *                                             u32 offset + u32 uncompressed_size each = 12 bytes/entry)
 *   [encodedEnd]         primary index header
 *   [primaryEnd]         full directory index (one dir, two files)
 *   [...]                footer (205 bytes)
 *
 * No commercial-game data — every byte is constructed here.
 */
function buildSyntheticPak(): Uint8Array {
	const enc = new TextEncoder()
	const fileABody = enc.encode("Hello, world!\n")
	const fileBBody = enc.encode("second\n")

	// Per-file header (53 bytes for uncompressed v11):
	//   i64 offset (always 0 in the per-file copy)
	//   i64 compressed_size
	//   i64 uncompressed_size
	//   u32 compression_method (0 = none)
	//   u8[20] sha1
	function makeFileHeader(size: number): Uint8Array {
		const h = new Uint8Array(53)
		const v = new DataView(h.buffer)
		v.setBigInt64(0, 0n, true) // offset
		v.setBigInt64(8, BigInt(size), true) // compressed
		v.setBigInt64(16, BigInt(size), true) // uncompressed
		v.setUint32(24, 0, true) // method
		// sha1 left zero — we don't verify
		return h
	}

	const fileAHeader = makeFileHeader(fileABody.length)
	const fileBHeader = makeFileHeader(fileBBody.length)

	const fileAOffset = 0
	const fileBOffset = fileAHeader.length + fileABody.length

	// Encoded entries (one per file). Layout (uncompressed,
	// 32-bit-safe sizes): u32 flags + u32 offset + u32 uncompressed_size = 12 bytes.
	// flags = bit 31 (offset 32-bit safe) | bit 30 (uncompressed-size 32-bit safe) | bit 29 (size 32-bit safe)
	const flags = (1 << 31) | (1 << 30) | (1 << 29)
	function encodeEntry(offset: number, size: number): Uint8Array {
		const out = new Uint8Array(12)
		const v = new DataView(out.buffer)
		v.setUint32(0, flags >>> 0, true)
		v.setUint32(4, offset, true)
		v.setUint32(8, size, true)
		return out
	}

	const entryA = encodeEntry(fileAOffset, fileABody.length)
	const entryB = encodeEntry(fileBOffset, fileBBody.length)
	const encodedEntries = new Uint8Array(entryA.length + entryB.length)
	encodedEntries.set(entryA, 0)
	encodedEntries.set(entryB, entryA.length)

	// Full directory index — single dir "Game/" with two files.
	function fstring(s: string): Uint8Array {
		const bytes = enc.encode(s + "\0")
		const out = new Uint8Array(4 + bytes.length)
		new DataView(out.buffer).setInt32(0, bytes.length, true)
		out.set(bytes, 4)
		return out
	}
	const fdiParts: Uint8Array[] = [
		new Uint8Array(4), // num_dirs = 1
		fstring("Game/"),
		new Uint8Array(4), // num_files = 2
		fstring("a.txt"),
		new Uint8Array(4), // entryOffset for a
		fstring("b.txt"),
		new Uint8Array(4), // entryOffset for b
	]
	new DataView(fdiParts[0]!.buffer).setInt32(0, 1, true)
	new DataView(fdiParts[2]!.buffer).setInt32(0, 2, true)
	new DataView(fdiParts[4]!.buffer).setInt32(0, 0, true) // a at entry 0
	new DataView(fdiParts[6]!.buffer).setInt32(0, entryA.length, true) // b after a
	let fdiSize = 0
	for (const p of fdiParts) fdiSize += p.length
	const fullDirIndex = new Uint8Array(fdiSize)
	{
		let o = 0
		for (const p of fdiParts) {
			fullDirIndex.set(p, o)
			o += p.length
		}
	}

	// Primary index. Layout:
	//   i32 mount_point_len + mount_point
	//   i32 num_entries
	//   u64 path_hash_seed
	//   u32 has_path_hash_index = 0
	//   u32 has_full_directory_index = 1
	//   i64 fdi_offset, i64 fdi_size, u8[20] fdi_sha1
	//   i32 encoded_entries_size
	//   bytes encoded_entries
	//   i32 num_files (deprecated, 0)
	const mountPoint = fstring("../../../")
	const primaryParts: Uint8Array[] = []
	primaryParts.push(mountPoint)
	{
		const o = new Uint8Array(4)
		new DataView(o.buffer).setUint32(0, 2, true)
		primaryParts.push(o)
	}
	primaryParts.push(new Uint8Array(8)) // path_hash_seed = 0
	primaryParts.push(new Uint8Array(4)) // has_path_hash_index = 0
	{
		const o = new Uint8Array(4)
		new DataView(o.buffer).setUint32(0, 1, true) // has_full_directory_index = 1
		primaryParts.push(o)
	}
	// fdi_offset / size / sha1 — patched below once we know
	// where the full directory index will land.
	const fdiHeader = new Uint8Array(8 + 8 + 20)
	primaryParts.push(fdiHeader)
	{
		const o = new Uint8Array(4)
		new DataView(o.buffer).setInt32(0, encodedEntries.length, true)
		primaryParts.push(o)
	}
	primaryParts.push(encodedEntries)
	primaryParts.push(new Uint8Array(4)) // num_files = 0

	let primarySize = 0
	for (const p of primaryParts) primarySize += p.length
	const primary = new Uint8Array(primarySize)
	{
		let o = 0
		for (const p of primaryParts) {
			primary.set(p, o)
			o += p.length
		}
	}

	// Now compute layout: data → primary → full_dir_index → footer.
	const dataBytes = new Uint8Array(
		fileAHeader.length +
			fileABody.length +
			fileBHeader.length +
			fileBBody.length,
	)
	{
		let o = 0
		dataBytes.set(fileAHeader, o)
		o += fileAHeader.length
		dataBytes.set(fileABody, o)
		o += fileABody.length
		dataBytes.set(fileBHeader, o)
		o += fileBHeader.length
		dataBytes.set(fileBBody, o)
	}

	const indexOffset = dataBytes.length
	const fdiOffset = indexOffset + primary.length
	// Patch the FDI offset/size into `fdiHeader` we already
	// embedded inside `primary` — the slice was a reference into
	// `primary`, so writing to it updates `primary` directly.
	{
		// fdi header lives at this offset within `primary`:
		let off = 0
		off += mountPoint.length // mountPoint
		off += 4 // num_entries
		off += 8 // path_hash_seed
		off += 4 // has_path_hash_index
		off += 4 // has_full_directory_index
		const v = new DataView(primary.buffer, primary.byteOffset + off, 8 + 8 + 20)
		v.setBigInt64(0, BigInt(fdiOffset), true)
		v.setBigInt64(8, BigInt(fullDirIndex.length), true)
		// sha1 left zero
	}

	// Footer (205 bytes for v11):
	//   u8 encrypted_index = 0
	//   u32 magic = 0x5A6F12E1
	//   i32 version = 11
	//   i64 index_offset
	//   i64 index_size
	//   u8[20] index_sha1
	//   u8[32] × 5 compression methods (all empty)
	const footer = new Uint8Array(205)
	{
		const v = new DataView(footer.buffer)
		footer[0] = 0
		v.setUint32(1, 0x5a6f12e1, true)
		v.setInt32(5, 11, true)
		v.setBigInt64(9, BigInt(indexOffset), true)
		v.setBigInt64(17, BigInt(primary.length), true)
		// rest left zero
	}

	const total = new Uint8Array(
		dataBytes.length + primary.length + fullDirIndex.length + footer.length,
	)
	let o = 0
	total.set(dataBytes, o)
	o += dataBytes.length
	total.set(primary, o)
	o += primary.length
	total.set(fullDirIndex, o)
	o += fullDirIndex.length
	total.set(footer, o)
	return total
}

describe("isUpakV11", () => {
	it("accepts a synthetic v11 footer", async () => {
		const bytes = buildSyntheticPak()
		const blob = new Blob([bytes as BlobPart])
		expect(await isUpakV11(blob)).toBe(true)
	})

	it("rejects non-PAK input", async () => {
		const bytes = new Uint8Array(512)
		const blob = new Blob([bytes as BlobPart])
		expect(await isUpakV11(blob)).toBe(false)
	})
})

describe("parseUpak", () => {
	it("decodes a synthetic v11 PAK with two uncompressed files", async () => {
		const bytes = buildSyntheticPak()
		const blob = new Blob([bytes as BlobPart])
		const pak = await parseUpak(blob)
		expect(pak.footer.version).toBe(11)
		expect(pak.footer.encryptedIndex).toBe(false)
		expect(pak.mountPoint).toBe("../../../")
		expect(pak.entries).toHaveLength(2)
		const a = pak.entries.find((e) => e.path.endsWith("a.txt"))!
		const b = pak.entries.find((e) => e.path.endsWith("b.txt"))!
		expect(a).toBeDefined()
		expect(b).toBeDefined()
		expect(a.compressionMethodIndex).toBe(0)
		expect(a.uncompressedSize).toBe(14) // "Hello, world!\n"
		expect(b.uncompressedSize).toBe(7) // "second\n"
		expect(a.path).toBe("Game/a.txt")
		expect(b.path).toBe("Game/b.txt")
	})

	it("rejects a too-small blob", async () => {
		const blob = new Blob([new Uint8Array(10) as BlobPart])
		await expect(parseUpak(blob)).rejects.toThrowError(/too small/i)
	})

	it("rejects unsupported version", async () => {
		const bytes = buildSyntheticPak()
		// Mutate version (offset = total - 205 + 5)
		const versionOffset = bytes.length - 205 + 5
		new DataView(bytes.buffer).setInt32(versionOffset, 7, true)
		const blob = new Blob([bytes as BlobPart])
		await expect(parseUpak(blob)).rejects.toThrowError(
			/Unsupported UE PAK version 7/,
		)
	})

	it("rejects an encrypted-index PAK", async () => {
		const bytes = buildSyntheticPak()
		bytes[bytes.length - 205] = 1 // encrypted_index_flag
		const blob = new Blob([bytes as BlobPart])
		await expect(parseUpak(blob)).rejects.toThrowError(
			/encrypted index/i,
		)
	})
})
