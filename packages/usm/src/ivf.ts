/**
 * Minimal IVF demuxer. IVF is the small wrapper format CRI uses
 * inside USM's video stream — a 32-byte file header followed by
 * `[size, pts, frame data]` triples for each frame. Browsers
 * don't accept IVF in `<video>`, but we can pull the frames out
 * and re-wrap them into WebM ({@link muxVp9Webm}) which they
 * do accept.
 */

const TEXT = new TextDecoder()

export interface IvfHeader {
  /** 4-char codec fourcc (`VP90` for VP9, `AV01` for AV1, etc.). */
  codec: string
  width: number
  height: number
  /** Frame rate numerator. CRI tools typically emit `60000`. */
  fpsNum: number
  /** Frame rate denominator. CRI tools typically emit `1000`. */
  fpsDen: number
  totalFrames: number
}

export interface IvfFrame {
  /** PTS in IVF time-base ticks (= `fpsDen / fpsNum` seconds). */
  pts: bigint
  /** The raw codec bitstream sample. */
  data: Uint8Array
}

export interface DemuxedIvf {
  header: IvfHeader
  frames: IvfFrame[]
}

/**
 * Demux an IVF blob lazily. Reads the input in 4 MiB strides
 * via `Blob.slice()`, so we never have to hold the entire video
 * payload in RAM at once.
 *
 * IVF format:
 *
 *   File header (32 bytes, all little-endian unless noted):
 *     0x00  4  'DKIF' magic
 *     0x04  2  version (always 0)
 *     0x06  2  header size in bytes (always 32)
 *     0x08  4  codec fourcc, ASCII (e.g. `VP90`)
 *     0x0C  2  width
 *     0x0E  2  height
 *     0x10  4  framerate numerator
 *     0x14  4  framerate denominator
 *     0x18  4  total frame count
 *     0x1C  4  reserved
 *
 *   Per-frame:
 *     0x00  4  frame size (data only, not including this header)
 *     0x04  8  pts (frame number for fixed-rate streams)
 *     0x0C  …  frame bytes
 *
 * USM authoring sometimes leaves `total frames` as zero;
 * the actual count is `frames.length` after demux.
 */
export async function demuxIvf(blob: Blob): Promise<DemuxedIvf> {
  const STRIDE = 4 * 1024 * 1024
  let bufferedStart = 0
  let buffered: Uint8Array = new Uint8Array(0)

  /** Make sure `[start, end)` is fully covered by `buffered`. */
  const ensureRange = async (start: number, end: number) => {
    if (start >= bufferedStart && end <= bufferedStart + buffered.length) return
    bufferedStart = start
    const stop = Math.min(blob.size, start + Math.max(STRIDE, end - start))
    buffered = new Uint8Array(await blob.slice(start, stop).arrayBuffer())
  }

  await ensureRange(0, 32)
  if (buffered.length < 32) throw new Error("IVF: truncated header")
  const fileView = new DataView(
    buffered.buffer,
    buffered.byteOffset,
    buffered.length,
  )
  const magic = TEXT.decode(buffered.subarray(0, 4))
  if (magic !== "DKIF") throw new Error(`IVF: bad magic "${magic}"`)
  const headerSize = fileView.getUint16(6, true)
  const codec = TEXT.decode(buffered.subarray(8, 12))
  const width = fileView.getUint16(12, true)
  const height = fileView.getUint16(14, true)
  const fpsNum = fileView.getUint32(16, true)
  const fpsDen = fileView.getUint32(20, true)
  const totalFrames = fileView.getUint32(24, true)
  const header: IvfHeader = { codec, width, height, fpsNum, fpsDen, totalFrames }

  const frames: IvfFrame[] = []
  let off = headerSize
  while (off < blob.size) {
    await ensureRange(off, off + 12)
    if (off - bufferedStart + 12 > buffered.length) break
    const local = off - bufferedStart
    const sz = new DataView(
      buffered.buffer,
      buffered.byteOffset + local,
      12,
    ).getUint32(0, true)
    const pts = new DataView(
      buffered.buffer,
      buffered.byteOffset + local,
      12,
    ).getBigUint64(4, true)
    if (sz === 0 || sz > 1 << 28) {
      throw new Error(`IVF: implausible frame size ${sz} at offset ${off}`)
    }
    await ensureRange(off, off + 12 + sz)
    if (off - bufferedStart + 12 + sz > buffered.length) break
    const data = new Uint8Array(sz)
    data.set(
      buffered.subarray(off - bufferedStart + 12, off - bufferedStart + 12 + sz),
    )
    frames.push({ pts, data })
    off += 12 + sz
  }
  return { header, frames }
}

/**
 * Detect whether a VP9 frame is a keyframe by peeking at its
 * uncompressed header. Per the VP9 spec, byte 0 has:
 *
 *   bits 7-6: frame_marker (must be 10)
 *   bits 5-4: profile (low 2 bits)
 *   bit  3:   show_existing_frame
 *   bit  2:   frame_type (0 = keyframe, 1 = non-key)
 *
 * So the keyframe test is `(byte0 & 0x04) === 0`. Inexact for
 * Profile-2/3 and frames whose encoder set show_existing_frame,
 * but those don't appear in CRI's authored content.
 */
export function isVp9Keyframe(data: Uint8Array): boolean {
  if (data.length === 0) return false
  return (data[0]! & 0x04) === 0
}
