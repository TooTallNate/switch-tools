/**
 * Preview components for FF7 PC battle models.
 *
 * The battle skeleton preview is parallel to the field HRC one:
 * it loads the master `<id>aa` file, then resolves each bone's
 * sibling mesh (`<id>am..cz`), textures (`<id>ac..al`), and the
 * animation pack (`<id>da`) by filename convention, and renders
 * the composite through the shared {@link MeshViewer}.
 *
 * Differences from the field HRC preview:
 *   - Bone lengths are negated relative to the field format
 *     (already done by the parser). The downstream skinning math
 *     is unchanged.
 *   - There's no RSD indirection — each bone's mesh is at a
 *     deterministic sibling filename.
 *   - All animations live in ONE pack file (`<id>da`) rather than
 *     individual `.a` files. The pack contains both body (skinned
 *     to the skeleton + 1 root slot) and weapon animations (1
 *     bone).
 *   - Animations are bit-packed delta-compressed — already
 *     decoded to degree triples by the parser.
 *   - Texture V coordinates are flipped at render time (battle
 *     textures are authored upside-down relative to field).
 */
import {
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import * as THREE from "three"

import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"
import { formatBytes } from "~/lib/utils"
import {
	MeshViewer,
	type MeshViewerAnimation,
	type MeshViewerAnimationDriver,
	type RenderableMesh,
	type RenderableMeshLOD,
	type RenderableMeshSection,
} from "./mesh-viewer"
import type { DecodedTexture } from "~/lib/uasset-material-chain"
import {
	parseBattleSkeleton,
	parseAnimationPack,
	splitRootFromFrames,
	type BattleBone,
	type ParsedBattleSkeleton,
	type SplitBattleAnimation,
} from "@tootallnate/ff7-battle"
import {
	parsePMesh,
	extractTrianglesForGroup,
	parseTex,
	type ParsedP,
	type ParsedTex,
} from "@tootallnate/ff7-pc-model"

// ---------------------------------------------------------------------------
// Sibling resolution
// ---------------------------------------------------------------------------

async function findNodeById(root: Node, target: string): Promise<Node | null> {
	if (root.id === target) return root
	if (target !== "" && !target.startsWith(root.id + "/") && root.id !== "") {
		return null
	}
	let cur: Node = root
	while (cur.id !== target) {
		if (!cur.getChildren) return null
		const kids = cur._children ?? (cur._children = await cur.getChildren())
		let next: Node | null = null
		for (const k of kids) {
			if (k.id === target || target.startsWith(k.id + "/")) {
				if (!next || k.id.length > next.id.length) next = k
			}
		}
		if (!next) return null
		cur = next
	}
	return cur
}

async function getSiblings(
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

interface ResolvedBattleBone extends BattleBone {
	mesh: ParsedP | null
}

interface AssembledBattle {
	skeleton: ParsedBattleSkeleton
	bones: ResolvedBattleBone[]
	textures: (ParsedTex | null)[]
	/** The `<id>da` animation pack node (for lazy loading). */
	animPackNode: Node | null
	warnings: string[]
}

async function assembleBattle(
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

interface BattleMeshPiece {
	boneIndex: number
	/** Local-frame positions, layout-equivalent to RigMeshPiece in field. */
	localPositions: Float32Array
	localNormals: Float32Array
	vertexStart: number
	vertexCount: number
}

interface BuiltBattleRig {
	mesh: RenderableMesh
	pieces: BattleMeshPiece[]
	textures: (DecodedTexture | null)[]
}

function buildBattleRig(assembled: AssembledBattle): BuiltBattleRig | null {
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
		upAxis: "z-up",
		flipYDefault: true,
	}
	return { mesh, pieces, textures }
}

// ---------------------------------------------------------------------------
// Per-frame skinning (mirror of the field-model approach)
// ---------------------------------------------------------------------------

type BoneMatrices = THREE.Matrix4[]

function computeBattleBoneMatrices(
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
function applyBattleMatricesToTypedArrays(
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

function applyBattleMatricesToGeometry(
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

// ---------------------------------------------------------------------------
// Main preview component
// ---------------------------------------------------------------------------

export function Ff7BattleSkeletonPreview({
	node,
	root,
}: {
	node: Node
	root: Node | null
}) {
	const { loading, data, error } = useAsync(
		() => assembleBattle(node, root),
		[node.id],
	)
	const assembled = data
	const rig = useMemo(() => (assembled ? buildBattleRig(assembled) : null), [
		assembled,
	])

	// Animation cache: lazy-parse the pack on first selection.
	const [animPack, setAnimPack] = useState<SplitBattleAnimation[] | null>(null)
	const [animError, setAnimError] = useState<Error | null>(null)
	useEffect(() => {
		if (!assembled?.animPackNode) return
		let cancelled = false
		;(async () => {
			try {
				const b = await assembled.animPackNode!.blob!()
				const bytes = new Uint8Array(await b.arrayBuffer())
				const pack = parseAnimationPack(bytes, assembled.skeleton.header)
				if (cancelled) return
				const split = pack.bodyAnimations.map((a) => splitRootFromFrames(a))
				setAnimPack(split)
			} catch (err) {
				if (!cancelled) setAnimError(err as Error)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [assembled?.animPackNode])

	// Bind-pose initialisation. Unlike field models (where bone
	// rotations are stored in the HRC implicitly via mesh layout),
	// battle models have NO meaningful bind pose stored on disk —
	// identity rotations cause every bone to extend along +Z, so
	// the whole model collapses into a 800-unit-long stick.
	//
	// The "natural" bind pose for a battle model is FRAME 0 OF THE
	// FIRST NON-EMPTY BODY ANIMATION. Once `animPack` arrives we
	// re-bake using that frame; until then we apply identity (and
	// the model will look like a stick — the user is unlikely to
	// see it because animPack typically arrives within a few ms of
	// the rig being built).
	useEffect(() => {
		if (!assembled || !rig) return
		let rootT: [number, number, number] | null = null
		let rootR: [number, number, number] | null = null
		let frame: { boneRotations: [number, number, number][] } | null = null
		if (animPack) {
			const first = animPack.find((a) => !a.empty && a.frames.length > 0)
			if (first) {
				const f0 = first.frames[0]!
				rootT = f0.rootTranslation
				rootR = f0.rootRotation
				frame = f0
			}
		}
		const matrices = computeBattleBoneMatrices(
			assembled.bones,
			rootT,
			rootR,
			frame as SplitBattleAnimation["frames"][number] | null,
		)
		applyBattleMatricesToTypedArrays(rig, matrices)
	}, [assembled, rig, animPack])

	// Driver for the MeshViewer's animation transport.
	const geometryRef = useRef<THREE.BufferGeometry | null>(null)
	const driver = useMemo<MeshViewerAnimationDriver | null>(() => {
		if (!rig || !assembled || !animPack) return null
		// Find the first non-empty animation index — used as the
		// "no selection" fallback so the model shows a sensible
		// pose instead of the identity-rotation stick.
		const firstNonEmpty = animPack.findIndex(
			(a) => !a.empty && a.frames.length > 0,
		)
		const anims: MeshViewerAnimation[] = animPack.map((a, i) => ({
			name: `body-${String(i).padStart(2, "0")} (${a.frames.length}f)`,
			frameCount: Math.max(1, a.frames.length),
			loop: a.frames.length > 1,
		}))
		return {
			category: "body",
			animations: anims,
			sample(index, frame, ctx) {
				geometryRef.current = ctx.geometry
				if (!ctx.geometry) return
				// Fall back to frame 0 of the first non-empty animation
				// when the user has nothing selected — battle skeletons
				// have no identity-rotation bind pose.
				let resolvedIndex = index
				let resolvedFrame = frame
				if (resolvedIndex < 0 || !animPack[resolvedIndex]) {
					if (firstNonEmpty < 0) return
					resolvedIndex = firstNonEmpty
					resolvedFrame = 0
				}
				const anim = animPack[resolvedIndex]
				if (!anim || anim.empty || anim.frames.length === 0) return
				const fIdx = Math.min(
					anim.frames.length - 1,
					Math.max(0, Math.floor(resolvedFrame)),
				)
				const f = anim.frames[fIdx]!
				const mats = computeBattleBoneMatrices(
					assembled.bones,
					f.rootTranslation,
					f.rootRotation,
					f,
				)
				applyBattleMatricesToGeometry(ctx.geometry, rig.pieces, mats)
			},
		}
	}, [rig, assembled, animPack])

	// Wait for animPack to load before showing the 3D view. Battle
	// models have no usable bind pose on disk — identity rotations
	// collapse the rig into a 800-unit stick along +Z. We need
	// frame 0 of the first non-empty animation to be baked into
	// the LOD's typed arrays BEFORE the renderer builds geometry
	// from them.
	const animPackReady = !assembled?.animPackNode || animPack !== null || animError !== null
	if (loading) return <LoadingFiller label="Loading battle skeleton…" />
	if (error) return <ErrorFiller error={error} />
	if (assembled && !animPackReady) {
		return <LoadingFiller label="Decoding animation pack…" />
	}
	if (!assembled || !rig) {
		return (
			<div className="flex h-full flex-col">
				<div className="border-b px-4 py-2">
					<h2 className="font-heading text-sm font-medium">{node.name}</h2>
					<p className="text-xs text-muted-foreground">
						FF7 battle skeleton — couldn't assemble. See the diagnostics below.
					</p>
				</div>
				<div className="flex-1 overflow-auto p-4 text-xs">
					<p>Master file: {node.name}</p>
					<p>Bones: {assembled?.skeleton.header.numBones ?? 0}</p>
					{assembled?.warnings.map((w, i) => (
						<p key={i} className="text-amber-500">
							{w}
						</p>
					))}
				</div>
			</div>
		)
	}

	const sk = assembled.skeleton
	const numAnims = animPack?.length ?? 0
	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF7 battle model · {sk.header.numBones} bones ·{" "}
					{assembled.textures.length} texture
					{assembled.textures.length === 1 ? "" : "s"} ·{" "}
					{sk.header.numBodyAnimations} body anim
					{sk.header.numBodyAnimations === 1 ? "" : "s"} (
					{sk.header.numWeaponAnimations} weapon) · {formatBytes(node.size ?? 0)}
				</p>
				{assembled.warnings.length > 0 && (
					<details className="mt-1 text-xs">
						<summary className="cursor-pointer text-amber-500">
							{assembled.warnings.length} warning
							{assembled.warnings.length === 1 ? "" : "s"}
						</summary>
						<ul className="ml-3 mt-1 list-disc">
							{assembled.warnings.map((w, i) => (
								<li key={i}>{w}</li>
							))}
						</ul>
					</details>
				)}
				{animError && (
					<p className="mt-1 text-xs text-amber-500">
						Animation pack failed to parse: {animError.message}
					</p>
				)}
				{!animError && assembled.animPackNode && !animPack && (
					<p className="mt-1 text-xs text-muted-foreground">
						Loading {numAnims || sk.header.numBodyAnimations} animation
						{numAnims === 1 ? "" : "s"}…
					</p>
				)}
			</div>
			<MeshViewer
				mesh={rig.mesh}
				materialDiffuseTextures={rig.textures}
				animationDrivers={driver ? [driver] : undefined}
				infoText={`${rig.pieces.length} piece${rig.pieces.length === 1 ? "" : "s"}`}
			/>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Standalone animation-pack preview (informational)
// ---------------------------------------------------------------------------

export function Ff7BattleAnimPackPreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync(async () => {
		const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer())
		// We don't know the bone count from the pack alone; parse with
		// generous estimates and let the resulting empty/error slots
		// surface in the UI. We use numBodyAnimations=256 and
		// numWeaponAnimations=0 because the pack's structure self-
		// terminates on the buffer end.
		return parseAnimationPack(bytes, {
			numBones: 0,
			numBodyAnimations: 256,
			numWeaponAnimations: 0,
		})
	}, [node.id])
	if (loading) return <LoadingFiller label="Decoding animation pack…" />
	if (error) return <ErrorFiller error={error} />
	if (!data) return null
	const bodyAnims = data.bodyAnimations.filter((a) => !a.empty)
	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF7 battle animation pack · {bodyAnims.length} animation
					{bodyAnims.length === 1 ? "" : "s"} (header sentinel: {data.sentinelCount})
				</p>
			</div>
			<div className="flex-1 overflow-auto p-4 text-xs">
				<p className="mb-2 text-muted-foreground">
					Open the matching <code>{node.name.replace(/da$/, "aa")}</code>{" "}
					skeleton to play these in 3D.
				</p>
				<table className="w-full font-mono text-xs">
					<thead>
						<tr className="border-b text-left">
							<th className="px-2 py-1">#</th>
							<th className="px-2 py-1">Frames</th>
							<th className="px-2 py-1">Quant key</th>
							<th className="px-2 py-1">Header quirk</th>
						</tr>
					</thead>
					<tbody>
						{data.bodyAnimations.map((a, i) => (
							<tr key={i} className="border-b">
								<td className="px-2 py-1">{i}</td>
								<td className="px-2 py-1">
									{a.empty ? "—" : a.frames.length}
								</td>
								<td className="px-2 py-1">{a.empty ? "—" : a.key}</td>
								<td className="px-2 py-1">
									{a.missingNumFrames2 ? "missing numFrames2" : ""}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}
