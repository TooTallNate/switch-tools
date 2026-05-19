/**
 * Preview for Final Fantasy VIII field-scene backgrounds.
 *
 * Each field scene lives in `field.fs/<region>/<name>.fs` (a
 * nested FFVIII archive triplet). Inside that inner triplet
 * are `<name>.map` (tile layout) and `<name>.mim` (image data)
 * sitting alongside scripts (`.jsm`), walkmesh (`.id`), camera
 * (`.ca`), character models (`chara.one`), etc.
 *
 * We're routed here because the user clicked a `.map` file —
 * we find its sibling `.mim` via the nx-archive sibling walk
 * and call `@tootallnate/ff8-field`'s `composite` to render
 * the 2D background.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { composite, detectMimType } from "@tootallnate/ff8-field"
import type { Node } from "~/lib/archive"
import { ErrorFiller, LoadingFiller, useAsync } from "./preview-pane"
import { triggerDownload, sanitizeStem } from "~/lib/mesh-export"
import { formatBytes } from "~/lib/utils"

interface ParsedScene {
	mapBytes: Uint8Array
	mimBytes: Uint8Array
	mimType: "old" | "new"
	mimSize: number
	mapName: string
	mimName: string
}

async function findSibling(node: Node, suffix: string): Promise<Node | null> {
	// Walk up via the id path. nx-archive ids are slash-delimited
	// cumulative paths, so the parent id is everything before the
	// last slash.
	const slash = node.id.lastIndexOf("/")
	if (slash <= 0) return null
	const parentId = node.id.slice(0, slash)
	// The parent is loaded lazily — we need to find a way to enumerate
	// its children. Since we have `node.id` we can re-walk the tree;
	// but a faster path is to use the `siblings` window through the
	// preview-pane's `root`. Use the simple approach: read the parent
	// children via a global lookup if present, otherwise return null.
	void parentId
	void suffix
	return null
}
void findSibling

async function parseScene(node: Node, siblings: SiblingMap | null): Promise<ParsedScene> {
	const mapBytes = new Uint8Array(await (await node.blob!()).arrayBuffer())
	const baseName = node.name.replace(/\.map$/i, "")
	const mimName = baseName + ".mim"
	// Locate sibling by exact basename in the parent's children.
	const mimBlob = siblings?.get(mimName.toLowerCase()) ?? null
	if (!mimBlob) {
		throw new Error(
			`Field scene preview needs sibling "${mimName}" alongside the .map file`,
		)
	}
	const mimBytes = new Uint8Array(await mimBlob.arrayBuffer())
	const mimType = detectMimType(mimBytes.length)
	return {
		mapBytes,
		mimBytes,
		mimType,
		mimSize: mimBytes.length,
		mapName: node.name,
		mimName,
	}
}

type SiblingMap = Map<string, Blob>

/**
 * Climb the tree from `node`'s parent and collect every sibling
 * blob keyed by lowercased name. Used to locate the `.mim` next
 * to the user-clicked `.map`.
 */
async function collectSiblings(node: Node, root: Node | null): Promise<SiblingMap> {
	const map: SiblingMap = new Map()
	if (!root) return map
	const slash = node.id.lastIndexOf("/")
	if (slash <= 0) return map
	const parentId = node.id.slice(0, slash)
	const parent = await findNodeById(root, parentId)
	if (!parent?.getChildren) return map
	const kids = parent._children ?? (parent._children = await parent.getChildren())
	for (const k of kids) {
		if (k.blob && !k.isContainer) {
			try {
				map.set(k.name.toLowerCase(), await k.blob())
			} catch {
				// Ignore unreadable siblings.
			}
		}
	}
	return map
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

export function Ff8FieldScenePreview({
	node,
	root,
}: {
	node: Node
	root: Node | null
}) {
	const { loading, data, error } = useAsync(async () => {
		const siblings = await collectSiblings(node, root)
		return parseScene(node, siblings)
	}, [node.id])
	const [bgKind, setBgKind] = useState<"dark" | "light" | "checker">("dark")
	const canvasRef = useRef<HTMLCanvasElement | null>(null)

	const result = useMemo(() => {
		if (!data) return null
		try {
			return composite(data.mapBytes, data.mimBytes)
		} catch (e) {
			console.error("composite failed:", e)
			return null
		}
	}, [data])

	useEffect(() => {
		if (!result || !canvasRef.current) return
		const canvas = canvasRef.current
		canvas.width = result.width
		canvas.height = result.height
		const ctx = canvas.getContext("2d")
		if (!ctx) return
		const clamped = new Uint8ClampedArray(result.width * result.height * 4)
		clamped.set(result.pixels)
		const img = new ImageData(clamped, result.width, result.height)
		ctx.putImageData(img, 0, 0)
	}, [result])

	const bgStyle = useMemo(() => {
		if (bgKind === "dark") return { background: "#0a0a0a" }
		if (bgKind === "light") return { background: "#f5f5f5" }
		return {
			background:
				"repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 24px 24px",
		}
	}, [bgKind])

	const downloadPng = async () => {
		if (!result || !canvasRef.current) return
		const blob = await new Promise<Blob | null>((resolve) =>
			canvasRef.current!.toBlob(resolve, "image/png"),
		)
		if (!blob) return
		const bytes = new Uint8Array(await blob.arrayBuffer())
		triggerDownload(
			bytes,
			`${sanitizeStem(node.name)}.png`,
			"image/png",
		)
	}

	if (loading) return <LoadingFiller label="Reading field scene…" />
	if (error) return <ErrorFiller error={error} />
	if (!data || !result) {
		return (
			<div className="flex h-full flex-col">
				<div className="border-b px-4 py-2">
					<h2 className="font-heading text-sm font-medium">{node.name}</h2>
					<p className="text-xs text-muted-foreground">
						Could not composite this field scene.
					</p>
				</div>
			</div>
		)
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-4 py-2">
				<h2 className="font-heading text-sm font-medium">{node.name}</h2>
				<p className="text-xs text-muted-foreground">
					FF8 field scene · {result.width}×{result.height} ·{" "}
					{result.renderedTiles.toLocaleString()} tiles · MIM "{data.mimType}"
					({formatBytes(data.mimSize)})
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
							<option value="dark">Dark</option>
							<option value="light">Light</option>
							<option value="checker">Checker</option>
						</select>
					</label>
					<button
						type="button"
						className="ml-auto rounded border px-2 py-1 hover:bg-accent"
						onClick={downloadPng}
					>
						Download PNG
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
