/**
 * Preview for FF7 PC pre-rendered field scenes — extensionless
 * entries inside `flevel.lgp`. Each entry is an LZSS-compressed
 * FieldModule container whose Section 4 (Palette) + Section 9
 * (Background) together encode a tile-based pre-rendered backdrop
 * (Cosmo Canyon, Midgar slums, etc.).
 *
 * The preview decompresses the entry, parses the FieldModule,
 * and composites all four tile layers (BG / movables /
 * midground / foreground) into an RGBA image. The user can
 * toggle individual layers + the script-driven "non-baseline"
 * visibility groups, and download the composited image as PNG.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import {
	decompressLzss,
	parseFieldModule,
	getSection,
	parsePalette,
	parseBackground,
	composite,
	type ParsedBackground,
	type ParsedPalette,
} from "@tootallnate/ff7-flevel"
import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"
import { triggerDownload, sanitizeStem } from "~/lib/mesh-export"

interface ParsedScene {
	palette: ParsedPalette
	background: ParsedBackground
}

async function parseScene(blob: Blob): Promise<ParsedScene> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	const decompressed = decompressLzss(bytes)
	const mod = parseFieldModule(decompressed)
	const palette = parsePalette(getSection(mod, "Palette"))
	const background = parseBackground(getSection(mod, "Background"))
	return { palette, background }
}

/**
 * Encode an RGBA pixel buffer as a PNG byte array. Uses the
 * browser's `OffscreenCanvas.convertToBlob` so we don't have
 * to ship our own zlib + PNG-chunk encoder.
 */
async function rgbaToPngBytes(
	width: number,
	height: number,
	pixels: Uint8Array,
): Promise<Uint8Array> {
	const canvas = new OffscreenCanvas(width, height)
	const ctx = canvas.getContext("2d")!
	// Allocate a fresh ArrayBuffer-backed Uint8ClampedArray so the
	// DOM-lib's strict `ArrayBuffer` (vs `SharedArrayBuffer`) check
	// is satisfied. We can't pass the source pixels directly
	// because their underlying buffer may be a SharedArrayBuffer
	// or a non-ArrayBuffer Uint8Array view.
	const clamped = new Uint8ClampedArray(width * height * 4)
	clamped.set(pixels)
	const imgData = new ImageData(clamped, width, height)
	ctx.putImageData(imgData, 0, 0)
	const pngBlob = await canvas.convertToBlob({ type: "image/png" })
	return new Uint8Array(await pngBlob.arrayBuffer())
}

export function Ff7FieldScenePreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync(
		async () => parseScene(await node.blob!()),
		[node.id],
	)
	const [includeMovables, setIncludeMovables] = useState(true)
	const [includeForeground, setIncludeForeground] = useState(true)
	const [onlyBaselineState, setOnlyBaselineState] = useState(true)

	const composited = useMemo(() => {
		if (!data) return null
		return composite(data.background, data.palette, {
			includeMovables,
			includeForeground,
			onlyBaselineState,
		})
	}, [data, includeMovables, includeForeground, onlyBaselineState])

	// Render to a canvas element. We use a `<canvas>` ref + manual
	// `putImageData` so we don't have to round-trip through a
	// `URL.createObjectURL` Blob for every option toggle.
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	useEffect(() => {
		if (!composited || !canvasRef.current) return
		const canvas = canvasRef.current
		canvas.width = composited.width
		canvas.height = composited.height
		const ctx = canvas.getContext("2d")
		if (!ctx) return
		// createImageData returns a Uint8ClampedArray with the right
		// underlying buffer type for putImageData; copy our composite
		// pixels in via `.set` rather than constructing a new
		// ImageData from a raw Uint8Array.
		const imgData = ctx.createImageData(composited.width, composited.height)
		imgData.data.set(composited.pixels)
		ctx.putImageData(imgData, 0, 0)
	}, [composited])

	if (loading) return <LoadingFiller label="Decompressing field scene…" />
	if (error) return <ErrorFiller error={error} />
	if (!data || !composited) return null

	const tilesByLayer = [0, 1, 2, 3].map(
		(l) =>
			data.background.tiles.filter((t: { layerID: number }) => t.layerID === l)
				.length,
	)
	const onDownload = async () => {
		const png = await rgbaToPngBytes(
			composited.width,
			composited.height,
			composited.pixels,
		)
		triggerDownload(png, `${sanitizeStem(node.name)}.png`, "image/png")
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF7 PC field scene · {composited.width} × {composited.height} ·{" "}
					{data.background.tiles.length.toLocaleString()} tiles
					{" "}(L0: {tilesByLayer[0]}, L1: {tilesByLayer[1]}, L2:{" "}
					{tilesByLayer[2]}, L3: {tilesByLayer[3]}) ·{" "}
					{data.background.textures.size} texture page
					{data.background.textures.size === 1 ? "" : "s"} ·{" "}
					{data.palette.pageCount} palette
					{data.palette.pageCount === 1 ? "" : "s"}
				</p>
				<div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
					<label className="flex items-center gap-1 cursor-pointer">
						<input
							type="checkbox"
							checked={includeMovables}
							onChange={(e) => setIncludeMovables(e.target.checked)}
						/>
						<span>Layer 1 (movables)</span>
					</label>
					<label className="flex items-center gap-1 cursor-pointer">
						<input
							type="checkbox"
							checked={includeForeground}
							onChange={(e) => setIncludeForeground(e.target.checked)}
						/>
						<span>Layers 2/3 (FG)</span>
					</label>
					<label className="flex items-center gap-1 cursor-pointer">
						<input
							type="checkbox"
							checked={onlyBaselineState}
							onChange={(e) => setOnlyBaselineState(e.target.checked)}
						/>
						<span>Only baseline state</span>
					</label>
					<button
						type="button"
						className="ml-auto rounded border px-2 py-1 hover:bg-accent"
						onClick={onDownload}
					>
						Download PNG
					</button>
				</div>
			</div>
			<div className="flex flex-1 items-center justify-center overflow-auto bg-[#0a0a0a] p-4">
				<canvas
					ref={canvasRef}
					className="max-w-full max-h-full"
					style={{ imageRendering: "pixelated" }}
				/>
			</div>
		</div>
	)
}
