/**
 * Keyboard-navigable archive tree following the WAI-ARIA Tree pattern.
 *
 * Standard keys (when the tree has focus):
 *
 *   ↑ / ↓     move focus to the previous / next visible row
 *   ←         if expanded, collapse; if collapsed, focus the parent
 *   →         if collapsed, expand; if already expanded, focus first child
 *   Home/End  focus the first / last visible row
 *   PgUp/PgDn move 10 rows at a time
 *   Enter     activate (toggle expand for containers, fire onSelect)
 *   Space     same as Enter
 *   a-z 0-9   type-ahead: jump to next visible row whose name starts
 *             with the typed prefix (resets after 500 ms of inactivity)
 *
 * Focus and selection are decoupled (per WAI-ARIA): arrow keys only
 * move focus. Pressing Enter / Space commits — that's what fires
 * `onSelect` and updates the preview pane. This way a user can scan
 * through a directory of NCAs without triggering AES-XTS decryption on
 * every row.
 *
 * Internally the tree owns:
 *   - `expandedIds`: which container ids the user has manually
 *     expanded (search forces additional ids open via `forcedExpandedIds`).
 *   - `focusedId`: which row currently holds the tree's single
 *     `tabIndex={0}` (per the WAI-ARIA single-tab-stop rule).
 *
 * Each render computes a flat `rows` list by walking the tree
 * top-down, skipping subtrees that aren't expanded and (when search
 * is active) hiding non-ancestors of matches. The list contains both
 * real node rows and synthetic placeholder rows (skeleton / progress
 * / error / empty) so that virtualization sees a uniform stream.
 *
 * # Virtualization
 *
 * Some archives produce tens of thousands of visible rows (e.g. FFX
 * `FFX_Data.vbf` has 34,179 entries flat). Rendering every row as a
 * React component freezes the browser. We use `@tanstack/react-virtual`
 * to render only the rows currently in the viewport (typically <30).
 *
 * Constraints this places on the implementation:
 *
 *   - Row height must be uniform — we enforce 32px via inline style.
 *     The `LoadingProgress` / error / empty placeholders share the
 *     same line so virtualization measurement stays trivial.
 *   - Per-row state cannot live in the row component (it unmounts
 *     when scrolled out of view). Lazy-load and per-container
 *     progress state are owned by the parent `FileTree`.
 *   - Programmatic focus must first `scrollToIndex` so the target
 *     row exists in the DOM, *then* `.focus()` after the next paint.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  HardDriveIcon,
  ImageIcon,
  LockIcon,
  Music2Icon,
  PackageIcon,
  TypeIcon,
} from "lucide-react"
import { Badge } from "~/components/ui/badge"
import { Progress } from "~/components/ui/progress"
import { Skeleton } from "~/components/ui/skeleton"
import type { Node } from "~/lib/archive"
import {
  formatBytesShort,
  progressPercent,
  type OnProgress,
  type ProgressEvent,
} from "~/lib/progress"
import { cn, formatBytes } from "~/lib/utils"

interface FileTreeProps {
  root: Node
  selectedId?: string
  onSelect: (node: Node) => void
  /**
   * Optional filter state. When provided AND `searchActive` is true,
   * the tree shows:
   *   - any node whose id is in `matchSet` (the actual matches),
   *   - their ancestors (so the user sees the path),
   *   - hides everything else.
   *
   * `forcedExpandedIds` lists ancestor ids that should be auto-
   * expanded regardless of the user's manual expand state.
   *
   * `matchSet` carries match positions for in-name highlighting.
   *
   * Clearing the search restores the manual expand state — that's
   * preserved because we keep `expandedIds` independent of search.
   */
  search?: SearchFilter
}

export interface SearchFilter {
  searchActive: boolean
  /** Map of node id → array of matched character indexes (for highlight). */
  matchSet: Map<string, number[]>
  /** Set of ancestor (and match) ids that must be visible / expanded. */
  visibleIds: Set<string>
  /** Subset of visibleIds that should auto-expand. */
  forcedExpandedIds: Set<string>
}

/**
 * One flat row in the rendered tree. The walker emits a mix of real
 * `node` rows and synthetic placeholder rows (a container that's
 * loading, has errored, or has no children) so the virtualizer sees
 * a single uniform stream.
 */
type Row =
  | {
      kind: "node"
      node: Node
      depth: number
      parentId: string | null
      expanded: boolean
      /** True if this is a container with no children populated yet. */
      pending: boolean
    }
  | {
      kind: "skeleton"
      /** Stable id so virtualizer keys don't collide between containers. */
      id: string
      containerId: string
      depth: number
      slot: 0 | 1 | 2
    }
  | {
      kind: "progress"
      id: string
      containerId: string
      depth: number
      progress: ProgressEvent
    }
  | {
      kind: "error"
      id: string
      containerId: string
      depth: number
      message: string
    }
  | {
      kind: "empty"
      id: string
      containerId: string
      depth: number
    }

/**
 * Fixed row height in pixels. Must match the rendered height of all
 * row variants. Computed from: `py-1.5` (12px) + content line-height
 * (~20px) = 32px. If you change any padding/text size, update this
 * AND verify the placeholder variants still fit.
 */
const ROW_HEIGHT = 32

/**
 * Number of off-screen rows to render above and below the visible
 * window. Higher = smoother scroll, more DOM. 12 strikes a good
 * balance for a tree pane.
 */
const ROW_OVERSCAN = 12

/**
 * Type-ahead buffer reset window — if the user hasn't typed a letter
 * for this many ms, the next letter starts a fresh search.
 */
const TYPEAHEAD_RESET_MS = 500

export function FileTree({
  root,
  selectedId,
  onSelect,
  search,
}: FileTreeProps) {
  // --- Centralised expansion state ---
  // Initialise with the root expanded by default — same as before
  // (when each row had its own `defaultExpanded` flag).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set([root.id]),
  )

  // Bumped whenever any pending lazy `getChildren()` resolves. The
  // children themselves are cached on the node object (`node._children`),
  // and the row walk reads them directly — but reading from a
  // mutable object doesn't trigger re-renders, so we use this
  // counter as a "data has changed, please rebuild rows" signal.
  const [loadTick, setLoadTick] = useState(0)
  const bumpLoadTick = useCallback(() => setLoadTick((n) => n + 1), [])

  // Per-container progress state for in-flight lazy loads. Lives on
  // the parent (not the row component) so it survives the row being
  // unmounted as the virtualizer scrolls.
  const [progressByContainer, setProgressByContainer] = useState<
    Map<string, ProgressEvent>
  >(() => new Map())

  // Whenever the tree root changes (user opens a new archive) reset
  // expansion + focus to a sensible default, and drop any progress
  // state from a prior archive.
  useEffect(() => {
    setExpandedIds(new Set([root.id]))
    setFocusedId(root.id)
    setProgressByContainer(new Map())
    // We deliberately exclude `setFocusedId` etc. from deps — they
    // come from useState and have stable identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // --- Centralised focus tracking ---
  // We keep a single `tabIndex={0}` row at any time; arrow keys move
  // it around. When focus leaves the tree the index is preserved so
  // tabbing back returns the user to the same row.
  const [focusedId, setFocusedId] = useState<string>(root.id)

  // We also track which row we *want* to focus programmatically (as
  // distinct from focusedId, which always reflects the current
  // single-tab-stop row). When the user presses ↓, we set this so
  // a useLayoutEffect in the next render can call `.focus()` on the
  // freshly-rendered button. Without this, calling `.focus()`
  // synchronously inside the keydown handler races against React's
  // re-render of the new row's tabIndex AND against the virtualizer
  // potentially not having rendered the target row yet.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null)

  // Per-row button refs — populated by each TreeRow on mount via the
  // `registerRef` callback. We use this to call `.focus()` after a
  // navigation key, and to scroll-into-view when needed. With
  // virtualization, rows mount/unmount as the viewport scrolls, so
  // this map will only ever contain refs for currently-visible rows.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const registerRef = useCallback(
    (id: string, el: HTMLButtonElement | null) => {
      if (el) rowRefs.current.set(id, el)
      else rowRefs.current.delete(id)
    },
    [],
  )

  // --- Compute the flat rows list ---
  //
  // Walks the tree top-down, expanding only ids in `expandedIds`
  // (or forced open by search). Uses the cached `node._children`
  // populated by the lazy loader; rows whose container is expanded
  // but whose children haven't loaded yet emit placeholder rows
  // (skeleton or progress) so the user sees feedback.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const walk = (n: Node, depth: number, parentId: string | null) => {
      const isHiddenBySearch =
        search?.searchActive && depth > 0 && !search.visibleIds.has(n.id)
      if (isHiddenBySearch) return

      const forcedOpen =
        !!search?.searchActive && search.forcedExpandedIds.has(n.id)
      const isContainer = !!n.isContainer
      const expanded = isContainer && (expandedIds.has(n.id) || forcedOpen)
      const childrenCached = n._children
      const pending = isContainer && expanded && !childrenCached

      out.push({
        kind: "node",
        node: n,
        depth,
        parentId,
        expanded,
        pending,
      })

      if (!expanded) return

      if (childrenCached) {
        if (childrenCached.length === 0 && !n._childrenError) {
          out.push({
            kind: "empty",
            id: `${n.id}::empty`,
            containerId: n.id,
            depth: depth + 1,
          })
          return
        }
        for (const child of childrenCached) walk(child, depth + 1, n.id)
        return
      }

      // Pending or errored.
      if (n._childrenError) {
        out.push({
          kind: "error",
          id: `${n.id}::error`,
          containerId: n.id,
          depth: depth + 1,
          message: n._childrenError.message,
        })
        return
      }

      const prog = progressByContainer.get(n.id)
      if (prog) {
        out.push({
          kind: "progress",
          id: `${n.id}::progress`,
          containerId: n.id,
          depth: depth + 1,
          progress: prog,
        })
      } else {
        for (const slot of [0, 1, 2] as const) {
          out.push({
            kind: "skeleton",
            id: `${n.id}::skel${slot}`,
            containerId: n.id,
            depth: depth + 1,
            slot,
          })
        }
      }
    }
    walk(root, 0, null)
    return out
    // `loadTick` is in deps so rows re-derive when a lazy expansion
    // settles. The walk reads from `node._children`, which is
    // mutated outside React; the tick is our "tree-data dirty"
    // signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, expandedIds, search, loadTick, progressByContainer])

  // Build an id-indexed lookup once per render so per-key handlers
  // can find a row in O(1). Only `node` rows are navigable — the
  // placeholder rows don't get an entry.
  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r.kind === "node") m.set(r.node.id, i)
    }
    return m
  }, [rows])

  // --- Lazy load any pending containers ---
  //
  // The walk above just emits placeholder rows for pending
  // containers; the actual `getChildren()` call lives here so it
  // survives the container row being scrolled out of view (and
  // therefore unmounted by the virtualizer). We track which loads
  // are in flight in a ref to dedupe — a pending container may
  // appear in `rows` on every re-render until the load settles.
  const inFlightLoads = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const row of rows) {
      if (row.kind !== "node") continue
      if (!row.pending) continue
      const node = row.node
      if (!node.isContainer || !node.getChildren) continue
      if (node._children || node._childrenError) continue
      if (inFlightLoads.current.has(node.id)) continue
      inFlightLoads.current.add(node.id)

      let lastProgressTs = 0
      const onProgress: OnProgress = (e) => {
        // Throttle to ~60 fps to avoid render storms on tight
        // decompression loops (e.g. NCZ-backed NCAs).
        const now = performance.now()
        if (now - lastProgressTs < 16) return
        lastProgressTs = now
        setProgressByContainer((prev) => {
          const next = new Map(prev)
          next.set(node.id, e)
          return next
        })
      }

      node
        .getChildren({ onProgress })
        .then((kids) => {
          node._children = kids
        })
        .catch((err: unknown) => {
          // Some lower-level decoders / browser stream APIs can
          // reject with non-Error values (notably `undefined` from
          // a native TransformStream when an upstream operation
          // runs out of memory). Always coerce to a real Error so
          // the UI doesn't render the literal word "undefined".
          node._childrenError =
            err instanceof Error
              ? err
              : err === undefined || err === null
                ? new Error(
                    "Operation failed without a specific error. This sometimes happens when the browser runs out of memory on multi-GB inputs.",
                  )
                : new Error(String(err))
        })
        .finally(() => {
          inFlightLoads.current.delete(node.id)
          setProgressByContainer((prev) => {
            if (!prev.has(node.id)) return prev
            const next = new Map(prev)
            next.delete(node.id)
            return next
          })
          bumpLoadTick()
        })
    }
  }, [rows, bumpLoadTick])

  // --- Type-ahead buffer ---
  const typeaheadRef = useRef<{ buffer: string; lastAt: number }>({
    buffer: "",
    lastAt: 0,
  })

  // --- Virtualization ---
  //
  // The scroll element is the Radix ScrollArea viewport mounted by
  // the parent (`App.tsx`). We attach via a callback ref on our own
  // outer div, then walk up to find the closest scrollable ancestor
  // matching `[data-radix-scroll-area-viewport]`. If for any reason
  // that's not found (Radix structure change), we fall back to the
  // nearest scrollable ancestor.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const scrollAnchorRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      setScrollEl(null)
      return
    }
    let cur: HTMLElement | null = el.parentElement
    while (cur) {
      if (cur.matches?.("[data-radix-scroll-area-viewport]")) {
        setScrollEl(cur)
        return
      }
      cur = cur.parentElement
    }
    // Fall back: nearest scrollable ancestor.
    cur = el.parentElement
    while (cur) {
      const overflowY = getComputedStyle(cur).overflowY
      if (overflowY === "auto" || overflowY === "scroll") {
        setScrollEl(cur)
        return
      }
      cur = cur.parentElement
    }
    setScrollEl(null)
  }, [])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    // Stable keys keep React reconciliation cheap as rows recycle.
    getItemKey: (i) => {
      const r = rows[i]
      return r.kind === "node" ? r.node.id : r.id
    },
  })

  // --- Navigation primitives ---

  /**
   * Move focus to the row at `targetIndex` in `rows`. No-op if out
   * of bounds, if the target is a placeholder (non-navigable), or
   * already focused.
   */
  const focusIndex = useCallback(
    (targetIndex: number) => {
      if (targetIndex < 0 || targetIndex >= rows.length) return
      const r = rows[targetIndex]
      if (r.kind !== "node") return
      const id = r.node.id
      if (id === focusedId) return
      setFocusedId(id)
      setPendingFocusId(id)
    },
    [rows, focusedId],
  )

  /**
   * Toggle expansion of a container. We don't expose this for
   * non-containers — pressing Enter on a file just selects it.
   */
  const setExpanded = useCallback((id: string, expand: boolean) => {
    setExpandedIds((prev) => {
      if (expand && prev.has(id)) return prev
      if (!expand && !prev.has(id)) return prev
      const next = new Set(prev)
      if (expand) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  /**
   * Persist the ancestor chain of `id` into the user's manual
   * expand state. Used when the user picks a node from search
   * results — clearing the search shouldn't collapse the path
   * to what they just opened.
   *
   * Node ids are slash-delimited cumulative paths, so the
   * ancestors of `a/b/c/d` are `a`, `a/b`, `a/b/c`.
   */
  const expandAncestors = useCallback((id: string) => {
    const parts = id.split("/")
    if (parts.length <= 1) return
    setExpandedIds((prev) => {
      let next: Set<string> | null = null
      let cumulative = parts[0]!
      for (let i = 1; i < parts.length; i++) {
        if (!prev.has(cumulative)) {
          if (!next) next = new Set(prev)
          next.add(cumulative)
        }
        cumulative += "/" + parts[i]
      }
      return next ?? prev
    })
  }, [])

  // When the selected node changes (e.g. via URL hash restoration
  // on boot, popstate from back/forward, or selection-from-search),
  // ensure all of its ancestors are expanded so the row is
  // actually visible. This is a no-op when the user manually
  // clicks a row (they had to expand the parent to see it, so the
  // ancestors are already in `expandedIds`).
  useEffect(() => {
    if (!selectedId) return
    expandAncestors(selectedId)
  }, [selectedId, expandAncestors])

  // After a programmatic focus change (arrow key, type-ahead, Home/End)
  // we need to (a) ensure the target row is materialized by the
  // virtualizer, then (b) call `.focus()` on its button. The two
  // operations have to happen in that order because the row's button
  // doesn't exist in the DOM until the virtualizer scrolls it into
  // view. We use a layout effect + an rAF to bridge.
  useLayoutEffect(() => {
    if (!pendingFocusId) return
    const idx = indexById.get(pendingFocusId)
    if (idx === undefined) {
      setPendingFocusId(null)
      return
    }
    // Ask the virtualizer to scroll the target into view; this also
    // forces it into the rendered window.
    virtualizer.scrollToIndex(idx, { align: "auto" })
    // The element may or may not be rendered this paint. Schedule a
    // focus attempt; retry once on the next frame if still missing.
    let frame: number | null = null
    const tryFocus = () => {
      const el = rowRefs.current.get(pendingFocusId)
      if (el) {
        el.focus({ preventScroll: true })
        setPendingFocusId(null)
        return
      }
      frame = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [pendingFocusId, indexById, virtualizer])

  // --- Single onKeyDown for the whole tree ---

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Ignore anything originating from inputs the user might have
      // mounted as a child (e.g. inline rename in the future).
      const target = e.target as HTMLElement
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return
      }
      const idx = indexById.get(focusedId)
      if (idx === undefined) return
      const row = rows[idx]
      if (row.kind !== "node") return

      // Helper: walk forward/back over rows skipping placeholders.
      const nextNodeIdx = (from: number, dir: 1 | -1): number => {
        let i = from + dir
        while (i >= 0 && i < rows.length) {
          if (rows[i].kind === "node") return i
          i += dir
        }
        return -1
      }

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()
          const n = nextNodeIdx(idx, 1)
          if (n !== -1) focusIndex(n)
          return
        }
        case "ArrowUp": {
          e.preventDefault()
          const n = nextNodeIdx(idx, -1)
          if (n !== -1) focusIndex(n)
          return
        }
        case "ArrowRight": {
          e.preventDefault()
          if (row.node.isContainer) {
            if (!row.expanded) {
              setExpanded(row.node.id, true)
            } else {
              // Already expanded: jump to first child if any.
              const firstChildIdx = nextNodeIdx(idx, 1)
              if (
                firstChildIdx !== -1 &&
                (rows[firstChildIdx] as Row & { kind: "node" }).depth >
                  row.depth
              ) {
                focusIndex(firstChildIdx)
              }
            }
          }
          return
        }
        case "ArrowLeft": {
          e.preventDefault()
          if (row.node.isContainer && row.expanded) {
            setExpanded(row.node.id, false)
          } else if (row.parentId) {
            const parentIdx = indexById.get(row.parentId)
            if (parentIdx !== undefined) focusIndex(parentIdx)
          }
          return
        }
        case "Home": {
          e.preventDefault()
          // First navigable row.
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].kind === "node") {
              focusIndex(i)
              break
            }
          }
          return
        }
        case "End": {
          e.preventDefault()
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].kind === "node") {
              focusIndex(i)
              break
            }
          }
          return
        }
        case "PageDown": {
          e.preventDefault()
          let target = idx
          for (let n = 0; n < 10; n++) {
            const next = nextNodeIdx(target, 1)
            if (next === -1) break
            target = next
          }
          focusIndex(target)
          return
        }
        case "PageUp": {
          e.preventDefault()
          let target = idx
          for (let n = 0; n < 10; n++) {
            const prev = nextNodeIdx(target, -1)
            if (prev === -1) break
            target = prev
          }
          focusIndex(target)
          return
        }
        case "Enter":
        case " ": {
          e.preventDefault()
          if (row.node.isContainer) {
            setExpanded(row.node.id, !row.expanded)
          }
          if (search?.searchActive) {
            expandAncestors(row.node.id)
          }
          onSelect(row.node)
          return
        }
        default:
          break
      }

      // --- Type-ahead ---
      // Single printable character (letters / digits / dot) advances
      // the buffer; any non-printable key resets it.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = performance.now()
        const ta = typeaheadRef.current
        const ch = e.key.toLowerCase()
        const expired = now - ta.lastAt > TYPEAHEAD_RESET_MS
        const wasFreshReset = expired || ta.buffer.length === 0
        if (expired) ta.buffer = ""
        ta.buffer += ch
        ta.lastAt = now
        // Cycling behaviour:
        //  - Single-letter, freshly reset → include the focused row
        //    (so first press of `f` while standing on `foo.txt`
        //    keeps focus on `foo.txt`).
        //  - Single-letter repeat within the window → skip past the
        //    focused row to cycle through siblings.
        //  - Multi-letter buffer (refining) → always include the
        //    current row (so `f` then `fo` doesn't skip to a later
        //    `fo*`).
        const includeCurrent =
          ta.buffer.length > 1 || (wasFreshReset && ta.buffer.length === 1)
        const matchIdx = findTypeaheadMatch(
          rows,
          idx,
          ta.buffer,
          includeCurrent,
        )
        if (matchIdx !== -1) {
          e.preventDefault()
          focusIndex(matchIdx)
        }
      }
    },
    [
      focusedId,
      focusIndex,
      indexById,
      onSelect,
      setExpanded,
      expandAncestors,
      rows,
      search?.searchActive,
    ],
  )

  // If the focused row is no longer in `rows` (because an ancestor
  // was collapsed), shift focus to the closest visible ancestor
  // instead. This keeps the tree's tab stop alive even after
  // structural changes.
  useEffect(() => {
    if (indexById.has(focusedId)) return
    setFocusedId(root.id)
  }, [indexById, focusedId, root.id])

  // --- Render ---
  //
  // We render in two layers:
  //   1. An empty anchor div whose only purpose is to hand
  //      `scrollAnchorRef` a node from which to walk up to the
  //      Radix scroll viewport.
  //   2. The virtualizer's spacer (full content height) with
  //      absolutely-positioned row elements at their measured
  //      offsets.
  //
  // The outer `<div role="tree">` owns the keyboard handler. We
  // forego the `<ul>/<li>` markup that the previous implementation
  // used — with absolute positioning the list semantics get
  // confusing for screen readers, and `role="tree" + role="treeitem"`
  // alone is the canonical pattern for flat-rendered trees per
  // WAI-ARIA practices.

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  // Per-row `aria-setsize` + `aria-posinset`. The flat list makes
  // these awkward to compute on demand, so we pre-pass once per
  // `rows` rebuild and stash the result keyed by row index.
  //
  // Algorithm: walk the flat list; for each node row at depth d, its
  // siblings are all subsequent node rows at depth d until we
  // encounter one at depth < d. Same logic backwards for posinset.
  const ariaInfo = useMemo(() => {
    const setSize = new Array<number>(rows.length).fill(0)
    const posInSet = new Array<number>(rows.length).fill(0)
    // We walk the flat list keeping a stack of "open" sibling
    // groups (one per ancestor depth). When we see a row at a
    // greater depth, we push a new group. When we see a row at
    // shallower depth, we pop all groups deeper than the current
    // depth — their final length backfills setSize for all rows
    // in the group.
    type Frame = { depth: number; indices: number[] }
    const open: Frame[] = []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r.kind !== "node") continue
      while (open.length > 0 && open[open.length - 1].depth > r.depth) {
        const closed = open.pop()!
        for (const idx of closed.indices) setSize[idx] = closed.indices.length
      }
      let frame: Frame | undefined = open[open.length - 1]
      if (!frame || frame.depth !== r.depth) {
        frame = { depth: r.depth, indices: [] }
        open.push(frame)
      }
      frame.indices.push(i)
      posInSet[i] = frame.indices.length
    }
    while (open.length > 0) {
      const closed = open.pop()!
      for (const idx of closed.indices) setSize[idx] = closed.indices.length
    }
    return { setSize, posInSet }
  }, [rows])

  return (
    <div
      onKeyDown={handleKeyDown}
      role="tree"
      className="text-sm"
      ref={scrollAnchorRef}
    >
      <div
        style={{
          height: totalSize,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((vi) => {
          const row = rows[vi.index]
          const style: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: ROW_HEIGHT,
            transform: `translateY(${vi.start}px)`,
          }
          if (row.kind === "node") {
            return (
              <TreeRow
                key={vi.key}
                row={row}
                style={style}
                isFocused={row.node.id === focusedId}
                isSelected={row.node.id === selectedId}
                setSize={ariaInfo.setSize[vi.index] || 1}
                posInSet={ariaInfo.posInSet[vi.index] || 1}
                registerRef={registerRef}
                onClick={() => {
                  setFocusedId(row.node.id)
                  if (row.node.isContainer) {
                    setExpanded(row.node.id, !row.expanded)
                  }
                  // When picking from within search results, persist
                  // the ancestor chain into the manual expand state
                  // so clearing the search doesn't collapse the path
                  // back to the selected node.
                  if (search?.searchActive) {
                    expandAncestors(row.node.id)
                  }
                  onSelect(row.node)
                }}
                search={search}
              />
            )
          }
          if (row.kind === "skeleton") {
            return (
              <SkeletonRow key={vi.key} style={style} depth={row.depth} />
            )
          }
          if (row.kind === "progress") {
            return (
              <ProgressRow
                key={vi.key}
                style={style}
                depth={row.depth}
                progress={row.progress}
              />
            )
          }
          if (row.kind === "error") {
            return (
              <ErrorRow
                key={vi.key}
                style={style}
                depth={row.depth}
                message={row.message}
              />
            )
          }
          // empty
          return <EmptyRow key={vi.key} style={style} depth={row.depth} />
        })}
      </div>
    </div>
  )
}

interface TreeRowProps {
  row: Row & { kind: "node" }
  style: React.CSSProperties
  isFocused: boolean
  isSelected: boolean
  setSize: number
  posInSet: number
  registerRef: (id: string, el: HTMLButtonElement | null) => void
  onClick: () => void
  search?: SearchFilter
}

function TreeRow({
  row,
  style,
  isFocused,
  isSelected,
  setSize,
  posInSet,
  registerRef,
  onClick,
  search,
}: TreeRowProps) {
  const { node, depth, expanded } = row

  const indent = `calc(${depth * 1.0}rem + 0.5rem)`

  const matchIndexes = search?.matchSet.get(node.id)
  const name = matchIndexes
    ? renderHighlighted(node.name, matchIndexes, isSelected)
    : node.name

  return (
    <div
      style={style}
      role="treeitem"
      aria-expanded={node.isContainer ? expanded : undefined}
      aria-level={depth + 1}
      aria-setsize={setSize}
      aria-posinset={posInSet}
    >
      <button
        ref={(el) => registerRef(node.id, el)}
        type="button"
        // Single-tab-stop pattern: only the focused row participates
        // in the page's tab order. Shift+Tab / Tab move focus into
        // and out of the tree as a unit.
        tabIndex={isFocused ? 0 : -1}
        data-selected={isSelected || undefined}
        onClick={onClick}
        className={cn(
          "group/row flex h-full w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm font-medium transition-colors",
          "hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          "data-[selected]:bg-primary data-[selected]:text-primary-foreground",
          "data-[selected]:hover:bg-primary/95",
        )}
        style={{ paddingLeft: indent }}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            !node.isContainer && "invisible",
            expanded && "rotate-90",
            !isSelected && "opacity-60",
          )}
        />
        <NodeIcon node={node} expanded={expanded} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {node.format && (
          <Badge
            variant={isSelected ? "outline" : "secondary"}
            className={cn(
              "shrink-0 font-mono uppercase",
              isSelected && "border-current/30 bg-primary-foreground/15 text-current",
            )}
          >
            {node.format}
          </Badge>
        )}
        {node.size !== undefined && (
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums",
              isSelected ? "opacity-80" : "text-muted-foreground",
            )}
          >
            {formatBytes(node.size)}
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * Find the next row whose name (case-insensitive) starts with the
 * type-ahead `buffer`, skipping placeholder rows. Returns -1 on no
 * match.
 *
 * `includeCurrent` controls whether the search considers the row at
 * `fromIdx`:
 *   - `true` for the first letter of a fresh type-ahead, or any
 *     refining (multi-letter) buffer — keeps focus on a row that
 *     already matches.
 *   - `false` for repeated single-letter presses within the same
 *     type-ahead window — advances past the current match so the
 *     user cycles through siblings.
 */
function findTypeaheadMatch(
  rows: Row[],
  fromIdx: number,
  buffer: string,
  includeCurrent: boolean,
): number {
  if (rows.length === 0 || buffer.length === 0) return -1
  const startOffset = includeCurrent ? 0 : 1
  for (let off = startOffset; off <= rows.length; off++) {
    const idx = (fromIdx + off) % rows.length
    const r = rows[idx]
    if (r.kind !== "node") continue
    if (r.node.name.toLowerCase().startsWith(buffer)) return idx
  }
  return -1
}

/**
 * Render a filename with the matched character ranges underlined +
 * bolded. `indexes` is an array of haystack character offsets; we
 * group consecutive offsets into spans for slightly nicer DOM.
 */
function renderHighlighted(name: string, indexes: number[], isSelected: boolean) {
  if (indexes.length === 0) return name
  const set = new Set(indexes)
  const parts: React.ReactNode[] = []
  let i = 0
  while (i < name.length) {
    const isMatch = set.has(i)
    let j = i + 1
    while (j < name.length && set.has(j) === isMatch) j++
    const slice = name.slice(i, j)
    if (isMatch) {
      parts.push(
        <span
          key={i}
          className={cn(
            "rounded-sm font-bold",
            isSelected
              ? "bg-primary-foreground/25 text-current"
              : "bg-primary/15 text-primary",
          )}
        >
          {slice}
        </span>,
      )
    } else {
      parts.push(<span key={i}>{slice}</span>)
    }
    i = j
  }
  return parts
}

// ----- Placeholder row variants -----
//
// All placeholders share the same ROW_HEIGHT so virtualization
// measurement stays trivial. Indentation matches the previous nested
// `<ul role="group">` layout: `(depth * 1rem) + 1.5rem`.

// All placeholder rows fit within ROW_HEIGHT (32px). Layout is a
// fixed-height flex container with vertically centered content, so
// rows line up with the regular TreeRow buttons above/below.

function SkeletonRow({
  style,
  depth,
}: {
  style: React.CSSProperties
  depth: number
}) {
  return (
    <div
      style={style}
      role="treeitem"
      aria-busy
      aria-level={depth + 1}
      className="flex items-center gap-2 pr-2"
    >
      <div
        className="flex h-full flex-1 items-center gap-2"
        style={{ paddingLeft: `calc(${depth * 1.0}rem + 1.5rem)` }}
      >
        <Skeleton className="size-4 shrink-0" />
        <Skeleton className="h-3.5 flex-1" />
        <Skeleton className="h-3.5 w-12 shrink-0" />
      </div>
    </div>
  )
}

function ProgressRow({
  style,
  depth,
  progress,
}: {
  style: React.CSSProperties
  depth: number
  progress: ProgressEvent
}) {
  const pct = progressPercent(progress)
  const bytes = `${formatBytesShort(progress.bytesOut)} / ${formatBytesShort(
    progress.bytesOutTotal,
  )}`
  return (
    <div
      style={style}
      role="treeitem"
      aria-busy
      aria-level={depth + 1}
      className="flex items-center gap-2 pr-2"
    >
      <div
        className="flex h-full flex-1 items-center gap-2"
        style={{ paddingLeft: `calc(${depth * 1.0}rem + 1.5rem)` }}
      >
        <span className="shrink-0 text-[11px] text-muted-foreground">
          Decompressing… {bytes}
          {pct !== null ? ` (${pct.toFixed(1)}%)` : ""}
        </span>
        {pct !== null && <Progress value={pct} className="flex-1" />}
      </div>
    </div>
  )
}

function ErrorRow({
  style,
  depth,
  message,
}: {
  style: React.CSSProperties
  depth: number
  message: string
}) {
  return (
    <div
      style={style}
      role="treeitem"
      aria-level={depth + 1}
      className="flex items-center gap-2 pr-2 text-xs text-destructive"
    >
      <div
        className="flex h-full flex-1 items-center gap-2"
        style={{ paddingLeft: `calc(${depth * 1.0}rem + 1.5rem)` }}
      >
        <AlertTriangleIcon className="size-3.5 shrink-0" />
        <span className="truncate">{message}</span>
      </div>
    </div>
  )
}

function EmptyRow({
  style,
  depth,
}: {
  style: React.CSSProperties
  depth: number
}) {
  return (
    <div
      style={style}
      role="treeitem"
      aria-level={depth + 1}
      className="flex items-center text-xs text-muted-foreground italic"
    >
      <div style={{ paddingLeft: `calc(${depth * 1.0}rem + 1.5rem)` }}>
        (empty)
      </div>
    </div>
  )
}

function NodeIcon({ node, expanded }: { node: Node; expanded: boolean }) {
  const cls = "size-4 shrink-0 opacity-80"
  if (
    node.kind === "directory" ||
    node.kind === "romfs" ||
    node.kind === "fs-directory"
  ) {
    return expanded ? <FolderOpenIcon className={cls} /> : <FolderIcon className={cls} />
  }
  if (
    node.kind === "pfs0" ||
    node.kind === "hfs0" ||
    node.kind === "xci-partition"
  ) {
    return <PackageIcon className={cls} />
  }
  if (node.kind === "nca" || node.kind === "nca-section") {
    return <LockIcon className={cls} />
  }
  if (node.kind === "archive-root") {
    return <HardDriveIcon className={cls} />
  }
  const lower = node.name.toLowerCase()
  if (
    /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/.test(lower)
  ) {
    return <ImageIcon className={cls} />
  }
  if (/\.(ttf|otf|ttc|otc|bfttf|bfotf|bffnt|woff2?)$/.test(lower)) {
    return <TypeIcon className={cls} />
  }
  if (
    /\.(wav|mp3|ogg|flac|m4a|bars|bfsar|bfstm|bfwav|bfstp|bfwar|bfbnk|bfseq|bfgrp|bfwsd|wem|bnk|pck|bank|fsb)$/.test(
      lower,
    )
  ) {
    return <Music2Icon className={cls} />
  }
  if (/\.(json|xml|txt|md|cfg|ini|toml|yml|yaml|csv|log)$/.test(lower)) {
    return <FileCode2Icon className={cls} />
  }
  return <FileTextIcon className={cls} />
}
