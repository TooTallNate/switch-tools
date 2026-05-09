// Texture decoding helpers (deswizzle + format → RGBA8) live in
// a separate file. Re-export at the top so callers get one
// import surface.
export {
  decodeUnityTexture2D,
  TextureFormatName,
  type DecodedTexture,
} from "./texture.js"

/**
 * Parser for Unity SerializedFile assets. A SerializedFile is
 * the on-disk representation of one Unity scene's worth of
 * assets — typically named `CAB-<hash>` and packed inside a
 * `UnityFS` bundle (see `@tootallnate/lib/unityfs`).
 *
 * The format is documented across AssetStudio (C#) and UnityPy
 * (Python). It's a binary format with a small fixed header, a
 * variable-length types table, an object table, and per-object
 * payloads that are deserialised against either a hardcoded
 * schema (when the bundle ships *without* TypeTree) or a
 * TypeTree blob inside the bundle itself (modern shipping
 * default in Unity 5.x+).
 *
 * This parser focuses on the TypeTree-enabled path because:
 *
 *   - It generalises over Unity versions (the TypeTree IS the
 *     schema, so we don't have to maintain hardcoded layouts
 *     per Unity release).
 *   - Modern shipping bundles (Unity 2019+) keep TypeTree on
 *     by default for safer asset reuse and to support
 *     differential updates.
 *
 * If you hit a bundle with TypeTree stripped out we surface
 * the object's raw bytes plus its class id so callers can fall
 * back to format-specific decoding (or just skip it).
 *
 * Endianness: the SerializedFile header itself is BIG-endian
 * for the legacy `metadataSize` / `fileSize` / `version` /
 * `dataOffset` words at offsets 0x00–0x0F. From offset 0x14
 * onward (post-version-22 layout) we switch to little-endian.
 * Object payloads inside the data section are little-endian on
 * everything but PowerPC consoles. We don't bother with the
 * BE-payload path — Switch / mobile / PC are all LE.
 */

const TEXT = new TextDecoder()

// ----- Types we care about at the surface level -----

/**
 * Unity's stable class IDs (from `UnityEngine.ClassIDReference`).
 * We list the handful that show up in shipping AssetBundles
 * frequently; everything else is surfaced via `classId` for
 * callers to recognise.
 */
export const ClassId = {
  GameObject: 1,
  Transform: 4,
  Material: 21,
  Texture2D: 28,
  Shader: 48,
  TextAsset: 49,
  Mesh: 43,
  Cubemap: 89,
  Avatar: 90,
  AnimationClip: 74,
  AudioClip: 83,
  Sprite: 213,
  AssetBundle: 142,
  AnimatorController: 91,
  ScriptableObject: 114, // alias of MonoBehaviour
  MonoBehaviour: 114,
  MonoScript: 115,
  RuntimeAnimatorController: 91,
  Font: 128,
  GUIStyle: 145,
  GUISkin: 146,
} as const

/**
 * Texture format codes from `UnityEngine.TextureFormat`. Values are
 * the on-disk numeric codes Unity ships in `m_TextureFormat`, taken
 * verbatim from the Unity 2021 enum so the round-trip is exact.
 *
 * Not all formats in this table have a decoder in `texture.ts` —
 * the table is a complete vocabulary; `describeFormat` is the
 * subset we know how to expand to RGBA8.
 */
export const TextureFormat = {
  // ----- Uncompressed -----
  Alpha8: 1,
  ARGB4444: 2,
  RGB24: 3,
  RGBA32: 4,
  ARGB32: 5,
  RGB565: 7,
  R16: 9, // 16-bit unsigned single channel (raw)
  RGBA4444: 13,
  BGRA32: 14,
  RHalf: 15,
  RGHalf: 16,
  RGBAHalf: 17,
  RFloat: 18,
  RGFloat: 19,
  RGBAFloat: 20,
  YUY2: 21,
  RGB9e5Float: 22,
  RG16: 62,
  R8: 63,
  // ----- Desktop block-compressed (DXT / BC family) -----
  DXT1: 10,
  DXT5: 12,
  BC6H: 24,
  BC7: 25,
  BC4: 26,
  BC5: 27,
  DXT1Crunched: 28,
  DXT5Crunched: 29,
  // ----- Mobile / iOS PowerVR -----
  PVRTC_RGB2: 30,
  PVRTC_RGBA2: 31,
  PVRTC_RGB4: 32,
  PVRTC_RGBA4: 33,
  // ----- Mobile / Android ETC + ATC -----
  ETC_RGB4: 34,
  ATC_RGB4: 35,
  ATC_RGBA8: 36,
  EAC_R: 41,
  EAC_R_SIGNED: 42,
  EAC_RG: 43,
  EAC_RG_SIGNED: 44,
  ETC2_RGB: 45,
  ETC2_RGBA1: 46,
  ETC2_RGBA8: 47,
  // ----- ASTC LDR (Switch / mobile / desktop) -----
  ASTC_RGB_4x4: 48,
  ASTC_RGB_5x5: 49,
  ASTC_RGB_6x6: 50,
  ASTC_RGB_8x8: 51,
  ASTC_RGB_10x10: 52,
  ASTC_RGB_12x12: 53,
  ASTC_RGBA_4x4: 54,
  ASTC_RGBA_5x5: 55,
  ASTC_RGBA_6x6: 56,
  ASTC_RGBA_8x8: 57,
  ASTC_RGBA_10x10: 58,
  ASTC_RGBA_12x12: 59,
  ETC_RGB4_3DS: 60,
  ETC_RGBA8_3DS: 61,
} as const

// ----- header / metadata structures -----

export interface SerializedFileHeader {
  metadataSize: number
  fileSize: number
  /** Format version (22 for Unity 2020+, 21 for earlier). */
  version: number
  dataOffset: number
  /** 0 = LE payload, 1 = BE payload. We only support LE. */
  endianness: number
  /** Unity engine version string, e.g. "2021.3.15f1". */
  unityVersion: string
  /** Build-target platform code (38 = StandaloneLinux64, 27 = Switch, …). */
  platform: number
  /** Whether the file ships TypeTree blobs for each type. */
  enableTypeTree: boolean
}

/**
 * One node of a TypeTree: name, type, byte size, alignment
 * requirement, and nested children. The deserialiser walks this
 * recursively to interpret an object's payload.
 */
export interface TypeTreeNode {
  type: string
  name: string
  /** Byte size of the field's serialised form (`-1` for variable-length). */
  byteSize: number
  /** Tree depth (0 = top-level field). */
  level: number
  /** Bit-flags. We care about `0x4000` = align-to-4 after this field. */
  metaFlag: number
  children: TypeTreeNode[]
}

/**
 * A type-table entry. `classId` is the Unity class ID; for
 * `MonoBehaviour` (114) the `scriptId` further identifies the
 * concrete C# class.
 */
export interface SerializedType {
  classId: number
  isStripped: boolean
  scriptTypeIndex: number
  scriptHash: Uint8Array | null
  typeHash: Uint8Array
  typeTree: TypeTreeNode | null
}

/**
 * One object entry in the SerializedFile. `pathId` uniquely
 * identifies the object within its file; `data` is a Blob
 * window over the object's serialised bytes (still raw — call
 * `parseObject` to deserialise against the type tree).
 */
export interface SerializedObject {
  pathId: bigint
  /** Index into `parsedFile.types`. */
  typeIndex: number
  data: Blob
  size: number
  classId: number
}

/** Reference to an external `.resS` resource file. */
export interface ExternalReference {
  /** Filename as stored — e.g. `archive:/CAB-…/CAB-….resS`. */
  pathName: string
  /** Bundle-relative basename used to look up the resource Blob. */
  basename: string
  /** Filesystem-like type tag, usually 0. */
  type: number
  /** GUID, when the source is a Unity asset reference. */
  guid: Uint8Array
}

export interface ParsedSerializedFile {
  header: SerializedFileHeader
  types: SerializedType[]
  objects: SerializedObject[]
  /** `.resS` and other companion files this asset depends on. */
  externals: ExternalReference[]
}

// ----- low-level reader -----

class Reader {
  private view: DataView
  pos = 0
  /** True iff we should read multi-byte ints little-endian. */
  readonly littleEndian: boolean
  constructor(public buf: Uint8Array, littleEndian: boolean) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.littleEndian = littleEndian
  }
  u8() {
    return this.view.getUint8(this.pos++)
  }
  i8() {
    return this.view.getInt8(this.pos++)
  }
  u16(le?: boolean) {
    const v = this.view.getUint16(this.pos, le ?? this.littleEndian)
    this.pos += 2
    return v
  }
  i16(le?: boolean) {
    const v = this.view.getInt16(this.pos, le ?? this.littleEndian)
    this.pos += 2
    return v
  }
  u32(le?: boolean) {
    const v = this.view.getUint32(this.pos, le ?? this.littleEndian)
    this.pos += 4
    return v
  }
  i32(le?: boolean) {
    const v = this.view.getInt32(this.pos, le ?? this.littleEndian)
    this.pos += 4
    return v
  }
  u64(le?: boolean) {
    const v = this.view.getBigUint64(this.pos, le ?? this.littleEndian)
    this.pos += 8
    return v
  }
  i64(le?: boolean) {
    const v = this.view.getBigInt64(this.pos, le ?? this.littleEndian)
    this.pos += 8
    return v
  }
  f32(le?: boolean) {
    const v = this.view.getFloat32(this.pos, le ?? this.littleEndian)
    this.pos += 4
    return v
  }
  f64(le?: boolean) {
    const v = this.view.getFloat64(this.pos, le ?? this.littleEndian)
    this.pos += 8
    return v
  }
  bytes(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  /** NUL-terminated ASCII string (header fields use this). */
  cstring(): string {
    let end = this.pos
    while (end < this.buf.length && this.buf[end] !== 0) end++
    const s = TEXT.decode(this.buf.subarray(this.pos, end))
    this.pos = end < this.buf.length ? end + 1 : end
    return s
  }
  /** Length-prefixed (LE u32) string used inside type-tree blobs and elsewhere. */
  alignedString(): string {
    const len = this.u32(true)
    const s = TEXT.decode(this.buf.subarray(this.pos, this.pos + len))
    this.pos += len
    this.align(4)
    return s
  }
  /** Round `pos` up to the next multiple of `n`. */
  align(n: number) {
    const rem = this.pos % n
    if (rem !== 0) this.pos += n - rem
  }
}

// ----- the parser proper -----

/**
 * Parse a Unity SerializedFile from raw bytes. The result
 * keeps the original buffer alive (via `Blob` slices on the
 * objects' `data`) so subsequent `parseObject` calls don't
 * have to re-read the source.
 *
 * Pass an optional resolver that maps an external resource
 * filename (e.g. `archive:/CAB-…/CAB-….resS`) to the matching
 * Blob. If you don't, the parser still works but Texture2D /
 * AudioClip references with `m_StreamData` won't be readable.
 */
export async function parseSerializedFile(
  blob: Blob,
): Promise<ParsedSerializedFile> {
  // Pull in the whole asset — these are typically tens to
  // hundreds of KB; not worth being lazy about.
  const buf = new Uint8Array(await blob.arrayBuffer())
  // Header up to 0x14 is BIG-endian; the rest depends on the
  // `endianness` byte at +0x10. We always start BE.
  const r = new Reader(buf, false)

  // Pre-v22 fields (still present in v22+ but ignored there).
  const _legacyMetadataSize = r.u32()
  const _legacyFileSize = r.u32()
  const version = r.u32()
  const _legacyDataOffset = r.u32()
  const endianness = r.u8()
  r.bytes(3) // reserved

  const headerLittleEndian = endianness === 0
  if (!headerLittleEndian) {
    throw new Error(
      "SerializedFile: BE payload encoding not supported (this implementation only handles LE)",
    )
  }

  let metadataSize: number
  let fileSize: number
  let dataOffset: number
  if (version >= 22) {
    // The extension words at +0x14..+0x2C stay BIG-endian, just
    // like the legacy fields above them — only the *payload*
    // (object data, type-tree string buffers, etc.) flips to
    // whatever the `endianness` byte said.
    metadataSize = r.u32(false)
    fileSize = Number(r.u64(false))
    dataOffset = Number(r.u64(false))
    r.u64(false) // unknown reserved
  } else {
    metadataSize = _legacyMetadataSize
    fileSize = _legacyFileSize
    dataOffset = _legacyDataOffset
  }

  // From here on, payload reads are little-endian (we already
  // validated above). Switch the reader's default.
  const r2 = new Reader(buf, true)
  r2.pos = r.pos

  const unityVersion = r2.cstring()
  const platform = r2.u32()
  const enableTypeTree = r2.u8() !== 0

  // ---- types table ----
  const numTypes = r2.u32()
  const types: SerializedType[] = []
  for (let i = 0; i < numTypes; i++) {
    types.push(readType(r2, version, enableTypeTree))
  }

  // ---- object table ----
  // v22+ uses i64 path IDs and aligns the entry to 8 bytes.
  const numObjects = r2.u32()
  const objectStubs: { pathId: bigint; byteStart: number; byteSize: number; typeIndex: number }[] = []
  for (let i = 0; i < numObjects; i++) {
    if (version >= 14) r2.align(4)
    const pathId = r2.i64()
    let byteStart: number
    if (version >= 22) byteStart = Number(r2.u64())
    else byteStart = r2.u32()
    const byteSize = r2.u32()
    const typeIndex = r2.u32()
    objectStubs.push({ pathId, byteStart, byteSize, typeIndex })
  }

  // ---- script-types table (v11+) ----
  if (version >= 11) {
    const numScriptTypes = r2.u32()
    for (let i = 0; i < numScriptTypes; i++) {
      if (version >= 14) r2.align(4)
      r2.i32() // localSerializedFileIndex
      if (version < 14) r2.i32()
      else r2.i64() // localIdentifierInFile
    }
  }

  // ---- external references ----
  const numExternals = r2.u32()
  const externals: ExternalReference[] = []
  for (let i = 0; i < numExternals; i++) {
    if (version >= 6) r2.cstring() // tempEmpty
    let guid = new Uint8Array(0)
    let type = 0
    if (version >= 5) {
      guid = new Uint8Array(r2.bytes(16))
      type = r2.i32()
    }
    const pathName = r2.cstring()
    const basename = pathName.replace(/^archive:\/[^/]+\//, "")
    externals.push({ pathName, basename, type, guid })
  }

  // (RefTypes after externals in v20+; we skip — never seen in
  // practice for shipping AssetBundles.)

  // ---- materialise object data Blobs ----
  // Each object's `data` is a Blob.slice() of the original
  // input — `byteStart` is relative to `dataOffset`.
  const objects: SerializedObject[] = objectStubs.map((s) => {
    const startInFile = dataOffset + s.byteStart
    const endInFile = startInFile + s.byteSize
    const data = blob.slice(startInFile, endInFile)
    const ty = types[s.typeIndex]
    if (!ty) {
      throw new Error(
        `SerializedFile: object pathId=${s.pathId} references type index ${s.typeIndex} which doesn't exist (have ${types.length} types)`,
      )
    }
    return {
      pathId: s.pathId,
      typeIndex: s.typeIndex,
      data,
      size: s.byteSize,
      classId: ty.classId,
    }
  })

  return {
    header: {
      metadataSize,
      fileSize,
      version,
      dataOffset,
      endianness,
      unityVersion,
      platform,
      enableTypeTree,
    },
    types,
    objects,
    externals,
  }
}

function readType(
  r: Reader,
  version: number,
  enableTypeTree: boolean,
): SerializedType {
  const classId = r.i32()
  let isStripped = false
  let scriptTypeIndex = -1
  if (version >= 16) isStripped = r.u8() !== 0
  if (version >= 17) scriptTypeIndex = r.i16()

  let scriptHash: Uint8Array | null = null
  if (version >= 13) {
    if (
      (version < 16 && classId < 0) ||
      (version >= 16 && classId === 114 /* MonoBehaviour */)
    ) {
      scriptHash = new Uint8Array(r.bytes(16))
    }
  }
  const typeHash = new Uint8Array(r.bytes(16))

  let typeTree: TypeTreeNode | null = null
  if (enableTypeTree) {
    if (version >= 12) {
      typeTree = readTypeTreeBlob(r, version)
    } else {
      typeTree = readTypeTreeLegacy(r)
    }
    // v21+: type dependencies (a list of type indices we
    // depend on). Skip.
    if (version >= 21) {
      const numDeps = r.u32()
      for (let i = 0; i < numDeps; i++) r.u32()
    }
  }

  return { classId, isStripped, scriptTypeIndex, scriptHash, typeHash, typeTree }
}

/**
 * The "blob"-style TypeTree (v12+) is a flat array of node
 * descriptors followed by a string buffer. Each node has its
 * type / name fields encoded as offsets into either the string
 * buffer or a built-in CommonStrings dictionary. We assemble
 * the flat list back into a tree using the `level` field.
 */
function readTypeTreeBlob(r: Reader, version: number): TypeTreeNode {
  const numNodes = r.u32()
  const stringBufferSize = r.u32()
  // Per-node descriptor:
  //   u16 version
  //   u8 level
  //   u8 typeFlags
  //   u32 typeStrOffset
  //   u32 nameStrOffset
  //   i32 byteSize
  //   i32 index
  //   i32 metaFlag
  // For version >= 19: + u64 refTypeHash
  const nodeRecordSize = version >= 19 ? 32 : 24
  const nodeRecords = r.bytes(numNodes * nodeRecordSize)
  const stringBuffer = r.bytes(stringBufferSize)

  const flat: TypeTreeNode[] = []
  for (let i = 0; i < numNodes; i++) {
    const off = i * nodeRecordSize
    const v = new DataView(
      nodeRecords.buffer,
      nodeRecords.byteOffset + off,
      nodeRecordSize,
    )
    const level = v.getUint8(2)
    const typeStrOffset = v.getUint32(4, true)
    const nameStrOffset = v.getUint32(8, true)
    const byteSize = v.getInt32(12, true)
    const metaFlag = v.getInt32(20, true)
    const type = readTypeTreeString(typeStrOffset, stringBuffer)
    const name = readTypeTreeString(nameStrOffset, stringBuffer)
    flat.push({ type, name, byteSize, level, metaFlag, children: [] })
  }

  // Assemble tree: each node's parent is the most recent
  // preceding node with `level === current.level - 1`. If the
  // first node isn't level 0, the bundle is malformed.
  if (flat.length === 0 || flat[0]!.level !== 0) {
    throw new Error("TypeTree: empty or first node not level 0")
  }
  const stack: TypeTreeNode[] = [flat[0]!]
  for (let i = 1; i < flat.length; i++) {
    const node = flat[i]!
    while (stack.length > node.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (!parent) {
      throw new Error(
        `TypeTree: node ${i} (level ${node.level}) has no parent`,
      )
    }
    parent.children.push(node)
    stack.push(node)
  }
  return flat[0]!
}

/**
 * Lookup helper for blob-style TypeTree string offsets. The
 * top bit (`0x80000000`) flags a CommonStrings entry; otherwise
 * it's an offset into the local string buffer.
 *
 * The CommonStrings table is documented in AssetStudio's
 * `CommonString.cs`. We only include the ones that show up in
 * shipping bundles — anything we miss falls back to a `?`
 * placeholder rather than throwing, since unknown strings
 * don't typically affect parse-ability of the rest of the tree.
 */
function readTypeTreeString(offset: number, stringBuffer: Uint8Array): string {
  const COMMON_FLAG = 0x80000000
  if ((offset & COMMON_FLAG) !== 0) {
    const localOff = offset & ~COMMON_FLAG
    return COMMON_STRINGS.get(localOff) ?? `?cs[${localOff.toString(16)}]`
  }
  let end = offset
  while (end < stringBuffer.length && stringBuffer[end] !== 0) end++
  return TEXT.decode(stringBuffer.subarray(offset, end))
}

/**
 * Pre-v12 tree layout: nodes encoded recursively with explicit
 * type/name strings inline. Rare in shipping content but cheap
 * to keep around.
 */
function readTypeTreeLegacy(r: Reader): TypeTreeNode {
  const type = r.cstring()
  const name = r.cstring()
  const byteSize = r.i32()
  // u16 version, u8 isArray, i32 index, i32 typeFlags, i32 metaFlag, i32 numChildren
  r.u16()
  r.u8()
  r.i32()
  r.i32()
  const metaFlag = r.i32()
  const numChildren = r.i32()
  const children: TypeTreeNode[] = []
  for (let i = 0; i < numChildren; i++) {
    children.push(readTypeTreeLegacy(r))
  }
  return { type, name, byteSize, level: 0, metaFlag, children }
}

/**
 * AssetStudio's `CommonString` dictionary, mapping the offsets
 * that fall in the high-bit-set range of a TypeTree string
 * reference to their literal value. This is a baked-in
 * Unity-engine constant table; we copy the subset we've seen in
 * Switch / mobile / PC bundles.
 */
const COMMON_STRINGS = new Map<number, string>([
  [0, "AABB"],
  [5, "AnimationClip"],
  [19, "AnimationCurve"],
  [34, "AnimationState"],
  [49, "Array"],
  [55, "Base"],
  [60, "BitField"],
  [69, "bitset"],
  [76, "bool"],
  [81, "char"],
  [86, "ColorRGBA"],
  [96, "Component"],
  [106, "data"],
  [111, "deque"],
  [117, "double"],
  [124, "dynamic_array"],
  [138, "FastPropertyName"],
  [155, "first"],
  [161, "float"],
  [167, "Font"],
  [172, "GameObject"],
  [183, "Generic Mono"],
  [196, "GradientNEW"],
  [208, "GUID"],
  [213, "GUIStyle"],
  [222, "int"],
  [226, "list"],
  [231, "long long"],
  [241, "map"],
  [245, "Matrix4x4f"],
  [256, "MdFour"],
  [263, "MonoBehaviour"],
  [277, "MonoScript"],
  [288, "m_ByteSize"],
  [299, "m_Curve"],
  [307, "m_EditorClassIdentifier"],
  [331, "m_EditorHideFlags"],
  [349, "m_Enabled"],
  [359, "m_ExtensionPtr"],
  [374, "m_GameObject"],
  [387, "m_Index"],
  [395, "m_IsArray"],
  [405, "m_IsStatic"],
  [416, "m_MetaFlag"],
  [427, "m_Name"],
  [434, "m_ObjectHideFlags"],
  [452, "m_PrefabInternal"],
  [469, "m_PrefabParentObject"],
  [490, "m_Script"],
  [499, "m_StaticEditorFlags"],
  [519, "m_Type"],
  [526, "m_Version"],
  [536, "Object"],
  [543, "pair"],
  [548, "PPtr<Component>"],
  [564, "PPtr<GameObject>"],
  [581, "PPtr<Material>"],
  [596, "PPtr<MonoBehaviour>"],
  [616, "PPtr<MonoScript>"],
  [633, "PPtr<Object>"],
  [646, "PPtr<Prefab>"],
  [659, "PPtr<Sprite>"],
  [672, "PPtr<TextAsset>"],
  [688, "PPtr<Texture>"],
  [702, "PPtr<Texture2D>"],
  [718, "PPtr<Transform>"],
  [734, "Prefab"],
  [741, "Quaternionf"],
  [753, "Rectf"],
  [759, "RectInt"],
  [767, "RectOffset"],
  [778, "second"],
  [785, "set"],
  [789, "short"],
  [795, "size"],
  [800, "SInt16"],
  [807, "SInt32"],
  [814, "SInt64"],
  [821, "SInt8"],
  [827, "staticvector"],
  [840, "string"],
  [847, "TextAsset"],
  [857, "TextMesh"],
  [866, "Texture"],
  [874, "Texture2D"],
  [884, "Transform"],
  [894, "TypelessData"],
  [907, "UInt16"],
  [914, "UInt32"],
  [921, "UInt64"],
  [928, "UInt8"],
  [934, "unsigned int"],
  [947, "unsigned long long"],
  [966, "unsigned short"],
  [981, "vector"],
  [988, "Vector2f"],
  [997, "Vector3f"],
  [1006, "Vector4f"],
  [1015, "m_ScriptingClassIdentifier"],
  [1042, "Gradient"],
  [1051, "Type*"],
  [1057, "int2_storage"],
  [1070, "int3_storage"],
  [1083, "BoundsInt"],
  [1093, "m_CorrespondingSourceObject"],
  [1121, "m_PrefabInstance"],
  [1138, "m_PrefabAsset"],
  [1152, "FileSize"],
  [1161, "Hash128"],
])

// ----- TypeTree-driven object deserialiser -----

/**
 * Deserialise an object's payload bytes against its TypeTree.
 * Returns a JSON-shaped value (numbers / strings / booleans /
 * arrays / records). Binary blobs come back as `Uint8Array`.
 *
 * Caller is responsible for picking out the field they want.
 * For Texture2D you'd reach for `m_Width`, `m_Height`,
 * `m_TextureFormat`, `image data`, `m_StreamData`, etc.
 */
export async function parseObject(
  obj: SerializedObject,
  typeTree: TypeTreeNode,
): Promise<unknown> {
  const buf = new Uint8Array(await obj.data.arrayBuffer())
  const r = new Reader(buf, true)
  const value = readNode(r, typeTree)
  return value
}

/** "Align after read" flag in `metaFlag`. */
const META_ALIGN_BYTES = 0x4000

function readNode(r: Reader, node: TypeTreeNode): unknown {
  let value: unknown
  // First, dispatch on the type name. Primitive types short-
  // circuit; everything else recurses into children.
  switch (node.type) {
    case "bool":
      value = r.u8() !== 0
      break
    case "SInt8": case "char": value = r.i8(); break
    case "UInt8": case "byte": case "unsigned char": value = r.u8(); break
    case "SInt16": case "short": value = r.i16(); break
    case "UInt16": case "unsigned short": value = r.u16(); break
    case "SInt32": case "int": case "Type*": value = r.i32(); break
    case "UInt32": case "unsigned int": value = r.u32(); break
    case "SInt64": case "long long": value = r.i64(); break
    case "UInt64": case "unsigned long long": case "FileSize": value = r.u64(); break
    case "float": value = r.f32(); break
    case "double": value = r.f64(); break
    case "string":
      // string is a struct: { Array { int size; Array<char> data } }.
      // Walk children to honour alignment, but pull out the bytes.
      value = readStringValue(r, node)
      break
    case "TypelessData":
      // Special quirk: `TypelessData` shows up in the TypeTree
      // with `int size` + `UInt8 data` as siblings rather than
      // wrapped in an Array node, but the underlying byte
      // layout IS `[i32 size] [size × u8]`. Walking the tree
      // as a generic struct reads only one byte for `data`,
      // which corrupts every subsequent field. Read it as a
      // length-prefixed blob instead.
      value = readTypelessData(r, node)
      break
    default:
      // Arrays in the TypeTree appear as a parent with one child
      // whose type is "Array" — that array's first child is
      // "int size", second child is the element template.
      if (
        node.children.length === 1 &&
        node.children[0]!.type === "Array"
      ) {
        value = readArray(r, node.children[0]!)
      } else if (node.children.length > 0) {
        value = readStruct(r, node)
      } else {
        // Atom we don't recognise — read by byteSize so we stay
        // synced. -1 byte size means we're stuck.
        if (node.byteSize > 0) value = r.bytes(node.byteSize)
        else
          throw new Error(
            `TypeTree: unknown atomic type "${node.type}" (no children, byteSize=${node.byteSize})`,
          )
      }
      break
  }
  if ((node.metaFlag & META_ALIGN_BYTES) !== 0) r.align(4)
  return value
}

function readStruct(r: Reader, node: TypeTreeNode): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const child of node.children) {
    out[child.name] = readNode(r, child)
  }
  return out
}

function readArray(
  r: Reader,
  arrayNode: TypeTreeNode,
): unknown[] | Uint8Array {
  // arrayNode.children = [size: int, data: T]
  if (arrayNode.children.length < 2) {
    throw new Error(
      `TypeTree: Array node has ${arrayNode.children.length} children (expected 2)`,
    )
  }
  const size = readNode(r, arrayNode.children[0]!) as number
  const elemNode = arrayNode.children[1]!
  // Common fast path: array of primitives we can slurp in one go.
  // Returns `Uint8Array` for byte-element arrays so that font /
  // shader / mesh blobs come back as compact binary instead of
  // millions of boxed numbers.
  const fast = fastBulkRead(r, elemNode, size)
  if (fast !== undefined) {
    if ((arrayNode.metaFlag & META_ALIGN_BYTES) !== 0) r.align(4)
    return fast
  }
  const out: unknown[] = []
  for (let i = 0; i < size; i++) out.push(readNode(r, elemNode))
  if ((arrayNode.metaFlag & META_ALIGN_BYTES) !== 0) r.align(4)
  return out
}

/**
 * If the array element is a primitive, pull all `count` elements
 * in one go via a typed-array view. Order-of-magnitude speedup on
 * big primitive arrays — texture pixels (often int) and embedded
 * font / shader / mesh blobs (often `vector<char>`).
 *
 * For byte-shaped element types (`UInt8` / `char` / `SInt8`) we
 * return a `Uint8Array` directly. This:
 *
 *   1. Avoids `Array.from(bytes)`'s O(N) per-element JS-object cost,
 *      which would balloon a 4 MB embedded font into 4 million heap
 *      slots when all we want is the raw blob.
 *   2. Means downstream consumers can `instanceof Uint8Array` to
 *      decide whether to treat the field as binary data (e.g.
 *      `Font.m_FontData`, which is a `vector<char>` in the modern
 *      Unity TypeTree but a `TypelessData` in older formats — both
 *      now collapse to the same shape).
 *
 * Wider-than-byte primitives still come back as a plain `unknown[]`
 * so that JSON-shaped consumers (the Unity-asset KV preview, e.g.)
 * can iterate them naturally.
 */
function fastBulkRead(
  r: Reader,
  elem: TypeTreeNode,
  count: number,
): unknown[] | Uint8Array | undefined {
  if (elem.children.length > 0) return undefined
  const bytes = r.bytes(count * elemSize(elem.type))
  switch (elem.type) {
    case "UInt8":
    case "byte":
    case "unsigned char":
    case "SInt8":
    case "char":
      // Copy out so callers can mutate / hold the slice without
      // pinning the whole SerializedFile buffer.
      return new Uint8Array(bytes)
    case "UInt16": case "unsigned short":
      return Array.from(new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 2)))
    case "SInt16": case "short":
      return Array.from(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 2)))
    case "UInt32": case "unsigned int":
      return Array.from(new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 4)))
    case "SInt32": case "int":
      return Array.from(new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 4)))
    case "float":
      return Array.from(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 4)))
    case "double":
      return Array.from(new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 8)))
    default:
      return undefined
  }
}

function elemSize(type: string): number {
  switch (type) {
    case "bool": case "UInt8": case "byte": case "unsigned char":
    case "SInt8": case "char":
      return 1
    case "UInt16": case "unsigned short": case "SInt16": case "short":
      return 2
    case "UInt32": case "unsigned int": case "SInt32": case "int":
    case "float":
      return 4
    case "UInt64": case "unsigned long long": case "SInt64":
    case "long long": case "double":
      return 8
    default:
      throw new Error(`elemSize: unknown primitive type "${type}"`)
  }
}

function readStringValue(r: Reader, node: TypeTreeNode): string {
  // Two children: Array { int size; Array<char> data }
  // Most encoders write the string as "size, then `size` bytes".
  if (node.children.length >= 1 && node.children[0]!.type === "Array") {
    const arr = node.children[0]!
    const size = readNode(r, arr.children[0]!) as number
    const bytes = r.bytes(size)
    if ((arr.metaFlag & META_ALIGN_BYTES) !== 0) r.align(4)
    if ((node.metaFlag & META_ALIGN_BYTES) !== 0) r.align(4)
    return TEXT.decode(bytes)
  }
  // Fallback: length-prefixed.
  return TEXT.decode(readBytesLengthPrefixed(r))
}

function readBytesLengthPrefixed(r: Reader): Uint8Array {
  const size = r.u32()
  const out = new Uint8Array(r.bytes(size))
  return out
}

/**
 * Read a `TypelessData` value as `{ size, data: Uint8Array }`.
 * The TypeTree describes `data` with a `byteSize=1` template
 * but the actual on-disk layout is one `int size` followed by
 * `size` bytes — so we have to short-circuit the generic
 * tree walker.
 */
function readTypelessData(
  r: Reader,
  node: TypeTreeNode,
): { size: number; data: Uint8Array } {
  const size = r.u32()
  const data = new Uint8Array(r.bytes(size))
  // TypelessData often carries an `align after` flag (0x4000)
  // on the `data` child specifically. We honour either the
  // parent's flag or the data child's flag.
  const dataChild = node.children.find((c) => c.name === "data")
  if (
    (node.metaFlag & META_ALIGN_BYTES) !== 0 ||
    (dataChild && (dataChild.metaFlag & META_ALIGN_BYTES) !== 0)
  ) {
    r.align(4)
  }
  return { size, data }
}
