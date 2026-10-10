/**
 * Media library: the high-level view of an opened game — its models,
 * music, sound effects, videos, fonts and images as a filterable grid
 * of cards, with multi-file assets merged into single items. Selecting
 * an item opens the same preview the file tree uses (3D viewer with
 * export, audio player, …); "Show in files" jumps to the source files.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  AlertTriangleIcon,
  AudioLinesIcon,
  BoxIcon,
  CopyIcon,
  DownloadIcon,
  FilmIcon,
  FolderTreeIcon,
  ImageIcon,
  Layers3Icon,
  MusicIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareIcon,
  TypeIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Spinner } from "~/components/ui/spinner"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "~/components/ui/resizable"
import type { Node } from "~/lib/archive"
import { exportableModels, exportModelsZip } from "~/lib/media/batch-export"
import { gapReportMarkdown, summarize } from "~/lib/media/gaps"
import type { ThumbResult } from "~/lib/media/thumbnails"
import { MEDIA_KIND_LABEL, MEDIA_KINDS, type MediaItem, type MediaKind } from "~/lib/media/types"
import { triggerDownload } from "~/lib/mesh-export"
import { cn, formatBytes } from "~/lib/utils"

import { PreviewPane } from "../preview-pane"
import type { MediaLibrary } from "./use-media-library"

const KIND_ICON: Record<MediaKind, typeof BoxIcon> = {
  model: BoxIcon,
  music: MusicIcon,
  sound: AudioLinesIcon,
  video: FilmIcon,
  font: TypeIcon,
  image: ImageIcon,
}

const KIND_ORDER = Object.fromEntries(MEDIA_KINDS.map((k, i) => [k, i])) as Record<MediaKind, number>

function duration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

function subtitle(item: MediaItem): string {
  const i = item.info
  const parts = [item.format]
  if (i?.durationSec !== undefined) parts.push(duration(i.durationSec))
  if (i?.triangles !== undefined) parts.push(`${i.triangles.toLocaleString()} tris`)
  if (i?.width && i?.height) parts.push(`${i.width}×${i.height}`)
  if (i?.count && i.count > 1) parts.push(`${i.count} textures`)
  if (item.parts?.length) parts.push(`${item.parts.length} files`)
  else if (item.size && i?.durationSec === undefined && i?.triangles === undefined) parts.push(formatBytes(item.size))
  return parts.join(" · ")
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function useThumb(item: MediaItem, library: MediaLibrary): ThumbResult | null {
  const [thumb, setThumb] = useState<ThumbResult | null>(null)
  useEffect(() => {
    let cancelled = false
    setThumb(null)
    library.thumbs
      ?.get(item)
      .then((t) => {
        if (!cancelled) setThumb(t)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      library.thumbs?.release(item.id)
    }
    // Thumbs depend only on the item identity, not its mutable info.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, library.thumbs])
  return thumb
}

function MediaCard({
  item,
  library,
  selected,
  onSelect,
}: {
  item: MediaItem
  library: MediaLibrary
  selected: boolean
  onSelect: () => void
}) {
  const thumb = useThumb(item, library)
  const Icon = KIND_ICON[item.kind]
  const isAudio = item.kind === "music" || item.kind === "sound"
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/60",
        selected && "border-primary ring-2 ring-primary/40",
      )}
    >
      <div
        className={cn(
          "relative flex aspect-square w-full items-center justify-center overflow-hidden",
          item.kind === "image" ? "bg-[repeating-conic-gradient(rgb(36,36,36)_0%_25%,rgb(24,24,24)_0%_50%)] bg-[length:16px_16px]" : "bg-muted/50",
        )}
      >
        {thumb?.url ? (
          <img
            src={thumb.url}
            alt=""
            draggable={false}
            className={cn("max-h-full max-w-full", isAudio ? "w-4/5 object-contain" : "object-contain")}
            style={{ imageRendering: item.kind === "image" ? "pixelated" : "auto" }}
          />
        ) : (
          <Icon className={cn("size-10 text-muted-foreground/60", !thumb && library.thumbs && "animate-pulse")} />
        )}
        {item.status !== "ok" && (
          <span
            title={item.note}
            className={cn(
              "absolute top-1.5 right-1.5 rounded px-1 py-0.5 text-[10px] font-medium",
              item.status === "error" ? "bg-destructive/90 text-white" : "bg-amber-500/90 text-black",
            )}
          >
            {item.status === "error" ? "failed" : "partial"}
          </span>
        )}
        {item.info?.animations ? (
          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
            {item.info.animations} anims
          </span>
        ) : null}
        {item.duplicates?.length ? (
          <span
            className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white"
            title={`The same file appears in ${item.duplicates.length + 1} places`}
          >
            ×{item.duplicates.length + 1}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 p-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium" title={item.title}>
            {item.title}
          </span>
        </div>
        <span className="truncate text-[10px] text-muted-foreground" title={subtitle(item)}>
          {subtitle(item)}
        </span>
      </div>
    </button>
  )
}

const CARD_MIN = 168
const GAP = 10

function MediaGrid({
  items,
  library,
  selectedId,
  onSelect,
}: {
  items: MediaItem[]
  library: MediaLibrary
  selectedId: string | null
  onSelect: (item: MediaItem) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const cols = Math.max(1, Math.floor((width - 24 + GAP) / (CARD_MIN + GAP)))
  const cardW = (width - 24 - GAP * (cols - 1)) / cols
  const rowH = cardW + 52 + GAP
  const rows = Math.ceil(items.length / cols)
  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 3,
  })
  useEffect(() => virt.measure(), [rowH, virt])

  return (
    <div ref={scrollRef} className="h-full overflow-auto px-3 py-3">
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="absolute left-0 grid w-full"
            style={{
              top: row.start,
              height: rowH - GAP,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: GAP,
            }}
          >
            {items.slice(row.index * cols, row.index * cols + cols).map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                library={library}
                selected={item.id === selectedId}
                onSelect={() => onSelect(item)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function DetailPanel({
  item,
  node,
  root,
  onClose,
  onShowInFiles,
  onNavigate,
}: {
  item: MediaItem | null
  node: Node
  root: Node
  onClose: () => void
  onShowInFiles: (id: string) => void
  onNavigate: (node: Node) => void
}) {
  const [showParts, setShowParts] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{item?.title ?? node.name}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground" title={item?.path ?? node.id}>
            {item?.path ?? node.id}
          </div>
          {item?.duplicates?.length ? (
            <div className="mt-0.5 max-h-20 overflow-auto font-mono text-[10px] text-muted-foreground">
              <span className="font-sans">Identical copies at:</span>
              {item.duplicates.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="block max-w-full truncate text-left hover:text-foreground hover:underline"
                  title={d.path}
                  onClick={() => onShowInFiles(d.id)}
                >
                  {d.path}
                </button>
              ))}
            </div>
          ) : null}
          {item && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
              <Badge variant="secondary">{MEDIA_KIND_LABEL[item.kind]}</Badge>
              <span>{item.format}</span>
              {item.parts?.length ? (
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => setShowParts((v) => !v)}>
                  merged from {item.parts.length + 1} files
                </button>
              ) : null}
              {item.note && (
                <span className={item.status === "error" ? "text-destructive" : "text-amber-500"}>{item.note}</span>
              )}
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => onShowInFiles(node.id)}>
          <FolderTreeIcon data-icon="inline-start" />
          Show in files
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close preview">
          <XIcon />
        </Button>
      </div>
      {showParts && item?.parts && (
        <div className="max-h-40 shrink-0 overflow-auto border-b bg-muted/30 px-3 py-2 font-mono text-[10px] text-muted-foreground">
          {[item.id, ...item.parts].map((p) => (
            <button key={p} type="button" className="block truncate text-left hover:text-foreground" onClick={() => onShowInFiles(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <PreviewPane node={node} root={root} onNavigate={onNavigate} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gap report
// ---------------------------------------------------------------------------

function GapsDialog({
  open,
  onOpenChange,
  library,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  library: MediaLibrary
}) {
  const index = library.index
  const md = useMemo(() => (index && open ? gapReportMarkdown(index) : ""), [index, open])
  if (!index) return null
  const s = summarize(index)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Coverage &amp; gaps</DialogTitle>
          <DialogDescription>
            What the library could and couldn&apos;t make sense of in {index.fileName}. Copy the report to hand it to an
            agent (or yourself) as a to-do list of formats to support.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
          {MEDIA_KINDS.map((k) => (
            <div key={k} className="rounded-md border bg-card p-2">
              <div className="text-muted-foreground">{MEDIA_KIND_LABEL[k]}</div>
              <div className="text-base font-medium tabular-nums">{s.counts[k].toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">Unrecognized files</div>
            <div className="font-medium tabular-nums">
              {s.unknownFiles.toLocaleString()} · {formatBytes(s.unknownBytes)}
            </div>
          </div>
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">Failed / partial media</div>
            <div className="font-medium tabular-nums">
              {s.failed} / {s.partial}
            </div>
          </div>
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">Containers that failed</div>
            <div className="font-medium tabular-nums">{index.errors.length}</div>
          </div>
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">Skipped (expensive)</div>
            <div className="font-medium tabular-nums">{index.skipped.length}</div>
          </div>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {md}
        </pre>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {index.skipped.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={library.scanning}
                onClick={() => {
                  library.rescan({ include: index.skipped.map((s) => s.id) })
                  onOpenChange(false)
                }}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Scan skipped containers
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const name = `${index.fileName.replace(/\.[^.]+$/, "")}-coverage.md`
                triggerDownload(new TextEncoder().encode(md), name, "text/markdown")
              }}
            >
              <DownloadIcon data-icon="inline-start" />
              Download .md
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(md).then(
                  () => toast.success("Gap report copied"),
                  () => toast.error("Couldn't copy to the clipboard"),
                )
              }}
            >
              <CopyIcon data-icon="inline-start" />
              Copy report
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Batch export
// ---------------------------------------------------------------------------

function ExportModelsDialog({
  open,
  onOpenChange,
  items,
  root,
  scopeKey,
  fileName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  items: MediaItem[]
  root: Node
  scopeKey: string
  fileName: string
}) {
  const models = useMemo(() => exportableModels(items), [items])
  const [format, setFormat] = useState<"stl" | "3mf">("3mf")
  const [busy, setBusy] = useState<{ done: number; total: number; current: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const run = async () => {
    const ac = new AbortController()
    abort.current = ac
    setBusy({ done: 0, total: models.length, current: "" })
    try {
      const r = await exportModelsZip(models, root, {
        format,
        scopeKey,
        signal: ac.signal,
        onProgress: (done, total, current) => setBusy({ done, total, current }),
      })
      if (r.exported > 0) {
        triggerDownload(r.zip, `${fileName.replace(/\.[^.]+$/, "")}-models-${format}.zip`, "application/zip")
      }
      if (r.failed.length) toast.warning(`${r.exported} exported, ${r.failed.length} failed`, { description: r.failed[0]?.message })
      else toast.success(`${r.exported} model${r.exported === 1 ? "" : "s"} exported`)
      onOpenChange(false)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export models</DialogTitle>
          <DialogDescription>
            {models.length.toLocaleString()} model{models.length === 1 ? "" : "s"} in the current view, each in its rest / idle pose,
            bundled into one ZIP. Every model uses this file&apos;s shared print scale (set it from any model&apos;s Export
            dialog), so characters stay proportional. Other export settings come from the Export dialog too.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {(["3mf", "stl"] as const).map((f) => (
            <Button key={f} variant={format === f ? "default" : "outline"} size="sm" onClick={() => setFormat(f)} disabled={!!busy}>
              {f === "3mf" ? "Painted 3MF" : "STL"}
            </Button>
          ))}
        </div>
        {busy && (
          <div className="flex flex-col gap-1 text-xs">
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${(busy.done / Math.max(1, busy.total)) * 100}%` }} />
            </div>
            <span className="truncate text-muted-foreground">
              {busy.done} / {busy.total} {busy.current}
            </span>
          </div>
        )}
        <DialogFooter>
          {busy ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button onClick={() => void run()} disabled={models.length === 0}>
              <DownloadIcon data-icon="inline-start" />
              Export {models.length.toLocaleString()}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function LibraryView({
  library,
  root,
  selected,
  scopeKey,
  fileName,
  onSelect,
  onShowInFiles,
}: {
  library: MediaLibrary
  root: Node
  /** Currently selected tree node (shared with the Files view / URL hash). */
  selected: Node | null
  scopeKey: string
  fileName: string
  onSelect: (id: string | null) => void
  onShowInFiles: (id: string) => void
}) {
  const [kind, setKind] = useState<MediaKind | "all" | "issues">("all")
  const [query, setQuery] = useState("")
  const [showParts, setShowParts] = useState(false)
  const [gapsOpen, setGapsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const index = library.index

  const visible = useMemo(() => (index?.items ?? []).filter((i) => showParts || !i.partOf), [index, showParts])
  const counts = useMemo(() => {
    const c = Object.fromEntries(MEDIA_KINDS.map((k) => [k, 0])) as Record<MediaKind, number>
    let issues = 0
    for (const i of visible) {
      c[i.kind]++
      if (i.status !== "ok") issues++
    }
    return { ...c, issues }
  }, [visible])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return visible
      .filter((i) => (kind === "all" ? true : kind === "issues" ? i.status !== "ok" : i.kind === kind))
      .filter((i) => !q || i.title.toLowerCase().includes(q) || i.path.toLowerCase().includes(q) || i.format.toLowerCase().includes(q))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path, undefined, { numeric: true }))
  }, [visible, kind, query])

  const itemsById = useMemo(() => new Map((index?.items ?? []).map((i) => [i.id, i])), [index])
  const selectedItem = selected ? itemsById.get(selected.id) ?? null : null
  // The root is normally the opened archive, but a standalone media file
  // (e.g. a lone model) is itself the library's only item.
  const showDetail = !!selected && (selected.id !== root.id || !root.isContainer)
  const gapCount = index ? index.unknown.length + index.errors.length + index.skipped.length + counts.issues : 0
  const exportCount = useMemo(() => exportableModels(filtered).length, [filtered])

  const chips: { key: MediaKind | "all" | "issues"; label: string; count: number }[] = [
    { key: "all", label: "All", count: visible.length },
    ...MEDIA_KINDS.map((k) => ({ key: k, label: MEDIA_KIND_LABEL[k], count: counts[k] })),
    ...(counts.issues ? [{ key: "issues" as const, label: "Issues", count: counts.issues }] : []),
  ]

  const grid = (
    <div className="flex h-full min-h-0 flex-col">
      {filtered.length > 0 ? (
        <MediaGrid
          items={filtered}
          library={library}
          selectedId={selected?.id ?? null}
          onSelect={(item) => onSelect(item.id)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
          {library.scanning || !index ? (
            <>
              <Spinner />
              <span>Looking for media…</span>
            </>
          ) : (
            <>
              <SquareIcon className="size-8 opacity-40" />
              <span>{visible.length ? "Nothing matches the current filter." : "No media found in this file."}</span>
              {!visible.length && (
                <Button variant="outline" size="sm" onClick={() => setGapsOpen(true)}>
                  See what couldn&apos;t be read
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card/40 px-3 py-2">
        <div className="relative w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search media…" className="h-8 pl-7" />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {chips.map((c) =>
            c.count === 0 && c.key !== "all" ? null : (
              <button
                key={c.key}
                type="button"
                onClick={() => setKind(c.key)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  kind === c.key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
                  c.key === "issues" && kind !== c.key && "text-amber-500",
                )}
              >
                {c.label}
                <span className="tabular-nums opacity-70">{c.count.toLocaleString()}</span>
              </button>
            ),
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
          <input type="checkbox" checked={showParts} onChange={(e) => setShowParts(e.target.checked)} />
          <Layers3Icon className="size-3.5" />
          Show parts
        </label>
        <div className="ml-auto flex items-center gap-2">
          {library.scanning ? (
            <div className="flex max-w-72 items-center gap-2 text-xs text-muted-foreground">
              <Spinner />
              <span className="shrink-0 tabular-nums">Scanning {library.progress?.visited.toLocaleString() ?? ""}</span>
              <span className="truncate font-mono text-[10px]" title={library.progress?.path}>
                {library.progress?.path}
              </span>
              <Button variant="ghost" size="icon-xs" onClick={library.cancel} aria-label="Stop scan">
                <XIcon />
              </Button>
            </div>
          ) : (
            index && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => library.rescan()}
                title={library.fromCache ? "Loaded from cache — rescan the file" : "Rescan the file"}
              >
                <RefreshCwIcon data-icon="inline-start" />
                {library.fromCache ? "Cached · rescan" : "Rescan"}
              </Button>
            )
          )}
          <Button variant="outline" size="sm" onClick={() => setGapsOpen(true)} disabled={!index}>
            <AlertTriangleIcon data-icon="inline-start" className={gapCount ? "text-amber-500" : undefined} />
            Gaps
            {gapCount > 0 && <Badge variant="secondary">{gapCount.toLocaleString()}</Badge>}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)} disabled={exportCount === 0}>
            <DownloadIcon data-icon="inline-start" />
            Export models
          </Button>
        </div>
      </div>

      {showDetail ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel id="library-grid" defaultSize="45%" minSize="20%" className="min-h-0">
            {grid}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="library-detail" defaultSize="55%" minSize="30%" className="min-h-0 bg-background">
            <DetailPanel
              item={selectedItem}
              node={selected!}
              root={root}
              onClose={() => onSelect(null)}
              onShowInFiles={onShowInFiles}
              onNavigate={(n) => onSelect(n.id)}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">{grid}</div>
      )}

      <GapsDialog open={gapsOpen} onOpenChange={setGapsOpen} library={library} />
      <ExportModelsDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        items={filtered}
        root={root}
        scopeKey={scopeKey}
        fileName={fileName}
      />
    </div>
  )
}
