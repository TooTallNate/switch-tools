import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { TooltipProvider } from "~/components/ui/tooltip"
import { Toaster } from "~/components/ui/sonner"
import { toast } from "sonner"

import { useDefaultLayout } from "react-resizable-panels"

import { AppHeader } from "~/components/app-header"
import { Dropzone, GlobalDragOverlay } from "~/components/dropzone"
import { FileTree, type SearchFilter } from "~/components/file-tree"
import {
  FileTreeSearch,
  type SearchState,
} from "~/components/file-tree-search"
import { KeysDialog } from "~/components/keys-dialog"
import { PreviewPane } from "~/components/preview-pane"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/ui/resizable"
import { ScrollArea } from "~/components/ui/scroll-area"
import { ThemeProvider } from "~/components/theme-provider"
import {
  buildFolderRootNode,
  buildRootNode,
  type ArchiveContext,
  type Node,
} from "~/lib/archive"
import type { WalkedFolder } from "~/lib/folder"
import { loadStoredKeySet } from "~/lib/keys-store"
import type { KeySet } from "@tootallnate/nca"
import { formatBytes } from "~/lib/utils"

/**
 * What's currently open in the UI. Either a single file the user
 * picked, or an entire folder of loose files (firmware dumps, unpacked
 * NSP/XCI contents, etc.).
 */
type Opened =
  | { kind: "file"; file: File; root: Node }
  | {
      kind: "folder"
      folder: WalkedFolder
      /** Total size summed across all files in the folder. */
      totalSize: number
      root: Node
    }

function openedDisplayName(o: Opened): string {
  return o.kind === "file" ? o.file.name : `${o.folder.name}/`
}
function openedDisplaySize(o: Opened): number {
  return o.kind === "file" ? o.file.size : o.totalSize
}

export default function App() {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={250}>
        <ArchiveApp />
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  )
}

// Stable IDs for the two main resizable panels. The persistence hook keys
// off the panel ids and the group id together.
const PANEL_TREE = "tree"
const PANEL_PREVIEW = "preview"
const LAYOUT_GROUP_ID = "nx-archive:layout"

function ArchiveApp() {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [selected, setSelected] = useState<Node | null>(null)
  const [keysOpen, setKeysOpen] = useState(false)
  const [keys, setKeys] = useState<KeySet | null>(null)
  const [reloadCounter, setReloadCounter] = useState(0)
  const [searchState, setSearchState] = useState<SearchState>({
    query: "",
    matches: [],
    walking: false,
    visited: 0,
    totalKnown: 0,
  })

  // Persist sidebar / preview widths to localStorage. The hook handles
  // serialisation; we only need to wire the returned `defaultLayout` and
  // `onLayoutChanged` callback through to `<ResizablePanelGroup>`.
  const layout = useDefaultLayout({
    id: LAYOUT_GROUP_ID,
    panelIds: [PANEL_TREE, PANEL_PREVIEW],
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  })

  // Live ref for the current KeySet. The archive tree captures `ctx`
  // by reference at build time, so its closures must read `keys` lazily
  // — through this ref — rather than from a stale snapshot.
  const keysRef = useRef<KeySet | null>(null)
  keysRef.current = keys

  // Load any stored keys at startup
  useEffect(() => {
    void loadStoredKeySet().then((stored) => {
      if (stored) setKeys(stored.keySet)
    })
  }, [])

  // The ArchiveContext is intentionally stable across re-renders so that
  // existing nodes' captured references stay valid when keys arrive later.
  const ctx = useMemo<ArchiveContext>(
    () => ({
      getKeys: () => keysRef.current,
      requestKeys: () => setKeysOpen(true),
    }),
    [],
  )

  const handleOpenFile = useCallback(
    async (file: File) => {
      try {
        const root = await buildRootNode(file, file.name, ctx)
        setOpened({ kind: "file", file, root })
        setSelected(root)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Couldn't open ${file.name}`, { description: message })
      }
    },
    [ctx],
  )

  const handleOpenFolder = useCallback(
    async (folder: WalkedFolder) => {
      try {
        const totalSize = folder.files.reduce((s, f) => s + f.file.size, 0)
        const root = await buildFolderRootNode(folder, ctx)
        setOpened({ kind: "folder", folder, totalSize, root })
        setSelected(root)
        toast.success(`Opened folder ${folder.name}`, {
          description: `${folder.files.length} files · ${formatBytes(totalSize)}`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Couldn't open folder ${folder.name}`, {
          description: message,
        })
      }
    },
    [ctx],
  )

  const handlePickerError = useCallback((err: Error) => {
    toast.error("Couldn't open", { description: err.message })
  }, [])

  const handleCloseFile = useCallback(() => {
    setOpened(null)
    setSelected(null)
  }, [])

  const handleKeysSaved = useCallback(
    (info: { keySet: KeySet; text: string } | null) => {
      setKeys(info?.keySet ?? null)
      // Drop cached error state on the existing tree so any nodes that
      // previously failed because of missing keys can be re-expanded.
      // Then bump the reload counter to remount the FileTree so the rows
      // that displayed an error pick up the cleared state.
      if (opened) invalidateNcaErrors(opened.root)
      setReloadCounter((n) => n + 1)
    },
    [opened],
  )

  // Translate the search-component output into the shape `FileTree`
  // wants: per-node match indexes, set of visible ids (matches + all
  // their ancestors), set of ids to auto-expand (the ancestors only —
  // the matched leaf doesn't need to be force-expanded).
  const searchFilter = useMemo<SearchFilter | undefined>(() => {
    if (searchState.query.trim().length === 0) return undefined
    const matchSet = new Map<string, number[]>()
    const visibleIds = new Set<string>()
    const forcedExpandedIds = new Set<string>()
    for (const match of searchState.matches) {
      matchSet.set(match.node.id, match.indexes)
      // Every id along the path is visible. The match itself is
      // visible; its ancestors are also visible AND auto-expanded
      // so the user can see where the match is.
      for (let i = 0; i < match.pathIds.length; i++) {
        const id = match.pathIds[i]
        visibleIds.add(id)
        if (i < match.pathIds.length - 1) forcedExpandedIds.add(id)
      }
    }
    return {
      searchActive: true,
      matchSet,
      visibleIds,
      forcedExpandedIds,
    }
  }, [searchState])

  return (
    <div className="flex h-full min-h-0 flex-col switch-backdrop">
      <AppHeader
        onOpenFile={handleOpenFile}
        onOpenFolder={handleOpenFolder}
        onOpenKeys={() => setKeysOpen(true)}
        onCloseFile={handleCloseFile}
        hasFile={!!opened}
        hasKeys={!!keys}
        currentFileName={opened ? openedDisplayName(opened) : undefined}
        currentFileSize={opened ? openedDisplaySize(opened) : undefined}
        onPickerError={handlePickerError}
      />

      <main className="flex min-h-0 flex-1 overflow-hidden">
        {!opened ? (
          <Dropzone
            onFile={handleOpenFile}
            onFolder={handleOpenFolder}
            onPickerError={handlePickerError}
          />
        ) : (
          <ResizablePanelGroup
            id={LAYOUT_GROUP_ID}
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <ResizablePanel
              id={PANEL_TREE}
              // react-resizable-panels v4 treats plain numbers as PIXELS;
              // strings with a "%" suffix are percentages of the group.
              defaultSize="28%"
              minSize="15%"
              maxSize="60%"
              className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card/40"
            >
              <div className="shrink-0 border-b px-3 py-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Archive contents
              </div>
              <div className="shrink-0 border-b p-2">
                <FileTreeSearch
                  root={opened.root}
                  walkVersion={reloadCounter}
                  onChange={setSearchState}
                />
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-2">
                  <FileTree
                    key={`tree-${reloadCounter}`}
                    root={opened.root}
                    selectedId={selected?.id}
                    onSelect={setSelected}
                    search={searchFilter}
                  />
                </div>
              </ScrollArea>
              {searchFilter &&
                (searchState.matches.length > 0 || searchState.walking) && (
                  <div className="shrink-0 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
                    {searchState.walking
                      ? `${searchState.matches.length} match${
                          searchState.matches.length === 1 ? "" : "es"
                        }… (searching)`
                      : `${searchState.matches.length} match${
                          searchState.matches.length === 1 ? "" : "es"
                        }`}
                  </div>
                )}
              {searchFilter &&
                !searchState.walking &&
                searchState.matches.length === 0 && (
                  <div className="shrink-0 border-t px-3 py-1.5 text-[10px] text-muted-foreground italic">
                    No matches.
                  </div>
                )}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              id={PANEL_PREVIEW}
              defaultSize="72%"
              minSize="30%"
              className="min-h-0 min-w-0 overflow-hidden bg-background"
            >
              <PreviewPane node={selected} />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </main>

      <GlobalDragOverlay
        onFile={handleOpenFile}
        onFolder={handleOpenFolder}
        onPickerError={handlePickerError}
      />

      <KeysDialog
        open={keysOpen}
        onOpenChange={setKeysOpen}
        onSaved={handleKeysSaved}
      />
    </div>
  )
}

/** Recursively drop cached children/errors so the tree re-fetches them. */
function invalidateNcaErrors(node: Node) {
  if (node._childrenError) {
    node._children = undefined
    node._childrenError = undefined
  }
  if (node._children) {
    for (const child of node._children) invalidateNcaErrors(child)
  }
}
