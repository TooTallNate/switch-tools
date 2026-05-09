/**
 * Texture2D pixel decoder for Unity SerializedFile assets.
 *
 * Unity ships texture pixels in two places: inline in the
 * `image data` field of the Texture2D object, or out-of-band
 * in a `.resS` resource stream referenced via `m_StreamData`.
 * Either way the bytes are GPU-tiled — for Switch (and Linux
 * builds of Unity that share the NVN backend, which is more
 * common than you'd think) that's Tegra X1 block-linear
 * layout, the same swizzle BNTX uses.
 *
 * This module pulls the encoded bytes out of either source,
 * runs them through the Tegra deswizzler, and converts to
 * RGBA8 for the formats we care about (Alpha8, R8, RGBA32,
 * BGRA32). More formats can be wired in later as needed.
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
 * Decode a Texture2D object's pixel data to RGBA8. The
 * `texturePayload` is the raw byte source — typically the
 * concatenation of the inline `image data` and the matching
 * `.resS` slice. For most shipping bundles only one of the
 * two is non-empty.
 *
 * Caller responsibilities:
 *   - Provide `width`, `height`, `textureFormat` from the
 *     parsed Texture2D object.
 *   - Provide `payload` covering exactly the mip-0 level's
 *     bytes (mips beyond 0 aren't decoded here yet).
 */
export function decodeUnityTexture2D(
  width: number,
  height: number,
  textureFormat: number,
  payload: Uint8Array,
): DecodedTexture {
  const fmt = describeFormat(textureFormat)
  if (!fmt) {
    throw new Error(
      `Unity Texture2D: unsupported format ${textureFormat} (${TextureFormatName(textureFormat) ?? "unknown"})`,
    )
  }
  const widthInBlocks = Math.ceil(width / fmt.blkWidth)
  const heightInBlocks = Math.ceil(height / fmt.blkHeight)
  const blockHeight = pickBlockHeight(heightInBlocks)
  // Deswizzle the GPU-tiled bytes into a row-major buffer of
  // `bytesPerBlock`-sized cells.
  const linear = deswizzle({
    width,
    height,
    blkWidth: fmt.blkWidth,
    blkHeight: fmt.blkHeight,
    bytesPerBlock: fmt.bytesPerBlock,
    data: payload,
    blockHeight,
  })
  // Convert to RGBA8 according to the source format.
  const pixels = new Uint8Array(width * height * 4)
  fmt.expandToRgba(linear, width, height, pixels)
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
