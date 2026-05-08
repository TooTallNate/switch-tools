/**
 * Parser for CRI Sofdec2 USM video container files. USM ("CRI
 * Universal Streaming Media") is the format CRI Middleware ships
 * with their cross-platform game movie SDK and, by extension,
 * the format you'll find in any first- or third-party Switch
 * game that uses CRI's video runtime — Mario RPG, Tales of *,
 * Yakuza, Persona, Atelier, etc.
 *
 * On-disk structure: a sequence of fixed-shape chunks tagged
 * with a 4-byte fourcc. The first chunk is `CRID`, listing every
 * stream in the file via an @UTF metadata table. Subsequent
 * chunks alternate between `@SFV` (video stream data), `@SFA`
 * (audio stream data), `@SBT` (subtitle stream), `@CUE` (cue
 * points), and `@SFM` (rare auxiliary data). A "stream" here is
 * just a logical channel — the actual codec (VP9 / H.264 / HCA /
 * ADX / PCM) lives in a per-stream header chunk.
 *
 * This parser is fully-lazy: it walks the chunk index up front
 * (cheap — just header reads via `Blob.slice`), then exposes
 * each stream's payload as a `Blob` whose `arrayBuffer()` only
 * materialises bytes on demand. So a 4 GB DLC USM costs ~50 KB
 * of RAM until you actually start decoding frames.
 *
 * For the codec specifics:
 *
 *   - `videoCodec` reports a normalised codec name. VP9 streams
 *     come out with their original IVF wrapper intact (just
 *     concatenate the chunk payloads), so they're directly
 *     consumable by `@tootallnate/usm`'s helpers / WebCodecs /
 *     ffmpeg / VLC.
 *   - `audioCodec` is best-effort; HCA needs per-game keys to
 *     decode actual samples (not in this package's scope).
 */

const TEXT = new TextDecoder()

// ----- chunk fourcc + flags -----

/** Top-level USM chunk fourcc strings. */
export const ChunkType = {
  CRID: "CRID", // file index — first chunk only
  SFV: "@SFV",  // video stream data
  SFA: "@SFA",  // audio stream data
  SBT: "@SBT",  // subtitle stream
  CUE: "@CUE",  // cue points
  SFM: "@SFM",  // metadata stream (rare)
} as const

/**
 * Per-chunk `dataType` (header byte +0x0F). Determines what's
 * inside the chunk's payload: real codec data, or metadata-style
 * @UTF tables / ASCII section markers.
 */
export const DataType = {
  STREAM: 0,
  /** Payload is an `@UTF` table — codec params, seek index, etc. */
  HEADER: 1,
  /** Payload is an ASCII end-marker like `#HEADER END    `. */
  SECTION_END: 2,
  /** Payload is an `@UTF` table with stream metadata. */
  METADATA: 3,
} as const

// ----- @UTF (CRI Universal Table Format) -----

/**
 * A single row of an `@UTF` table, presented as a name → value
 * record. `BigInt` is used for 64-bit columns; everything else
 * is `number` / `string` / `Uint8Array`.
 */
export type UtfRow = Record<string, number | bigint | string | Uint8Array>

export interface UtfTable {
  name: string
  rows: UtfRow[]
}

/**
 * Parse an `@UTF` table from a buffer that begins with the
 * `@UTF` magic. The format is documented exhaustively in
 * vgmstream's `cri_utf.c`; the short version is:
 *
 *   - 8-byte header: magic + body size.
 *   - 24-byte body header: rows offset, strings offset, binary
 *     offset, table-name offset, column count, row width, row
 *     count. All offsets are relative to byte 8 of the table.
 *   - Column descriptors: 1 byte flags, 4 bytes name offset,
 *     optional inline default value (sized by the data type)
 *     when the flags include `DEFAULT`.
 *   - Rows: `numRows × rowWidth` bytes, with each column's
 *     value at the offset accumulated by walking the columns
 *     in order.
 *
 * Flag layout (per `cri_utf.c`):
 *
 *   0x10 NAME      column has a name
 *   0x20 DEFAULT   column has an inline default applied to all
 *                  rows that don't override it
 *   0x40 ROW       column has per-row data in the row buffer
 *   0x80 UNDEFINED invalid; throw
 *
 * Real-world tables only set NAME plus exactly one of DEFAULT
 * or ROW. A few legacy files (e.g. Muramasa Rebirth) set both;
 * we handle that path correctly by giving DEFAULT precedence
 * and skipping past the row data.
 *
 * Data types (lower 4 bits of flag byte): 0=u8, 1=s8, 2=u16BE,
 * 3=s16BE, 4=u32BE, 5=s32BE, 6=u64BE, 7=s64BE, 8=f32BE,
 * 9=f64BE, 0xA=string (offset into string table), 0xB=binary
 * (offset+size pair into binary data section).
 */
export function parseUtfTable(buf: Uint8Array): UtfTable {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = TEXT.decode(buf.subarray(0, 4))
  if (magic !== "@UTF") throw new Error(`@UTF: bad magic "${magic}"`)
  const tableSize = view.getUint32(4, false)
  // Body offsets are all relative to byte 8.
  const BASE = 8
  const rowsOffset = view.getUint32(BASE + 0, false) + BASE
  const stringsOffset = view.getUint32(BASE + 4, false) + BASE
  const binaryOffset = view.getUint32(BASE + 8, false) + BASE
  const tableNameOffset = view.getUint32(BASE + 12, false)
  const numColumns = view.getUint16(BASE + 16, false)
  const rowWidth = view.getUint16(BASE + 18, false)
  const numRows = view.getUint32(BASE + 20, false)

  const stringsBuf = buf.subarray(stringsOffset)
  const binaryBuf = buf.subarray(binaryOffset)
  const readString = (off: number): string => {
    let end = off
    while (end < stringsBuf.length && stringsBuf[end] !== 0) end++
    return TEXT.decode(stringsBuf.subarray(off, end))
  }
  const tableName = readString(tableNameOffset)

  const FLAG_NAME = 0x10
  const FLAG_DEFAULT = 0x20
  const FLAG_ROW = 0x40
  const FLAG_UNDEFINED = 0x80

  interface ColumnInfo {
    name: string
    dtype: number
    hasDefault: boolean
    hasRow: boolean
    defaultValue?: number | bigint | string | Uint8Array
  }
  const columns: ColumnInfo[] = []
  let cursor = BASE + 24
  for (let i = 0; i < numColumns; i++) {
    const flags = buf[cursor]!
    cursor += 1
    if (flags & FLAG_UNDEFINED) {
      throw new Error(`@UTF: column ${i} has UNDEFINED flag set (0x${flags.toString(16)})`)
    }
    if (!(flags & FLAG_NAME)) {
      throw new Error(`@UTF: column ${i} has no NAME flag (0x${flags.toString(16)})`)
    }
    const dtype = flags & 0x0f
    const nameOff = view.getUint32(cursor, false)
    cursor += 4
    const name = readString(nameOff)
    let defaultValue: number | bigint | string | Uint8Array | undefined
    if (flags & FLAG_DEFAULT) {
      const r = readDtype(view, cursor, dtype, stringsBuf, binaryBuf)
      defaultValue = r.value
      cursor += r.size
    }
    columns.push({
      name,
      dtype,
      hasDefault: !!(flags & FLAG_DEFAULT),
      hasRow: !!(flags & FLAG_ROW),
      defaultValue,
    })
  }

  const rows: UtfRow[] = []
  for (let r = 0; r < numRows; r++) {
    const row: UtfRow = {}
    let rcur = rowsOffset + r * rowWidth
    for (const col of columns) {
      if (col.hasDefault) {
        row[col.name] = col.defaultValue!
        // ROW data, when present alongside DEFAULT, still
        // occupies row buffer space — skip past it.
        if (col.hasRow) {
          const size = dtypeSize(col.dtype)
          rcur += size
        }
      } else if (col.hasRow) {
        const result = readDtype(view, rcur, col.dtype, stringsBuf, binaryBuf)
        row[col.name] = result.value
        rcur += result.size
      } else {
        // Neither DEFAULT nor ROW: column reads as the dtype's
        // zero. Real CRI tables don't emit these, but defensive.
        row[col.name] = dtypeZero(col.dtype)
      }
    }
    rows.push(row)
  }
  void tableSize // not actually needed once we have the columns/rows
  return { name: tableName, rows }
}

interface DtypeResult {
  value: number | bigint | string | Uint8Array
  size: number
}
function readDtype(
  view: DataView,
  off: number,
  dtype: number,
  stringsBuf: Uint8Array,
  binaryBuf: Uint8Array,
): DtypeResult {
  switch (dtype) {
    case 0x0:
      return { value: view.getUint8(off), size: 1 }
    case 0x1:
      return { value: view.getInt8(off), size: 1 }
    case 0x2:
      return { value: view.getUint16(off, false), size: 2 }
    case 0x3:
      return { value: view.getInt16(off, false), size: 2 }
    case 0x4:
      return { value: view.getUint32(off, false), size: 4 }
    case 0x5:
      return { value: view.getInt32(off, false), size: 4 }
    case 0x6:
      return { value: view.getBigUint64(off, false), size: 8 }
    case 0x7:
      return { value: view.getBigInt64(off, false), size: 8 }
    case 0x8:
      return { value: view.getFloat32(off, false), size: 4 }
    case 0x9:
      return { value: view.getFloat64(off, false), size: 8 }
    case 0xa: {
      const strOff = view.getUint32(off, false)
      let end = strOff
      while (end < stringsBuf.length && stringsBuf[end] !== 0) end++
      return { value: TEXT.decode(stringsBuf.subarray(strOff, end)), size: 4 }
    }
    case 0xb: {
      const binOff = view.getUint32(off, false)
      const binSize = view.getUint32(off + 4, false)
      // Copy out: callers shouldn't have to worry about the
      // backing buffer's lifetime.
      const out = new Uint8Array(binSize)
      out.set(binaryBuf.subarray(binOff, binOff + binSize))
      return { value: out, size: 8 }
    }
    default:
      throw new Error(`@UTF: unknown dtype 0x${dtype.toString(16)}`)
  }
}
function dtypeSize(dtype: number): number {
  switch (dtype) {
    case 0x0: case 0x1: return 1
    case 0x2: case 0x3: return 2
    case 0x4: case 0x5: case 0x8: case 0xa: return 4
    case 0x6: case 0x7: case 0x9: case 0xb: return 8
    default: throw new Error(`@UTF: unknown dtype 0x${dtype.toString(16)}`)
  }
}
function dtypeZero(dtype: number): number | bigint | string | Uint8Array {
  if (dtype === 0xa) return ""
  if (dtype === 0xb) return new Uint8Array(0)
  if (dtype === 0x6 || dtype === 0x7) return 0n
  return 0
}

// ----- chunk walker -----

/**
 * One USM chunk's header fields, plus the absolute byte range
 * of its payload within the source blob. `payloadStart` is
 * inclusive and `payloadEnd` is exclusive.
 */
export interface UsmChunkHeader {
  fourcc: string
  /** Absolute offset in the source blob of the chunk's first byte. */
  offset: number
  /** Total bytes occupied by the chunk (including padding). */
  totalSize: number
  /** Absolute offset of the chunk payload's first byte. */
  payloadStart: number
  /** Absolute offset just past the last payload byte. */
  payloadEnd: number
  /** Channel number (0 = primary; multi-track audio uses higher). */
  channel: number
  /** What kind of payload this chunk carries — see {@link DataType}. */
  dataType: number
  /** Frame timestamp in the codec's own units. */
  frameTime: number
  /** Frame rate scale factor — interpretation depends on the stream. */
  frameRate: number
}

/**
 * Walk a USM blob's chunk index without materialising any
 * payload bytes. Each chunk header is ~24 bytes; we only read
 * those, so a multi-GB USM is indexed in milliseconds.
 *
 * Throws if a chunk's fourcc isn't one of the known top-level
 * tags — that's almost always a sign the input is corrupted
 * or isn't actually a USM.
 */
export async function readUsmChunkIndex(
  blob: Blob,
): Promise<UsmChunkHeader[]> {
  // Pull the entire file index in 4 MB strides. We're only
  // reading 24 bytes per chunk, so for a typical 1 GB USM with
  // ~40k chunks we make ~250 small slice reads — fast.
  const out: UsmChunkHeader[] = []
  const STRIDE = 4 * 1024 * 1024
  let off = 0
  let buffered: Uint8Array | null = null
  let bufferedStart = 0
  const ensure = async (need: number) => {
    if (
      buffered &&
      off >= bufferedStart &&
      off + need <= bufferedStart + buffered.length
    ) {
      return
    }
    bufferedStart = off
    const end = Math.min(blob.size, off + STRIDE)
    buffered = new Uint8Array(await blob.slice(off, end).arrayBuffer())
  }

  while (off < blob.size) {
    await ensure(0x18)
    if (!buffered) break
    const local = off - bufferedStart
    if (local + 0x18 > buffered.length) {
      // Partial read at end-of-stride; refresh.
      bufferedStart = off
      const end = Math.min(blob.size, off + STRIDE)
      buffered = new Uint8Array(await blob.slice(off, end).arrayBuffer())
      if (buffered.length < 0x18) break
    }
    const view = new DataView(
      buffered.buffer,
      buffered.byteOffset + (off - bufferedStart),
      0x18,
    )
    const fourcc = TEXT.decode(
      buffered.subarray(off - bufferedStart, off - bufferedStart + 4),
    )
    if (
      fourcc !== ChunkType.CRID &&
      fourcc !== ChunkType.SFV &&
      fourcc !== ChunkType.SFA &&
      fourcc !== ChunkType.SBT &&
      fourcc !== ChunkType.CUE &&
      fourcc !== ChunkType.SFM
    ) {
      throw new Error(
        `USM: unexpected chunk fourcc "${fourcc}" at offset 0x${off.toString(16)}`,
      )
    }
    const chunkSize = view.getUint32(4, false)
    const headerOffset = view.getUint8(9)
    const padSize = view.getUint16(0x0a, false)
    const channel = view.getUint8(0x0c)
    const dataType = view.getUint8(0x0f)
    const frameTime = view.getUint32(0x10, false)
    const frameRate = view.getUint32(0x14, false)
    const totalSize = chunkSize + 8
    const payloadStart = off + headerOffset + 8
    const payloadEnd = off + totalSize - padSize
    out.push({
      fourcc,
      offset: off,
      totalSize,
      payloadStart,
      payloadEnd,
      channel,
      dataType,
      frameTime,
      frameRate,
    })
    off += totalSize
  }

  return out
}

// ----- high-level parse -----

/** Codec ID values that show up in `VIDEO_HDRINFO.mpeg_codec`. */
export const VideoCodecId = {
  /** No video stream / placeholder. */
  None: 0,
  /** Sofdec.Prime VP9. */
  VP9: 9,
  /** H.264 / AVC. */
  H264: 5,
  /** Older Sofdec MPEG. */
  Mpeg: 1,
} as const

export type VideoCodec = "vp9" | "h264" | "mpeg" | "unknown"

/** Pretty codec name + the original raw enum value from the file. */
export interface VideoCodecInfo {
  codec: VideoCodec
  rawId: number
}

export interface UsmVideoStream {
  type: "video"
  /** Channel number — primary video is 0. */
  channel: number
  codec: VideoCodecInfo
  width: number
  height: number
  /** Display-cropped width (often equals `width`). */
  displayWidth: number
  displayHeight: number
  /** Frames per second, decoded from `framerate_n / framerate_d`. */
  fps: number
  totalFrames: number
  /**
   * Concatenated payload of every data-type-0 video chunk for
   * this channel, as a lazy Blob. For VP9 USMs this is a
   * complete IVF file; for H.264 USMs it's a raw NAL stream.
   */
  data: Blob
  /** Approximate uncompressed byte length of `data`. */
  dataSize: number
}

export type UsmAudioCodec = "hca" | "adx" | "pcm" | "unknown"

export interface UsmAudioStream {
  type: "audio"
  channel: number
  codec: UsmAudioCodec
  sampleRate: number
  channelCount: number
  totalSamples: number
  /**
   * Concatenated payload of every data-type-0 audio chunk for
   * this channel. The bytes are codec-specific (HCA / ADX /
   * raw PCM).
   */
  data: Blob
  dataSize: number
}

export type UsmStream = UsmVideoStream | UsmAudioStream

export interface UsmFile {
  /** Total file size in bytes (echoes `blob.size` for convenience). */
  fileSize: number
  /**
   * Stream index from the leading CRID chunk's CRIUSF_DIR_STREAM
   * table — one row per stream including the directory itself.
   */
  streams: UsmStream[]
  /** Raw chunk index, for tools that want to walk it themselves. */
  chunks: UsmChunkHeader[]
}

/**
 * Parse a USM blob and surface its streams. The actual codec
 * payloads are exposed as lazy Blobs — they don't get
 * materialised until the caller pulls bytes via
 * `stream.data.arrayBuffer()` / `.stream()`.
 *
 * Multi-channel audio (e.g. JP/EN voice tracks on the same
 * stream id) is exposed as separate `UsmAudioStream` objects,
 * one per channel, since most consumers want to pick one
 * language and decode it independently.
 */
export async function parseUsm(blob: Blob): Promise<UsmFile> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  const magic = TEXT.decode(head)
  if (magic !== "CRID") {
    throw new Error(`USM: bad magic "${magic}"; expected "CRID"`)
  }
  const chunks = await readUsmChunkIndex(blob)
  if (chunks.length === 0) throw new Error("USM: no chunks found")

  // ---- pull the CRIUSF_DIR_STREAM table from the first CRID ----
  const cridChunks = chunks.filter((c) => c.fourcc === ChunkType.CRID)
  if (cridChunks.length === 0) throw new Error("USM: no CRID chunk")
  // The first CRID's data-type-0 (or in practice, type-1)
  // payload is the directory @UTF table. We don't gate on
  // dataType here because some USMs label it differently across
  // CRI tool versions — just take the first @UTF we find inside.
  const firstCrid = cridChunks[0]!
  const cridBytes = new Uint8Array(
    await blob.slice(firstCrid.payloadStart, firstCrid.payloadEnd).arrayBuffer(),
  )
  const dirTable = parseUtfTable(skipToUtf(cridBytes))
  if (dirTable.name !== "CRIUSF_DIR_STREAM") {
    throw new Error(
      `USM: first CRID's table is "${dirTable.name}", expected "CRIUSF_DIR_STREAM"`,
    )
  }

  // ---- collect per-channel header @UTF tables ----
  // For each top-level channel kind we look for the first
  // dataType=1 chunk on that channel; its payload is an @UTF
  // table describing the codec. Mario RPG uses the table named
  // VIDEO_HDRINFO for video; older files use VIDEO_PARAMS.
  // Audio uses AUDIO_HDRINFO / AUDIO_PARAMS analogously.
  const videoHeader = await findHeaderUtf(blob, chunks, ChunkType.SFV)
  const audioHeadersByChannel = await findHeaderUtfsByChannel(
    blob,
    chunks,
    ChunkType.SFA,
  )

  // ---- video stream ----
  const streams: UsmStream[] = []
  if (videoHeader) {
    const row = videoHeader.rows[0]!
    const codec = identifyVideoCodec(numField(row, "mpeg_codec"))
    const width = numField(row, "width")
    const height = numField(row, "height")
    const displayWidth = numField(row, "disp_width") || width
    const displayHeight = numField(row, "disp_height") || height
    const fpsN = numField(row, "framerate_n") || 30000
    const fpsD = numField(row, "framerate_d") || 1000
    const totalFrames = numField(row, "total_frames")
    const { data, dataSize } = makeStreamPayloadBlob(
      blob,
      chunks,
      ChunkType.SFV,
      0,
    )
    streams.push({
      type: "video",
      channel: 0,
      codec,
      width,
      height,
      displayWidth,
      displayHeight,
      fps: fpsD === 0 ? 0 : fpsN / fpsD,
      totalFrames,
      data,
      dataSize,
    })
  }

  // ---- audio streams (one per channel) ----
  for (const [channel, hdr] of audioHeadersByChannel) {
    const row = hdr.rows[0]!
    const codecRaw = numField(row, "audio_codec")
    let codec: UsmAudioCodec = "unknown"
    if (codecRaw === 2) codec = "hca"
    else if (codecRaw === 0) codec = "adx"
    else if (codecRaw === 4) codec = "pcm"
    const { data, dataSize } = makeStreamPayloadBlob(
      blob,
      chunks,
      ChunkType.SFA,
      channel,
    )
    streams.push({
      type: "audio",
      channel,
      codec,
      sampleRate: numField(row, "sampling_rate"),
      channelCount: numField(row, "num_channels"),
      totalSamples: numField(row, "total_samples"),
      data,
      dataSize,
    })
  }

  return { fileSize: blob.size, streams, chunks }
}

/**
 * Some USM authoring tools prefix the CRID chunk's @UTF payload
 * with 8 bytes of zero padding. Skip ahead to the magic before
 * handing the buffer to the parser.
 */
function skipToUtf(buf: Uint8Array): Uint8Array {
  for (let i = 0; i < 16 && i + 4 <= buf.length; i++) {
    if (
      buf[i] === 0x40 &&
      buf[i + 1] === 0x55 &&
      buf[i + 2] === 0x54 &&
      buf[i + 3] === 0x46
    ) {
      return buf.subarray(i)
    }
  }
  return buf
}

/**
 * Locate the codec-header @UTF table for a given top-level
 * stream tag (`@SFV` or `@SFA`). The convention is: the first
 * `dataType=1` chunk for that fourcc carries an @UTF table
 * describing the codec. If the file doesn't have one (e.g.
 * audio-less USMs don't include @SFA at all), returns null.
 */
async function findHeaderUtf(
  blob: Blob,
  chunks: UsmChunkHeader[],
  fourcc: string,
): Promise<UtfTable | null> {
  for (const c of chunks) {
    if (c.fourcc !== fourcc) continue
    if (c.dataType !== DataType.HEADER) continue
    const bytes = new Uint8Array(
      await blob.slice(c.payloadStart, c.payloadEnd).arrayBuffer(),
    )
    const utfBuf = skipToUtf(bytes)
    if (utfBuf.length < 8 || TEXT.decode(utfBuf.subarray(0, 4)) !== "@UTF") {
      continue
    }
    return parseUtfTable(utfBuf)
  }
  return null
}

/**
 * Same as {@link findHeaderUtf} but groups by channel — one
 * table per audio track. Used for multi-language USMs that
 * carry e.g. JP voice on channel 0 and EN voice on channel 1.
 */
async function findHeaderUtfsByChannel(
  blob: Blob,
  chunks: UsmChunkHeader[],
  fourcc: string,
): Promise<Map<number, UtfTable>> {
  const out = new Map<number, UtfTable>()
  for (const c of chunks) {
    if (c.fourcc !== fourcc) continue
    if (c.dataType !== DataType.HEADER) continue
    if (out.has(c.channel)) continue
    const bytes = new Uint8Array(
      await blob.slice(c.payloadStart, c.payloadEnd).arrayBuffer(),
    )
    const utfBuf = skipToUtf(bytes)
    if (utfBuf.length < 8 || TEXT.decode(utfBuf.subarray(0, 4)) !== "@UTF") {
      continue
    }
    out.set(c.channel, parseUtfTable(utfBuf))
  }
  return out
}

/** Pull a numeric column from a UTF row, coercing BigInt to Number. */
function numField(row: UtfRow, name: string): number {
  const v = row[name]
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  return 0
}

/**
 * Build a lazy Blob representing the concatenation of every
 * `dataType=0` chunk payload for `fourcc` on `channel`. Uses
 * `Blob` constructor with a list of `blob.slice()` ranges —
 * each slice is itself lazy, so concatenation is essentially
 * free until the caller pulls bytes.
 */
function makeStreamPayloadBlob(
  blob: Blob,
  chunks: UsmChunkHeader[],
  fourcc: string,
  channel: number,
): { data: Blob; dataSize: number } {
  const parts: BlobPart[] = []
  let totalSize = 0
  for (const c of chunks) {
    if (c.fourcc !== fourcc) continue
    if (c.channel !== channel) continue
    if (c.dataType !== DataType.STREAM) continue
    parts.push(blob.slice(c.payloadStart, c.payloadEnd))
    totalSize += c.payloadEnd - c.payloadStart
  }
  return { data: new Blob(parts), dataSize: totalSize }
}

function identifyVideoCodec(rawId: number): VideoCodecInfo {
  switch (rawId) {
    case VideoCodecId.VP9:
      return { codec: "vp9", rawId }
    case VideoCodecId.H264:
      return { codec: "h264", rawId }
    case VideoCodecId.Mpeg:
      return { codec: "mpeg", rawId }
    default:
      return { codec: "unknown", rawId }
  }
}
