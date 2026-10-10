/**
 * FF7 PC battle-model rig: resolve a `battle.lgp` `<id>aa` skeleton's
 * per-bone meshes, textures and animation pack, merge them into one
 * {@link RenderableMesh}, and pose it. React-free so both the battle
 * preview and the media library can use it. Extracted unchanged from
 * `components/ff7-battle-preview.tsx`.
 */
import * as THREE from 'three'
import {
	parseAnimationPack,
	parseBattleSkeleton,
	splitRootFromFrames,
	type BattleBone,
	type ParsedBattleSkeleton,
	type SplitBattleAnimation,
} from '@tootallnate/ff7-battle'
import {
	extractTrianglesForGroup,
	parsePMesh,
	parseTex,
	type ParsedP,
	type ParsedTex,
} from '@tootallnate/ff7-pc-model'

import type {
	RenderableMesh,
	RenderableMeshLOD,
	RenderableMeshSection,
} from '~/components/mesh-viewer'
import type { Node } from './archive'
import type { DecodedTexture } from './uasset-material-chain'
import { findNodeById } from './unity-external'

// ---------------------------------------------------------------------------
// Sibling resolution
// ---------------------------------------------------------------------------


export async function getSiblings(
	root: Node | null,
	selected: Node,
): Promise<Node[]> {
	if (!root) return []
	const slash = selected.id.lastIndexOf("/")
	if (slash <= 0) return []
	const parentId = selected.id.slice(0, slash)
	const parent = await findNodeById(root, parentId)
	if (!parent?.getChildren) return []
	return parent._children ?? (parent._children = await parent.getChildren())
}

// ---------------------------------------------------------------------------
// Composite assembly
// ---------------------------------------------------------------------------

export interface ResolvedBattleBone extends BattleBone {
	mesh: ParsedP | null
}

export interface AssembledBattle {
	skeleton: ParsedBattleSkeleton
	bones: ResolvedBattleBone[]
	textures: (ParsedTex | null)[]
	/** The `<id>da` animation pack node (for lazy loading). */
	animPackNode: Node | null
	warnings: string[]
}

export async function assembleBattle(
	masterNode: Node,
	root: Node | null,
): Promise<AssembledBattle> {
	const masterBytes = new Uint8Array(
		await (await masterNode.blob!()).arrayBuffer(),
	)
	const skeleton = parseBattleSkeleton(masterBytes, masterNode.name)
	const warnings: string[] = []

	const siblings = await getSiblings(root, masterNode)
	const byName = new Map<string, Node>()
	for (const s of siblings) byName.set(s.name.toLowerCase(), s)

	// Resolve per-bone meshes.
	const bones: ResolvedBattleBone[] = []
	for (const bone of skeleton.bones) {
		let mesh: ParsedP | null = null
		if (bone.hasModel) {
			const node = byName.get(bone.meshFilename.toLowerCase())
			if (node) {
				try {
					const b = await node.blob!()
					mesh = parsePMesh(new Uint8Array(await b.arrayBuffer()))
				} catch (err) {
					warnings.push(
						`Failed to parse mesh ${bone.meshFilename}: ${
							err instanceof Error ? err.message : String(err)
						}`,
					)
				}
			} else {
				warnings.push(`Missing bone mesh ${bone.meshFilename}`)
			}
		}
		bones.push({ ...bone, mesh })
	}

	// Resolve textures.
	const textures: (ParsedTex | null)[] = []
	for (const texName of skeleton.textureFilenames) {
		const node = byName.get(texName.toLowerCase())
		if (!node) {
			warnings.push(`Missing texture ${texName}`)
			textures.push(null)
			continue
		}
		try {
			const b = await node.blob!()
			textures.push(parseTex(new Uint8Array(await b.arrayBuffer())))
		} catch (err) {
			warnings.push(
				`Failed to parse texture ${texName}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
			textures.push(null)
		}
	}

	// Locate (but don't yet parse) the animation pack.
	const animPackNode = byName.get(skeleton.animationPackFilename.toLowerCase()) ?? null
	if (!animPackNode && skeleton.header.numBodyAnimations > 0) {
		warnings.push(`Missing animation pack ${skeleton.animationPackFilename}`)
	}

	return { skeleton, bones, textures, animPackNode, warnings }
}

// ---------------------------------------------------------------------------
// Mesh-piece extraction (parallel to the field-model composite)
// ---------------------------------------------------------------------------

export interface BattleMeshPiece {
	boneIndex: number
	/** Local-frame positions, layout-equivalent to RigMeshPiece in field. */
	localPositions: Float32Array
	localNormals: Float32Array
	vertexStart: number
	vertexCount: number
}

export interface BuiltBattleRig {
	mesh: RenderableMesh
	pieces: BattleMeshPiece[]
	textures: (DecodedTexture | null)[]
}

export function buildBattleRig(assembled: AssembledBattle): BuiltBattleRig | null {
	let totalVerts = 0
	let totalTris = 0
	let totalSections = 0
	for (const b of assembled.bones) {
		if (!b.mesh) continue
		for (const g of b.mesh.groups) {
			totalSections++
			totalTris += g.numPolygons
			totalVerts += g.numPolygons * 3
		}
	}
	if (totalSections === 0) return null

	const positions = new Float32Array(totalVerts * 3)
	const normals = new Float32Array(totalVerts * 3)
	const uvs = new Float32Array(totalVerts * 2)
	const colors = new Float32Array(totalVerts * 3)
	const indices = new Uint32Array(totalTris * 3)
	const sections: RenderableMeshSection[] = []
	const textures: (DecodedTexture | null)[] = []
	const pieces: BattleMeshPiece[] = []

	let vertCursor = 0
	let idxCursor = 0
	let hasAnyUv = false
	let materialSlot = 0
	for (let bi = 0; bi < assembled.bones.length; bi++) {
		const bone = assembled.bones[bi]!
		if (!bone.mesh) continue
		for (const g of bone.mesh.groups) {
			const tris = extractTrianglesForGroup(bone.mesh, g)
			const vc = tris.positions.length / 3
			if (tris.texCoords) {
				// Battle models authored textures upside-down — flip V here
				// so the existing flipY-false MeshViewer code path renders
				// them right-side-up (matching field models).
				for (let i = 0; i < tris.texCoords.length; i += 2) {
					uvs[(vertCursor + i / 2) * 2 + 0] = tris.texCoords[i]!
					uvs[(vertCursor + i / 2) * 2 + 1] = 1 - tris.texCoords[i + 1]!
				}
				hasAnyUv = true
			}
			colors.set(tris.colors, vertCursor * 3)
			for (let i = 0; i < tris.indices.length; i++) {
				indices[idxCursor + i] = tris.indices[i]! + vertCursor
			}
			sections.push({
				materialIndex: materialSlot,
				firstIndex: idxCursor,
				numTriangles: Math.floor(tris.indices.length / 3),
			})

			let decoded: DecodedTexture | null = null
			if (g.areTexturesUsed && g.textureNumber < assembled.textures.length) {
				const tex = assembled.textures[g.textureNumber]
				if (tex) {
					decoded = {
						packagePath: `${bone.meshFilename}#${g.textureNumber}`,
						width: tex.width,
						height: tex.height,
						pixels: tex.pixels,
						pixelFormat: tex.paletted ? "TEX8" : `TEX${tex.bitsPerPixel}`,
						normalReconstructed: false,
						flipY: false,
					}
				}
			}
			textures.push(decoded)
			pieces.push({
				boneIndex: bi,
				localPositions: tris.positions,
				localNormals: tris.normals,
				vertexStart: vertCursor,
				vertexCount: vc,
			})
			vertCursor += vc
			idxCursor += tris.indices.length
			materialSlot++
		}
	}

	const lod: RenderableMeshLOD = {
		numVertices: vertCursor,
		positions,
		normals,
		uv: hasAnyUv ? uvs : undefined,
		colors,
		indices,
		sections,
		label: `${vertCursor.toLocaleString()} verts, ${(idxCursor / 3).toLocaleString()} tris`,
	}
	const mesh: RenderableMesh = {
		lods: [lod],
		// Bone math already places the model in three.js's +Y-up
		// convention (the root applies a 180° X-flip to convert
		// FF7's source -Y-up to +Y-up). No further viewer-level
		// transform needed.
		upAxis: "y-up",
	}
	return { mesh, pieces, textures }
}

// ---------------------------------------------------------------------------
// Per-frame skinning (mirror of the field-model approach)
// ---------------------------------------------------------------------------

export type BoneMatrices = THREE.Matrix4[]

export function computeBattleBoneMatrices(
	bones: ResolvedBattleBone[],
	rootTranslation: [number, number, number] | null,
	rootRotation: [number, number, number] | null,
	frame: SplitBattleAnimation["frames"][number] | null,
): BoneMatrices {
	const matrices: BoneMatrices = new Array(bones.length)
	const tmpRot = new THREE.Matrix4()
	const tmpEuler = new THREE.Euler()
	const tmpTrans = new THREE.Matrix4()
	const eulerOrder: THREE.EulerOrder = "YXZ"

	// Root transform: translation × rotation + 180° X flip.
	const rootTrans = new THREE.Matrix4()
	const rootRot = new THREE.Matrix4()
	if (rootTranslation) {
		rootTrans.makeTranslation(
			rootTranslation[0],
			rootTranslation[1],
			rootTranslation[2],
		)
	}
	const rrx = rootRotation?.[0] ?? 0
	const rry = rootRotation?.[1] ?? 0
	const rrz = rootRotation?.[2] ?? 0
	tmpEuler.set(
		THREE.MathUtils.degToRad(rrx + 180),
		THREE.MathUtils.degToRad(rry),
		THREE.MathUtils.degToRad(rrz),
		eulerOrder,
	)
	rootRot.makeRotationFromEuler(tmpEuler)
	const rootMat = new THREE.Matrix4().multiplyMatrices(rootTrans, rootRot)

	for (let i = 0; i < bones.length; i++) {
		const bone = bones[i]!
		const parentMat = bone.parent >= 0 ? matrices[bone.parent]! : rootMat
		const parentLength = bone.parent >= 0 ? bones[bone.parent]!.length : 0
		if (frame && i < frame.boneRotations.length) {
			const [a, b, c] = frame.boneRotations[i]!
			tmpEuler.set(
				THREE.MathUtils.degToRad(a),
				THREE.MathUtils.degToRad(b),
				THREE.MathUtils.degToRad(c),
				eulerOrder,
			)
			tmpRot.makeRotationFromEuler(tmpEuler)
		} else {
			tmpRot.identity()
		}
		// Same -Z translation convention as field models.
		tmpTrans.makeTranslation(0, 0, -parentLength)
		const m = new THREE.Matrix4()
		m.multiplyMatrices(parentMat, tmpTrans)
		m.multiply(tmpRot)
		matrices[i] = m
	}
	return matrices
}

/**
 * Apply bone matrices directly to the LOD's typed-array buffers
 * (no THREE.BufferGeometry required). Used to set the bind pose
 * before the WebGL renderer attaches.
 */
export function applyBattleMatricesToTypedArrays(
	rig: BuiltBattleRig,
	matrices: BoneMatrices,
): void {
	const lod = rig.mesh.lods[0]!
	const posArr = lod.positions
	const normArr = lod.normals
	const v = new THREE.Vector3()
	const n = new THREE.Vector3()
	for (const piece of rig.pieces) {
		const m = matrices[piece.boneIndex]!
		for (let i = 0; i < piece.vertexCount; i++) {
			const li = i * 3
			const gi = (piece.vertexStart + i) * 3
			v.set(
				piece.localPositions[li]!,
				piece.localPositions[li + 1]!,
				piece.localPositions[li + 2]!,
			)
			v.applyMatrix4(m)
			posArr[gi] = v.x
			posArr[gi + 1] = v.y
			posArr[gi + 2] = v.z
			if (normArr) {
				n.set(
					piece.localNormals[li]!,
					piece.localNormals[li + 1]!,
					piece.localNormals[li + 2]!,
				)
				n.transformDirection(m)
				normArr[gi] = n.x
				normArr[gi + 1] = n.y
				normArr[gi + 2] = n.z
			}
		}
	}
}

export function applyBattleMatricesToGeometry(
	geometry: THREE.BufferGeometry,
	pieces: BattleMeshPiece[],
	matrices: BoneMatrices,
): void {
	const posAttr = geometry.getAttribute("position") as
		| THREE.BufferAttribute
		| undefined
	const normAttr = geometry.getAttribute("normal") as
		| THREE.BufferAttribute
		| undefined
	if (!posAttr) return
	const posArr = posAttr.array as Float32Array
	const normArr = normAttr?.array as Float32Array | undefined
	const v = new THREE.Vector3()
	const n = new THREE.Vector3()
	for (const piece of pieces) {
		const m = matrices[piece.boneIndex]!
		for (let i = 0; i < piece.vertexCount; i++) {
			const li = i * 3
			const gi = (piece.vertexStart + i) * 3
			v.set(
				piece.localPositions[li]!,
				piece.localPositions[li + 1]!,
				piece.localPositions[li + 2]!,
			)
			v.applyMatrix4(m)
			posArr[gi] = v.x
			posArr[gi + 1] = v.y
			posArr[gi + 2] = v.z
			if (normArr) {
				n.set(
					piece.localNormals[li]!,
					piece.localNormals[li + 1]!,
					piece.localNormals[li + 2]!,
				)
				n.transformDirection(m)
				normArr[gi] = n.x
				normArr[gi + 1] = n.y
				normArr[gi + 2] = n.z
			}
		}
	}
	posAttr.needsUpdate = true
	if (normAttr) normAttr.needsUpdate = true
	geometry.computeBoundingSphere()
}

/**
 * Battle models have no usable bind pose on disk, so the rest pose is
 * frame 0 of the first non-empty body animation (as the preview does).
 * Returns the parsed body animations for callers that want them.
 */
export async function poseFf7BattleRest(
	assembled: AssembledBattle,
	rig: BuiltBattleRig,
): Promise<SplitBattleAnimation[]> {
	let pack: SplitBattleAnimation[] = []
	if (assembled.animPackNode) {
		try {
			const bytes = new Uint8Array(await (await assembled.animPackNode.blob!()).arrayBuffer())
			pack = parseAnimationPack(bytes, assembled.skeleton.header).bodyAnimations.map((a) => splitRootFromFrames(a))
		} catch {
			pack = []
		}
	}
	const first = pack.find((a) => !a.empty && a.frames.length > 0)
	const f0 = first?.frames[0] ?? null
	applyBattleMatricesToTypedArrays(
		rig,
		computeBattleBoneMatrices(assembled.bones, f0?.rootTranslation ?? null, f0?.rootRotation ?? null, f0),
	)
	return pack
}
