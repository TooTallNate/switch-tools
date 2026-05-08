import { describe, expect, it } from "vitest"
import { parseSerializedFile } from "../src/index.js"

describe("parseSerializedFile", () => {
  it("rejects buffers smaller than the header", async () => {
    const blob = new Blob([new Uint8Array(8)])
    await expect(parseSerializedFile(blob)).rejects.toThrow()
  })

  it("rejects big-endian payloads (we only support LE)", async () => {
    // Hand-build a header with endianness=1 (BE) — the parser
    // bails as soon as it sees that flag, before reaching any
    // of the post-header structure.
    const buf = new Uint8Array(0x40)
    const view = new DataView(buf.buffer)
    view.setUint32(0x08, 22, false) // version
    buf[0x10] = 1 // endianness = BE → unsupported
    await expect(parseSerializedFile(new Blob([buf]))).rejects.toThrow(/BE payload/)
  })
})
