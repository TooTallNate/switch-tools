/**
 * FFVIII `.mch` (Model Character) preview.
 *
 * `d###.mch`, `o###.mch`, `p###.mch` — PSX-style skinned meshes
 * for FFVIII's field characters. Each standalone file pairs a
 * packed TIM TOC at offset 0 with one or more embedded TIM
 * textures plus an MCH body (`ModelHeader` + bones + vertices +
 * faces + skin objects + animation track).
 *
 * Rendering pipeline:
 *
 *   1. {@link parseMch} discovers the body offset from the TIM
 *      TOC (the high nibble of the first dword encodes how many
 *      additional TIM entries follow before the 0xFFFFFFFF
 *      terminator).
 *   2. Each {@link embeddedTimOffsets} is sliced from the file
 *      and decoded to RGBA via {@link parseTim}.
 *   3. We emit per-face vertex data (one unique vertex per
 *      face corner) so each face can have its own UV coords
 *      without affecting sibling faces sharing the same
 *      vertex.
 *   4. The vertex→bone mapping comes from the MCH's
 *      {@link McbSkin} list (vertex ranges → bones), unlike
 *      the FF8 battle DAT where it's per-vertex.
 *   5. Skinning math matches FF8 battle (parent-Z offset by
 *      parent.boneSize, intrinsic YXZ Euler from bone
 *      rotations). Bone 0 is the root (parentId == 0).
 *
 * The animation track typically has 1 frame (bind pose) for
 * standalone d###.mch files — per-scene override animations
 * live in the scene's chara.one and aren't bridged here yet.
 */
import { useEffect, useMemo } from "react"
import * as THREE from "three"
import {
	isDummyMch,
	parseMch,
	parseTim,
	type McbFace,
	type ParsedMch,
	type ParsedTim,
} from "@tootallnate/ff8-model"

import type { Node } from "~/lib/archive"
import {
	ErrorFiller,
	LoadingFiller,
	useAsync,
} from "./preview-pane"
import {
	MeshViewer,
	type MeshViewerAnimation,
	type MeshViewerAnimationDriver,
	type RenderableMesh,
	type RenderableMeshLOD,
	type RenderableMeshSection,
} from "./mesh-viewer"
import type { DecodedTexture } from "~/lib/uasset-material-chain"
import { ScrollArea } from "./ui/scroll-area"
import { Separator } from "./ui/separator"

// ---------------------------------------------------------------------------
// TIM slicing
// ---------------------------------------------------------------------------

/**
 * Slice an MCH file's embedded TIMs by walking the TOC offsets
 * and using each TIM's tail (next TIM offset, or modelOffset for
 * the last) as the implicit end.
 */
function sliceAndDecodeTims(
	bytes: Uint8Array,
	mch: ParsedMch,
): (ParsedTim | null)[] {
	if (!mch.embeddedTimOffsets || mch.bodyOffset === undefined) return []
	const offs = mch.embeddedTimOffsets
	const tims: (ParsedTim | null)[] = []
	for (let i = 0; i < offs.length; i++) {
		const start = offs[i]!
		const end = i + 1 < offs.length ? offs[i + 1]! : mch.bodyOffset
		if (end <= start || end > bytes.length) {
			tims.push(null)
			continue
		}
		try {
			tims.push(parseTim(bytes.subarray(start, end)))
		} catch {
			tims.push(null)
		}
	}
	return tims
}

// ---------------------------------------------------------------------------
// Skinned-rig builder
// ---------------------------------------------------------------------------

interface MeshPiece {
	boneIndex: number
	/** Indices into the final per-face vertex stream (positions[]). */
	vertexIndices: number[]
	/**
	 * Per-corner bone-local positions (xyz triplets, length =
	 * `vertexIndices.length * 3`). These are the vertex coords
	 * AFTER the OpenVIII basis swap `(X, Y, Z) → (-X/S, -Y/S, Z/S)`
	 * but BEFORE any bone-matrix application — the skinning
	 * pass multiplies each one by `matrices[boneIndex]` to
	 * produce the world-space position.
	 */
	localPositions: Float32Array
}

interface BuiltRig {
	mesh: RenderableMesh
	pieces: MeshPiece[]
	textures: (DecodedTexture | null)[]
	mch: ParsedMch
	hasTextures: boolean
}

/**
 * Look up which bone owns a given source-vertex index by walking
 * the MCH's skinObjects array.
 */
function buildVertexBoneMap(mch: ParsedMch): Int16Array {
	const out = new Int16Array(mch.vertices.length)
	out.fill(-1)
	for (const s of mch.skinObjects) {
		// Bone 0 means "root attachment" — treat as bone index 0
		// (the parser already normalises `logicalBone = boneId - 1`,
		// returning -1 for boneId === 0; we want bone-0-relative
		// for the root attachment in that case).
		const boneIdx = s.logicalBone < 0 ? 0 : s.logicalBone
		const end = Math.min(
			out.length,
			s.vertexIndex + s.vertexCount,
		)
		for (let i = s.vertexIndex; i < end; i++) {
			out[i] = boneIdx
		}
	}
	return out
}

/**
 * Master scale. FF8 PSX bone sizes and vertex coords share a
 * unit; OpenVIII's `Vertex.cs` divides PSX positions by 2048
 * (the engine's "ScaleHelper" constant) and `Bone.cs` does the
 * same for bone sizes. We follow that convention so the bone-
 * matrix translations and the bone-local vertex offsets stay in
 * the same coordinate frame.
 */
const POS_SCALE = 1 / 2048

function buildRig(mch: ParsedMch, tims: (ParsedTim | null)[]): BuiltRig {
	const vertexBone = buildVertexBoneMap(mch)

	// First pass — count output triangles.
	let totalTris = 0
	for (const f of mch.faces) totalTris += f.isQuad ? 2 : 1
	const totalVerts = totalTris * 3

	// Material slots:
	//   - slot 0 = vertex-color fallback (no texture)
	//   - slots 1..N = each embedded TIM (one slot per TIM)
	const texCount = tims.length
	const materialTextures: (DecodedTexture | null)[] = [null]
	for (let t = 0; t < texCount; t++) {
		const tim = tims[t]
		if (!tim) {
			materialTextures.push(null)
			continue
		}
		materialTextures.push({
			packagePath: `mch-tim-${t}`,
			width: tim.width,
			height: tim.height,
			pixels: tim.pixels,
			pixelFormat: `TIM${tim.bpp}`,
			normalReconstructed: false,
			flipY: false,
		})
	}

	const positions = new Float32Array(totalVerts * 3)
	const normals = new Float32Array(totalVerts * 3) // we hijack normal.x for boneIdx
	const uvs = new Float32Array(totalVerts * 2)
	const indices = new Uint32Array(totalTris * 3)

	const slotForTexId = (texId: number): number => {
		if (texCount === 0) return 0
		if (texId < 0 || texId >= texCount) return 0
		const slotted = texId + 1
		// If that TIM failed to decode (null), fall back to vertex-color slot.
		if (!tims[texId]) return 0
		return slotted
	}

	const slotCount = Math.max(1, texCount + 1)
	const trisPerSlot = new Array<number>(slotCount).fill(0)
	for (const f of mch.faces) {
		const slot = slotForTexId(f.textureIndex)
		trisPerSlot[slot] += f.isQuad ? 2 : 1
	}
	const slotStart = new Array<number>(slotCount).fill(0)
	for (let i = 1; i < slotCount; i++) {
		slotStart[i] = slotStart[i - 1]! + trisPerSlot[i - 1]!
	}
	const slotCursor = slotStart.slice()

	let vCursor = 0
	/**
	 * Emit one face-corner vertex into the buffers. `srcVertIdx`
	 * indexes into `mch.vertices`; `uv` is in 0..255 TIM-pixel
	 * units; `texDims` is the bound texture's width/height (or
	 * `[1,1]` if untextured — the UV gets normalised to 0..255
	 * regardless, which renders as a single texel for the
	 * fallback slot).
	 */
	const emitVertex = (
		srcVertIdx: number,
		uv: [number, number],
		texDims: [number, number],
	): number => {
		const v = mch.vertices[srcVertIdx]
		if (!v) return -1
		// FFVIII MCH vertices are stored BONE-LOCAL — each vertex
		// is an offset from its owning bone's joint in the joint's
		// local frame. We pre-apply OpenVIII's basis swap here so
		// `vec.applyMatrix4(boneMat)` does the right thing during
		// the skinning pass:
		//
		//   PSX  (X, Y, Z)  →  three.js  (-X/S, -Y/S, Z/S)
		//
		// The negations and Y/Z swap mirror the implicit conversion
		// in `OpenVIII-monogame/Battle/Dat/Vertex.cs` (verified
		// experimentally — see the Squall d000 dump in /tmp).
		positions[vCursor * 3 + 0] = -v[0] * POS_SCALE
		positions[vCursor * 3 + 1] = -v[1] * POS_SCALE
		positions[vCursor * 3 + 2] = v[2] * POS_SCALE
		// Stash bone index in normal.x for the future animation
		// driver (currently unused — bind pose is always rendered).
		const bone = vertexBone[srcVertIdx] ?? 0
		normals[vCursor * 3 + 0] = bone
		normals[vCursor * 3 + 1] = 0
		normals[vCursor * 3 + 2] = 0
		// FF8 MCH UVs are stored in 0..255 TIM-pixel units —
		// normalise by the bound texture size (or 1 if untextured
		// so we don't divide-by-zero).
		uvs[vCursor * 2 + 0] = uv[0] / Math.max(1, texDims[0])
		uvs[vCursor * 2 + 1] = uv[1] / Math.max(1, texDims[1])
		return vCursor++
	}

	for (const f of mch.faces) {
		const slot = slotForTexId(f.textureIndex)
		const tim = f.textureIndex >= 0 && f.textureIndex < texCount
			? tims[f.textureIndex]
			: null
		const dims: [number, number] = tim
			? [tim.width, tim.height]
			: [1, 1]
		if (f.isQuad) {
			// Per `triangulateMchFace`: tri1 = (v3, v0, v1); tri2 = (v3, v0, v2).
			// UVs follow the same vertex indices: (uv3, uv0, uv1) and (uv3, uv0, uv2).
			const v0 = emitVertex(f.vertexIndexes[3]!, f.texCoords[3]!, dims)
			const v1 = emitVertex(f.vertexIndexes[0]!, f.texCoords[0]!, dims)
			const v2 = emitVertex(f.vertexIndexes[1]!, f.texCoords[1]!, dims)
			const v3 = emitVertex(f.vertexIndexes[3]!, f.texCoords[3]!, dims)
			const v4 = emitVertex(f.vertexIndexes[0]!, f.texCoords[0]!, dims)
			const v5 = emitVertex(f.vertexIndexes[2]!, f.texCoords[2]!, dims)
			if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0 || v4 < 0 || v5 < 0) continue
			const tri1 = slotCursor[slot]!++
			const tri2 = slotCursor[slot]!++
			indices[tri1 * 3 + 0] = v0
			indices[tri1 * 3 + 1] = v1
			indices[tri1 * 3 + 2] = v2
			indices[tri2 * 3 + 0] = v3
			indices[tri2 * 3 + 1] = v4
			indices[tri2 * 3 + 2] = v5
		} else {
			// Triangle: emit (C, A, B) per triangulateMchFace.
			const v0 = emitVertex(f.vertexIndexes[2]!, f.texCoords[2]!, dims)
			const v1 = emitVertex(f.vertexIndexes[0]!, f.texCoords[0]!, dims)
			const v2 = emitVertex(f.vertexIndexes[1]!, f.texCoords[1]!, dims)
			if (v0 < 0 || v1 < 0 || v2 < 0) continue
			const tri = slotCursor[slot]!++
			indices[tri * 3 + 0] = v0
			indices[tri * 3 + 1] = v1
			indices[tri * 3 + 2] = v2
		}
	}

	const sections: RenderableMeshSection[] = []
	for (let slot = 0; slot < slotCount; slot++) {
		if (trisPerSlot[slot]! === 0) continue
		sections.push({
			materialIndex: slot,
			firstIndex: slotStart[slot]! * 3,
			numTriangles: trisPerSlot[slot]!,
		})
	}

	// Pieces: collect emitted-vertex indices grouped by their
	// source-bone (read out of the normals[].x hijack).
	const vertsByBone = new Map<number, number[]>()
	for (let v = 0; v < vCursor; v++) {
		const bId = normals[v * 3 + 0]! | 0
		if (!vertsByBone.has(bId)) vertsByBone.set(bId, [])
		vertsByBone.get(bId)!.push(v)
	}
	const pieces: MeshPiece[] = []
	for (const [bId, vs] of vertsByBone) {
		const local = new Float32Array(vs.length * 3)
		for (let i = 0; i < vs.length; i++) {
			const gi = vs[i]! * 3
			local[i * 3 + 0] = positions[gi + 0]!
			local[i * 3 + 1] = positions[gi + 1]!
			local[i * 3 + 2] = positions[gi + 2]!
		}
		pieces.push({ boneIndex: bId, vertexIndices: vs, localPositions: local })
	}

	const lod: RenderableMeshLOD = {
		numVertices: vCursor,
		positions,
		normals,
		uv: uvs,
		indices,
		sections,
		label: `${vCursor.toLocaleString()} verts, ${totalTris.toLocaleString()} tris`,
	}
	const mesh: RenderableMesh = {
		lods: [lod],
		upAxis: "y-up",
	}

	return {
		mesh,
		pieces,
		textures: materialTextures,
		mch,
		hasTextures: materialTextures.some((t) => t !== null),
	}
}

// ---------------------------------------------------------------------------
// Skinning math (mirrors the OpenVIII MonoGame battle-DAT
// algorithm — MCH and battle DAT share the same bone-hierarchy
// + vertex-storage conventions, only the on-disk header layout
// differs)
// ---------------------------------------------------------------------------

/**
 * Compute per-bone world matrices for one animation frame
 * (root translation + per-bone Euler rotations in degrees).
 *
 * Conventions, all from OpenVIII verbatim:
 *   - Root parent in MCH is `parentId == 0` (parser surfaces
 *     this as `logicalParent === -1`).
 *   - Child bone sits at parent's local +Z by `parent.size * S`.
 *   - Bone rotation: `Rz(-rz) · Ry(-ry) · Rx(-rx)` (= three.js
 *     `Euler("ZYX")` with negated components).
 *   - Root translation: X and Y are negated, Z preserved.
 */
function computeBoneMatrices(
	mch: ParsedMch,
	rootTranslation: [number, number, number] | null,
	boneRotations: [number, number, number][] | null,
): THREE.Matrix4[] {
	const bones = mch.bones
	const matrices: THREE.Matrix4[] = new Array(bones.length)
	const tmpEuler = new THREE.Euler()
	const tmpRot = new THREE.Matrix4()
	const tmpTrans = new THREE.Matrix4()
	const eulerOrder: THREE.EulerOrder = "ZYX"

	const rootMat = new THREE.Matrix4()
	if (rootTranslation) {
		rootMat.makeTranslation(
			-rootTranslation[0] * POS_SCALE,
			-rootTranslation[1] * POS_SCALE,
			rootTranslation[2] * POS_SCALE,
		)
	}

	for (let i = 0; i < bones.length; i++) {
		const b = bones[i]!
		let rx = 0
		let ry = 0
		let rz = 0
		if (boneRotations && i < boneRotations.length) {
			rx = boneRotations[i]![0]
			ry = boneRotations[i]![1]
			rz = boneRotations[i]![2]
		}
		tmpEuler.set(
			THREE.MathUtils.degToRad(-rx),
			THREE.MathUtils.degToRad(-ry),
			THREE.MathUtils.degToRad(-rz),
			eulerOrder,
		)
		tmpRot.makeRotationFromEuler(tmpEuler)

		let parentMat: THREE.Matrix4
		let parentLen = 0
		if (b.logicalParent < 0) {
			parentMat = rootMat
		} else {
			parentMat = matrices[b.logicalParent] ?? rootMat
			parentLen = bones[b.logicalParent]!.size * POS_SCALE
		}
		tmpTrans.makeTranslation(0, 0, parentLen)
		const m = new THREE.Matrix4().multiplyMatrices(parentMat, tmpTrans)
		m.multiply(tmpRot)
		matrices[i] = m
	}
	return matrices
}

/**
 * Apply per-bone matrices to the rig's pieces and write the
 * resulting world-space positions either back into the live
 * `geometry.positions` attribute (`geometry !== null`) or into
 * the rig's typed-array LOD (`geometry === null` — bake before
 * mount).
 */
function applySkinning(
	rig: BuiltRig,
	matrices: THREE.Matrix4[],
	geometry: THREE.BufferGeometry | null,
): void {
	const posArr = geometry
		? (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array
		: rig.mesh.lods[0]!.positions
	const v = new THREE.Vector3()
	for (const piece of rig.pieces) {
		const m = matrices[piece.boneIndex]
		if (!m) continue
		for (let i = 0; i < piece.vertexIndices.length; i++) {
			v.set(
				piece.localPositions[i * 3 + 0]!,
				piece.localPositions[i * 3 + 1]!,
				piece.localPositions[i * 3 + 2]!,
			)
			v.applyMatrix4(m)
			const gi = piece.vertexIndices[i]! * 3
			posArr[gi + 0] = v.x
			posArr[gi + 1] = v.y
			posArr[gi + 2] = v.z
		}
	}
	if (geometry) {
		const attr = geometry.getAttribute("position") as THREE.BufferAttribute
		attr.needsUpdate = true
		geometry.computeBoundingSphere()
	}
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function hex(n: number, width = 0): string {
	const s = n.toString(16)
	return "0x" + (width > 0 ? s.padStart(width, "0") : s)
}

interface Loaded {
	bytes: Uint8Array
	parsed: ParsedMch | null
	tims: (ParsedTim | null)[]
	isDummy: boolean
}

export function Ff8MchPreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync<Loaded>(async () => {
		if (!node.blob) throw new Error("MCH node has no backing blob.")
		const blob = await node.blob()
		const bytes = new Uint8Array(await blob.arrayBuffer())
		if (isDummyMch(bytes)) {
			return { bytes, parsed: null, tims: [], isDummy: true }
		}
		const parsed = parseMch(bytes)
		const tims = sliceAndDecodeTims(bytes, parsed)
		return { bytes, parsed, tims, isDummy: false }
	}, [node.id])

	const rig = useMemo(() => {
		if (!data || data.isDummy || !data.parsed) return null
		try {
			return buildRig(data.parsed, data.tims)
		} catch (e) {
			console.error("MCH rig build failed:", e)
			return null
		}
	}, [data])

	// Bake the bind pose (frame 0 of animation 0, or the
	// identity-bone-rotation pose if no animations) into the
	// rig's typed-array LOD BEFORE the MeshViewer mounts. The
	// renderer reads `mesh.lods[0].positions` once for the
	// initial geometry; per-frame animation updates flow through
	// the driver's `sample` callback below.
	useEffect(() => {
		if (!rig || !data?.parsed) return
		const firstAnim = data.parsed.animations.find((a) => a.frames.length > 0)
		const rootT = firstAnim?.frames[0]?.rootTranslation ?? null
		const boneRots = firstAnim?.frames[0]?.boneRotations ?? null
		const mats = computeBoneMatrices(data.parsed, rootT, boneRots)
		applySkinning(rig, mats, null)
	}, [rig, data])

	const driver = useMemo<MeshViewerAnimationDriver | null>(() => {
		if (!rig || !data?.parsed) return null
		const anims = data.parsed.animations.filter((a) => a.frames.length > 0)
		if (anims.length === 0) return null
		const list: MeshViewerAnimation[] = anims.map((a, i) => ({
			name: `anim-${String(i).padStart(2, "0")} (${a.framesCount}f × ${a.bonesCount}b)`,
			frameCount: Math.max(1, a.framesCount),
			loop: a.framesCount > 1,
		}))
		return {
			category: "field",
			animations: list,
			sample(index, frame, ctx) {
				if (!data.parsed) return
				let resolved = index
				if (resolved < 0 || !anims[resolved]) resolved = 0
				const anim = anims[resolved]!
				if (anim.frames.length === 0) return
				const fIdx = Math.min(
					anim.frames.length - 1,
					Math.max(0, Math.floor(frame)),
				)
				const f = anim.frames[fIdx]!
				const mats = computeBoneMatrices(
					data.parsed,
					f.rootTranslation,
					f.boneRotations,
				)
				applySkinning(rig, mats, ctx.geometry)
			},
		}
	}, [rig, data])

	if (loading) return <LoadingFiller label="Parsing MCH…" />
	if (error) return <ErrorFiller error={error} />
	const v = data!

	if (v.isDummy) {
		return (
			<ScrollArea className="h-full">
				<div className="flex flex-col gap-5 p-5">
					<div>
						<h2 className="font-heading text-base font-medium">
							{node.name} — Final Fantasy VIII character model
						</h2>
						<Separator className="mt-2" />
					</div>
					<div className="rounded-md border bg-card p-4 text-sm">
						This <code className="font-mono">.mch</code>{" "}
						slot ships the 33-byte "
						<code className="font-mono">
							This is dummy file. Kazuo Suzuki
						</code>
						" sentinel rather than a model. Square shipped a
						handful of empty model slots in the
						Remastered's <code>main_chr.fs</code>; they're
						unused at runtime.
					</div>
				</div>
			</ScrollArea>
		)
	}

	const p = v.parsed!
	if (!rig) {
		return (
			<ScrollArea className="h-full">
				<div className="flex flex-col gap-5 p-5">
					<div>
						<h2 className="font-heading text-base font-medium">
							{node.name} — Final Fantasy VIII character model
						</h2>
						<Separator className="mt-2" />
					</div>
					<div className="rounded-md border bg-amber-500/10 p-4 text-sm">
						Could not build a 3D mesh from this MCH
						({p.bones.length} bones · {p.vertices.length}{" "}
						verts · {p.faces.length} faces ·{" "}
						{p.animations.length} animations).
					</div>
				</div>
			</ScrollArea>
		)
	}

	const totalAnimFrames = p.animations.reduce(
		(sum, a) => sum + a.framesCount,
		0,
	)
	const triCount = p.faces.filter((f) => !f.isQuad).length
	const quadCount = p.faces.length - triCount

	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF8 character model · {p.bones.length} bones ·{" "}
					{p.vertices.length.toLocaleString()} verts · {triCount} tri
					{triCount === 1 ? "" : "s"} + {quadCount} quad
					{quadCount === 1 ? "" : "s"} · {v.tims.length} TIM
					{v.tims.length === 1 ? "" : "s"} ·{" "}
					{p.animations.length} anim{p.animations.length === 1 ? "" : "s"}
					{totalAnimFrames > 0 ? ` (${totalAnimFrames} frames total)` : ""}
				</p>
				<details className="mt-1 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						Header / TOC
					</summary>
					<dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
						<dt className="text-muted-foreground">Body offset</dt>
						<dd className="tabular-nums font-mono">
							{p.bodyOffset !== undefined ? hex(p.bodyOffset) : "—"}
						</dd>
						<dt className="text-muted-foreground">TIM offsets</dt>
						<dd className="tabular-nums font-mono break-all">
							{(p.embeddedTimOffsets ?? []).map((o) => hex(o)).join(", ") ||
								"—"}
						</dd>
						<dt className="text-muted-foreground">Skin objects</dt>
						<dd className="tabular-nums">{p.skinObjects.length}</dd>
						<dt className="text-muted-foreground">File size</dt>
						<dd className="tabular-nums">
							{v.bytes.length.toLocaleString()} B
						</dd>
					</dl>
				</details>
			</div>
			<MeshViewer
				mesh={rig.mesh}
				materialDiffuseTextures={rig.textures}
				animationDrivers={driver ? [driver] : undefined}
				infoText={`${rig.pieces.length} skin pieces · ${rig.hasTextures ? `${v.tims.filter((t) => t).length} TIMs` : "untextured"}`}
			/>
		</div>
	)
}

// Local UV / Face helpers retained to satisfy bundler tree-shaking
// when the user wants to import the raw types; not used at render
// time (see `triangulateMchFace` call sites above).
export type { McbFace }
