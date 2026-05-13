import { describe, expect, it } from 'vitest';
import {
	parseStaticMeshFromTail,
	StaticMeshParseError,
} from '../src/index.js';

/**
 * Synthetic .uexp-tail builder for a cooked UE 4.27 StaticMesh.
 *
 * Layout matches what `parseStaticMeshFromTail` consumes:
 *   bSerializeGuid (u32)
 *   FStripDataFlags (2 bytes)
 *   bCooked (u32, must be 1)
 *   BodySetup, NavCollision (2 × i32 — FPackageIndex, can be zero)
 *   FGuid LightingGuid (16 bytes)
 *   Sockets TArray (i32 count + count × i32 — zero count is the easy case)
 *   FStaticMeshRenderData:
 *     i32 NumLODs
 *     [one or more inlined LODs]
 *     u8 NumInlinedLODs
 *     FStripDataFlags DistanceField (no DistanceField data follows here)
 *     FBoxSphereBounds (7 × float)
 *     bool bLODsShareStaticLighting (u32)
 *     8 × (bool, float) per-platform ScreenSize entries
 *
 * Every byte is synthesized — no commercial-game data.
 */

class Writer {
	bytes: number[] = [];
	u8(v: number): this { this.bytes.push(v & 0xff); return this; }
	u16(v: number): this {
		this.bytes.push(v & 0xff, (v >> 8) & 0xff);
		return this;
	}
	u32(v: number): this {
		this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
		return this;
	}
	i32(v: number): this {
		return this.u32(v);
	}
	f32(v: number): this {
		const buf = new ArrayBuffer(4);
		new DataView(buf).setFloat32(0, v, true);
		const u8 = new Uint8Array(buf);
		this.bytes.push(u8[0]!, u8[1]!, u8[2]!, u8[3]!);
		return this;
	}
	zeros(n: number): this {
		for (let i = 0; i < n; i++) this.bytes.push(0);
		return this;
	}
	concat(buf: Uint8Array): this {
		for (const b of buf) this.bytes.push(b);
		return this;
	}
	get length(): number { return this.bytes.length; }
	finish(): Uint8Array { return new Uint8Array(this.bytes); }
}

/**
 * Encode a normal vector (x, y, z) ∈ [-1, 1]³ to the FPackedNormal
 * on-disk representation: each component is mapped to 0..255 via
 * `round((v + 1) * 127.5)`, then XOR'd with 0x80 to match the
 * UE 4.20+ on-disk bias-flip.
 */
function encodePackedNormal(x: number, y: number, z: number, w = 1): Uint8Array {
	const out = new Uint8Array(4);
	out[0] = (Math.round((x + 1) * 127.5) & 0xff) ^ 0x80;
	out[1] = (Math.round((y + 1) * 127.5) & 0xff) ^ 0x80;
	out[2] = (Math.round((z + 1) * 127.5) & 0xff) ^ 0x80;
	out[3] = (Math.round((w + 1) * 127.5) & 0xff) ^ 0x80;
	return out;
}

interface SyntheticLOD {
	vertices: Array<{ x: number; y: number; z: number }>;
	normals: Array<{ x: number; y: number; z: number }>;
	uvs: Array<{ u: number; v: number }>;
	indices: number[];
	sections: Array<{ firstIndex: number; numTriangles: number; minVertex: number; maxVertex: number }>;
}

function writeLOD(w: Writer, lod: SyntheticLOD): void {
	// LOD strip flags + sections + maxDev + isCookedOut + inlined.
	w.u8(0x01).u8(0x00);                          // editor-stripped
	w.i32(lod.sections.length);
	for (const s of lod.sections) {
		w.i32(0);                                  // materialIndex
		w.i32(s.firstIndex);
		w.i32(s.numTriangles);
		w.i32(s.minVertex);
		w.i32(s.maxVertex);
		w.u32(1);                                  // enableCollision
		w.u32(1);                                  // castShadow
		w.u32(0);                                  // forceOpaque
		w.u32(1);                                  // visibleInRayTracing
	}
	w.f32(0);                                      // MaxDeviation
	w.u32(0);                                      // bIsLODCookedOut
	w.u32(1);                                      // bInlined
	// SerializeBuffers — strip flags first.
	w.u8(0x01).u8(0x00);                          // buffer strip flags (editor stripped only)
	// PositionVertexBuffer
	w.i32(12).i32(lod.vertices.length);            // Stride + NumVertices
	w.i32(12).i32(lod.vertices.length);            // BulkSerialize: EltSize + Count
	for (const v of lod.vertices) {
		w.f32(v.x).f32(v.y).f32(v.z);
	}
	// StaticMeshVertexBuffer
	w.u8(0x01).u8(0x00);                          // SMVB strip flags
	w.i32(1);                                      // NumTexCoords = 1
	w.i32(lod.vertices.length);                    // NumVertices
	w.u32(1);                                      // bUseFullPrecisionUVs = true (easier to test)
	w.u32(0);                                      // bUseHighPrecisionTangentBasis = false
	// Tangents BulkSerialize: 8 bytes per vertex.
	w.i32(8).i32(lod.vertices.length);
	for (let i = 0; i < lod.vertices.length; i++) {
		// TangentX = +X axis, TangentZ = supplied normal.
		w.concat(encodePackedNormal(1, 0, 0));
		const n = lod.normals[i]!;
		w.concat(encodePackedNormal(n.x, n.y, n.z));
	}
	// UVs BulkSerialize: 8 bytes per UV (full precision).
	w.i32(8).i32(lod.vertices.length);
	for (const uv of lod.uvs) {
		w.f32(uv.u).f32(uv.v);
	}
	// ColorVertexBuffer (empty: NumVertices = 0 skips the BulkSerialize header).
	w.u8(0x01).u8(0x00);                          // strip flags
	w.i32(4).i32(0);                               // Stride, NumVertices = 0
	// Index buffer.
	w.u32(0);                                      // b32Bit = false (16-bit indices)
	w.i32(1).i32(lod.indices.length * 2);          // BulkSerialize<u8>
	for (const idx of lod.indices) w.u16(idx);
	w.u32(0);                                      // bShouldExpandTo32Bit
	// ReversedIndexBuffer (always present unless CDSF_ReversedIndexBuffer set; ours isn't).
	w.u32(0).i32(1).i32(0).u32(0);                 // empty
	// DepthOnlyIndexBuffer (always present).
	w.u32(0).i32(1).i32(0).u32(0);
	// ReversedDepthOnlyIndexBuffer.
	w.u32(0).i32(1).i32(0).u32(0);
	// AdjacencyIndexBuffer (CDSF_AdjacencyData bit not set in our strip).
	w.u32(0).i32(1).i32(0).u32(0);
	// Ray-tracing geometry (CDSF_RayTracingResources bit not set).
	w.i32(1).i32(0);                               // BulkSerialize<u8>, empty
	// Samplers: one per section + one global.
	for (let i = 0; i < lod.sections.length + 1; i++) {
		w.i32(0);                                  // Prob[]
		w.i32(0);                                  // Alias[]
		w.f32(0);                                  // TotalWeight
	}
	// Buffers-size trailer (3 × u32).
	w.u32(0).u32(0).u32(0);
}

function buildMeshTail(lods: SyntheticLOD[], bounds?: { sphereRadius: number }): Uint8Array {
	const w = new Writer();
	// bSerializeGuid + (no guid) + StripFlags + bCooked.
	w.u32(0);
	w.u8(0x01).u8(0x00);                          // editor stripped, no class flags
	w.u32(1);                                      // bCooked
	// BodySetup + NavCollision (None).
	w.i32(0).i32(0);
	// LightingGuid.
	w.zeros(16);
	// Sockets (empty).
	w.i32(0);
	// FStaticMeshRenderData.
	w.i32(lods.length);                            // NumLODs
	for (const lod of lods) writeLOD(w, lod);
	w.u8(lods.length);                             // NumInlinedLODs
	// DistanceField strip flags (DataStrippedForServer set to skip the per-LOD volumes).
	w.u8(0x02).u8(0x00);
	// Bounds (small unit cube).
	w.f32(0).f32(0).f32(0);
	w.f32(1).f32(1).f32(1);
	w.f32(bounds?.sphereRadius ?? Math.sqrt(3));
	// bLODsShareStaticLighting.
	w.u32(0);
	// 8 × (bool, float) ScreenSize entries.
	for (let i = 0; i < 8; i++) w.u32(0).f32(1);
	return w.finish();
}

const UNIT_NORMAL_Z = { x: 0, y: 0, z: 1 };

describe('parseStaticMeshFromTail', () => {
	it('decodes a single triangle with one vertex shared by section bookkeeping', () => {
		const lod: SyntheticLOD = {
			vertices: [
				{ x: 0, y: 0, z: 0 },
				{ x: 1, y: 0, z: 0 },
				{ x: 0, y: 1, z: 0 },
			],
			normals: [UNIT_NORMAL_Z, UNIT_NORMAL_Z, UNIT_NORMAL_Z],
			uvs: [
				{ u: 0, v: 0 },
				{ u: 1, v: 0 },
				{ u: 0, v: 1 },
			],
			indices: [0, 1, 2],
			sections: [{ firstIndex: 0, numTriangles: 1, minVertex: 0, maxVertex: 2 }],
		};
		const tail = buildMeshTail([lod]);
		const mesh = parseStaticMeshFromTail(tail);
		expect(mesh.lods).toHaveLength(1);
		const out = mesh.lods[0]!;
		expect(out.numVertices).toBe(3);
		expect(out.indices.length).toBe(3);
		expect(Array.from(out.indices)).toEqual([0, 1, 2]);
		expect(out.sections).toHaveLength(1);
		expect(out.sections[0]!.numTriangles).toBe(1);
	});

	it('decodes vertex positions exactly', () => {
		const lod: SyntheticLOD = {
			vertices: [
				{ x: 1.5, y: -2.25, z: 7.125 },
				{ x: 100, y: 0, z: -50 },
				{ x: 0.5, y: 0.5, z: 0.5 },
			],
			normals: [UNIT_NORMAL_Z, UNIT_NORMAL_Z, UNIT_NORMAL_Z],
			uvs: [
				{ u: 0, v: 0 },
				{ u: 0, v: 0 },
				{ u: 0, v: 0 },
			],
			indices: [0, 1, 2],
			sections: [{ firstIndex: 0, numTriangles: 1, minVertex: 0, maxVertex: 2 }],
		};
		const tail = buildMeshTail([lod]);
		const mesh = parseStaticMeshFromTail(tail);
		const p = mesh.lods[0]!.positions;
		expect(p[0]).toBeCloseTo(1.5);
		expect(p[1]).toBeCloseTo(-2.25);
		expect(p[2]).toBeCloseTo(7.125);
		expect(p[3]).toBeCloseTo(100);
		expect(p[4]).toBeCloseTo(0);
		expect(p[5]).toBeCloseTo(-50);
	});

	it('decodes packed normals to unit vectors (within quantization tolerance)', () => {
		const lod: SyntheticLOD = {
			vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
			normals: [
				{ x: 0, y: 0, z: 1 },        // up
				{ x: 1, y: 0, z: 0 },        // right
				{ x: 0, y: -1, z: 0 },       // back
			],
			uvs: [{ u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }],
			indices: [0, 1, 2],
			sections: [{ firstIndex: 0, numTriangles: 1, minVertex: 0, maxVertex: 2 }],
		};
		const tail = buildMeshTail([lod]);
		const mesh = parseStaticMeshFromTail(tail);
		const n = mesh.lods[0]!.normals;
		// Each component should round-trip within ~1/127.5 = 0.0079 tolerance.
		expect(n[0]).toBeCloseTo(0, 1);   // up.x
		expect(n[1]).toBeCloseTo(0, 1);   // up.y
		expect(n[2]).toBeCloseTo(1, 1);   // up.z
		expect(n[3]).toBeCloseTo(1, 1);   // right.x
		expect(n[7]).toBeCloseTo(-1, 1);  // back.y
	});

	it('decodes UVs from a full-precision buffer', () => {
		const lod: SyntheticLOD = {
			vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
			normals: [UNIT_NORMAL_Z, UNIT_NORMAL_Z, UNIT_NORMAL_Z],
			uvs: [
				{ u: 0, v: 0 },
				{ u: 1, v: 0 },
				{ u: 0.5, v: 0.25 },
			],
			indices: [0, 1, 2],
			sections: [{ firstIndex: 0, numTriangles: 1, minVertex: 0, maxVertex: 2 }],
		};
		const tail = buildMeshTail([lod]);
		const mesh = parseStaticMeshFromTail(tail);
		const uvs = mesh.lods[0]!.uvs[0]!;
		expect(uvs[4]).toBeCloseTo(0.5);
		expect(uvs[5]).toBeCloseTo(0.25);
	});

	it('reports section bookkeeping verbatim', () => {
		const lod: SyntheticLOD = {
			vertices: Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0, z: 0 })),
			normals: Array.from({ length: 6 }, () => UNIT_NORMAL_Z),
			uvs: Array.from({ length: 6 }, () => ({ u: 0, v: 0 })),
			indices: [0, 1, 2, 3, 4, 5],
			sections: [
				{ firstIndex: 0, numTriangles: 1, minVertex: 0, maxVertex: 2 },
				{ firstIndex: 3, numTriangles: 1, minVertex: 3, maxVertex: 5 },
			],
		};
		const tail = buildMeshTail([lod]);
		const mesh = parseStaticMeshFromTail(tail);
		const sections = mesh.lods[0]!.sections;
		expect(sections).toHaveLength(2);
		expect(sections[0]!.firstIndex).toBe(0);
		expect(sections[1]!.firstIndex).toBe(3);
		expect(sections[0]!.maxVertexIndex).toBe(2);
	});

	it('reports the FBoxSphereBounds from the render data', () => {
		const lod: SyntheticLOD = {
			vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
			normals: [UNIT_NORMAL_Z, UNIT_NORMAL_Z, UNIT_NORMAL_Z],
			uvs: [{ u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }],
			indices: [0, 1, 2],
			sections: [{ firstIndex: 0, numTriangles: 1, minVertex: 0, maxVertex: 2 }],
		};
		const tail = buildMeshTail([lod], { sphereRadius: 7.5 });
		const mesh = parseStaticMeshFromTail(tail);
		expect(mesh.bounds?.sphereRadius).toBeCloseTo(7.5);
		expect(mesh.bounds?.extentX).toBeCloseTo(1);
	});

	it('throws on uncooked input', () => {
		const w = new Writer();
		w.u32(0);                                  // bSerializeGuid
		w.u8(0).u8(0);                             // strip flags (no stripping)
		w.u32(0);                                  // bCooked = 0
		expect(() => parseStaticMeshFromTail(w.finish())).toThrowError(StaticMeshParseError);
	});
});
