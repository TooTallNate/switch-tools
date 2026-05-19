/**
 * Preview for FF7 PC overworld map files (`wm0.map` / `wm2.map`
 * / `wm3.map`). Parses the section grid, decompresses every
 * sector, and renders the full landmass through the shared
 * {@link MeshViewer} with **per-triangle WMSET textures** sampled
 * from sibling `world_xx.lgp`.
 *
 * Two viewing modes (auto-selected based on availability):
 *   - **Textured**: One material per WMSET texture (282
 *     overworld / 8 underwater / 4 glacier). Triangles
 *     grouped by texture ID into per-material sections.
 *   - **Walkmap-colored** (fallback): Per-vertex RGB colors
 *     derived from each triangle's walkmap type (grass=green,
 *     sea=blue, mountain=brown, etc.). Used when no sibling
 *     `world_*.lgp` is found.
 */
import { useMemo } from "react"
import {
	parseWorldMap,
	sectorVertexWorld,
	kindFromSectionCount,
	texturesForMap,
	WALKMAP_NAMES,
	REGION_NAMES,
	type WorldTextureInfo,
} from "@tootallnate/ff7-world"
import { parseLgp } from "@tootallnate/lgp"
import { parseTex } from "@tootallnate/ff7-pc-model"
import type { Node } from "~/lib/archive"
import {
	MeshViewer,
	type RenderableMesh,
	type RenderableMeshLOD,
	type RenderableMeshSection,
} from "./mesh-viewer"
import type { DecodedTexture } from "~/lib/uasset-material-chain"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"

/**
 * Walkmap → RGB palette. Tuned to read like a hand-drawn world
 * map — grass green, sea blue, deserts golden, snow white,
 * mountains brown.
 */
const WALKMAP_COLORS: readonly [number, number, number][] = [
	[0x4d / 255, 0xaa / 255, 0x4d / 255], // 0 grass
	[0x2b / 255, 0x60 / 255, 0x2b / 255], // 1 forest
	[0x8a / 255, 0x73 / 255, 0x4d / 255], // 2 mountain
	[0x20 / 255, 0x4c / 255, 0x80 / 255], // 3 sea (deep)
	[0x6e / 255, 0x96 / 255, 0xc8 / 255], // 4 river crossing
	[0x4d / 255, 0x7a / 255, 0xc8 / 255], // 5 river
	[0x6e / 255, 0xb2 / 255, 0xc8 / 255], // 6 water (shallow)
	[0x4d / 255, 0x6b / 255, 0x3d / 255], // 7 swamp
	[0xd8 / 255, 0xc9 / 255, 0x6b / 255], // 8 desert
	[0xa1 / 255, 0x99 / 255, 0x7a / 255], // 9 wasteland
	[0xe8 / 255, 0xee / 255, 0xf0 / 255], // 10 snow
	[0x5e / 255, 0x96 / 255, 0xb6 / 255], // 11 riverside
	[0x6d / 255, 0x57 / 255, 0x33 / 255], // 12 cliff
	[0xa0 / 255, 0x70 / 255, 0x40 / 255], // 13 corel bridge
	[0xa0 / 255, 0x70 / 255, 0x40 / 255], // 14 wutai bridge
	[0x18 / 255, 0x32 / 255, 0x5e / 255], // 15 underwater tunnel
	[0x8e / 255, 0x77 / 255, 0x4d / 255], // 16 hill side
	[0xe0 / 255, 0xc8 / 255, 0x90 / 255], // 17 beach
	[0x60 / 255, 0x60 / 255, 0x80 / 255], // 18 sub pen
	[0xa0 / 255, 0x67 / 255, 0x3d / 255], // 19 canyon
	[0x88 / 255, 0x60 / 255, 0x30 / 255], // 20 mountain pass
	[0x60 / 255, 0x60 / 255, 0x60 / 255], // 21 unknown bridges
	[0x70 / 255, 0xa0 / 255, 0xc8 / 255], // 22 waterfall
	[0x40 / 255, 0x40 / 255, 0x40 / 255], // 23 unused
	[0xc8 / 255, 0xb8 / 255, 0x60 / 255], // 24 gold saucer desert
	[0x2a / 255, 0x55 / 255, 0x2a / 255], // 25 jungle
	[0x20 / 255, 0x4c / 255, 0x80 / 255], // 26 sea (2)
	[0x60 / 255, 0x30 / 255, 0x60 / 255], // 27 northern cave
	[0xb8 / 255, 0xa0 / 255, 0x50 / 255], // 28 gs desert border
	[0xa0 / 255, 0x70 / 255, 0x40 / 255], // 29 bridgehead
	[0x60 / 255, 0x60 / 255, 0x60 / 255], // 30 back entrance
	[0x40 / 255, 0x40 / 255, 0x40 / 255], // 31 unused
]

interface BuiltWorld {
	mesh: RenderableMesh
	materialTextures: (DecodedTexture | null)[]
	stats: {
		sectionCount: number
		liveSections: number
		gridWidth: number
		gridHeight: number
		totalTriangles: number
		totalVertices: number
		uniqueTextures: number
		texturesLoaded: number
	}
}

/**
 * Find a sibling `world_*.lgp` next to the .map file. The Switch
 * port ships per-language archives (`world_us.lgp`, `world_de.lgp`,
 * ...); the original PC has just `world_us.lgp`. We pick the first
 * one we find — they all carry the same texture pixels, only the
 * `mes` text differs.
 */
async function findSiblingWorldLgp(
	mapNode: Node,
	root: Node | null,
): Promise<Node | null> {
	if (!root) return null
	const slash = mapNode.id.lastIndexOf("/")
	if (slash <= 0) return null
	const parentId = mapNode.id.slice(0, slash)
	const parent = await findNodeById(root, parentId)
	if (!parent?.getChildren) return null
	const kids = parent._children ?? (parent._children = await parent.getChildren())
	for (const k of kids) {
		if (/^world(_\w+)?\.lgp$/i.test(k.name)) return k
	}
	return null
}

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

/**
 * Load every texture referenced by `usedTextureIds` from the
 * sibling LGP. Returns a parallel map id → DecodedTexture (null
 * for any that failed to parse).
 */
async function loadWorldTextures(
	lgpNode: Node,
	textureTable: readonly WorldTextureInfo[],
	usedTextureIds: Set<number>,
): Promise<Map<number, DecodedTexture>> {
	const lgpBlob = await lgpNode.blob!()
	const lgp = await parseLgp(lgpBlob)
	const byName = new Map<string, Blob>()
	for (const e of lgp.entries) byName.set(e.name.toLowerCase(), e.data)
	const out = new Map<number, DecodedTexture>()
	for (const id of usedTextureIds) {
		const info = textureTable[id]
		if (!info) continue
		const blob = byName.get((info.name + ".tex").toLowerCase())
		if (!blob) continue
		try {
			const tex = parseTex(new Uint8Array(await blob.arrayBuffer()))
			out.set(id, {
				packagePath: info.name,
				width: tex.width,
				height: tex.height,
				pixels: tex.pixels,
				pixelFormat: tex.paletted ? "TEX8" : `TEX${tex.bitsPerPixel}`,
				normalReconstructed: false,
				flipY: false,
			})
		} catch {
			// Swallow texture-load failures — fall back to walkmap
			// color for these slots.
		}
	}
	return out
}

async function buildWorld(node: Node, root: Node | null): Promise<BuiltWorld> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer())
	const world = parseWorldMap(bytes)
	const kind = kindFromSectionCount(world.sections.length)
	const textureTable = texturesForMap(kind)

	// First pass: enumerate every triangle to gather (a) total
	// counts and (b) the set of texture IDs in use.
	const usedTexIds = new Set<number>()
	let triCount = 0
	for (let si = 0; si < world.liveSections; si++) {
		for (const sec of world.sections[si]!.sectors) {
			triCount += sec.triangles.length
			for (const tri of sec.triangles) usedTexIds.add(tri.textureId)
		}
	}

	// Try to resolve sibling LGP + load only the textures we need.
	const lgpNode = await findSiblingWorldLgp(node, root)
	const texturesById: Map<number, DecodedTexture> = lgpNode
		? await loadWorldTextures(lgpNode, textureTable, usedTexIds)
		: new Map()
	const hasTextures = texturesById.size > 0

	// Decide on material slots. With textures: one slot per used
	// texture ID, plus slot 0 reserved for "untextured" fallback.
	// Without textures: one slot total, vertex-colored.
	const sortedTexIds = [...usedTexIds].sort((a, b) => a - b)
	const texIdToSlot = new Map<number, number>()
	if (hasTextures) {
		// Slot 0 = untextured (walkmap-colored) fallback for
		// triangles whose texture failed to load.
		for (let i = 0; i < sortedTexIds.length; i++) {
			texIdToSlot.set(sortedTexIds[i]!, i + 1)
		}
	} else {
		for (const id of sortedTexIds) texIdToSlot.set(id, 0)
	}

	const positions = new Float32Array(triCount * 9)
	const normals = new Float32Array(triCount * 9)
	const colors = new Float32Array(triCount * 9)
	const uvs = new Float32Array(triCount * 6)
	const indices = new Uint32Array(triCount * 3)

	// Group triangles by material slot (so MeshViewer can render
	// one draw call per material). We pre-scan to count how many
	// triangles per slot, then fill them in slot order.
	const slotCount = hasTextures ? sortedTexIds.length + 1 : 1
	const trisPerSlot = new Array<number>(slotCount).fill(0)
	for (let si = 0; si < world.liveSections; si++) {
		for (const sec of world.sections[si]!.sectors) {
			for (const tri of sec.triangles) {
				const texId = tri.textureId
				const slot = hasTextures
					? (texturesById.has(texId) ? texIdToSlot.get(texId)! : 0)
					: 0
				trisPerSlot[slot]!++
			}
		}
	}
	// Cumulative offsets where each slot's triangles start.
	const slotStart = new Array<number>(slotCount).fill(0)
	for (let i = 1; i < slotCount; i++) {
		slotStart[i] = slotStart[i - 1]! + trisPerSlot[i - 1]!
	}
	const slotCursor = slotStart.slice()

	const SCALE = 1 / 100
	for (let si = 0; si < world.liveSections; si++) {
		const sx = si % world.gridWidth
		const sz = Math.floor(si / world.gridWidth)
		for (const sec of world.sections[si]!.sectors) {
			for (const tri of sec.triangles) {
				const texId = tri.textureId
				const slot = hasTextures
					? (texturesById.has(texId) ? texIdToSlot.get(texId)! : 0)
					: 0
				const triIdx = slotCursor[slot]!++
				const vc = triIdx * 3
				const ic = triIdx * 3
				const v0 = sec.vertices[tri.v0]!
				const v1 = sec.vertices[tri.v1]!
				const v2 = sec.vertices[tri.v2]!
				const w0 = sectorVertexWorld(v0, sec, sx, sz)
				const w1 = sectorVertexWorld(v1, sec, sx, sz)
				const w2 = sectorVertexWorld(v2, sec, sx, sz)
				positions[vc * 3 + 0] = w0.x * SCALE
				positions[vc * 3 + 1] = -w0.y * SCALE
				positions[vc * 3 + 2] = w0.z * SCALE
				positions[(vc + 1) * 3 + 0] = w1.x * SCALE
				positions[(vc + 1) * 3 + 1] = -w1.y * SCALE
				positions[(vc + 1) * 3 + 2] = w1.z * SCALE
				positions[(vc + 2) * 3 + 0] = w2.x * SCALE
				positions[(vc + 2) * 3 + 1] = -w2.y * SCALE
				positions[(vc + 2) * 3 + 2] = w2.z * SCALE
				const n0 = sec.normals[tri.v0]!
				const n1 = sec.normals[tri.v1]!
				const n2 = sec.normals[tri.v2]!
				normals[vc * 3 + 0] = n0.x
				normals[vc * 3 + 1] = -n0.y
				normals[vc * 3 + 2] = n0.z
				normals[(vc + 1) * 3 + 0] = n1.x
				normals[(vc + 1) * 3 + 1] = -n1.y
				normals[(vc + 1) * 3 + 2] = n1.z
				normals[(vc + 2) * 3 + 0] = n2.x
				normals[(vc + 2) * 3 + 1] = -n2.y
				normals[(vc + 2) * 3 + 2] = n2.z
				const col = WALKMAP_COLORS[tri.walkmap] ?? [0.5, 0, 0.5]
				colors[vc * 3 + 0] = col[0]
				colors[vc * 3 + 1] = col[1]
				colors[vc * 3 + 2] = col[2]
				colors[(vc + 1) * 3 + 0] = col[0]
				colors[(vc + 1) * 3 + 1] = col[1]
				colors[(vc + 1) * 3 + 2] = col[2]
				colors[(vc + 2) * 3 + 0] = col[0]
				colors[(vc + 2) * 3 + 1] = col[1]
				colors[(vc + 2) * 3 + 2] = col[2]
				// UVs: PSX-vRAM raw → per-texture normalized.
				const info = textureTable[texId]
				if (info) {
					uvs[vc * 2 + 0] = (tri.u0 - info.uOffset) / info.width
					uvs[vc * 2 + 1] = (tri.v0uv - info.vOffset) / info.height
					uvs[(vc + 1) * 2 + 0] = (tri.u1 - info.uOffset) / info.width
					uvs[(vc + 1) * 2 + 1] = (tri.v1uv - info.vOffset) / info.height
					uvs[(vc + 2) * 2 + 0] = (tri.u2 - info.uOffset) / info.width
					uvs[(vc + 2) * 2 + 1] = (tri.v2uv - info.vOffset) / info.height
				}
				// Triangle winding: reverse so OpenGL CCW front-face
				// matches the source's CW orientation.
				indices[ic + 0] = vc + 2
				indices[ic + 1] = vc + 1
				indices[ic + 2] = vc + 0
			}
		}
	}

	// Build sections: one per material slot.
	const sections: RenderableMeshSection[] = []
	for (let slot = 0; slot < slotCount; slot++) {
		if (trisPerSlot[slot]! === 0) continue
		sections.push({
			materialIndex: slot,
			firstIndex: slotStart[slot]! * 3,
			numTriangles: trisPerSlot[slot]!,
		})
	}

	// Material textures array: index 0 is the untextured fallback
	// (null → MeshViewer uses vertex colors); subsequent slots are
	// the textures in `sortedTexIds` order.
	const materialTextures: (DecodedTexture | null)[] = []
	if (hasTextures) {
		materialTextures.push(null) // slot 0: walkmap-colored fallback
		for (const id of sortedTexIds) {
			materialTextures.push(texturesById.get(id) ?? null)
		}
	}

	const lod: RenderableMeshLOD = {
		numVertices: triCount * 3,
		positions,
		normals,
		colors,
		uv: hasTextures ? uvs : undefined,
		indices,
		sections,
		label: `${(triCount * 3).toLocaleString()} verts, ${triCount.toLocaleString()} tris`,
	}
	const mesh: RenderableMesh = {
		lods: [lod],
		upAxis: "y-up",
	}
	return {
		mesh,
		materialTextures,
		stats: {
			sectionCount: world.sections.length,
			liveSections: world.liveSections,
			gridWidth: world.gridWidth,
			gridHeight: world.gridHeight,
			totalTriangles: triCount,
			totalVertices: triCount * 3,
			uniqueTextures: usedTexIds.size,
			texturesLoaded: texturesById.size,
		},
	}
}

export function Ff7WorldMapPreview({
	node,
	root,
}: {
	node: Node
	root: Node | null
}) {
	const { loading, data, error } = useAsync(
		() => buildWorld(node, root),
		[node.id],
	)

	const walkmapLegend = useMemo(() => {
		const entries: { name: string; rgb: string; idx: number }[] = []
		for (let i = 0; i < WALKMAP_COLORS.length; i++) {
			const [r, g, b] = WALKMAP_COLORS[i]!
			const rgb = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
			entries.push({ name: WALKMAP_NAMES[i] ?? `Walkmap ${i}`, rgb, idx: i })
		}
		return entries
	}, [])
	void REGION_NAMES // future: per-region tinting

	if (loading) return <LoadingFiller label="Decompressing world map…" />
	if (error) return <ErrorFiller error={error} />
	if (!data) return null

	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF7 world map · {data.stats.gridWidth}×{data.stats.gridHeight} grid (
					{data.stats.liveSections} live sections, {data.stats.sectionCount}{" "}
					total) ·{" "}
					{data.stats.totalTriangles.toLocaleString()} triangles ·{" "}
					{data.stats.texturesLoaded} / {data.stats.uniqueTextures} textures
					loaded
				</p>
				<details className="mt-1 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						Walkmap legend
					</summary>
					<div className="mt-1 grid grid-cols-3 gap-x-3 gap-y-0.5">
						{walkmapLegend.map((e) => (
							<div key={e.idx} className="flex items-center gap-1">
								<span
									className="inline-block size-3 border"
									style={{ backgroundColor: e.rgb }}
								/>
								<span>
									{e.idx}: {e.name}
								</span>
							</div>
						))}
					</div>
				</details>
			</div>
			<MeshViewer
				mesh={data.mesh}
				materialDiffuseTextures={
					data.materialTextures.length > 0 ? data.materialTextures : undefined
				}
				infoText={`Section grid: ${data.stats.gridWidth}×${data.stats.gridHeight}`}
			/>
		</div>
	)
}
