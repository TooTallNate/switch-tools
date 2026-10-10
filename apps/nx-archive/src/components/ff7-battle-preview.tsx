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
} from "./mesh-viewer"
import {
	parseAnimationPack,
	splitRootFromFrames,
	type SplitBattleAnimation,
} from "@tootallnate/ff7-battle"
import {
	applyBattleMatricesToGeometry,
	applyBattleMatricesToTypedArrays,
	assembleBattle,
	buildBattleRig,
	computeBattleBoneMatrices,
} from "~/lib/ff7-battle-rig"

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
				baseName={node.name}
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
