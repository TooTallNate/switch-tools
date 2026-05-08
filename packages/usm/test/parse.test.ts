import { describe, expect, it } from "vitest"
import {
  isVp9Keyframe,
  muxVp9Webm,
  parseUsm,
  parseUtfTable,
  readUsmChunkIndex,
} from "../src/index.js"

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

  it("walks chunk index through a Blob-shaped facade (not a real Blob)", async () => {
    // Simulates the lazy AES-CTR-decrypting facade returned by
    // `@tootallnate/nca` for files inside an NSP. The facade
    // walks like a Blob but isn't `instanceof Blob` — which
    // historically broke `new Blob([facade])` constructions
    // inside the parser, because the native Blob constructor
    // stringifies non-Blob entries via `toString()` and the
    // result was a literal "[object Object]…" payload.
    //
    // The fix was to back the per-stream payload Blobs with our
    // own concat-facade rather than the native Blob constructor.
    // This test exercises that path by walking `readUsmChunkIndex`
    // against a facade input — chunk-index walking goes through
    // the same `slice().arrayBuffer()` chain that a real-world
    // inside-NSP USM would.
    const realUsmBytes = buildMinimalCridUsm()
    const facade: Blob = makeFacade(realUsmBytes.buffer, 0, realUsmBytes.byteLength)
    const chunks = await readUsmChunkIndex(facade)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.fourcc).toBe("CRID")
  })
})

/** Build a minimal CRID-only USM whose payload is empty. */
function buildMinimalCridUsm(): Uint8Array {
  const buf = new Uint8Array(0x40)
  buf.set(new TextEncoder().encode("CRID"), 0)
  new DataView(buf.buffer).setUint32(4, 0x38, false) // chunkSize = total - 8
  buf[9] = 0x18 // headerOffset
  return buf
}

/**
 * Minimal Blob-shaped facade for testing — backs onto an
 * `ArrayBuffer` window and supports the methods our parser
 * uses (`size`, `slice`, `arrayBuffer`). Critically this is
 * NOT `instanceof Blob`.
 */
function makeFacade(buffer: ArrayBuffer, start: number, end: number): Blob {
  const length = end - start
  const facade = {
    get size() {
      return length
    },
    get type() {
      return ""
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return buffer.slice(start, end)
    },
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(buffer.slice(start, end))
    },
    async text(): Promise<string> {
      return new TextDecoder().decode(new Uint8Array(buffer, start, length))
    },
    slice(s = 0, e = length): Blob {
      const ss = Math.max(0, Math.min(length, s))
      const ee = Math.max(ss, Math.min(length, e))
      return makeFacade(buffer, start + ss, start + ee)
    },
    stream(): ReadableStream<Uint8Array> {
      let done = false
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (done) {
            controller.close()
            return
          }
          done = true
          controller.enqueue(new Uint8Array(buffer, start, length))
        },
      })
    },
  }
  return facade as unknown as Blob
}

describe("isVp9Keyframe", () => {
  it("flags byte-0 frame_type=0 as keyframe", () => {
    // bit 2 of byte 0 is 0 → keyframe per VP9 spec.
    expect(isVp9Keyframe(new Uint8Array([0x80]))).toBe(true)
    expect(isVp9Keyframe(new Uint8Array([0x82]))).toBe(true) // bit 1 is something else
    // bit 2 set → non-key.
    expect(isVp9Keyframe(new Uint8Array([0x84]))).toBe(false)
  })
  it("treats empty input as non-key (defensive)", () => {
    expect(isVp9Keyframe(new Uint8Array(0))).toBe(false)
  })
})

describe("muxVp9Webm", () => {
  it("emits a WebM document with valid EBML structure", () => {
    // Two synthetic VP9 frames — bytes don't have to be real VP9
    // for the muxer's structural correctness.
    const frame0 = new Uint8Array([0x80, 0x49, 0x83, 0x42])
    const frame1 = new Uint8Array([0x84, 0x49, 0x83, 0x42])
    const webm = muxVp9Webm(
      [
        { data: frame0, timestampMs: 0, isKeyframe: true },
        { data: frame1, timestampMs: 16, isKeyframe: false },
      ],
      { width: 1920, height: 1080, frameDurationMs: 16, durationMs: 32 },
    )
    // EBML header magic.
    expect(webm[0]).toBe(0x1a)
    expect(webm[1]).toBe(0x45)
    expect(webm[2]).toBe(0xdf)
    expect(webm[3]).toBe(0xa3)
    // The "webm" docType string should appear somewhere early.
    const head = new TextDecoder().decode(webm.subarray(0, 64))
    expect(head).toContain("webm")
    // The V_VP9 codec id should appear.
    const all = new TextDecoder().decode(webm)
    expect(all).toContain("V_VP9")
  })
  it("rejects clusters longer than the s16 SimpleBlock timestamp can encode", () => {
    // Two keyframes 40 s apart in one cluster would push the
    // relative timestamp past 32 767 ms. We start a new cluster
    // on each keyframe, so this only triggers for non-key frames
    // very late in a single cluster — synthesise that.
    const a = new Uint8Array([0x80])
    const b = new Uint8Array([0x84])
    expect(() =>
      muxVp9Webm(
        [
          { data: a, timestampMs: 0, isKeyframe: true },
          { data: b, timestampMs: 40_000, isKeyframe: false }, // delta 40 s
        ],
        { width: 64, height: 64 },
      ),
    ).toThrow(/cluster too long/)
  })
})
