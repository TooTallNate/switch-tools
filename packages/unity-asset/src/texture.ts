/**
 * Texture2D pixel decoder for Unity SerializedFile assets.
 *
 * Unity ships texture pixels in two places: inline in the
 * `image data` field of the Texture2D object, or out-of-band
 * in a `.resS` resource stream referenced via `m_StreamData`.
 *
 * **Byte layout differs by platform**. The Switch (build target
 * 38, and 27 on some Unity versions) tiles texture data with
 * the Tegra X1 block-linear swizzle — the same layout BNTX uses.
 * Every other shipping target — desktop (Windows / macOS / Linux),
 * mobile (Android / iOS for the formats we cover), WebGL — stores
 * row-major linear pixels with no swizzle. The caller passes the
 * `platform` field from the SerializedFile header so we route to
 * the right path.
 *
 * The output is RGBA8 for the formats we cover (Alpha8 / R8 /
 * RGB24 / RGBA32 / ARGB32 / BGRA32). BC / ETC / ASTC paths can
 * be wired in later by extending `describeFormat`.
 */

import { deswizzle, pickBlockHeight } from "@tootallnate/bntx"
import { TextureFormat } from "./index.js"

export interface DecodedTexture {
  width: number
  height: number
  /** RGBA8 pixels in row-major top-down order. Length = `4 × width × height`. */
  pixels: Uint8Array
}

/**
 * BuildTarget IDs that use Tegra block-linear texture tiling. All
 * other targets store textures with linear row-major bytes.
 *
 * Per AssetStudio's `BuildTarget.cs` (MIT):
 *   - 27 Switch (Unity <= 2017.x)
 *   - 38 Switch (Unity 2018+ once they renumbered)
 */
const TEGRA_PLATFORMS = new Set<number>([27, 38])

/**
 * BuildTarget IDs whose cooker writes texture pixels in top-down
 * (Direct3D / Metal) byte order. Every other target — every
 * OpenGL / OpenGL-ES / Vulkan target including Linux, modern
 * macOS, Android, Switch — writes pixels bottom-up, matching
 * OpenGL's `(0, 0)` = lower-left convention.
 *
 * Per AssetStudio's `BuildTarget.cs` (MIT):
 *   - 5  StandaloneWindows (Direct3D 9 / 11)
 *   - 19 StandaloneWindows64
 *   - 21 WSAPlayer
 *   - 31 XboxOne
 *   - 33 PS4 (GNM, top-down)
 *   - 34 PSP2 / Vita
 *   - 41 Stadia (Vulkan, ships top-down anyway)
 *   - 44 GameCoreXboxOne / GameCoreScarlett
 *
 * When we can't identify the platform (caller didn't pass one)
 * we fall through to "no flip" to keep the legacy behaviour.
 */
const TOP_DOWN_PLATFORMS = new Set<number>([
	5, 19, 21, 31, 33, 34, 41, 44,
])

/**
 * True iff `platform` (Unity BuildTarget code) stores textures
 * top-down. Returns `false` for unknown / unspecified platforms
 * — the calling code uses that as "don't apply a Y flip", which
 * matches the pre-flip historical behaviour.
 */
export function isTopDownTexturePlatform(platform: number | undefined): boolean {
	if (platform === undefined) return false
	return TOP_DOWN_PLATFORMS.has(platform)
}

/**
 * Flip an RGBA8 pixel buffer along the Y-axis in place. Used to
 * convert Unity's on-disc bottom-up texture data into the
 * top-down ordering the rest of our pipeline (Canvas2D, PNG
 * download, sprite crop) expects.
 */
function flipVerticalRgba(pixels: Uint8Array, width: number, height: number): void {
	const rowBytes = width * 4
	const tmp = new Uint8Array(rowBytes)
	for (let y = 0; y < Math.floor(height / 2); y++) {
		const top = y * rowBytes
		const bottom = (height - 1 - y) * rowBytes
		tmp.set(pixels.subarray(top, top + rowBytes))
		pixels.copyWithin(top, bottom, bottom + rowBytes)
		pixels.set(tmp, bottom)
	}
}

/**
 * Decode a Texture2D object's pixel data to RGBA8.
 *
 * Caller responsibilities:
 *   - Provide `width`, `height`, `textureFormat` from the
 *     parsed Texture2D object.
 *   - Provide `payload` covering exactly the mip-0 level's
 *     bytes (mips beyond 0 aren't decoded here yet).
 *   - Provide `platform` from the SerializedFile header so we
 *     can decide whether to run the Tegra deswizzler. Omit to
 *     keep the legacy Switch-first behaviour (deswizzle
 *     unconditionally); callers that know they're not on Switch
 *     should always pass it.
 */
export function decodeUnityTexture2D(
  width: number,
  height: number,
  textureFormat: number,
  payload: Uint8Array,
  platform?: number,
): DecodedTexture {
  const fmt = describeFormat(textureFormat)
  if (!fmt) {
    throw new Error(
      `Unity Texture2D: unsupported format ${textureFormat} (${TextureFormatName(textureFormat) ?? "unknown"})`,
    )
  }
  let linear: Uint8Array
  // Switch builds store textures with Tegra X1 block-linear
  // swizzle; deswizzle into row-major. Every other target ships
  // the bytes linear, so we pass them through as-is.
  //
  // When the caller omits `platform` we deswizzle to preserve the
  // pre-platform-aware behaviour (this module originally targeted
  // Switch-only bundles).
  if (platform === undefined || TEGRA_PLATFORMS.has(platform)) {
    const widthInBlocks = Math.ceil(width / fmt.blkWidth)
    const heightInBlocks = Math.ceil(height / fmt.blkHeight)
    const blockHeight = pickBlockHeight(heightInBlocks)
    linear = deswizzle({
      width,
      height,
      blkWidth: fmt.blkWidth,
      blkHeight: fmt.blkHeight,
      bytesPerBlock: fmt.bytesPerBlock,
      data: payload,
      blockHeight,
    })
  } else {
    linear = payload
  }
  const pixels = new Uint8Array(width * height * 4)
  fmt.expandToRgba(linear, width, height, pixels)
  // Y-flip when the source was stored bottom-up. Unity's cooker
  // writes textures bottom-up (OpenGL convention) for every target
  // except a handful of Direct3D / Metal / GNM ones — see
  // `TOP_DOWN_PLATFORMS`. Without this, Linux / macOS / Switch /
  // mobile builds render upside-down in our preview.
  if (platform !== undefined && !isTopDownTexturePlatform(platform)) {
    flipVerticalRgba(pixels, width, height)
  }
  return { width, height, pixels }
}

/**
 * `TextureFormat` enum value → human-readable name. Subset
 * matching the formats we care about; everything else falls
 * through to `unknown`.
 */
export function TextureFormatName(code: number): string | undefined {
  switch (code) {
    // Uncompressed
    case TextureFormat.Alpha8: return "Alpha8"
    case TextureFormat.ARGB4444: return "ARGB4444"
    case TextureFormat.RGB24: return "RGB24"
    case TextureFormat.RGBA32: return "RGBA32"
    case TextureFormat.ARGB32: return "ARGB32"
    case TextureFormat.RGB565: return "RGB565"
    case TextureFormat.R16: return "R16"
    case TextureFormat.RGBA4444: return "RGBA4444"
    case TextureFormat.BGRA32: return "BGRA32"
    case TextureFormat.RHalf: return "RHalf"
    case TextureFormat.RGHalf: return "RGHalf"
    case TextureFormat.RGBAHalf: return "RGBAHalf"
    case TextureFormat.RFloat: return "RFloat"
    case TextureFormat.RGFloat: return "RGFloat"
    case TextureFormat.RGBAFloat: return "RGBAFloat"
    case TextureFormat.YUY2: return "YUY2"
    case TextureFormat.RGB9e5Float: return "RGB9e5Float"
    case TextureFormat.RG16: return "RG16"
    case TextureFormat.R8: return "R8"
    // BC / DXT
    case TextureFormat.DXT1: return "DXT1 (BC1)"
    case TextureFormat.DXT5: return "DXT5 (BC3)"
    case TextureFormat.BC4: return "BC4"
    case TextureFormat.BC5: return "BC5"
    case TextureFormat.BC6H: return "BC6H"
    case TextureFormat.BC7: return "BC7"
    case TextureFormat.DXT1Crunched: return "DXT1Crunched"
    case TextureFormat.DXT5Crunched: return "DXT5Crunched"
    // PVRTC
    case TextureFormat.PVRTC_RGB2: return "PVRTC_RGB2"
    case TextureFormat.PVRTC_RGBA2: return "PVRTC_RGBA2"
    case TextureFormat.PVRTC_RGB4: return "PVRTC_RGB4"
    case TextureFormat.PVRTC_RGBA4: return "PVRTC_RGBA4"
    // ETC / EAC
    case TextureFormat.ETC_RGB4: return "ETC_RGB4"
    case TextureFormat.ATC_RGB4: return "ATC_RGB4"
    case TextureFormat.ATC_RGBA8: return "ATC_RGBA8"
    case TextureFormat.EAC_R: return "EAC_R"
    case TextureFormat.EAC_R_SIGNED: return "EAC_R_SIGNED"
    case TextureFormat.EAC_RG: return "EAC_RG"
    case TextureFormat.EAC_RG_SIGNED: return "EAC_RG_SIGNED"
    case TextureFormat.ETC2_RGB: return "ETC2_RGB"
    case TextureFormat.ETC2_RGBA1: return "ETC2_RGBA1"
    case TextureFormat.ETC2_RGBA8: return "ETC2_RGBA8"
    case TextureFormat.ETC_RGB4_3DS: return "ETC_RGB4_3DS"
    case TextureFormat.ETC_RGBA8_3DS: return "ETC_RGBA8_3DS"
    // ASTC LDR
    case TextureFormat.ASTC_RGB_4x4: return "ASTC_RGB_4x4"
    case TextureFormat.ASTC_RGB_5x5: return "ASTC_RGB_5x5"
    case TextureFormat.ASTC_RGB_6x6: return "ASTC_RGB_6x6"
    case TextureFormat.ASTC_RGB_8x8: return "ASTC_RGB_8x8"
    case TextureFormat.ASTC_RGB_10x10: return "ASTC_RGB_10x10"
    case TextureFormat.ASTC_RGB_12x12: return "ASTC_RGB_12x12"
    case TextureFormat.ASTC_RGBA_4x4: return "ASTC_RGBA_4x4"
    case TextureFormat.ASTC_RGBA_5x5: return "ASTC_RGBA_5x5"
    case TextureFormat.ASTC_RGBA_6x6: return "ASTC_RGBA_6x6"
    case TextureFormat.ASTC_RGBA_8x8: return "ASTC_RGBA_8x8"
    case TextureFormat.ASTC_RGBA_10x10: return "ASTC_RGBA_10x10"
    case TextureFormat.ASTC_RGBA_12x12: return "ASTC_RGBA_12x12"
    default: return undefined
  }
}

interface FormatDescriptor {
  blkWidth: number
  blkHeight: number
  bytesPerBlock: number
  expandToRgba: (
    src: Uint8Array,
    w: number,
    h: number,
    dst: Uint8Array,
  ) => void
}

/**
 * Per-format descriptor: GPU block geometry + byte size, plus
 * the function that turns the linear (deswizzled) bytes into
 * an RGBA8 buffer. We cover the formats TMPro fonts use most
 * of the time — Alpha8 / R8 — plus the common uncompressed
 * RGBA / BGRA.
 *
 * BC1/3/4/5/7 decoders live in `@tootallnate/bntx` already;
 * extending this table to call them is a small follow-up
 * when a real-world bundle needs it.
 */
function describeFormat(code: number): FormatDescriptor | null {
  switch (code) {
    case TextureFormat.Alpha8:
    case TextureFormat.R8:
      return {
        blkWidth: 1,
        blkHeight: 1,
        bytesPerBlock: 1,
        expandToRgba(src, w, h, dst) {
          // Alpha8 and R8 both store one byte per pixel. We
          // splat the value across all RGB channels and use
          // the same byte as alpha — mirrors what TMPro's
          // shader does at runtime, which interprets the
          // single channel as both luminance + coverage.
          for (let i = 0; i < w * h; i++) {
            const v = src[i]!
            dst[i * 4] = v
            dst[i * 4 + 1] = v
            dst[i * 4 + 2] = v
            dst[i * 4 + 3] = v
          }
        },
      }
    case TextureFormat.RGBA32:
      return {
        blkWidth: 1,
        blkHeight: 1,
        bytesPerBlock: 4,
        expandToRgba(src, w, h, dst) {
          dst.set(src.subarray(0, w * h * 4))
        },
      }
    case TextureFormat.ARGB32:
      return {
        blkWidth: 1,
        blkHeight: 1,
        bytesPerBlock: 4,
        expandToRgba(src, w, h, dst) {
          for (let i = 0; i < w * h; i++) {
            const a = src[i * 4]!
            const r = src[i * 4 + 1]!
            const g = src[i * 4 + 2]!
            const b = src[i * 4 + 3]!
            dst[i * 4] = r
            dst[i * 4 + 1] = g
            dst[i * 4 + 2] = b
            dst[i * 4 + 3] = a
          }
        },
      }
    case TextureFormat.BGRA32:
      return {
        blkWidth: 1,
        blkHeight: 1,
        bytesPerBlock: 4,
        expandToRgba(src, w, h, dst) {
          for (let i = 0; i < w * h; i++) {
            dst[i * 4] = src[i * 4 + 2]!
            dst[i * 4 + 1] = src[i * 4 + 1]!
            dst[i * 4 + 2] = src[i * 4]!
            dst[i * 4 + 3] = src[i * 4 + 3]!
          }
        },
      }
    case TextureFormat.RGB24:
      return {
        blkWidth: 1,
        blkHeight: 1,
        bytesPerBlock: 3,
        expandToRgba(src, w, h, dst) {
          for (let i = 0; i < w * h; i++) {
            dst[i * 4] = src[i * 3]!
            dst[i * 4 + 1] = src[i * 3 + 1]!
            dst[i * 4 + 2] = src[i * 3 + 2]!
            dst[i * 4 + 3] = 255
          }
        },
      }
    default:
      return null
  }
}
