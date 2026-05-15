/**
 * Unity Texture2D decode helper for the browser.
 *
 * The base `@tootallnate/unity-asset` package's `decodeUnityTexture2D`
 * handles uncompressed formats (Alpha8, RGB24, RGBA32, BGRA32, …) in
 * pure TypeScript — those are fast to compute and portable to Node /
 * tests / scripts.
 *
 * GPU-compressed formats (ASTC LDR, BC1/3/4/5/6/7, ETC2, EAC) are
 * delegated to the GPU via a hidden WebGL2 context: we upload the
 * compressed bytes with `compressedTexImage2D`, render a
 * full-viewport quad sampling that texture into a framebuffer, then
 * `readPixels` the RGBA8 result back. WebGL drivers know these
 * formats natively, so the decode is offloaded to hardware.
 *
 * If the active hardware doesn't expose the required compressed-
 * texture extension we surface a clear error so the UI can render a
 * "this format requires GPU support" panel rather than silently
 * dropping the texture.
 */

import {
	decodeUnityTexture2D as decodeSoftwareTexture2D,
	isTopDownTexturePlatform,
	TextureFormat,
	type DecodedTexture,
} from '@tootallnate/unity-asset';
import { deswizzle, pickBlockHeight } from '@tootallnate/bntx';

import { decodeAstc as decodeAstcWasm } from './astc';

export type { DecodedTexture };

/**
 * Decode a Unity Texture2D mip-0 payload to RGBA8 pixels.
 *
 * Cascading dispatch:
 *
 *   1. Pure-TS decoder for uncompressed formats (Alpha8 / RGBA32 /
 *      BGRA32 / RGB24 / R8 / …). Fastest path, runs in any JS env.
 *   2. ASTC LDR via the `@tootallnate/astc-wasm` package — pure
 *      Rust decoder compiled to WASM, works on every machine
 *      regardless of GPU support. Lazily-loaded, ~33 KB.
 *   3. GPU-side decode via WebGL2 + `compressedTexImage2D`. Used
 *      for BC / ETC2 / EAC formats where we don't ship a software
 *      decoder; depends on the host GPU exposing the relevant
 *      `WEBGL_compressed_texture_*` extension.
 *
 * For ASTC specifically we prefer the WASM path over WebGL because
 * ASTC support is patchy on desktop browsers (notably macOS Chrome
 * / Firefox don't expose `WEBGL_compressed_texture_astc`); the WASM
 * decoder is universal.
 */
/**
 * BuildTarget IDs whose textures are stored with Tegra X1
 * block-linear swizzle. All other targets ship row-major linear
 * pixels and skip the deswizzle step.
 */
const TEGRA_PLATFORMS = new Set<number>([27, 38]);

function isTegraPlatform(platform: number | undefined): boolean {
	// When the caller doesn't know the platform we conservatively
	// assume Tegra — this module was originally written for
	// Switch-only content, and downstream consumers that DO know
	// they're on desktop now pass the platform field explicitly.
	if (platform === undefined) return true;
	return TEGRA_PLATFORMS.has(platform);
}

export async function decodeTexture2D(
	width: number,
	height: number,
	textureFormat: number,
	payload: Uint8Array,
	platform?: number,
): Promise<DecodedTexture> {
	// Software path covers most desktop bundles; fall through on
	// "unsupported format" to the more elaborate paths.
	try {
		return decodeSoftwareTexture2D(width, height, textureFormat, payload, platform);
	} catch (err) {
		// Re-throw anything that isn't an "unsupported format"
		// failure (e.g. malformed payload, deswizzle error).
		if (!(err instanceof Error) || !/unsupported format/i.test(err.message)) {
			throw err;
		}
	}
	// ASTC family — go straight to the WASM decoder. Works on every
	// platform without GPU support, which the WebGL path doesn't.
	const astc = pickAstcBlockSize(textureFormat);
	if (astc) {
		// On Switch / Tegra targets the compressed blocks are stored
		// in a GPU-tiled (block-linear) layout — we have to deswizzle
		// before handing them to the ASTC decoder or the output is
		// scrambled. Every other target stores the blocks row-major
		// and the bytes go to the decoder unchanged.
		let blockStream: Uint8Array;
		if (isTegraPlatform(platform)) {
			const heightInBlocks = Math.ceil(height / astc.blockH);
			const widthInBlocks = Math.ceil(width / astc.blockW);
			const blockHeight = inferTegraBlockHeight(
				widthInBlocks,
				heightInBlocks,
				16,
				payload.length,
			);
			blockStream = deswizzle({
				width,
				height,
				blkWidth: astc.blockW,
				blkHeight: astc.blockH,
				bytesPerBlock: 16,
				data: payload,
				blockHeight,
			});
		} else {
			blockStream = payload;
		}
		const pixels = await decodeAstcWasm(
			width,
			height,
			astc.blockW,
			astc.blockH,
			blockStream,
		);
		// Unity writes textures bottom-up (OpenGL convention) for
		// every target except the Direct3D / Metal / GNM family —
		// see `isTopDownTexturePlatform`. Without the flip, those
		// builds render upside-down in our canvas-side preview.
		if (platform !== undefined && !isTopDownTexturePlatform(platform)) {
			flipVerticalRgba(pixels, width, height);
		}
		return { width, height, pixels };
	}
	// Format-to-WebGL-internal mapping for non-ASTC compressed
	// formats. The numeric values are stable and the extension
	// constants live on the extension object at runtime.
	const gpu = pickGpuDecodePlan(textureFormat);
	if (!gpu) {
		throw new Error(
			`Unity Texture2D: unsupported format ${textureFormat} (no software, ASTC, or GPU decoder available).`,
		);
	}
	const gpuPixels = await decodeOnGpu(width, height, payload, gpu);
	if (platform !== undefined && !isTopDownTexturePlatform(platform)) {
		flipVerticalRgba(gpuPixels.pixels, width, height);
	}
	return gpuPixels;
}

/**
 * Infer the Tegra `block_height` exponent from the on-disk payload
 * size. Switch textures pad each mip out to multiples of one GOB
 * (64 bytes wide × 8 rows tall) horizontally and `8 × blockHeight`
 * rows vertically; reading that padding back tells us which
 * blockHeight was used at encode time.
 *
 * `pickBlockHeight` (the bntx default) returns the largest power
 * of 2 ≤ heightInBlocks, capped at 16 — but real-world Switch
 * Unity textures often ship a SMALLER blockHeight than that
 * upper bound (notably when the texture is wider than it is
 * tall, or when shipping atlases below the optimal-tiling
 * threshold). Using the wrong blockHeight scrambles half the
 * blocks. We iterate {16, 8, 4, 2, 1} and pick the largest value
 * whose padded layout fits the payload exactly — that's the
 * value the Tegra encoder actually used.
 *
 * Falls back to `pickBlockHeight` when we can't reconcile any
 * exponent against the payload (e.g. row-major / pitch-linear
 * builds, mip-chain payloads). The deswizzle path is always
 * called: when the data is plain row-major the address math
 * happens to be a no-op for textures small enough to fit in a
 * single GOB column, which is the common shipping case.
 */
function inferTegraBlockHeight(
	widthInBlocks: number,
	heightInBlocks: number,
	bytesPerBlock: number,
	payloadLen: number,
): number {
	const rowBytes = widthInBlocks * bytesPerBlock;
	const paddedRowBytes = roundUp(rowBytes, 64);
	for (const bh of [16, 8, 4, 2, 1]) {
		const stripeHeight = 8 * bh;
		const paddedRows = roundUp(heightInBlocks, stripeHeight);
		if (paddedRowBytes * paddedRows === payloadLen) {
			return bh;
		}
	}
	// Couldn't reconcile — surface the heuristic default. Better
	// than silently mis-decoding: tiny textures fit in one GOB so
	// any blockHeight produces the same result, and oversized
	// payloads (mip chains) will use the largest block height
	// which matches the dominant mip-0 layout.
	return pickBlockHeight(heightInBlocks);
}

function roundUp(n: number, multiple: number): number {
	return Math.ceil(n / multiple) * multiple;
}

/**
 * Pick the ASTC block dimensions for a Unity TextureFormat code.
 * Returns `null` for non-ASTC formats. Both the RGB-only and RGBA
 * variants use the same on-disk layout — the `_RGB` / `_RGBA`
 * distinction is a rendering hint, not a different bit format —
 * so we collapse them to the same decoder call.
 */
function pickAstcBlockSize(
	format: number,
): { blockW: number; blockH: number } | null {
	switch (format) {
		case TextureFormat.ASTC_RGB_4x4:
		case TextureFormat.ASTC_RGBA_4x4:
			return { blockW: 4, blockH: 4 };
		case TextureFormat.ASTC_RGB_5x5:
		case TextureFormat.ASTC_RGBA_5x5:
			return { blockW: 5, blockH: 5 };
		case TextureFormat.ASTC_RGB_6x6:
		case TextureFormat.ASTC_RGBA_6x6:
			return { blockW: 6, blockH: 6 };
		case TextureFormat.ASTC_RGB_8x8:
		case TextureFormat.ASTC_RGBA_8x8:
			return { blockW: 8, blockH: 8 };
		case TextureFormat.ASTC_RGB_10x10:
		case TextureFormat.ASTC_RGBA_10x10:
			return { blockW: 10, blockH: 10 };
		case TextureFormat.ASTC_RGB_12x12:
		case TextureFormat.ASTC_RGBA_12x12:
			return { blockW: 12, blockH: 12 };
		default:
			return null;
	}
}

interface GpuDecodePlan {
	internalFormat: number;
	extensionName: string;
	/** Human-readable label used in error messages. */
	label: string;
}

/**
 * Look up the WebGL compressed-internal-format constant + the
 * extension that exposes it for a given Unity TextureFormat code.
 *
 * The numeric values come from the WebGL spec:
 *   - WEBGL_compressed_texture_astc (KHR_texture_compression_astc_ldr)
 *   - WEBGL_compressed_texture_s3tc (DXT1/DXT5/BC4/BC5)
 *   - EXT_texture_compression_bptc  (BC6H/BC7)
 *   - WEBGL_compressed_texture_etc  (ETC2 / EAC)
 *
 * We don't try to be exhaustive — Unity ships a long tail of crunch /
 * 3DS / signed-EAC variants that are rare in practice. Adding more
 * is a one-line addition each.
 */
function pickGpuDecodePlan(format: number): GpuDecodePlan | null {
	switch (format) {
		// ----- ASTC LDR -----
		case TextureFormat.ASTC_RGB_4x4:
		case TextureFormat.ASTC_RGBA_4x4:
			return {
				internalFormat: 0x93b0, // COMPRESSED_RGBA_ASTC_4x4_KHR
				extensionName: 'WEBGL_compressed_texture_astc',
				label: 'ASTC 4x4',
			};
		case TextureFormat.ASTC_RGB_5x5:
		case TextureFormat.ASTC_RGBA_5x5:
			return {
				internalFormat: 0x93b2,
				extensionName: 'WEBGL_compressed_texture_astc',
				label: 'ASTC 5x5',
			};
		case TextureFormat.ASTC_RGB_6x6:
		case TextureFormat.ASTC_RGBA_6x6:
			return {
				internalFormat: 0x93b4,
				extensionName: 'WEBGL_compressed_texture_astc',
				label: 'ASTC 6x6',
			};
		case TextureFormat.ASTC_RGB_8x8:
		case TextureFormat.ASTC_RGBA_8x8:
			return {
				internalFormat: 0x93b7,
				extensionName: 'WEBGL_compressed_texture_astc',
				label: 'ASTC 8x8',
			};
		case TextureFormat.ASTC_RGB_10x10:
		case TextureFormat.ASTC_RGBA_10x10:
			return {
				internalFormat: 0x93ba,
				extensionName: 'WEBGL_compressed_texture_astc',
				label: 'ASTC 10x10',
			};
		case TextureFormat.ASTC_RGB_12x12:
		case TextureFormat.ASTC_RGBA_12x12:
			return {
				internalFormat: 0x93bd,
				extensionName: 'WEBGL_compressed_texture_astc',
				label: 'ASTC 12x12',
			};
		// ----- DXT / BC -----
		case TextureFormat.DXT1:
			return {
				internalFormat: 0x83f1, // COMPRESSED_RGBA_S3TC_DXT1_EXT
				extensionName: 'WEBGL_compressed_texture_s3tc',
				label: 'DXT1 (BC1)',
			};
		case TextureFormat.DXT5:
			return {
				internalFormat: 0x83f3, // COMPRESSED_RGBA_S3TC_DXT5_EXT
				extensionName: 'WEBGL_compressed_texture_s3tc',
				label: 'DXT5 (BC3)',
			};
		case TextureFormat.BC4:
			return {
				internalFormat: 0x8dbb, // COMPRESSED_RED_RGTC1_EXT
				extensionName: 'EXT_texture_compression_rgtc',
				label: 'BC4',
			};
		case TextureFormat.BC5:
			return {
				internalFormat: 0x8dbd, // COMPRESSED_RED_GREEN_RGTC2_EXT
				extensionName: 'EXT_texture_compression_rgtc',
				label: 'BC5',
			};
		case TextureFormat.BC6H:
			return {
				internalFormat: 0x8e8f, // COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT
				extensionName: 'EXT_texture_compression_bptc',
				label: 'BC6H',
			};
		case TextureFormat.BC7:
			return {
				internalFormat: 0x8e8c, // COMPRESSED_RGBA_BPTC_UNORM
				extensionName: 'EXT_texture_compression_bptc',
				label: 'BC7',
			};
		// ----- ETC2 / EAC -----
		case TextureFormat.ETC2_RGB:
			return {
				internalFormat: 0x9274, // COMPRESSED_RGB8_ETC2
				extensionName: 'WEBGL_compressed_texture_etc',
				label: 'ETC2 RGB',
			};
		case TextureFormat.ETC2_RGBA8:
			return {
				internalFormat: 0x9278, // COMPRESSED_RGBA8_ETC2_EAC
				extensionName: 'WEBGL_compressed_texture_etc',
				label: 'ETC2 RGBA',
			};
		case TextureFormat.EAC_R:
			return {
				internalFormat: 0x9270, // COMPRESSED_R11_EAC
				extensionName: 'WEBGL_compressed_texture_etc',
				label: 'EAC R',
			};
		case TextureFormat.EAC_RG:
			return {
				internalFormat: 0x9272, // COMPRESSED_RG11_EAC
				extensionName: 'WEBGL_compressed_texture_etc',
				label: 'EAC RG',
			};
		default:
			return null;
	}
}

/**
 * Decode `payload` on the GPU by uploading it as a compressed
 * texture, sampling it into a framebuffer, and reading back RGBA8
 * pixels. Re-uses a single hidden WebGL2 context across calls.
 *
 * On a missing extension the WebGL upload would silently produce a
 * black texture — we check the extension up front and throw with a
 * clear message so the preview can show "ASTC requires GPU support
 * not available in this browser."
 */
async function decodeOnGpu(
	width: number,
	height: number,
	payload: Uint8Array,
	plan: GpuDecodePlan,
): Promise<DecodedTexture> {
	const ctx = ensureGpuContext();
	if (!ctx) {
		throw new Error(
			`${plan.label} decoding requires a WebGL2 context, which isn't available in this environment.`,
		);
	}
	const gl = ctx.gl;
	const ext = gl.getExtension(plan.extensionName);
	if (!ext) {
		throw new Error(
			`${plan.label} decoding requires the WebGL extension \`${plan.extensionName}\`, which the active GPU doesn't support.`,
		);
	}
	// Upload the compressed payload as a texture.
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.compressedTexImage2D(
		gl.TEXTURE_2D,
		0,
		plan.internalFormat,
		width,
		height,
		0,
		payload,
	);
	const uploadErr = gl.getError();
	if (uploadErr !== gl.NO_ERROR) {
		gl.deleteTexture(tex);
		throw new Error(
			`${plan.label} upload failed (GL error 0x${uploadErr.toString(16)}). Payload size or block alignment may be off.`,
		);
	}
	// Bind a colour-buffer target sized to the texture, render the
	// quad, and read back the pixels.
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	const colour = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, colour);
	gl.texImage2D(
		gl.TEXTURE_2D,
		0,
		gl.RGBA8,
		width,
		height,
		0,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		null,
	);
	gl.framebufferTexture2D(
		gl.FRAMEBUFFER,
		gl.COLOR_ATTACHMENT0,
		gl.TEXTURE_2D,
		colour,
		0,
	);
	if (
		gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
	) {
		gl.deleteTexture(tex);
		gl.deleteTexture(colour);
		gl.deleteFramebuffer(fbo);
		throw new Error('GPU decode: incomplete framebuffer');
	}
	gl.viewport(0, 0, width, height);
	gl.useProgram(ctx.program);
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.bindBuffer(gl.ARRAY_BUFFER, ctx.quadBuffer);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	const pixels = new Uint8Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	// Flip vertically: WebGL's framebuffer origin is bottom-left,
	// but Unity / our consumers expect top-down rows.
	flipVerticalRgba(pixels, width, height);
	// Cleanup per call. The WebGL context itself is reused.
	gl.deleteTexture(tex);
	gl.deleteTexture(colour);
	gl.deleteFramebuffer(fbo);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return { width, height, pixels };
}

interface GpuContext {
	gl: WebGL2RenderingContext;
	program: WebGLProgram;
	quadBuffer: WebGLBuffer;
}

let _gpuCtx: GpuContext | null | undefined;

/**
 * Lazily create (and cache) a hidden WebGL2 context used for all
 * GPU-side texture decoding. Returns `null` when WebGL isn't
 * available (Node / SSR / privacy modes that block context
 * creation) so callers can surface a friendly fallback.
 */
function ensureGpuContext(): GpuContext | null {
	if (_gpuCtx !== undefined) return _gpuCtx;
	if (typeof document === 'undefined') {
		_gpuCtx = null;
		return null;
	}
	const canvas = document.createElement('canvas');
	const gl = canvas.getContext('webgl2', {
		preserveDrawingBuffer: false,
		antialias: false,
		premultipliedAlpha: false,
	}) as WebGL2RenderingContext | null;
	if (!gl) {
		_gpuCtx = null;
		return null;
	}
	const vsSrc = `#version 300 es
	in vec2 a_pos;
	out vec2 v_uv;
	void main() {
		v_uv = a_pos * 0.5 + 0.5;
		gl_Position = vec4(a_pos, 0.0, 1.0);
	}`;
	const fsSrc = `#version 300 es
	precision highp float;
	in vec2 v_uv;
	uniform sampler2D u_tex;
	out vec4 o_col;
	void main() {
		o_col = texture(u_tex, v_uv);
	}`;
	const program = compileProgram(gl, vsSrc, fsSrc);
	if (!program) {
		_gpuCtx = null;
		return null;
	}
	gl.bindAttribLocation(program, 0, 'a_pos');
	const quadBuffer = gl.createBuffer()!;
	gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
	gl.bufferData(
		gl.ARRAY_BUFFER,
		new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
		gl.STATIC_DRAW,
	);
	_gpuCtx = { gl, program, quadBuffer };
	return _gpuCtx;
}

function compileProgram(
	gl: WebGL2RenderingContext,
	vsSrc: string,
	fsSrc: string,
): WebGLProgram | null {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
	if (!vs) return null;
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
	if (!fs) {
		gl.deleteShader(vs);
		return null;
	}
	const program = gl.createProgram()!;
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		gl.deleteProgram(program);
		return null;
	}
	return program;
}

function compileShader(
	gl: WebGL2RenderingContext,
	type: number,
	src: string,
): WebGLShader | null {
	const sh = gl.createShader(type)!;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		gl.deleteShader(sh);
		return null;
	}
	return sh;
}

/**
 * Flip an RGBA8 image vertically in place, swapping rows to convert
 * between WebGL's bottom-up framebuffer origin and our top-down
 * canvas / `<img>` consumers.
 */
function flipVerticalRgba(rgba: Uint8Array, width: number, height: number) {
	const stride = width * 4;
	const tmp = new Uint8Array(stride);
	for (let y = 0; y < height >> 1; y++) {
		const top = y * stride;
		const bot = (height - 1 - y) * stride;
		tmp.set(rgba.subarray(top, top + stride));
		rgba.copyWithin(top, bot, bot + stride);
		rgba.set(tmp, bot);
	}
}
