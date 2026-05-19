/**
 * Preview for Final Fantasy VIII battle character / monster DAT
 * files (`c0m###.dat`). Renders the 3D model through the shared
 * MeshViewer with per-frame skinned animation + texture support.
 *
 * Inputs: a single `.dat` blob. Outputs the model's skeleton +
 * geometry + textures + animation transport — everything self-
 * contained (battle DATs ship all their data internally; no
 * sibling-file resolution needed unlike field models).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { parseDat, type ParsedDat, type DatObject } from "@tootallnate/ff8-battle"
import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"
import {
	MeshViewer,
	type MeshViewerAnimation,
	type MeshViewerAnimationDriver,
	type RenderableMesh,
	type RenderableMeshLOD,
	type RenderableMeshSection,
} from "./mesh-viewer"
import type { DecodedTexture } from "~/lib/uasset-material-chain"

// ---------------------------------------------------------------------------
// Skinned-rig builder
// ---------------------------------------------------------------------------

interface MeshPiece {
	boneIndex: number
	/** Local-frame positions (raw int16 vertex coords). */
	localPositions: Float32Array
	vertexStart: number
	vertexCount: number
}

interface BuiltRig {
	mesh: RenderableMesh
	pieces: MeshPiece[]
	textures: (DecodedTexture | null)[]
	/** Frames of degrees-per-bone for runtime skinning. */
	dat: ParsedDat
}

function buildRig(dat: ParsedDat): BuiltRig | null {
	if (!dat.skeleton || !dat.geometry) return null
	const bones = dat.skeleton.bones

	// First pass — count vertices + triangles across all objects.
	let totalVerts = 0
	let totalTris = 0
	for (const obj of dat.geometry.objects) {
		// Each vertex is replicated once per triangle/quad it
		// belongs to (we don't share verts across faces, like the
		// FF7 model viewer — keeps the texturing simple).
		for (const t of obj.triangles) {
			totalVerts += 3
			totalTris += 1
			void t
		}
		for (const q of obj.quads) {
			totalVerts += 6
			totalTris += 2
			void q
		}
	}

	const positions = new Float32Array(totalVerts * 3)
	const normals = new Float32Array(totalVerts * 3)
	const uvs = new Float32Array(totalVerts * 2)
	const indices = new Uint32Array(totalTris * 3)
	const sections: RenderableMeshSection[] = []
	const pieces: MeshPiece[] = []
	const materialTextures: (DecodedTexture | null)[] = []

	// FF8 battle textures: each face has a texIndex pointing into
	// dat.textures[]. We assign one material slot per texture (so
	// the MeshViewer can multi-material the rig). Plus slot 0 is a
	// vertex-color fallback for any face with texIndex out of
	// range or no texture loaded.
	const texCount = dat.textures?.length ?? 0
	if (texCount === 0) {
		// No textures — just one slot.
		materialTextures.push(null)
	} else {
		// Slot 0 = fallback; slots 1..N = textures.
		materialTextures.push(null)
		for (let t = 0; t < texCount; t++) {
			const tex = dat.textures![t]!
			materialTextures.push({
				packagePath: `tex${t}`,
				width: tex.width,
				height: tex.height,
				pixels: tex.pixels,
				pixelFormat: `TIM${tex.bpp}`,
				normalReconstructed: false,
				flipY: false,
			})
		}
	}

	// Second pass — emit vertex data per face, grouping faces by
	// texture so we can build sections at the end. To do that
	// without an intermediate buffer, we precompute the per-face
	// material slot and the slot's offset.
	const slotForTexId = (texId: number): number => {
		if (texCount === 0) return 0
		if (texId < 0 || texId >= texCount) return 0
		return texId + 1
	}

	// Count triangles per material slot.
	const slotCount = texCount === 0 ? 1 : texCount + 1
	const trisPerSlot = new Array<number>(slotCount).fill(0)
	for (const obj of dat.geometry.objects) {
		for (const t of obj.triangles) {
			trisPerSlot[slotForTexId(t.textureIndex)]++
		}
		for (const q of obj.quads) {
			trisPerSlot[slotForTexId(q.textureIndex)] += 2
		}
	}
	const slotStart = new Array<number>(slotCount).fill(0)
	for (let i = 1; i < slotCount; i++) {
		slotStart[i] = slotStart[i - 1]! + trisPerSlot[i - 1]!
	}
	const slotCursor = slotStart.slice()

	// Vertex emit cursor — we emit verts in the same slot order
	// as the triangles, since each tri owns 3 unique verts.
	let vCursor = 0
	const emitVertex = (
		obj: DatObject,
		vIdx: number,
		uv: [number, number],
		texDims: [number, number],
	): number => {
		const v = obj.vertices[vIdx]!
		// FF8 raw vertex coords are int16 in PSX-mm-ish units.
		// Scale by 1/100 to bring into three.js-friendly range.
		const SCALE = 1 / 100
		positions[vCursor * 3 + 0] = v.x * SCALE
		positions[vCursor * 3 + 1] = -v.y * SCALE // PSX Y-down → Y-up
		positions[vCursor * 3 + 2] = v.z * SCALE
		// Per-vertex bone reference encoded into the normal slot
		// (we hijack the normal vec3 — its x channel = boneIndex).
		// Skinning happens at render time in `applySkinning`.
		normals[vCursor * 3 + 0] = v.boneId
		normals[vCursor * 3 + 1] = 0
		normals[vCursor * 3 + 2] = 0
		// UVs in TIM pixel units; normalize by texture size.
		uvs[vCursor * 2 + 0] = uv[0] / texDims[0]
		uvs[vCursor * 2 + 1] = uv[1] / texDims[1]
		return vCursor++
	}

	for (const obj of dat.geometry.objects) {
		for (const t of obj.triangles) {
			const slot = slotForTexId(t.textureIndex)
			const triIdx = slotCursor[slot]!++
			const ic = triIdx * 3
			const texInfo = dat.textures?.[t.textureIndex]
			const dims: [number, number] = texInfo
				? [texInfo.width, texInfo.height]
				: [128, 128]
			// Per spec note 5: shifted pairing — vertex order is
			// (C, A, B) for drawing, UVs stay (Vta, Vtb, Vtc), so
			// vertex C pairs with UV[0], A with UV[1], B with UV[2].
			const i0 = emitVertex(obj, t.vertexIndexes[0]!, t.uvs[0]!, dims)
			const i1 = emitVertex(obj, t.vertexIndexes[1]!, t.uvs[1]!, dims)
			const i2 = emitVertex(obj, t.vertexIndexes[2]!, t.uvs[2]!, dims)
			indices[ic + 0] = i0
			indices[ic + 1] = i1
			indices[ic + 2] = i2
		}
		for (const q of obj.quads) {
			const slot = slotForTexId(q.textureIndex)
			const tri0Idx = slotCursor[slot]!++
			const tri1Idx = slotCursor[slot]!++
			const texInfo = dat.textures?.[q.textureIndex]
			const dims: [number, number] = texInfo
				? [texInfo.width, texInfo.height]
				: [128, 128]
			// Quad triangulation: (A,B,D) + (A,C,D) per OpenVIII.
			const a = emitVertex(obj, q.vertexIndexes[0]!, q.uvs[0]!, dims)
			const b = emitVertex(obj, q.vertexIndexes[1]!, q.uvs[1]!, dims)
			const c = emitVertex(obj, q.vertexIndexes[2]!, q.uvs[2]!, dims)
			const d = emitVertex(obj, q.vertexIndexes[3]!, q.uvs[3]!, dims)
			const a2 = emitVertex(obj, q.vertexIndexes[0]!, q.uvs[0]!, dims)
			const c2 = emitVertex(obj, q.vertexIndexes[2]!, q.uvs[2]!, dims)
			const d2 = emitVertex(obj, q.vertexIndexes[3]!, q.uvs[3]!, dims)
			indices[tri0Idx * 3 + 0] = a
			indices[tri0Idx * 3 + 1] = b
			indices[tri0Idx * 3 + 2] = d
			indices[tri1Idx * 3 + 0] = a2
			indices[tri1Idx * 3 + 1] = c2
			indices[tri1Idx * 3 + 2] = d2
			void c
		}
	}

	// Build sections.
	for (let slot = 0; slot < slotCount; slot++) {
		if (trisPerSlot[slot]! === 0) continue
		sections.push({
			materialIndex: slot,
			firstIndex: slotStart[slot]! * 3,
			numTriangles: trisPerSlot[slot]!,
		})
	}

	// Pieces: for skinning, we need to know which bone each vert
	// belongs to. We've stashed boneId in normals[].x. Generate a
	// piece per bone for the per-frame skinner.
	const vertsByBone = new Map<number, number[]>()
	for (let v = 0; v < vCursor; v++) {
		const bId = normals[v * 3 + 0]! | 0
		if (!vertsByBone.has(bId)) vertsByBone.set(bId, [])
		vertsByBone.get(bId)!.push(v)
	}
	// We pre-store the raw local-frame positions so skinning can
	// re-transform them every frame.
	const rawLocals = new Map<number, Float32Array>()
	for (const [bId, vs] of vertsByBone) {
		const arr = new Float32Array(vs.length * 3)
		for (let i = 0; i < vs.length; i++) {
			arr[i * 3 + 0] = positions[vs[i]! * 3 + 0]!
			arr[i * 3 + 1] = positions[vs[i]! * 3 + 1]!
			arr[i * 3 + 2] = positions[vs[i]! * 3 + 2]!
		}
		rawLocals.set(bId, arr)
		pieces.push({
			boneIndex: bId,
			localPositions: arr,
			vertexStart: 0, // not used; we use vertsByBone instead
			vertexCount: vs.length,
		})
	}

	// Stash vertsByBone on the rig so the driver can find it.
	void bones

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

	// Stash the bone → vertex index map for the driver to use.
	;(mesh as unknown as { _ff8BoneVerts: Map<number, number[]> })._ff8BoneVerts =
		vertsByBone

	return { mesh, pieces, textures: materialTextures, dat }
}

// ---------------------------------------------------------------------------
// Skinning math (FF8 conventions)
// ---------------------------------------------------------------------------

/**
 * Compute per-bone world matrices. FF8 conventions:
 *   - parentId == 0xFFFF marks the root.
 *   - Each child sits at the parent's local-Z by parent.boneSize/4096.
 *   - Bone rotations are applied YXZ intrinsic (per OpenVIII).
 *   - Animation frames provide per-bone rotation overrides; without
 *     a frame we use the rest-pose rotations stored in the bone
 *     records themselves.
 */
function computeBoneMatrices(
	dat: ParsedDat,
	rootTranslation: [number, number, number] | null,
	boneRotations: [number, number, number][] | null,
): THREE.Matrix4[] {
	const bones = dat.skeleton!.bones
	const matrices: THREE.Matrix4[] = new Array(bones.length)
	const tmpEuler = new THREE.Euler()
	const tmpRot = new THREE.Matrix4()
	const tmpTrans = new THREE.Matrix4()
	const eulerOrder: THREE.EulerOrder = "YXZ"

	// Root matrix: just the root translation. We've already
	// flipped Y at vertex-emit time (FF8 source is -Y-up; we
	// negate Y per vertex into +Y-up). Adding another 180°
	// rotation here would double-flip and put the model
	// upside-down.
	const rootMat = new THREE.Matrix4()
	if (rootTranslation) {
		const tx = rootTranslation[0] / 100
		const ty = -rootTranslation[1] / 100
		const tz = rootTranslation[2] / 100
		rootMat.makeTranslation(tx, ty, tz)
	}

	const BONE_SIZE_SCALE = 1 / 100 // same divisor as vertex scale

	for (let i = 0; i < bones.length; i++) {
		const b = bones[i]!
		// Determine rotation. Prefer animation override; else rest pose.
		let rx = b.rotX
		let ry = b.rotY
		let rz = b.rotZ
		if (boneRotations && i < boneRotations.length) {
			rx = boneRotations[i]![0]
			ry = boneRotations[i]![1]
			rz = boneRotations[i]![2]
		}
		tmpEuler.set(
			THREE.MathUtils.degToRad(rx),
			THREE.MathUtils.degToRad(ry),
			THREE.MathUtils.degToRad(rz),
			eulerOrder,
		)
		tmpRot.makeRotationFromEuler(tmpEuler)

		// Translation: child position = parent's local +Z by parent's bone size.
		let parentMat: THREE.Matrix4
		let parentLen = 0
		if (b.parentId === 0xffff) {
			parentMat = rootMat
		} else {
			parentMat = matrices[b.parentId]!
			parentLen = bones[b.parentId]!.boneSize * BONE_SIZE_SCALE
		}
		tmpTrans.makeTranslation(0, 0, -parentLen)
		const m = new THREE.Matrix4().multiplyMatrices(parentMat, tmpTrans)
		m.multiply(tmpRot)
		matrices[i] = m
	}
	return matrices
}

function applySkinning(
	rig: BuiltRig,
	matrices: THREE.Matrix4[],
	geometry: THREE.BufferGeometry,
): void {
	const posAttr = geometry.getAttribute("position") as
		| THREE.BufferAttribute
		| undefined
	if (!posAttr) return
	const posArr = posAttr.array as Float32Array
	const vertsByBone = (rig.mesh as unknown as { _ff8BoneVerts: Map<number, number[]> })
		._ff8BoneVerts
	const v = new THREE.Vector3()
	for (const piece of rig.pieces) {
		const m = matrices[piece.boneIndex]
		if (!m) continue
		const vIndices = vertsByBone.get(piece.boneIndex)
		if (!vIndices) continue
		for (let i = 0; i < piece.vertexCount; i++) {
			v.set(
				piece.localPositions[i * 3 + 0]!,
				piece.localPositions[i * 3 + 1]!,
				piece.localPositions[i * 3 + 2]!,
			)
			v.applyMatrix4(m)
			const gi = vIndices[i]! * 3
			posArr[gi + 0] = v.x
			posArr[gi + 1] = v.y
			posArr[gi + 2] = v.z
		}
	}
	posAttr.needsUpdate = true
	geometry.computeBoundingSphere()
}

function applySkinningToTypedArrays(rig: BuiltRig, matrices: THREE.Matrix4[]): void {
	const lod = rig.mesh.lods[0]!
	const posArr = lod.positions
	const vertsByBone = (rig.mesh as unknown as { _ff8BoneVerts: Map<number, number[]> })
		._ff8BoneVerts
	const v = new THREE.Vector3()
	for (const piece of rig.pieces) {
		const m = matrices[piece.boneIndex]
		if (!m) continue
		const vIndices = vertsByBone.get(piece.boneIndex)
		if (!vIndices) continue
		for (let i = 0; i < piece.vertexCount; i++) {
			v.set(
				piece.localPositions[i * 3 + 0]!,
				piece.localPositions[i * 3 + 1]!,
				piece.localPositions[i * 3 + 2]!,
			)
			v.applyMatrix4(m)
			const gi = vIndices[i]! * 3
			posArr[gi + 0] = v.x
			posArr[gi + 1] = v.y
			posArr[gi + 2] = v.z
		}
	}
}

// ---------------------------------------------------------------------------
// Main preview component
// ---------------------------------------------------------------------------

export function Ff8BattleDatPreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync(async () => {
		const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer())
		return parseDat(bytes)
	}, [node.id])
	const rig = useMemo(() => (data ? buildRig(data) : null), [data])

	// Bake bind pose (animation 0 frame 0 if available, else rest)
	// into typed arrays before the renderer mounts.
	useEffect(() => {
		if (!rig || !data) return
		let rootT: [number, number, number] | null = null
		let boneRots: [number, number, number][] | null = null
		const firstAnim = data.animations?.find((a) => a.frames.length > 0)
		if (firstAnim) {
			const f = firstAnim.frames[0]!
			rootT = f.rootTranslation
			boneRots = f.boneRotations
		}
		const mats = computeBoneMatrices(data, rootT, boneRots)
		applySkinningToTypedArrays(rig, mats)
	}, [rig, data])

	const driver = useMemo<MeshViewerAnimationDriver | null>(() => {
		if (!rig || !data?.animations || data.animations.length === 0) return null
		const anims: MeshViewerAnimation[] = data.animations.map((a, i) => ({
			name: `anim-${String(i).padStart(2, "0")} (${a.frames.length}f)`,
			frameCount: Math.max(1, a.frames.length),
			loop: a.frames.length > 1,
		}))
		return {
			category: "battle",
			animations: anims,
			sample(index, frame, ctx) {
				if (!ctx.geometry) return
				let resolvedIndex = index
				if (resolvedIndex < 0 || !data.animations![resolvedIndex]) {
					resolvedIndex = 0
				}
				const anim = data.animations![resolvedIndex]
				if (!anim || anim.frames.length === 0) return
				const fIdx = Math.min(
					anim.frames.length - 1,
					Math.max(0, Math.floor(frame)),
				)
				const f = anim.frames[fIdx]!
				const mats = computeBoneMatrices(data, f.rootTranslation, f.boneRotations)
				applySkinning(rig, mats, ctx.geometry)
			},
		}
	}, [rig, data])

	if (loading) return <LoadingFiller label="Parsing battle DAT…" />
	if (error) return <ErrorFiller error={error} />
	if (!data || !rig) {
		return (
			<div className="flex h-full flex-col">
				<div className="border-b px-4 py-2">
					<h2 className="font-heading text-sm font-medium">{node.name}</h2>
					<p className="text-xs text-muted-foreground">
						Could not build a 3D mesh from this DAT (no skeleton/geometry).
					</p>
				</div>
			</div>
		)
	}

	const info = data.information
	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">
					{info?.name ?? node.name}
				</h2>
				<p className="text-xs text-muted-foreground">
					FF8 battle DAT · {data.skeleton?.bones.length ?? 0} bones ·{" "}
					{data.geometry?.objects.length ?? 0} object
					{(data.geometry?.objects.length ?? 0) === 1 ? "" : "s"} ·{" "}
					{data.textures?.length ?? 0} texture
					{(data.textures?.length ?? 0) === 1 ? "" : "s"} ·{" "}
					{data.animations?.length ?? 0} animation
					{(data.animations?.length ?? 0) === 1 ? "" : "s"}
				</p>
				{info && (
					<details className="mt-1 text-xs">
						<summary className="cursor-pointer text-muted-foreground">
							Enemy stats
						</summary>
						<dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1">
							<dt className="text-muted-foreground">HP polynomial</dt>
							<dd className="tabular-nums">[{info.hp.join(", ")}]</dd>
							<dt className="text-muted-foreground">STR polynomial</dt>
							<dd className="tabular-nums">[{info.str.join(", ")}]</dd>
							<dt className="text-muted-foreground">MAG polynomial</dt>
							<dd className="tabular-nums">[{info.mag.join(", ")}]</dd>
							<dt className="text-muted-foreground">EXP / AP</dt>
							<dd className="tabular-nums">
								{info.exp.toLocaleString()} / {info.ap}
							</dd>
							<dt className="text-muted-foreground">Med / High level</dt>
							<dd className="tabular-nums">
								{info.medLevelStart} / {info.highLevelStart}
							</dd>
						</dl>
					</details>
				)}
			</div>
			<MeshViewer
				mesh={rig.mesh}
				materialDiffuseTextures={rig.textures}
				animationDrivers={driver ? [driver] : undefined}
				infoText={`${rig.pieces.length} skin pieces`}
			/>
		</div>
	)
}
