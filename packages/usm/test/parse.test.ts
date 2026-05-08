import { describe, expect, it } from "vitest"
import { parseUsm, parseUtfTable, readUsmChunkIndex } from "../src/index.js"

// Minimal hand-built @UTF table for round-trip testing without
// needing real USM files in the repo. We include this so we
// exercise the schema decoder end-to-end against a known input
// — real USMs are too big (and license-encumbered) to vendor.
function buildSimpleUtf(): Uint8Array {
  // Strings table (NUL-terminated):
  //   "<NULL>"     (offset 0)
  //   "MY_TABLE"   (offset 7)
  //   "fmtver"     (offset 16)
  //   "name"       (offset 23)
  const strings = new TextEncoder().encode(
    "<NULL>\0MY_TABLE\0fmtver\0name\0",
  )
  // Two columns:
  //   - "fmtver"  (NAME|DEFAULT, dtype=u32) inline value 100
  //   - "name"    (NAME|ROW, dtype=string)
  // Two rows. Each row holds: 4 bytes string offset for "name".
  // String offsets: row 0 → "<NULL>" at 0, row 1 → "fmtver" at 16.
  // Schema layout:
  //   header (24 bytes after magic+size)
  //   columns (1+4 +inline u32 = 9 bytes for col0; 1+4 = 5 bytes for col1)
  //   rows (4 bytes per row × 2 = 8)
  //   strings (length above)
  //   binary (none)
  const header = new ArrayBuffer(24)
  const headerView = new DataView(header)
  // Body offsets (relative to byte 8 of full table = byte 0 of body):
  //   rowsOffset = 24 (after header) + columns size
  //   stringsOffset = rowsOffset + rows size
  //   binaryOffset = stringsOffset + strings.length
  const colsSize = 9 + 5 // col0 has inline u32 default
  const rowsSize = 4 * 2
  const rowsOffset = 24 + colsSize
  const stringsOffset = rowsOffset + rowsSize
  const binaryOffset = stringsOffset + strings.length
  const tableNameOffset = 7 // "MY_TABLE"
  headerView.setUint32(0, rowsOffset, false)
  headerView.setUint32(4, stringsOffset, false)
  headerView.setUint32(8, binaryOffset, false)
  headerView.setUint32(12, tableNameOffset, false)
  headerView.setUint16(16, 2, false) // numColumns
  headerView.setUint16(18, 4, false) // rowWidth (4 bytes per row: just the string offset)
  headerView.setUint32(20, 2, false) // numRows

  const cols = new Uint8Array(colsSize)
  // Col 0: NAME|DEFAULT|u32 = 0x10|0x20|0x04 = 0x34. Name @ 16.
  // Inline default: 100 (BE u32).
  cols[0] = 0x34
  new DataView(cols.buffer).setUint32(1, 16, false) // name offset → "fmtver"
  new DataView(cols.buffer).setUint32(5, 100, false) // inline default value
  // Col 1: NAME|ROW|string = 0x10|0x40|0x0a = 0x5a. Name @ 23.
  cols[9] = 0x5a
  new DataView(cols.buffer).setUint32(10, 23, false) // name offset → "name"

  const rows = new ArrayBuffer(rowsSize)
  const rowsView = new DataView(rows)
  rowsView.setUint32(0, 0, false) // row 0: name → "<NULL>"
  rowsView.setUint32(4, 16, false) // row 1: name → "fmtver"

  const bodyLen = 24 + colsSize + rowsSize + strings.length
  const fullLen = 8 + bodyLen // magic + size + body
  const out = new Uint8Array(fullLen)
  out.set(new TextEncoder().encode("@UTF"), 0)
  new DataView(out.buffer).setUint32(4, bodyLen, false)
  out.set(new Uint8Array(header), 8)
  out.set(cols, 8 + 24)
  out.set(new Uint8Array(rows), 8 + 24 + colsSize)
  out.set(strings, 8 + 24 + colsSize + rowsSize)
  return out
}

describe("parseUtfTable", () => {
  it("decodes a hand-built table with both DEFAULT and ROW columns", () => {
    const buf = buildSimpleUtf()
    const table = parseUtfTable(buf)
    expect(table.name).toBe("MY_TABLE")
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]!.fmtver).toBe(100)
    expect(table.rows[0]!.name).toBe("<NULL>")
    expect(table.rows[1]!.fmtver).toBe(100) // default applies to every row
    expect(table.rows[1]!.name).toBe("fmtver")
  })

  it("rejects buffers that don't start with @UTF", () => {
    const bogus = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])
    expect(() => parseUtfTable(bogus)).toThrow(/@UTF/)
  })
})

describe("readUsmChunkIndex", () => {
  it("rejects non-USM input", async () => {
    const blob = new Blob([new Uint8Array(64)])
    await expect(readUsmChunkIndex(blob)).rejects.toThrow(/unexpected chunk fourcc/)
  })

  it("walks a minimal hand-built USM", async () => {
    // Build the smallest possible legal USM: one CRID chunk with
    // a 16-byte payload (not a real @UTF table, just enough to
    // satisfy the chunk walker).
    const chunkBuf = new Uint8Array(0x40)
    chunkBuf.set(new TextEncoder().encode("CRID"), 0)
    new DataView(chunkBuf.buffer).setUint32(4, 0x38, false) // chunkSize (= total - 8)
    chunkBuf[9] = 0x18 // headerOffset
    new DataView(chunkBuf.buffer).setUint16(0x0a, 0, false) // padSize
    chunkBuf[0x0c] = 0 // channel
    chunkBuf[0x0f] = 1 // dataType = HEADER
    new DataView(chunkBuf.buffer).setUint32(0x10, 0, false) // frameTime
    new DataView(chunkBuf.buffer).setUint32(0x14, 30, false) // frameRate

    const blob = new Blob([chunkBuf])
    const chunks = await readUsmChunkIndex(blob)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.fourcc).toBe("CRID")
    expect(chunks[0]!.totalSize).toBe(0x40)
    expect(chunks[0]!.frameRate).toBe(30)
  })
})

describe("parseUsm", () => {
  it("rejects non-USM input", async () => {
    const blob = new Blob([new Uint8Array(64)])
    await expect(parseUsm(blob)).rejects.toThrow(/bad magic/)
  })
})
