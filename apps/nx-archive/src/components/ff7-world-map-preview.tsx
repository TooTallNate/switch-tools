/**
 * Preview for FF7 PC overworld map files (`wm0.map` / `wm2.map`
 * / `wm3.map`). Parses the section grid, decompresses every
 * sector, and renders the full landmass through the shared
 * {@link MeshViewer}.
 *
 * For now the mesh is rendered with **vertex colors derived from
 * walkmap type** (grass=green, sea=blue, mountain=brown, etc.).
 * Texture support could be added later by walking the sibling
 * `world_xx.lgp` archive and resolving each triangle's WMSET
 * texture entry to a `.tex` blob — but that's hundreds of
 * separate small textures and a non-trivial atlas-build task.
 * The walkmap palette is already visually striking and tells
 * the story at a glance.
 */
import { useMemo } from "react"
import {
	parseWorldMap,
	sectorVertexWorld,
	kindFromSectionCount,
	texturesForMap,
	WALKMAP_NAMES,
	REGION_NAMES,
} from "@tootallnate/ff7-world"
import type { Node } from "~/lib/archive"
import {
	MeshViewer,
	type RenderableMesh,
	type RenderableMeshLOD,
	type RenderableMeshSection,
} from "./mesh-viewer"
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
	stats: {
		sectionCount: number
		liveSections: number
		gridWidth: number
		gridHeight: number
		totalTriangles: number
		totalVertices: number
		uniqueTextures: number
	}
}

async function buildWorld(blob: Blob): Promise<BuiltWorld> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	const world = parseWorldMap(bytes)
	const kind = kindFromSectionCount(world.sections.length)
	const tex = texturesForMap(kind)
	void tex // future: texture mapping

	// One vertex per (section × sector × triangle × vertex) — no
	// dedup. World map is heavy (~140k tris on WM0), but the
	// flat-shaded vertex-color path needs unshared vertices anyway
	// because each face has its own walkmap color.
	let triCount = 0
	for (let si = 0; si < world.liveSections; si++) {
		for (const sec of world.sections[si]!.sectors) {
			triCount += sec.triangles.length
		}
	}
	const positions = new Float32Array(triCount * 9)
	const normals = new Float32Array(triCount * 9)
	const colors = new Float32Array(triCount * 9)
	const indices = new Uint32Array(triCount * 3)
	const texUsed = new Set<number>()

	// Y-down ↔ Y-up: world map vertex Y is "up" but values can be
	// negative for trenches. We negate to match three.js's +Y-up
	// convention (the source has +Y pointing DOWN per
	// reimplementation notes). Scale by 1/100 to bring the mesh
	// into a more comfortable working range (the original is ~3e5
	// units wide).
	const SCALE = 1 / 100
	let vc = 0
	let ic = 0
	for (let si = 0; si < world.liveSections; si++) {
		const sx = si % world.gridWidth
		const sz = Math.floor(si / world.gridWidth)
		for (const sec of world.sections[si]!.sectors) {
			for (const tri of sec.triangles) {
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
				// Per-vertex normals from the source (also Y-flipped).
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
				// Color all 3 verts by walkmap.
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
				// Triangle winding: reverse so OpenGL CCW front-face
				// shows the upper surface (Braver / V-Gears observation).
				indices[ic + 0] = vc + 2
				indices[ic + 1] = vc + 1
				indices[ic + 2] = vc + 0
				vc += 3
				ic += 3
				texUsed.add(tri.textureId)
			}
		}
	}

	const sections: RenderableMeshSection[] = [
		{ materialIndex: 0, firstIndex: 0, numTriangles: triCount },
	]
	const lod: RenderableMeshLOD = {
		numVertices: vc,
		positions,
		normals,
		colors,
		indices,
		sections,
		label: `${vc.toLocaleString()} verts, ${triCount.toLocaleString()} tris`,
	}
	const mesh: RenderableMesh = {
		lods: [lod],
		upAxis: "y-up",
	}
	return {
		mesh,
		stats: {
			sectionCount: world.sections.length,
			liveSections: world.liveSections,
			gridWidth: world.gridWidth,
			gridHeight: world.gridHeight,
			totalTriangles: triCount,
			totalVertices: vc,
			uniqueTextures: texUsed.size,
		},
	}
}

export function Ff7WorldMapPreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync(
		async () => buildWorld(await node.blob!()),
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
					{data.stats.uniqueTextures} unique texture references
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
				infoText={`Section grid: ${data.stats.gridWidth}×${data.stats.gridHeight}`}
			/>
		</div>
	)
}
