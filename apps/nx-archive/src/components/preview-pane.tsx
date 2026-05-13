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
import { Progress } from "~/components/ui/progress"
import { ScrollArea } from "~/components/ui/scroll-area"
import { Separator } from "~/components/ui/separator"
import { Skeleton } from "~/components/ui/skeleton"
import { Spinner } from "~/components/ui/spinner"
import { BfresViewer } from "./bfres-viewer"
import { JsonInspector, UnityObjectInspector } from "./data-inspector"
import {
  demuxIvf,
  isVp9Keyframe,
  muxVp9WebmBlob,
  parseUsm,
  type UsmFile,
  type UsmStream,
  type UsmVideoStream,
} from "@tootallnate/usm"
import {
  ClassId as UnityClassId,
  parseObject as parseUnityObject,
  parseSerializedFile,
  TextureFormatName as UnityTextureFormatName,
  type DecodedTexture as UnityDecodedTexture,
  type ParsedSerializedFile,
  type SerializedObject,
} from "@tootallnate/unity-asset"
import { decodeTexture2D as decodeUnityTexture2D } from "~/lib/unity-texture"
import { StaticMeshViewer } from "./static-mesh-viewer"
import {
  decodeUeMip,
  describePixelFormat,
  UnsupportedPixelFormatError,
} from "~/lib/uasset-texture"
import {
  extractMaterialPathsFromProperties,
  pickDiffuseTexture,
  resolveMaterialTextures,
  type DecodedTexture,
} from "~/lib/uasset-material-chain"
import {
  createAssetResolver,
  type AssetResolver,
} from "~/lib/uasset-resolver"
import {
  parseFsb5,
  decodeSampleToBlob,
  loadFmodVorbisSetupPackets,
  type FmodVorbisSetupPackets,
} from "@tootallnate/fsb5"
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
  flattenHtdocsFromNode,
  type HtdocsFiles,
  regionDisplayName,
  rewriteHtml,
} from "~/lib/htdocs"
import type { RenderableBffnt } from "@tootallnate/bffnt"
import {
  parseBmfontBinary,
  type ParsedBmFont,
  type BmfChar,
} from "@tootallnate/bmfont"
import {
  getMipBytes,
  inferAssetClassName,
  isZenPackage,
  parseStaticMesh,
  parseTexturePlatformData,
  parseUasset,
  parseZenPackage,
  readExportProperties,
  resolveFName,
  resolveImportPackagePath,
  resolvePackageIndex,
  type LoadedStaticMesh,
  type NativeStruct,
  type ParsedTexturePlatformData,
  type ParsedUasset,
  type ParsedZenPackage,
  type TextureMip,
  type UExportProperties,
  type UProperty,
  type UValue,
} from "@tootallnate/uasset"
import {
  AUDIO_MIME,
  IMAGE_MIME,
  VIDEO_MIME,
  buildHexDump,
  detectPreviewKind,
  extOf,
  parseBarsForView,
  parseBarslistForView,
  parseBffntForView,
  parseBfsarForView,
  parseBfstmForAudioView,
  parseBfwavForAudioView,
  parseBfresForView,
  parseBntxForView,
  parseBnvibForView,
  parseByamlForView,
  parseWemForAudioView,
  parseFmodSampleForView,
  SOUND_FORMAT_NAMES,
  type WemView,
  type FmodSampleView,
  parseFontForView,
  parseCnmtForView,
  parseNacpForView,
  parseNpdmForView,
  parseNroForView,
  parseNsoForView,
  renderBffntText,
  type AudioPreviewView,
  type BarsView,
  type BarslistView,
  type BfresView,
  type BfsarView,
  type BntxView,
  type BnvibView,
  type ByamlView,
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
import {
  formatBytesShort,
  progressPercent,
  type ProgressEvent,
  type OnProgress,
} from "~/lib/progress"

const TEXT_PREVIEW_LIMIT = 1 * 1024 * 1024 // 1 MB
const HEX_PREVIEW_LIMIT = 4 * 1024 // 4 KB hex window
const IMAGE_PREVIEW_LIMIT = 32 * 1024 * 1024
const MEDIA_PREVIEW_LIMIT = 200 * 1024 * 1024
/** Above this we skip JSON/YAML parsing for the tree view and fall through to the source view. */
const TREE_PARSE_LIMIT = 4 * 1024 * 1024 // 4 MB

interface PreviewPaneProps {
  node: Node | null
  /**
   * Root of the archive tree the selected node belongs to. Passed
   * down to previews that need to discover sibling nodes — e.g.
   * the BFRES viewer scans for companion `*.Tex.*` and
   * `*_Animation.*` BFRES files in the same directory (BotW /
   * Splatoon / Odyssey split layouts) so the model picks up its
   * textures and animations even when they live separately.
   */
  root?: Node | null
  /**
   * Request that the host navigate to a different node in the tree
   * (selecting it AND scrolling it into view if needed). Previews
   * use this to expose deep-links between related assets, e.g.
   * "click this FontFace reference to jump to the actual font
   * file". When omitted, deep-link affordances render as plain
   * text.
   */
  onNavigate?: (node: Node) => void
}

export function PreviewPane({ node, root, onNavigate }: PreviewPaneProps) {
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

  return (
    <PreviewContent
      key={node.id}
      node={node}
      root={root ?? null}
      onNavigate={onNavigate}
    />
  )
}

function PreviewContent({
  node,
  root,
  onNavigate,
}: {
  node: Node
  root: Node | null
  onNavigate?: (node: Node) => void
}) {
  const isFile = !node.isContainer
  const kind = useMemo<PreviewKind | null>(
    () => {
      if (!isFile) return null
      // FMOD bank samples carry their bank+sample-index in `meta`.
      if (node.meta?.fmodSampleIndex !== undefined) return 'fmod-sample-audio'
      // Unity SerializedFiles (the `CAB-…` files inside a UnityFS
      // bundle) and the per-object children inside them don't have
      // a meaningful filename pattern that detectPreviewKind would
      // recognise — they're tagged by `node.kind` upstream in
      // `archive.ts` instead.
      if (node.kind === "unity-asset") return "unity-asset"
      if (node.kind === "unity-object") return "unity-object"
      return detectPreviewKind(node.name)
    },
    [isFile, node.name, node.meta, node.kind],
  )

  // Container nodes that have a dedicated structured preview instead
  // of the generic "expand me" empty state.
  const isHtdocs = node.kind === "htdocs"
  const isNca = node.kind === "nca"
  const isBars = node.kind === "bars"
  const isBfsar = node.kind === "bfsar"
  const isBfres = node.kind === "bfres"
  // Unity SerializedFile nodes are now containers (each inner
  // object becomes a child) but still benefit from the rich
  // SerializedFile-level summary as their "landing page" — show
  // it instead of the generic "expand me" empty state.
  const isUnityAsset = node.kind === "unity-asset"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PreviewHeader node={node} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {isHtdocs ? (
          <HtdocsPreview node={node} />
        ) : isNca ? (
          <NcaPreview node={node} />
        ) : isBars ? (
          <BarsPreview node={node} />
        ) : isBfsar ? (
          <BfsarPreview node={node} />
        ) : isBfres ? (
          <BfresPreview node={node} root={root} />
        ) : isUnityAsset ? (
          <UnityAssetPreview node={node} root={root} />
        ) : node.isContainer ? (
          <ContainerSummary node={node} />
        ) : (
          <FilePreview node={node} kind={kind!} root={root} onNavigate={onNavigate} />
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

/**
 * Live preview of a Switch offline-manual `*.htdocs/` directory.
 *
 * Mounts the parsed file map into an `HtdocsBundle`, picks the
 * default entry-point HTML, rewrites resource references to
 * point at minted blob URLs, and renders the document inside a
 * sandboxed iframe. Navigation events from the iframe (clicks,
 * `history.back()`, region picker) update `currentPath` and
 * trigger a re-render against the new document.
 *
 * The same component backs:
 *
 *   - `kind: 'htdocs'` directories (clicked via the tree) — opens
 *     at the bundle's natural entry point (`index.html` etc).
 *   - Standalone `.html` files inside an htdocs ancestor (mounted
 *     by {@link HtmlPreview}) — opens at that file's path within
 *     the ancestor's bundle.
 *   - Standalone `.html` files with no htdocs ancestor — opens
 *     against a synthesised single-file bundle.
 *
 * The Rendered / Source toggle in the toolbar swaps between the
 * iframe and a syntax-highlighted view of the *current document*'s
 * raw bytes (so `currentPath` stays meaningful in both views).
 */
function HtdocsPreview({
  node,
  filesProvider,
  initialPath,
}: {
  node: Node
  /**
   * Optional override for the file map. Defaults to walking
   * `node.getChildren()` recursively, which is what every htdocs-
   * tagged container provides. {@link HtmlPreview} uses this
   * override to mount a synthetic single-file bundle when a
   * standalone `.html` has no htdocs ancestor in the tree.
   *
   * The function is invoked once per `node` change; consumers
   * shouldn't rely on it being called repeatedly.
   */
  filesProvider?: () => Promise<HtdocsFiles>
  /**
   * Path within the bundle to focus on at mount time. Defaults to
   * `bundle.pickEntryPoint()` (index.html etc).
   */
  initialPath?: string
}) {
  // Build the bundle once per node. This materialises every file
  // in the manual into a real Blob (decrypting lazy NCA-section
  // facades on the way through) and creates an object URL per
  // file. The cleanup effect revokes them when the user
  // navigates away.
  //
  // The default file source walks `node.getChildren()`
  // recursively. Caller-supplied `filesProvider` overrides this
  // — the only consumer that does so today is {@link HtmlPreview}
  // for standalone `.html` previews with no htdocs ancestor.
  const [bundle, setBundle] = useState<HtdocsBundle | null>(null)
  const [bundleError, setBundleError] = useState<Error | null>(null)
  useEffect(() => {
    let cancelled = false
    let built: HtdocsBundle | null = null
    setBundle(null)
    setBundleError(null)
    const loadFiles = filesProvider ?? (() => flattenHtdocsFromNode(node))
    loadFiles()
      .then((files) => HtdocsBundle.build(files))
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
  }, [node, filesProvider])

  // Use the caller-supplied initial path when present (e.g. when
  // an HtmlPreview is focusing on one .html file inside a wider
  // htdocs scope), otherwise fall back to the bundle's natural
  // entry point (`index.html`, `top.html`, …).
  const entryPoint = useMemo(() => {
    if (!bundle) return null
    if (initialPath && bundle.hasFile(initialPath)) return initialPath
    return bundle.pickEntryPoint()
  }, [bundle, initialPath])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  // Rendered (iframe) vs Source (raw bytes of `currentPath`).
  // Defaults to Rendered — the whole point of the htdocs preview
  // is the live render. Source is opt-in.
  const [view, setView] = useState<"rendered" | "source">("rendered")
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
        <RenderedSourceToggle view={view} onChange={setView} />
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

      {/* Iframe / source + optional debug panel */}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-hidden">
          {view === "source" ? (
            <HtdocsSourceView
              bundle={bundle}
              path={currentPath}
            />
          ) : iframeSrcDoc ? (
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

/**
 * Two-button segmented control for the htdocs preview's
 * Rendered / Source toggle. Mirrors the look of the JSON / YAML
 * tree preview's toggle so the interaction feels consistent.
 */
function RenderedSourceToggle({
  view,
  onChange,
}: {
  view: "rendered" | "source"
  onChange: (next: "rendered" | "source") => void
}) {
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border text-xs"
      role="tablist"
      aria-label="View mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "rendered"}
        onClick={() => onChange("rendered")}
        className={cn(
          "px-2.5 py-1 font-medium",
          view === "rendered"
            ? "bg-accent text-accent-foreground"
            : "bg-background text-muted-foreground hover:bg-accent/50",
        )}
      >
        Rendered
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "source"}
        onClick={() => onChange("source")}
        className={cn(
          "border-l px-2.5 py-1 font-medium",
          view === "source"
            ? "bg-accent text-accent-foreground"
            : "bg-background text-muted-foreground hover:bg-accent/50",
        )}
      >
        Source
      </button>
    </div>
  )
}

/**
 * Render the raw text contents of the htdocs document at `path`,
 * fetched from the same `HtdocsBundle` the iframe view uses. The
 * bytes have already been blob-mapped, so we just `.text()` the
 * stored Blob and feed it to the existing syntax-highlight
 * pipeline (HTML, CSS, JS, JSON, etc.) for a familiar look.
 */
function HtdocsSourceView({
  bundle,
  path,
}: {
  bundle: HtdocsBundle
  path: string
}) {
  const { resolvedTheme } = useTheme()
  const themeMode = resolvedTheme === "dark" ? "dark" : "light"
  // Pull the bytes once per document. The bundle already holds a
  // Blob per file from its initial build, so this is purely a
  // `.text()` decode — fast even for sizeable HTML docs.
  const { loading, data, error } = useAsync(async () => {
    const blob = bundle.files.get(path)
    if (!blob) {
      throw new Error(`File "${path}" is not in this htdocs bundle.`)
    }
    const truncated = blob.size > TEXT_PREVIEW_LIMIT
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_LIMIT) : blob
    const text = await slice.text()
    const lang = languageForFile(path)
    const highlightable = !!lang && text.length <= HIGHLIGHT_LIMIT
    return { text, truncated, fullSize: blob.size, lang, highlightable }
  }, [bundle, path])

  // Async highlight (lazy-loaded grammar). Falls back to plain
  // text if the highlighter isn't available for the language.
  const [highlighted, setHighlighted] = useState<string | null>(null)
  useEffect(() => {
    if (!data || !data.highlightable || !data.lang) {
      setHighlighted(null)
      return
    }
    let cancelled = false
    highlightCode(data.text, data.lang, themeMode)
      .then((html) => {
        if (!cancelled) setHighlighted(html)
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null)
      })
    return () => {
      cancelled = true
    }
  }, [data, themeMode])

  if (loading) return <LoadingFiller label="Reading…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-4">
        {data!.truncated && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Source truncated</AlertTitle>
            <AlertDescription>
              Showing the first {formatBytes(TEXT_PREVIEW_LIMIT)} of{" "}
              {formatBytes(data!.fullSize)}.
            </AlertDescription>
          </Alert>
        )}
        {highlighted ? (
          <div
            className="shiki-host overflow-x-auto rounded-md text-xs leading-relaxed [&>pre]:m-0 [&>pre]:p-3 [&_code]:font-mono [&_code]:whitespace-pre-wrap [&_code]:break-words"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre className="rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {data!.text}
          </pre>
        )}
      </div>
    </ScrollArea>
  )
}

/**
 * Standalone HTML file preview.
 *
 * The user picked a single `.html` from the tree (not an entire
 * `*.htdocs/` directory). We look for an ancestor `.htdocs` node
 * to use as the resource-resolution scope: when the HTML lives
 * inside a Switch offline-manual subtree, references like
 * `<img src="img/foo.png">` resolve against the manual's full
 * file map. When there's no ancestor (e.g. the user dropped just
 * a single `.html` from their downloads), we build a one-file
 * synthetic bundle so the iframe still renders the document
 * itself — relative resource refs simply 404.
 *
 * Either way we mount {@link HtdocsPreview} so the rendered
 * iframe, navigation, and Rendered/Source toggle behave identical
 * to the manual-browsing case.
 */
function HtmlPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  // Resolve the htdocs scope (ancestor + file path within it) on
  // first mount. The lookup walks up `node.id` until we hit an
  // htdocs-tagged ancestor; the synthesised single-file fallback
  // kicks in for everything else.
  const { loading, data, error } = useAsync(async () => {
    const ancestor = await findHtdocsAncestor(root, node.id)
    if (ancestor) {
      return {
        scopeNode: ancestor.node,
        initialPath: ancestor.relativePath,
        filesProvider: undefined as undefined | (() => Promise<HtdocsFiles>),
      }
    }
    // No htdocs ancestor — synthesise a single-file bundle so the
    // iframe still renders the document. Relative resource refs
    // (img / css / js) silently 404 in this mode, which is the
    // best we can do without sibling context.
    const blob = await node.blob!()
    const filesProvider = async (): Promise<HtdocsFiles> =>
      new Map([[node.name, blob]])
    return {
      scopeNode: node,
      initialPath: node.name,
      filesProvider,
    }
  }, [node.id, root])

  if (loading) return <LoadingFiller label="Resolving HTML scope…" />
  if (error) return <ErrorFiller error={error} />
  return (
    <HtdocsPreview
      node={data!.scopeNode}
      filesProvider={data!.filesProvider}
      initialPath={data!.initialPath}
    />
  )
}

interface HtdocsAncestorMatch {
  /** The ancestor htdocs node (`kind: 'htdocs'`). */
  node: Node
  /** Path of `descendantId` relative to the ancestor's root, e.g. `index.html` or `img/foo.png`. */
  relativePath: string
}

/**
 * Walk up `descendantId` looking for an ancestor node whose `kind`
 * is `'htdocs'`. Returns the ancestor + the file's path within
 * its file map, or `null` if no htdocs ancestor exists.
 *
 * Implementation note: node IDs are slash-joined paths, so
 * candidate ancestor IDs are just successively-shorter prefixes
 * of `descendantId`. We resolve each candidate via the same
 * tree-walk pattern used by other sibling-resolution helpers.
 */
async function findHtdocsAncestor(
  root: Node | null,
  descendantId: string,
): Promise<HtdocsAncestorMatch | null> {
  if (!root) return null
  // Build the list of slash-prefixes from longest to shortest,
  // skipping the descendant itself (we only care about ancestors).
  const segments = descendantId.split("/")
  for (let i = segments.length - 1; i > 0; i--) {
    const candidateId = segments.slice(0, i).join("/")
    const ancestor = await findNodeById(root, candidateId)
    if (!ancestor) continue
    if (ancestor.kind === "htdocs") {
      const relative = descendantId.slice(candidateId.length + 1)
      return { node: ancestor, relativePath: relative }
    }
  }
  return null
}

/**
 * Resolve a node by its slash-joined `id` by walking down from
 * `root`. Reuses the same pattern as the other archive-tree
 * helpers; cached children get reused on repeat lookups.
 */
async function findNodeById(
  root: Node,
  target: string,
): Promise<Node | null> {
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

function FilePreview({
  node,
  kind,
  root,
  onNavigate,
}: {
  node: Node
  kind: PreviewKind
  root: Node | null
  onNavigate?: (node: Node) => void
}) {
  switch (kind) {
    case "image":
      return <ImagePreview node={node} />
    case "audio":
      return <MediaPreview node={node} kind="audio" />
    case "video":
      return <MediaPreview node={node} kind="video" />
    case "text":
      return <TextPreview node={node} kind="text" />
    case "json-tree":
      return <TreePreview node={node} kind="json" />
    case "yaml-tree":
      return <TreePreview node={node} kind="yaml" />
    case "html-preview":
      return <HtmlPreview node={node} root={root} />
    case "uasset-info":
      return <UassetPreview node={node} root={root} onNavigate={onNavigate} />
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
    case "bmfont-info":
      return <BmfontPreview node={node} root={root} />
    case "bfwav-audio":
      return <NintendoAudioPreview node={node} kind="bfwav" />
    case "bfstm-audio":
      return <NintendoAudioPreview node={node} kind="bfstm" />
    case "wem-audio":
      return <WemAudioPreview node={node} />
    case "fmod-sample-audio":
      return <FmodSamplePreview node={node} />
    case "barslist-info":
      return <BarslistPreview node={node} />
    case "bnvib-audio":
      return <BnvibPreview node={node} />
    case "byaml-tree":
      return <ByamlPreview node={node} />
    case "bntx-image":
      return <BntxPreview node={node} />
    case "usm-video":
      return <UsmPreview node={node} />
    case "unity-asset":
      return <UnityAssetPreview node={node} root={root} />
    case "unity-object":
      return <UnityObjectPreview node={node} root={root} />
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

/**
 * Same as {@link useAsync} but the loader receives an `onProgress`
 * callback. The most-recent progress event is exposed alongside
 * `loading` so the consumer can render `<ProgressFiller>`.
 *
 * Progress updates are throttled via `requestAnimationFrame` so
 * decompressors firing 10s of events per second don't trigger a
 * re-render storm.
 */
function useAsyncWithProgress<T>(
  loader: (onProgress: OnProgress) => Promise<T>,
  deps: unknown[],
) {
  const [state, setState] = useState<{
    loading: boolean
    data: T | null
    error: Error | null
    progress: ProgressEvent | null
  }>({ loading: true, data: null, error: null, progress: null })

  useEffect(() => {
    let cancelled = false
    let pending: ProgressEvent | null = null
    let rafId: number | null = null

    const onProgress: OnProgress = (e) => {
      pending = e
      if (rafId !== null || cancelled) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (cancelled) return
        const next = pending
        pending = null
        setState((s) => ({ ...s, progress: next }))
      })
    }

    setState({ loading: true, data: null, error: null, progress: null })
    loader(onProgress)
      .then((data) => {
        if (!cancelled)
          setState({ loading: false, data, error: null, progress: null })
      })
      .catch((err: Error) => {
        if (!cancelled)
          setState({
            loading: false,
            data: null,
            error: err,
            progress: null,
          })
      })
    return () => {
      cancelled = true
      if (rafId !== null) cancelAnimationFrame(rafId)
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

/**
 * Tree-or-source preview for structured data files: JSON natively,
 * YAML through `js-yaml`. Defaults to the interactive
 * `<JsonInspector>` tree (collapsible nodes, inline previews) and
 * exposes a "Source" toggle that falls back to {@link TextPreview}
 * for syntax-highlighted raw text. When the file is too large to
 * parse comfortably, or when parsing fails, we render the source
 * view automatically with a small hint explaining why.
 */
function TreePreview({
  node,
  kind,
}: {
  node: Node
  kind: "json" | "yaml"
}) {
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    const truncated = blob.size > TREE_PARSE_LIMIT
    if (truncated) return { value: null, parseError: null, truncated }
    const text = await blob.text()
    try {
      if (kind === "yaml") {
        const { parseYaml } = await import("~/lib/yaml")
        return { value: await parseYaml(text), parseError: null, truncated }
      }
      return { value: JSON.parse(text), parseError: null, truncated }
    } catch (e) {
      return {
        value: null,
        parseError: e instanceof Error ? e.message : String(e),
        truncated,
      }
    }
  }, [node.id, kind])

  // Default to Tree view; user can flip to Source for the raw
  // syntax-highlighted text. We force Source when parsing failed
  // or the file is too large to parse.
  const [view, setView] = useState<"tree" | "source">("tree")
  const forcedSource =
    !!data && (data.truncated || data.parseError !== null)
  const effectiveView = forcedSource ? "source" : view

  if (loading) return <LoadingFiller label="Reading…" />
  if (error) return <ErrorFiller error={error} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card px-4 py-2">
        <div className="text-xs text-muted-foreground">
          {data!.parseError ? (
            <span className="text-destructive">
              {kind === "yaml" ? "YAML" : "JSON"} parse error: {data!.parseError}
            </span>
          ) : data!.truncated ? (
            <span>
              File too large for tree view (
              {formatBytes(node.size ?? 0)}); showing source.
            </span>
          ) : (
            <span>
              {kind === "yaml" ? "YAML" : "JSON"} —{" "}
              {effectiveView === "tree"
                ? "click nodes to expand"
                : "syntax-highlighted source"}
            </span>
          )}
        </div>
        {!forcedSource && (
          <div
            className="inline-flex overflow-hidden rounded-md border text-xs"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={effectiveView === "tree"}
              onClick={() => setView("tree")}
              className={cn(
                "px-2.5 py-1 font-medium",
                effectiveView === "tree"
                  ? "bg-accent text-accent-foreground"
                  : "bg-background text-muted-foreground hover:bg-accent/50",
              )}
            >
              Tree
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveView === "source"}
              onClick={() => setView("source")}
              className={cn(
                "border-l px-2.5 py-1 font-medium",
                effectiveView === "source"
                  ? "bg-accent text-accent-foreground"
                  : "bg-background text-muted-foreground hover:bg-accent/50",
              )}
            >
              Source
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {effectiveView === "tree" ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              <JsonInspector data={data!.value} expandLevel={2} />
            </div>
          </ScrollArea>
        ) : (
          // Source view delegates to the existing TextPreview path
          // so we get the same syntax-highlighting, truncation, and
          // theming as plain text files. YAML is highlighted as
          // text (we don't ship a YAML grammar) which still gives
          // structural colour for keys / values.
          <TextPreview node={node} kind={kind === "json" ? "json" : "text"} />
        )}
      </div>
    </div>
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

// ---- NACP enum/bitfield decoders ----
//
// These mirror the names used in libpietendo / libnx / switchbrew so an
// "Author note" reading our UI can cross-reference upstream docs without
// guessing what each magic number means.
//
// Refs:
//   https://switchbrew.org/wiki/NACP
//   https://switchbrew.github.io/libnx/nacp_8h_source.html

const STARTUP_USER_ACCOUNT: Record<number, string> = {
  0: "None",
  1: "Required",
  2: "RequiredWithNetworkServiceAccountAvailable",
}
const HDCP: Record<number, string> = { 0: "None", 1: "Required" }
const SCREENSHOT: Record<number, string> = { 0: "Allow", 1: "Deny" }
const VIDEO_CAPTURE: Record<number, string> = {
  0: "Disabled",
  1: "Manual",
  2: "Enabled",
}
const LOGO_TYPE: Record<number, string> = {
  0: "LicensedByNintendo",
  1: "DistributedByNintendo",
  2: "Nintendo",
}
const LOGO_HANDLING: Record<number, string> = { 0: "Auto", 1: "Manual" }

/**
 * Bit names for the SupportedLanguageFlag bitfield. Each set bit at
 * position N means the title ships content for `Language(N)`.
 */
const LANGUAGE_NAMES = [
  "AmericanEnglish",
  "BritishEnglish",
  "Japanese",
  "French",
  "German",
  "LatinAmericanSpanish",
  "Spanish",
  "Italian",
  "Dutch",
  "CanadianFrench",
  "Portuguese",
  "Russian",
  "Korean",
  "TraditionalChinese",
  "SimplifiedChinese",
  "BrazilianPortuguese",
  "Polish", // [21.0.0+]
  "Thai",   // [21.0.0+]
]

/**
 * Bit names for the AttributeFlag bitfield. Each bit corresponds to a
 * named flag from libpietendo's `AttributeFlag` enum.
 */
const ATTRIBUTE_FLAG_NAMES = ["Demo", "RetailInteractiveDisplay"]

/**
 * Bit names for the ParentalControlFlag bitfield. Only one bit
 * (`FreeCommunication`) is currently documented — the rest decode
 * as `Unknown(bit N)` so we don't silently hide future additions.
 */
const PARENTAL_CONTROL_FLAG_NAMES = ["FreeCommunication"]

/** Decode an enum value to its name, or `Unknown(N)` if unmapped. */
function enumHint(map: Record<number, string>, v: number): string {
  return map[v] ?? `Unknown(${v})`
}

/**
 * Decode a 32-bit bitfield into a comma-separated list of set-bit
 * names. Returns "(none)" when zero, and "(all)" when every named
 * bit is set (saves space on language flags for fully-localised
 * titles).
 */
function bitfieldHint(names: readonly string[], v: number): string {
  if (v === 0) return "(none)"
  const labels: string[] = []
  for (let i = 0; i < 32; i++) {
    if ((v >>> i) & 1) labels.push(names[i] ?? `bit${i}`)
  }
  if (
    names.length > 0 &&
    labels.length === names.length &&
    labels.every((l, i) => l === names[i])
  ) {
    return `(all ${names.length})`
  }
  return labels.join(", ")
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
          <KvRow
            k="Startup user account"
            v={String(data!.startupUserAccount)}
            hint={enumHint(STARTUP_USER_ACCOUNT, data!.startupUserAccount)}
          />
          <KvRow
            k="HDCP"
            v={String(data!.hdcp)}
            hint={enumHint(HDCP, data!.hdcp)}
          />
          <KvRow
            k="Screenshot"
            v={String(data!.screenshot)}
            hint={enumHint(SCREENSHOT, data!.screenshot)}
          />
          <KvRow
            k="Video capture"
            v={String(data!.videoCapture)}
            hint={enumHint(VIDEO_CAPTURE, data!.videoCapture)}
          />
          <KvRow
            k="Logo type"
            v={String(data!.logoType)}
            hint={enumHint(LOGO_TYPE, data!.logoType)}
          />
          <KvRow
            k="Logo handling"
            v={String(data!.logoHandling)}
            hint={enumHint(LOGO_HANDLING, data!.logoHandling)}
          />
          <KvRow
            k="Supported language flag"
            v={"0x" + data!.supportedLanguageFlag.toString(16)}
            hint={bitfieldHint(LANGUAGE_NAMES, data!.supportedLanguageFlag)}
            mono
          />
          <KvRow
            k="Parental control flag"
            v={"0x" + data!.parentalControlFlag.toString(16)}
            hint={bitfieldHint(
              PARENTAL_CONTROL_FLAG_NAMES,
              data!.parentalControlFlag,
            )}
            mono
          />
          <KvRow
            k="Attribute flag"
            v={"0x" + data!.attributeFlag.toString(16)}
            hint={bitfieldHint(ATTRIBUTE_FLAG_NAMES, data!.attributeFlag)}
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
        : v.format === "woff"
          ? "WOFF (zlib-wrapped sfnt)"
          : v.format === "woff2"
            ? "WOFF2 (Brotli-wrapped sfnt)"
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

// ====================================================================
// AngelCode BMFont (.fnt) bitmap font preview
// ====================================================================
//
// BMFont ships as a `.fnt` descriptor + one or more PNG atlas pages.
// We parse the descriptor with `@tootallnate/bmfont` and look up the
// page PNGs as siblings of the `.fnt` in the archive tree. Glyph
// composition is done in the browser: we draw the page image to an
// offscreen canvas once, then for each character in the user-typed
// sample we copy the glyph's atlas rectangle onto a target canvas at
// the pen position dictated by `xoffset` / `yoffset` / `xadvance`.
//
// Sibling resolution is the same pattern Texture2D's `m_StreamData`
// uses for `.resS` files. When the user opens just the `.fnt` (no
// directory) we fall back to a file picker so they can pair it with
// the PNG manually.

const BMFONT_DEFAULT_SAMPLE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  !@#$%&*()_+-=[]{};':\",./<>?"

interface BmfontView {
  parsed: ParsedBmFont
  /** Loaded `<img>`-shaped pages, indexed by page number. Missing pages are `null`. */
  pageImages: (HTMLImageElement | null)[]
  /** Filename → blob URL of any pages we resolved automatically (cleaned up by the effect). */
  pageBlobUrls: string[]
  /** Map from codepoint → glyph for fast sample-text composition. */
  glyphIndex: Map<number, BmfChar>
}

function BmfontPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  // First load: parse the .fnt + try to auto-resolve sibling page
  // PNGs from the archive tree. We only fail hard on a parse error
  // — missing pages just leave `pageImages[i] = null` so the
  // sample text shows boxes for unrenderable glyphs and the user
  // gets a "load page atlas" file picker below.
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const parsed = parseBmfontBinary(bytes)
    const siblings = await resolveBmfontPages(node, root, parsed)
    const blobUrls: string[] = []
    const images: (HTMLImageElement | null)[] = await Promise.all(
      parsed.pages.map(async (name) => {
        const sibling = siblings.get(name.toLowerCase())
        if (!sibling) return null
        const url = URL.createObjectURL(sibling)
        blobUrls.push(url)
        return loadImage(url)
      }),
    )
    const glyphIndex = new Map<number, BmfChar>()
    for (const ch of parsed.chars) glyphIndex.set(ch.id, ch)
    const view: BmfontView = {
      parsed,
      pageImages: images,
      pageBlobUrls: blobUrls,
      glyphIndex,
    }
    return view
  }, [node.id])

  // Manually-loaded pages (when the auto-resolution misses one).
  // Keyed by page index, layered on top of `data.pageImages`.
  const [manualPages, setManualPages] = useState<
    Map<number, { image: HTMLImageElement; url: string }>
  >(new Map())

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    if (!data) return
    return () => {
      for (const url of data.pageBlobUrls) URL.revokeObjectURL(url)
    }
  }, [data])
  useEffect(() => {
    return () => {
      for (const { url } of manualPages.values()) URL.revokeObjectURL(url)
    }
  }, [manualPages])

  const [sample, setSample] = useState(BMFONT_DEFAULT_SAMPLE)

  if (loading) return <LoadingFiller label="Decoding BMFont…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!

  // Effective per-page images: manual pages override auto pages.
  const effectiveImages = v.pageImages.map(
    (img, i) => manualPages.get(i)?.image ?? img,
  )
  const missingPageIndices = effectiveImages
    .map((img, i) => (img ? -1 : i))
    .filter((i) => i >= 0)

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BMFont — AngelCode bitmap font" />

        <KvBlock title="Font">
          <KvRow k="Face" v={v.parsed.info.face} />
          <KvRow k="Size" v={`${v.parsed.info.fontSize} pt`} />
          <KvRow k="Line height" v={`${v.parsed.common.lineHeight} px`} />
          <KvRow k="Baseline" v={`${v.parsed.common.base} px from cell top`} />
          <KvRow
            k="Style"
            v={[
              v.parsed.info.flags.bold && "bold",
              v.parsed.info.flags.italic && "italic",
              v.parsed.info.flags.smooth && "smoothed",
              v.parsed.info.flags.unicode && "unicode",
            ]
              .filter(Boolean)
              .join(", ") || "regular"}
          />
          <KvRow k="Glyphs" v={`${v.parsed.chars.length}`} />
          <KvRow k="Kerning pairs" v={`${v.parsed.kernings.length}`} />
        </KvBlock>

        <KvBlock title="Atlas">
          <KvRow
            k="Sheet size"
            v={`${v.parsed.common.scaleW} × ${v.parsed.common.scaleH} px`}
          />
          <KvRow k="Pages" v={`${v.parsed.common.pages}`} />
          <KvRow
            k="Channels"
            v={
              v.parsed.common.flags.packed
                ? "packed (per-channel glyphs)"
                : "single-channel"
            }
          />
        </KvBlock>

        {missingPageIndices.length > 0 && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>
              Page atlas
              {missingPageIndices.length === 1 ? "" : "es"} missing
            </AlertTitle>
            <AlertDescription>
              <p className="mb-2">
                The font references the following PNG file
                {missingPageIndices.length === 1 ? "" : "s"} which
                {missingPageIndices.length === 1 ? " wasn't" : " weren't"} found
                next to the `.fnt`:
              </p>
              <ul className="mb-2 ml-4 list-disc text-xs font-mono">
                {missingPageIndices.map((i) => (
                  <li key={i}>{v.parsed.pages[i]}</li>
                ))}
              </ul>
              <p>
                Drop a directory containing both files, or load each page atlas
                manually below.
              </p>
            </AlertDescription>
          </Alert>
        )}

        <BmfontSampleSection
          view={v}
          effectiveImages={effectiveImages}
          sample={sample}
          onSampleChange={setSample}
        />

        <BmfontPagesSection
          pages={v.parsed.pages}
          effectiveImages={effectiveImages}
          onManualLoad={async (pageIndex, file) => {
            const url = URL.createObjectURL(file)
            const image = await loadImage(url)
            setManualPages((prev) => {
              const next = new Map(prev)
              const old = next.get(pageIndex)
              if (old) URL.revokeObjectURL(old.url)
              next.set(pageIndex, { image, url })
              return next
            })
          }}
        />
      </div>
    </ScrollArea>
  )
}

/**
 * Walk the archive tree to find sibling files of the `.fnt` whose
 * names match the `pages[]` filenames. When the user dropped a
 * whole directory the siblings live in the same parent node; for
 * a standalone `.fnt` upload there are no siblings and we return
 * an empty map (the manual-load picker handles that case).
 */
async function resolveBmfontPages(
  node: Node,
  root: Node | null,
  parsed: ParsedBmFont,
): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  if (!root) return out
  const slash = node.id.lastIndexOf("/")
  if (slash <= 0) return out
  const parentId = node.id.slice(0, slash)
  const findById = async (n: Node, target: string): Promise<Node | null> => {
    if (n.id === target) return n
    if (!target.startsWith(n.id + "/") && n.id !== "") return null
    let cur: Node = n
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
  const parent = await findById(root, parentId)
  if (!parent || !parent.getChildren) return out
  const siblings =
    parent._children ?? (parent._children = await parent.getChildren())
  const wanted = new Set(parsed.pages.map((n) => n.toLowerCase()))
  for (const k of siblings) {
    if (k.blob && wanted.has(k.name.toLowerCase())) {
      try {
        out.set(k.name.toLowerCase(), await k.blob())
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

/**
 * Load an `<img>` from a URL and resolve once `decode()` finishes.
 * Reused for both auto-resolved and manually-loaded page atlases.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(new Error(`Failed to load image: ${e}`))
    img.src = url
  })
}

/**
 * Live sample-text section: a textarea bound to a canvas that
 * composites the user-typed sample glyph-by-glyph from the atlas
 * page images.
 *
 * Layout follows the BMFont spec: pen starts at `(0, 0)` for each
 * line; for each character we draw the atlas rectangle at
 * `(pen.x + xoffset, pen.y + yoffset)` and advance the pen by
 * `xadvance`. Newlines wrap to the next line (`pen.y +=
 * lineHeight`). Kerning is applied between consecutive glyphs.
 */
function BmfontSampleSection({
  view,
  effectiveImages,
  sample,
  onSampleChange,
}: {
  view: BmfontView
  effectiveImages: (HTMLImageElement | null)[]
  sample: string
  onSampleChange: (value: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Build a kerning lookup from `(first, second)` → amount once
  // per font; we re-use it across every render of the sample.
  const kerningMap = useMemo(() => {
    const m = new Map<number, number>()
    for (const k of view.parsed.kernings) {
      m.set(kerningKey(k.first, k.second), k.amount)
    }
    return m
  }, [view.parsed.kernings])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const text = sample.length > 0 ? sample : " "
    const layout = layoutBmfontText(view, text, kerningMap)
    // Make the canvas exactly the right size to hold the laid-out
    // glyphs at 1× — CSS `max-width:100%` scales it down for the
    // pane, and `image-rendering: pixelated` keeps it crisp.
    canvas.width = Math.max(1, layout.width)
    canvas.height = Math.max(1, layout.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const g of layout.glyphs) {
      const img = effectiveImages[g.glyph.page]
      if (!img) continue
      ctx.drawImage(
        img,
        g.glyph.x,
        g.glyph.y,
        g.glyph.width,
        g.glyph.height,
        g.dstX,
        g.dstY,
        g.glyph.width,
        g.glyph.height,
      )
    }
  }, [view, sample, kerningMap, effectiveImages])

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Sample
      </h3>
      <textarea
        value={sample}
        onChange={(e) => onSampleChange(e.target.value)}
        rows={3}
        className="w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
      />
      <div className="overflow-auto rounded-md border bg-card p-3">
        <canvas
          ref={canvasRef}
          className="block max-w-full"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    </section>
  )
}

interface BmfontLayoutGlyph {
  glyph: BmfChar
  /** Top-left destination pixel for the glyph rectangle. */
  dstX: number
  dstY: number
}

interface BmfontLayoutResult {
  width: number
  height: number
  glyphs: BmfontLayoutGlyph[]
}

/**
 * Compute glyph destination positions for `text` using the BMFont
 * pen-based layout. Returns the bounding canvas size + per-glyph
 * draw commands, ready for `ctx.drawImage`.
 *
 * Unrecognised codepoints are simply skipped — no fallback box —
 * so the sample text length doesn't depend on the user typing
 * only characters present in the font.
 */
function layoutBmfontText(
  view: BmfontView,
  text: string,
  kerning: Map<number, number>,
): BmfontLayoutResult {
  const lineHeight = view.parsed.common.lineHeight
  let penX = 0
  let penY = 0
  let maxX = 0
  let maxY = lineHeight // at least one line tall
  let prevId = -1
  const glyphs: BmfontLayoutGlyph[] = []
  // Iterate codepoints, not UTF-16 code units, so emoji / surrogate
  // pairs are handled correctly when the font happens to ship them.
  for (const ch of text) {
    if (ch === "\n") {
      penX = 0
      penY += lineHeight
      maxY = penY + lineHeight
      prevId = -1
      continue
    }
    const id = ch.codePointAt(0)
    if (id === undefined) continue
    const glyph = view.glyphIndex.get(id)
    if (!glyph) {
      // Skip — keep the pen where it is. Most fonts include a
      // space glyph but not every codepoint, and rendering a
      // visible miss as a placeholder would distort layout.
      continue
    }
    if (prevId >= 0) {
      const k = kerning.get(kerningKey(prevId, id))
      if (k !== undefined) penX += k
    }
    if (glyph.width > 0 && glyph.height > 0) {
      glyphs.push({
        glyph,
        dstX: penX + glyph.xoffset,
        dstY: penY + glyph.yoffset,
      })
    }
    penX += glyph.xadvance
    if (penX > maxX) maxX = penX
    prevId = id
  }
  return { width: maxX, height: maxY, glyphs }
}

/** Pack two codepoints into a single map key for kerning lookups. */
function kerningKey(first: number, second: number): number {
  // Codepoints are well within u31, so shift+OR is safe.
  return (first << 21) | (second & 0x1fffff)
}

/**
 * Atlas viewer + per-page "load PNG" picker for cases where the
 * sibling resolution couldn't find the page image (typical when
 * the user dropped just the `.fnt` from their downloads folder).
 */
function BmfontPagesSection({
  pages,
  effectiveImages,
  onManualLoad,
}: {
  pages: string[]
  effectiveImages: (HTMLImageElement | null)[]
  onManualLoad: (pageIndex: number, file: File) => void | Promise<void>
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Pages
      </h3>
      <div className="flex flex-col gap-3">
        {pages.map((name, i) => {
          const img = effectiveImages[i]
          return (
            <div key={i} className="flex flex-col gap-2 rounded-md border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-mono text-muted-foreground">
                  {name}
                  {img ? (
                    <span className="ml-2 text-muted-foreground">
                      ({img.naturalWidth} × {img.naturalHeight})
                    </span>
                  ) : (
                    <span className="ml-2 text-destructive">not loaded</span>
                  )}
                </div>
                {!img && (
                  <label className="cursor-pointer rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-accent">
                    Load PNG
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void onManualLoad(i, file)
                        e.target.value = ""
                      }}
                    />
                  </label>
                )}
              </div>
              {img && (
                <div className="overflow-auto rounded-md border bg-[#0a0a0a] p-2">
                  <img
                    src={img.src}
                    alt={name}
                    className="block max-w-full"
                    style={{ imageRendering: "pixelated" }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ====================================================================
// Unreal Engine .uasset / .umap header preview
// ====================================================================
//
// We surface the package summary, name table, import table, and
// export table — enough to identify what an asset is without
// shipping the per-class property serializer (which is a 10k+
// LOC project of its own; tools like CUE4Parse / UAssetAPI
// handle that).
//
// In practice this lets users see at a glance:
//
//   - The asset's primary class (BinkMediaPlayer, AkInitBank,
//     Texture2D, WidgetBlueprint, etc.) — inferred from the
//     first export's classIndex resolved through the import
//     table
//   - What other packages this asset depends on (full import
//     table)
//   - What named properties / classes the asset references
//     (name table) — useful as a hint at what the asset is
//     configured to do, even without decoding property values
//   - The file's sub-objects (export table) and where their
//     serialized bodies live in the file

// A UassetPreview's loader returns either the legacy-format result
// (with a `.uexp` sibling supplying property data) or a UE5 Zen
// package result (everything inline in a single blob). The render
// path branches on the discriminator.
type UassetPreviewData =
  | {
      kind: "legacy"
      parsed: ParsedUasset
      exports: UExportProperties[]
      uexpError: Error | null
      uexpBytes: Uint8Array | null
      ubulkBytes: Uint8Array | null
    }
  | {
      kind: "zen"
      parsed: ParsedZenPackage
      sourceBytes: Uint8Array
    }

function UassetPreview({
  node,
  root,
  onNavigate,
}: {
  node: Node
  root: Node | null
  onNavigate?: (node: Node) => void
}) {
  const { loading, data, error } = useAsync<UassetPreviewData>(async () => {
    const blob = await node.blob!()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // Legacy .uasset (magic 0x9E2A83C1) vs UE5 IO Store ("Zen"):
    // legacy files have the magic at offset 0, Zen files don't.
    // We can't just call `parseUasset(bytes)` and catch — that
    // produces a misleading error for the Zen case.
    const looksLegacy =
      bytes.length >= 4 &&
      bytes[0] === 0xc1 &&
      bytes[1] === 0x83 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x9e
    if (!looksLegacy && isZenPackage(bytes)) {
      const parsed = parseZenPackage(bytes)
      return { kind: "zen", parsed, sourceBytes: bytes }
    }
    const parsed = parseUasset(bytes)
    // UE splits each asset into a `.uasset` (header tables) and a
    // sibling `.uexp` (the actual export property bodies). When a
    // sibling exists in the same archive we decode its properties so
    // the user sees real values like `Looping=true` and not just the
    // names of the properties.
    //
    // For Texture2D / TextureCube assets we also try to grab the
    // `.ubulk` sibling — that's where UE stores the larger mip
    // levels when the texture doesn't fit in the .uexp inline budget.
    const exports: UExportProperties[] = []
    let uexpBytes: Uint8Array | null = null
    let ubulkBytes: Uint8Array | null = null
    let uexpError: Error | null = null
    if (root && node.id.toLowerCase().endsWith(".uasset")) {
      const siblingUexpId = node.id.replace(/\.uasset$/i, ".uexp")
      const siblingUbulkId = node.id.replace(/\.uasset$/i, ".ubulk")
      try {
        const uexpNode = await findNodeById(root, siblingUexpId)
        if (uexpNode?.blob) {
          const uexpBlob = await uexpNode.blob()
          uexpBytes = new Uint8Array(await uexpBlob.arrayBuffer())
          for (let i = 0; i < parsed.exports.length; i++) {
            try {
              exports.push(readExportProperties(parsed, uexpBytes, i))
            } catch (err) {
              // Per-export failure shouldn't kill the whole preview;
              // the missing export simply won't appear in the props pane.
              console.warn(`uasset: export ${i} property decode failed:`, err)
            }
          }
        }
        const ubulkNode = await findNodeById(root, siblingUbulkId)
        if (ubulkNode?.blob) {
          const ubulkBlob = await ubulkNode.blob()
          ubulkBytes = new Uint8Array(await ubulkBlob.arrayBuffer())
        }
      } catch (err) {
        uexpError = err instanceof Error ? err : new Error(String(err))
      }
    }
    return {
      kind: "legacy",
      parsed,
      exports,
      uexpError,
      uexpBytes,
      ubulkBytes,
    }
  }, [node.id, root])

  if (loading) return <LoadingFiller label="Decoding .uasset header…" />
  if (error) return <ErrorFiller error={error} />
  if (data!.kind === "zen") {
    return <ZenPackageView parsed={data!.parsed} sourceBytes={data!.sourceBytes} />
  }
  const { parsed: v, exports: decodedExports, uexpError, uexpBytes, ubulkBytes } = data!

  const className = inferAssetClassName(v)
  const isTexture =
    className === "Texture2D" ||
    className === "TextureCube" ||
    className === "TextureRenderTarget2D"
  const isStaticMesh = className === "StaticMesh"
  const isFont = className === "Font"
  const isFontFace = className === "FontFace"
  const isSoundWave = className === "SoundWave"
  const ueVersionLabel = (() => {
    const lf = v.summary.legacyFileVersion
    if (lf < -7) return `UE5 (legacyFileVersion=${lf})`
    if (lf === -7) return `UE 4.20+ (legacyFileVersion=${lf})`
    return `UE 4.x (legacyFileVersion=${lf})`
  })()

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="UE asset (header view)" />

        <KvBlock title="Asset">
          <KvRow k="Class" v={className ?? "(unknown)"} />
          <KvRow k="Engine" v={ueVersionLabel} />
          <KvRow k="Folder" v={v.summary.folderName} />
          <KvRow
            k="Header size"
            v={`${formatBytes(v.summary.totalHeaderSize)}${v.summary.totalHeaderSize === node.size ? " (header-only file)" : ""}`}
          />
          <KvRow
            k="Tables"
            v={`${v.names.length} names · ${v.imports.length} imports · ${v.exports.length} exports`}
          />
          <KvRow k="Package GUID" v={v.summary.guid} mono />
          {v.summary.customVersions.length > 0 && (
            <KvRow
              k="Custom versions"
              v={`${v.summary.customVersions.length}`}
            />
          )}
        </KvBlock>

        {isTexture && uexpBytes && (
          <UassetTextureSection
            parsed={v}
            uexpBytes={uexpBytes}
            ubulkBytes={ubulkBytes}
            className={className}
          />
        )}

        {isStaticMesh && uexpBytes && (
          <UassetStaticMeshSection parsed={v} uexpBytes={uexpBytes} root={root} />
        )}

        {isFont && (
          <UassetFontSection parsed={v} root={root} onNavigate={onNavigate} />
        )}

        {isFontFace && (
          <UassetFontFaceSection node={node} parsed={v} uexpBytes={uexpBytes} root={root} />
        )}

        {isSoundWave && uexpBytes && (
          <UassetSoundWaveSection parsed={v} uexpBytes={uexpBytes} />
        )}

        {decodedExports.length > 0 && (
          <UassetPropertiesSection
            parsed={v}
            decodedExports={decodedExports}
          />
        )}
        {uexpError && (
          <Alert variant="destructive">
            <AlertTitle>Could not load .uexp sibling</AlertTitle>
            <AlertDescription>
              {uexpError.message}
            </AlertDescription>
          </Alert>
        )}

        <UassetExportsTable parsed={v} />
        <UassetImportsTable parsed={v} />
        <UassetNamesTable parsed={v} />

        {v.softPackageReferences.length > 0 && (
          <UassetSoftRefsTable refs={v.softPackageReferences} />
        )}
      </div>
    </ScrollArea>
  )
}

/**
 * Convert a decoded `UProperty[]` array into a plain JSON-shaped tree
 * suitable for `<JsonInspector>`.
 *
 * The shape is intentionally lossy:
 *   - Wrapper types like `{kind:'struct', native: {...}}` collapse to
 *     just the inner native struct fields.
 *   - Generic structs collapse to `{[propName]: simplifyValue(prop), ...}`.
 *   - Arrays / sets become JS arrays.
 *   - Maps become arrays of `[key, value]` pairs (since plain JS objects
 *     can't represent non-string keys).
 *   - Object references become a string like `"-> Texture2D'/Game/UI/T_Foo'"`.
 *   - Unknown values become `<unknown: NN bytes (reason)>`.
 *
 * The goal is at-a-glance readability in the inspector; consumers that
 * need the full UE typing (e.g. an asset extractor) should consume the
 * raw `UProperty` tree directly.
 */
function propertiesToInspectable(properties: UProperty[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const prop of properties) {
    // Static-array properties surface as multiple tags with the same
    // name and arrayIndex 0..N-1. We coalesce them into a JS array.
    const key = prop.name
    const v = simplifyValue(prop.value)
    if (key in out) {
      const existing = out[key]
      if (Array.isArray(existing)) {
        existing.push(v)
      } else {
        out[key] = [existing, v]
      }
    } else {
      out[key] = v
    }
  }
  return out
}

function simplifyValue(v: UValue): unknown {
  switch (v.kind) {
    case "bool":
    case "int8":
    case "int16":
    case "int32":
    case "uint16":
    case "uint32":
    case "float":
    case "double":
    case "name":
    case "string":
    case "text":
      return v.value
    case "int64":
    case "uint64":
      return v.value.toString()
    case "object":
      return v.resolved === "None" ? null : `→ ${v.resolved}`
    case "softObject":
      return v.subPath ? `${v.assetPath}:${v.subPath}` : v.assetPath
    case "enum":
      return v.value
    case "byte":
      return v.enumName ? `${v.enumName}::${v.value}` : v.value
    case "array":
    case "set":
      return v.values.map(simplifyValue)
    case "map":
      return v.entries.map((e) => [simplifyValue(e.key), simplifyValue(e.value)])
    case "struct":
      if (v.native) return simplifyNativeStruct(v.native)
      if (v.properties) return propertiesToInspectable(v.properties)
      if (v.rawBytes) {
        return `<${v.structName}: ${v.rawBytes.length} raw bytes>`
      }
      return `<${v.structName}>`
    case "unknown":
      return `<unknown: ${v.rawBytes.length} bytes (${v.reason})>`
  }
}

function simplifyNativeStruct(s: NativeStruct): unknown {
  switch (s.kind) {
    case "Vector":
      return { x: s.x, y: s.y, z: s.z }
    case "Vector2D":
      return { x: s.x, y: s.y }
    case "Vector4":
    case "Plane":
      return { x: s.x, y: s.y, z: s.z, w: s.w }
    case "IntPoint":
      return { x: s.x, y: s.y }
    case "IntVector":
      return { x: s.x, y: s.y, z: s.z }
    case "Rotator":
      return { pitch: s.pitch, yaw: s.yaw, roll: s.roll }
    case "Quat":
      return { x: s.x, y: s.y, z: s.z, w: s.w }
    case "Color":
      return { r: s.r, g: s.g, b: s.b, a: s.a }
    case "LinearColor":
      return { r: s.r, g: s.g, b: s.b, a: s.a }
    case "Guid":
      return s.value
    case "Box":
      return {
        min: simplifyNativeStruct(s.min),
        max: simplifyNativeStruct(s.max),
        isValid: s.isValid,
      }
    case "Box2D":
      return {
        min: simplifyNativeStruct(s.min),
        max: simplifyNativeStruct(s.max),
        isValid: s.isValid,
      }
    case "Transform":
      return {
        rotation: simplifyNativeStruct(s.rotation),
        translation: simplifyNativeStruct(s.translation),
        scale3D: simplifyNativeStruct(s.scale3D),
      }
    case "RichCurveKey":
      return {
        time: s.time,
        value: s.value,
        interpMode: s.interpMode,
        tangentMode: s.tangentMode,
        tangentWeightMode: s.tangentWeightMode,
        arriveTangent: s.arriveTangent,
        arriveTangentWeight: s.arriveTangentWeight,
        leaveTangent: s.leaveTangent,
        leaveTangentWeight: s.leaveTangentWeight,
      }
    case "SimpleCurveKey":
      return { time: s.time, value: s.value }
  }
}

/**
 * Preview for UE5 IO Store ("Zen Loader") packages.
 *
 * Unlike legacy `.uasset` files there's no magic, no sibling `.uexp`,
 * and no name-table outer chain for imports — instead, package
 * references are CityHash64 hashes against a separate global object
 * table. We don't yet have the global table on hand, so this view
 * focuses on what we CAN decode without it:
 *
 *   - Package name + flags
 *   - Per-export name + class hash + body location/size
 *   - Full name map (everything UE actually serialised)
 *   - Hex view of each export's body bytes, for users who want to
 *     navigate the encoded property data manually.
 *
 * Decoding the property body itself (unversioned property bitmap +
 * field-path-encoded values) is its own multi-hundred-LOC project
 * and is the next layer we'll build.
 */
function ZenPackageView({
  parsed,
  sourceBytes,
}: {
  parsed: ParsedZenPackage
  sourceBytes: Uint8Array
}) {
  const flagLabels = useMemo(() => {
    const flags: string[] = []
    const f = parsed.summary.packageFlags
    if (f & 0x80000000) flags.push("FilterEditorOnly")
    if (f & 0x00002000) flags.push("UsesUnversionedProperties")
    if (f & 0x00000001) flags.push("NewlyCreated")
    if (f & 0x00000002) flags.push("ClientOptional")
    if (f & 0x00000004) flags.push("ServerSideOnly")
    if (f & 0x00000008) flags.push("CompiledIn")
    if (f & 0x00000010) flags.push("ForDiffing")
    if (f & 0x00000040) flags.push("ContainsMap")
    if (flags.length === 0) flags.push("(none)")
    return flags
  }, [parsed.summary.packageFlags])

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="UE5 Zen Package (IO Store cooked)" />

        <KvBlock title="Package">
          <KvRow k="Name" v={parsed.summary.name} />
          <KvRow k="Format" v={parsed.summary.variant === "legacy" ? "Legacy (UE 4.26 – 5.0)" : "FZenPackageSummary (UE 5.1+)"} />
          <KvRow k="Header size" v={`${formatBytes(parsed.summary.headerSize)}`} />
          <KvRow
            k="Tables"
            v={`${parsed.names.length} names · ${parsed.imports.length} imports · ${parsed.exports.length} exports`}
          />
          <KvRow
            k="Package flags"
            v={`0x${parsed.summary.packageFlags.toString(16)} (${flagLabels.join(", ")})`}
          />
        </KvBlock>

        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Zen package: partial decode</AlertTitle>
          <AlertDescription>
            The header, name map, import map, and export map decode cleanly.
            Property body decoding for unversioned UE5 packages (the bytes after
            each export's header) is not yet implemented — those tags need a
            global class schema we don't have access to. The raw bytes are
            available in the per-export hex view below.
          </AlertDescription>
        </Alert>

        <ZenExportsSection parsed={parsed} sourceBytes={sourceBytes} />
        <ZenImportsSection parsed={parsed} />
        <ZenNamesSection parsed={parsed} />
      </div>
    </ScrollArea>
  )
}

function ZenExportsSection({
  parsed,
  sourceBytes,
}: {
  parsed: ParsedZenPackage
  sourceBytes: Uint8Array
}) {
  if (parsed.exports.length === 0) return null
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Exports ({parsed.exports.length})
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="min-w-full text-xs">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Body offset</th>
              <th className="px-3 py-2 font-medium">Body size</th>
              <th className="px-3 py-2 font-medium">Object flags</th>
            </tr>
          </thead>
          <tbody>
            {parsed.exports.map((exp, i) => (
              <tr key={i} className="border-t font-mono [&:hover]:bg-accent/40">
                <td className="px-3 py-1.5 text-muted-foreground">{i}</td>
                <td className="px-3 py-1.5">{exp.objectName}</td>
                <td className="px-3 py-1.5 text-xs">
                  {exp.classIndex.type === "ScriptImport"
                    ? `Script(0x${exp.classIndex.scriptImportHash!.toString(16)})`
                    : exp.classIndex.type}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  0x{exp.bodyOffset.toString(16)}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {formatBytes(exp.cookedSerialSize)}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  0x{exp.objectFlags.toString(16)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Export bodies live at the listed offsets within this file. Hex view
        below shows the first 256 bytes of each.
      </p>
      <div className="mt-2 flex flex-col gap-3">
        {parsed.exports.map((exp, i) => (
          <details key={i} className="rounded-md border bg-card p-3 text-xs">
            <summary className="cursor-pointer font-medium">
              Export {i}: {exp.objectName} — first 256 bytes
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
              {formatHexDump(
                sourceBytes.subarray(
                  exp.bodyOffset,
                  Math.min(exp.bodyOffset + 256, exp.bodyOffset + exp.cookedSerialSize),
                ),
                exp.bodyOffset,
              )}
            </pre>
          </details>
        ))}
      </div>
    </section>
  )
}

function ZenImportsSection({ parsed }: { parsed: ParsedZenPackage }) {
  if (parsed.imports.length === 0) return null
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Imports ({parsed.imports.length})
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="min-w-full text-xs">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Hash / reference</th>
            </tr>
          </thead>
          <tbody>
            {parsed.imports.map((imp, i) => (
              <tr key={i} className="border-t font-mono [&:hover]:bg-accent/40">
                <td className="px-3 py-1.5 text-muted-foreground">{i}</td>
                <td className="px-3 py-1.5">{imp.type}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {imp.type === "ScriptImport"
                    ? `0x${imp.scriptImportHash!.toString(16)}`
                    : imp.type === "PackageImport"
                      ? `pkg=${imp.packageImportRef!.importedPackageIndex} hashIdx=${imp.packageImportRef!.importedPublicExportHashIndex}`
                      : imp.type === "Export"
                        ? `export[${imp.exportIndex}]`
                        : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ZenNamesSection({ parsed }: { parsed: ParsedZenPackage }) {
  if (parsed.names.length === 0) return null
  const NAMES_LIMIT = 200
  const truncated = parsed.names.length > NAMES_LIMIT
  const visible = parsed.names.slice(0, NAMES_LIMIT)
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Names ({parsed.names.length})
      </h3>
      <div className="rounded-md border bg-card p-3">
        <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 md:grid-cols-3">
          {visible.map((n, i) => (
            <li key={i} className="font-mono text-xs text-foreground">
              <span className="text-muted-foreground">{i.toString().padStart(3, "·")}.</span>{" "}
              {n}
            </li>
          ))}
        </ul>
        {truncated && (
          <div className="mt-2 text-xs text-muted-foreground">
            … {parsed.names.length - NAMES_LIMIT} more name
            {parsed.names.length - NAMES_LIMIT === 1 ? "" : "s"} (table display
            capped at {NAMES_LIMIT})
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Pretty-print `bytes` as a hex+ASCII dump similar to `xxd`. `base`
 * is the absolute file offset of `bytes[0]`, used to anchor the
 * left-column labels.
 */
function formatHexDump(bytes: Uint8Array, base: number): string {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, bytes.length))
    const hex = Array.from(row)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
    const asc = Array.from(row)
      .map((b) => (b >= 0x20 && b < 0x7e ? String.fromCharCode(b) : "."))
      .join("")
    lines.push(
      `${(base + i).toString(16).padStart(6, "0")}  ${hex.padEnd(48)}  ${asc}`,
    )
  }
  return lines.join("\n")
}

/**
 * Renders the decoded property tree(s) for each export with property
 * data. For a single-export asset (the common case) we elide the
 * outer wrapper so the user lands directly in the property keys.
 */
function UassetPropertiesSection({
  parsed,
  decodedExports,
}: {
  parsed: ParsedUasset
  decodedExports: UExportProperties[]
}) {
  const single = decodedExports.length === 1
  const treeData = useMemo(() => {
    if (single) {
      return propertiesToInspectable(decodedExports[0]!.properties)
    }
    const out: Record<string, unknown> = {}
    for (const e of decodedExports) {
      const name = resolveFName(e.export.objectName, parsed.names)
      out[name] = propertiesToInspectable(e.properties)
    }
    return out
  }, [decodedExports, parsed.names, single])

  // Compute which exports had tail bytes (asset-class-specific data
  // we deliberately don't decode at this layer).
  const tailNotes = useMemo(() => {
    return decodedExports
      .filter((e) => e.tail.length > 4) // 4-byte end-of-package magic is normal
      .map((e) => ({
        name: resolveFName(e.export.objectName, parsed.names),
        bytes: e.tail.length,
      }))
  }, [decodedExports, parsed.names])

  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Properties
      </h3>
      <div className="rounded-md border bg-card p-3">
        <JsonInspector data={treeData} expandLevel={2} />
      </div>
      {tailNotes.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {tailNotes
            .map((t) => `${t.name}: ${formatBytes(t.bytes)} of class-specific data follows the property tags`)
            .join(" · ")}
        </p>
      )}
    </section>
  )
}

/**
 * Texture2D / TextureCube preview: parses the FTexturePlatformData
 * blob in the .uexp tail, picks the largest available mip, and
 * decodes it to RGBA8 via the pixel-format-specific decoder
 * (`~/lib/uasset-texture`).
 *
 * For cubemaps we render the 6 faces stacked vertically — the
 * cubemap-to-equirect projection is its own project. Stacking
 * preserves all the data; users can verify each face individually.
 */
function UassetTextureSection({
  parsed,
  uexpBytes,
  ubulkBytes,
  className,
}: {
  parsed: ParsedUasset
  uexpBytes: Uint8Array
  ubulkBytes: Uint8Array | null
  className: string | null
}) {
  // Parse the platform-data section once and pick a mip to render.
  const tpdState = useMemo(() => {
    try {
      return {
        ok: true as const,
        tpd: parseTexturePlatformData(parsed, uexpBytes, 0),
      }
    } catch (err) {
      return { ok: false as const, error: err as Error }
    }
  }, [parsed, uexpBytes])

  // Which mip to render. Default to the largest available (mip[0]).
  const [selectedMipIdx, setSelectedMipIdx] = useState(0)

  const decodeState = useAsync(async () => {
    if (!tpdState.ok) return null
    const mip = tpdState.tpd.mips[selectedMipIdx]
    if (!mip) return null
    const bytes = getMipBytes(mip, ubulkBytes)
    if (!bytes) {
      throw new Error(
        `Mip ${selectedMipIdx} (${mip.width}×${mip.height}) needs .ubulk data but no .ubulk sibling was found.`,
      )
    }
    // For cubemaps the stored width × height covers ALL 6 faces stacked.
    // Decode the full block and present them stacked vertically.
    return await decodeUeMip(
      tpdState.tpd.pixelFormat,
      mip.width,
      mip.height * Math.max(1, mip.depth) * (tpdState.tpd.isCube ? 6 : 1),
      bytes,
    )
  }, [tpdState, selectedMipIdx, ubulkBytes])

  if (!tpdState.ok) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
        <p className="text-sm font-medium">Could not parse texture platform data</p>
        <p className="text-xs text-muted-foreground">{tpdState.error.message}</p>
      </section>
    )
  }

  const tpd = tpdState.tpd
  const mip = tpd.mips[selectedMipIdx]
  const pixelFormatDesc = describePixelFormat(tpd.pixelFormat)

  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Texture
      </h3>
      <KvBlock title={className ?? "Texture"}>
        <KvRow k="Format" v={`${tpd.pixelFormat} — ${pixelFormatDesc}`} />
        <KvRow
          k="Authored"
          v={`${tpd.importedWidth} × ${tpd.importedHeight}${tpd.isCube ? " (cubemap, 6 faces)" : ""}${tpd.numSlices > 1 && !tpd.isCube ? ` (${tpd.numSlices} slices)` : ""}`}
        />
        <KvRow
          k="Mips"
          v={`${tpd.mips.length} stored (first cooked: ${tpd.firstMipToSerialize})`}
        />
      </KvBlock>

      <div className="mt-3 flex flex-col gap-3 rounded-md border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Mip</span>
          <select
            className="rounded border bg-background px-2 py-1 font-mono"
            value={selectedMipIdx}
            onChange={(e) => setSelectedMipIdx(Number(e.target.value))}
          >
            {tpd.mips.map((m, i) => (
              <option key={i} value={i}>
                {i}: {m.width}×{m.height}
                {m.depth > 1 ? `×${m.depth}` : ""} ({m.location})
              </option>
            ))}
          </select>
          {mip && (
            <span className="text-muted-foreground">
              {formatBytes(mip.dataSize)} encoded
              {mip.location === "ubulk" && !ubulkBytes && " · .ubulk missing"}
            </span>
          )}
        </div>

        <UassetTextureCanvas
          decodeState={decodeState}
          tpd={tpd}
          mip={mip}
        />
      </div>
    </section>
  )
}

/**
 * Canvas surface for the decoded mip. We paint the pixels straight
 * into an `ImageData` and let the browser scale via CSS — keeps the
 * pixel-perfect rendering even when displaying small mips.
 */
function UassetTextureCanvas({
  decodeState,
  tpd,
  mip,
}: {
  decodeState: ReturnType<typeof useAsync<DecodedMipState>>
  tpd: ParsedTexturePlatformData
  mip: TextureMip | undefined
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (!decodeState.data) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = decodeState.data.width
    canvas.height = decodeState.data.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Construct ImageData via a fresh-buffer copy. We could share
    // the backing storage with the decoder's Uint8Array but the
    // ImageData constructor's overloads insist on an `ArrayBuffer`
    // (not `ArrayBufferLike`); copying sidesteps the type dance
    // and keeps the canvas decoupled from the decoder's lifecycle.
    const clamped = new Uint8ClampedArray(decodeState.data.pixels)
    const imageData = new ImageData(
      clamped,
      decodeState.data.width,
      decodeState.data.height,
    )
    ctx.putImageData(imageData, 0, 0)
  }, [decodeState.data])

  if (decodeState.loading) {
    return <LoadingFiller label={`Decoding ${tpd.pixelFormat}…`} />
  }
  if (decodeState.error) {
    const unsupported = decodeState.error instanceof UnsupportedPixelFormatError
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
        <p className="text-sm font-medium">
          {unsupported ? "Browser preview not supported" : "Texture decode failed"}
        </p>
        <p className="text-xs text-muted-foreground">{decodeState.error.message}</p>
      </section>
    )
  }
  if (!decodeState.data || !mip) return null

  // Use checkerboard background so transparent textures are visible.
  // Cap CSS display to a reasonable size so 4k mips don't dominate the page.
  return (
    <div className="flex items-center justify-center rounded-md bg-[linear-gradient(45deg,#ccc_25%,transparent_25%),linear-gradient(-45deg,#ccc_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#ccc_75%),linear-gradient(-45deg,transparent_75%,#ccc_75%)] bg-[length:16px_16px] bg-[position:0_0,0_8px,8px_-8px,-8px_0]">
      <canvas
        ref={canvasRef}
        className="max-h-[600px] max-w-full"
        style={{
          imageRendering: decodeState.data.width < 256 ? "pixelated" : "auto",
        }}
      />
    </div>
  )
}

interface DecodedMipState {
  width: number
  height: number
  pixels: Uint8Array
}

/**
 * StaticMesh preview: parse the FStaticMeshRenderData blob from the
 * .uexp tail, render LOD 0 in a Three.js viewer. The viewer itself
 * handles LOD switching, wireframe toggle, etc. — this wrapper just
 * does the parse and surfaces a clear error if the data doesn't
 * decode (rare in practice, but useful to know when it happens).
 */
function UassetStaticMeshSection({
  parsed,
  uexpBytes,
  root,
}: {
  parsed: ParsedUasset
  uexpBytes: Uint8Array
  root: Node | null
}) {
  // 1. Parse the cooked geometry (sync; ~ms even for 50k-vert meshes).
  const meshState = useMemo<
    | { ok: true; mesh: LoadedStaticMesh; exportIdx: number }
    | { ok: false; error: Error }
  >(() => {
    try {
      let exportIdx = -1
      for (let i = 0; i < parsed.exports.length; i++) {
        const exp = parsed.exports[i]
        if (exp.classIndex >= 0) continue
        const imp = parsed.imports[-exp.classIndex - 1]
        if (!imp) continue
        const className = parsed.names[imp.objectName.nameIndex]?.value
        if (className === "StaticMesh") {
          exportIdx = i
          break
        }
      }
      if (exportIdx < 0) {
        throw new Error("No StaticMesh export found in this .uasset")
      }
      const mesh = parseStaticMesh(parsed, uexpBytes, exportIdx)
      if (mesh.lods.length === 0) {
        throw new Error("StaticMesh has no LODs (all were stripped or non-inline)")
      }
      return { ok: true as const, mesh, exportIdx }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err : new Error(String(err)),
      }
    }
  }, [parsed, uexpBytes])

  // 2. Walk the StaticMaterials → MaterialInstance → Texture2D chain
  //    for every material slot in parallel. Cache the resolver across
  //    re-renders of this component instance so repeat lookups stay
  //    snappy when the user toggles wireframe / LOD.
  const resolver = useMemo(() => createAssetResolver(root), [root])
  const texturesState = useAsync<Array<DecodedTexture | null>>(async () => {
    if (!meshState.ok) return []
    // Re-read the StaticMesh property block to pull the StaticMaterials
    // array out as raw decoded properties — that's what the chain
    // helper consumes.
    const { properties } = readExportProperties(
      parsed,
      uexpBytes,
      meshState.exportIdx,
    )
    const staticMaterialsProp = properties.find((p) => p.name === "StaticMaterials")
    if (!staticMaterialsProp || staticMaterialsProp.value.kind !== "array") return []
    const materialPaths = extractMaterialPathsFromProperties(
      staticMaterialsProp.value.values,
      parsed,
    )
    const sets = await resolveMaterialTextures(materialPaths, resolver)
    return sets.map((set) => (set ? pickDiffuseTexture(set) : null))
  }, [meshState, parsed, uexpBytes, resolver])

  if (!meshState.ok) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
        <p className="text-sm font-medium">Could not decode StaticMesh geometry</p>
        <p className="text-xs text-muted-foreground">{meshState.error.message}</p>
      </section>
    )
  }
  const { mesh } = meshState
  const lod0 = mesh.lods[0]!
  const textures = texturesState.data ?? null
  const texturesResolved = textures?.filter((t) => t).length ?? 0
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Mesh
      </h3>
      <KvBlock title="StaticMesh">
        <KvRow
          k="LOD 0"
          v={`${lod0.numVertices.toLocaleString()} vertices · ${(lod0.indices.length / 3).toLocaleString()} triangles`}
        />
        <KvRow k="LODs available" v={`${mesh.lods.length}`} />
        <KvRow k="Sections" v={`${lod0.sections.length}`} />
        {mesh.materialSlotNames.length > 0 && (
          <KvRow k="Materials" v={mesh.materialSlotNames.join(", ")} />
        )}
        {textures && (
          <KvRow
            k="Textures"
            v={
              texturesResolved === 0
                ? "(none resolved)"
                : `${texturesResolved} of ${textures.length} material${textures.length === 1 ? "" : "s"} textured`
            }
          />
        )}
        {mesh.bounds && (
          <KvRow
            k="Bounds"
            v={`origin (${mesh.bounds.originX.toFixed(1)}, ${mesh.bounds.originY.toFixed(1)}, ${mesh.bounds.originZ.toFixed(1)}) · radius ${mesh.bounds.sphereRadius.toFixed(1)}`}
          />
        )}
      </KvBlock>
      <div className="mt-3 h-[500px]">
        <StaticMeshViewer
          mesh={mesh}
          materialDiffuseTextures={textures ?? undefined}
        />
      </div>
    </section>
  )
}

/**
 * Live preview of a `UFontFace` asset — the actual font payload
 * (TTF/OTF) that a `UFont` references. Two source layouts are
 * supported:
 *
 *   - **Inline**: the bytes live in the .uexp's post-property tail
 *     (`u32 bSerializeGuid + opt FGuid + u32 bLoadInlineData=1 +
 *     i32 size + bytes`). Older / smaller fonts.
 *   - **Streamed / LazyLoad**: the bytes live in a sibling
 *     `<name>.ufont` file that the cooker emits next to the
 *     .uasset. Modern default for fonts above an inline-size
 *     threshold.
 *
 * Both paths hand the resulting bytes to the existing FontPreview
 * component for rendering.
 */
function UassetFontFaceSection({
  node,
  parsed,
  uexpBytes,
  root,
}: {
  node: Node
  parsed: ParsedUasset
  uexpBytes: Uint8Array | null
  root: Node | null
}) {
  const state = useAsync<
    | { bytes: Uint8Array; sourceLabel: string }
    | { error: string }
  >(async () => {
    // 1. Inline data in the .uexp tail.
    if (uexpBytes) {
      try {
        const inline = readFontFaceInlineData(parsed, uexpBytes)
        if (inline && inline.length > 0) {
          return { bytes: inline, sourceLabel: "inline (.uexp)" }
        }
      } catch {
        // Fall through to the streamed path.
      }
    }
    // 2. Sibling `.ufont` file alongside this .uasset (same path,
    // different extension). UE's cooker writes this when the font
    // uses LazyLoad or Stream loading policy.
    if (root && /\.uasset$/i.test(node.id)) {
      const ufontId = node.id.replace(/\.uasset$/i, ".ufont")
      const ufontNode = await findNodeById(root, ufontId)
      if (ufontNode?.blob) {
        const blob = await ufontNode.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (bytes.length > 0) {
          return { bytes, sourceLabel: "streamed (.ufont)" }
        }
      }
    }
    return {
      error:
        "Could not find font data: no inline payload in .uexp and no sibling .ufont file alongside the .uasset.",
    }
  }, [parsed, uexpBytes, root, node.id])

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Font face
      </h3>
      {state.loading && <LoadingFiller label="Loading font bytes…" />}
      {state.error && <ErrorFiller error={state.error} />}
      {state.data && "error" in state.data && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Font data not available</AlertTitle>
          <AlertDescription>{state.data.error}</AlertDescription>
        </Alert>
      )}
      {state.data && "bytes" in state.data && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Source: {state.data.sourceLabel}
          </p>
          <FontBytesPreview
            blob={new Blob([state.data.bytes as BlobPart], { type: "font/ttf" })}
            fileName={fontFileName(
              node.name.replace(/\.uasset$/i, ""),
              new Blob([state.data.bytes as BlobPart]),
            )}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Font preview: walks a `UFont` asset's import table for any
 * `FontFace` references, resolves them to sibling `.uasset` files
 * in the archive, extracts the TTF/OTF bytes from each, and hands
 * them to the existing FontPreview component for rendering.
 *
 * UE's font system separates the metadata (UFont) from the actual
 * font bytes (UFontFace). One Font asset can reference multiple
 * FontFace assets (for fallback typefaces); we show every one we
 * can resolve so localised assets with separate Japanese / Latin
 * face references display all of them.
 *
 * If a FontFace doesn't ship with inline data (`LoadingPolicy !=
 * Inline`), the bytes live in a sibling `.ufont` file that the
 * cooker emits next to the `.uasset`. We try that path as a
 * fallback.
 */
function UassetFontSection({
  parsed,
  root,
  onNavigate,
}: {
  parsed: ParsedUasset
  root: Node | null
  onNavigate?: (node: Node) => void
}) {
  const resolver = useMemo(() => createAssetResolver(root), [root])
  const fontFaceRefs = useMemo(() => {
    const refs: { objectName: string; packagePath: string | null }[] = []
    for (let i = 0; i < parsed.imports.length; i++) {
      const imp = parsed.imports[i]!
      const cls = parsed.names[imp.className.nameIndex]?.value
      if (cls !== "FontFace") continue
      const fpkgIdx = -(i + 1)
      refs.push({
        objectName: parsed.names[imp.objectName.nameIndex]?.value ?? "(unknown)",
        packagePath: resolveImportPackagePath(fpkgIdx, parsed.imports, parsed.names),
      })
    }
    return refs
  }, [parsed])

  const state = useAsync<ResolvedFontFace[]>(async () => {
    const out: ResolvedFontFace[] = []
    for (const ref of fontFaceRefs) {
      if (!ref.packagePath) {
        out.push({ ...ref, status: "no-path" })
        continue
      }
      try {
        const resolved = await loadFontFaceBytes(ref.packagePath, resolver)
        out.push({ ...ref, status: "ok", ...resolved })
      } catch (err) {
        // Even when loading bytes fails, try to surface the
        // resolved .uasset Node so the user can still navigate to
        // it from the deep-link.
        const triplet = await resolver.resolve(ref.packagePath).catch(() => null)
        out.push({
          ...ref,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          fontFaceNode: triplet?.uasset ?? null,
        })
      }
    }
    return out
  }, [fontFaceRefs, resolver])

  if (fontFaceRefs.length === 0) {
    return (
      <section className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
        This Font has no FontFace references in its import table. The actual
        glyph data probably lives elsewhere (a `BulkData` table or a separate
        archive); not yet supported.
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Font faces ({fontFaceRefs.length})
      </h3>
      {state.loading && <LoadingFiller label="Resolving FontFace assets…" />}
      {state.error && <ErrorFiller error={state.error} />}
      {state.data?.map((face, i) => (
        <FontFaceCard key={i} face={face} onNavigate={onNavigate} />
      ))}
    </section>
  )
}

interface ResolvedFontFaceBase {
  objectName: string
  packagePath: string | null
}

type ResolvedFontFace =
  | (ResolvedFontFaceBase & {
      status: "ok"
      bytes: Uint8Array
      sourceLabel: string
      fontFaceNode: Node | null
    })
  | (ResolvedFontFaceBase & { status: "no-path" })
  | (ResolvedFontFaceBase & {
      status: "error"
      error: string
      fontFaceNode: Node | null
    })

/**
 * Resolve `/Game/…/T_Foo` to its sibling .uasset/.uexp/.ufont
 * triplet and extract the TTF/OTF bytes.
 *
 * Two cooked layouts are supported:
 *   1. Inline: bytes live in the .uexp tail after a `bSerializeGuid`
 *      pair + 4-byte `bLoadInlineData=1` + length-prefixed
 *      `TArray<uint8>`. Older UE 4.20+ workflow.
 *   2. Streamed / LazyLoad: bytes live in a sibling `.ufont` file
 *      next to the .uasset. The .uasset's SourceFilename property
 *      points at the artist's original path; the .ufont is the
 *      cooker's repacked copy. This is the modern default
 *      ("LazyLoad" is UE 4.25+ for fonts >100KB).
 *
 * We try inline first, then fall back to the sibling .ufont if the
 * `bLoadInlineData` flag was zero or the .uexp had no useful data.
 */
async function loadFontFaceBytes(
  packagePath: string,
  resolver: AssetResolver,
): Promise<{ bytes: Uint8Array; sourceLabel: string; fontFaceNode: Node }> {
  const triplet = await resolver.resolve(packagePath)
  if (!triplet) {
    throw new Error(`FontFace asset not found in archive: ${packagePath}`)
  }
  // Inline data path: the .uexp's tail (post-`None`) carries the
  // raw TTF bytes when `bLoadInlineData != 0`.
  if (triplet.uexp) {
    const aBytes = new Uint8Array(await (await triplet.uasset.blob!()).arrayBuffer())
    const parsed = parseUasset(aBytes)
    const eBytes = new Uint8Array(await (await triplet.uexp.blob!()).arrayBuffer())
    const inlineBytes = readFontFaceInlineData(parsed, eBytes)
    if (inlineBytes && inlineBytes.length > 0) {
      return {
        bytes: inlineBytes,
        sourceLabel: "inline (.uexp)",
        fontFaceNode: triplet.uasset,
      }
    }
  }
  // Streamed/lazy path: sibling `.ufont` file with the same basename.
  if (triplet.ufont) {
    const fontBytes = new Uint8Array(await (await triplet.ufont.blob!()).arrayBuffer())
    if (fontBytes.length > 0) {
      return {
        bytes: fontBytes,
        sourceLabel: "streamed (.ufont)",
        fontFaceNode: triplet.uasset,
      }
    }
  }
  throw new Error(
    "FontFace ships with streaming-policy data but no sibling .ufont file was found in the archive.",
  )
}

/**
 * Read the UFontFace's post-property cooked-data block.
 *
 * Layout (UE 4.20+; matches the canonical `UFontFace::Serialize`):
 *   [property tags ending in `None`]
 *   u32 bSerializeGuid             (UObject::Serialize tail)
 *   if bSerializeGuid: FGuid (16 bytes)
 *   u32 bLoadInlineData
 *   if bLoadInlineData:
 *     i32 NumBytes
 *     u8  Data[NumBytes]
 *
 * Returns the inline data bytes, or null when the asset uses a
 * streaming loading policy.
 */
function readFontFaceInlineData(
  parsed: ParsedUasset,
  uexpBytes: Uint8Array,
): Uint8Array | null {
  if (parsed.exports.length === 0) return null
  let props
  try {
    props = readExportProperties(parsed, uexpBytes, 0)
  } catch {
    return null
  }
  const tail = props.tail
  if (tail.length < 8) return null
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let p = 0
  const bSerializeGuid = dv.getUint32(p, true)
  p += 4
  if (bSerializeGuid) {
    if (tail.length < p + 16) return null
    p += 16
  }
  if (tail.length < p + 4) return null
  const bLoadInlineData = dv.getUint32(p, true)
  p += 4
  if (!bLoadInlineData) return null
  if (tail.length < p + 4) return null
  const numBytes = dv.getInt32(p, true)
  p += 4
  if (numBytes <= 0 || tail.length < p + numBytes) return null
  return tail.subarray(p, p + numBytes).slice()
}

function FontFaceCard({
  face,
  onNavigate,
}: {
  face: ResolvedFontFace
  onNavigate?: (node: Node) => void
}) {
  const blob = useMemo(() => {
    if (face.status !== "ok") return null
    return new Blob([face.bytes as BlobPart], { type: "font/ttf" })
  }, [face])
  const targetNode = face.status === "ok" || face.status === "error" ? face.fontFaceNode : null
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="font-mono text-sm font-medium">{face.objectName}</h4>
        <span className="text-xs text-muted-foreground">
          {face.status === "ok"
            ? `${formatBytes(face.bytes.length)} · ${face.sourceLabel}`
            : face.status === "error"
              ? "load failed"
              : "no archive path"}
        </span>
      </div>
      {face.packagePath && (
        <p className="mb-2 break-all font-mono text-xs">
          {targetNode && onNavigate ? (
            <button
              type="button"
              onClick={() => onNavigate(targetNode)}
              className="text-primary underline-offset-2 hover:underline"
              title="Open this FontFace asset in the tree"
            >
              {face.packagePath} →
            </button>
          ) : (
            <span className="text-muted-foreground">{face.packagePath}</span>
          )}
        </p>
      )}
      {face.status === "error" && (
        <p className="text-xs text-destructive">{face.error}</p>
      )}
      {face.status === "ok" && blob && (
        <FontBytesPreview
          blob={blob}
          fileName={fontFileName(face.objectName, blob)}
        />
      )}
    </div>
  )
}

/**
 * Pick a sensible download filename for an extracted FontFace
 * payload. We strip any existing TTF/OTF/UFONT extension off the
 * object name (FontFace object names usually don't have one, but
 * we're defensive) and append `.otf` if the bytes start with the
 * OpenType/CFF magic, else `.ttf`. UE's font cooker can emit
 * either format and the bytes are otherwise indistinguishable
 * without parsing the sfnt directory — but for the filename it's
 * worth at least getting the suffix right when we cheaply can.
 */
function fontFileName(objectName: string, _blob: Blob): string {
  const base = objectName.replace(/\.(ttf|otf|ufont)$/i, "")
  // We pass `_blob` for future detection (sniff first 4 bytes for
  // `OTTO` magic) but defer that to avoid an async filename derive
  // in the hot render path. `.ttf` is the right default for the
  // overwhelming majority of UE-cooked fonts.
  return `${base}.ttf`
}

/**
 * Render a Blob containing TTF/OTF bytes via the existing
 * `FontPreview` pipeline — same code path that previews standalone
 * .ttf/.otf files. We construct a synthetic in-memory Node so the
 * preview component can use its normal `node.blob!()` flow.
 */
function FontBytesPreview({
  blob,
  fileName = "extracted.ttf",
}: {
  blob: Blob
  /**
   * Filename to use for the synthetic Node's download. Should end
   * in `.ttf` / `.otf`; we use the FontFace's object name (e.g.
   * `WoodsScript.ttf`) when invoked from a UFont chain so users
   * get a sensibly-named font file on disk.
   */
  fileName?: string
}) {
  const node = useMemo<Node>(
    () => ({
      id: `font-bytes:${blob.size}:${Math.random().toString(36).slice(2)}`,
      name: fileName,
      kind: "file",
      isContainer: false,
      size: blob.size,
      blob: async () => blob,
    }),
    [blob, fileName],
  )
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      {/* Synthetic header mirroring `PreviewHeader` so the extracted
          font behaves like a first-class file: filename, byte count,
          and a real Download button that writes the raw TTF/OTF to
          disk. Without this the user could see the Font Book-style
          preview but had no way to save the bytes. */}
      <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-heading text-sm font-medium">
            {fileName}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatBytes(blob.size)}
          </div>
        </div>
        <DownloadButton blobFn={async () => blob} fileName={fileName} />
      </div>
      <FontPreview node={node} />
    </div>
  )
}

/**
 * SoundWave preview: surfaces the audio metadata from property tags
 * (channels / sample rate / duration / total samples) and the per-
 * platform format identifier from the cooked FFormatContainer.
 *
 * Switch UE5 builds typically wrap their audio in a Switch-specific
 * cooked format (often labeled `SWITCH_AUDIO00000000` in the format
 * container) that isn't a known public RIFF/WAVE/Ogg/Opus container.
 * Without an upstream decoder we can extract the metadata, surface
 * the format identifier, and offer the raw compressed payload as a
 * download for offline decoding (vgmstream, ffmpeg with appropriate
 * patches, etc.). Inline browser playback isn't yet implemented.
 */
function UassetSoundWaveSection({
  parsed,
  uexpBytes,
}: {
  parsed: ParsedUasset
  uexpBytes: Uint8Array
}) {
  const decoded = useMemo(() => {
    if (parsed.exports.length === 0) return null
    try {
      return readSoundWaveCookedData(parsed, uexpBytes)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } as const
    }
  }, [parsed, uexpBytes])

  if (!decoded) {
    return (
      <section className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
        SoundWave has no exports to decode.
      </section>
    )
  }
  if ("error" in decoded) {
    return (
      <section className="rounded-md border bg-card p-4">
        <p className="text-sm font-medium">Could not read SoundWave cooked data</p>
        <p className="mt-1 text-xs text-muted-foreground">{decoded.error}</p>
      </section>
    )
  }

  const downloadName = `${decoded.formatName.toLowerCase().replace(/[^a-z0-9]/g, "_")}.bin`
  const downloadHref = useMemo(() => {
    if (!decoded.payload) return null
    const blob = new Blob([decoded.payload as BlobPart])
    return URL.createObjectURL(blob)
  }, [decoded.payload])
  useEffect(() => {
    return () => {
      if (downloadHref) URL.revokeObjectURL(downloadHref)
    }
  }, [downloadHref])

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        SoundWave
      </h3>
      <KvBlock title="Audio">
        <KvRow k="Format" v={decoded.formatName} />
        {decoded.properties.numChannels !== undefined && (
          <KvRow
            k="Channels"
            v={`${decoded.properties.numChannels}${decoded.properties.numChannels === 1 ? " (mono)" : decoded.properties.numChannels === 2 ? " (stereo)" : ""}`}
          />
        )}
        {decoded.properties.sampleRate !== undefined && (
          <KvRow k="Sample rate" v={`${decoded.properties.sampleRate} Hz`} />
        )}
        {decoded.properties.duration !== undefined && (
          <KvRow k="Duration" v={`${decoded.properties.duration.toFixed(3)} s`} />
        )}
        {decoded.properties.totalSamples !== undefined && (
          <KvRow
            k="Total samples"
            v={decoded.properties.totalSamples.toLocaleString()}
          />
        )}
        <KvRow k="Cooked payload" v={formatBytes(decoded.payload.length)} />
      </KvBlock>

      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Switch-cooked audio: playback not yet supported</AlertTitle>
        <AlertDescription>
          This SoundWave uses the <code className="font-mono">{decoded.formatName}</code>{" "}
          platform-specific codec, which isn&rsquo;t a standard RIFF / Ogg / Opus
          container. The metadata above is decoded from the property tags;
          the raw compressed payload is available for offline decoding via
          tools like{" "}
          <a
            href="https://github.com/vgmstream/vgmstream"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            vgmstream
          </a>
          .
        </AlertDescription>
      </Alert>

      {downloadHref && (
        <div>
          <a
            href={downloadHref}
            download={downloadName}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <DownloadIcon className="size-4" />
            Download raw {decoded.formatName} payload ({formatBytes(decoded.payload.length)})
          </a>
        </div>
      )}
    </section>
  )
}

interface SoundWaveCookedData {
  properties: {
    numChannels?: number
    sampleRate?: number
    duration?: number
    totalSamples?: number
  }
  formatName: string
  payload: Uint8Array
}

/**
 * Walk the property tags + `USoundWave::Serialize` tail (UE 4.20+):
 *
 *   property tags ending in `None`
 *   u32 bSerializeGuid + optional FGuid
 *   u32 bCooked = 1
 *   TArray<FSoundFormatData> CompressedFormatData:
 *     i32 count
 *     per entry:
 *       FName FormatName             (e.g. SWITCH_AUDIO00000000)
 *       FByteBulkData PayloadHeader  (flags + i32 size + i32 size2 + i64 offset)
 *       payload bytes (when ForceInlinePayload flag set)
 *   FGuid CompressedDataGuid
 *
 * Returns the first CompressedFormatData entry's name + payload —
 * Switch builds typically have just one entry.
 */
function readSoundWaveCookedData(
  parsed: ParsedUasset,
  uexpBytes: Uint8Array,
): SoundWaveCookedData {
  // Pull primitive metadata properties first (these are
  // version-independent and decode cleanly via the standard tag stream).
  const props = readExportProperties(parsed, uexpBytes, 0)
  const properties: SoundWaveCookedData["properties"] = {}
  for (const p of props.properties) {
    if (p.value.kind === "int32" && p.name === "NumChannels") {
      properties.numChannels = p.value.value
    } else if (p.value.kind === "int32" && p.name === "SampleRate") {
      properties.sampleRate = p.value.value
    } else if (p.value.kind === "float" && p.name === "Duration") {
      properties.duration = p.value.value
    } else if (p.value.kind === "float" && p.name === "TotalSamples") {
      properties.totalSamples = p.value.value
    } else if (p.value.kind === "int32" && p.name === "TotalSamples") {
      properties.totalSamples = p.value.value
    }
  }

  const tail = props.tail
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let p = 0
  // bSerializeGuid + optional FGuid (UObject::Serialize tail)
  if (tail.length < p + 4) {
    throw new Error("Truncated USoundWave tail before bSerializeGuid")
  }
  const bSerializeGuid = dv.getUint32(p, true)
  p += 4
  if (bSerializeGuid) {
    if (tail.length < p + 16) throw new Error("Truncated FGuid")
    p += 16
  }
  // u32 bCooked
  if (tail.length < p + 4) throw new Error("Truncated bCooked")
  const bCooked = dv.getUint32(p, true)
  p += 4
  if (!bCooked) {
    throw new Error("USoundWave is not cooked (raw RawData stream not supported by this preview)")
  }
  // CompressedFormatData TArray
  if (tail.length < p + 4) throw new Error("Truncated CompressedFormatData count")
  const formatCount = dv.getInt32(p, true)
  p += 4
  if (formatCount < 1) throw new Error("CompressedFormatData is empty")
  // First entry: FName FormatName (2 × u32) + FByteBulkData
  if (tail.length < p + 8) throw new Error("Truncated FormatName")
  const formatNameIdx = dv.getUint32(p, true)
  p += 4
  p += 4 // FormatName.number
  const formatName =
    parsed.names[formatNameIdx]?.value ?? `<bad name ${formatNameIdx}>`
  // FByteBulkData header.
  if (tail.length < p + 4) throw new Error("Truncated bulkFlags")
  const bulkFlags = dv.getUint32(p, true)
  p += 4
  const sized64 = (bulkFlags & 0x2000) !== 0
  let dataSize: number
  if (sized64) {
    if (tail.length < p + 16) throw new Error("Truncated 64-bit size")
    dataSize = Number(dv.getBigUint64(p, true))
    p += 8
    p += 8 // dataSize2
  } else {
    if (tail.length < p + 8) throw new Error("Truncated 32-bit size")
    dataSize = dv.getInt32(p, true)
    p += 4
    p += 4 // dataSize2
  }
  if (tail.length < p + 8) throw new Error("Truncated bulk offset")
  p += 8 // i64 offset
  const inline = (bulkFlags & 0x40) !== 0
  if (!inline) {
    throw new Error(
      `CompressedFormatData has non-inline payload (flags=0x${bulkFlags.toString(16)}); only inline payloads are read by this preview.`,
    )
  }
  if (tail.length < p + dataSize) {
    throw new Error(
      `Truncated payload: need ${dataSize} bytes, have ${tail.length - p}`,
    )
  }
  const payload = tail.subarray(p, p + dataSize)
  return { properties, formatName, payload }
}

function UassetExportsTable({ parsed }: { parsed: ParsedUasset }) {
  if (parsed.exports.length === 0) return null
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Exports ({parsed.exports.length})
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="min-w-full text-xs">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Outer</th>
              <th className="px-3 py-2 font-medium">Serial offset</th>
              <th className="px-3 py-2 font-medium">Serial size</th>
            </tr>
          </thead>
          <tbody>
            {parsed.exports.map((e, i) => (
              <tr key={i} className="border-t font-mono [&:hover]:bg-accent/40">
                <td className="px-3 py-1.5">
                  {resolveFName(e.objectName, parsed.names)}
                </td>
                <td className="px-3 py-1.5">
                  {resolvePackageIndex(
                    e.classIndex,
                    parsed.imports,
                    parsed.exports,
                    parsed.names,
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {resolvePackageIndex(
                    e.outerIndex,
                    parsed.imports,
                    parsed.exports,
                    parsed.names,
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {e.serialOffset.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {formatBytes(e.serialSize)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function UassetImportsTable({ parsed }: { parsed: ParsedUasset }) {
  if (parsed.imports.length === 0) return null
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Imports ({parsed.imports.length})
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="min-w-full text-xs">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Object</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Package</th>
              <th className="px-3 py-2 font-medium">Outer</th>
            </tr>
          </thead>
          <tbody>
            {parsed.imports.map((imp, i) => (
              <tr key={i} className="border-t font-mono [&:hover]:bg-accent/40">
                <td className="px-3 py-1.5">
                  {resolveFName(imp.objectName, parsed.names)}
                </td>
                <td className="px-3 py-1.5">
                  {resolveFName(imp.className, parsed.names)}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {resolveFName(imp.classPackage, parsed.names)}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {resolvePackageIndex(
                    imp.outerIndex,
                    parsed.imports,
                    parsed.exports,
                    parsed.names,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function UassetNamesTable({ parsed }: { parsed: ParsedUasset }) {
  if (parsed.names.length === 0) return null
  // Names lists are sometimes long (50+ entries); cap the
  // initial render at 200 and let the user scroll.
  const NAMES_LIMIT = 200
  const truncated = parsed.names.length > NAMES_LIMIT
  const visible = parsed.names.slice(0, NAMES_LIMIT)
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Names ({parsed.names.length})
      </h3>
      <div className="rounded-md border bg-card p-3">
        <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 md:grid-cols-3">
          {visible.map((n, i) => (
            <li key={i} className="font-mono text-xs text-foreground">
              <span className="text-muted-foreground">{i.toString().padStart(3, "·")}.</span>{" "}
              {n.value}
            </li>
          ))}
        </ul>
        {truncated && (
          <div className="mt-2 text-xs text-muted-foreground">
            … {parsed.names.length - NAMES_LIMIT} more name
            {parsed.names.length - NAMES_LIMIT === 1 ? "" : "s"} (table
            display capped at {NAMES_LIMIT})
          </div>
        )}
      </div>
    </section>
  )
}

function UassetSoftRefsTable({ refs }: { refs: string[] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Soft package references ({refs.length})
      </h3>
      <ul className="rounded-md border bg-card p-3 font-mono text-xs">
        {refs.map((r, i) => (
          <li key={i} className="px-1 py-0.5">
            {r}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ====================================================================
// BARS — Switch / Wii U audio resource archive
// ====================================================================
//
// BARS is a flat archive of named audio cues — each cue is an
// `(AMTA, FWAV|FSTP)` pair where AMTA carries the human-readable
// track name plus per-track metadata (sample rate, channels, loop
// range) and FWAV / FSTP is the actual audio payload. The
// {@link makeBarsNode} container exposes each cue as an expandable
// child of the BARS file in the tree, so this preview pane is
// strictly the *summary* view shown when the user clicks the BARS
// archive itself: counts, totals, and a top-N table of tracks.

const BARS_TRACK_TABLE_LIMIT = 100

function BarsPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBarsForView(await node.blob!())
  }, [node.id])

  if (loading) return <LoadingFiller label="Decoding BARS…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BARS — Binary Audio Resource System" />

        <KvBlock title="Archive">
          <KvRow k="Tracks" v={String(v.parsed.trackCount)} />
          <KvRow
            k="Audio payloads"
            v={`${v.fwavCount} FWAV · ${v.fstpCount} FSTP · ${v.stubCount} stub (no audio)`}
          />
          <KvRow k="Audio bytes total" v={formatBytes(v.totalAudioBytes)} />
          <KvRow k="File size" v={formatBytes(v.parsed.fileSize)} />
          <KvRow k="Endian" v={v.parsed.endian} />
        </KvBlock>

        <BarsTrackTableSection view={v} />
      </div>
    </ScrollArea>
  )
}

function BarsTrackTableSection({ view }: { view: BarsView }) {
  const { parsed } = view
  const truncated = parsed.entries.length > BARS_TRACK_TABLE_LIMIT
  const rows = truncated
    ? parsed.entries.slice(0, BARS_TRACK_TABLE_LIMIT)
    : parsed.entries
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Tracks {truncated ? `(showing first ${BARS_TRACK_TABLE_LIMIT} of ${parsed.entries.length})` : ""}
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Channels</th>
              <th className="px-3 py-2 font-medium">Loop</th>
              <th className="px-3 py-2 font-medium">Volume</th>
              <th className="px-3 py-2 font-medium">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const data = e.amta.data
              return (
                <tr
                  key={e.index}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">
                    {e.index}
                  </td>
                  <td className="px-3 py-1.5">
                    {e.name || (
                      <span className="text-muted-foreground">(unnamed)</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono">
                    {e.audioKind ?? (
                      <span className="text-muted-foreground">stub</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {data?.channelCount ?? "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {data?.loopFlag
                      ? `${data.loopStart}–${data.loopEnd}`
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {data ? data.volume.toFixed(3) : "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">
                    {e.audioSize > 0 ? formatBytes(e.audioSize) : "—"}
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

// ====================================================================
// BFSAR — Binary caFe Sound ARchive
// ====================================================================
//
// BFSAR (`FSAR` magic) is NintendoWare's master sound archive on the
// Wii U / Switch. It contains seven flavours of items (sounds, sound
// groups, banks, wave archives, groups, players, files); the actual
// audio bytes live in the `FILE` block as standalone BFSTM / BFWAV /
// BFSTP / BFWAR / BFBNK / BFSEQ / BFGRP / BFWSD payloads.
//
// As with BARS, the {@link makeBfsarNode} container already exposes
// each named internal file as a child node in the tree (suffixed
// with the appropriate `.bfstm` / `.bfwav` / etc. extension), so
// this preview is the summary view shown when the user clicks the
// BFSAR file itself.

function BfsarPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBfsarForView(await node.blob!())
  }, [node.id])

  if (loading) return <LoadingFiller label="Decoding BFSAR…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!

  // BFSAR version is encoded as packed BCD: e.g. 0x00020400 → "2.4.0".
  const ver = v.parsed.version
  const versionStr = `${(ver >> 16) & 0xff}.${(ver >> 8) & 0xff}.${ver & 0xff}`

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BFSAR — Binary caFe Sound ARchive" />

        <KvBlock title="Archive">
          <KvRow k="Version" v={versionStr} />
          <KvRow k="Endian" v={v.parsed.endian} />
          <KvRow k="File size" v={formatBytes(v.parsed.fileSize)} />
          <KvRow k="Top-level blocks" v={String(v.parsed.blockCount)} />
          <KvRow
            k="Strings"
            v={`${v.parsed.strings.length} entries`}
          />
        </KvBlock>

        <KvBlock title="Item counts">
          <KvRow k="Sounds" v={String(v.parsed.counts.sounds)} />
          <KvRow k="Sound groups" v={String(v.parsed.counts.soundGroups)} />
          <KvRow k="Banks" v={String(v.parsed.counts.banks)} />
          <KvRow k="Wave archives" v={String(v.parsed.counts.waveArchives)} />
          <KvRow k="Groups" v={String(v.parsed.counts.groups)} />
          <KvRow k="Players" v={String(v.parsed.counts.players)} />
          <KvRow k="Files" v={String(v.parsed.counts.files)} />
        </KvBlock>

        <KvBlock title="File breakdown">
          <KvRow k="Inline (in FILE block)" v={String(v.inlineCount)} />
          <KvRow k="Inside group archives" v={String(v.groupCount)} />
          <KvRow k="External (referenced by path)" v={String(v.parsed.externalFiles.length)} />
          <KvRow
            k="Sound kinds"
            v={`${v.streamCount} stream · ${v.waveCount} wave · ${v.sequenceCount} sequence`}
          />
        </KvBlock>

        <BfsarFileTableSection view={v} />
      </div>
    </ScrollArea>
  )
}

function BfsarFileTableSection({ view }: { view: BfsarView }) {
  const { parsed } = view
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Internal files
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Magic</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Location</th>
              <th className="px-3 py-2 font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            {parsed.internalFiles.map((f) => (
              <tr
                key={f.index}
                className="border-b border-border/40 last:border-0"
              >
                <td className="px-3 py-1.5 font-mono text-muted-foreground">
                  {f.index}
                </td>
                <td className="px-3 py-1.5">{f.name}</td>
                <td className="px-3 py-1.5 font-mono">
                  {f.innerMagic ?? "—"}
                </td>
                <td className="px-3 py-1.5">
                  {f.soundKind ?? f.nameSource}
                </td>
                <td className="px-3 py-1.5">{f.location ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">
                  {f.size > 0 ? formatBytes(f.size) : "—"}
                </td>
              </tr>
            ))}
            {parsed.externalFiles.map((f) => (
              <tr
                key={`ext-${f.index}`}
                className="border-b border-border/40 last:border-0 text-muted-foreground"
              >
                <td className="px-3 py-1.5 font-mono">{f.index}</td>
                <td className="px-3 py-1.5">{f.name}</td>
                <td className="px-3 py-1.5 font-mono">EXT</td>
                <td className="px-3 py-1.5">external</td>
                <td className="px-3 py-1.5 font-mono break-all">{f.path}</td>
                <td className="px-3 py-1.5">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ====================================================================
// BFRES — Nintendo 3D resource container preview
// ====================================================================
//
// Surfaces the metadata tree (header version, models with bone /
// shape / material counts, animation counts per kind, embedded
// BNTX info) as a sidebar. The container itself is browsable in
// the tree (external files, typically `textures.bntx`).

function BfresPreview({
  node,
  root,
}: {
  node: Node
  root?: Node | null
}) {
  const { loading, data, error } = useAsync(async () => {
    return parseBfresForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Decoding BFRES…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  // BFRES files come in two flavours: model containers (numShape > 0
  // somewhere) and pure-animation/data containers. Only mount the 3D
  // viewer for the former — the viewer would render an empty scene
  // and confuse users for the latter.
  const hasModels = v.parsed.models.some((m) => m.numShape > 0)
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BFRES — Nintendo 3D resource container" />
        {hasModels && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              3D viewer
            </h3>
            <BfresViewer node={node} root={root} />
          </section>
        )}
        <KvBlock title="Header">
          <KvRow k="Name" v={v.parsed.name || "(unnamed)"} />
          <KvRow
            k="Version"
            v={`${v.parsed.version.major}.${v.parsed.version.minor}.${v.parsed.version.patch}`}
          />
          <KvRow k="File size" v={formatBytes(v.parsed.fileSize)} />
          <KvRow
            k="Alignment"
            v={`2^${v.parsed.alignmentExponent} = ${1 << v.parsed.alignmentExponent} bytes`}
          />
        </KvBlock>
        <BfresModelsSection view={v} />
        <BfresAnimationsSection view={v} />
        <BfresExternalSection view={v} />
      </div>
    </ScrollArea>
  )
}

function BfresModelsSection({ view }: { view: BfresView }) {
  const models = view.parsed.models
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Models ({models.length})
      </h3>
      {models.length === 0 ? (
        <p className="text-xs text-muted-foreground">No models in this BFRES.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full border-collapse text-xs">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Vertex bufs</th>
                <th className="px-3 py-2 font-medium">Shapes</th>
                <th className="px-3 py-2 font-medium">Materials</th>
                <th className="px-3 py-2 font-medium">Bones</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-1.5">{m.name || "(unnamed)"}</td>
                  <td className="px-3 py-1.5">{m.numVertexBuffer}</td>
                  <td className="px-3 py-1.5">{m.numShape}</td>
                  <td className="px-3 py-1.5">{m.numMaterial}</td>
                  <td className="px-3 py-1.5">{m.numBone || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function BfresAnimationsSection({ view }: { view: BfresView }) {
  const groups = view.parsed.animationGroups
  const total = groups.reduce((sum, g) => sum + g.names.length, 0)
  if (total === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Animations ({total})
      </h3>
      <div className="flex flex-col gap-2">
        {groups
          .filter((g) => g.names.length > 0)
          .map((g) => (
            <div key={g.kind} className="rounded-md border bg-card p-3">
              <div className="text-xs font-medium">
                {g.kind} <span className="text-muted-foreground">({g.magic})</span>
                <span className="ml-2 text-muted-foreground">
                  · {g.names.length}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                {g.names.slice(0, 30).map((n, i) => (
                  <span
                    key={i}
                    className="rounded-md border bg-background px-2 py-0.5 font-mono"
                  >
                    {n}
                  </span>
                ))}
                {g.names.length > 30 && (
                  <span className="text-muted-foreground">
                    …{g.names.length - 30} more
                  </span>
                )}
              </div>
            </div>
          ))}
      </div>
    </section>
  )
}

function BfresExternalSection({ view }: { view: BfresView }) {
  const files = view.parsed.externalFiles
  if (files.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        External files ({files.length})
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Magic</th>
              <th className="px-3 py-2 font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, i) => (
              <tr key={i} className="border-b border-border/40 last:border-0">
                <td className="px-3 py-1.5">{f.name || "(unnamed)"}</td>
                <td className="px-3 py-1.5 font-mono">{f.innerMagic ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">
                  {formatBytes(f.size)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ====================================================================
// BFWAV / BFSTM / BFSTP — playable audio preview
// ====================================================================
//
// Decodes the Nintendo container to PCM16 (via @tootallnate/dsp-adpcm
// + @tootallnate/bfwav / @tootallnate/bfstm), wraps the result in a
// RIFF WAVE blob, and hands the resulting `audio/wav` object URL to
// a plain `<audio>` element. The browser's built-in player handles
// scrub / seek / play-pause / loop without us writing any of that.

function NintendoAudioPreview({
  node,
  kind,
}: {
  node: Node
  kind: "bfwav" | "bfstm"
}) {
  const { loading, data, error } = useAsync(async () => {
    const blob = await node.blob!()
    if (kind === "bfwav") return parseBfwavForAudioView(blob)
    return parseBfstmForAudioView(blob)
  }, [node.id, kind])

  // Object URL for the decoded WAV. Created when `data` arrives,
  // revoked when the node changes. Tracked separately from `data`
  // so React can render the `<audio>` source synchronously.
  const [wavUrl, setWavUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data) return
    const url = URL.createObjectURL(data.wavBlob)
    setWavUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setWavUrl(null)
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding audio…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader
          title={
            v.source === "bfwav"
              ? "BFWAV — Cafe single-shot audio"
              : v.source === "bfstp"
                ? "BFSTP — Cafe prefetch stream"
                : "BFSTM — Cafe streamed audio"
          }
        />

        <NintendoAudioPlayer wavUrl={wavUrl} view={v} />

        <KvBlock title="Audio">
          <KvRow k="Codec" v={v.codecName} />
          <KvRow k="Sample rate" v={`${v.sampleRate} Hz`} />
          <KvRow
            k="Channels"
            v={`${v.numChannels} (${v.numChannels === 1 ? "mono" : v.numChannels === 2 ? "stereo" : `${v.numChannels}-channel`})`}
          />
          <KvRow k="Total samples" v={v.totalSamples.toLocaleString()} />
          <KvRow
            k="Duration"
            v={`${formatDuration(v.durationSeconds)} (${v.durationSeconds.toFixed(2)}s)`}
          />
          <KvRow
            k="Loop"
            v={
              v.loopFlag
                ? `samples [${v.loopStart.toLocaleString()}, ${v.totalSamples.toLocaleString()}]`
                : "no"
            }
          />
        </KvBlock>

        {v.parsed.kind === "bfstm" && (
          <KvBlock title="Stream layout">
            <KvRow
              k="Interleave"
              v={`${v.parsed.data.interleaveBlockCount} blocks × ${v.parsed.data.interleaveBlockSize.toLocaleString()} bytes/channel`}
            />
            <KvRow
              k="Samples per block"
              v={v.parsed.data.samplesPerBlock.toLocaleString()}
            />
            <KvRow
              k="Last block"
              v={`${v.parsed.data.lastBlockSamples.toLocaleString()} samples (${v.parsed.data.lastBlockSizeWithoutPadding} valid bytes / ${v.parsed.data.lastBlockSizeWithPadding} padded)`}
            />
          </KvBlock>
        )}

        {v.parsed.kind === "bfwav" && (
          <KvBlock title="Container">
            <KvRow k="Endian" v={v.parsed.data.endian} />
            <KvRow
              k="Version"
              v={
                "0x" + v.parsed.data.version.toString(16).padStart(8, "0")
              }
            />
            <KvRow k="File size" v={formatBytes(v.parsed.data.fileSize)} />
          </KvBlock>
        )}
      </div>
    </ScrollArea>
  )
}

function NintendoAudioPlayer({
  wavUrl,
  view,
}: {
  wavUrl: string | null
  view: AudioPreviewView
}) {
  const downloadName = useMemo(() => {
    return `${view.source}_${view.numChannels}ch_${view.sampleRate}Hz.wav`
  }, [view])
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      {wavUrl ? (
        <audio
          src={wavUrl}
          controls
          className="w-full"
          preload="auto"
        />
      ) : (
        <Skeleton className="h-12 w-full" />
      )}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Decoded {view.codecName} → 16-bit PCM ({view.numChannels} ch ·{" "}
          {view.sampleRate} Hz · {formatDuration(view.durationSeconds)})
        </span>
        {wavUrl && (
          <a
            href={wavUrl}
            download={downloadName}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .wav
          </a>
        )}
      </div>
    </section>
  )
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—"
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (m === 0) return `${s.toFixed(1)}s`
  const ss = s.toFixed(1).padStart(4, "0")
  return `${m}:${ss}`
}

// ====================================================================
// USM — CRI Sofdec2 video container preview
// ====================================================================
//
// Parses the USM, demuxes its embedded VP9 IVF video stream, and
// remuxes it into a tiny WebM document so the browser's native
// `<video>` element plays it directly. The VP9 bitstream itself
// is not re-encoded — only the surrounding container changes.
// Audio inside USMs is HCA, which browsers don't speak; we list
// audio streams in the metadata table but don't attempt playback
// until we ship an HCA decoder.

interface UsmView {
  /** Full parsed USM (chunks, streams). */
  usm: UsmFile
  /** Selected video stream (currently always the first one). */
  video: UsmVideoStream | null
  /**
   * Non-null when the video stream was successfully remuxed to
   * WebM. Object URL lifetime is managed by `UsmPreview` so
   * the cleanup runs once per node. Still-frame metadata is
   * displayed even when this is null (e.g. unsupported codec).
   */
  webmBlob: Blob | null
  /** Why we couldn't produce a WebM — surfaced inline. */
  remuxError: string | null
}

async function buildUsmView(blob: Blob): Promise<UsmView> {
  const usm = await parseUsm(blob)
  const video = usm.streams.find(
    (s): s is UsmVideoStream => s.type === "video",
  ) ?? null
  if (!video) return { usm, video: null, webmBlob: null, remuxError: null }
  if (video.codec.codec !== "vp9") {
    return {
      usm,
      video,
      webmBlob: null,
      remuxError: `In-browser playback only supports VP9 USMs; this stream is "${video.codec.codec}" (codec id ${video.codec.rawId}).`,
    }
  }
  // Demux IVF → tag keyframes → mux WebM. The VP9 bytes pass
  // through unchanged; only the container envelopes change.
  try {
    const ivf = await demuxIvf(video.data)
    const fps = video.fps || 30
    const frameDurationMs = 1000 / fps
    const frames = ivf.frames.map((f, i) => ({
      data: f.data,
      timestampMs: Math.round(i * frameDurationMs),
      // First frame must be a keyframe per VP9/WebM rules; also
      // honour the bitstream's own keyframe flag thereafter.
      isKeyframe: i === 0 || isVp9Keyframe(f.data),
    }))
    const webmBlob = muxVp9WebmBlob(frames, {
      width: video.width,
      height: video.height,
      frameDurationMs,
      durationMs: frames.length * frameDurationMs,
    })
    return { usm, video, webmBlob, remuxError: null }
  } catch (e) {
    return {
      usm,
      video,
      webmBlob: null,
      remuxError: e instanceof Error ? e.message : String(e),
    }
  }
}

function UsmPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return buildUsmView(await node.blob!())
  }, [node.id])

  // Object URL lifetime tied to the loaded view — recreated each
  // time the user picks a different USM, revoked on unmount.
  const [webmUrl, setWebmUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data?.webmBlob) {
      setWebmUrl(null)
      return
    }
    const url = URL.createObjectURL(data.webmBlob)
    setWebmUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setWebmUrl(null)
    }
  }, [data?.webmBlob])

  if (loading) return <LoadingFiller label="Demuxing USM…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="USM — CRI Sofdec2 video container" />

        {v.video && (
          <UsmPlayer
            video={v.video}
            webmUrl={webmUrl}
            remuxError={v.remuxError}
            sourceName={node.name}
          />
        )}

        <KvBlock title="Container">
          <KvRow k="File size" v={formatBytes(v.usm.fileSize)} />
          <KvRow k="Total chunks" v={v.usm.chunks.length.toLocaleString()} />
          <KvRow
            k="Streams"
            v={`${v.usm.streams.length} (${v.usm.streams.filter((s) => s.type === "video").length} video, ${v.usm.streams.filter((s) => s.type === "audio").length} audio)`}
          />
        </KvBlock>

        {v.video && (
          <KvBlock title="Video">
            <KvRow
              k="Codec"
              v={v.video.codec.codec.toUpperCase()}
              hint={`raw id ${v.video.codec.rawId}`}
            />
            <KvRow
              k="Resolution"
              v={`${v.video.width}×${v.video.height}`}
              hint={
                v.video.displayWidth !== v.video.width ||
                v.video.displayHeight !== v.video.height
                  ? `display ${v.video.displayWidth}×${v.video.displayHeight}`
                  : undefined
              }
            />
            <KvRow k="Frame rate" v={`${v.video.fps.toFixed(2)} fps`} />
            <KvRow k="Frames" v={v.video.totalFrames.toLocaleString()} />
            <KvRow
              k="Duration"
              v={
                v.video.fps > 0
                  ? formatDuration(v.video.totalFrames / v.video.fps)
                  : "—"
              }
            />
            <KvRow k="Stream size" v={formatBytes(v.video.dataSize)} />
          </KvBlock>
        )}

        <UsmStreamsTable streams={v.usm.streams} />
      </div>
    </ScrollArea>
  )
}

function UsmPlayer({
  video,
  webmUrl,
  remuxError,
  sourceName,
}: {
  video: UsmVideoStream
  webmUrl: string | null
  remuxError: string | null
  sourceName: string
}) {
  // `<video.bin>.usm` → `video.bin.webm`. We don't strip extension
  // since some games name files like `movie_007.usm` and the
  // user expects to recognise the stem.
  const downloadName = useMemo(() => {
    const stem = sourceName.replace(/\.usm$/i, "")
    return `${stem}.webm`
  }, [sourceName])
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      {webmUrl ? (
        <video
          src={webmUrl}
          controls
          autoPlay
          className="w-full rounded-md bg-black"
          style={{ aspectRatio: `${video.width} / ${video.height}` }}
        />
      ) : remuxError ? (
        <div className="flex items-center justify-center rounded-md border border-dashed border-destructive/40 bg-destructive/5 p-6 text-center text-sm text-destructive">
          {remuxError}
        </div>
      ) : (
        <Skeleton
          className="w-full"
          style={{ aspectRatio: `${video.width} / ${video.height}` }}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Remuxed VP9 → WebM ({video.width}×{video.height} ·{" "}
          {video.fps.toFixed(2)} fps ·{" "}
          {video.fps > 0
            ? formatDuration(video.totalFrames / video.fps)
            : "—"}
          )
        </span>
        {webmUrl && (
          <a
            href={webmUrl}
            download={downloadName}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .webm
          </a>
        )}
      </div>
    </section>
  )
}

function UsmStreamsTable({ streams }: { streams: UsmStream[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Streams ({streams.length})
      </h3>
      {streams.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No streams in this USM.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full border-collapse text-xs">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Codec</th>
                <th className="px-3 py-2 font-medium">Details</th>
                <th className="px-3 py-2 font-medium text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {streams.map((s, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-1.5 font-mono uppercase">{s.type}</td>
                  <td className="px-3 py-1.5">{s.channel}</td>
                  <td className="px-3 py-1.5 font-mono uppercase">
                    {s.type === "video" ? s.codec.codec : s.codec}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {s.type === "video"
                      ? `${s.width}×${s.height} · ${s.fps.toFixed(2)} fps · ${s.totalFrames.toLocaleString()} frames`
                      : `${s.channelCount} ch · ${s.sampleRate} Hz · ${s.totalSamples.toLocaleString()} samples`}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatBytes(s.dataSize)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ====================================================================
// Unity SerializedFile preview (CAB-… inside a UnityFS bundle)
// ====================================================================
//
// Walks the asset's TypeTree-driven object table and surfaces a
// structured view: header, types, objects, plus format-specific
// previews (font book for TMPro fonts; pixels for Texture2D).

interface UnityAssetView {
  parsed: ParsedSerializedFile
  /** Map of resource-stream basename → Blob, keyed by lowercase path. */
  externalsByName: Map<string, Blob>
  /** Decoded objects for the ones we know how to interpret. */
  decoded: UnityDecodedObject[]
}

interface UnityDecodedObject {
  obj: SerializedObject
  /** Walked-tree value, or `null` if the object lacks a TypeTree. */
  value: unknown
  /** Cached top-level name field if present. */
  name: string | null
}

async function buildUnityAssetView(
  node: Node,
  root: Node | null,
): Promise<UnityAssetView> {
  const blob = await node.blob!()
  const parsed = await parseSerializedFile(blob)
  // Resolve external references — typically a sibling
  // `<basename>.resS` containing texture / audio pixel data
  // referenced via `m_StreamData`. We look up siblings by
  // walking `node`'s parent in the archive tree.
  const externalsByName = await resolveUnityExternals(node, root, parsed)
  // Decode every object whose type ships a TypeTree. Objects
  // without a TypeTree still appear in the table but we don't
  // try to render them.
  const decoded: UnityDecodedObject[] = []
  for (const obj of parsed.objects) {
    const ty = parsed.types[obj.typeIndex]
    if (!ty || !ty.typeTree) {
      decoded.push({ obj, value: null, name: null })
      continue
    }
    try {
      const value = await parseUnityObject(obj, ty.typeTree)
      const name =
        value && typeof value === "object" && "m_Name" in value
          ? String((value as { m_Name?: unknown }).m_Name ?? "") || null
          : null
      decoded.push({ obj, value, name })
    } catch {
      decoded.push({ obj, value: null, name: null })
    }
  }
  return { parsed, externalsByName, decoded }
}

/**
 * Walk to `node`'s parent in the archive tree and pick out
 * sibling Blobs whose names are referenced by the asset's
 * `externals` table. Most relevant in practice for `.resS`
 * resource streams that hold large texture / audio pixel data.
 */
async function resolveUnityExternals(
  node: Node,
  root: Node | null,
  parsed: ParsedSerializedFile,
): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  if (!root) return out
  const slash = node.id.lastIndexOf("/")
  if (slash <= 0) return out
  const parentId = node.id.slice(0, slash)
  // Walk root by id segments to find the parent. (Helper
  // kept inline to avoid a cross-file dependency.)
  const findById = async (n: Node, target: string): Promise<Node | null> => {
    if (n.id === target) return n
    if (!target.startsWith(n.id + "/") && n.id !== "") return null
    let cur: Node = n
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
  const parent = await findById(root, parentId)
  if (!parent || !parent.getChildren) return out
  const siblings =
    parent._children ?? (parent._children = await parent.getChildren())
  // Collect every basename mentioned in the asset (externals
  // table + each object's `m_StreamData.path`). The basenames
  // we care about all live in the same UnityFS bundle, which
  // is `parent` here.
  const wantedBasenames = new Set<string>()
  for (const e of parsed.externals) {
    if (e.basename) wantedBasenames.add(e.basename.toLowerCase())
  }
  // Texture2D objects often reference .resS via m_StreamData
  // even when the externals table doesn't list them — scan
  // sibling names that look like .resS files too.
  for (const k of siblings) {
    if (/\.ress$/i.test(k.name) && k.blob) {
      wantedBasenames.add(k.name.toLowerCase())
    }
  }
  for (const k of siblings) {
    if (k.blob && wantedBasenames.has(k.name.toLowerCase())) {
      try {
        out.set(k.name.toLowerCase(), await k.blob())
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

function UnityAssetPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  const { loading, data, error } = useAsync(async () => {
    return buildUnityAssetView(node, root)
  }, [node.id])
  if (loading) return <LoadingFiller label="Decoding Unity asset…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const tmpFontObj = findTmpFontObject(v.decoded)
  // Per-Font previews now live on the individual `unity-object`
  // children of this CAB node (one font per child) — drilling in
  // gives a dedicated preview for each. We don't stack them here.
  // TMP_FontAsset is still rendered inline because it's a single
  // composite asset (MonoBehaviour + Texture2D + glyph table)
  // whose "book" view doesn't have an obvious one-to-one mapping
  // to a child node yet.
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="Unity asset (SerializedFile)" />

        {tmpFontObj && <TmpFontBookPreview view={v} fontObj={tmpFontObj} />}

        <KvBlock title="Header">
          <KvRow k="Unity version" v={v.parsed.header.unityVersion} />
          <KvRow
            k="Format version"
            v={String(v.parsed.header.version)}
            hint={
              v.parsed.header.version >= 22
                ? "Unity 2020+ layout"
                : "legacy layout"
            }
          />
          <KvRow
            k="Platform"
            v={`${v.parsed.header.platform}`}
            hint={unityPlatformName(v.parsed.header.platform)}
          />
          <KvRow k="File size" v={formatBytes(v.parsed.header.fileSize)} />
          <KvRow
            k="TypeTree"
            v={v.parsed.header.enableTypeTree ? "embedded" : "stripped"}
          />
        </KvBlock>

        <UnityObjectsTable view={v} />

        {v.parsed.externals.length > 0 && (
          <KvBlock title="Externals">
            {v.parsed.externals.map((e, i) => (
              <KvRow
                key={i}
                k={e.basename || `external ${i}`}
                v={e.pathName}
                mono
              />
            ))}
          </KvBlock>
        )}
      </div>
    </ScrollArea>
  )
}

function unityPlatformName(code: number): string | undefined {
  // Subset of Unity's `BuildTarget` enum.
  switch (code) {
    case 1: return "StandaloneOSX"
    case 5: return "StandaloneWindows"
    case 7: return "WebPlayer"
    case 9: return "iOS"
    case 13: return "Xbox360"
    case 19: return "PSVita"
    case 23: return "PS4"
    case 24: return "PSP2"
    case 25: return "XboxOne"
    case 27: return "Switch"
    case 38: return "StandaloneLinux64"
    default: return undefined
  }
}

function UnityObjectsTable({ view }: { view: UnityAssetView }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Objects ({view.decoded.length})
      </h3>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Path ID</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {view.decoded.map((d, i) => {
              const ty = view.parsed.types[d.obj.typeIndex]
              const className =
                Object.entries(UnityClassId).find(
                  ([, cid]) => cid === ty?.classId,
                )?.[0] ?? `class ${ty?.classId}`
              return (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-1.5">{className}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">
                    {d.obj.pathId.toString()}
                  </td>
                  <td className="px-3 py-1.5">{d.name ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatBytes(d.obj.size)}
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

// -------- TextMeshPro font book --------

interface TmpFontFaceInfo {
  familyName: string
  styleName: string
  pointSize: number
  lineHeight: number
  ascentLine: number
  descentLine: number
}

interface TmpGlyph {
  index: number
  metrics: {
    width: number
    height: number
    horizontalBearingX: number
    horizontalBearingY: number
    horizontalAdvance: number
  }
  rect: { x: number; y: number; width: number; height: number }
  scale: number
  atlasIndex: number
}

interface TmpCharacter {
  unicode: number
  glyphIndex: number
}

interface TmpAtlasInfo {
  width: number
  height: number
  /** Unity `TextureFormat` enum value. */
  textureFormat: number
  /**
   * Where to find the **encoded, GPU-swizzled** atlas bytes.
   * Either inline (small fonts, usually English-only) or out-
   * of-band in a `.resS` resource stream (most CJK fonts).
   *
   * `null` when the model has no atlas at all (extremely rare;
   * means it's a metrics-only TMP_FontAsset).
   */
  encoded: TmpAtlasEncoded | null
}

type TmpAtlasEncoded =
  | { kind: "inline"; data: Uint8Array }
  | { kind: "stream"; blob: Blob; offset: number; size: number }

interface TmpFontData {
  face: TmpFontFaceInfo
  glyphs: Map<number, TmpGlyph>
  characters: TmpCharacter[]
  atlas: TmpAtlasInfo
}

function findTmpFontObject(decoded: UnityDecodedObject[]): UnityDecodedObject | null {
  for (const d of decoded) {
    const v = d.value as Record<string, unknown> | null
    if (!v) continue
    if ("m_GlyphTable" in v && "m_CharacterTable" in v && "m_FaceInfo" in v) {
      return d
    }
  }
  return null
}

/**
 * Find every Unity `Font` (class 128) object in the asset. These
 * carry a `m_FontData` array of TTF / OTF bytes — i.e. an
 * embedded source font file. Most TMPro assets ship in static
 * mode (no Font object); dynamic-mode TMPro assets and legacy
 * uGUI fonts both ship one.
 */
function findUnityFontObjects(view: UnityAssetView): UnityDecodedObject[] {
  const out: UnityDecodedObject[] = []
  for (const d of view.decoded) {
    const ty = view.parsed.types[d.obj.typeIndex]
    if (ty?.classId !== UnityClassId.Font) continue
    const val = d.value as Record<string, unknown> | null
    if (!val) continue
    // Only surface fonts that ship actual TTF/OTF bytes — there
    // are pure-metrics fonts (TextAsset-shaped) that don't have
    // anything to render natively.
    const bytes = extractUnityFontBytes(val)
    if (bytes && bytes.length > 0) out.push(d)
  }
  return out
}

/**
 * Pull the raw font bytes out of a Unity `Font` object's
 * decoded value, handling both shapes the TypeTree produces:
 *
 *   - Older bundles describe `m_FontData` as `TypelessData`,
 *     which `parseObject` returns as `{ size, data: Uint8Array }`.
 *   - Modern bundles (Unity 2020+) describe it as
 *     `vector<char>`, which the array fast-path returns as a
 *     plain `Uint8Array`.
 *
 * We accept either and return a single `Uint8Array` view, or
 * `null` when the field is missing / empty.
 */
function extractUnityFontBytes(
  val: Record<string, unknown> | null | undefined,
): Uint8Array | null {
  if (!val) return null
  const fd = val.m_FontData
  if (!fd) return null
  if (fd instanceof Uint8Array) return fd.length > 0 ? fd : null
  if (typeof fd === "object" && "data" in fd) {
    const d = (fd as { data?: unknown }).data
    if (d instanceof Uint8Array) return d.length > 0 ? d : null
  }
  return null
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  return 0
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * Pull the structured font data out of a TMP_FontAsset's
 * walked-tree value. Defensive about missing fields — older
 * TMPro asset versions ship a slightly different schema, but
 * the fields we read here have been stable since TMPro 1.0.
 */
function buildTmpFontData(
  view: UnityAssetView,
  fontObj: UnityDecodedObject,
): TmpFontData | null {
  const v = fontObj.value as Record<string, unknown> | null
  if (!v) return null

  const fi = v.m_FaceInfo as Record<string, unknown>
  const face: TmpFontFaceInfo = {
    familyName: asString(fi.m_FamilyName),
    styleName: asString(fi.m_StyleName),
    pointSize: asNumber(fi.m_PointSize),
    lineHeight: asNumber(fi.m_LineHeight),
    ascentLine: asNumber(fi.m_AscentLine),
    descentLine: asNumber(fi.m_DescentLine),
  }

  const glyphs = new Map<number, TmpGlyph>()
  for (const raw of (v.m_GlyphTable as Record<string, unknown>[]) ?? []) {
    const m = raw.m_Metrics as Record<string, unknown>
    const r = raw.m_GlyphRect as Record<string, unknown>
    const g: TmpGlyph = {
      index: asNumber(raw.m_Index),
      metrics: {
        width: asNumber(m.m_Width),
        height: asNumber(m.m_Height),
        horizontalBearingX: asNumber(m.m_HorizontalBearingX),
        horizontalBearingY: asNumber(m.m_HorizontalBearingY),
        horizontalAdvance: asNumber(m.m_HorizontalAdvance),
      },
      rect: {
        x: asNumber(r.m_X),
        y: asNumber(r.m_Y),
        width: asNumber(r.m_Width),
        height: asNumber(r.m_Height),
      },
      scale: asNumber(raw.m_Scale) || 1,
      atlasIndex: asNumber(raw.m_AtlasIndex),
    }
    glyphs.set(g.index, g)
  }

  const characters: TmpCharacter[] = []
  for (const raw of (v.m_CharacterTable as Record<string, unknown>[]) ?? []) {
    characters.push({
      unicode: asNumber(raw.m_Unicode),
      glyphIndex: asNumber(raw.m_GlyphIndex),
    })
  }

  // Resolve atlas. TMP fonts attach the atlas as a Texture2D
  // in the same SerializedFile (`m_AtlasTextures` is a list of
  // PPtrs to Texture2D objects, but in practice it has exactly
  // one entry, which is also the only Texture2D in the file).
  // Take the first Texture2D and surface its dimensions +
  // format + an encoded-bytes locator. Actual decode happens
  // later, in {@link TmpFontBookPreview}, since the resS bytes
  // can be hundreds of KB and we want that to run lazily.
  const texDecoded = view.decoded.find(
    (d) => view.parsed.types[d.obj.typeIndex]?.classId === UnityClassId.Texture2D,
  )
  const atlas: TmpAtlasInfo = {
    width: 0,
    height: 0,
    textureFormat: 0,
    encoded: null,
  }
  if (texDecoded && texDecoded.value) {
    const tv = texDecoded.value as Record<string, unknown>
    atlas.width = asNumber(tv.m_Width)
    atlas.height = asNumber(tv.m_Height)
    atlas.textureFormat = asNumber(tv.m_TextureFormat)
    // Encoded pixels can live inline (`image data.data`) or in
    // a resS via `m_StreamData`. TMPro fonts in modern Unity
    // ship via resS; check there first.
    const sd = tv.m_StreamData as Record<string, unknown> | undefined
    if (sd && asNumber(sd.size) > 0) {
      const path = asString(sd.path)
      // Path is `archive:/CAB-…/CAB-….resS` — pluck the
      // basename UnityFS exposes (last segment after the
      // final slash, minus a stray NUL byte the serializer
      // tends to append).
      const basenameMatch = /([^/\\]+)$/.exec(path.replace(/\0+$/, ""))
      const basename = basenameMatch ? basenameMatch[1]!.toLowerCase() : ""
      const resBlob = view.externalsByName.get(basename)
      if (resBlob) {
        atlas.encoded = {
          kind: "stream",
          blob: resBlob,
          offset: asNumber(sd.offset),
          size: asNumber(sd.size),
        }
      }
    }
    if (!atlas.encoded) {
      const inline = tv["image data"] as
        | { size: number; data: Uint8Array }
        | undefined
      if (inline && inline.size > 0) {
        atlas.encoded = { kind: "inline", data: inline.data }
      }
    }
  }

  return { face, glyphs, characters, atlas }
}

function TmpFontBookPreview({
  view,
  fontObj,
}: {
  view: UnityAssetView
  fontObj: UnityDecodedObject
}) {
  // First-pass load: structured font data + plan for fetching
  // atlas pixels from the resS.
  const data = useMemo(() => buildTmpFontData(view, fontObj), [view, fontObj])

  // Read + decode the atlas lazily. The resS slice can be
  // hundreds of KB and the deswizzle + RGBA expand is non-
  // trivial, so we hide both behind a `useAsync` so the rest
  // of the preview (face metrics, glyph table summary) renders
  // immediately.
  const {
    loading: atlasLoading,
    data: atlasDecoded,
    error: atlasError,
  } = useAsync(
    async () => {
      if (!data || !data.atlas.encoded) return null
      let encoded: Uint8Array
      if (data.atlas.encoded.kind === "inline") {
        encoded = data.atlas.encoded.data
      } else {
        const slice = data.atlas.encoded.blob.slice(
          data.atlas.encoded.offset,
          data.atlas.encoded.offset + data.atlas.encoded.size,
        )
        encoded = new Uint8Array(await slice.arrayBuffer())
      }
      return decodeUnityTexture2D(
        data.atlas.width,
        data.atlas.height,
        data.atlas.textureFormat,
        encoded,
      )
    },
    [data],
  )

  // Sample text the user can edit. Default to the first 96
  // printable codepoints from the character table so the
  // preview always shows real glyphs.
  const defaultSample = useMemo(() => {
    if (!data) return ""
    const chars = data.characters
      .filter((c) => c.unicode >= 0x21 && c.unicode <= 0x7e)
      .slice(0, 96)
    return chars.map((c) => String.fromCodePoint(c.unicode)).join("")
  }, [data])
  const [sampleText, setSampleText] = useState("")
  useEffect(() => {
    setSampleText(defaultSample)
  }, [defaultSample])

  if (!data) return null

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <div>
          <span className="text-sm font-medium text-foreground">
            {data.face.familyName}
          </span>
          {data.face.styleName && (
            <span className="ml-2 text-muted-foreground">
              {data.face.styleName}
            </span>
          )}
        </div>
        <div>
          {data.glyphs.size} glyphs · {data.atlas.width}×{data.atlas.height} SDF
          atlas
        </div>
      </div>
      <textarea
        value={sampleText}
        onChange={(e) => setSampleText(e.target.value)}
        placeholder="Type to preview…"
        className="h-20 resize-y rounded-md border bg-background p-2 font-mono text-xs"
        spellCheck={false}
      />
      <div className="overflow-auto rounded-md border bg-background">
        {atlasLoading ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            Loading atlas…
          </div>
        ) : atlasError ? (
          <div className="p-3 text-xs text-destructive">
            {atlasError.message}
          </div>
        ) : (
          <TmpFontBookCanvas
            data={data}
            atlas={atlasDecoded ?? null}
            text={sampleText}
          />
        )}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          Show raw SDF atlas
        </summary>
        <div className="mt-2 max-h-[600px] overflow-auto rounded-md border bg-background p-2">
          <TmpFontAtlasPreview atlas={atlasDecoded ?? null} />
        </div>
      </details>
      <div className="text-xs text-muted-foreground">
        SDF atlas (face point size {data.face.pointSize.toFixed(0)}, line height{" "}
        {data.face.lineHeight.toFixed(0)},{" "}
        {UnityTextureFormatName(data.atlas.textureFormat) ??
          `format ${data.atlas.textureFormat}`}
        )
      </div>
    </section>
  )
}

/**
 * Render `text` onto a canvas by composing glyphs from the
 * SDF atlas. The atlas is stored bottom-up (Unity convention)
 * with one byte per pixel (Alpha8). We:
 *
 *   1. Decode the atlas to RGBA8 in memory once per atlas blob.
 *   2. For each character in `text`, look up its glyph index,
 *      then draw the corresponding atlas region at the right
 *      position using the per-glyph horizontal advance and
 *      bearing values.
 *   3. Pen advances one glyph at a time on a single line; line
 *      breaks (ASCII 10) reset the X position and bump Y by
 *      `face.lineHeight`.
 *
 * The atlas is SDF, so we threshold around 0.5 to get a crisp
 * outline rather than the soft greyscale edge. That mimics
 * what TMPro's runtime shader does when rendering text on top
 * of an opaque material.
 */
/**
 * Render the raw SDF atlas to a canvas at native resolution.
 * Used as a debug / inspection aid — handy for confirming the
 * deswizzle + Y-flip is right before glyph layout enters the
 * picture.
 */
function TmpFontAtlasPreview({
  atlas,
}: {
  atlas: UnityDecodedTexture | null
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx || !atlas) return
    const { width, height, pixels } = atlas
    canvas.width = width
    canvas.height = height
    // Flip Y from Unity bottom-up to canvas top-down. Pixels
    // are already RGBA8 (deswizzler + format expander did the
    // hard work); we just rearrange rows.
    const flipped = new Uint8ClampedArray(pixels.length)
    const rowBytes = width * 4
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowBytes
      const dstRow = y * rowBytes
      flipped.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow)
    }
    ctx.putImageData(new ImageData(flipped, width, height), 0, 0)
  }, [atlas])
  return <canvas ref={ref} className="block" style={{ imageRendering: "pixelated" }} />
}

function TmpFontBookCanvas({
  data,
  atlas,
  text,
}: {
  data: TmpFontData
  atlas: UnityDecodedTexture | null
  text: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Render scale: TMP atlases store glyphs at their authored
  // point size, often 32 px tall. At 2× we get 64-px-tall
  // glyphs which reads well on hi-DPI displays.
  const RENDER_SCALE = 2.0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    if (!atlas) {
      canvas.width = 1
      canvas.height = 1
      return
    }

    // 1. Build an RGBA atlas, flipping Y from Unity bottom-up
    //    to canvas top-down and re-thresholding the SDF
    //    distance field. The decoder gave us pixels in the
    //    source format already converted to RGBA8 (so for an
    //    Alpha8 / R8 SDF that's `(v, v, v, v)` — but we want
    //    *opaque white text with alpha = SDF coverage* for
    //    rendering on a dark background, so we recompute the
    //    alpha here via a smoothstep around 128.
    const aw = atlas.width
    const ah = atlas.height
    const src = atlas.pixels
    const atlasRgba = new Uint8ClampedArray(aw * ah * 4)
    for (let y = 0; y < ah; y++) {
      const srcRow = (ah - 1 - y) * aw * 4
      const dstRow = y * aw * 4
      for (let x = 0; x < aw; x++) {
        const v = src[srcRow + x * 4]! // R == G == B == A for SDF
        const t = Math.max(0, Math.min(1, (v - 96) / 64))
        const alpha = Math.round(t * 255)
        atlasRgba[dstRow + x * 4] = 255
        atlasRgba[dstRow + x * 4 + 1] = 255
        atlasRgba[dstRow + x * 4 + 2] = 255
        atlasRgba[dstRow + x * 4 + 3] = alpha
      }
    }
    const atlasImg = new ImageData(atlasRgba, aw, ah)

    // 2. Lay out glyphs. Compute pen positions first so we know
    //    the canvas size before drawing. Pen Y is the baseline
    //    of the current line; pen X advances by the glyph's
    //    horizontal advance after each character.
    interface PlacedGlyph {
      glyph: TmpGlyph
      x: number
      y: number
    }
    const placed: PlacedGlyph[] = []
    let penX = 0
    const lineHeight = data.face.lineHeight || data.face.pointSize * 1.2
    // Baseline of the first line. We pad a bit at the top so
    // ascenders aren't clipped — `lineHeight` is generous
    // enough to hold an entire line including descenders below.
    let penY = lineHeight * 0.85
    let maxX = 0
    const charByCode = new Map<number, number>()
    for (const c of data.characters) charByCode.set(c.unicode, c.glyphIndex)

    for (const ch of [...text]) {
      const cp = ch.codePointAt(0)!
      if (cp === 10 /* LF */) {
        if (penX > maxX) maxX = penX
        penX = 0
        penY += lineHeight
        continue
      }
      const glyphIdx = charByCode.get(cp)
      if (glyphIdx === undefined) continue
      const glyph = data.glyphs.get(glyphIdx)
      if (!glyph) continue
      placed.push({ glyph, x: penX, y: penY })
      penX += glyph.metrics.horizontalAdvance
    }
    if (penX > maxX) maxX = penX

    // Canvas dimensions. Width = furthest pen advance; height =
    // baseline of last line + descent room. We render at 2× to
    // counter the atlas's slight blurriness when the browser
    // downscales for retina displays.
    const W = Math.max(64, Math.ceil(maxX * RENDER_SCALE))
    const H = Math.max(64, Math.ceil((penY + lineHeight * 0.4) * RENDER_SCALE))
    canvas.width = W
    canvas.height = H

    // 3. Paint background + glyphs. We use putImageData on a
    //    temporary canvas to load the atlas pixels, then
    //    drawImage with src/dst rects to blit each glyph.
    ctx.fillStyle = "#0c0c10" // matches the app's background
    ctx.fillRect(0, 0, W, H)

    const atlasCanvas = document.createElement("canvas")
    atlasCanvas.width = aw
    atlasCanvas.height = ah
    const atlasCtx = atlasCanvas.getContext("2d")!
    atlasCtx.putImageData(atlasImg, 0, 0)

    for (const p of placed) {
      const g = p.glyph
      // Skip glyphs whose atlas rect has zero area. TMP packs
      // a "blank" entry as glyph 1 (space, etc.) with rect
      // 0×0 — drawing those would throw or do nothing useful.
      if (g.rect.width === 0 || g.rect.height === 0) continue
      // Atlas coordinates: m_X / m_Y are the bottom-left of the
      // glyph rectangle in atlas space; m_Width / m_Height are
      // the pixel dimensions. Unity's atlas origin is bottom-
      // left, so we flipped Y above when building `atlasRgba`
      // (which is now top-down). To find the rect in the
      // top-down image: y_top_down = ah - rect.y - rect.height.
      const sx = g.rect.x
      const sy = ah - g.rect.y - g.rect.height
      const sw = g.rect.width
      const sh = g.rect.height
      // Use the rect's pixel dimensions for the destination
      // too. Glyph metrics' `width` / `height` are the SDF-
      // padding-stripped logical sizes and would shrink the
      // glyph; the SDF padding belongs at draw time so colors
      // bleed correctly through the threshold.
      // bearingY is "ascent above baseline" measured in pixels
      // matching the rect's coordinate system, so subtracting
      // it from the pen Y baseline gives the glyph rect's top.
      const dx = (p.x + g.metrics.horizontalBearingX) * RENDER_SCALE
      const dy = (p.y - g.metrics.horizontalBearingY) * RENDER_SCALE
      const dw = sw * RENDER_SCALE
      const dh = sh * RENDER_SCALE
      ctx.drawImage(atlasCanvas, sx, sy, sw, sh, dx, dy, dw, dh)
    }
  }, [data, atlas, text])

  return (
    <canvas
      ref={canvasRef}
      className="block max-w-full"
      style={{ imageRendering: "auto" }}
    />
  )
}

// -------- Single Unity object inside a SerializedFile --------

/**
 * Preview for a single object inside a Unity SerializedFile —
 * one Font, Texture2D, MonoBehaviour, etc. surfaced as its own
 * tree node by the `unity-object` archive kind.
 *
 * We re-parse the parent CAB (held in `meta.unitySerializedFileBlob`)
 * to pick out the specific object by `pathId`. SerializedFile
 * parsing is in the millisecond range, so paying the cost on each
 * click keeps memory predictable without making the UI sluggish.
 *
 * Dispatch by class name:
 *   - `Font`            → {@link UnityFontPreview} (live TTF / OTF preview)
 *   - everything else   → generic decoded-object summary + raw-bytes hex
 *
 * More dedicated previews (Texture2D, AudioClip, MonoBehaviour,
 * AssetBundle manifest, …) can be added here without touching the
 * archive layer or the dispatch in `FilePreview`.
 */
function UnityObjectPreview({
  node,
  root,
}: {
  node: Node
  root: Node | null
}) {
  // The CAB blob and the object's pathId are stamped onto the node
  // by `archive.ts` when the SerializedFile children are built. If
  // either is missing we fall back to a plain hex view of the
  // object bytes — that path also catches future producers of
  // `unity-object` nodes that haven't migrated to the new meta yet.
  const cabBlob = node.meta?.unitySerializedFileBlob as Blob | undefined
  const targetPathId = node.meta?.unityPathId as string | undefined
  const cabId = node.meta?.unitySerializedFileNodeId as string | undefined

  const { loading, data, error } = useAsync(async () => {
    if (!cabBlob || !targetPathId) {
      throw new Error("Unity object node missing SerializedFile metadata")
    }
    const parsed = await parseSerializedFile(cabBlob)
    const wantedId = BigInt(targetPathId)
    const obj = parsed.objects.find((o) => o.pathId === wantedId)
    if (!obj) {
      throw new Error(
        `Unity object pathId=${targetPathId} not found in SerializedFile`,
      )
    }
    const ty = parsed.types[obj.typeIndex]
    let value: unknown = null
    if (ty?.typeTree) {
      try {
        value = await parseUnityObject(obj, ty.typeTree)
      } catch (e) {
        // Decoded value is best-effort; the raw bytes are still
        // available below for inspection.
        value = { __error: (e as Error).message }
      }
    }
    const name =
      value && typeof value === "object" && "m_Name" in value
        ? String((value as { m_Name?: unknown }).m_Name ?? "") || null
        : null
    const decoded: UnityDecodedObject = { obj, value, name }
    return { parsed, decoded }
  }, [node.id, cabBlob, targetPathId])

  if (loading) return <LoadingFiller label="Decoding Unity object…" />
  if (error) return <ErrorFiller error={error} />
  const { parsed, decoded } = data!
  const className = (node.meta?.unityClass as string | undefined) ?? "Unity object"

  // Class-specific dispatch. Each preview gets the decoded object
  // (`decoded`) plus the parsed SerializedFile (`parsed`) and the
  // archive root + CAB id so externals (`.resS` for Texture2D,
  // `.resource` for AudioClip) can be resolved against sibling
  // tree nodes. Anything not handled falls through to a generic
  // collapsible tree of the decoded value below.
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title={`Unity ${className}`} />
        <UnityObjectClassPreview
          className={className}
          decoded={decoded}
          parsed={parsed}
          node={node}
          root={root}
          cabId={cabId}
        />
        <UnityObjectFieldsBlock decoded={decoded} className={className} />
      </div>
    </ScrollArea>
  )
}

/**
 * Header table (Class / Path ID / Size) plus a `react-inspector`
 * collapsible tree of the decoded object's full field structure.
 *
 * The KV header is the at-a-glance metadata that's identical for
 * every Unity object regardless of class — kept as a flat table
 * because the values don't benefit from expansion.
 *
 * The decoded value tree below is the interactive part: nested
 * objects expand on click, PPtr / Uint8Array values render as
 * compact non-expandable badges (see
 * `prepareUnityValueForInspector` in
 * `unity-object-inspector.tsx`), and arrays show inline previews.
 */
function UnityObjectFieldsBlock({
  decoded,
  className,
}: {
  decoded: UnityDecodedObject
  className: string
}) {
  const { obj, value } = decoded
  return (
    <section className="flex flex-col gap-3">
      <KvBlock title="Object header">
        <KvRow k="Class" v={`${className} (${obj.classId})`} />
        <KvRow k="Path ID" v={obj.pathId.toString()} />
        <KvRow k="Size" v={formatBytes(obj.size)} />
      </KvBlock>
      {value !== null && value !== undefined && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Object fields
          </div>
          <UnityObjectInspector data={value} expandLevel={1} />
        </div>
      )}
    </section>
  )
}

/**
 * Per-class preview body for a {@link UnityObjectPreview}. Returns
 * a class-tailored renderer when one exists (Font, TextAsset,
 * Texture2D, AudioClip, MonoBehaviour, AssetBundle), otherwise
 * `null` so only the generic KV summary at the parent level shows.
 */
function UnityObjectClassPreview({
  className,
  decoded,
  parsed,
  node,
  root,
  cabId,
}: {
  className: string
  decoded: UnityDecodedObject
  parsed: ParsedSerializedFile
  node: Node
  root: Node | null
  cabId: string | undefined
}) {
  switch (className) {
    case "Font":
      return (
        <UnityFontPreview fontObj={decoded} sourceName={node.name} />
      )
    case "TextAsset":
      return <UnityTextAssetPreview decoded={decoded} sourceName={node.name} />
    case "AssetBundle":
      return <UnityAssetBundlePreview decoded={decoded} parsed={parsed} />
    case "MonoBehaviour":
      return <UnityMonoBehaviourPreview decoded={decoded} parsed={parsed} />
    case "Texture2D":
      return (
        <UnityTexture2DObjectPreview
          decoded={decoded}
          root={root}
          cabId={cabId}
        />
      )
    case "AudioClip":
      return (
        <UnityAudioClipPreview
          decoded={decoded}
          root={root}
          cabId={cabId}
        />
      )
    case "Sprite":
      return (
        <UnitySpritePreview
          decoded={decoded}
          parsed={parsed}
          root={root}
          cabId={cabId}
        />
      )
    default:
      return null
  }
}

// -------- Unity `Font` (class 128) embedded TTF / OTF preview --------

/**
 * Render a sample of a Unity `Font` object's embedded TTF/OTF
 * via the browser's CSS Font Loading API, plus offer the bytes
 * as a downloadable `.ttf` / `.otf`. Used both for legacy uGUI
 * fonts and for dynamic-mode TMPro fonts that ship the source
 * font alongside the SDF atlas.
 *
 * The font bytes come from the `Font` object's `m_FontData`
 * field — a `TypelessData` blob whose first 4 bytes identify
 * the format (`OTTO` for OpenType / CFF, `00 01 00 00` or
 * `true` for TrueType). We sniff that to label the UI and pick
 * the right file extension.
 */
function UnityFontPreview({
  fontObj,
  sourceName,
}: {
  fontObj: UnityDecodedObject
  sourceName: string
}) {
  const v = fontObj.value as Record<string, unknown>
  const fontBytes = extractUnityFontBytes(v)
  const displayName =
    asString(v.m_Name) || sourceName.replace(/\.bundle$/i, "")
  const format = sniffFontFormat(fontBytes)

  // CSS Font Loading registration. Same pattern as `FontPreview`
  // for `.bfttf` / `.ttf` / `.otf` files: assign a unique family
  // name, await `FontFace.load()`, hand the family to the
  // sample text via `style.fontFamily`.
  const [fontFamily, setFontFamily] = useState<string | null>(null)
  const [fontError, setFontError] = useState<string | null>(null)
  useEffect(() => {
    if (!fontBytes || fontBytes.length === 0) {
      setFontFamily(null)
      setFontError(null)
      return
    }
    let cancelled = false
    let registered: FontFace | null = null
    const family = `nx-archive-unity-font-${Math.random().toString(36).slice(2, 10)}`
    ;(async () => {
      try {
        // Slice off the buffer to a fresh ArrayBuffer (FontFace
        // doesn't accept Uint8Array views with non-zero byte
        // offset reliably across browsers, plus TS narrows
        // `Uint8Array.buffer` to `ArrayBuffer | SharedArrayBuffer`
        // and FontFace only takes plain ArrayBuffer).
        const ab = new ArrayBuffer(fontBytes.byteLength)
        new Uint8Array(ab).set(fontBytes)
        const face = new FontFace(family, ab)
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
  }, [fontBytes])

  // We trigger the font download imperatively (create the blob
  // URL on click → programmatic `<a>` → remove → revoke after a
  // short timeout) rather than declaratively binding a long-lived
  // `URL.createObjectURL(...)` to an `<a href>`. Two reasons:
  //
  //   1. Firefox refuses to navigate a same-origin page to a
  //      blob: URL whose MIME type it considers font-like
  //      (`font/ttf` / `font/otf`) — the resulting "Security
  //      Error: Content at <origin> may not load data from
  //      blob:…" makes the link silently no-op.
  //   2. React StrictMode double-invokes effect cleanups, which
  //      revokes a useMemo-built URL between mount and re-mount
  //      while the link still references the dead URL.
  //
  // Switching to `application/octet-stream` for the download blob
  // (the MIME type only governs the download-time content
  // disposition; the file extension comes from `download=`) sides
  // step (1), and per-click URL lifetime sidesteps (2).

  const formatLabel =
    format === "otf"
      ? "OpenType (CFF)"
      : format === "ttf"
        ? "TrueType"
        : "Unknown sfnt"
  const downloadName = useMemo(() => {
    const stem = (asString(v.m_Name) || displayName)
      .replace(/[^A-Za-z0-9._-]+/g, "_")
    return `${stem || "font"}.${format ?? "ttf"}`
  }, [v.m_Name, displayName, format])

  if (!fontBytes || fontBytes.length === 0) return null

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <div>
          <span className="text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="ml-2 text-muted-foreground">
            (embedded {formatLabel})
          </span>
        </div>
        <div>{formatBytes(fontBytes.length)}</div>
      </div>
      {fontError && (
        <div className="text-xs text-destructive">{fontError}</div>
      )}
      {!fontFamily && !fontError && (
        <div className="text-xs text-muted-foreground">Loading font…</div>
      )}
      {fontFamily && (
        <div
          className="overflow-x-auto rounded-md border bg-background p-3 leading-relaxed"
          style={{ fontFamily: `"${fontFamily}", sans-serif` }}
        >
          <div className="text-2xl">{displayName}</div>
          <div
            className="mt-2 text-base"
            style={{ fontFamily: `"${fontFamily}", sans-serif` }}
          >
            {FONT_SAMPLE_PANGRAM}
          </div>
          <div
            className="mt-2 text-base"
            style={{ fontFamily: `"${fontFamily}", sans-serif` }}
          >
            {FONT_SAMPLE_PUNCTUATION}
          </div>
          <div
            className="mt-2 text-xl"
            style={{ fontFamily: `"${fontFamily}", sans-serif` }}
          >
            {FONT_SAMPLE_CJK}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Embedded source font from `m_FontData`</span>
        <button
          type="button"
          onClick={() => downloadBlobBytes(fontBytes, downloadName)}
          className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
        >
          Save .{format ?? "ttf"}
        </button>
      </div>
    </section>
  )
}

/**
 * Trigger a same-page download of `bytes` saved as `fileName`.
 *
 * Uses an imperative create-link → click → revoke cycle rather
 * than a long-lived `<a href={blobUrl}>`:
 *
 *   - React StrictMode double-invokes effect cleanups, which
 *     would revoke a useMemo-built blob URL between mount and
 *     re-mount, leaving the rendered link pointing at a dead URL.
 *   - Firefox refuses same-origin navigation to a `blob:` URL
 *     whose Blob's MIME type is font-shaped (`font/ttf`,
 *     `font/otf`) — it errors with "Security Error: Content at
 *     <origin> may not load data from blob:…" and the link
 *     silently no-ops.
 *
 * We side-step both by creating the URL on click, attaching it
 * to a transient hidden `<a>`, calling `.click()`, and revoking
 * after a short timeout (matches what the global `DownloadButton`
 * does for archive-level downloads). MIME type is
 * `application/octet-stream` so the browser treats the payload
 * as a generic download attachment regardless of contents.
 */
function downloadBlobBytes(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/octet-stream",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/**
 * Identify the on-disk font format by peeking at the first 4
 * bytes (the sfnt magic). Returns `"ttf"`, `"otf"`, or `null`
 * if the bytes don't look like an sfnt at all (in which case
 * we still surface the raw bytes via download but skip the
 * live preview).
 */
function sniffFontFormat(bytes: Uint8Array | null): "ttf" | "otf" | null {
  if (!bytes || bytes.length < 4) return null
  const m = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!
  if (m === 0x4f54544f /* OTTO */) return "otf"
  if (m === 0x00010000) return "ttf"
  if (m === 0x74727565 /* true */) return "ttf"
  if (m === 0x74797031 /* typ1 */) return "ttf"
  if (m === 0x74746366 /* ttcf */) return "ttf" // TrueType collection
  return null
}

// -------- Unity `TextAsset` (class 49) preview --------

/**
 * Render a Unity `TextAsset` object's `m_Script` field. Unity stores
 * arbitrary text or binary blobs in this class — common uses include
 * level descriptors, dialog tables, JSON configs, CSV / TSV data,
 * and the occasional shader source. The TypeTree describes
 * `m_Script` as a `string` so `parseObject` always returns a JS
 * `string` (UTF-8 decoded if the bytes were valid UTF-8, otherwise
 * a string of replacement characters).
 *
 * Heuristics:
 *
 *   - Pretty-print as JSON when the content parses as JSON (covers
 *     the most common shipping case for Unity addressables manifests
 *     and per-bundle config files).
 *   - Otherwise show as plain monospace text, with line-count and
 *     byte-count badges.
 *   - Truncate inline rendering past `TEXT_PREVIEW_LIMIT` so a 5 MB
 *     dialog table doesn't lock the UI; the `Save` button always
 *     downloads the full payload.
 */
function UnityTextAssetPreview({
  decoded,
  sourceName,
}: {
  decoded: UnityDecodedObject
  sourceName: string
}) {
  const v = decoded.value as Record<string, unknown> | null
  const rawScript = v?.m_Script
  // `m_Script` is described as `string` in the TypeTree — but our
  // parser also accepts `vector<char>` shipping bytes for some
  // legacy Unity versions. Coerce both to a JS string for display.
  let text = ""
  let byteLength = 0
  if (typeof rawScript === "string") {
    text = rawScript
    byteLength = new TextEncoder().encode(rawScript).length
  } else if (rawScript instanceof Uint8Array) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(rawScript)
    byteLength = rawScript.length
  } else if (
    rawScript &&
    typeof rawScript === "object" &&
    "data" in rawScript &&
    (rawScript as { data?: unknown }).data instanceof Uint8Array
  ) {
    const u8 = (rawScript as { data: Uint8Array }).data
    text = new TextDecoder("utf-8", { fatal: false }).decode(u8)
    byteLength = u8.length
  }
  if (!text) {
    return (
      <section className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
        TextAsset is empty (no `m_Script` content).
      </section>
    )
  }
  // Try JSON pretty-printing — fall back to raw text on parse error.
  let display = text
  let format: "json" | "text" = "text"
  if (text.length <= TEXT_PREVIEW_LIMIT) {
    const trimmed = text.trim()
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        display = JSON.stringify(JSON.parse(trimmed), null, 2)
        format = "json"
      } catch {
        /* leave raw */
      }
    }
  }
  const truncated = text.length > TEXT_PREVIEW_LIMIT
  const lineCount = text.split("\n").length
  const baseName = (decoded.name || sourceName).replace(/\.txt$/i, "")
  const downloadName = `${baseName.replace(/[^A-Za-z0-9._-]+/g, "_")}.${format === "json" ? "json" : "txt"}`
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <div className="text-sm font-medium text-foreground">
          {decoded.name || "(unnamed)"}
          <span className="ml-2 text-muted-foreground">
            (TextAsset {format === "json" ? "JSON" : "text"})
          </span>
        </div>
        <div>
          {lineCount.toLocaleString()} line{lineCount === 1 ? "" : "s"} ·{" "}
          {formatBytes(byteLength)}
        </div>
      </div>
      <pre className="max-h-[60vh] overflow-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
        {truncated
          ? `${display.slice(0, TEXT_PREVIEW_LIMIT)}\n\n… (truncated; use the Save button below for full content)`
          : display}
      </pre>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {format === "json"
            ? "Auto-formatted JSON — original bytes preserved on download."
            : "Plain text content from `m_Script`."}
        </span>
        <button
          type="button"
          onClick={() =>
            downloadBlobBytes(new TextEncoder().encode(text), downloadName)
          }
          className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
        >
          Save .{format}
        </button>
      </div>
    </section>
  )
}

// -------- Unity `AssetBundle` (class 142) manifest preview --------

/**
 * Render the AssetBundle manifest — the per-bundle metadata record
 * Unity emits as object pathId=1. It catalogues every asset
 * surfaced from this bundle (m_Container) along with the bundle's
 * declared dependencies on other bundles (m_Dependencies). Useful
 * for navigating Addressables-style content where many bundles
 * cross-reference each other.
 *
 * `m_Container` is a List<KeyValuePair<string, AssetInfo>> in the
 * Unity source — our TypeTree walker surfaces it as an array of
 * `{ first: string, second: { preloadIndex, preloadSize, asset:
 * PPtr<Object> } }` entries. We normalise to a flat list of
 * (path, pathId) for display.
 */
function UnityAssetBundlePreview({
  decoded,
  parsed,
}: {
  decoded: UnityDecodedObject
  parsed: ParsedSerializedFile
}) {
  // Used to look up object class + name when an m_Container entry
  // points to another asset in this same SerializedFile (the
  // common case — most Addressables bundles bind every asset by
  // a pathId in the same CAB).
  const objIndex = useMemo(() => {
    const m = new Map<bigint, { className: string; name: string }>()
    for (const obj of parsed.objects) {
      const ty = parsed.types[obj.typeIndex]
      // Re-decode each object lazily would be expensive; instead
      // we lean on the fact that the UnityObjectsTable view above
      // already had this data. For the AssetBundle preview we
      // only show class names from the static lookup (no per-
      // object decode here) and let the user click into the
      // referenced asset for details.
      const className =
        Object.entries(UnityClassId).find(
          ([, v]) => v === obj.classId,
        )?.[0] ?? `Class${obj.classId}`
      m.set(obj.pathId, { className, name: ty?.typeTree?.name ?? "" })
    }
    return m
  }, [parsed])
  const v = decoded.value as Record<string, unknown> | null
  if (!v) return null
  const containerEntries = extractAssetBundleContainer(v.m_Container)
  const dependencies = extractAssetBundleDependencies(v.m_Dependencies)
  const bundleName =
    typeof v.m_AssetBundleName === "string" ? v.m_AssetBundleName : ""
  return (
    <section className="flex flex-col gap-4 rounded-md border bg-card p-4">
      <div className="text-sm font-medium text-foreground">
        AssetBundle manifest
        {bundleName && (
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {bundleName}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {containerEntries.length} asset
        {containerEntries.length === 1 ? "" : "s"} ·{" "}
        {dependencies.length} dependenc
        {dependencies.length === 1 ? "y" : "ies"}
      </div>
      {containerEntries.length > 0 && (
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="min-w-full text-xs">
            <thead className="border-b bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Asset path</th>
                <th className="px-3 py-2 font-medium">PPtr</th>
                <th className="px-3 py-2 font-medium">Class</th>
              </tr>
            </thead>
            <tbody>
              {containerEntries.map((e, i) => {
                const pid =
                  typeof e.pathId === "bigint"
                    ? e.pathId
                    : BigInt(e.pathId ?? 0)
                const found = objIndex.get(pid)
                const cls = e.fileId === 0 ? (found?.className ?? "—") : "external"
                return (
                  <tr
                    key={i}
                    className="border-t font-mono [&:hover]:bg-accent/40"
                  >
                    <td className="break-all px-3 py-1.5">{e.path}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                      {e.fileId === 0
                        ? `pathId=${pid.toString()}`
                        : `fileId=${e.fileId}, pathId=${pid.toString()}`}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{cls}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {dependencies.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Dependencies</div>
          <ul className="rounded-md border bg-background p-2 font-mono text-xs">
            {dependencies.map((d, i) => (
              <li key={i} className="px-1 py-0.5">{d}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

interface AssetBundleContainerEntry {
  path: string
  fileId: number
  pathId: bigint | number
  preloadIndex: number
  preloadSize: number
}

function extractAssetBundleContainer(
  raw: unknown,
): AssetBundleContainerEntry[] {
  if (!Array.isArray(raw)) return []
  const out: AssetBundleContainerEntry[] = []
  for (const e of raw) {
    if (!e || typeof e !== "object") continue
    // KeyValuePair<string, AssetInfo> serialises as { first, second }
    // where AssetInfo is { preloadIndex, preloadSize, asset: PPtr }.
    const r = e as Record<string, unknown>
    const path = typeof r.first === "string" ? r.first : ""
    const second = r.second as Record<string, unknown> | undefined
    if (!second) continue
    const asset = second.asset as Record<string, unknown> | undefined
    const fileId = asset && typeof asset.m_FileID === "number" ? asset.m_FileID : 0
    const rawPathId = asset?.m_PathID
    const pathId =
      typeof rawPathId === "bigint"
        ? rawPathId
        : typeof rawPathId === "number"
          ? rawPathId
          : 0n
    const preloadIndex =
      typeof second.preloadIndex === "number" ? second.preloadIndex : 0
    const preloadSize =
      typeof second.preloadSize === "number" ? second.preloadSize : 0
    out.push({ path, fileId, pathId, preloadIndex, preloadSize })
  }
  return out
}

function extractAssetBundleDependencies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((d): d is string => typeof d === "string")
}

// -------- Unity `MonoBehaviour` (class 114) preview --------

/**
 * Header summary for a `MonoBehaviour` — surfaces the associated
 * MonoScript PPtr so users can locate the script asset in the
 * tree even when MonoScripts ship in a separate bundle. The
 * actual user-defined fields are rendered by the inspector tree
 * below (`UnityObjectFieldsBlock`) — no need to duplicate.
 */
function UnityMonoBehaviourPreview({
  decoded,
  parsed,
}: {
  decoded: UnityDecodedObject
  parsed: ParsedSerializedFile
}) {
  void parsed
  const v = decoded.value as Record<string, unknown> | null
  if (!v) return null
  const scriptRef = v.m_Script as
    | { m_FileID?: number; m_PathID?: bigint | number }
    | undefined
  const scriptLabel = scriptRef
    ? `fileId=${scriptRef.m_FileID ?? 0}, pathId=${(scriptRef.m_PathID ?? 0).toString()}`
    : null
  return (
    <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
      <div className="text-sm font-medium text-foreground">
        MonoBehaviour
        <span className="ml-2 text-xs text-muted-foreground">
          (custom script instance)
        </span>
      </div>
      {scriptLabel && (
        <div className="text-xs text-muted-foreground">
          Script: <span className="font-mono">{scriptLabel}</span>
        </div>
      )}
    </section>
  )
}

// -------- Unity `Texture2D` (class 28) preview --------

/**
 * Render a Unity Texture2D as a PNG via the existing
 * `decodeUnityTexture2D` decoder. Two data sources to handle:
 *
 *   - Inline `image data` (small textures or older Unity versions).
 *   - Streamed via `m_StreamData` → reads `(offset, size)` from a
 *     sibling `.resS` file inside the same bundle.
 *
 * Resolves siblings by walking the archive tree from `root` to the
 * CAB's parent (the bundle), the same way the parent
 * `UnityAssetPreview` does for its inline texture renderings.
 */
function UnityTexture2DObjectPreview({
  decoded,
  root,
  cabId,
}: {
  decoded: UnityDecodedObject
  root: Node | null
  cabId: string | undefined
}) {
  const v = decoded.value as Record<string, unknown> | null
  // Decode pixels (RGBA8). The actual PNG-encode happens on the
  // canvas effect below, mirroring the BntxPreview pattern.
  const { loading, data, error } = useAsync(async () => {
    if (!v) throw new Error("Texture2D has no decoded value")
    const width = asNumber(v.m_Width)
    const height = asNumber(v.m_Height)
    const textureFormat = asNumber(v.m_TextureFormat)
    if (!width || !height || !textureFormat) {
      throw new Error("Texture2D missing width/height/format")
    }
    const payload = await resolveTexture2DPayload(v, root, cabId)
    if (!payload || payload.length === 0) {
      throw new Error(
        "Texture2D has no decodable pixel data (empty image data and no resolvable .resS).",
      )
    }
    const decodedTex = await decodeUnityTexture2D(
      width,
      height,
      textureFormat,
      payload,
    )
    return decodedTex
  }, [decoded.obj.pathId.toString(), cabId])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pngUrl, setPngUrl] = useState<string | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) {
      setPngUrl(null)
      return
    }
    canvas.width = data.width
    canvas.height = data.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const img = ctx.createImageData(data.width, data.height)
    img.data.set(data.pixels)
    ctx.putImageData(img, 0, 0)
    canvas.toBlob((b) => {
      if (b) setPngUrl(URL.createObjectURL(b))
    }, "image/png")
    return () => {
      setPngUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding texture…" />
  if (error) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
        <p className="text-sm font-medium text-foreground">
          Couldn't decode this Texture2D.
        </p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
      </section>
    )
  }
  const tex = data!
  const formatId = asNumber(v?.m_TextureFormat)
  const formatName =
    UnityTextureFormatName(formatId) ?? (formatId ? `format_${formatId}` : "?")
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <div>
          <span className="text-sm font-medium text-foreground">
            {decoded.name || "(unnamed)"}
          </span>
          <span className="ml-2 text-muted-foreground">
            ({tex.width}×{tex.height} {formatName})
          </span>
        </div>
        <div>{tex.pixels.length.toLocaleString()} px bytes</div>
      </div>
      <div className="overflow-auto rounded-md border bg-[#0a0a0a] p-2">
        <canvas
          ref={canvasRef}
          className="block max-h-[70vh] object-contain"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Decoded via `decodeUnityTexture2D` → canvas PNG.</span>
        {pngUrl && (
          <button
            type="button"
            onClick={async () => {
              const resp = await fetch(pngUrl)
              const buf = await resp.arrayBuffer()
              downloadBlobBytes(
                new Uint8Array(buf),
                `${(decoded.name || "texture").replace(/[^A-Za-z0-9._-]+/g, "_")}.png`,
              )
            }}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .png
          </button>
        )}
      </div>
    </section>
  )
}

/**
 * Assemble the encoded pixel payload for a decoded Texture2D
 * value. Walks both data sources Unity uses:
 *
 *   - `m_StreamData`: streamed via a sibling `.resS` file at the
 *     given offset/size. Most modern (Unity 5.4+) bundles ship
 *     textures this way.
 *   - `image data` (`TypelessData` / `vector<char>`): inline
 *     bytes embedded in the SerializedFile itself. Used for
 *     small textures and older Unity versions.
 *
 * Returns the bytes for mip-0 specifically — `decodeUnityTexture2D`
 * doesn't support deeper mip chains yet.
 */
async function resolveTexture2DPayload(
  v: Record<string, unknown>,
  root: Node | null,
  cabId: string | undefined,
): Promise<Uint8Array | null> {
  const sd = v.m_StreamData as Record<string, unknown> | undefined
  const sdSize = sd ? asNumber(sd.size) : 0
  if (sd && sdSize > 0) {
    const externals = await resolveTexture2DExternals(root, cabId)
    const path = asString(sd.path).replace(/\0+$/, "")
    const basenameMatch = /([^/\\]+)$/.exec(path)
    const basename = basenameMatch ? basenameMatch[1]!.toLowerCase() : ""
    const resBlob = externals.get(basename)
    if (resBlob) {
      const offset = asNumber(sd.offset)
      const slice = resBlob.slice(offset, offset + sdSize)
      return new Uint8Array(await slice.arrayBuffer())
    }
  }
  // Fall back to inline bytes. `image data` may be either the
  // legacy `{ size, data }` TypelessData shape or a raw
  // `Uint8Array` from the modern `vector<char>` fast path.
  const inline = v["image data"]
  if (inline instanceof Uint8Array) return inline
  if (
    inline &&
    typeof inline === "object" &&
    "data" in inline &&
    (inline as { data?: unknown }).data instanceof Uint8Array
  ) {
    return (inline as { data: Uint8Array }).data
  }
  return null
}

// -------- Unity `Sprite` (class 213) preview --------

/**
 * A Sprite isn't its own pixel data — it's a rectangular crop into
 * a `Texture2D`. We:
 *
 *   1. Read the source-texture PPtr from `m_RD.texture`.
 *   2. Find that Texture2D in the same SerializedFile by `pathId`.
 *   3. Decode the full source texture (cached path through
 *      `decodeTexture2D` so the existing format / GPU support
 *      cascade applies).
 *   4. Crop to `m_RD.textureRect` — Unity Y origin is bottom-left,
 *      so we flip the Y coordinate against the source texture's
 *      height when slicing.
 *   5. Render the cropped region to a canvas with a checkerboard
 *      backdrop so transparency is visible.
 *
 * Sprites whose source texture lives in a different bundle (the
 * PPtr's `m_FileID` is non-zero) get a friendly fallback message.
 * Atlas-packed sprites with `uvTransform` rotation aren't handled
 * yet — most non-atlased Sprites in the wild use the simple crop
 * path this implements, so we cover the common case first.
 */
function UnitySpritePreview({
  decoded,
  parsed,
  root,
  cabId,
}: {
  decoded: UnityDecodedObject
  parsed: ParsedSerializedFile
  root: Node | null
  cabId: string | undefined
}) {
  const v = decoded.value as Record<string, unknown> | null

  const { loading, data, error } = useAsync(async () => {
    if (!v) throw new Error("Sprite has no decoded value")
    const rd = v.m_RD as Record<string, unknown> | undefined
    if (!rd) throw new Error("Sprite missing m_RD render data")
    // Source texture PPtr.
    const texRef = rd.texture as
      | { m_FileID?: number; m_PathID?: bigint | number }
      | undefined
    const fileId = typeof texRef?.m_FileID === "number" ? texRef.m_FileID : 0
    const pathIdRaw = texRef?.m_PathID
    const pathId =
      typeof pathIdRaw === "bigint"
        ? pathIdRaw
        : typeof pathIdRaw === "number"
          ? BigInt(pathIdRaw)
          : 0n
    if (pathId === 0n) {
      throw new Error("Sprite has no source-texture reference (m_RD.texture)")
    }
    if (fileId !== 0) {
      throw new Error(
        "Sprite's source texture lives in another bundle (m_FileID > 0); cross-bundle PPtr resolution isn't implemented yet.",
      )
    }
    // Look up the Texture2D in the parent SerializedFile.
    const texObj = parsed.objects.find((o) => o.pathId === pathId)
    if (!texObj) {
      throw new Error(
        `Source Texture2D pathId=${pathId.toString()} not found in this SerializedFile.`,
      )
    }
    const texTy = parsed.types[texObj.typeIndex]
    if (!texTy?.typeTree) {
      throw new Error("Source Texture2D has no TypeTree to decode against.")
    }
    const texVal = (await parseUnityObject(texObj, texTy.typeTree)) as Record<
      string,
      unknown
    >
    const sourceWidth = asNumber(texVal.m_Width)
    const sourceHeight = asNumber(texVal.m_Height)
    const sourceFormat = asNumber(texVal.m_TextureFormat)
    if (!sourceWidth || !sourceHeight || !sourceFormat) {
      throw new Error("Source Texture2D is missing width/height/format")
    }
    // Decode the full source texture (we already have all the
    // platform-specific dispatch cascade — software / WASM ASTC /
    // WebGL — wrapped behind decodeTexture2D).
    const payload = await resolveTexture2DPayload(texVal, root, cabId)
    if (!payload || payload.length === 0) {
      throw new Error("Source Texture2D has no pixel data to decode.")
    }
    const sourceDecoded = await decodeUnityTexture2D(
      sourceWidth,
      sourceHeight,
      sourceFormat,
      payload,
    )
    // Crop to textureRect. Unity Y-axis is bottom-up, so the
    // textureRect.y is measured from the bottom of the source
    // texture. We flip into top-down coordinates by:
    //   topY = sourceHeight - rect.y - rect.height
    const rect = rd.textureRect as
      | { x?: number; y?: number; width?: number; height?: number }
      | undefined
    const cropX = Math.max(0, Math.round(asNumber(rect?.x)))
    const cropYBottom = Math.max(0, Math.round(asNumber(rect?.y)))
    const cropW = Math.max(
      1,
      Math.min(sourceWidth, Math.round(asNumber(rect?.width))),
    )
    const cropH = Math.max(
      1,
      Math.min(sourceHeight, Math.round(asNumber(rect?.height))),
    )
    const cropYTop = sourceHeight - cropYBottom - cropH
    const cropped = cropRgba(
      sourceDecoded.pixels,
      sourceDecoded.width,
      cropX,
      cropYTop,
      cropW,
      cropH,
    )
    return {
      pixels: cropped,
      width: cropW,
      height: cropH,
      sourceTextureName: asString(texVal.m_Name) || "(unnamed)",
      sourceWidth,
      sourceHeight,
      sourceFormat,
      cropOrigin: { x: cropX, y: cropYTop },
    }
  }, [decoded.obj.pathId.toString(), cabId])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pngUrl, setPngUrl] = useState<string | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) {
      setPngUrl(null)
      return
    }
    canvas.width = data.width
    canvas.height = data.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const img = ctx.createImageData(data.width, data.height)
    img.data.set(data.pixels)
    ctx.putImageData(img, 0, 0)
    canvas.toBlob((b) => {
      if (b) setPngUrl(URL.createObjectURL(b))
    }, "image/png")
    return () => {
      setPngUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding sprite…" />
  if (error) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
        <p className="text-sm font-medium text-foreground">
          Couldn't render this Sprite.
        </p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
      </section>
    )
  }
  const view = data!
  const pivot = (v?.m_Pivot as { x?: number; y?: number } | undefined) ?? null
  const pixelsPerUnit = asNumber(v?.m_PixelsToUnits) || null
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <div>
          <span className="text-sm font-medium text-foreground">
            {decoded.name || "(unnamed)"}
          </span>
          <span className="ml-2 text-muted-foreground">
            ({view.width}×{view.height} from {view.sourceTextureName}{" "}
            {view.sourceWidth}×{view.sourceHeight})
          </span>
        </div>
        <div>
          crop @ ({view.cropOrigin.x}, {view.cropOrigin.y})
          {pixelsPerUnit ? ` · ${pixelsPerUnit} px/unit` : ""}
          {pivot ? ` · pivot (${pivot.x}, ${pivot.y})` : ""}
        </div>
      </div>
      <div
        className="overflow-auto rounded-md border p-2"
        style={{
          // Light/dark checkerboard so transparent sprite regions
          // are visible against the surrounding card.
          backgroundColor: "#0a0a0a",
          backgroundImage:
            "linear-gradient(45deg, #1a1a1a 25%, transparent 25%), linear-gradient(-45deg, #1a1a1a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1a1a1a 75%), linear-gradient(-45deg, transparent 75%, #1a1a1a 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
        }}
      >
        <canvas
          ref={canvasRef}
          className="block max-h-[70vh] object-contain"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Cropped from `m_RD.texture` using `m_RD.textureRect`.</span>
        {pngUrl && (
          <button
            type="button"
            onClick={async () => {
              const resp = await fetch(pngUrl)
              const buf = await resp.arrayBuffer()
              downloadBlobBytes(
                new Uint8Array(buf),
                `${(decoded.name || "sprite").replace(/[^A-Za-z0-9._-]+/g, "_")}.png`,
              )
            }}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .png
          </button>
        )}
      </div>
    </section>
  )
}

/**
 * Copy a sub-rectangle out of an RGBA8 source buffer.
 *
 * `srcRowStride` is the source's full pixel width (so we know how
 * many bytes to skip per row). The crop rectangle is in source
 * pixel coordinates with the origin at the top-left — the caller
 * is responsible for any Y-axis flips before calling.
 */
function cropRgba(
  src: Uint8Array,
  srcWidth: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
): Uint8Array {
  const out = new Uint8Array(cropW * cropH * 4)
  const srcStride = srcWidth * 4
  const dstStride = cropW * 4
  for (let y = 0; y < cropH; y++) {
    const srcOff = (cropY + y) * srcStride + cropX * 4
    const dstOff = y * dstStride
    out.set(src.subarray(srcOff, srcOff + dstStride), dstOff)
  }
  return out
}

/**
 * Walk up to the SerializedFile's parent directory in the archive
 * tree and collect any sibling `.resS` files keyed by lowercase
 * basename. Mirrors `resolveUnityExternals` from the parent CAB
 * preview, but scoped to the externals a Texture2D might need
 * (`m_StreamData.path` typically references one).
 */
async function resolveTexture2DExternals(
  root: Node | null,
  cabId: string | undefined,
): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  if (!root || !cabId) return out
  const slash = cabId.lastIndexOf("/")
  if (slash <= 0) return out
  const parentId = cabId.slice(0, slash)
  const findById = async (n: Node, target: string): Promise<Node | null> => {
    if (n.id === target) return n
    if (!target.startsWith(n.id + "/") && n.id !== "") return null
    let cur: Node = n
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
  const parent = await findById(root, parentId)
  if (!parent || !parent.getChildren) return out
  const siblings =
    parent._children ?? (parent._children = await parent.getChildren())
  for (const k of siblings) {
    if (/\.ress$/i.test(k.name) && k.blob) {
      try {
        out.set(k.name.toLowerCase(), await k.blob())
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

// -------- Unity `AudioClip` (class 83) preview --------

/**
 * Render and play a Unity AudioClip. The audio bytes live in one
 * of two places:
 *
 *   - **Streamed** (Unity 5+ shipping default): `m_Resource` PPtr
 *     points to a `(source, offset, size)` window inside a sibling
 *     `.resource` file in the same bundle.
 *   - **Inline**: older bundles embed the bytes directly in
 *     `m_AudioData`.
 *
 * Once we have the bytes, the format depends on
 * `m_CompressionFormat` (and per-platform conventions):
 *
 *   - `0` PCM         → wrap in a WAV container for `<audio>`.
 *   - `1` Vorbis      → already an Ogg-Vorbis stream.
 *   - `2` ADPCM       → FSB5-wrapped, decode via existing path.
 *   - `3` MP3         → already an MP3 stream.
 *   - `5/6/7` AAC/HE-AAC → already AAC.
 *   - `9` Switch Opus → FSB5-wrapped Opus on Switch builds.
 *   - `10` ATRAC9 / `11` XMA / `12` AAC → FSB5 again.
 *
 * We sniff the first 4 bytes to confirm: `FSB5`, `OggS`, `RIFF`,
 * `ID3` / `0xFF 0xFB` (MP3). When the bytes look like raw FSB5 we
 * parse the first sample inside, decode via `decodeSampleToBlob`,
 * and play the resulting WAV / Ogg blob. Anything else gets
 * served as-is to the `<audio>` element.
 */
function UnityAudioClipPreview({
  decoded,
  root,
  cabId,
}: {
  decoded: UnityDecodedObject
  root: Node | null
  cabId: string | undefined
}) {
  const v = decoded.value as Record<string, unknown> | null
  const { loading, data, error } = useAsync(async () => {
    if (!v) throw new Error("AudioClip has no decoded value")
    const bytes = await loadUnityAudioClipBytes(v, root, cabId)
    if (!bytes || bytes.length === 0) {
      throw new Error("AudioClip resource is empty or could not be located.")
    }
    return decodeUnityAudioClip(bytes, v)
  }, [decoded.obj.pathId.toString(), cabId])

  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data?.playbackBlob) return
    const url = URL.createObjectURL(data.playbackBlob)
    setAudioUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setAudioUrl(null)
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding audio clip…" />
  if (error) {
    return (
      <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
        <p className="text-sm font-medium text-foreground">
          Couldn't decode this AudioClip.
        </p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
      </section>
    )
  }
  const view = data!
  const channels = (v?.m_Channels as number) ?? view.channels ?? 0
  const freq = (v?.m_Frequency as number) ?? view.sampleRate ?? 0
  const length = (v?.m_Length as number) ?? null
  const formatLabel = view.formatLabel
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <div>
          <span className="text-sm font-medium text-foreground">
            {decoded.name || "(unnamed)"}
          </span>
          <span className="ml-2 text-muted-foreground">({formatLabel})</span>
        </div>
        <div>
          {freq ? `${freq.toLocaleString()} Hz` : "—"} ·{" "}
          {channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels} ch`}
          {length !== null ? ` · ${formatDuration(length)}` : ""}
        </div>
      </div>
      {audioUrl ? (
        <audio controls src={audioUrl} className="w-full">
          Your browser does not support the audio element.
        </audio>
      ) : (
        <div className="text-xs text-muted-foreground">
          {view.decodeError ??
            "Browser playback isn't supported for this codec yet."}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{view.sourceLabel}</span>
        <button
          type="button"
          onClick={async () => {
            const buf = await (view.playbackBlob ??
              new Blob([view.rawBytes as BlobPart])).arrayBuffer()
            downloadBlobBytes(
              new Uint8Array(buf),
              `${(decoded.name || "audio").replace(/[^A-Za-z0-9._-]+/g, "_")}.${view.downloadExt}`,
            )
          }}
          className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
        >
          Save .{view.downloadExt}
        </button>
      </div>
    </section>
  )
}

interface UnityAudioClipView {
  rawBytes: Uint8Array
  playbackBlob: Blob | null
  formatLabel: string
  sourceLabel: string
  downloadExt: string
  channels: number | null
  sampleRate: number | null
  decodeError: string | null
}

/**
 * Resolve the raw audio bytes for a Unity AudioClip. Handles both
 * the streamed (`m_Resource` → sibling `.resource`) and inline
 * (`m_AudioData`) layouts.
 */
async function loadUnityAudioClipBytes(
  v: Record<string, unknown>,
  root: Node | null,
  cabId: string | undefined,
): Promise<Uint8Array | null> {
  // Streamed payload: m_Resource = { m_Source, m_Offset, m_Size }.
  const res = v.m_Resource as
    | {
        m_Source?: string
        m_Offset?: number | bigint
        m_Size?: number | bigint
      }
    | undefined
  if (res && typeof res.m_Source === "string" && res.m_Source.length > 0) {
    const externals = await resolveAudioClipExternals(root, cabId)
    // Unity stores `m_Source` as `archive:/CAB-…/<basename>.resource`.
    // Pull off the basename and look it up in our siblings map.
    const basename = res.m_Source.split("/").pop() ?? res.m_Source
    const blob = externals.get(basename.toLowerCase())
    if (blob) {
      const offset = Number(res.m_Offset ?? 0)
      const size = Number(res.m_Size ?? 0)
      if (size > 0) {
        const slice = blob.slice(offset, offset + size)
        return new Uint8Array(await slice.arrayBuffer())
      }
    }
  }
  // Inline payload: m_AudioData (may be Uint8Array directly from the
  // array fast-path, or `{ size, data }` from the legacy
  // TypelessData walker).
  const inline = v.m_AudioData
  if (inline instanceof Uint8Array) return inline
  if (
    inline &&
    typeof inline === "object" &&
    "data" in inline &&
    (inline as { data?: unknown }).data instanceof Uint8Array
  ) {
    return (inline as { data: Uint8Array }).data
  }
  return null
}

/**
 * Walk the archive tree to find `.resource` siblings of the CAB.
 * Same shape as `resolveTexture2DExternals` but matches the
 * AudioClip extension.
 */
async function resolveAudioClipExternals(
  root: Node | null,
  cabId: string | undefined,
): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  if (!root || !cabId) return out
  const slash = cabId.lastIndexOf("/")
  if (slash <= 0) return out
  const parentId = cabId.slice(0, slash)
  const findById = async (n: Node, target: string): Promise<Node | null> => {
    if (n.id === target) return n
    if (!target.startsWith(n.id + "/") && n.id !== "") return null
    let cur: Node = n
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
  const parent = await findById(root, parentId)
  if (!parent || !parent.getChildren) return out
  const siblings =
    parent._children ?? (parent._children = await parent.getChildren())
  for (const k of siblings) {
    if (/\.resource$/i.test(k.name) && k.blob) {
      try {
        out.set(k.name.toLowerCase(), await k.blob())
      } catch {
        /* ignore */
      }
    }
  }
  return out
}

/**
 * Sniff and decode the audio bytes into something the browser can
 * play natively. Strategy:
 *
 *   - `FSB5` magic       → parse, decode sample 0 to WAV/Ogg.
 *   - `OggS` magic       → already Ogg, play raw.
 *   - `RIFF` (WAV) magic → already WAV, play raw.
 *   - `ID3` / `0xFFFB`   → MP3, play raw.
 *   - PCM raw (no magic) → wrap in WAV using the AudioClip metadata.
 *
 * Anything else is surfaced as a download-only payload — the user
 * can save the bytes and convert offline.
 */
async function decodeUnityAudioClip(
  bytes: Uint8Array,
  v: Record<string, unknown>,
): Promise<UnityAudioClipView> {
  const channels = typeof v.m_Channels === "number" ? v.m_Channels : null
  const sampleRate = typeof v.m_Frequency === "number" ? v.m_Frequency : null
  const compressionFormat =
    typeof v.m_CompressionFormat === "number" ? v.m_CompressionFormat : -1
  const formatLabel = unityAudioFormatName(compressionFormat)
  const m4 = readMagic4(bytes)
  // FSB5
  if (m4 === 0x46534235 /* "FSB5" */) {
    try {
      const fsb5 = parseFsb5(bytes)
      if (fsb5.samples.length === 0) {
        throw new Error("FSB5 has no samples")
      }
      const sample = fsb5.samples[0]!
      let lib: FmodVorbisSetupPackets | undefined
      if (fsb5.header.mode === 15) {
        lib = await getFmodVorbisLibraryForUnity()
      }
      const decoded = await decodeSampleToBlob(sample, fsb5.header.mode, lib)
      return {
        rawBytes: bytes,
        playbackBlob: decoded.blob,
        formatLabel: `FSB5 / ${formatLabel}`,
        sourceLabel: "Decoded FSB5 sample 0 to playable WAV/Ogg.",
        downloadExt: decoded.blob.type.includes("ogg") ? "ogg" : "wav",
        channels,
        sampleRate,
        decodeError: null,
      }
    } catch (e) {
      return {
        rawBytes: bytes,
        playbackBlob: null,
        formatLabel: `FSB5 / ${formatLabel}`,
        sourceLabel: "FSB5 detected but decode failed.",
        downloadExt: "fsb",
        channels,
        sampleRate,
        decodeError: (e as Error).message,
      }
    }
  }
  // OggS
  if (m4 === 0x4f676753) {
    return {
      rawBytes: bytes,
      playbackBlob: new Blob([bytes as BlobPart], { type: "audio/ogg" }),
      formatLabel,
      sourceLabel: "Raw Ogg-Vorbis stream.",
      downloadExt: "ogg",
      channels,
      sampleRate,
      decodeError: null,
    }
  }
  // RIFF (WAV)
  if (m4 === 0x52494646) {
    return {
      rawBytes: bytes,
      playbackBlob: new Blob([bytes as BlobPart], { type: "audio/wav" }),
      formatLabel,
      sourceLabel: "Raw RIFF / WAV stream.",
      downloadExt: "wav",
      channels,
      sampleRate,
      decodeError: null,
    }
  }
  // MP3 (ID3 header or 0xFF 0xFB sync word)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  ) {
    return {
      rawBytes: bytes,
      playbackBlob: new Blob([bytes as BlobPart], { type: "audio/mpeg" }),
      formatLabel,
      sourceLabel: "Raw MP3 stream.",
      downloadExt: "mp3",
      channels,
      sampleRate,
      decodeError: null,
    }
  }
  // Raw PCM — wrap in WAV using the clip metadata.
  if (compressionFormat === 0 && channels && sampleRate) {
    const bps = typeof v.m_BitsPerSample === "number" ? v.m_BitsPerSample : 16
    const wav = wrapPcmAsWav(bytes, channels, sampleRate, bps)
    return {
      rawBytes: bytes,
      playbackBlob: new Blob([wav as BlobPart], { type: "audio/wav" }),
      formatLabel: `PCM / ${bps}-bit`,
      sourceLabel: "Raw PCM wrapped in a WAV container.",
      downloadExt: "wav",
      channels,
      sampleRate,
      decodeError: null,
    }
  }
  // Unknown — offer raw download only.
  return {
    rawBytes: bytes,
    playbackBlob: null,
    formatLabel,
    sourceLabel: "Unknown audio container; raw bytes available for download.",
    downloadExt: "bin",
    channels,
    sampleRate,
    decodeError: `Unrecognised audio magic 0x${m4.toString(16).padStart(8, "0")}`,
  }
}

function readMagic4(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0
  return (
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  )
}

/**
 * Wrap raw little-endian PCM samples as a minimal RIFF/WAV file.
 * `bitsPerSample` defaults to 16 — Unity reports it on the
 * AudioClip alongside m_Channels / m_Frequency.
 */
function wrapPcmAsWav(
  pcm: Uint8Array,
  channels: number,
  sampleRate: number,
  bitsPerSample: number,
): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  // RIFF header
  view.setUint32(0, 0x52494646, false) // "RIFF"
  view.setUint32(4, 36 + dataSize, true)
  view.setUint32(8, 0x57415645, false) // "WAVE"
  // fmt chunk
  view.setUint32(12, 0x666d7420, false) // "fmt "
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  // data chunk
  view.setUint32(36, 0x64617461, false) // "data"
  view.setUint32(40, dataSize, true)
  new Uint8Array(buf, 44).set(pcm)
  return new Uint8Array(buf)
}

/**
 * Unity `AudioCompressionFormat` enum (from `AudioImporter.cs` in
 * the Unity source). We only need it for the human-readable label
 * — actual decoding is driven off the stream magic.
 */
function unityAudioFormatName(code: number): string {
  switch (code) {
    case 0: return "PCM"
    case 1: return "Vorbis"
    case 2: return "ADPCM"
    case 3: return "MP3"
    case 4: return "PSMVAG"
    case 5: return "HEVAG"
    case 6: return "XMA"
    case 7: return "AAC"
    case 8: return "GCADPCM"
    case 9: return "ATRAC9"
    default: return code >= 0 ? `format_${code}` : "unknown"
  }
}

/**
 * Lazy-load the FMOD Vorbis setup-packets library on first use,
 * cached per page load. Mirrors the existing FmodSamplePreview
 * helper, but kept separate so this file doesn't have to expose
 * its private cache.
 */
let _fmodVorbisLibForUnity: FmodVorbisSetupPackets | null = null
let _fmodVorbisFetchForUnity: Promise<FmodVorbisSetupPackets> | null = null
async function getFmodVorbisLibraryForUnity(): Promise<FmodVorbisSetupPackets> {
  if (_fmodVorbisLibForUnity) return _fmodVorbisLibForUnity
  if (_fmodVorbisFetchForUnity) return _fmodVorbisFetchForUnity
  _fmodVorbisFetchForUnity = (async () => {
    const url = (
      await import(
        /* @vite-ignore */
        "@tootallnate/fsb5/assets/fmod_vorbis_setup_packets.bin?url"
      )
    ).default as string
    const res = await fetch(url)
    const buf = new Uint8Array(await res.arrayBuffer())
    _fmodVorbisLibForUnity = loadFmodVorbisSetupPackets(buf)
    return _fmodVorbisLibForUnity
  })()
  return _fmodVorbisFetchForUnity
}

function WemAudioPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseWemForAudioView(await node.blob!())
  }, [node.id])

  // Object URL for the decoded audio Blob (WAV or Ogg-Opus). Same
  // ownership/lifecycle pattern as `NintendoAudioPreview`.
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data || !data.decoded) return
    const url = URL.createObjectURL(data.decoded.blob)
    setAudioUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setAudioUrl(null)
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding WEM…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="WEM — Wwise Encoded Media" />

        {v.decoded ? (
          <WemAudioPlayer view={v} audioUrl={audioUrl} />
        ) : (
          <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
            <p className="text-sm font-medium">
              Browser playback isn't supported for this codec yet.
            </p>
            <p className="text-xs text-muted-foreground">
              {v.decodeError ?? "Unknown error."}
            </p>
            <p className="text-xs text-muted-foreground">
              You can still download the raw `.wem` from the toolbar above
              and convert it offline (e.g. with vgmstream / ww2ogg).
            </p>
          </section>
        )}

        <KvBlock title="Audio">
          <KvRow
            k="Codec"
            v={`${v.parsed.fmt.codecName} (0x${v.parsed.fmt.codecId.toString(16).padStart(4, "0")})`}
          />
          <KvRow k="Sample rate" v={`${v.parsed.fmt.sampleRate} Hz`} />
          <KvRow
            k="Channels"
            v={`${v.parsed.fmt.channels} (${v.parsed.fmt.channels === 1 ? "mono" : v.parsed.fmt.channels === 2 ? "stereo" : `${v.parsed.fmt.channels}-channel`})`}
          />
          <KvRow
            k="Avg bytes/s"
            v={v.parsed.fmt.avgBytesPerSec.toLocaleString()}
          />
          <KvRow k="Block align" v={String(v.parsed.fmt.blockAlign)} />
          <KvRow
            k="Bits/sample"
            v={String(v.parsed.fmt.bitsPerSample)}
          />
        </KvBlock>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Chunks
          </h3>
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full border-collapse text-xs">
              <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">ID</th>
                  <th className="px-3 py-2 font-medium">Offset</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {v.parsed.chunks.map((c) => (
                  <tr key={c.offset} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono">{c.id}</td>
                    <td className="px-3 py-2 font-mono">
                      0x{c.offset.toString(16)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {formatBytes(c.size)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}

function WemAudioPlayer({
  view,
  audioUrl,
}: {
  view: WemView
  audioUrl: string | null
}) {
  const downloadName = useMemo(() => {
    if (!view.decoded) return "wem.bin"
    return `wem_${view.parsed.fmt.codecId.toString(16)}.${view.decoded.extension}`
  }, [view])
  const decodeLabel = useMemo(() => {
    if (!view.decoded) return ""
    if (view.decoded.kind === "switch-opus-to-ogg-opus")
      return "Re-muxed Switch-Opus → Ogg-Opus (browser-native decode)"
    if (view.decoded.kind === "wwise-vorbis-to-ogg-vorbis")
      return "Rebuilt Wwise Vorbis → Ogg-Vorbis (browser-native decode, ww2ogg-style codebook reconstruction)"
    if (view.decoded.kind === "pcm-wav") return "PCM → WAV (no decode)"
    if (view.decoded.kind === "opus-passthrough")
      return "Standard Ogg-Opus (passthrough)"
    return ""
  }, [view])
  const mime = view.decoded?.blob.type ?? ""
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      {audioUrl ? (
        <audio
          src={audioUrl}
          controls
          className="w-full"
          preload="auto"
        />
      ) : (
        <Skeleton className="h-12 w-full" />
      )}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{decodeLabel}</span>
        {audioUrl && view.decoded && (
          <a
            href={audioUrl}
            download={downloadName}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .{view.decoded.extension}
          </a>
        )}
      </div>
      {mime && (
        <span className="text-[11px] text-muted-foreground/70">
          MIME: {mime}
        </span>
      )}
    </section>
  )
}

// ====================================================================
// FMOD Studio bank sample (FSB5) — audio preview
// ====================================================================

function FmodSamplePreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    const bankBlob = node.meta?.fmodBankBlob as Blob | undefined
    const sampleIndex = node.meta?.fmodSampleIndex as number | undefined
    if (!bankBlob || sampleIndex === undefined) {
      throw new Error("FMOD sample node missing bank/index metadata")
    }
    return parseFmodSampleForView(bankBlob, sampleIndex)
  }, [node.id])

  // Object URL lifecycle.
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data || !data.decoded) return
    const url = URL.createObjectURL(data.decoded.blob)
    setAudioUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setAudioUrl(null)
    }
  }, [data])

  if (loading) return <LoadingFiller label="Decoding FMOD sample…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader
          title={
            v.parsedFsb5.header.mode === 15
              ? "FMOD Vorbis sample"
              : `FMOD ${SOUND_FORMAT_NAMES[v.parsedFsb5.header.mode]} sample`
          }
        />

        {v.decoded ? (
          <FmodSampleAudioPlayer view={v} audioUrl={audioUrl} />
        ) : (
          <section className="flex flex-col gap-2 rounded-md border bg-card p-4">
            <p className="text-sm font-medium">
              Browser playback isn't supported for this codec yet.
            </p>
            <p className="text-xs text-muted-foreground">
              {v.decodeError ?? "Unknown error."}
            </p>
            <p className="text-xs text-muted-foreground">
              You can still download the raw payload and convert offline
              (e.g. via fsbtool / vgmstream).
            </p>
          </section>
        )}

        <KvBlock title="Sample">
          <KvRow k="Name" v={v.sample.name || "(unnamed)"} />
          <KvRow k="Codec" v={SOUND_FORMAT_NAMES[v.parsedFsb5.header.mode] ?? `mode_${v.parsedFsb5.header.mode}`} />
          <KvRow k="Sample rate" v={`${v.sample.frequency} Hz`} />
          <KvRow
            k="Channels"
            v={`${v.sample.channels} (${v.sample.channels === 1 ? "mono" : v.sample.channels === 2 ? "stereo" : `${v.sample.channels}-channel`})`}
          />
          <KvRow k="Total samples" v={v.sample.numSamples.toLocaleString()} />
          <KvRow
            k="Duration"
            v={`${formatDuration(v.sample.numSamples / v.sample.frequency)} (${(v.sample.numSamples / v.sample.frequency).toFixed(2)}s)`}
          />
          <KvRow k="Payload size" v={formatBytes(v.sample.data.length)} />
        </KvBlock>

        <KvBlock title="Bank">
          <KvRow k="Total samples" v={String(v.parsedFsb5.samples.length)} />
          <KvRow
            k="Encryption"
            v={
              v.bankInfo.wasEncrypted
                ? `decrypted with key for "${v.bankInfo.matchedKeyGame}"`
                : "none"
            }
          />
          {v.bankInfo.paddingBytes > 0 && (
            <KvRow k="SND padding bytes" v={String(v.bankInfo.paddingBytes)} />
          )}
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function FmodSampleAudioPlayer({
  view,
  audioUrl,
}: {
  view: FmodSampleView
  audioUrl: string | null
}) {
  const downloadName = useMemo(() => {
    if (!view.decoded) return "fmod-sample.bin"
    const safe = (view.sample.name || `sample_${view.sample.index}`).replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    )
    return `${safe}.${view.decoded.extension}`
  }, [view])
  const decodeLabel = useMemo(() => {
    if (!view.decoded) return ""
    if (view.decoded.kind === "fmod-vorbis-to-ogg-vorbis")
      return "Rebuilt FMOD Vorbis → Ogg-Vorbis (CRC32 setup-packet lookup)"
    if (view.decoded.kind === "ima-adpcm-wav") return "IMA-ADPCM → WAV"
    if (view.decoded.kind === "pcm-wav") return "PCM → WAV (no decode)"
    return ""
  }, [view])
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      {audioUrl ? (
        <audio src={audioUrl} controls className="w-full" preload="auto" />
      ) : (
        <Skeleton className="h-12 w-full" />
      )}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{decodeLabel}</span>
        {audioUrl && view.decoded && (
          <a
            href={audioUrl}
            download={downloadName}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .{view.decoded.extension}
          </a>
        )}
      </div>
      <span className="text-[11px] text-muted-foreground/70">
        MIME: {view.decoded?.blob.type ?? "—"}
      </span>
    </section>
  )
}

// ====================================================================
// BARSLIST — ARSL manifest preview
// ====================================================================

function BarslistPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBarslistForView(await node.blob!())
  }, [node.id])
  if (loading) return <LoadingFiller label="Decoding BARSLIST…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BARSLIST — Audio resource manifest" />
        <KvBlock title="Manifest">
          <KvRow k="Name" v={v.parsed.name} />
          <KvRow k="Endian" v={v.parsed.endian} />
          <KvRow k="Version" v={String(v.parsed.version)} />
          <KvRow k="Resources" v={String(v.parsed.resources.length)} />
        </KvBlock>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Resources
          </h3>
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full border-collapse text-xs">
              <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                </tr>
              </thead>
              <tbody>
                {v.parsed.resources.map((r, i) => (
                  <tr key={i} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{i}</td>
                    <td className="px-3 py-1.5 font-mono break-all">{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}

// ====================================================================
// BNVIB — Switch HD Rumble vibration pattern preview
// ====================================================================
//
// We decode the binary haptic pattern into a stereo PCM16 waveform
// (low band → left, high band → right) so the user can both *hear*
// the rumble and see the amplitude envelopes plotted alongside.

function BnvibPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBnvibForView(await node.blob!())
  }, [node.id])
  const [wavUrl, setWavUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data) return
    const url = URL.createObjectURL(data.wavBlob)
    setWavUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setWavUrl(null)
    }
  }, [data])
  if (loading) return <LoadingFiller label="Decoding rumble pattern…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BNVIB — Switch HD Rumble vibration pattern" />
        <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
          {wavUrl ? (
            <audio
              src={wavUrl}
              controls
              className="w-full"
              preload="auto"
            />
          ) : (
            <Skeleton className="h-12 w-full" />
          )}
          <div className="text-xs text-muted-foreground">
            Stereo: low band (left) and high band (right) rendered as
            sine waves at the per-sample frequency, scaled by the
            per-sample amplitude. Listen with headphones to hear the
            two bands separately.
          </div>
        </section>
        <BnvibAmplitudeChart parsed={v.parsed} />
        <KvBlock title="Vibration">
          <KvRow k="Type" v={v.parsed.typeName} />
          <KvRow k="Sample rate" v={`${v.parsed.sampleRate} Hz`} />
          <KvRow
            k="Samples"
            v={`${v.parsed.sampleCount.toLocaleString()} (${v.parsed.durationSeconds.toFixed(3)} s)`}
          />
          {v.parsed.loopStart !== null && (
            <KvRow
              k="Loop"
              v={`samples [${v.parsed.loopStart!.toLocaleString()}, ${v.parsed.loopEnd!.toLocaleString()}]`}
            />
          )}
          {v.parsed.loopWait !== null && (
            <KvRow k="Loop wait" v={`${v.parsed.loopWait} samples`} />
          )}
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

/**
 * Plot the per-band amplitude envelope as a small canvas chart.
 * X axis = sample index (compressed to fit the canvas), Y axis =
 * amplitude (0..1). Two stacked traces — low and high — give an
 * at-a-glance feel for the rumble's dynamics.
 */
function BnvibAmplitudeChart({ parsed }: { parsed: BnvibView["parsed"] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const W = canvas.width
    const H = canvas.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, W, H)
    if (parsed.sampleCount === 0) return
    // Background
    ctx.fillStyle = isDark ? "#0a0a0a" : "#fafafa"
    ctx.fillRect(0, 0, W, H)
    // Mid line
    ctx.strokeStyle = isDark ? "#27272a" : "#e4e4e7"
    ctx.beginPath()
    ctx.moveTo(0, H / 2)
    ctx.lineTo(W, H / 2)
    ctx.stroke()
    // Loop region shading (if any)
    if (parsed.loopStart !== null && parsed.loopEnd !== null) {
      const x0 = (parsed.loopStart! / parsed.sampleCount) * W
      const x1 = (parsed.loopEnd! / parsed.sampleCount) * W
      ctx.fillStyle = isDark
        ? "rgba(96, 165, 250, 0.10)"
        : "rgba(37, 99, 235, 0.08)"
      ctx.fillRect(x0, 0, x1 - x0, H)
    }
    const drawTrace = (color: string, getter: (i: number) => number) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      // Bin samples into one column per pixel.
      for (let x = 0; x < W; x++) {
        const start = Math.floor((x / W) * parsed.sampleCount)
        const end = Math.floor(((x + 1) / W) * parsed.sampleCount)
        let peak = 0
        for (let i = start; i < end; i++) {
          const a = getter(i)
          if (a > peak) peak = a
        }
        const y = H / 2 - (peak * H) / 2 + 0.5
        if (x === 0) ctx.moveTo(x + 0.5, y)
        else ctx.lineTo(x + 0.5, y)
      }
      ctx.stroke()
    }
    drawTrace(isDark ? "#60a5fa" : "#2563eb", (i) => parsed.samples[i].ampLow)
    drawTrace(isDark ? "#fb923c" : "#ea580c", (i) => parsed.samples[i].ampHigh)
  }, [parsed, isDark])
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        Amplitude envelopes
      </h3>
      <div className="rounded-md border bg-card p-3">
        <canvas
          ref={canvasRef}
          width={800}
          height={120}
          className="block w-full"
          style={{ height: "120px" }}
        />
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-sm bg-blue-500" />
            low band
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-sm bg-orange-500" />
            high band
          </span>
        </div>
      </div>
    </section>
  )
}

// ====================================================================
// BYAML — Nintendo binary YAML preview
// ====================================================================
//
// Decode to JSON and pipe through the existing Shiki JSON
// highlighter. Big files (course balloons can be ~700 KB after
// expansion) are truncated with a banner so the highlighter stays
// responsive.

const BYAML_HIGHLIGHT_LIMIT = 256 * 1024 // chars of formatted JSON

function ByamlPreview({ node }: { node: Node }) {
  const { resolvedTheme } = useTheme()
  const { loading, data, error } = useAsync(async () => {
    return parseByamlForView(await node.blob!())
  }, [node.id])
  const [highlighted, setHighlighted] = useState<string | null>(null)
  useEffect(() => {
    if (!data) {
      setHighlighted(null)
      return
    }
    let cancelled = false
    const text = data.jsonString.length > BYAML_HIGHLIGHT_LIMIT
      ? data.jsonString.slice(0, BYAML_HIGHLIGHT_LIMIT)
      : data.jsonString
    highlightCode(text, "json", resolvedTheme === "dark" ? "dark" : "light")
      .then((html) => {
        if (!cancelled) setHighlighted(html)
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null)
      })
    return () => {
      cancelled = true
    }
  }, [data, resolvedTheme])
  if (loading) return <LoadingFiller label="Decoding BYAML…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  const truncated = v.jsonString.length > BYAML_HIGHLIGHT_LIMIT
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BYAML — Nintendo binary YAML" />
        <KvBlock title="Header">
          <KvRow k="Endian" v={v.parsed.endian} />
          <KvRow k="Version" v={String(v.parsed.version)} />
          <KvRow k="Hash keys" v={String(v.parsed.hashKeys.length)} />
          <KvRow k="String values" v={String(v.parsed.values.length)} />
          <KvRow
            k="Root"
            v={
              v.parsed.root === null
                ? "(null)"
                : Array.isArray(v.parsed.root)
                  ? `array[${(v.parsed.root as unknown[]).length}]`
                  : `dict{${Object.keys(v.parsed.root as object).length}}`
            }
          />
        </KvBlock>
        {truncated && (
          <Alert>
            <AlertTitle>Tree truncated</AlertTitle>
            <AlertDescription>
              Showing the first {Math.floor(BYAML_HIGHLIGHT_LIMIT / 1024)} KB of the
              formatted JSON ({v.jsonString.length.toLocaleString()} chars total).
              Download the file to inspect the full tree.
            </AlertDescription>
          </Alert>
        )}
        <section className="flex min-h-0 flex-col">
          {highlighted ? (
            <div
              className="overflow-x-auto rounded-md border bg-card text-xs leading-relaxed [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:p-4"
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          ) : (
            <pre className="overflow-x-auto rounded-md border bg-card p-4 text-xs leading-relaxed">
              {truncated
                ? v.jsonString.slice(0, BYAML_HIGHLIGHT_LIMIT)
                : v.jsonString}
            </pre>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}

// ====================================================================
// BNTX — Nintendo texture preview
// ====================================================================
//
// Decode the texture's first layer to RGBA8, render to an offscreen
// `<canvas>`, and let the user save it as a PNG. We render against a
// checkerboard background so transparent areas are visually obvious.

function BntxPreview({ node }: { node: Node }) {
  const { loading, data, error } = useAsync(async () => {
    return parseBntxForView(await node.blob!())
  }, [node.id])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Keep a separate object URL for the "Save as PNG" download link.
  const [pngUrl, setPngUrl] = useState<string | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const w = data.texture.width
    const h = data.texture.height
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Wrap the decoded pixels in an ImageData (no copy if widths match).
    const imageData = ctx.createImageData(w, h)
    imageData.data.set(data.pixels)
    ctx.putImageData(imageData, 0, 0)
    // Encode to PNG for the download link. `toBlob` is async.
    canvas.toBlob((b) => {
      if (b) setPngUrl(URL.createObjectURL(b))
    }, "image/png")
    return () => {
      setPngUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [data])
  if (loading) return <LoadingFiller label="Decoding BNTX…" />
  if (error) return <ErrorFiller error={error} />
  const v = data!
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-5">
        <SectionHeader title="BNTX — Binary NinTeXture" />
        <BntxImageSection canvasRef={canvasRef} view={v} pngUrl={pngUrl} />
        <KvBlock title="Texture">
          <KvRow k="Name" v={v.texture.name || "(unnamed)"} />
          <KvRow k="Format" v={v.texture.formatInfo.name} />
          <KvRow k="Dimensions" v={`${v.texture.width} × ${v.texture.height} px`} />
          <KvRow k="Mip levels" v={String(v.texture.mipCount)} />
          <KvRow k="Array length" v={String(v.texture.arrayLength)} />
          <KvRow
            k="Block size"
            v={
              v.texture.formatInfo.isBcn || v.texture.formatInfo.isAstc
                ? `${v.texture.formatInfo.blkWidth} × ${v.texture.formatInfo.blkHeight} px / ${v.texture.formatInfo.bytesPerBlock} B`
                : `${v.texture.formatInfo.bytesPerBlock} B/pixel`
            }
          />
          <KvRow k="sRGB" v={v.texture.srgb ? "yes" : "no"} />
          <KvRow k="Image data size" v={formatBytes(v.texture.imageSize)} />
        </KvBlock>
        <KvBlock title="Container">
          <KvRow k="Endian" v={v.parsed.endian} />
          <KvRow k="Target" v={v.parsed.target} />
          <KvRow k="Texture count" v={String(v.parsed.textureCount)} />
        </KvBlock>
      </div>
    </ScrollArea>
  )
}

function BntxImageSection({
  canvasRef,
  view,
  pngUrl,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  view: BntxView
  pngUrl: string | null
}) {
  const downloadName = (view.texture.name || "texture") + ".png"
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div
        className="overflow-auto rounded-md border"
        // Light-and-dark transparency checkerboard so alpha is visible.
        style={{
          background:
            "repeating-conic-gradient(rgb(36, 36, 36) 0% 25%, rgb(20, 20, 20) 0% 50%) 50% / 16px 16px",
          maxHeight: "70vh",
        }}
      >
        <canvas
          ref={canvasRef}
          className="block max-w-full"
          style={{
            imageRendering:
              view.texture.width <= 256 && view.texture.height <= 256
                ? "pixelated"
                : "auto",
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Decoded {view.texture.formatInfo.name} → 8-bit RGBA ({view.texture.width} × {view.texture.height})
        </span>
        {pngUrl && (
          <a
            href={pngUrl}
            download={downloadName}
            className="rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent"
          >
            Save .png
          </a>
        )}
      </div>
    </section>
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

function KvRow({
  k,
  v,
  hint,
  mono,
}: {
  k: string
  v: string
  /**
   * Optional human-readable description shown after the value, e.g.
   * for enum decode (`1` → `Required`) or bitfield names. Rendered in
   * muted color so the raw value still reads first.
   */
  hint?: string
  mono?: boolean
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/50 py-1.5 text-sm last:border-0">
      <dt className="min-w-[180px] text-muted-foreground">{k}</dt>
      <dd className={cn("flex-1 break-all", mono && "font-mono text-xs")}>
        {v}
        {hint ? (
          <span className="ml-2 text-muted-foreground">— {hint}</span>
        ) : null}
      </dd>
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

/**
 * Drop-in replacement for {@link LoadingFiller} that shows a real
 * progress bar plus byte counts. Used for long-running decompression
 * / decryption operations (NCZ, large NCA section reads, Yaz0).
 */
function ProgressFiller({
  label,
  progress,
}: {
  label: string
  progress: ProgressEvent | null
}) {
  const pct = progressPercent(progress)
  const haveTotal =
    progress !== null &&
    (progress.bytesOutTotal !== undefined ||
      progress.bytesInTotal !== undefined)
  const bytesOut = progress?.bytesOut ?? 0
  const bytesOutTotal = progress?.bytesOutTotal
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Spinner />
      <span className="text-sm">{label}</span>
      <div className="flex w-72 max-w-[80vw] flex-col items-center gap-1.5">
        {haveTotal && pct !== null ? (
          <>
            <Progress value={pct} className="w-full" />
            <span className="font-mono text-[11px] tabular-nums">
              {formatBytesShort(bytesOut)} / {formatBytesShort(bytesOutTotal)}{" "}
              ({pct.toFixed(1)}%)
            </span>
          </>
        ) : progress !== null ? (
          <span className="font-mono text-[11px] tabular-nums">
            {formatBytesShort(bytesOut)} processed
          </span>
        ) : (
          <Skeleton className="h-3 w-40" />
        )}
      </div>
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
  blobFn: (options?: { onProgress?: OnProgress }) => Promise<Blob>
  fileName: string
}) {
  const [busy, setBusy] = useState(false)
  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const id = toast.loading(`Preparing ${fileName}…`)
    // rAF-throttled progress updates so the toast doesn't re-render
    // 60+ times a second while a multi-GB NCZ is decompressing.
    let pending: ProgressEvent | null = null
    let rafId: number | null = null
    const flush = () => {
      rafId = null
      if (!pending) return
      const e = pending
      pending = null
      const pct = progressPercent(e)
      const bytes = `${formatBytesShort(e.bytesOut)} / ${formatBytesShort(e.bytesOutTotal)}`
      const label = pct !== null
        ? `Preparing ${fileName} — ${bytes} (${pct.toFixed(1)}%)`
        : `Preparing ${fileName} — ${formatBytesShort(e.bytesOut)} processed`
      toast.loading(label, { id })
    }
    const onProgress: OnProgress = (e) => {
      pending = e
      if (rafId === null) rafId = requestAnimationFrame(flush)
    }
    try {
      const blob = await blobFn({ onProgress })
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
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
      if (rafId !== null) cancelAnimationFrame(rafId)
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
