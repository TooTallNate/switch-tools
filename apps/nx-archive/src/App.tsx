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
import { OodleDialog } from "~/components/oodle-dialog"

import { PreviewPane } from "~/components/preview-pane"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/ui/resizable"
import { ScrollArea } from "~/components/ui/scroll-area"
import { ThemeProvider } from "~/components/theme-provider"
import {
  buildDirectoryRootNode,
  buildRootNode,
  type ArchiveContext,
  type Node,
} from "~/lib/archive"
import type { WalkedDirectory } from "~/lib/directory"
import { loadStoredKeySet } from "~/lib/keys-store"
import {
  getOodleDecompressor,
  loadStoredOodleWasm,
} from "~/lib/oodle-store"

import {
  clearHandle,
  isFileSystemAccessApiSupported,
  loadStoredHandle,
  queryHandlePermission,
  requestHandlePermission,
} from "~/lib/last-file-store"
import { readHashId, useHashId } from "~/lib/url-hash"
import type { KeySet } from "@tootallnate/nca"
import { formatBytes } from "~/lib/utils"

/**
 * What's currently open in the UI. Either a single file the user
 * picked, or an entire directory of loose files (firmware dumps,
 * unpacked NSP/XCI contents, etc.).
 */
type Opened =
  | { kind: "file"; file: File; root: Node }
  | {
      kind: "directory"
      directory: WalkedDirectory
      /** Total size summed across all files in the directory. */
      totalSize: number
      root: Node
    }

function openedDisplayName(o: Opened): string {
  return o.kind === "file" ? o.file.name : `${o.directory.name}/`
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

/**
 * Walk the tree to find a node by id, materialising lazy
 * children as needed. Returns `null` if the id doesn't exist
 * (e.g. a stale URL hash referencing a node from a different
 * archive). Identical to the `findNodeById` helper duplicated
 * in several preview components — we should extract a shared
 * lib version eventually.
 */
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

function ArchiveApp() {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [selected, setSelected] = useState<Node | null>(null)
  // Reflects the current selection in `location.hash`. The hook
  // also picks up back/forward navigations so the React state
  // stays in sync with the URL.
  const [hashId, setHashId] = useHashId()
  const [keysOpen, setKeysOpen] = useState(false)
  const [oodleOpen, setOodleOpen] = useState(false)
  const [hasOodle, setHasOodle] = useState(false)
  // (The legacy `bink2.wasm` upload flow was removed once the
  // GPL-3 cnc-ra-libs decoder was replaced with the LGPL-licensed
  // @tootallnate/ffmpeg-wasm extensions bundled inline. Bink 1 +
  // Bink 2 previews now work out of the box with no user-supplied
  // assets — see `~/lib/bink-encode.ts`.)
  const [keys, setKeys] = useState<KeySet | null>(null)
  const [reloadCounter, setReloadCounter] = useState(0)
  const [searchState, setSearchState] = useState<SearchState>({
    query: "",
    matches: [],
    walking: false,
    visited: 0,
    totalKnown: 0,
  })
  /**
   * Last-opened file handle whose IDB record we found on boot
   * but whose permission isn't currently `'granted'`. The
   * AppHeader surfaces a "Restore" button for this; clicking it
   * goes through {@link requestHandlePermission} (user gesture)
   * and then opens the file.
   */
  const [pendingRestore, setPendingRestore] = useState<{
    handle: FileSystemFileHandle
    name: string
    size: number
  } | null>(null)

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

  /**
   * Tracks whether the boot-time persistent-state loads (keys,
   * oodle) have all completed. The FSA auto-restore effect waits
   * on this so the restored file is built with keys already in
   * `keysRef` — otherwise NSP/XCI parsers that need keys
   * mid-walk would fail on the first deep navigation.
   */
  const [storesLoaded, setStoresLoaded] = useState(false)

  // Load any stored keys/oodle at startup
  useEffect(() => {
    void Promise.all([
      loadStoredKeySet().then((stored) => {
        if (stored) setKeys(stored.keySet)
      }),
      // Preload the Oodle WASM if the user uploaded one previously,
      // so the in-memory cache is warm by the time the first
      // Oodle-compressed block is read.
      loadStoredOodleWasm().then((bytes) => setHasOodle(!!bytes)),
    ]).then(() => setStoresLoaded(true))
  }, [])

  // The ArchiveContext is intentionally stable across re-renders so that
  // existing nodes' captured references stay valid when keys arrive later.
  const ctx = useMemo<ArchiveContext>(
    () => ({
      getKeys: () => keysRef.current,
      requestKeys: () => setKeysOpen(true),
      getOodleDecompressor,
      requestOodle: () => setOodleOpen(true),
    }),
    [],
  )

  /**
   * Wrapper around `setSelected` that also reflects the
   * selection into the URL hash. User-initiated selections
   * (`mode = "push"`) add a browser-history entry so back /
   * forward steps through them; programmatic selections
   * (initial boot restore, popstate handler) use `"replace"` so
   * we don't pollute history.
   */
  const selectNode = useCallback(
    (node: Node | null, mode: "push" | "replace" = "push") => {
      setSelected(node)
      setHashId(node?.id ?? null, mode)
    },
    [setHashId],
  )

  const handleOpenFile = useCallback(
    async (file: File) => {
      try {
        const root = await buildRootNode(file, file.name, ctx)
        setOpened({ kind: "file", file, root })
        // Try restoring the selection from `location.hash` (set
        // by a previous session). If the hash matches an
        // existing node, expand-and-select it. Otherwise (or
        // if no hash) just select the root. We use `replace`
        // in all cases so the initial restoration doesn't add
        // a back-navigable history entry.
        const targetId = readHashId()
        if (targetId && targetId !== root.id) {
          const node = await findNodeById(root, targetId)
          selectNode(node ?? root, "replace")
        } else {
          selectNode(root, "replace")
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Couldn't open ${file.name}`, { description: message })
      }
    },
    [ctx, selectNode],
  )

  // On boot, try to restore the previously-opened file. This is
  // gated on `storesLoaded` (keys / oodle / bink2 done loading
  // from IndexedDB) so the restored file's NCA / archive walks
  // don't trip ProdKeysMissingError or similar.
  //
  // Two restoration paths, tried in order:
  //
  //   1. **File System Access API + IndexedDB** (Chromium): if
  //      we have a stored `FileSystemFileHandle` and the
  //      permission state is `'granted'`, call `.getFile()` and
  //      open it. `'prompt'` triggers the persistent restore
  //      toast (user-gesture upgrade required); `'denied'`
  //      clears the handle.
  //
  //   2. **Static `<input>` form-restoration** (Firefox): if the
  //      file input that lives in `index.html` already has a
  //      `.files[0]` (the browser auto-filled it from the
  //      previous session BEFORE React mounted), open that.
  //      Chrome / Safari never populate this on reload.
  const restoreAttemptedRef = useRef(false)
  useEffect(() => {
    if (!storesLoaded) return
    if (restoreAttemptedRef.current) return
    restoreAttemptedRef.current = true
    let cancelled = false
    void (async () => {
      // Track whether any restore-path engaged this boot. If
      // nothing did (e.g. user wiped the file input, FSA grant
      // expired without IDB handle, fresh visit, …) we'll clear
      // any stale URL hash at the bottom — otherwise a fragment
      // from a prior session would cling to a no-file URL bar.
      // The "prompt" toast path counts as "engaged" too: the
      // user may click Reopen and we'd want the hash preserved
      // so the deep selection comes back with the file.
      let restoreEngaged = false

      // --- Path 1: FSA handle (Chromium)
      if (isFileSystemAccessApiSupported()) {
        const stored = await loadStoredHandle()
        if (cancelled) return
        if (stored) {
          const state = await queryHandlePermission(stored.handle)
          if (cancelled) return
          if (state === "granted") {
            try {
              const file = await stored.handle.getFile()
              if (!cancelled) {
                await handleOpenFile(file)
                restoreEngaged = true
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              toast.error(`Couldn't reopen ${stored.name}`, {
                description: message,
              })
              await clearHandle()
            }
          } else if (state === "denied") {
            await clearHandle()
          } else {
            // state === 'prompt' — user-gesture re-grant pending
            setPendingRestore({
              handle: stored.handle,
              name: stored.name,
              size: stored.size,
            })
            restoreEngaged = true
          }
        }
      }

      // --- Path 2: form-restored static <input> (Firefox)
      if (!restoreEngaged) {
        const el = document.getElementById(
          "nx-archive-file-input",
        ) as HTMLInputElement | null
        const restored = el?.files?.[0]
        if (restored && !cancelled) {
          await handleOpenFile(restored)
          restoreEngaged = true
        }
      }

      // --- Nothing restored: clear any stale URL hash so the
      // address bar reflects the actual "no file" app state.
      if (!cancelled && !restoreEngaged && readHashId() !== null) {
        setHashId(null, "replace")
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesLoaded])

  /**
   * Click handler used by the "Reopen last file" toast's action
   * button. MUST run inside a user-gesture event handler (Chrome
   * rejects `requestPermission` otherwise).
   */
  const handleRestoreLastFile = useCallback(async () => {
    if (!pendingRestore) return
    const state = await requestHandlePermission(pendingRestore.handle)
    if (state !== "granted") {
      if (state === "denied") {
        toast.error("Permission denied", {
          description: `Can't reopen ${pendingRestore.name}.`,
        })
        await clearHandle()
        setPendingRestore(null)
      }
      return
    }
    try {
      const file = await pendingRestore.handle.getFile()
      await handleOpenFile(file)
      setPendingRestore(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Couldn't reopen ${pendingRestore.name}`, {
        description: message,
      })
      await clearHandle()
      setPendingRestore(null)
    }
  }, [pendingRestore, handleOpenFile])

  // When we have a `pendingRestore` (Chrome-only — a stored
  // `FileSystemFileHandle` from a previous session whose
  // permission needs re-granting via user gesture), render a
  // persistent toast offering to reopen the file. The toast
  // sticks around until the user clicks Reopen, clicks Dismiss,
  // or opens a different file (in which case the IDB record is
  // overwritten and there's nothing to restore from). We use a
  // stable toast `id` so re-renders update the existing toast
  // rather than stacking new ones.
  const RESTORE_TOAST_ID = "restore-last-file"
  useEffect(() => {
    if (!pendingRestore || opened) {
      // No restore pending, OR the user already opened something
      // — dismiss any existing restore toast.
      toast.dismiss(RESTORE_TOAST_ID)
      return
    }
    toast(
      <span>
        Reopen{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-all">
          {pendingRestore.name}
        </code>
        ?
      </span>,
      {
        id: RESTORE_TOAST_ID,
        description: (
          <span className="flex items-center gap-1.5">
            <span className="font-mono tabular-nums text-foreground">
              {formatBytes(pendingRestore.size)}
            </span>
            <span className="text-muted-foreground">· last session</span>
          </span>
        ),
        duration: Infinity,
        action: {
          label: "Reopen",
          onClick: () => {
            // Sonner closes the toast after the action fires; the
            // permission upgrade runs inside this synchronous
            // click-handler frame, which is what Chrome requires.
            void handleRestoreLastFile()
          },
        },
        cancel: {
          label: "Dismiss",
          onClick: () => {
            // User explicitly opted out — drop the stored handle so
            // we don't pester them next reload.
            void clearHandle()
            setPendingRestore(null)
          },
        },
      },
    )
  }, [pendingRestore, opened, handleRestoreLastFile])

  const handleOpenDirectory = useCallback(
    async (directory: WalkedDirectory) => {
      try {
        const totalSize = directory.files.reduce(
          (s, f) => s + f.file.size,
          0,
        )
        const root = await buildDirectoryRootNode(directory, ctx)
        setOpened({ kind: "directory", directory, totalSize, root })
        // Mirror the hash-restore behaviour from `handleOpenFile`
        // so directory mounts also rehydrate the previously
        // selected node from `location.hash`.
        const targetId = readHashId()
        if (targetId && targetId !== root.id) {
          const node = await findNodeById(root, targetId)
          selectNode(node ?? root, "replace")
        } else {
          selectNode(root, "replace")
        }
        toast.success(`Opened directory ${directory.name}`, {
          description: `${directory.files.length} files · ${formatBytes(totalSize)}`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Couldn't open directory ${directory.name}`, {
          description: message,
        })
      }
    },
    [ctx, selectNode],
  )

  const handlePickerError = useCallback((err: Error) => {
    toast.error("Couldn't open", { description: err.message })
  }, [])

  const handleCloseFile = useCallback(() => {
    setOpened(null)
    setSelected(null)
    // Replace rather than push: we've also discarded the IDB
    // handle below, so a back-button click can't actually
    // restore the file we just closed. Better to leave the URL
    // looking like a fresh visit.
    setHashId(null, "replace")
    setPendingRestore(null)
    // Drop the IDB-persisted handle (Chromium) and the static
    // <input>'s value (Firefox) so the closed file doesn't
    // restore itself on the next reload.
    void clearHandle()
    const el = document.getElementById(
      "nx-archive-file-input",
    ) as HTMLInputElement | null
    if (el) el.value = ""
  }, [setHashId])

  // Keep the selection in sync with the URL hash on back/forward
  // navigation. The `useHashId` hook updates `hashId` whenever
  // the user clicks back/forward (or any other source changes
  // `location.hash`). When `hashId` no longer matches the
  // currently-selected node id, we walk the tree to find the
  // target and re-select it.
  //
  // Normally the URL is already correct (we're catching up to
  // it) so we use `setSelected` directly. The exception is when
  // the hash points to a node that doesn't exist (e.g. user
  // typed garbage into the URL bar, or the file changed between
  // sessions): we fall back to root and use `selectNode` to
  // also rewrite the hash, otherwise the bad hash would keep
  // re-triggering this effect on every render.
  useEffect(() => {
    if (!opened) return
    if ((selected?.id ?? null) === hashId) return
    let cancelled = false
    void (async () => {
      if (!hashId) {
        if (!cancelled) setSelected(opened.root)
        return
      }
      const node = await findNodeById(opened.root, hashId)
      if (cancelled) return
      if (node) {
        // Hash resolved cleanly — just align the React state,
        // URL is already correct.
        setSelected(node)
      } else {
        // Stale or garbage hash — fall back to root AND rewrite
        // the URL via `selectNode` so we don't re-loop on the
        // bad hash next render.
        selectNode(opened.root, "replace")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hashId, opened, selected?.id, selectNode])

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
        onOpenDirectory={handleOpenDirectory}
        onOpenKeys={() => setKeysOpen(true)}
        onOpenOodle={() => setOodleOpen(true)}
        onCloseFile={handleCloseFile}
        hasFile={!!opened}
        hasKeys={!!keys}
        hasOodle={hasOodle}
        currentFileName={opened ? openedDisplayName(opened) : undefined}
        currentFileSize={opened ? openedDisplaySize(opened) : undefined}
        onPickerError={handlePickerError}
      />

      <main className="flex min-h-0 flex-1 overflow-hidden">
        {!opened ? (
          <Dropzone
            onFile={handleOpenFile}
            onDirectory={handleOpenDirectory}
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
              {/*
                Override Radix's `display: table` on the inner viewport
                wrapper so the file-tree rows stay constrained to the
                visible viewport width. Without this, badges and file
                sizes get clipped on the right when the tree pane is
                narrow — `display: table` makes the wrapper size to
                its content's intrinsic width, defeating each row's
                `flex-1 truncate` on the filename.
              */}
              {/*
                Padding moved off the inner wrapper: the FileTree is
                virtualized, with rows absolutely positioned within a
                spacer the height of the full virtual content. Any
                non-zero padding around that spacer offsets the rows
                from the scroll element's top by exactly that amount,
                which throws off the virtualizer's measurement. The
                tree handles its own row indentation internally.
              */}
              <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
                <FileTree
                  key={`tree-${reloadCounter}`}
                  root={opened.root}
                  selectedId={selected?.id}
                  onSelect={(n) => selectNode(n, "push")}
                  search={searchFilter}
                />
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
              <PreviewPane
                node={selected}
                root={opened.root}
                onNavigate={(n) => selectNode(n, "push")}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </main>

      <GlobalDragOverlay
        onFile={handleOpenFile}
        onDirectory={handleOpenDirectory}
        onPickerError={handlePickerError}
      />

      <KeysDialog
        open={keysOpen}
        onOpenChange={setKeysOpen}
        onSaved={handleKeysSaved}
      />

      <OodleDialog
        open={oodleOpen}
        onOpenChange={setOodleOpen}
        onChanged={() => {
          // Sync the badge state with what was just saved.
          void loadStoredOodleWasm().then((bytes) => setHasOodle(!!bytes))
          // Force a tree re-fetch on any nodes whose previous read
          // failed with OodleMissingError; same mechanism we use for
          // ProdKeysMissingError after a keys upload.
          if (opened) invalidateNcaErrors(opened.root)
          setReloadCounter((c) => c + 1)
        }}
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
