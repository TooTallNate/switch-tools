import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileSearchIcon,
  GlobeIcon,
  HomeIcon,
  PackageOpenIcon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { ScrollArea } from "~/components/ui/scroll-area"
import { Separator } from "~/components/ui/separator"
import { Skeleton } from "~/components/ui/skeleton"
import { Spinner } from "~/components/ui/spinner"
import {
  parseNcaForNode,
  type NcaSource,
  type Node,
} from "~/lib/archive"
import {
  NCA_FS_TYPE_PFS0,
  NCA_FS_TYPE_ROMFS,
  NcaContentType,
  type NcaSection,
  type ParsedNca,
} from "@tootallnate/nca"
import {
  HtdocsBundle,
  buildNxShim,
  flattenHtdocs,
  regionDisplayName,
  rewriteHtml,
} from "~/lib/htdocs"
import type { RomFsEntry } from "@tootallnate/romfs"
import type { RenderableBffnt } from "@tootallnate/bffnt"
import {
  AUDIO_MIME,
  IMAGE_MIME,
  VIDEO_MIME,
  buildHexDump,
  detectPreviewKind,
  extOf,
  parseBffntForView,
  parseFontForView,
  parseCnmtForView,
  parseNacpForView,
  parseNpdmForView,
  parseNroForView,
  parseNsoForView,
  renderBffntText,
  type FontView,
  type CnmtView,
  type NacpView,
  type NpdmView,
  type NroView,
  type NsoView,
  type PreviewKind,
} from "~/lib/preview"
import {
  highlightCode,
  languageForFile,
  type SupportedLang,
} from "~/lib/highlight"
import { useTheme } from "next-themes"
import { cn, formatBytes } from "~/lib/utils"

const TEXT_PREVIEW_LIMIT = 1 * 1024 * 1024 // 1 MB
const HEX_PREVIEW_LIMIT = 4 * 1024 // 4 KB hex window
const IMAGE_PREVIEW_LIMIT = 32 * 1024 * 1024
const MEDIA_PREVIEW_LIMIT = 200 * 1024 * 1024

interface PreviewPaneProps {
  node: Node | null
}

export function PreviewPane({ node }: PreviewPaneProps) {
  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileSearchIcon />
            </EmptyMedia>
            <EmptyTitle>No file selected</EmptyTitle>
            <EmptyDescription>
              Choose a file from the tree on the left to preview its contents,
              or expand a directory to browse deeper.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return <PreviewContent key={node.id} node={node} />
}

function PreviewContent({ node }: { node: Node }) {
  const isFile = !node.isContainer
  const kind = useMemo<PreviewKind | null>(
    () => (isFile ? detectPreviewKind(node.name) : null),
    [isFile, node.name],
  )

  // Container nodes that have a dedicated structured preview instead
  // of the generic "expand me" empty state.
  const isHtdocs = node.kind === "htdocs"
  const isNca = node.kind === "nca"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewHeader node={node} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {isHtdocs ? (
          <HtdocsPreview node={node} />
        ) : isNca ? (
          <NcaPreview node={node} />
        ) : node.isContainer ? (
          <ContainerSummary node={node} />
        ) : (
          <FilePreview node={node} kind={kind!} />
        )}
      </div>
    </div>
  )
}

function PreviewHeader({ node }: { node: Node }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b bg-card px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-heading text-sm font-medium">{node.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {node.format && (
            <Badge variant="secondary" className="font-mono uppercase">
              {node.format}
            </Badge>
          )}
          {node.size !== undefined && <span>{formatBytes(node.size)}</span>}
          <span className="truncate font-mono opacity-60">{node.id}</span>
        </div>
      </div>
      {node.blob && <DownloadButton blobFn={node.blob} fileName={node.name} />}
    </div>
  )
}

function ContainerSummary({ node }: { node: Node }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PackageOpenIcon />
          </EmptyMedia>
          <EmptyTitle>{node.format ?? "Container"} archive</EmptyTitle>
          <EmptyDescription>
            Expand this entry in the tree on the left to browse its contents.
            {node.blob && " You can also download the raw container."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}

// ====================================================================
// Htdocs interactive preview
// ====================================================================

interface NxLogEntry {
  id: number
  ts: number
  text: string
  detail?: string
}

const NX_BRIDGE = "nx-archive:htdocs-bridge"

function HtdocsPreview({ node }: { node: Node }) {
  const htdocsRoot = node.meta?.htdocsRoot as RomFsEntry | undefined

  // Build the bundle once per node. This materializes every file in the
  // manual into a real Blob (which decrypts lazy NCA-section facades on
  // the way through) and creates an object URL per file. The cleanup
  // effect revokes them when the user navigates away.
  const [bundle, setBundle] = useState<HtdocsBundle | null>(null)
  const [bundleError, setBundleError] = useState<Error | null>(null)
  useEffect(() => {
    if (!htdocsRoot) {
      setBundle(null)
      setBundleError(null)
      return
    }
    let cancelled = false
    let built: HtdocsBundle | null = null
    setBundle(null)
    setBundleError(null)
    const files = flattenHtdocs(htdocsRoot)
    HtdocsBundle.build(files)
      .then((b) => {
        if (cancelled) {
          b.dispose()
          return
        }
        built = b
        setBundle(b)
      })
      .catch((err: Error) => {
        if (!cancelled) setBundleError(err)
      })
    return () => {
      cancelled = true
      built?.dispose()
    }
  }, [htdocsRoot])

  const entryPoint = useMemo(() => bundle?.pickEntryPoint() ?? null, [bundle])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [log, setLog] = useState<NxLogEntry[]>([])
  const logIdRef = useRef(0)
  // For Switch offline manuals that route by `?r=N` query param: the
  // currently-chosen region key. Defaults to the table's preferred
  // default key (`'All'`, then `'1'`, then first defined). Persists
  // across in-bundle navigations so picking Japan once keeps you on
  // Japanese pages until you change it.
  const [regionKey, setRegionKey] = useState<string | null>(null)

  // Look up the regions table (if any) that applies to the current
  // document. Updated on every navigation; if the user navigates into
  // a sub-tree with its own regions.js, we'd pick that one up too.
  //
  // We also compute whether the *current* document is itself a region
  // *router* — i.e. NOT one of the regional pages listed as a value in
  // the table. Without this distinction we'd inject `?r=N` into the
  // resolved regional page too, and any second redirect attempt
  // there would loop. The router pages (typically `index.html`) don't
  // appear in the table's values; the regional pages (`index_US.html`)
  // do.
  const regionsTable = useMemo(() => {
    if (!bundle || !currentPath) return null
    return bundle.regionsForDocument(currentPath) ?? null
  }, [bundle, currentPath])
  const isRouterPage = useMemo(() => {
    if (!regionsTable || !currentPath) return false
    // Strip the directory part to compare against table values
    // (which are file names relative to the regions.js dir).
    const fileName = currentPath.split('/').pop() ?? currentPath
    return !Object.values(regionsTable.regions).includes(fileName)
  }, [regionsTable, currentPath])

  // Reset to the entry point whenever a fresh bundle becomes available.
  useEffect(() => {
    setCurrentPath(entryPoint)
    setHistory([])
    setLog([])
    logIdRef.current = 0
    // Pick a default region if the bundle has any regions.js.
    if (entryPoint && bundle) {
      const t = bundle.regionsForDocument(entryPoint)
      setRegionKey(t ? t.defaultKey : null)
    } else {
      setRegionKey(null)
    }
  }, [entryPoint, bundle])

  // Switch offline manuals universally use a one-line "router"
  // index.html that reads `?r=N` from the URL and redirects to a
  // localised page (`index_All.html`, `index_US.html`, …). Inside a
  // srcdoc iframe `location.search` is `''`, so the router script
  // falls through and renders an empty body. We could (and do) try
  // to override `location.search` from inside the iframe — see
  // `buildLocationSearchOverride` — but the `Location` exotic
  // object is locked down enough that the override silently fails
  // in some browsers.
  //
  // The reliable fix is to short-circuit the router from the OUTSIDE:
  // if we're about to load a router page AND we know the region,
  // redirect to `regions[regionKey]` directly. The user never sees
  // the empty router page.
  useEffect(() => {
    if (!bundle || !currentPath || !regionsTable || !regionKey) return
    if (!isRouterPage) return
    const target = regionsTable.regions[regionKey]
    if (!target) return
    // Resolve the regional page relative to the regions.js directory.
    const dir = regionsTable.scriptPath.includes("/")
      ? regionsTable.scriptPath.slice(
          0,
          regionsTable.scriptPath.lastIndexOf("/"),
        )
      : ""
    const resolved = bundle.resolvePath(
      dir ? `${dir}/x` : "x",
      target,
    )
    if (resolved && resolved !== currentPath) {
      // Push the router page onto history so the back button can
      // return there if the user wants to inspect it.
      setHistory((h) => [...h, currentPath])
      setCurrentPath(resolved)
    }
  }, [bundle, currentPath, regionsTable, regionKey, isRouterPage])

  const appendLog = useCallback((text: string, detail?: string) => {
    setLog((prev) => {
      const next: NxLogEntry = {
        id: ++logIdRef.current,
        ts: Date.now(),
        text,
        detail,
      }
      // Keep the panel from growing unbounded.
      const trimmed = prev.length > 200 ? prev.slice(-200) : prev
      return [...trimmed, next]
    })
  }, [])

  // Receive postMessage events from the iframe (the `window.nx` shim
  // posts here for every method that's interesting to the host).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data
      if (!d || typeof d !== "object" || d.kind !== NX_BRIDGE) return
      switch (d.type) {
        case "ready":
          appendLog("ready", d.url)
          break
        case "debug":
          appendLog("[debug]", String(d.message ?? ""))
          break
        case "sendMessage":
          appendLog("nx.sendMessage", d.message)
          break
        case "endApplet":
          appendLog("nx.endApplet (closing)")
          // Going back in history is the closest analog to closing the
          // applet — pop one navigation, otherwise return to the entry.
          setHistory((h) => {
            if (h.length) {
              setCurrentPath(h[h.length - 1])
              return h.slice(0, -1)
            }
            setCurrentPath(entryPoint)
            return []
          })
          toast.info("nx.endApplet() — manual requested close")
          break
        case "playSystemSe":
          appendLog("nx.playSystemSe", String(d.name ?? ""))
          break
        case "footer.setAssign":
          appendLog(`nx.footer.setAssign(${d.button})`, String(d.label ?? ""))
          break
        case "footer.unsetAssign":
          appendLog(`nx.footer.unsetAssign(${d.button})`)
          break
        case "dialog.open1":
        case "dialog.open2":
          appendLog(`nx.${d.type === "dialog.open1" ? "open1" : "open2"}ButtonDialog`, JSON.stringify(d.opts))
          break
        case "system.lockUserOperation":
        case "system.unlockUserOperation":
          appendLog(d.type)
          break
        case "system.showError":
          appendLog("nx.system.showError", String(d.code ?? ""))
          break
        case "navigate":
          // Navigate to a same-bundle path. resolvePath handles the
          // relative-vs-absolute logic.
          if (!bundle) break
          // The href is relative to the *current* document, which is what
          // resolvePath wants.
          if (currentPath == null) break
          const resolved = bundle.resolvePath(currentPath, String(d.href))
          if (resolved) {
            setHistory((h) => [...h, currentPath])
            setCurrentPath(resolved)
          } else {
            appendLog("navigate (external; ignored)", String(d.href))
          }
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [appendLog, bundle, currentPath, entryPoint])

  // Compute the iframe document. We re-rewrite the HTML every time the
  // user navigates within the bundle (each page has its own base path
  // for resolving relative URLs) AND every time the chosen region
  // changes (the rewriter injects a `location.search = '?r=N'`
  // override that gets baked into the bootstrap script).
  const [iframeSrcDoc, setIframeSrcDoc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!bundle || !currentPath) {
      setIframeSrcDoc(null)
      return
    }
    const blob = bundle.files.get(currentPath)
    if (!blob) {
      setIframeSrcDoc(null)
      return
    }
    blob.text().then((html) => {
      if (cancelled) return
      const rewritten = rewriteHtml(html, currentPath, bundle, {
        nxShim: buildNxShim(NX_BRIDGE),
        bridgeName: NX_BRIDGE,
        // Only inject `?r=N` on the *router* page — the one that reads
        // `location.search` and redirects to a region-specific page.
        // Injecting it on the regional pages too would either be a
        // no-op (they don't read location.search) or, worse, cause an
        // infinite redirect loop on any router-like sub-page.
        forcedSearch:
          isRouterPage && regionKey ? `?r=${regionKey}` : undefined,
      })
      setIframeSrcDoc(rewritten)
    })
    return () => {
      cancelled = true
    }
  }, [bundle, currentPath, regionsTable, regionKey])

  if (!htdocsRoot) {
    return (
      <Empty className="m-8 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>htdocs preview unavailable</EmptyTitle>
          <EmptyDescription>
            The directory&rsquo;s file map is missing — try collapsing this
            entry in the tree and re-expanding it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (bundleError) {
    return (
      <Empty className="m-8 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Couldn&rsquo;t load the manual</EmptyTitle>
          <EmptyDescription>{bundleError.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (!bundle) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Spinner className="mr-2" />
        Decrypting manual contents…
      </div>
    )
  }

  if (!currentPath) {
    return (
      <Empty className="m-8 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileSearchIcon />
          </EmptyMedia>
          <EmptyTitle>No HTML entry point found</EmptyTitle>
          <EmptyDescription>
            The directory contains no <code>.html</code> files we could find.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const goHome = () => {
    setHistory([])
    setCurrentPath(entryPoint)
  }

  const goBack = () => {
    setHistory((h) => {
      if (!h.length) return h
      const next = h[h.length - 1]
      setCurrentPath(next)
      return h.slice(0, -1)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-2">
        <Button
          size="icon-sm"
          variant="outline"
          onClick={goBack}
          disabled={!history.length}
          aria-label="Go back"
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={goHome}
          disabled={currentPath === entryPoint}
          aria-label="Go to entry point"
        >
          <HomeIcon />
        </Button>
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {currentPath}
        </div>
        {regionsTable && regionKey && (
          <RegionPicker
            regions={regionsTable.regions}
            selectedKey={regionKey}
            onChange={(newKey) => {
              setRegionKey(newKey)
              // Navigate directly to the new region's page. We don't
              // rely on the router-page short-circuit effect for this
              // because the user is typically already on a regional
              // page when they switch — that effect only fires when
              // currentPath is the router itself.
              if (currentPath && bundle) {
                const target = regionsTable.regions[newKey]
                if (target) {
                  const dir = regionsTable.scriptPath.includes("/")
                    ? regionsTable.scriptPath.slice(
                        0,
                        regionsTable.scriptPath.lastIndexOf("/"),
                      )
                    : ""
                  const resolved = bundle.resolvePath(
                    dir ? `${dir}/x` : "x",
                    target,
                  )
                  if (resolved && resolved !== currentPath) {
                    setHistory((h) => [...h, currentPath])
                    setCurrentPath(resolved)
                  }
                }
              }
            }}
          />
        )}
        <Badge variant="secondary" className="font-mono">
          {bundle.urls.size} files
        </Badge>
        <Button
          size="sm"
          variant={showLog ? "default" : "outline"}
          onClick={() => setShowLog((v) => !v)}
          title="Toggle window.nx call log"
        >
          <TerminalIcon data-icon="inline-start" />
          nx log
          {log.length > 0 && (
            <Badge variant="secondary" className="ml-1.5">
              {log.length}
            </Badge>
          )}
        </Button>
      </div>

      {/* Iframe + optional debug panel */}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-hidden">
          {iframeSrcDoc ? (
            <iframe
              key={currentPath}
              srcDoc={iframeSrcDoc}
              title={`htdocs: ${currentPath}`}
              // Sandbox notes:
              //   `allow-scripts` — manuals always have inline JS
              //   `allow-same-origin` — REQUIRED to fetch the blob: URLs
              //     we mint for the manual's CSS/images/fonts/scripts.
              //     Without this, browsers (Firefox especially) treat
              //     the iframe as a unique opaque origin that isn't
              //     allowed to read blobs created by the parent.
              //     Trade-off: the manual's scripts can technically
              //     reach `window.parent`, but this is a local viewer
              //     of content the user is already inspecting, not
              //     an untrusted-content sandbox. The same trade-off
              //     applies to Chrome DevTools / GitHub HTML preview.
              //   `allow-popups` `allow-forms` — quality-of-life for
              //     manuals that pop dialogs or have search forms.
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              className="size-full border-0 bg-white"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Spinner className="mr-2" />
              Loading…
            </div>
          )}
        </div>
        {showLog && (
          <aside className="flex w-[28rem] min-h-0 shrink-0 flex-col border-l bg-card">
            <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
              <div className="font-heading text-xs font-medium uppercase tracking-wider text-muted-foreground">
                window.nx calls
              </div>
              <Button size="icon-xs" variant="ghost" onClick={() => setLog([])}>
                <span className="sr-only">Clear</span>
                ×
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              {log.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground">
                  Calls into <code>window.nx.*</code> from the manual&rsquo;s
                  scripts will appear here.
                </div>
              ) : (
                <ol className="flex flex-col p-2">
                  {log.map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-md px-2 py-1.5 font-mono text-[11px] leading-relaxed hover:bg-muted"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-muted-foreground">
                          {new Date(entry.ts).toLocaleTimeString([], {
                            hour12: false,
                          })}
                        </span>
                        <span className="font-medium">{entry.text}</span>
                      </div>
                      {entry.detail !== undefined && entry.detail !== "" && (
                        <div className="break-all whitespace-pre-wrap text-muted-foreground">
                          {entry.detail}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </ScrollArea>
          </aside>
        )}
      </div>
    </div>
  )
}

/**
 * Toolbar dropdown for picking a region inside a Switch offline
 * manual that uses the `regions.js` routing pattern. Selecting a
 * region triggers a re-render of the iframe with `?r=<key>` injected
 * into `location.search`, which makes the manual's existing redirect
 * script run as it would on Switch hardware.
 *
 * The dropdown shows friendly names (Japan / Americas / Europe / …)
 * plus the resolved file path for each so power users can see what's
 * about to load.
 */
function RegionPicker({
  regions,
  selectedKey,
  onChange,
}: {
  regions: Record<string, string>
  selectedKey: string
  onChange: (key: string) => void
}) {
  // Sort: 'All' first if present, then numeric keys, then everything
  // else lexicographically.
  const keys = useMemo(() => {
    const all = Object.keys(regions)
    return all.sort((a, b) => {
      if (a === "All") return -1
      if (b === "All") return 1
      const an = Number(a)
      const bn = Number(b)
      const aNum = !Number.isNaN(an)
      const bNum = !Number.isNaN(bn)
      if (aNum && bNum) return an - bn
      if (aNum) return -1
      if (bNum) return 1
      return a.localeCompare(b)
    })
  }, [regions])

  const selectedLabel = regionDisplayName(selectedKey)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" title="Select manual region">
          <GlobeIcon data-icon="inline-start" />
          {selectedLabel}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel>Manual region</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {keys.map((k) => (
          <DropdownMenuItem
            key={k}
            onSelect={() => onChange(k)}
            data-selected={k === selectedKey || undefined}
            className={cn(
              "flex items-center justify-between gap-3",
              k === selectedKey && "font-medium",
            )}
          >
            <span>{regionDisplayName(k)}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {regions[k]}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// =============================================================================
// NCA structured preview
// =============================================================================
//
// Selecting an NCA in the tree shows its decoded header info — magic,
// content type, title ID, key generation, key area, sections, rights ID.
// This replaces the older synthetic `_nca-info.json` child.

function NcaPreview({ node }: { node: Node }) {
  // The archive lib stashes the NCA's source ({ getBlob, ctx, tikMap })
  // on the node's meta so we can re-parse it on demand without going
  // through the (expensive) tree expansion path.
  const source = node.meta?.ncaSource as NcaSource | undefined

  const { loading, data, error } = useAsync(
    async () => {
      if (!source) {
        throw new Error(
          "Internal error: this NCA node is missing its source metadata.",
        )
      }
      return parseNcaForNode(source)
    },
    [node.id],
  )

  if (loading) return <LoadingFiller label="Decrypting NCA header…" />
  if (error) return <ErrorFiller error={error} />
  const parsed = data!

  const contentTypeLabel =
    NcaContentType[parsed.contentType] ?? `unknown(${parsed.contentType})`

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="NCA — Nintendo Content Archive" />

        {parsed.missingKey && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Section bodies can’t be decrypted</AlertTitle>
            <AlertDescription>{parsed.missingKey}</AlertDescription>
          </Alert>
        )}

        <KvBlock title="Header">
          <KvRow k="Magic" v={parsed.magic} mono />
          <KvRow k="Content type" v={contentTypeLabel} />
          <KvRow
            k="Title ID"
            v={"0x" + parsed.titleId.toString(16).padStart(16, "0")}
            mono
          />
          <KvRow k="Size" v={formatBytes(Number(parsed.ncaSize))} />
          <KvRow
            k="SDK version"
            v={formatSdkVersion(parsed.sdkVersion)}
          />
          <KvRow
            k="Distribution"
            v={
              parsed.distribution === 0
                ? "Download"
                : parsed.distribution === 1
                  ? "GameCard"
                  : `unknown(${parsed.distribution})`
            }
          />
          <KvRow
            k="Key generation"
            v={`${parsed.keyGeneration} (${describeKeyGeneration(parsed.keyGeneration)})`}
          />
          <KvRow
            k="KAEK index"
            v={
              parsed.kaekIndex === 0
                ? "0 (Application)"
                : parsed.kaekIndex === 1
                  ? "1 (Ocean)"
                  : parsed.kaekIndex === 2
                    ? "2 (System)"
                    : `${parsed.kaekIndex}`
            }
          />
          <KvRow k="Has rights ID" v={parsed.hasRightsId ? "yes" : "no"} />
          {parsed.hasRightsId && (
            <KvRow
              k="Rights ID"
              v={hexBytesToString(parsed.rightsId)}
              mono
            />
          )}
        </KvBlock>

        <NcaSectionsTable sections={parsed.sections} />

        <KvBlock title="Decrypted key area">
          {parsed.keyArea.map((k, i) => (
            <KvRow
              key={i}
              k={`keyArea[${i}]${i === 2 ? " (section key)" : ""}`}
              v={hexBytesToString(k)}
              mono
            />
          ))}
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function NcaSectionsTable({ sections }: { sections: NcaSection[] }) {
  if (sections.length === 0) {
    return (
      <KvBlock title="Sections">
        <KvRow k="Sections" v="(none)" />
      </KvBlock>
    )
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Sections ({sections.length})
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium">#</th>
              <th className="px-2 py-1.5 text-left font-medium">FS</th>
              <th className="px-2 py-1.5 text-left font-medium">Crypto</th>
              <th className="px-2 py-1.5 text-right font-medium">Offset</th>
              <th className="px-2 py-1.5 text-right font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => {
              const fsLabel =
                s.fsType === NCA_FS_TYPE_PFS0
                  ? "PFS0"
                  : s.fsType === NCA_FS_TYPE_ROMFS
                    ? "RomFS"
                    : `unknown(${s.fsType})`
              const cryptoLabel =
                s.cryptType === 1
                  ? "None"
                  : s.cryptType === 2
                    ? "AES-XTS"
                    : s.cryptType === 3
                      ? "AES-CTR"
                      : s.cryptType === 4
                        ? "AES-CTR-Ex (BKTR)"
                        : `unknown(${s.cryptType})`
              const sectionLen = s.mediaEndOffset - s.mediaStartOffset
              return (
                <tr key={s.index} className="border-b last:border-0">
                  <td className="px-2 py-1.5 font-mono">{s.index}</td>
                  <td className="px-2 py-1.5 font-mono">{fsLabel}</td>
                  <td className="px-2 py-1.5 font-mono">{cryptoLabel}</td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    0x{s.mediaStartOffset.toString(16)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatBytes(sectionLen)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Human-friendly label for the SDK Addon Version field (a packed BCD). */
function formatSdkVersion(raw: number): string {
  // Format used by FS_ACCESS log lines: "{byte3}.{byte2}.{byte1}"
  // where the high byte is byte3.
  const b3 = (raw >>> 24) & 0xff
  const b2 = (raw >>> 16) & 0xff
  const b1 = (raw >>> 8) & 0xff
  return `${b3}.${b2}.${b1}  (raw 0x${raw.toString(16).padStart(8, "0")})`
}

/**
 * Map an NCA `keyGeneration` field (1-indexed, matching what the
 * hacbrewpack reference uses) to a human-readable firmware label.
 */
function describeKeyGeneration(gen: number): string {
  // From switchbrew's NCA wiki page; values are 1-indexed externally,
  // i.e. gen=1 ↔ master_key_00 ↔ firmware 1.0.0.
  switch (gen) {
    case 1: return "1.0.0–2.3.0"
    case 2: return "3.0.0"
    case 3: return "3.0.1"
    case 4: return "4.0.0"
    case 5: return "5.0.0"
    case 6: return "6.0.0"
    case 7: return "6.2.0"
    case 8: return "7.0.0"
    case 9: return "8.1.0"
    case 10: return "9.0.0"
    case 11: return "9.1.0"
    case 12: return "12.1.0"
    case 13: return "13.0.0"
    case 14: return "14.0.0"
    case 15: return "15.0.0"
    case 16: return "16.0.0"
    case 17: return "17.0.0"
    case 18: return "18.0.0"
    case 19: return "19.0.0"
    case 20: return "20.0.0"
    case 21: return "21.0.0"
    case 22: return "22.0.0"
    default: return `firmware unknown (master_key_${(gen - 1).toString(16).padStart(2, "0")})`
  }
}

function hexBytesToString(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0")
  return s
}

function FilePreview({ node, kind }: { node: Node; kind: PreviewKind }) {
  switch (kind) {
    case "image":
      return <ImagePreview node={node} />
    case "audio":
      return <MediaPreview node={node} kind="audio" />
    case "video":
      return <MediaPreview node={node} kind="video" />
    case "text":
    case "json":
      return <TextPreview node={node} kind={kind} />
    case "nacp":
      return <NacpPreview node={node} />
    case "cnmt":
      return <CnmtPreview node={node} />
    case "nro-info":
      return <NroPreview node={node} />
    case "nso-info":
      return <NsoPreview node={node} />
    case "npdm-info":
      return <NpdmPreview node={node} />
    case "bfttf-info":
    case "font-info":
      return <FontPreview node={node} />
    case "bffnt-info":
      return <BffntPreview node={node} />
    case "hex":
    default:
      return <HexPreview node={node} />
  }
}

// -------- Async loader hook --------

function useAsync<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{
    loading: boolean
    data: T | null
    error: Error | null
  }>({ loading: true, data: null, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, data: null, error: null })
    loader()
      .then((data) => {
        if (!cancelled) setState({ loading: false, data, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ loading: false, data: null, error: err })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

// -------- Specific previews --------

function ImagePreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    if (blob.size > IMAGE_PREVIEW_LIMIT) {
      throw new Error(
        `Image too large to preview (${formatBytes(blob.size)}). Download to view.`,
      )
    }
    const ext = extOf(node.name)
    // Switch app icons (icon_*.dat) are JPEGs.
    const isSwitchIconDat = /^icon_.*\.dat$/i.test(node.name)
    const mime = isSwitchIconDat ? "image/jpeg" : IMAGE_MIME[ext] ?? "image/png"
    const b = new Blob([await blob.arrayBuffer()], { type: mime })
    return URL.createObjectURL(b)
  }, [node.id])

  useEffect(() => {
    return () => {
      if (data) URL.revokeObjectURL(data)
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding image…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full items-center justify-center bg-muted/40 p-6">
        <img
          src={data!}
          alt={node.name}
          className="max-h-[calc(100vh-12rem)] max-w-full rounded-md ring-1 ring-foreground/10"
        />
      </div>
    </ScrollArea>
  )
}

function MediaPreview({
  node,
  kind,
}: {
  node: Node
  kind: "audio" | "video"
}) {
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    if (blob.size > MEDIA_PREVIEW_LIMIT) {
      throw new Error(
        `Media file too large to preview (${formatBytes(blob.size)}). Download to view.`,
      )
    }
    const ext = extOf(node.name)
    const mime =
      kind === "audio" ? AUDIO_MIME[ext] ?? "audio/*" : VIDEO_MIME[ext] ?? "video/*"
    const b = new Blob([await blob.arrayBuffer()], { type: mime })
    return URL.createObjectURL(b)
  }, [node.id])

  useEffect(() => {
    return () => {
      if (data) URL.revokeObjectURL(data)
    }
  }, [data])

  if (loading) return <LoadingFiller label={`Decoding ${kind}…`} />
  if (error) return <ErrorFiller error={error} />
  return (
    <div className="flex h-full items-center justify-center bg-muted/40 p-6">
      {kind === "audio" ? (
        <audio src={data!} controls className="w-full max-w-md" />
      ) : (
        <video
          src={data!}
          controls
          className="max-h-full max-w-full rounded-md ring-1 ring-foreground/10"
        />
      )}
    </div>
  )
}

/**
 * Cap on the size we'll syntax-highlight. Beyond this we fall back to
 * plain `<pre>` rendering — Shiki's tokenizer is fast but a 1 MB
 * minified JS file would still spike the main thread and the colours
 * stop being useful at that scale anyway.
 */
const HIGHLIGHT_LIMIT = 256 * 1024 // 256 KB

function TextPreview({ node, kind }: { node: Node; kind: "text" | "json" }) {
  const { resolvedTheme } = useTheme()
  // We pick the language up-front (cheap, just an extension lookup)
  // so the loader knows whether to format JSON and/or highlight.
  const lang: SupportedLang | null =
    kind === "json" ? "json" : languageForFile(node.name)

  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    const truncated = blob.size > TEXT_PREVIEW_LIMIT
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_LIMIT) : blob
    const text = await slice.text()
    let display = text
    if (kind === "json") {
      try {
        display = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        /* leave raw */
      }
    }
    // Don't highlight oversized payloads — `display` may be the raw
    // 1 MB blob even if we successfully read it.
    const highlightable = !!lang && display.length <= HIGHLIGHT_LIMIT
    return { display, truncated, fullSize: blob.size, highlightable }
  }, [node.id, kind, lang])

  // Highlight asynchronously: the highlighter is lazily loaded on
  // first use, then cached, so subsequent renders are essentially
  // synchronous. We re-run when the source text or active theme
  // changes; until the first highlight resolves we render the plain
  // text so the user isn't staring at a blank pane.
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const themeMode = resolvedTheme === "dark" ? "dark" : "light"
  useEffect(() => {
    if (!data || !data.highlightable || !lang) {
      setHighlighted(null)
      return
    }
    let cancelled = false
    highlightCode(data.display, lang, themeMode)
      .then((html) => {
        if (!cancelled) setHighlighted(html)
      })
      .catch(() => {
        // Highlighter failures (e.g. missing grammar) just fall back
        // to plain text — never break the preview pane.
        if (!cancelled) setHighlighted(null)
      })
    return () => {
      cancelled = true
    }
  }, [data, lang, themeMode])

  if (loading) return <LoadingFiller label="Reading…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-4">
        {data!.truncated && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Preview truncated</AlertTitle>
            <AlertDescription>
              Showing the first {formatBytes(TEXT_PREVIEW_LIMIT)} of{" "}
              {formatBytes(data!.fullSize)}. Download for the complete file.
            </AlertDescription>
          </Alert>
        )}
        {highlighted ? (
          // Shiki returns `<pre><code>…</code></pre>` with inline `style`
          // attrs carrying token colours and the theme's background. We
          // wrap it in our own padded container so it fits the rest of
          // the preview pane visually, and target Shiki's `<pre>` with
          // a child selector to apply our font-size / scroll behaviour
          // without losing its theme background.
          <div
            className="shiki-host overflow-x-auto rounded-md text-xs leading-relaxed [&>pre]:m-0 [&>pre]:p-3 [&_code]:font-mono [&_code]:whitespace-pre-wrap [&_code]:break-words"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre className="rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {data!.display}
          </pre>
        )}
      </div>
    </ScrollArea>
  )
}

function HexPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    const slice = blob.size > HEX_PREVIEW_LIMIT ? blob.slice(0, HEX_PREVIEW_LIMIT) : blob
    const bytes = new Uint8Array(await slice.arrayBuffer())
    return {
      dump: buildHexDump(bytes, 0),
      truncated: blob.size > HEX_PREVIEW_LIMIT,
      fullSize: blob.size,
    }
  }, [node.id])

  if (loading) return <LoadingFiller label="Decoding…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-4">
        {data!.truncated && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Hex view truncated</AlertTitle>
            <AlertDescription>
              Showing the first {formatBytes(HEX_PREVIEW_LIMIT)} of{" "}
              {formatBytes(data!.fullSize)}. Download for the complete file.
            </AlertDescription>
          </Alert>
        )}
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre">
          {data!.dump}
        </pre>
      </div>
    </ScrollArea>
  )
}

function NacpPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseNacpForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing NACP…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="NACP — Application Control Property" />
        <KvBlock title="Identification">
          <KvRow k="Title" v={data!.title || "(blank)"} />
          <KvRow k="Author" v={data!.author || "(blank)"} />
          <KvRow k="Version" v={data!.version || "(blank)"} />
          <KvRow k="Title ID" v={data!.id} mono />
          <KvRow k="Save Data Owner ID" v={data!.saveDataOwnerId} mono />
          <KvRow k="Add-On Content Base ID" v={data!.addOnContentBaseId} mono />
          <KvRow k="Presence Group ID" v={data!.presenceGroupId} mono />
        </KvBlock>
        <KvBlock title="Behavior flags">
          <KvRow k="Startup user account" v={String(data!.startupUserAccount)} />
          <KvRow k="HDCP" v={String(data!.hdcp)} />
          <KvRow k="Screenshot" v={String(data!.screenshot)} />
          <KvRow k="Video capture" v={String(data!.videoCapture)} />
          <KvRow k="Logo type" v={String(data!.logoType)} />
          <KvRow k="Logo handling" v={String(data!.logoHandling)} />
          <KvRow
            k="Supported language flag"
            v={"0x" + data!.supportedLanguageFlag.toString(16)}
            mono
          />
          <KvRow
            k="Parental control flag"
            v={"0x" + data!.parentalControlFlag.toString(16)}
            mono
          />
          <KvRow
            k="Attribute flag"
            v={"0x" + data!.attributeFlag.toString(16)}
            mono
          />
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function CnmtPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseCnmtForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing CNMT…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="CNMT — Content Meta" />
        <KvBlock title="Title">
          <KvRow k="Title ID" v={v.titleId} mono />
          <KvRow k="Title Version" v={String(v.titleVersion)} />
          <KvRow
            k="Title Type"
            v={`${v.titleTypeName} (0x${v.titleType.toString(16)})`}
          />
          <KvRow
            k="Required System Version"
            v={String(v.requiredSystemVersion)}
          />
        </KvBlock>
        <KvBlock title={`Contents (${v.contents.length})`}>
          <div className="flex flex-col gap-2">
            {v.contents.map((c, i) => (
              <div
                key={i}
                className="rounded-md border bg-card p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="secondary">
                    {c.typeName}
                    <span className="ml-1 opacity-60">
                      (0x{c.type.toString(16)})
                    </span>
                  </Badge>
                  <span className="font-mono text-muted-foreground">
                    {formatBytes(c.size)}
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  <span className="font-mono">
                    <span className="text-muted-foreground">NCA ID</span>{" "}
                    <span className="break-all">{c.ncaId}</span>
                  </span>
                  <span className="font-mono">
                    <span className="text-muted-foreground">Hash</span>{" "}
                    <span className="break-all">{c.hash.slice(0, 32)}…</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function NroPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseNroForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Reading NRO…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="NRO — Nintendo Switch homebrew executable" />
        <KvBlock title="Header">
          <KvRow k="Magic" v={data!.magic} mono />
          <KvRow k="Format Version" v={String(data!.formatVersion)} />
          <KvRow k="Code Size" v={formatBytes(data!.nroSize)} />
          <KvRow k="Flags" v={"0x" + data!.flags.toString(16)} mono />
          <KvRow k="Has Assets" v={data!.hasAssets ? "yes" : "no"} />
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function NsoPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseNsoForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Reading NSO…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="NSO — Nintendo Switch executable module" />
        <KvBlock title="Header">
          <KvRow k="Magic" v={v.magic} mono />
          <KvRow k="Version" v={String(v.version)} />
          <KvRow k="Module Name" v={v.moduleName || "(none)"} />
          <KvRow k="Module ID (build-id)" v={v.moduleId} mono />
          <KvRow k="Flags" v={v.flags} mono />
          <KvRow k="Compression" v={v.usesZstd ? "zstd (22.0.0+)" : "LZ4"} />
          {v.executeOnlyMemory && (
            <KvRow k="Execute-only memory" v="yes (20.0.0+)" />
          )}
        </KvBlock>
        <NsoSegmentTable segments={v.segments} bssSize={v.bssSize} />
        <KvBlock title="Embedded sections">
          <KvRow
            k="Module name"
            v={`offset 0x${v.embeddedOffset.toString(16)} size ${formatBytes(v.embeddedSize)}`}
            mono
          />
          <KvRow
            k=".dynstr"
            v={`offset 0x${v.dynStrOffset.toString(16)} size ${formatBytes(v.dynStrSize)}`}
            mono
          />
          <KvRow
            k=".dynsym"
            v={`offset 0x${v.dynSymOffset.toString(16)} size ${formatBytes(v.dynSymSize)}`}
            mono
          />
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function NsoSegmentTable({
  segments,
  bssSize,
}: {
  segments: NsoView["segments"]
  bssSize: number
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Segments
      </h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium">Segment</th>
              <th className="px-2 py-1.5 text-left font-medium">VA</th>
              <th className="px-2 py-1.5 text-right font-medium">Size</th>
              <th className="px-2 py-1.5 text-right font-medium">On disk</th>
              <th className="px-2 py-1.5 text-center font-medium">Compressed</th>
              <th className="px-2 py-1.5 text-center font-medium">Hashed</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.name} className="border-b last:border-0">
                <td className="px-2 py-1.5 font-mono">{s.name}</td>
                <td className="px-2 py-1.5 font-mono">{s.memoryOffset}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {formatBytes(s.size)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {s.compressed ? formatBytes(s.fileSize) : "—"}
                </td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">
                  {s.compressed ? "yes" : "—"}
                </td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">
                  {s.hashed ? "yes" : "—"}
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-2 py-1.5 font-mono">.bss</td>
              <td className="px-2 py-1.5 text-muted-foreground">—</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {formatBytes(bssSize)}
              </td>
              <td colSpan={3} className="px-2 py-1.5 text-muted-foreground">
                (uninitialised; not on disk)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function NpdmPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseNpdmForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Parsing NPDM…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const m = v.parsed.meta
  const a = v.parsed.acid
  const c = v.parsed.aci0
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="NPDM — Process Definition Metadata" />

        <KvBlock title="Meta">
          <KvRow k="Process name" v={m.name || "(blank)"} />
          <KvRow k="Product code" v={m.productCode || "(blank)"} />
          <KvRow k="Architecture" v={m.is64Bit ? "AArch64" : "AArch32"} />
          <KvRow k="Address space" v={m.addressSpace} />
          <KvRow k="Main thread priority" v={String(m.mainThreadPriority)} />
          <KvRow k="Main thread core" v={String(m.mainThreadCoreNumber)} />
          <KvRow k="Main thread stack" v={formatBytes(m.mainThreadStackSize)} />
          <KvRow k="System resource size" v={formatBytes(m.systemResourceSize)} />
          <KvRow k="Version" v={String(m.version)} />
          <KvRow k="Flags" v={"0x" + m.flags.toString(16).padStart(2, "0")} mono />
          {m.optimizeMemoryAllocation && (
            <KvRow k="OptimizeMemoryAllocation" v="yes" />
          )}
          {m.disableDeviceAddressSpaceMerge && (
            <KvRow k="DisableDeviceAddressSpaceMerge" v="yes" />
          )}
          {m.enableAliasRegionExtraSize && (
            <KvRow k="EnableAliasRegionExtraSize" v="yes" />
          )}
        </KvBlock>

        <KvBlock title="ACID — Access Control Descriptor">
          <KvRow
            k="Program ID range"
            v={`0x${a.programIdMin.toString(16).padStart(16, "0")} – 0x${a.programIdMax.toString(16).padStart(16, "0")}`}
            mono
          />
          <KvRow k="Memory region" v={a.memoryRegion} />
          <KvRow k="Production flag" v={a.productionFlag ? "yes" : "no"} />
          <KvRow
            k="Unqualified approval"
            v={a.unqualifiedApproval ? "yes" : "no"}
          />
          {a.loadBrowserCoreDll && <KvRow k="Load browser core DLL" v="yes" />}
          <KvRow k="ACID version" v={String(a.version)} />
          <KvRow k="ACID flags" v={"0x" + a.flags.toString(16)} mono />
        </KvBlock>

        <KvBlock title="ACI0 — Access Control Info">
          <KvRow
            k="Program ID"
            v={"0x" + c.programId.toString(16).padStart(16, "0")}
            mono
          />
        </KvBlock>

        <NpdmFsAccessTable acid={a} aci0={c} />

        <NpdmServicesTable
          acidEntries={a.sac.entries}
          aci0Entries={c.sac.entries}
        />

        <NpdmKernelTable
          acidDescriptors={a.kc.descriptors}
          aci0Descriptors={c.kc.descriptors}
        />

        <KvBlock title="ACID signature">
          <KvRow
            k="RSA-2048 signature"
            v={v.signatureHex.match(/.{1,32}/g)!.join(" ")}
            mono
          />
          <KvRow
            k="RSA-2048 public key"
            v={v.publicKeyHex.match(/.{1,32}/g)!.join(" ")}
            mono
          />
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function NpdmFsAccessTable({
  acid,
  aci0,
}: {
  acid: NpdmView["parsed"]["acid"]
  aci0: NpdmView["parsed"]["aci0"]
}) {
  const allBits = useMemo(() => {
    const set = new Set<string>([
      ...acid.fac.flagBits,
      ...aci0.fac.flagBits,
    ])
    return [...set].sort()
  }, [acid, aci0])

  if (allBits.length === 0) {
    return (
      <KvBlock title="FS access flags">
        <KvRow k="Bits" v="(none)" />
      </KvBlock>
    )
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        FS access flags
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {allBits.map((bit) => {
          const inAcid = acid.fac.flagBits.includes(bit as never)
          const inAci0 = aci0.fac.flagBits.includes(bit as never)
          return (
            <Badge
              key={bit}
              variant={inAci0 ? "default" : "secondary"}
              className="font-mono"
              title={
                inAcid && inAci0
                  ? "Granted by ACID and used by ACI0"
                  : inAcid
                    ? "Permitted by ACID but not used by ACI0"
                    : "Used by ACI0 but not in ACID — unusual"
              }
            >
              {bit}
            </Badge>
          )
        })}
      </div>
      <div className="text-xs text-muted-foreground">
        ACID flag = 0x{acid.fac.flag.toString(16).padStart(16, "0")} ·{" "}
        ACI0 flag = 0x{aci0.fac.flag.toString(16).padStart(16, "0")}
      </div>
    </section>
  )
}

function NpdmServicesTable({
  acidEntries,
  aci0Entries,
}: {
  acidEntries: NpdmView["parsed"]["acid"]["sac"]["entries"]
  aci0Entries: NpdmView["parsed"]["aci0"]["sac"]["entries"]
}) {
  // Merge by name; mark which side(s) it appeared on.
  const merged = useMemo(() => {
    const byName = new Map<
      string,
      { name: string; isServer: boolean; inAcid: boolean; inAci0: boolean }
    >()
    for (const e of acidEntries) {
      byName.set(e.name, {
        name: e.name,
        isServer: e.isServer,
        inAcid: true,
        inAci0: false,
      })
    }
    for (const e of aci0Entries) {
      const existing = byName.get(e.name)
      if (existing) {
        existing.inAci0 = true
        existing.isServer ||= e.isServer
      } else {
        byName.set(e.name, {
          name: e.name,
          isServer: e.isServer,
          inAcid: false,
          inAci0: true,
        })
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [acidEntries, aci0Entries])

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Services ({merged.length})
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {merged.map((s) => (
          <Badge
            key={s.name}
            variant="outline"
            className={cn(
              "font-mono",
              s.isServer && "border-primary text-primary",
            )}
            title={[
              s.isServer ? "May register this service" : "May connect to this service",
              s.inAcid ? "in ACID" : null,
              s.inAci0 ? "in ACI0" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {s.isServer && <span className="mr-1">⚙</span>}
            {s.name}
          </Badge>
        ))}
      </div>
    </section>
  )
}

function NpdmKernelTable({
  acidDescriptors,
  aci0Descriptors,
}: {
  acidDescriptors: NpdmView["parsed"]["acid"]["kc"]["descriptors"]
  aci0Descriptors: NpdmView["parsed"]["aci0"]["kc"]["descriptors"]
}) {
  // Show ACI0 (the runtime view) and call out where it differs from ACID.
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Kernel capabilities (ACI0)
      </h3>
      <div className="flex flex-col gap-1.5 rounded-md border bg-card p-2">
        {aci0Descriptors.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            (none)
          </div>
        ) : (
          aci0Descriptors.map((d, i) => (
            <NpdmKernelDescriptorRow key={i} descriptor={d} />
          ))
        )}
      </div>
      {acidDescriptors.length !== aci0Descriptors.length && (
        <div className="text-xs text-muted-foreground">
          ACID has{" "}
          <span className="font-medium text-foreground">
            {acidDescriptors.length}
          </span>{" "}
          descriptor{acidDescriptors.length === 1 ? "" : "s"} (ACI0 has{" "}
          {aci0Descriptors.length}).
        </div>
      )}
    </section>
  )
}

function NpdmKernelDescriptorRow({
  descriptor,
}: {
  descriptor: NpdmView["parsed"]["acid"]["kc"]["descriptors"][number]
}) {
  const detail = (() => {
    switch (descriptor.kind) {
      case "ThreadInfo":
        return `priority ${descriptor.lowestPriority}–${descriptor.highestPriority}, cores ${descriptor.minCoreNumber}–${descriptor.maxCoreNumber}`
      case "EnableSystemCalls":
        return descriptor.syscalls.length
          ? `syscalls: ${descriptor.syscalls
              .map((n) => "0x" + n.toString(16))
              .join(", ")}`
          : `(empty mask in slot ${descriptor.index})`
      case "MemoryMap":
        return "(unpaired entry)"
      case "MemoryMapPaired":
        return `${descriptor.permissionType} ${descriptor.mappingType} @ 0x${descriptor.beginAddress
          .toString(16)
          .padStart(8, "0")} size ${formatBytes(descriptor.size)}`
      case "IoMemoryMap":
        return `0x${descriptor.beginAddress.toString(16).padStart(8, "0")}`
      case "MemoryRegionMap":
        return descriptor.regions
          .map(
            (r, i) =>
              `slot${i}: type ${r.type}${r.readOnly ? " (RO)" : ""}`,
          )
          .join(", ")
      case "EnableInterrupts":
        return descriptor.interrupts.length
          ? `IRQs: ${descriptor.interrupts.join(", ")}`
          : "(empty)"
      case "MiscParams":
        return descriptor.programType
      case "KernelVersion":
        return `kernel ${descriptor.majorVersion}.${descriptor.minorVersion}`
      case "HandleTableSize":
        return `${descriptor.handleTableSize} handles`
      case "MiscFlags":
        return [
          descriptor.enableDebug && "EnableDebug",
          descriptor.forceDebugProd && "ForceDebugProd",
          descriptor.forceDebug && "ForceDebug",
        ]
          .filter(Boolean)
          .join(", ") || "(none)"
      case "Unknown":
        return `0x${descriptor.raw.toString(16).padStart(8, "0")}`
    }
  })()

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-1 text-xs">
      <Badge variant="secondary" className="font-mono">
        {descriptor.kind}
      </Badge>
      <span className="break-all text-muted-foreground">{detail}</span>
    </div>
  )
}

// =============================================================================
// Font preview (TTF / OTF / BFTTF / BFOTF)
// =============================================================================
//
// Single component handles plain `.ttf` / `.otf` / `.ttc` and Switch's
// obfuscated `.bfttf` / `.bfotf` wrappers. The shared logic — read the
// sfnt name table, register the bytes with the browser via the CSS Font
// Loading API, render sample text in the actual font — is identical;
// only the section header label, the optional "deobfuscated" container
// block, and the "Download as .ttf" export button differ between the
// two paths.

const FONT_SAMPLE_LATIN =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  !@#$%&*()_+-=[]{};':\",./<>?"
const FONT_SAMPLE_PANGRAM = "The quick brown fox jumps over the lazy dog."
const FONT_SAMPLE_CJK = "永远的世界 — 永遠の世界 — 영원한 세계"
const FONT_SAMPLE_PUNCTUATION = "→ ← ↑ ↓  ✓ ✗ ⓘ ★ ☆  ¡ ¿ § ¶ † ‡  “ ” ‘ ’ « »"

function FontPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseFontForView(await node.blob!())
  }, [node.id])

  // Once we have the font bytes, register them with the browser via
  // the CSS Font Loading API under a unique family name and render
  // sample text below using that family. Each loaded font gets its
  // own family so multiple previews can coexist.
  const [fontFamily, setFontFamily] = useState<string | null>(null)
  const [fontError, setFontError] = useState<string | null>(null)
  useEffect(() => {
    if (!data) {
      setFontFamily(null)
      setFontError(null)
      return
    }
    let cancelled = false
    let registered: FontFace | null = null
    const family = `nx-archive-font-${Math.random().toString(36).slice(2, 10)}`
    ;(async () => {
      try {
        const buf = await data.font.arrayBuffer()
        const face = new FontFace(family, buf)
        await face.load()
        if (cancelled) return
        document.fonts.add(face)
        registered = face
        setFontFamily(family)
      } catch (err) {
        if (!cancelled) {
          setFontError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
      if (registered) document.fonts.delete(registered)
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding font…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const formatLabel =
    v.format === "ttf"
      ? "TrueType"
      : v.format === "otf"
        ? "OpenType (CFF)"
        : "Unknown sfnt"

  // Pick the most descriptive name for the header — full name first,
  // then the typographic family + subfamily, then plain family.
  const displayName =
    v.names.full ||
    [v.names.typographicFamily ?? v.names.family, v.names.subfamily]
      .filter(Boolean)
      .join(" ") ||
    node.name

  const sectionTitle = v.wasObfuscated
    ? "BFTTF — Switch system font"
    : `${formatLabel} font`

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title={sectionTitle} />

        <KvBlock title="Font">
          <KvRow k="Display name" v={displayName} />
          {v.names.family && <KvRow k="Family" v={v.names.family} />}
          {v.names.subfamily && <KvRow k="Subfamily" v={v.names.subfamily} />}
          {v.names.typographicFamily &&
            v.names.typographicFamily !== v.names.family && (
              <KvRow
                k="Typographic family"
                v={v.names.typographicFamily}
              />
            )}
          {v.names.postscript && (
            <KvRow k="PostScript name" v={v.names.postscript} mono />
          )}
          {v.names.version && <KvRow k="Version" v={v.names.version} />}
          {v.names.copyright && (
            <KvRow k="Copyright" v={v.names.copyright} />
          )}
        </KvBlock>

        <KvBlock title={v.wasObfuscated ? "Container" : "File"}>
          <KvRow k="Format" v={formatLabel} />
          <KvRow
            k={v.wasObfuscated ? "Original size" : "Size"}
            v={formatBytes(v.size)}
          />
          {v.wasObfuscated && (
            <KvRow
              k="Header size check"
              v={v.headerSizeOk ? "ok" : "mismatch (still extracted)"}
            />
          )}
        </KvBlock>

        {/* Live sample with the loaded font */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Sample
          </h3>
          {fontError && (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Couldn’t register the font with the browser</AlertTitle>
              <AlertDescription>{fontError}</AlertDescription>
            </Alert>
          )}
          {!fontFamily && !fontError && (
            <div className="text-xs text-muted-foreground">Loading font…</div>
          )}
          {fontFamily && (
            <div
              className="overflow-x-auto rounded-md border bg-card p-4 leading-relaxed"
              style={{ fontFamily: `"${fontFamily}", sans-serif` }}
            >
              <div className="text-3xl font-medium" style={{ fontFamily: `"${fontFamily}", sans-serif` }}>
                {displayName}
              </div>
              <div
                className="mt-3 whitespace-pre-wrap text-base"
                style={{ fontFamily: `"${fontFamily}", sans-serif` }}
              >
                {FONT_SAMPLE_LATIN}
              </div>
              <div
                className="mt-3 text-base"
                style={{ fontFamily: `"${fontFamily}", sans-serif` }}
              >
                {FONT_SAMPLE_PANGRAM}
              </div>
              <div
                className="mt-3 text-2xl"
                style={{ fontFamily: `"${fontFamily}", sans-serif` }}
              >
                {FONT_SAMPLE_CJK}
              </div>
              <div
                className="mt-3 text-base text-muted-foreground"
                style={{ fontFamily: `"${fontFamily}", sans-serif` }}
              >
                {FONT_SAMPLE_PUNCTUATION}
              </div>
              {/* Size scale */}
              <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                {[12, 16, 20, 28, 36, 48, 64].map((px) => (
                  <span
                    key={px}
                    style={{
                      fontFamily: `"${fontFamily}", sans-serif`,
                      fontSize: `${px}px`,
                    }}
                  >
                    {px}px
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* For BFTTF inputs, offer an explicit deobfuscated-export
            button. Plain TTF / OTF inputs already have the standard
            "Download" button in the header — no separate export
            section needed since the bytes are identical. */}
        {v.wasObfuscated && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              Export
            </h3>
            <div className="flex flex-wrap gap-2">
              <FontDownloadAsTtfButton node={node} view={v} />
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}

function FontDownloadAsTtfButton({
  node,
  view,
}: {
  node: Node
  view: FontView
}) {
  const [busy, setBusy] = useState(false)
  // Strip the .bfttf / .bfotf extension and replace with .ttf / .otf.
  const ext = view.format === "otf" ? "otf" : "ttf"
  const stripped = node.name.replace(/\.(bfttf|bfotf)$/i, "")
  const fileName = `${stripped}.${ext}`

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const id = toast.loading(`Preparing ${fileName}…`)
    try {
      const url = URL.createObjectURL(view.font)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      a.style.display = "none"
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
      toast.success(`Downloaded ${fileName}`, { id })
    } catch (err) {
      toast.error(`Failed to prepare ${fileName}`, {
        id,
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button onClick={onClick} disabled={busy} variant="default">
      {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
      Download as .{ext}
    </Button>
  )
}

// =============================================================================
// BFFNT preview (Switch bitmap fonts)
// =============================================================================
//
// BFFNTs are sprite-sheet fonts: a deswizzled, BC4/A8/LA8/RGBA8 atlas
// of pre-rendered glyphs plus per-glyph metrics (CWDH) and a Unicode
// → glyph-index map (CMAP). Unlike `.bfttf` (an obfuscated TrueType
// outline that we hand straight to the browser via `FontFace`), here
// the browser has no native renderer — we have to composite the
// sample text glyph-by-glyph onto a `<canvas>` ourselves using
// `@tootallnate/bffnt`'s `renderText`.

const BFFNT_DEFAULT_SAMPLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  !@#$%&*()_+-=[]{};':\",./<>?"

function BffntPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBffntForView(await node.blob!())
  }, [node.id])

  const [sample, setSample] = useState(BFFNT_DEFAULT_SAMPLE)

  if (loading) return <LoadingFiller label="Decoding BFFNT…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const { tglp, finf, header } = v.parsed

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BFFNT — Switch bitmap font" />

        <KvBlock title="Font">
          <KvRow k="Cell size" v={`${tglp.cellWidth} × ${tglp.cellHeight} px`} />
          <KvRow k="Line height" v={`${finf.lineFeed} px`} />
          <KvRow k="Ascent" v={`${finf.ascent} px`} />
          <KvRow k="Baseline" v={`${tglp.baselinePosition} px from top of cell`} />
          <KvRow
            k="Glyphs"
            v={`${v.glyphCount} (${v.mappedCodepoints} codepoints across ${v.cmapBlockCount} CMAP block${v.cmapBlockCount === 1 ? "" : "s"})`}
          />
        </KvBlock>

        <KvBlock title="Atlas">
          <KvRow
            k="Sheet size"
            v={`${tglp.sheetWidth} × ${tglp.sheetHeight} px`}
          />
          <KvRow
            k="Sheets"
            v={`${tglp.sheetCount} × ${tglp.sheetColumns}c × ${tglp.sheetRows}r cells`}
          />
          <KvRow k="Texture format" v={v.formatName} />
          <KvRow k="Endian" v={v.endian} />
          <KvRow k="Version" v={`0x${header.version.toString(16).padStart(8, "0")}`} />
        </KvBlock>

        <BffntSampleSection
          font={v.renderable}
          sample={sample}
          onSampleChange={setSample}
        />

        <BffntAtlasSection font={v.renderable} formatName={v.formatName} />
      </div>
    </ScrollArea>
  )
}

/**
 * Live sample-text section: a textarea bound to a canvas, with
 * `renderText` re-running on every keystroke. The canvas is sized
 * to fit the rendered ImageData exactly; CSS scales it up via
 * `image-rendering: pixelated` so the rasterised glyphs stay crisp
 * even on zoomed-in displays.
 */
function BffntSampleSection({
  font,
  sample,
  onSampleChange,
}: {
  font: RenderableBffnt
  sample: string
  onSampleChange: (value: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  // Re-rasterise into the canvas whenever the sample text or theme
  // changes. We compose against a transparent background and let CSS
  // provide the surrounding card colour.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const text = sample.length > 0 ? sample : " "
    const rendered = renderBffntText(font, text)
    canvas.width = rendered.width
    canvas.height = rendered.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Recolour the alpha-mode RGBA8 ImageData to match the active
    // theme's foreground. The source pixels are pre-keyed to white
    // (alpha = glyph coverage), so we just overwrite RGB.
    const imageData = ctx.createImageData(rendered.width, rendered.height)
    const px = imageData.data
    const src = rendered.pixels
    const fg = isDark ? 235 : 25
    // Recolour to the active theme's foreground (source pixels are
    // pre-keyed white with alpha = glyph coverage).
    for (let i = 0; i < src.length; i += 4) {
      px[i] = fg
      px[i + 1] = fg
      px[i + 2] = fg
      px[i + 3] = src[i + 3]
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.putImageData(imageData, 0, 0)
  }, [font, sample, isDark])

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Sample
      </h3>
      <textarea
        value={sample}
        onChange={(e) => onSampleChange(e.target.value)}
        rows={3}
        className="resize-y rounded-md border bg-background px-3 py-2 text-sm font-mono"
        spellCheck={false}
      />
      <div className="overflow-x-auto rounded-md border bg-card p-4">
        <canvas
          ref={canvasRef}
          className="block max-w-full"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    </section>
  )
}

/**
 * Render the full deswizzled atlas (one image per TGLP sheet) so the
 * user can see every glyph the font ships with. Each sheet renders
 * to its own `<canvas>` at native resolution, then CSS scales it
 * down to fit the column.
 */
function BffntAtlasSection({
  font,
  formatName,
}: {
  font: RenderableBffnt
  formatName: string
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Atlas
      </h3>
      <p className="text-xs text-muted-foreground">
        {font.sheets.length} sheet{font.sheets.length === 1 ? "" : "s"} ·{" "}
        {formatName} · deswizzled and Y-flipped to top-left origin
      </p>
      <div className="flex flex-col gap-3">
        {font.sheets.map((sheet, i) => (
          <BffntAtlasSheet key={i} sheet={sheet} index={i} />
        ))}
      </div>
    </section>
  )
}

function BffntAtlasSheet({
  sheet,
  index,
}: {
  sheet: RenderableBffnt["sheets"][number]
  index: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = sheet.width
    canvas.height = sheet.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Recolour atlas pixels for theme contrast, same as the sample.
    const imageData = ctx.createImageData(sheet.width, sheet.height)
    const px = imageData.data
    const src = sheet.pixels
    const fg = isDark ? 235 : 25
    for (let i = 0; i < src.length; i += 4) {
      px[i] = fg
      px[i + 1] = fg
      px[i + 2] = fg
      px[i + 3] = src[i + 3]
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.putImageData(imageData, 0, 0)
  }, [sheet, isDark])

  return (
    <div className="overflow-x-auto rounded-md border bg-card p-3">
      <div className="mb-2 text-xs text-muted-foreground">
        Sheet {index} — {sheet.width} × {sheet.height} px
      </div>
      <canvas
        ref={canvasRef}
        className="block max-w-full"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  )
}

// -------- Layout helpers --------

function SectionHeader({ title }: { title: string }) {
  return (
    <div>
      <h2 className="font-heading text-base font-medium">{title}</h2>
      <Separator className="mt-2" />
    </div>
  )
}

function KvBlock({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

function KvRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/50 py-1.5 text-sm last:border-0">
      <dt className="min-w-[180px] text-muted-foreground">{k}</dt>
      <dd className={cn("flex-1 break-all", mono && "font-mono text-xs")}>{v}</dd>
    </div>
  )
}

function LoadingFiller({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Spinner />
      <span className="text-sm">{label}</span>
      <Skeleton className="h-3 w-40" />
    </div>
  )
}

function ErrorFiller({ error }: { error: Error }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-md">
        <CircleAlertIcon />
        <AlertTitle>Could not preview this file</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    </div>
  )
}

/**
 * Convert a `Blob` *or* a `Blob`-shaped facade (e.g. the lazy
 * AES-CTR decryption blob produced by `@tootallnate/nca`'s parser)
 * into a real `Blob` instance.
 *
 * `URL.createObjectURL`, `<img src>`, the CSS Font Loading API and
 * various other browser entry points are strict: they require an
 * actual `Blob` instance (`MediaSource` is also accepted, but not
 * relevant here). They reject anything that just *quacks* like a
 * Blob with `Argument 1 could not be converted to any of: Blob,
 * MediaSource`.
 *
 * If `value` already passes `instanceof Blob`, we return it
 * unchanged — that avoids paying for a copy on real Blobs. Otherwise
 * we read it through its (chunked, decrypting) `stream()` if
 * available, falling back to `arrayBuffer()` so that even minimal
 * facades work.
 *
 * Memory note: the materialised Blob holds the whole file in memory.
 * For multi-gigabyte assets this can OOM the tab — true streaming
 * downloads require the File System Access API's `createWritable()`,
 * which we don't use here yet. Acceptable for now since most browsable
 * files inside Switch archives are well under that range.
 */
async function materializeAsBlob(value: Blob): Promise<Blob> {
  // Real Blobs (and File, which extends Blob) pass straight through.
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value
  }
  if (typeof value.stream === "function") {
    return new Response(value.stream()).blob()
  }
  const buf = await value.arrayBuffer()
  return new Blob([buf])
}

function DownloadButton({
  blobFn,
  fileName,
}: {
  blobFn: () => Promise<Blob>
  fileName: string
}) {
  const [busy, setBusy] = useState(false)
  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const id = toast.loading(`Preparing ${fileName}…`)
    try {
      const blob = await blobFn()
      const realBlob = await materializeAsBlob(blob)
      const url = URL.createObjectURL(realBlob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      a.style.display = "none"
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke after the click is consumed
      setTimeout(() => URL.revokeObjectURL(url), 1500)
      toast.success(`Downloaded ${fileName}`, { id })
    } catch (err) {
      toast.error(
        `Failed to prepare ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        { id },
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" onClick={onClick} disabled={busy}>
      {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
      Download
    </Button>
  )
}
