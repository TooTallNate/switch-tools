/**
 * Preview for Microsoft DirectDraw Surface (`.dds`) texture
 * files. Decodes BC1/2/3/4/5 + DX10 + uncompressed RGBA via
 * `@tootallnate/dds` and paints into a `<canvas>`.
 *
 * Also handles FFVIII Switch Remastered's `.ddsz`: the
 * archive-tree dispatcher tags those with `meta.ddsz = true`
 * and exposes the already-LZ4-decompressed DDS as the node's
 * blob. From this preview's perspective they're identical to
 * a plain `.dds`.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { parseDds } from "@tootallnate/dds"
import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"
import { triggerDownload, sanitizeStem } from "~/lib/mesh-export"
import { formatBytes } from "~/lib/utils"

interface ParsedView {
	width: number
	height: number
	pixels: Uint8Array
	formatLabel: string
	rawDdsBytes: Uint8Array
}

async function parse(blob: Blob): Promise<ParsedView> {
	const rawDdsBytes = new Uint8Array(await blob.arrayBuffer())
	const parsed = parseDds(rawDdsBytes)
	return {
		width: parsed.width,
		height: parsed.height,
		pixels: parsed.pixels,
		formatLabel: parsed.formatLabel,
		rawDdsBytes,
	}
}

export function DdsPreview({ node }: { node: Node }) {
	const { loading, data, error } = useAsync(
		async () => parse(await node.blob!()),
		[node.id],
	)
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const [bgKind, setBgKind] = useState<"dark" | "light" | "checker">(
		"checker",
	)

	useEffect(() => {
		if (!data || !canvasRef.current) return
		const canvas = canvasRef.current
		canvas.width = data.width
		canvas.height = data.height
		const ctx = canvas.getContext("2d")
		if (!ctx) return
		const clamped = new Uint8ClampedArray(data.width * data.height * 4)
		clamped.set(data.pixels)
		const img = new ImageData(clamped, data.width, data.height)
		ctx.putImageData(img, 0, 0)
	}, [data])

	const bgStyle = useMemo(() => {
		if (bgKind === "dark") return { background: "#0a0a0a" }
		if (bgKind === "light") return { background: "#f5f5f5" }
		// 16-px checkerboard
		return {
			background:
				"repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 24px 24px",
		}
	}, [bgKind])

	const downloadDds = () => {
		if (!data) return
		triggerDownload(
			data.rawDdsBytes,
			`${sanitizeStem(node.name)}.dds`,
			"image/vnd.ms-dds",
		)
	}

	const downloadPng = async () => {
		if (!data) return
		const canvas = canvasRef.current
		if (!canvas) return
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/png"),
		)
		if (!blob) return
		const bytes = new Uint8Array(await blob.arrayBuffer())
		triggerDownload(bytes, `${sanitizeStem(node.name)}.png`, "image/png")
	}

	if (loading) return <LoadingFiller label="Decoding DDS…" />
	if (error) return <ErrorFiller error={error} />
	if (!data) return null

	const isDdsz = node.meta?.ddsz === true
	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					{isDdsz ? "DDSZ (LZ4-compressed) · " : ""}
					{data.formatLabel} · {data.width}×{data.height} ·{" "}
					{formatBytes(data.rawDdsBytes.length)} raw DDS
				</p>
				<div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
					<label className="flex items-center gap-1">
						<span>Background:</span>
						<select
							value={bgKind}
							onChange={(e) =>
								setBgKind(e.target.value as "dark" | "light" | "checker")
							}
							className="rounded border bg-background px-1 py-0.5"
						>
							<option value="checker">Checker</option>
							<option value="dark">Dark</option>
							<option value="light">Light</option>
						</select>
					</label>
					<button
						type="button"
						className="ml-auto rounded border px-2 py-1 hover:bg-accent"
						onClick={downloadPng}
					>
						Download PNG
					</button>
					<button
						type="button"
						className="rounded border px-2 py-1 hover:bg-accent"
						onClick={downloadDds}
					>
						Download DDS
					</button>
				</div>
			</div>
			<div
				className="flex flex-1 items-center justify-center overflow-auto"
				style={bgStyle}
			>
				<canvas
					ref={canvasRef}
					className="max-w-full max-h-full"
					style={{ imageRendering: "pixelated" }}
				/>
			</div>
		</div>
	)
}
