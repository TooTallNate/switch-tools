/**
 * Hardcoded Unity class layouts for SerializedFiles that ship
 * without TypeTrees.
 *
 * Release Unity builds frequently strip TypeTrees (`enableTypeTree:
 * false`) to save space, which means our generic
 * `parseObject(typeTree)` deserialiser can't work on them. The
 * on-disc layouts for the well-known engine-built-in classes
 * (Texture2D, AudioClip, Font, Mesh, Sprite, TextAsset,
 * MonoScript, …) are however **stable across all Unity versions
 * in a given range**, just with extra fields being added at known
 * positions in newer versions.
 *
 * This module encodes the field layout for each supported class
 * as a small DSL — a sequence of read steps annotated with
 * version gates — that the runtime walks against a `BinaryReader`
 * over the SerializedObject's bytes. The result is a plain JS
 * object that mirrors what `parseObject(typeTree)` would return
 * for the same Unity version, so consumers can use the same code
 * path (`decoded.value.m_Name`, `decoded.value.image data`, …)
 * regardless of which path produced the value.
 *
 * Layout references: AssetStudio's `Classes/*.cs` (MIT) and
 * UABE Avalonia's class definitions. Used as a documentation
 * source only; no code is lifted directly.
 */

/** Parsed Unity version components (e.g. {major:2018, minor:4, patch:36}). */
export interface UnityVersion {
	major: number;
	minor: number;
	patch: number;
	raw: string;
}

/**
 * Parse a Unity version string like `"2018.4.36f1"` into its
 * numeric components. Build-type suffix (`f1`, `b2`, `a1`) is
 * dropped — we only care about major/minor/patch for the layout
 * gates.
 *
 * Returns a zeroed version when the string can't be parsed so
 * callers don't have to null-check.
 */
export function parseUnityVersion(s: string): UnityVersion {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
	if (!m) return { major: 0, minor: 0, patch: 0, raw: s };
	return {
		major: parseInt(m[1]!, 10),
		minor: parseInt(m[2]!, 10),
		patch: parseInt(m[3]!, 10),
		raw: s,
	};
}

/** Compare two `UnityVersion`s: -1 / 0 / 1 like a standard comparator. */
export function cmpUnityVersion(a: UnityVersion, b: UnityVersion): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	return 0;
}

/** True iff `v >= [maj, min, patch]` (patch optional). */
export function uvAtLeast(v: UnityVersion, maj: number, min = 0, patch = 0): boolean {
	if (v.major !== maj) return v.major > maj;
	if (v.minor !== min) return v.minor > min;
	return v.patch >= patch;
}

/** True iff `v < [maj, min, patch]`. */
export function uvBelow(v: UnityVersion, maj: number, min = 0, patch = 0): boolean {
	return !uvAtLeast(v, maj, min, patch);
}

/**
 * Lightweight reader over a `Uint8Array` with Unity's alignment
 * convention: certain field reads (booleans, sub-objects) are
 * followed by an align-to-4 step that snaps the cursor forward
 * to a 4-byte boundary.
 */
export class UnityReader {
	private off = 0;
	private readonly view: DataView;
	constructor(public readonly bytes: Uint8Array) {
		this.view = new DataView(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		);
	}
	get offset(): number {
		return this.off;
	}
	get remaining(): number {
		return this.bytes.length - this.off;
	}
	skip(n: number): void {
		this.off += n;
	}
	align4(): void {
		this.off = (this.off + 3) & ~3;
	}
	u8(): number {
		const v = this.view.getUint8(this.off);
		this.off += 1;
		return v;
	}
	i32(): number {
		const v = this.view.getInt32(this.off, true);
		this.off += 4;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.off, true);
		this.off += 4;
		return v;
	}
	i64(): bigint {
		const v = this.view.getBigInt64(this.off, true);
		this.off += 8;
		return v;
	}
	u64(): bigint {
		const v = this.view.getBigUint64(this.off, true);
		this.off += 8;
		return v;
	}
	f32(): number {
		const v = this.view.getFloat32(this.off, true);
		this.off += 4;
		return v;
	}
	/** Read a Unity `string`: u32 length + UTF-8 bytes + align-4. */
	string(): string {
		const len = this.u32();
		if (len === 0) {
			this.align4();
			return '';
		}
		const start = this.off;
		const end = Math.min(start + len, this.bytes.length);
		this.off = end;
		this.align4();
		const decoder = new TextDecoder('utf-8', { fatal: false });
		return decoder.decode(this.bytes.subarray(start, end));
	}
	/** Read a Unity bytes array: u32 size + N bytes + align-4. */
	bytes_(): Uint8Array {
		const size = this.u32();
		const out = this.bytes.subarray(this.off, this.off + size);
		this.off += size;
		this.align4();
		return out;
	}
	/**
	 * Read an array of items via `read`, prefixed with a u32 size.
	 * No automatic alignment between elements — the read function
	 * is responsible for that.
	 */
	array<T>(read: (r: this) => T): T[] {
		const n = this.u32();
		const out: T[] = new Array(n);
		for (let i = 0; i < n; i++) out[i] = read(this);
		return out;
	}
}

// =====================================================================
// Texture2D (class 28)
// =====================================================================

/** GLTextureSettings inner struct (5 × i32). */
export interface GlTextureSettings {
	m_FilterMode: number;
	m_Aniso: number;
	m_MipBias: number;
	m_WrapU: number;
	m_WrapV: number;
	m_WrapW: number;
}

/** StreamingInfo (4×8 or 4×16 bytes depending on Unity version). */
export interface StreamingInfo {
	offset: bigint;
	size: number;
	path: string;
}

/** Hardcoded decoded Texture2D. */
export interface ParsedUnityTexture2D {
	m_Name: string;
	m_ForcedFallbackFormat?: number;
	m_DownscaleFallback?: boolean;
	m_IsAlphaChannelOptional?: boolean;
	m_Width: number;
	m_Height: number;
	m_CompleteImageSize: number;
	m_MipsStripped?: number;
	m_TextureFormat: number;
	m_MipCount: number;
	m_IsReadable: boolean;
	m_IsPreProcessed?: boolean;
	m_IgnoreMasterTextureLimit?: boolean;
	m_StreamingMipmaps?: boolean;
	m_StreamingMipmapsPriority?: number;
	m_ImageCount: number;
	m_TextureDimension: number;
	m_TextureSettings: GlTextureSettings;
	m_LightmapFormat: number;
	m_ColorSpace: number;
	m_PlatformBlob?: Uint8Array;
	'image data': Uint8Array;
	m_StreamData?: StreamingInfo;
}

/**
 * Parse Texture2D bytes against the per-Unity-version layout.
 * Tolerant: returns partial results if the input is shorter than
 * the expected layout.
 */
export function parseUnityTexture2D(
	bytes: Uint8Array,
	unityVersion: string,
): ParsedUnityTexture2D {
	const v = parseUnityVersion(unityVersion);
	const r = new UnityReader(bytes);

	// `m_Name` — always first.
	const m_Name = r.string();

	// Pre-2017.3 had no ForcedFallbackFormat etc. We don't support
	// those bundles here (very rare on modern targets).
	let m_ForcedFallbackFormat: number | undefined;
	let m_DownscaleFallback: boolean | undefined;
	let m_IsAlphaChannelOptional: boolean | undefined;
	if (uvAtLeast(v, 2017, 3)) {
		m_ForcedFallbackFormat = r.i32();
		m_DownscaleFallback = r.u8() !== 0;
		if (uvAtLeast(v, 2020, 2)) {
			m_IsAlphaChannelOptional = r.u8() !== 0;
		}
		r.align4();
	}

	const m_Width = r.i32();
	const m_Height = r.i32();
	const m_CompleteImageSize = r.i32();

	let m_MipsStripped: number | undefined;
	if (uvAtLeast(v, 2020, 1)) {
		m_MipsStripped = r.i32();
	}

	const m_TextureFormat = r.i32();

	// MipCount field was renamed `m_MipMap` (single u8) in older
	// versions. From 5.2+ it's a real u32 count. Assume modern.
	const m_MipCount = r.i32();

	const m_IsReadable = r.u8() !== 0;

	let m_IsPreProcessed: boolean | undefined;
	let m_IgnoreMasterTextureLimit: boolean | undefined;
	let m_StreamingMipmaps: boolean | undefined;
	if (uvAtLeast(v, 2020, 1)) {
		m_IsPreProcessed = r.u8() !== 0;
	}
	if (uvAtLeast(v, 2019, 3)) {
		m_IgnoreMasterTextureLimit = r.u8() !== 0;
	}
	// Pre-2018.2 had `m_ReadAllowed` here. Skip the historical case.
	if (uvAtLeast(v, 2018, 3)) {
		m_StreamingMipmaps = r.u8() !== 0;
	}
	r.align4();

	let m_StreamingMipmapsPriority: number | undefined;
	if (uvAtLeast(v, 2018, 3)) {
		m_StreamingMipmapsPriority = r.i32();
	}
	const m_ImageCount = r.i32();
	const m_TextureDimension = r.i32();

	// GLTextureSettings — 5×i32 (FilterMode, Aniso, MipBias, WrapU, WrapV, WrapW).
	// Wrap fields split into per-axis u/v/w starting at 2017.x; older builds
	// had a single `m_WrapMode` u32. We always emit 6 fields with a fallback
	// (WrapV/W copying WrapU on old layouts).
	const m_FilterMode = r.i32();
	const m_Aniso = r.i32();
	const m_MipBias = r.i32();
	let m_WrapU: number, m_WrapV: number, m_WrapW: number;
	if (uvAtLeast(v, 2017)) {
		m_WrapU = r.i32();
		m_WrapV = r.i32();
		m_WrapW = r.i32();
	} else {
		const w = r.i32();
		m_WrapU = w;
		m_WrapV = w;
		m_WrapW = w;
	}
	const m_TextureSettings: GlTextureSettings = {
		m_FilterMode,
		m_Aniso,
		m_MipBias,
		m_WrapU,
		m_WrapV,
		m_WrapW,
	};

	const m_LightmapFormat = r.i32();
	const m_ColorSpace = r.i32();

	let m_PlatformBlob: Uint8Array | undefined;
	if (uvAtLeast(v, 2020, 2)) {
		m_PlatformBlob = r.bytes_();
	}

	const imageData = r.bytes_();

	// `m_StreamData` — present from 5.3+. Layout:
	//   u32 offset (u64 from 2020.1+)
	//   u32 size
	//   string path
	let m_StreamData: StreamingInfo | undefined;
	if (r.remaining >= 8) {
		const offset = uvAtLeast(v, 2020, 1) ? r.u64() : BigInt(r.u32());
		const size = r.u32();
		const path = r.string();
		m_StreamData = { offset, size, path };
	}

	return {
		m_Name,
		m_ForcedFallbackFormat,
		m_DownscaleFallback,
		m_IsAlphaChannelOptional,
		m_Width,
		m_Height,
		m_CompleteImageSize,
		m_MipsStripped,
		m_TextureFormat,
		m_MipCount,
		m_IsReadable,
		m_IsPreProcessed,
		m_IgnoreMasterTextureLimit,
		m_StreamingMipmaps,
		m_StreamingMipmapsPriority,
		m_ImageCount,
		m_TextureDimension,
		m_TextureSettings,
		m_LightmapFormat,
		m_ColorSpace,
		m_PlatformBlob,
		'image data': imageData,
		m_StreamData,
	};
}

// =====================================================================
// TextAsset (class 49)
// =====================================================================

/** Hardcoded decoded TextAsset. */
export interface ParsedUnityTextAsset {
	m_Name: string;
	/** Raw bytes. Unity stores TextAsset content as a `string` field, but
	 * many games stuff binary blobs through it (saves, configs, packed
	 * data), so we expose both the bytes and a best-effort UTF-8 decode. */
	m_Script: Uint8Array;
	m_ScriptAsString?: string;
}

/**
 * Parse a TextAsset's bytes. Layout is stable across all Unity
 * versions: `m_Name` (string) + `m_Script` (string-as-bytes).
 *
 * We expose the raw bytes plus a best-effort UTF-8 decode so
 * binary payloads (game saves shipped through TextAsset) don't
 * get corrupted on round-trip.
 */
export function parseUnityTextAsset(bytes: Uint8Array): ParsedUnityTextAsset {
	const r = new UnityReader(bytes);
	const m_Name = r.string();
	const m_Script = r.bytes_();
	// Best-effort UTF-8 decode for human-readable previews.
	let m_ScriptAsString: string | undefined;
	try {
		const decoder = new TextDecoder('utf-8', { fatal: false });
		const s = decoder.decode(m_Script);
		// Hide it if the decoded text is mostly garbage (>20% replacement
		// chars or non-printable in the first 256 bytes).
		const sample = s.slice(0, 256);
		let bad = 0;
		for (const c of sample) {
			const cp = c.codePointAt(0)!;
			if (cp === 0xfffd || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d)) {
				bad++;
			}
		}
		if (sample.length === 0 || bad / sample.length < 0.2) {
			m_ScriptAsString = s;
		}
	} catch {
		/* binary-only */
	}
	return { m_Name, m_Script, m_ScriptAsString };
}

// =====================================================================
// Font (class 128)
// =====================================================================

/**
 * Hardcoded Font reader. Unity's `Font` object has a lot of
 * fields, but for previewing we only need the embedded font data
 * blob (`m_FontData`), the display name, and a couple of metric
 * fields. We skip everything else by reading just up to
 * `m_FontData` and stopping there.
 *
 * Layout for Unity 2017+ (per AssetStudio):
 *
 *   m_Name              string
 *   m_LineSpacing       float
 *   m_DefaultMaterial   PPtr<Material> (i32 fileID + i64 pathID)
 *   m_FontSize          float
 *   m_Texture           PPtr<Texture>
 *   m_AsciiStartOffset  int
 *   m_Tracking          float
 *   m_CharacterSpacing  int
 *   m_CharacterPadding  int
 *   m_ConvertCase       int
 *   m_CharacterRects    Array<CharacterInfo>  (variable-length)
 *   m_KerningValues     Array<...>
 *   m_PixelScale        float
 *   m_FontData          bytes
 *
 * Walking through `m_CharacterRects` requires knowing the
 * CharacterInfo struct layout (which varies per version). For a
 * preview-only reader we instead use a heuristic: scan the bytes
 * for an `sfnt`-magic prefix (TTF/OTF) and treat everything from
 * that magic onward as the embedded font, plus the immediately
 * preceding u32 as its length. That works because `m_FontData`
 * is the **last** byte-array field in `Font` and Unity emits its
 * length right before the bytes.
 */
export interface ParsedUnityFont {
	m_Name: string;
	m_FontData?: Uint8Array;
	m_LineSpacing?: number;
}

export function parseUnityFont(bytes: Uint8Array): ParsedUnityFont {
	const r = new UnityReader(bytes);
	const m_Name = r.string();
	let m_LineSpacing: number | undefined;
	try {
		m_LineSpacing = r.f32();
	} catch {
		/* truncated */
	}
	// Heuristic: scan for a u32-length-prefixed sfnt magic in the
	// remaining bytes. We look for:
	//   - "OTTO" → OpenType-CFF
	//   - "true" or "typ1" → TrueType
	//   - "\x00\x01\x00\x00" → TTF v1.0
	//   - "ttcf" → TrueType collection
	const SFNT_MAGICS = [
		[0x4f, 0x54, 0x54, 0x4f], // OTTO
		[0x00, 0x01, 0x00, 0x00], // TTF v1.0
		[0x74, 0x72, 0x75, 0x65], // true
		[0x74, 0x79, 0x70, 0x31], // typ1
		[0x74, 0x74, 0x63, 0x66], // ttcf
	];
	for (let i = 0; i + 8 < bytes.length; i++) {
		const b0 = bytes[i];
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		const b3 = bytes[i + 3];
		const isMagic = SFNT_MAGICS.some(
			(m) => m[0] === b0 && m[1] === b1 && m[2] === b2 && m[3] === b3,
		);
		if (!isMagic) continue;
		// Check the u32 immediately before this position for a plausible
		// length (= bytes.length - i, or close to it).
		if (i >= 4) {
			const lenLo = bytes[i - 4];
			const lenHi1 = bytes[i - 3];
			const lenHi2 = bytes[i - 2];
			const lenHi3 = bytes[i - 1];
			const len = lenLo | (lenHi1 << 8) | (lenHi2 << 16) | (lenHi3 << 24);
			if (len > 0 && len <= bytes.length - i) {
				return { m_Name, m_LineSpacing, m_FontData: bytes.subarray(i, i + len) };
			}
		}
		// No valid u32 prefix; assume the rest of the buffer.
		return { m_Name, m_LineSpacing, m_FontData: bytes.subarray(i) };
	}
	return { m_Name, m_LineSpacing };
}

// =====================================================================
// AudioClip (class 83)
// =====================================================================

/** Hardcoded AudioClip. Stable layout from Unity 5.0 onward. */
export interface ParsedUnityAudioClip {
	m_Name: string;
	m_LoadType?: number;
	m_Channels: number;
	m_Frequency: number;
	m_BitsPerSample: number;
	m_Length: number;
	m_IsTrackerFormat?: boolean;
	m_SubsoundIndex?: number;
	m_PreloadAudioData?: boolean;
	m_LoadInBackground?: boolean;
	m_Legacy3D?: boolean;
	m_3D?: boolean;
	m_UseHardware?: boolean;
	m_CompressionFormat?: number;
	/** StreamingInfo path/offset/size into a `.resS` / `.resource` companion. */
	m_Source?: string;
	m_Offset?: bigint;
	m_Size?: bigint;
}

/**
 * Parse an AudioClip from Unity 5.0+. The layout has shifted a
 * couple of times — we cover the modern path that's been stable
 * since Unity 5.0 (2015-onwards).
 *
 * Layout:
 *   m_Name string
 *   m_LoadType i32 (DecompressOnLoad=0, CompressedInMemory=1, Streaming=2)
 *   m_Channels i32
 *   m_Frequency i32
 *   m_BitsPerSample i32
 *   m_Length float
 *   m_IsTrackerFormat bool
 *   align4
 *   m_SubsoundIndex i32
 *   m_PreloadAudioData bool
 *   m_LoadInBackground bool
 *   m_Legacy3D bool
 *   align4
 *   m_Source string
 *   m_Offset i64
 *   m_Size i64
 *   m_CompressionFormat i32
 */
export function parseUnityAudioClip(
	bytes: Uint8Array,
	unityVersion: string,
): ParsedUnityAudioClip {
	const v = parseUnityVersion(unityVersion);
	const r = new UnityReader(bytes);
	const m_Name = r.string();

	// Unity 4 / early 5 had a different layout (per-clip embedded
	// PCM, no streaming). We support 5.0+ which is what every
	// modern build uses.
	if (uvBelow(v, 5)) {
		// Best-effort: emit the rest as opaque.
		return {
			m_Name,
			m_Channels: 0,
			m_Frequency: 0,
			m_BitsPerSample: 0,
			m_Length: 0,
		};
	}

	const m_LoadType = r.i32();
	const m_Channels = r.i32();
	const m_Frequency = r.i32();
	const m_BitsPerSample = r.i32();
	const m_Length = r.f32();
	const m_IsTrackerFormat = r.u8() !== 0;
	r.align4();
	const m_SubsoundIndex = r.i32();
	const m_PreloadAudioData = r.u8() !== 0;
	const m_LoadInBackground = r.u8() !== 0;
	const m_Legacy3D = r.u8() !== 0;
	r.align4();
	const m_Source = r.string();
	const m_Offset = r.i64();
	const m_Size = r.i64();
	let m_CompressionFormat: number | undefined;
	try {
		m_CompressionFormat = r.i32();
	} catch {
		/* trailer optional */
	}

	return {
		m_Name,
		m_LoadType,
		m_Channels,
		m_Frequency,
		m_BitsPerSample,
		m_Length,
		m_IsTrackerFormat,
		m_SubsoundIndex,
		m_PreloadAudioData,
		m_LoadInBackground,
		m_Legacy3D,
		m_CompressionFormat,
		m_Source,
		m_Offset: m_Offset as unknown as bigint,
		m_Size: m_Size as unknown as bigint,
	};
}

// =====================================================================
// Mesh (class 43)
// =====================================================================

/**
 * Hardcoded Mesh reader (summary only).
 *
 * The full Mesh layout is huge and version-dependent (sub-meshes,
 * vertex-format descriptors, packed vertex data, blend-shapes,
 * skinning, bones, BVH). For a metadata preview we only read up to
 * `m_SubMeshes.length` to surface vertex / triangle counts; full
 * geometry extraction is a follow-up.
 */
export interface ParsedUnityMeshSummary {
	m_Name: string;
	subMeshCount?: number;
	totalSize: number;
}

export function parseUnityMeshSummary(bytes: Uint8Array): ParsedUnityMeshSummary {
	const r = new UnityReader(bytes);
	const m_Name = r.string();
	// Modern Mesh starts with:
	//   m_Name string
	//   m_SubMeshes Array<SubMesh>   (i32 count + ...)
	// Reading the count tells us how many surfaces this mesh holds.
	let subMeshCount: number | undefined;
	if (r.remaining >= 4) {
		subMeshCount = r.u32();
		if (subMeshCount > 1000) {
			// Implausible — version layout drift, abandon.
			subMeshCount = undefined;
		}
	}
	return { m_Name, subMeshCount, totalSize: bytes.length };
}

// =====================================================================
// Sprite (class 213)
// =====================================================================

/** Subset of Unity's `SpriteRenderData` struct we care about. */
export interface ParsedUnitySpriteRenderData {
	texture: { m_FileID: number; m_PathID: bigint };
	alphaTexture?: { m_FileID: number; m_PathID: bigint };
	textureRect: { x: number; y: number; width: number; height: number };
}

/**
 * Hardcoded Sprite reader. Reads enough fields for the
 * Sprite-as-cropped-Texture2D preview to work:
 *   - `m_Name`
 *   - `m_Rect` / `m_Offset` / `m_PixelsToUnits` (existing summary)
 *   - `m_RD.texture` (PPtr to the source Texture2D)
 *   - `m_RD.textureRect` (the crop rectangle inside that texture)
 *
 * We skip the in-between fields (atlas refs, pivot, polygon flag,
 * etc.) by walking the on-disc layout for Unity 2017.x–2022.x.
 * Versions older than 2017 are not supported here.
 */
export interface ParsedUnitySpriteSummary {
	m_Name: string;
	m_Rect?: { x: number; y: number; width: number; height: number };
	m_Offset?: { x: number; y: number };
	m_PixelsToUnits?: number;
	m_Pivot?: { x: number; y: number };
	m_Extrude?: number;
	m_IsPolygon?: boolean;
	m_RD?: ParsedUnitySpriteRenderData;
}

export function parseUnitySpriteSummary(
	bytes: Uint8Array,
	unityVersion = '',
): ParsedUnitySpriteSummary {
	const v = parseUnityVersion(unityVersion);
	const r = new UnityReader(bytes);
	const m_Name = r.string();
	let m_Rect: ParsedUnitySpriteSummary['m_Rect'];
	let m_Offset: ParsedUnitySpriteSummary['m_Offset'];
	let m_PixelsToUnits: number | undefined;
	let m_Pivot: ParsedUnitySpriteSummary['m_Pivot'];
	let m_Extrude: number | undefined;
	let m_IsPolygon: boolean | undefined;
	let m_RD: ParsedUnitySpriteRenderData | undefined;
	try {
		m_Rect = { x: r.f32(), y: r.f32(), width: r.f32(), height: r.f32() };
		m_Offset = { x: r.f32(), y: r.f32() };
		// `m_Border` (Vector4f, 4×f32) added in Unity 5.4.
		if (uvAtLeast(v, 5, 4)) {
			r.f32();
			r.f32();
			r.f32();
			r.f32();
		}
		m_PixelsToUnits = r.f32();
		// `m_Pivot` added in Unity 5.4.2 — but it shipped in every
		// 5.4+ Sprite we've seen on disc, so gate on 5.4.
		if (uvAtLeast(v, 5, 4)) {
			m_Pivot = { x: r.f32(), y: r.f32() };
		}
		m_Extrude = r.u32();
		// `m_IsPolygon` added in Unity 5.3. Followed by align-4.
		if (uvAtLeast(v, 5, 3)) {
			m_IsPolygon = r.u8() !== 0;
			r.align4();
		}
		// `m_RenderDataKey` added in Unity 2017.x: (Hash128, i64).
		// Hash128 is 16 bytes.
		if (uvAtLeast(v, 2017)) {
			r.skip(16); // hash
			r.skip(8); // long
			// `m_AtlasTags`: array<string>
			const tagCount = r.u32();
			for (let i = 0; i < tagCount; i++) r.string();
			// `m_SpriteAtlas`: PPtr<SpriteAtlas> = (i32, i64)
			r.skip(12);
		}
		// `m_RD` begins. We read just `texture` + `alphaTexture`
		// + `textureRect`, then stop — everything past that is
		// version-specific and we don't need it.
		const texture = { m_FileID: r.i32(), m_PathID: r.i64() };
		let alphaTexture: { m_FileID: number; m_PathID: bigint } | undefined;
		if (uvAtLeast(v, 2017)) {
			alphaTexture = { m_FileID: r.i32(), m_PathID: r.i64() };
		}
		// `secondaryTextures` (2019.2+): array<{ PPtr, hash:u32 }>.
		// AssetStudio handles 2019.2 specifically; we skip it by
		// reading the count + entries when present.
		if (uvAtLeast(v, 2019, 2)) {
			const n = r.u32();
			for (let i = 0; i < n; i++) {
				r.skip(12); // PPtr<Texture2D>
				r.skip(4); // hash
			}
		}
		// In Unity 2018.2+ `m_SubMeshes` and `m_IndexBuffer` come
		// before `m_VertexData`; we don't need them. Per
		// AssetStudio, the next field that matches what we care
		// about (`textureRect`) sits further on. The simplest way
		// to locate `textureRect` is to scan forward for four
		// consecutive plausible f32s that match a sub-rect of
		// `m_Rect`. We don't bother — the existing Sprite preview
		// only needs `m_RD.texture` for the cross-reference, and
		// `m_RD.textureRect` defaults to the full sprite rect when
		// missing.
		//
		// (A full Sprite decoder would walk SubMesh / IndexBuffer /
		// VertexData / m_Bindpose / m_SourceSkin / textureRect /
		// textureRectOffset / atlasRectOffset / settingsRaw …
		// before reaching textureRect.)
		m_RD = {
			texture,
			alphaTexture,
			// textureRect defaults to the full image rect when we
			// can't locate it; the Sprite preview clips against
			// the source texture's bounds anyway.
			textureRect: m_Rect ?? { x: 0, y: 0, width: 0, height: 0 },
		};
	} catch {
		/* truncated — return whatever we managed to read */
	}
	return {
		m_Name,
		m_Rect,
		m_Offset,
		m_PixelsToUnits,
		m_Pivot,
		m_Extrude,
		m_IsPolygon,
		m_RD,
	};
}

// =====================================================================
// MonoScript (class 115)
// =====================================================================

/** Hardcoded MonoScript header. */
export interface ParsedUnityMonoScript {
	m_Name: string;
	m_ExecutionOrder?: number;
	m_PropertiesHash?: Uint8Array;
	m_ClassName?: string;
	m_Namespace?: string;
	m_AssemblyName?: string;
	/** True if this is a `MonoBehaviour`-derived script (typical case). */
	m_IsEditorScript?: boolean;
}

/**
 * Parse a MonoScript's bytes. Layout has been stable since
 * Unity 5.x:
 *   m_Name string
 *   m_ExecutionOrder i32
 *   m_PropertiesHash bytes (16 bytes from 5.x)
 *   m_ClassName string
 *   m_Namespace string
 *   m_AssemblyName string
 *   m_IsEditorScript bool (rare in shipping builds)
 *   align4
 */
export function parseUnityMonoScript(bytes: Uint8Array): ParsedUnityMonoScript {
	const r = new UnityReader(bytes);
	const m_Name = r.string();
	let m_ExecutionOrder: number | undefined;
	let m_PropertiesHash: Uint8Array | undefined;
	let m_ClassName: string | undefined;
	let m_Namespace: string | undefined;
	let m_AssemblyName: string | undefined;
	let m_IsEditorScript: boolean | undefined;
	try {
		m_ExecutionOrder = r.i32();
		// Fixed-length hash: 16 bytes since 5.x.
		const HASH_SIZE = 16;
		if (r.remaining >= HASH_SIZE) {
			m_PropertiesHash = bytes.subarray(r.offset, r.offset + HASH_SIZE);
			r.skip(HASH_SIZE);
		}
		m_ClassName = r.string();
		m_Namespace = r.string();
		m_AssemblyName = r.string();
		if (r.remaining >= 1) {
			m_IsEditorScript = r.u8() !== 0;
			r.align4();
		}
	} catch {
		/* fields are optional */
	}
	return {
		m_Name,
		m_ExecutionOrder,
		m_PropertiesHash,
		m_ClassName,
		m_Namespace,
		m_AssemblyName,
		m_IsEditorScript,
	};
}
