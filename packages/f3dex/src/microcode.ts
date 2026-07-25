/**
 * N64 RSP graphics microcode command tables.
 *
 * The Nintendo 64 has no "model format". Geometry is delivered to
 * the Reality Signal Processor as a *display list*: a stream of
 * 64-bit commands, each an 8-bit opcode plus 56 bits of payload.
 * The opcode numbering depends on which microcode ("ucode") the
 * game linked against, and the three that matter in practice are:
 *
 *   • F3D     — the original Fast3D. Super Mario 64, Wave Race 64,
 *               most 1996-97 titles.
 *   • F3DEX   — Fast3D EXtended. Larger vertex cache (32), adds
 *               two-triangle and branch commands. Mario Kart 64,
 *               Star Fox 64, mid-generation titles.
 *   • F3DEX2  — the rewrite shipped with SDK 2.0. Completely
 *               renumbered RSP opcodes. Ocarina of Time, Majora's
 *               Mask, Paper Mario, late titles.
 *
 * RSP opcodes differ between F3D/F3DEX and F3DEX2. RDP opcodes
 * (0xC0 and above — the `G_SET*` / `G_LOAD*` rasteriser state) are
 * shared, because they are consumed by fixed-function hardware
 * rather than the microcode.
 *
 * References:
 *   - N64 SDK `gbi.h` (the authoritative opcode + macro source)
 *   - https://hack64.net/wiki/doku.php?id=f3dex2 (F3DEX2 notes)
 *   - https://wiki.cloudmodding.com/oot/F3DZEX (Zelda's F3DEX2 variant)
 */

/**
 * Which microcode a display list is encoded for.
 *
 * `rare` is Rare's in-house variant used by GoldenEye 007 and
 * Perfect Dark: plain-F3D opcodes and `G_VTX` packing, but with
 * `G_TRI2` (0xB1) replaced by a `G_TRI4` that draws up to four
 * triangles from 4-bit vertex indices. See {@link RARE_OPS}.
 */
export type Microcode = 'f3d' | 'f3dex' | 'f3dex2' | 'rare';

/**
 * RDP (rasteriser) opcodes. Identical across microcodes since the
 * RDP is fixed-function hardware.
 */
export const RDP = {
	G_NOOP: 0xc0,
	G_SETCIMG: 0xff,
	G_SETZIMG: 0xfe,
	G_SETTIMG: 0xfd,
	G_SETCOMBINE: 0xfc,
	G_SETENVCOLOR: 0xfb,
	G_SETPRIMCOLOR: 0xfa,
	G_SETBLENDCOLOR: 0xf9,
	G_SETFOGCOLOR: 0xf8,
	G_SETFILLCOLOR: 0xf7,
	G_FILLRECT: 0xf6,
	G_SETTILE: 0xf5,
	G_LOADTILE: 0xf4,
	G_LOADBLOCK: 0xf3,
	G_SETTILESIZE: 0xf2,
	G_LOADTLUT: 0xf0,
	G_RDPSETOTHERMODE: 0xef,
	G_SETPRIMDEPTH: 0xee,
	G_SETSCISSOR: 0xed,
	G_SETCONVERT: 0xec,
	G_SETKEYR: 0xeb,
	G_SETKEYGB: 0xea,
	G_RDPFULLSYNC: 0xe9,
	G_RDPTILESYNC: 0xe8,
	G_RDPPIPESYNC: 0xe7,
	G_RDPLOADSYNC: 0xe6,
	G_TEXRECTFLIP: 0xe5,
	G_TEXRECT: 0xe4,
} as const;

/**
 * The RSP opcodes this interpreter acts on, resolved per microcode.
 * Opcodes absent from a given microcode are set to -1 so they can
 * never match a real command byte.
 */
export interface RspOpcodes {
	G_VTX: number;
	G_MODIFYVTX: number;
	G_CULLDL: number;
	G_BRANCH_Z: number;
	G_TRI1: number;
	G_TRI2: number;
	/** Rare only: four triangles from nibble-packed indices. */
	G_TRI4: number;
	G_QUAD: number;
	G_DL: number;
	G_ENDDL: number;
	G_MTX: number;
	G_POPMTX: number;
	G_MOVEMEM: number;
	G_MOVEWORD: number;
	G_TEXTURE: number;
	/** F3D/F3DEX: separate set/clear. F3DEX2: single G_GEOMETRYMODE. */
	G_SETGEOMETRYMODE: number;
	G_CLEARGEOMETRYMODE: number;
	G_GEOMETRYMODE: number;
	G_SETOTHERMODE_H: number;
	G_SETOTHERMODE_L: number;
	G_RDPHALF_1: number;
	G_RDPHALF_2: number;
	G_SPNOOP: number;
	G_LOAD_UCODE: number;
}

const F3D_OPS: RspOpcodes = {
	G_SPNOOP: 0x00,
	G_MTX: 0x01,
	G_MOVEMEM: 0x03,
	G_VTX: 0x04,
	G_DL: 0x06,
	// F3DEX additions; harmless to accept in F3D mode too since the
	// opcodes are otherwise unused there.
	G_BRANCH_Z: 0xb0,
	G_TRI2: 0xb1,
	G_TRI4: -1,
	G_MODIFYVTX: 0xb2,
	G_RDPHALF_1: 0xb4,
	G_LOAD_UCODE: 0xaf,
	G_CLEARGEOMETRYMODE: 0xb6,
	G_SETGEOMETRYMODE: 0xb7,
	G_ENDDL: 0xb8,
	G_SETOTHERMODE_L: 0xb9,
	G_SETOTHERMODE_H: 0xba,
	G_TEXTURE: 0xbb,
	G_MOVEWORD: 0xbc,
	G_POPMTX: 0xbd,
	G_CULLDL: 0xbe,
	G_TRI1: 0xbf,
	// Not present in F3D/F3DEX.
	G_GEOMETRYMODE: -1,
	G_QUAD: -1,
	G_RDPHALF_2: -1,
};

const F3DEX2_OPS: RspOpcodes = {
	G_SPNOOP: 0x00,
	G_VTX: 0x01,
	G_MODIFYVTX: 0x02,
	G_CULLDL: 0x03,
	G_BRANCH_Z: 0x04,
	G_TRI1: 0x05,
	G_TRI2: 0x06,
	G_TRI4: -1,
	G_QUAD: 0x07,
	G_TEXTURE: 0xd7,
	G_POPMTX: 0xd8,
	G_GEOMETRYMODE: 0xd9,
	G_MTX: 0xda,
	G_MOVEWORD: 0xdb,
	G_MOVEMEM: 0xdc,
	G_LOAD_UCODE: 0xdd,
	G_DL: 0xde,
	G_ENDDL: 0xdf,
	G_SETOTHERMODE_H: 0xe3,
	G_SETOTHERMODE_L: 0xe2,
	G_RDPHALF_1: 0xe1,
	G_RDPHALF_2: 0xf1,
	// Not present in F3DEX2 (folded into G_GEOMETRYMODE).
	G_SETGEOMETRYMODE: -1,
	G_CLEARGEOMETRYMODE: -1,
};

/**
 * Rare's microcode (GoldenEye 007, Perfect Dark).
 *
 * Identical to F3D except that opcode 0xB1 — `G_TRI2` in F3DEX — is
 * `G_TRI4`, and 0xC0 (`G_NOOP` in stock GBI) is a bespoke `G_SETTEX`.
 * Documented in the GoldenEye decompilation's
 * `include/gbi_extension.h`:
 *
 *   B1  rsp_tri4 — draws up to four triangles at a time. Expects
 *   values from 0-F corresponding with the points declared by the
 *   vertex command. Triangles with all points set to 0 are not
 *   drawn.
 *
 *     w0:  0000F000 z4 | 00000F00 z3 | 000000F0 z2 | 0000000F z1
 *     w1:  f0000000 y4 | 0f000000 x4 | 00f00000 y3 | 000f0000 x3
 *          0000f000 y2 | 00000f00 x2 | 000000f0 y1 | 0000000f x1
 *
 * Triangle *i* is `(x_i, y_i, z_i)`. Packing three indices into 12
 * bits caps the vertex cache at 16 entries; the decomp notes Rare
 * accepted extra RSP work to save RDRAM.
 */
const RARE_OPS: RspOpcodes = {
	...F3D_OPS,
	// 0xB1 is G_TRI4 here, not G_TRI2.
	G_TRI2: -1,
	G_TRI4: 0xb1,
};

/** Resolve the RSP opcode table for a microcode. */
export function opcodesFor(microcode: Microcode): RspOpcodes {
	if (microcode === 'f3dex2') return F3DEX2_OPS;
	if (microcode === 'rare') return RARE_OPS;
	return F3D_OPS;
}

/** Lazily-built lookup of every opcode meaningful to a microcode. */
const VALID_OPCODES = new Map<Microcode, Set<number>>();

/**
 * Is `opcode` meaningful for this microcode (RSP or RDP)?
 *
 * Exported for scanners: testing one byte is far cheaper than
 * spinning up an interpreter, and it rejects the overwhelming
 * majority of candidate offsets immediately.
 */
export function isValidOpcode(microcode: Microcode, opcode: number): boolean {
	let set = VALID_OPCODES.get(microcode);
	if (!set) {
		set = new Set<number>();
		for (const value of Object.values(opcodesFor(microcode))) {
			if (typeof value === 'number' && value >= 0) set.add(value);
		}
		for (const value of Object.values(RDP)) set.add(value);
		VALID_OPCODES.set(microcode, set);
	}
	return set.has(opcode);
}

/**
 * Vertex cache size, in entries.
 *
 * Per the SDK's `gbi.h`: plain F3D holds 16 transformed vertices,
 * while "F3DEX_GBI: G_VTX GBI format was changed to support 64
 * vertice[s]" — and F3DEX2's `v0+n` field is 7 bits wide, likewise
 * allowing 64. Rare's microcode packs triangle indices as 4-bit
 * nibbles, so it can only address 16.
 */
export function vertexCacheSize(microcode: Microcode): number {
	if (microcode === 'f3d' || microcode === 'rare') return 16;
	return 64;
}

/**
 * Divisor applied to the packed triangle index bytes.
 *
 * The `gSP1Triangle` macros pre-multiply cache indices so the RSP
 * can use them as byte offsets without shifting. The multiplier is
 * the size of a vertex entry in the RSP's transformed-vertex cache,
 * which differs per microcode:
 *
 *   F3D     ×10  (packed 10-byte cache entries)
 *   F3DEX   ×2
 *   F3DEX2  ×2
 *
 * Getting this wrong is self-detecting rather than silently
 * corrupting: dividing an F3DEX stream by 10 yields fractional
 * indices, which {@link interpretDisplayList} counts as
 * `invalidTriangles`.
 */
export function triangleIndexScale(microcode: Microcode): number {
	// Rare kept F3D's G_TRI1 (indices x10) alongside its own G_TRI4;
	// gbi_extension.h notes "to use a higher index use gSP1Triangle".
	return microcode === 'f3d' || microcode === 'rare' ? 10 : 2;
}

/** Geometry-mode bits we care about (same values in all microcodes). */
export const GEOMETRY_MODE = {
	G_ZBUFFER: 0x00000001,
	G_SHADE: 0x00000004,
	G_CULL_FRONT: 0x00000200,
	G_CULL_BACK: 0x00000400,
	G_FOG: 0x00010000,
	G_LIGHTING: 0x00020000,
	G_TEXTURE_GEN: 0x00040000,
	G_TEXTURE_GEN_LINEAR: 0x00080000,
	G_SHADING_SMOOTH: 0x00200000,
} as const;

/**
 * F3DEX2 uses different bit positions for the cull flags than
 * F3D/F3DEX. Only relevant if a caller wants to honour culling.
 */
export const GEOMETRY_MODE_F3DEX2 = {
	G_CULL_FRONT: 0x00000200,
	G_CULL_BACK: 0x00000400,
} as const;
