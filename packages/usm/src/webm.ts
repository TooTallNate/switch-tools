/**
 * Minimal WebM/Matroska muxer for VP9 video. Takes a sequence
 * of pre-encoded VP9 frames (which is exactly what USM gives us
 * after IVF demux) and produces a WebM Blob that browsers play
 * natively in `<video>` elements — including seeking, fullscreen,
 * picture-in-picture, etc., for free.
 *
 * Why we need this: USM ships VP9 inside an IVF container,
 * which `<video>` doesn't accept. The video bitstream itself is
 * unmodified; we just rewrap it in EBML / Matroska.
 *
 * Audio is intentionally not supported here — USM audio is HCA
 * which browsers can't play either, and we don't have an HCA
 * decoder yet. The viewer can play HCA samples through a
 * separate `<audio>` element synced manually once we add an HCA
 * decoder package.
 *
 * ## Format primer
 *
 * Matroska is an EBML (Extensible Binary Meta Language) document.
 * Every element is `<id><size><payload>` where `id` and `size`
 * are variable-length integers (VINTs).
 *
 * VINT encoding: the high bit position of the first byte tells
 * you how many bytes the VINT occupies. `0x80...` = 1 byte,
 * `0x40...` = 2 bytes, `0x20...` = 3 bytes, etc. The "marker"
 * bit doesn't count toward the value — so the 1-byte VINT for
 * 5 is `0x85` (= 0x80 | 5).
 *
 * Element IDs are also VINTs but the marker bit IS conventionally
 * preserved as part of the ID for matching. So we just embed
 * them as fixed byte sequences.
 *
 * The top-level structure for a video-only WebM is:
 *
 *   EBML header (says "this is a Matroska v4 / WebM doc")
 *   Segment (master, "unknown size" sentinel so we don't have
 *            to compute the total length up front)
 *     SeekHead (3 entries: Info, Tracks, Cues — gives the
 *               browser fast random access on open)
 *     Info (TimestampScale = 1 000 000 ns/tick = 1ms; Duration)
 *     Tracks
 *       TrackEntry (VP9 video, width/height, default frame
 *                   duration in ns)
 *     Cluster ×N (one per ~1 second of frames)
 *       Timestamp
 *       SimpleBlock ×F (per-frame container with track number,
 *                       relative timestamp, keyframe flag)
 *     Cues (keyframe → cluster offset; one entry per keyframe)
 *
 * ## Cluster boundaries
 *
 * Browsers seek by rewinding to the closest preceding keyframe.
 * If we put every keyframe at the start of a cluster, seek
 * latency is bounded by the cluster size. Mario RPG's clip has
 * a keyframe every ~120 frames (= 2 s @ 60 fps), so we just
 * start a new cluster on every keyframe — clusters then end up
 * ~1-2 s of video each. Maximum cluster size in WebM spec is
 * 32768 ms relative timestamp; we never approach that.
 */

const ENC = new TextEncoder()

// ----- EBML element IDs (raw byte sequences, marker bit intact) -----

const ID_EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
const ID_EBML_VERSION = new Uint8Array([0x42, 0x86])
const ID_EBML_READ_VERSION = new Uint8Array([0x42, 0xf7])
const ID_EBML_MAX_ID_LENGTH = new Uint8Array([0x42, 0xf2])
const ID_EBML_MAX_SIZE_LENGTH = new Uint8Array([0x42, 0xf3])
const ID_DOC_TYPE = new Uint8Array([0x42, 0x82])
const ID_DOC_TYPE_VERSION = new Uint8Array([0x42, 0x87])
const ID_DOC_TYPE_READ_VERSION = new Uint8Array([0x42, 0x85])

const ID_SEGMENT = new Uint8Array([0x18, 0x53, 0x80, 0x67])
const ID_SEEK_HEAD = new Uint8Array([0x11, 0x4d, 0x9b, 0x74])
const ID_SEEK = new Uint8Array([0x4d, 0xbb])
const ID_SEEK_ID = new Uint8Array([0x53, 0xab])
const ID_SEEK_POSITION = new Uint8Array([0x53, 0xac])
const ID_VOID = new Uint8Array([0xec])

const ID_INFO = new Uint8Array([0x15, 0x49, 0xa9, 0x66])
const ID_TIMESTAMP_SCALE = new Uint8Array([0x2a, 0xd7, 0xb1])
const ID_DURATION = new Uint8Array([0x44, 0x89])
const ID_MUXING_APP = new Uint8Array([0x4d, 0x80])
const ID_WRITING_APP = new Uint8Array([0x57, 0x41])

const ID_TRACKS = new Uint8Array([0x16, 0x54, 0xae, 0x6b])
const ID_TRACK_ENTRY = new Uint8Array([0xae])
const ID_TRACK_NUMBER = new Uint8Array([0xd7])
const ID_TRACK_UID = new Uint8Array([0x73, 0xc5])
const ID_TRACK_TYPE = new Uint8Array([0x83])
const ID_FLAG_LACING = new Uint8Array([0x9c])
const ID_DEFAULT_DURATION = new Uint8Array([0x23, 0xe3, 0x83])
const ID_CODEC_ID = new Uint8Array([0x86])
const ID_VIDEO = new Uint8Array([0xe0])
const ID_PIXEL_WIDTH = new Uint8Array([0xb0])
const ID_PIXEL_HEIGHT = new Uint8Array([0xba])

const ID_CLUSTER = new Uint8Array([0x1f, 0x43, 0xb6, 0x75])
const ID_TIMESTAMP = new Uint8Array([0xe7])
const ID_SIMPLE_BLOCK = new Uint8Array([0xa3])

const ID_CUES = new Uint8Array([0x1c, 0x53, 0xbb, 0x6b])
const ID_CUE_POINT = new Uint8Array([0xbb])
const ID_CUE_TIME = new Uint8Array([0xb3])
const ID_CUE_TRACK_POSITIONS = new Uint8Array([0xb7])
const ID_CUE_TRACK = new Uint8Array([0xf7])
const ID_CUE_CLUSTER_POSITION = new Uint8Array([0xf1])

/** Track type codes per Matroska spec. We only need video. */
const TRACK_TYPE_VIDEO = 1

/**
 * Encode an unsigned integer as a VINT (variable-length integer).
 * Used for element sizes, where the marker bit indicates how
 * many bytes to read.
 *
 * The marker bit is the first 1-bit in the result. So `0x80...`
 * = 1 byte (7 data bits), `0x40...` = 2 bytes (14 data bits), etc.
 *
 * For `value === undefined` we emit the "unknown size" sentinel
 * (`0xFF`) — useful for the top-level Segment where we don't
 * know the final total length until we're done writing.
 */
function vint(value: number | bigint | undefined): Uint8Array {
  if (value === undefined) {
    // 1-byte VINT with all-1 data bits = "unknown size" sentinel.
    return new Uint8Array([0xff])
  }
  const v = typeof value === "bigint" ? value : BigInt(value)
  // Pick the smallest byte length that fits. Each length L
  // gives 7L data bits (VINT marker eats one bit).
  for (let len = 1; len <= 8; len++) {
    const max = (1n << BigInt(7 * len)) - 1n
    if (v < max) {
      const out = new Uint8Array(len)
      const marker = 1n << BigInt(7 * len) // top bit of length-L VINT
      const combined = marker | v
      for (let i = 0; i < len; i++) {
        out[len - 1 - i] = Number((combined >> BigInt(8 * i)) & 0xffn)
      }
      return out
    }
  }
  throw new Error(`vint: value ${v} doesn't fit in 8 bytes`)
}

/** Encode an unsigned integer in the smallest big-endian byte
 *  string that holds it. Matroska's `u` type allows any width
 *  from 1 to 8 bytes; we always pick the smallest. */
function uintBytes(value: number | bigint): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value)
  if (v < 0n) throw new Error(`uintBytes: negative value ${v}`)
  // Pick smallest byte count.
  let len = 1
  while (len < 8 && (1n << BigInt(8 * len)) <= v) len++
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    out[len - 1 - i] = Number((v >> BigInt(8 * i)) & 0xffn)
  }
  return out
}

/** Encode an IEEE-754 64-bit float in big-endian. */
function f64Bytes(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setFloat64(0, value, false)
  return out
}

/** Concatenate a list of Uint8Arrays into one. */
function concat(parts: ArrayLike<Uint8Array>): Uint8Array {
  let total = 0
  for (let i = 0; i < parts.length; i++) total += parts[i]!.length
  const out = new Uint8Array(total)
  let off = 0
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i]!, off)
    off += parts[i]!.length
  }
  return out
}

/**
 * Build an EBML element: `<id><vintSize><payload>`. Used for
 * everything except the Segment master (whose size we mark as
 * unknown — see {@link master}).
 */
function elem(id: Uint8Array, payload: Uint8Array): Uint8Array {
  return concat([id, vint(payload.length), payload])
}

/** Master element (container of children) — same as `elem` but
 *  named differently in code for clarity. */
function master(id: Uint8Array, children: Uint8Array[]): Uint8Array {
  return elem(id, concat(children))
}

/** Master with "unknown size" — used for Segment. The VINT is
 *  `0xFF` (a length-1 VINT with all-ones data bits), telling
 *  parsers to read until end-of-stream. */
function unboundedMaster(id: Uint8Array, children: Uint8Array[]): Uint8Array {
  const payload = concat(children)
  return concat([id, vint(undefined), payload])
}

/** Convenience: build a `<id, vintSize, uintBigEndian>` element. */
function uintElem(id: Uint8Array, value: number | bigint): Uint8Array {
  return elem(id, uintBytes(value))
}

/** Convenience: build a `<id, vintSize, f64BigEndian>` element. */
function floatElem(id: Uint8Array, value: number): Uint8Array {
  return elem(id, f64Bytes(value))
}

/** Convenience: build a `<id, vintSize, ascii>` element. */
function strElem(id: Uint8Array, value: string): Uint8Array {
  return elem(id, ENC.encode(value))
}

// ----- public API -----

/**
 * One frame to mux into the output WebM. `timestampMs` is the
 * frame's presentation time in milliseconds from the start of
 * the stream.
 */
export interface WebmFrame {
  data: Uint8Array
  timestampMs: number
  /** True iff this frame can be decoded without reference to others. */
  isKeyframe: boolean
}

export interface WebmMuxOptions {
  width: number
  height: number
  /**
   * Default frame duration in milliseconds. Optional — the
   * output is valid without it, but supplying it lets seekers
   * snap to frames precisely.
   */
  frameDurationMs?: number
  /**
   * Total stream duration in milliseconds. Optional but
   * recommended; without it browsers show "Live" / "0:00" for
   * the total time and seeking is rougher.
   */
  durationMs?: number
}

/**
 * Mux a sequence of VP9 frames into a WebM document.
 *
 * Frames are clustered: every keyframe starts a new cluster,
 * which makes seeking clean — the browser rewinds to the
 * cluster start on a Cue hit, which IS a keyframe, and the
 * decoder can resume from there without prior state.
 *
 * Returns a `Uint8Array` containing the complete WebM file.
 * Wrap it in a `Blob` of MIME type `video/webm` to feed to a
 * `<video>` element via `URL.createObjectURL`.
 */
export function muxVp9Webm(
  frames: WebmFrame[],
  options: WebmMuxOptions,
): Uint8Array {
  const { width, height, frameDurationMs, durationMs } = options
  // ---- EBML header ----
  const ebmlHeader = master(ID_EBML, [
    uintElem(ID_EBML_VERSION, 1),
    uintElem(ID_EBML_READ_VERSION, 1),
    uintElem(ID_EBML_MAX_ID_LENGTH, 4),
    uintElem(ID_EBML_MAX_SIZE_LENGTH, 8),
    strElem(ID_DOC_TYPE, "webm"),
    uintElem(ID_DOC_TYPE_VERSION, 4),
    uintElem(ID_DOC_TYPE_READ_VERSION, 2),
  ])

  // ---- Info ----
  // TimestampScale = 1 000 000 ns = 1 ms — that means our
  // cluster + block timestamps are already in ms with no
  // conversion. Anywhere we emit a timestamp throughout the
  // file it's "this many ms since the start of the segment".
  const infoChildren: Uint8Array[] = [
    uintElem(ID_TIMESTAMP_SCALE, 1_000_000),
    strElem(ID_MUXING_APP, "@tootallnate/usm"),
    strElem(ID_WRITING_APP, "@tootallnate/usm"),
  ]
  if (durationMs !== undefined) {
    infoChildren.splice(1, 0, floatElem(ID_DURATION, durationMs))
  }
  const info = master(ID_INFO, infoChildren)

  // ---- Tracks ----
  const trackVideoChildren: Uint8Array[] = [
    uintElem(ID_PIXEL_WIDTH, width),
    uintElem(ID_PIXEL_HEIGHT, height),
  ]
  const trackEntryChildren: Uint8Array[] = [
    uintElem(ID_TRACK_NUMBER, 1),
    uintElem(ID_TRACK_UID, 1),
    // Lacing packs multiple short audio frames into one Block;
    // we don't need it for video.
    uintElem(ID_FLAG_LACING, 0),
    strElem(ID_CODEC_ID, "V_VP9"),
    uintElem(ID_TRACK_TYPE, TRACK_TYPE_VIDEO),
    master(ID_VIDEO, trackVideoChildren),
  ]
  if (frameDurationMs !== undefined) {
    trackEntryChildren.splice(
      3,
      0,
      uintElem(ID_DEFAULT_DURATION, Math.round(frameDurationMs * 1_000_000)),
    )
  }
  const tracks = master(ID_TRACKS, [master(ID_TRACK_ENTRY, trackEntryChildren)])

  // ---- Clusters + Cues ----
  // Build clusters first. We track each cluster's offset within
  // the Segment (= byte offset relative to the byte right after
  // the Segment's ID + size header) so the Cues table can point
  // at them. Matroska's `CueClusterPosition` is segment-relative,
  // not absolute, which keeps the mux output relocatable.
  interface CueEntry {
    timestampMs: number
    /** Segment-relative byte offset of the Cluster's ID. */
    clusterPosition: number
  }
  const cueEntries: CueEntry[] = []
  const clusterBlobs: Uint8Array[] = []
  let segmentPos = 0 // running byte counter inside the Segment payload
  // The Segment payload begins with SeekHead, Info, Tracks,
  // then the clusters. We'll fill in the size of those
  // pre-cluster sections after we know the SeekHead size; for
  // now estimate to leave room and patch up offsets at the end.
  // Concretely we fix this by computing pre-cluster size first,
  // then offsetting each cue's clusterPosition by it.

  // Group frames into clusters. New cluster on each keyframe.
  // First frame must be a keyframe in any well-formed VP9 stream;
  // if it isn't, we'll force-mark it.
  let i = 0
  while (i < frames.length) {
    const clusterStart = i
    const baseTs = frames[clusterStart]!.timestampMs
    // Find the next keyframe (start of the next cluster).
    let j = clusterStart + 1
    while (j < frames.length && !frames[j]!.isKeyframe) j++

    // Build SimpleBlocks for [clusterStart, j).
    const blocks: Uint8Array[] = []
    for (let k = clusterStart; k < j; k++) {
      const f = frames[k]!
      // SimpleBlock payload = [vintTrackNum(1)] [s16BE relTs] [u8 flags] [data]
      const relTs = f.timestampMs - baseTs
      // s16BE in [-32768, 32767]. If a single cluster ever spans
      // > 32 s of frames at our scale we'd overflow — guard.
      if (relTs < -32768 || relTs > 32767) {
        throw new Error(
          `WebM mux: SimpleBlock relative timestamp ${relTs} ms out of range; cluster too long`,
        )
      }
      const flags =
        // bit 7: keyframe (only meaningful on SimpleBlock).
        // bit 0: discardable (we don't use).
        (f.isKeyframe || k === clusterStart ? 0x80 : 0x00) |
        // bit 3: invisible (we don't use).
        // lacing: 00 = no lacing, our default.
        0x00
      const payload = new Uint8Array(1 + 2 + 1 + f.data.length)
      // Track number 1 as 1-byte VINT = 0x81.
      payload[0] = 0x81
      payload[1] = (relTs >> 8) & 0xff
      payload[2] = relTs & 0xff
      payload[3] = flags
      payload.set(f.data, 4)
      blocks.push(elem(ID_SIMPLE_BLOCK, payload))
    }

    const cluster = master(ID_CLUSTER, [
      uintElem(ID_TIMESTAMP, baseTs),
      ...blocks,
    ])
    // Cue points must reference keyframes. Every cluster we emit
    // begins with a keyframe by construction, so add one.
    cueEntries.push({
      timestampMs: baseTs,
      clusterPosition: segmentPos, // patched below
    })
    clusterBlobs.push(cluster)
    segmentPos += cluster.length
    i = j
  }

  // ---- Cues ----
  // Pre-build with placeholder cluster positions; patch them
  // once we know the size of SeekHead + Info + Tracks.
  const buildCues = (clusterBaseOffset: number) =>
    master(
      ID_CUES,
      cueEntries.map((c) =>
        master(ID_CUE_POINT, [
          uintElem(ID_CUE_TIME, c.timestampMs),
          master(ID_CUE_TRACK_POSITIONS, [
            uintElem(ID_CUE_TRACK, 1),
            uintElem(
              ID_CUE_CLUSTER_POSITION,
              c.clusterPosition + clusterBaseOffset,
            ),
          ]),
        ]),
      ),
    )

  // ---- SeekHead ----
  // Build with placeholder positions, then patch. SeekHead points
  // at Info, Tracks, and Cues (by their segment-relative byte
  // offset). The browser uses these to jump to the metadata
  // tables without having to scan from the top.
  const buildSeekHead = (positions: {
    info: number
    tracks: number
    cues: number
  }) =>
    master(ID_SEEK_HEAD, [
      master(ID_SEEK, [
        elem(ID_SEEK_ID, ID_INFO),
        uintElem(ID_SEEK_POSITION, positions.info),
      ]),
      master(ID_SEEK, [
        elem(ID_SEEK_ID, ID_TRACKS),
        uintElem(ID_SEEK_POSITION, positions.tracks),
      ]),
      master(ID_SEEK, [
        elem(ID_SEEK_ID, ID_CUES),
        uintElem(ID_SEEK_POSITION, positions.cues),
      ]),
    ])

  // Two-pass sizing: build a SeekHead with worst-case (8-byte)
  // position values to lock in its size, then build the real
  // one with actual positions — same length thanks to padding
  // via Void if needed.
  // Simpler approach: build with rough positions, observe size,
  // recompute positions, build final.
  let seekHead = buildSeekHead({ info: 0, tracks: 0, cues: 0 })
  let infoPos = seekHead.length
  let tracksPos = infoPos + info.length
  let cuesPos = tracksPos + tracks.length + segmentPos
  // segmentPos accumulated all clusters' total size above —
  // confusingly it's now the offset of Cues from the start of
  // the cluster region. Add tracksPos to make it segment-relative.
  seekHead = buildSeekHead({ info: infoPos, tracks: tracksPos, cues: cuesPos })
  // Re-check positions; re-build until stable. In practice one
  // re-pass is enough because uintBytes packs the new positions
  // tight and the only growth is when a position rolls past a
  // power-of-256 threshold.
  for (let pass = 0; pass < 4; pass++) {
    infoPos = seekHead.length
    tracksPos = infoPos + info.length
    const clustersStart = tracksPos + tracks.length
    cuesPos = clustersStart + segmentPos
    const fresh = buildSeekHead({ info: infoPos, tracks: tracksPos, cues: cuesPos })
    if (fresh.length === seekHead.length) {
      seekHead = fresh
      break
    }
    seekHead = fresh
  }

  // Patch cue cluster positions to be segment-relative.
  const clustersStart = seekHead.length + info.length + tracks.length
  const cues = buildCues(clustersStart)

  // ---- Final assembly ----
  const segmentChildren: Uint8Array[] = [
    seekHead,
    info,
    tracks,
    ...clusterBlobs,
    cues,
  ]
  const segment = unboundedMaster(ID_SEGMENT, segmentChildren)

  return concat([ebmlHeader, segment])
}

/**
 * Build a `Blob` of MIME type `video/webm` from muxer output.
 * Convenience wrapper for the common case.
 */
export function muxVp9WebmBlob(
  frames: WebmFrame[],
  options: WebmMuxOptions,
): Blob {
  return new Blob([muxVp9Webm(frames, options) as BlobPart], {
    type: "video/webm",
  })
}
