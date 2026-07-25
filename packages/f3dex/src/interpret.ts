/**
 * N64 display-list interpreter.
 *
 * Walks an F3D / F3DEX / F3DEX2 command stream and accumulates the
 * triangles it draws into flat typed arrays ready for a renderer.
 *
 * How N64 geometry actually works, and what that means here:
 *
 *  • Vertices are DMA'd into a small RSP cache (16 entries on F3D,
 *    32 on F3DEX/F3DEX2) by `G_VTX`. Triangle commands then index
 *    that cache — *not* a global vertex array. A display list
 *    typically reloads the cache many times, so cache slot 3 means
 *    something different before and after each `G_VTX`.
 *
 *  • Because of that reuse, and because texture coordinates and
 *    shade colours live in the cache entry rather than in the
 *    triangle, we emit **unshared vertices**: three fresh vertices
 *    per triangle, snapshotting the cache contents at draw time.
 *    This is the same approach the FF7/FF8 model adapters in this
 *    repo take, for the same reason.
 *
 *  • Vertex positions are transformed by the top of the RSP matrix
 *    stack at `G_VTX` time. We implement the stack so multi-part
 *    models (which push/pop between limbs) come out assembled.
 *
 *  • Pointers inside a display list are *segmented*: the top byte
 *    is a segment number resolved through a runtime-populated
 *    table. Since we work statically, the default resolver simply
 *    keeps the low 24 bits and treats them as an offset into the
 *    same buffer — which is exactly right for the common cases
 *    (a Zelda 64 object file mapped to segment 6, or an SM64 MIO0
 *    blob mapped to segment 0x0E), and callers with a real segment
 *    map can pass their own.
 */

import {
	GEOMETRY_MODE,
	isValidOpcode,
	opcodesFor,
	RDP,
	triangleIndexScale,
	vertexCacheSize,
	type Microcode,

} from './microcode.js';
import { textureFormatName } from './texture.js';

/**
 * Translates a 32-bit segmented address into an offset in the
 * buffer being interpreted, or `null` if it cannot be resolved.
 */
export type SegmentResolver = (segmentedAddress: number) => number | null;

/**
 * Default resolver: discard the segment byte and treat the low 24
 * bits as a buffer offset. See the module doc comment for why this
 * is the right default for self-contained model files.
 */
export function defaultSegmentResolver(dataLength: number): SegmentResolver {
	return (addr: number) => {
		const offset = addr & 0x00ffffff;
		return offset < dataLength ? offset : null;
	};
}

/** Texture wrap mode derived from a tile's `cm` bits. */
export type WrapMode = 'wrap' | 'mirror' | 'clamp';

function wrapModeFor(cm: number): WrapMode {
	// Bit 0 = mirror, bit 1 = clamp.
	if (cm & 2) return 'clamp';
	if (cm & 1) return 'mirror';
	return 'wrap';
}

/** A distinct texture/render state encountered while interpreting. */
export interface F3dexMaterial {
	/** Segmented address of the texture image, or `null` if untextured. */
	textureAddress: number | null;
	/** Resolved buffer offset of the texture image, if resolvable. */
	textureOffset: number | null;
	/** `G_IM_FMT_*`. */
	format: number;
	/** `G_IM_SIZ_*`. */
	size: number;
	/** e.g. `"RGBA16"`. */
	formatName: string;
	/** Texel dimensions from `G_SETTILESIZE`, when known. */
	width: number | null;
	height: number | null;
	/** Segmented address of the TLUT for CI formats, if one was loaded. */
	tlutAddress: number | null;
	/** Resolved buffer offset of the TLUT. */
	tlutOffset: number | null;
	wrapS: WrapMode;
	wrapT: WrapMode;
	/** True if any triangle in this material was drawn with lighting on. */
	lit: boolean;
	/**
	 * Set when the texture lives in a different segment than the
	 * geometry, so it is not present in this buffer at all.
	 *
	 * Common and expected: Zelda 64 object files reference shared
	 * textures (equipment, eyes, mouths) through segments the game
	 * rebinds at runtime, and Super Mario 64 actors pull from the
	 * common-asset segment. `textureOffset` is deliberately left
	 * `null` in that case rather than pointing somewhere plausible
	 * but wrong.
	 */
	externalTexture: boolean;
}

/** A material-bounded run of triangles. */
export interface F3dexGroup {
	materialIndex: number;
	/** Offset into `indices`, in indices (i.e. 3 × triangle offset). */
	firstIndex: number;
	numTriangles: number;
}

/** The geometry produced by interpreting a display list. */
export interface F3dexMesh {
	/** XYZ positions in model space, post matrix-stack transform. */
	positions: Float32Array;
	/** XYZ unit normals; meaningful where the source used lighting. */
	normals: Float32Array;
	/** RGB vertex colours, 0..1; meaningful where lighting was off. */
	colors: Float32Array;
	/** Alpha per vertex, 0..1. */
	alphas: Float32Array;
	/**
	 * UVs. Normalised to 0..1 when the material's texture dimensions
	 * are known; otherwise left in texel units.
	 */
	uvs: Float32Array;
	indices: Uint32Array;
	groups: F3dexGroup[];
	materials: F3dexMaterial[];
	/** True if any geometry was drawn with `G_LIGHTING` enabled. */
	usesLighting: boolean;
	/** Number of display-list commands executed. */
	commandCount: number;
	/**
	 * Commands whose opcode is not valid for this microcode. Real
	 * display lists have essentially none; a high ratio is the
	 * strongest signal that an offset isn't actually a display
	 * list, which is what {@link scanDisplayLists} keys on.
	 */
	unknownCommands: number;
	/** Vertices successfully loaded by `G_VTX`. */
	verticesLoaded: number;
	/**
	 * `G_VTX` commands skipped because they pointed at a segment
	 * other than the one the geometry lives in.
	 *
	 * Resolving those by masking off the segment byte would load
	 * unrelated bytes as vertices, which renders as characteristic
	 * spikes radiating from the model. Skipping them instead leaves
	 * the affected triangles at the origin, and a non-zero count
	 * tells a scanner the model is only partially present.
	 */
	foreignVertexLoads: number;
	/**
	 * Triangle commands rejected because their packed indices were
	 * not exact multiples of the microcode's index scale, or fell
	 * outside the vertex cache. Real display lists produce none —
	 * the `gSP*Triangle` macros always emit exact multiples — so a
	 * non-zero count means either the wrong microcode or bytes that
	 * are not a display list at all.
	 */
	invalidTriangles: number;
	/** Nested display lists entered via `G_DL`. */
	displayListCount: number;
	/** Set when interpretation stopped early (see `truncationReason`). */
	truncated: boolean;
	truncationReason?: string;
}

export interface InterpretOptions {
	microcode?: Microcode;
	resolveSegment?: SegmentResolver;
	/** Abort after this many commands (default 200_000). */
	maxCommands?: number;
	/** Maximum `G_DL` nesting depth (default 32). */
	maxDepth?: number;
	/** Abort after this many triangles (default 200_000). */
	maxTriangles?: number;
	/**
	 * Stop at the first opcode that isn't valid for the microcode
	 * (default false).
	 *
	 * Essential for scanning: without it, a garbage offset keeps
	 * executing until it stumbles onto an `G_ENDDL` byte or reaches
	 * the end of the buffer, which turns a whole-buffer scan into
	 * an O(n²) walk. With it, non-display-list offsets are rejected
	 * after a single command.
	 */
	bailOnUnknown?: boolean;
	/**
	 * Abort once this many commands have executed without drawing a
	 * triangle (default: unlimited).
	 *
	 * Also a scanning safeguard. Some buffers contain long stretches
	 * that decode as valid-but-inert RDP state commands — the RDP
	 * opcode range 0xC0-0xFF is a quarter of all byte values, so
	 * texture data in particular can produce thousands of
	 * "legitimate" commands that never reference geometry. Those
	 * runs are the dominant cost of a naive scan; a real display
	 * list, by contrast, starts drawing almost immediately.
	 */
	maxIdleCommands?: number;
	/**
	 * Initial matrix, row-major, row-vector convention. Defaults to
	 * identity.
	 */
	baseMatrix?: Float32Array;
}

/** One entry of the RSP vertex cache. */
interface CacheEntry {
	x: number;
	y: number;
	z: number;
	s: number;
	t: number;
	r: number;
	g: number;
	b: number;
	a: number;
	nx: number;
	ny: number;
	nz: number;
	lit: boolean;
}

function identityMatrix(): Float32Array {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

/**
 * Read an N64 fixed-point `Mtx` (64 bytes).
 *
 * The SDK stores a matrix as two halves: the first 32 bytes hold
 * the *integer* parts of all 16 elements as s16, the second 32
 * bytes hold the *fractional* parts as u16, giving 15.16 fixed
 * point. Element (i, j)'s integer half sits at `i*8 + j*2`.
 */
function readMatrix(data: Uint8Array, offset: number): Float32Array | null {
	if (offset < 0 || offset + 64 > data.length) return null;
	const m = new Float32Array(16);
	for (let i = 0; i < 4; i++) {
		for (let j = 0; j < 4; j++) {
			const o = i * 8 + j * 2;
			let int = (data[offset + o] << 8) | data[offset + o + 1];
			if (int & 0x8000) int -= 0x10000;
			const frac =
				(data[offset + 32 + o] << 8) | data[offset + 32 + o + 1];
			m[i * 4 + j] = int + frac / 65536;
		}
	}
	return m;
}

/** `a × b`, row-major with row-vector convention. */
function multiplyMatrix(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(16);
	for (let i = 0; i < 4; i++) {
		for (let j = 0; j < 4; j++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += a[i * 4 + k] * b[k * 4 + j];
			out[i * 4 + j] = sum;
		}
	}
	return out;
}

const EMPTY_FLOATS = new Float32Array(0);

/** Growable Float32Array accumulator. */
class FloatBuffer {
	// Starts empty: the scanner constructs an interpreter at every
	// candidate offset, and the overwhelming majority emit no
	// geometry at all. Allocating on first push keeps those free.
	private buf: Float32Array = EMPTY_FLOATS;
	length = 0;
	push(...values: number[]): void {
		if (this.length + values.length > this.buf.length) {
			let cap = this.buf.length || 256;
			while (cap < this.length + values.length) cap *= 2;
			const bigger = new Float32Array(cap);
			bigger.set(this.buf.subarray(0, this.length));
			this.buf = bigger;
		}
		for (const v of values) this.buf[this.length++] = v;
	}
	finish(): Float32Array {
		return this.buf.slice(0, this.length);
	}
}

interface MaterialKeyState {
	timg: number | null;
	format: number;
	size: number;
	width: number | null;
	height: number | null;
	tlut: number | null;
	wrapS: WrapMode;
	wrapT: WrapMode;
}

/**
 * Interpret a display list, returning the geometry it draws.
 *
 * Never throws on malformed input: unresolvable pointers and
 * unknown commands are skipped, and the result's `truncated` flag
 * reports whether a limit was hit. This makes the function safe to
 * point at arbitrary offsets, which the scanner relies on.
 */
export function interpretDisplayList(
	data: Uint8Array,
	startOffset: number,
	options: InterpretOptions = {},
): F3dexMesh {
	const microcode = options.microcode ?? 'f3dex2';
	const ops = opcodesFor(microcode);
	const resolve =
		options.resolveSegment ?? defaultSegmentResolver(data.length);
	const maxCommands = options.maxCommands ?? 200_000;
	const maxDepth = options.maxDepth ?? 32;
	const maxTriangles = options.maxTriangles ?? 200_000;
	const idxScale = triangleIndexScale(microcode);
	const cacheSize = vertexCacheSize(microcode);

	const positions = new FloatBuffer();
	const normals = new FloatBuffer();
	const colors = new FloatBuffer();
	const alphas = new FloatBuffer();
	const uvs = new FloatBuffer();
	const indices: number[] = [];
	const groups: F3dexGroup[] = [];
	const materials: F3dexMaterial[] = [];
	const materialByKey = new Map<string, number>();

	const cache: CacheEntry[] = Array.from({ length: cacheSize }, () => ({
		x: 0, y: 0, z: 0, s: 0, t: 0,
		r: 255, g: 255, b: 255, a: 255,
		nx: 0, ny: 0, nz: 1,
		lit: false,
	}));

	let matrix = options.baseMatrix ?? identityMatrix();
	const matrixStack: Float32Array[] = [];
	let geometryMode = 0;
	let usesLighting = false;
	let commandCount = 0;
	let unknownCommands = 0;
	let verticesLoaded = 0;
	let foreignVertexLoads = 0;
	let invalidTriangles = 0;
	let displayListCount = 0;
	let truncated = false;
	let truncationReason: string | undefined;

	// Texture state.
	let timg: number | null = null;
	let timgFormat = 0;
	let timgSize = 0;
	let tileWidth: number | null = null;
	let tileHeight: number | null = null;
	let tlut: number | null = null;
	let wrapS: WrapMode = 'wrap';
	let wrapT: WrapMode = 'wrap';
	let texScaleS = 1;
	let texScaleT = 1;
	let textureEnabled = false;

	const maxIdleCommands = options.maxIdleCommands ?? Infinity;
	let idleCommands = 0;
	let currentGroup: F3dexGroup | null = null;
	let currentMaterialIndex = -1;
	/**
	 * Segment byte of the first address a `G_VTX` successfully read
	 * from — i.e. the segment this model's data lives in. Texture
	 * pointers outside it are treated as external (see
	 * `F3dexMaterial.externalTexture`), because resolving them by
	 * masking off the segment would decode unrelated bytes as
	 * pixels.
	 */
	let homeSegment: number | null = null;

	const materialIndexFor = (state: MaterialKeyState, lit: boolean): number => {
		const key = [
			state.timg ?? 'none',
			state.format,
			state.size,
			state.width ?? '?',
			state.height ?? '?',
			state.tlut ?? 'none',
			state.wrapS,
			state.wrapT,
		].join('|');
		const existing = materialByKey.get(key);
		if (existing !== undefined) {
			if (lit) materials[existing].lit = true;
			return existing;
		}
		// Only resolve a texture that lives in the same segment as
		// the geometry; anything else is external to this buffer.
		let textureOffset: number | null = null;
		let externalTexture = false;
		if (state.timg !== null) {
			const segment = (state.timg >>> 24) & 0xff;
			if (homeSegment === null || segment === homeSegment) {
				textureOffset = resolve(state.timg);
				if (textureOffset === null) externalTexture = true;
			} else {
				externalTexture = true;
			}
		}
		const index = materials.length;
		materials.push({
			textureAddress: state.timg,
			textureOffset,
			externalTexture,
			format: state.format,
			size: state.size,
			formatName: textureFormatName(state.format, state.size),
			width: state.width,
			height: state.height,
			tlutAddress: state.tlut,
			tlutOffset: state.tlut === null ? null : resolve(state.tlut),
			wrapS: state.wrapS,
			wrapT: state.wrapT,
			lit,
		});
		materialByKey.set(key, index);
		return index;
	};

	/**
	 * Emit one triangle from cache slots, snapshotting their state.
	 *
	 * `a`/`b`/`c` arrive pre-divided by the microcode's index scale,
	 * so a fractional value means the packed byte wasn't a valid
	 * index — treated as invalid rather than silently floored.
	 */
	const emitTriangle = (a: number, b: number, c: number): void => {
		if (
			!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) ||
			a < 0 || a >= cacheSize ||
			b < 0 || b >= cacheSize ||
			c < 0 || c >= cacheSize
		) {
			invalidTriangles++;
			return;
		}
		const lit = (geometryMode & GEOMETRY_MODE.G_LIGHTING) !== 0;
		const state: MaterialKeyState = {
			timg: textureEnabled ? timg : null,
			format: timgFormat,
			size: timgSize,
			width: tileWidth,
			height: tileHeight,
			tlut,
			wrapS,
			wrapT,
		};
		const materialIndex = materialIndexFor(state, lit);
		if (materialIndex !== currentMaterialIndex) {
			currentGroup = {
				materialIndex,
				firstIndex: indices.length,
				numTriangles: 0,
			};
			groups.push(currentGroup);
			currentMaterialIndex = materialIndex;
		}
		idleCommands = 0;
		const mat = materials[materialIndex];
		// Normalise UVs when we know the texture size. N64 vertex
		// s/t are S10.5 texel coordinates, scaled by G_TEXTURE.
		const uDiv = mat.width && mat.width > 0 ? mat.width : null;
		const vDiv = mat.height && mat.height > 0 ? mat.height : null;
		for (const slot of [a, b, c]) {
			const v = cache[slot];
			positions.push(v.x, v.y, v.z);
			normals.push(v.nx, v.ny, v.nz);
			colors.push(v.r / 255, v.g / 255, v.b / 255);
			alphas.push(v.a / 255);
			const su = (v.s * texScaleS) / 32;
			const tv = (v.t * texScaleT) / 32;
			uvs.push(uDiv ? su / uDiv : su, vDiv ? tv / vDiv : tv);
			indices.push(indices.length);
		}
		currentGroup!.numTriangles++;
	};

	const readU32 = (o: number): number =>
		((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>>
		0;

	/** Load `n` vertices into the cache starting at slot `v0`. */
	const loadVertices = (address: number, n: number, v0: number): void => {
		const segment = (address >>> 24) & 0xff;
		if (homeSegment !== null && segment !== homeSegment) {
			// Vertices for this draw live in a segment the game binds
			// at runtime — not in this buffer. See
			// F3dexMesh.foreignVertexLoads.
			foreignVertexLoads++;
			return;
		}
		const base = resolve(address);
		if (base === null) return;
		const lit = (geometryMode & GEOMETRY_MODE.G_LIGHTING) !== 0;
		if (lit) usesLighting = true;
		for (let i = 0; i < n; i++) {
			const slot = v0 + i;
			if (slot < 0 || slot >= cacheSize) continue;
			const o = base + i * 16;
			if (o + 16 > data.length) return;
			let x = (data[o] << 8) | data[o + 1];
			let y = (data[o + 2] << 8) | data[o + 3];
			let z = (data[o + 4] << 8) | data[o + 5];
			if (x & 0x8000) x -= 0x10000;
			if (y & 0x8000) y -= 0x10000;
			if (z & 0x8000) z -= 0x10000;
			let s = (data[o + 8] << 8) | data[o + 9];
			let t = (data[o + 10] << 8) | data[o + 11];
			if (s & 0x8000) s -= 0x10000;
			if (t & 0x8000) t -= 0x10000;
			verticesLoaded++;
			if (homeSegment === null) homeSegment = (address >>> 24) & 0xff;
			const e = cache[slot];
			// Transform by the current matrix (row-vector × row-major).
			e.x = x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12];
			e.y = x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13];
			e.z = x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14];
			e.s = s;
			e.t = t;
			e.lit = lit;
			const c0 = data[o + 12];
			const c1 = data[o + 13];
			const c2 = data[o + 14];
			e.a = data[o + 15];
			if (lit) {
				// Bytes 12-14 are a signed normal when lighting is on.
				const nx = c0 & 0x80 ? c0 - 256 : c0;
				const ny = c1 & 0x80 ? c1 - 256 : c1;
				const nz = c2 & 0x80 ? c2 - 256 : c2;
				const len = Math.hypot(nx, ny, nz) || 1;
				e.nx = nx / len;
				e.ny = ny / len;
				e.nz = nz / len;
				// Keep colour white so a lit model isn't tinted by
				// normal bytes reinterpreted as RGB.
				e.r = e.g = e.b = 255;
			} else {
				e.r = c0;
				e.g = c1;
				e.b = c2;
				e.nx = 0;
				e.ny = 0;
				e.nz = 1;
			}
		}
	};

	/** Execute a display list at `offset`, recursing into `G_DL`. */
	const run = (offset: number, depth: number): void => {
		if (depth > maxDepth) {
			truncated = true;
			truncationReason = `exceeded G_DL depth ${maxDepth}`;
			return;
		}
		let p = offset;
		for (;;) {
			if (p + 8 > data.length) {
				truncated = true;
				truncationReason = 'ran past end of buffer';
				return;
			}
			if (++idleCommands > maxIdleCommands) {
				truncated = true;
				truncationReason = `${maxIdleCommands} commands without geometry`;
				return;
			}
			if (++commandCount > maxCommands) {
				truncated = true;
				truncationReason = `exceeded ${maxCommands} commands`;
				return;
			}
			if (indices.length / 3 > maxTriangles) {
				truncated = true;
				truncationReason = `exceeded ${maxTriangles} triangles`;
				return;
			}
			const w0 = readU32(p);
			const w1 = readU32(p + 4);
			p += 8;
			const op = w0 >>> 24;

			if (op === ops.G_ENDDL) return;
			if (!isValidOpcode(microcode, op)) {
				unknownCommands++;
				if (options.bailOnUnknown) {
					truncated = true;
					truncationReason = `unknown opcode 0x${op
						.toString(16)
						.padStart(2, '0')} at 0x${(p - 8).toString(16)}`;
					return;
				}
			}

			switch (op) {
				case ops.G_VTX: {
					// All three microcodes pack G_VTX differently.
					if (microcode === 'f3dex2') {
						// w0: n in bits 12-19, (v0 + n) in bits 1-7.
						const n = (w0 >>> 12) & 0xff;
						const end = (w0 >>> 1) & 0x7f;
						loadVertices(w1, n, end - n);
					} else if (microcode === 'f3dex') {
						// F3DEX, per gbi.h:
						//   gDma1p(G_VTX, v, (n<<10)|(16n-1), v0*2)
						// so bits 16-23 hold v0 DOUBLED, bits 10-15
						// hold n, and bits 0-9 hold the byte length
						// minus one.
						const n = (w0 >>> 10) & 0x3f;
						const v0 = ((w0 >>> 16) & 0xff) >> 1;
						loadVertices(w1, n, v0);
					} else {
						// Plain F3D (and Rare's variant), per gbi.h:
						//   gDma1p(G_VTX, v, 16n, ((n-1)<<4)|v0)
						// so bits 16-23 hold ((n-1)<<4)|v0 and bits
						// 0-15 hold the byte length.
						const byteLen = w0 & 0xffff;
						const n =
							byteLen >= 16 ? byteLen >> 4 : ((w0 >>> 20) & 0xf) + 1;
						const v0 = (w0 >>> 16) & 0xf;
						loadVertices(w1, n, v0);
					}
					break;
				}
				case ops.G_TRI1: {
					if (microcode === 'f3dex2') {
						emitTriangle(
							((w0 >>> 16) & 0xff) / idxScale,
							((w0 >>> 8) & 0xff) / idxScale,
							(w0 & 0xff) / idxScale,
						);
					} else {
						emitTriangle(
							((w1 >>> 16) & 0xff) / idxScale,
							((w1 >>> 8) & 0xff) / idxScale,
							(w1 & 0xff) / idxScale,
						);
					}
					break;
				}
				case ops.G_TRI2: {
					if (microcode === 'f3dex2') {
						emitTriangle(
							((w0 >>> 16) & 0xff) / idxScale,
							((w0 >>> 8) & 0xff) / idxScale,
							(w0 & 0xff) / idxScale,
						);
						emitTriangle(
							((w1 >>> 16) & 0xff) / idxScale,
							((w1 >>> 8) & 0xff) / idxScale,
							(w1 & 0xff) / idxScale,
						);
					} else {
						// F3DEX packs the first triangle in w0's low
						// 24 bits and the second in w1.
						emitTriangle(
							((w0 >>> 16) & 0xff) / idxScale,
							((w0 >>> 8) & 0xff) / idxScale,
							(w0 & 0xff) / idxScale,
						);
						emitTriangle(
							((w1 >>> 16) & 0xff) / idxScale,
							((w1 >>> 8) & 0xff) / idxScale,
							(w1 & 0xff) / idxScale,
						);
					}
					break;
				}
				case ops.G_TRI4: {
					// Rare's four-triangles-per-command form. Each
					// triangle's three indices are 4-bit nibbles
					// spread across both words; a triangle whose
					// indices are all zero is a padding slot and is
					// not drawn.
					for (let t = 0; t < 4; t++) {
						const x = (w1 >>> (t * 8)) & 0xf;
						const y = (w1 >>> (t * 8 + 4)) & 0xf;
						const z = (w0 >>> (t * 4)) & 0xf;
						if (x === 0 && y === 0 && z === 0) continue;
						emitTriangle(x, y, z);
					}
					break;
				}
				case ops.G_QUAD: {
					// F3DEX2 only: two triangles sharing an edge.
					const a = ((w0 >>> 16) & 0xff) / idxScale;
					const b = ((w0 >>> 8) & 0xff) / idxScale;
					const c = (w0 & 0xff) / idxScale;
					const d = (w1 & 0xff) / idxScale;
					emitTriangle(a, b, c);
					emitTriangle(a, c, d);
					break;
				}
				case ops.G_MTX: {
					const loaded = readMatrix(data, resolve(w1) ?? -1);
					if (loaded) {
						let params = (w0 >>> 16) & 0xff;
						// F3DEX2 stores the push flag inverted.
						if (microcode === 'f3dex2') params ^= 0x01;
						const push = (params & 0x01) !== 0;
						const load = (params & 0x02) !== 0;
						if (push) matrixStack.push(matrix);
						matrix = load ? loaded : multiplyMatrix(loaded, matrix);
					}
					break;
				}
				case ops.G_POPMTX: {
					const popped = matrixStack.pop();
					if (popped) matrix = popped;
					break;
				}
				case ops.G_DL: {
					const target = resolve(w1);
					// Param bit 0 set = branch (no return).
					const branch = ((w0 >>> 16) & 0xff & 0x01) !== 0;
					if (target !== null) {
						displayListCount++;
						if (branch) {
							p = target;
							continue;
						}
						run(target, depth + 1);
					}
					break;
				}
				case ops.G_SETGEOMETRYMODE:
					geometryMode |= w1;
					break;
				case ops.G_CLEARGEOMETRYMODE:
					geometryMode &= ~w1;
					break;
				case ops.G_GEOMETRYMODE:
					// F3DEX2: clear the bits in ~w0, then set w1.
					geometryMode &= w0 & 0x00ffffff;
					geometryMode |= w1;
					break;
				case ops.G_TEXTURE: {
					// scaleS/scaleT are u16 where 0xFFFF ≈ 1.0.
					const s = (w1 >>> 16) & 0xffff;
					const t = w1 & 0xffff;
					texScaleS = s === 0 ? 1 : s / 65536;
					texScaleT = t === 0 ? 1 : t / 65536;
					// Round the common 0xFFFF case to exactly 1.
					if (s >= 0xfffe) texScaleS = 1;
					if (t >= 0xfffe) texScaleT = 1;
					const on = microcode === 'f3dex2' ? (w0 >>> 1) & 0x7f : w1 & 0xff;
					textureEnabled = microcode === 'f3dex2' ? on !== 0 : true;
					break;
				}
				case RDP.G_SETTIMG: {
					timg = w1;
					timgFormat = (w0 >>> 21) & 0x07;
					timgSize = (w0 >>> 19) & 0x03;
					textureEnabled = true;
					break;
				}
				case RDP.G_SETTILE: {
					// Wrap modes for the render tile (tile 0).
					const tile = (w1 >>> 24) & 0x07;
					if (tile === 0) {
						wrapT = wrapModeFor((w1 >>> 18) & 0x03);
						wrapS = wrapModeFor((w1 >>> 8) & 0x03);
					}
					break;
				}
				case RDP.G_SETTILESIZE: {
					const uls = (w0 >>> 12) & 0xfff;
					const ult = w0 & 0xfff;
					const lrs = (w1 >>> 12) & 0xfff;
					const lrt = w1 & 0xfff;
					// S10.2 fixed point; inclusive bounds.
					const w = ((lrs - uls) >> 2) + 1;
					const h = ((lrt - ult) >> 2) + 1;
					tileWidth = w > 0 && w <= 1024 ? w : null;
					tileHeight = h > 0 && h <= 1024 ? h : null;
					break;
				}
				case RDP.G_LOADTLUT: {
					// The palette address is whatever G_SETTIMG last
					// set — the RDP loads from the current image.
					tlut = timg;
					break;
				}
				default:
					// Everything else (sync, combiner, blender,
					// scissor, fill colours, MOVEMEM/MOVEWORD, …)
					// does not affect the geometry we extract.
					break;
			}
		}
	};

	run(startOffset, 0);

	return {
		positions: positions.finish(),
		normals: normals.finish(),
		colors: colors.finish(),
		alphas: alphas.finish(),
		uvs: uvs.finish(),
		indices: Uint32Array.from(indices),
		groups,
		materials,
		usesLighting,
		commandCount,
		unknownCommands,
		verticesLoaded,
		foreignVertexLoads,
		invalidTriangles,
		displayListCount,
		truncated,
		truncationReason,
	};
}
