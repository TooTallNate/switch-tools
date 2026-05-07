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
 * Each render computes a flat `visibleRows` list by walking the tree
 * top-down, skipping subtrees that aren't expanded and (when search
 * is active) hiding non-ancestors of matches. This list backs all
 * the keyboard navigation arithmetic.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
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
import { Skeleton } from "~/components/ui/skeleton"
import type { Node } from "~/lib/archive"
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

/** A flat row record produced by walking the (expanded) tree. */
interface VisibleRow {
  node: Node
  depth: number
  parentId: string | null
  expanded: boolean
  /** True if this is a container with no children populated yet. */
  pending: boolean
}

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

  // Bumped whenever any row's lazy `getChildren()` resolves. The
  // children themselves are cached on the node object (`node._children`),
  // and the visible-rows walk reads them directly — but reading from
  // a mutable object doesn't trigger re-renders, so we use this
  // counter as a "data has changed, please rebuild visibleRows" signal.
  const [loadTick, setLoadTick] = useState(0)
  const bumpLoadTick = useCallback(() => setLoadTick((n) => n + 1), [])

  // Whenever the tree root changes (user opens a new archive) reset
  // expansion + focus to a sensible default.
  useEffect(() => {
    setExpandedIds(new Set([root.id]))
    setFocusedId(root.id)
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
  // re-render of the new row's tabIndex.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null)

  // Per-row button refs — populated by each TreeRow on mount via the
  // `registerRef` callback. We use this to call `.focus()` after a
  // navigation key, and to scroll-into-view when needed.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const registerRef = useCallback(
    (id: string, el: HTMLButtonElement | null) => {
      if (el) rowRefs.current.set(id, el)
      else rowRefs.current.delete(id)
    },
    [],
  )

  // --- Compute the flat visible-rows list ---
  //
  // Walks the tree top-down, expanding only ids in `expandedIds`
  // (or forced open by search). Uses the cached `node._children`
  // populated by the lazy loader; rows whose container is expanded
  // but whose children haven't loaded yet are "pending" and
  // contribute their own row (so navigation skips past them rather
  // than getting stuck).
  const visibleRows = useMemo<VisibleRow[]>(() => {
    const out: VisibleRow[] = []
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

      out.push({ node: n, depth, parentId, expanded, pending })

      if (expanded && childrenCached) {
        for (const child of childrenCached) walk(child, depth + 1, n.id)
      }
    }
    walk(root, 0, null)
    return out
    // `loadTick` is in deps so visible rows re-derive when a lazy
    // expansion settles. The walk reads from `node._children`, which
    // is mutated outside React; the tick is our "tree-data dirty"
    // signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, expandedIds, search, loadTick])

  // Build an id-indexed lookup once per render so per-key handlers
  // can find a row in O(1).
  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < visibleRows.length; i++) {
      m.set(visibleRows[i].node.id, i)
    }
    return m
  }, [visibleRows])

  // --- Type-ahead buffer ---
  const typeaheadRef = useRef<{ buffer: string; lastAt: number }>({
    buffer: "",
    lastAt: 0,
  })

  // --- Navigation primitives ---

  /**
   * Move focus to the row at `targetIndex` in `visibleRows`.
   * No-op if out of bounds or already there.
   */
  const focusIndex = useCallback(
    (targetIndex: number) => {
      if (targetIndex < 0 || targetIndex >= visibleRows.length) return
      const id = visibleRows[targetIndex].node.id
      if (id === focusedId) return
      setFocusedId(id)
      setPendingFocusId(id)
    },
    [visibleRows, focusedId],
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

  // After a programmatic focus change (arrow key, type-ahead, Home/End)
  // re-focus the freshly-rendered row's button. useLayoutEffect runs
  // after DOM mutation but before paint, so the focus shift is
  // imperceptible.
  useLayoutEffect(() => {
    if (!pendingFocusId) return
    const el = rowRefs.current.get(pendingFocusId)
    if (el) {
      el.focus({ preventScroll: false })
      // Browsers handle `.focus({ preventScroll: false })` consistently
      // for keeping the focused row in view; no extra scrollIntoView
      // call is needed.
    }
    setPendingFocusId(null)
  }, [pendingFocusId, visibleRows])

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
      const row = visibleRows[idx]

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()
          focusIndex(idx + 1)
          return
        }
        case "ArrowUp": {
          e.preventDefault()
          focusIndex(idx - 1)
          return
        }
        case "ArrowRight": {
          e.preventDefault()
          if (row.node.isContainer) {
            if (!row.expanded) {
              setExpanded(row.node.id, true)
            } else {
              // Already expanded: jump to first child if any.
              const firstChildIdx = idx + 1
              if (
                firstChildIdx < visibleRows.length &&
                visibleRows[firstChildIdx].depth > row.depth
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
          focusIndex(0)
          return
        }
        case "End": {
          e.preventDefault()
          focusIndex(visibleRows.length - 1)
          return
        }
        case "PageDown": {
          e.preventDefault()
          focusIndex(Math.min(visibleRows.length - 1, idx + 10))
          return
        }
        case "PageUp": {
          e.preventDefault()
          focusIndex(Math.max(0, idx - 10))
          return
        }
        case "Enter":
        case " ": {
          e.preventDefault()
          if (row.node.isContainer) {
            setExpanded(row.node.id, !row.expanded)
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
          visibleRows,
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
    [focusedId, focusIndex, indexById, onSelect, setExpanded, visibleRows],
  )

  // If the focused row is no longer in `visibleRows` (because an
  // ancestor was collapsed), shift focus to the closest visible
  // ancestor instead. This keeps the tree's tab stop alive even
  // after structural changes.
  useEffect(() => {
    if (indexById.has(focusedId)) return
    // Walk up the original ancestor chain until we find one in the
    // visible set. We don't keep an explicit ancestor map, so fall
    // back to the root.
    setFocusedId(root.id)
  }, [indexById, focusedId, root.id])

  return (
    <div onKeyDown={handleKeyDown}>
      <ul role="tree" className="text-sm">
        {visibleRows.map((row) => (
          <TreeRow
            key={row.node.id}
            row={row}
            isFocused={row.node.id === focusedId}
            isSelected={row.node.id === selectedId}
            registerRef={registerRef}
            onClick={() => {
              setFocusedId(row.node.id)
              if (row.node.isContainer) {
                setExpanded(row.node.id, !row.expanded)
              }
              onSelect(row.node)
            }}
            onLoaded={bumpLoadTick}
            search={search}
          />
        ))}
      </ul>
    </div>
  )
}

interface TreeRowProps {
  row: VisibleRow
  isFocused: boolean
  isSelected: boolean
  registerRef: (id: string, el: HTMLButtonElement | null) => void
  onClick: () => void
  onLoaded: () => void
  search?: SearchFilter
}

function TreeRow({
  row,
  isFocused,
  isSelected,
  registerRef,
  onClick,
  onLoaded,
  search,
}: TreeRowProps) {
  const { node, depth, expanded, pending } = row

  // Lazy-load children when this container becomes expanded for the
  // first time. Results / errors are cached on the node object so
  // re-renders (or unmount/remount cycles under React StrictMode)
  // don't re-fetch. The walker in lib/search.ts shares the same
  // cache.
  //
  // When the load resolves we don't manage state locally (the
  // children come from the *parent's* walk over `node._children`),
  // so we just bump a tick on the parent via `onLoaded` — it
  // re-runs its visible-rows memo and our row gets re-rendered
  // with the freshly-cached children visible underneath.
  useEffect(() => {
    if (!pending || !node.isContainer || !node.getChildren) return
    if (node._children || node._childrenError) {
      // Cache already populated; nudge parent in case it hasn't
      // re-rendered yet (e.g. cache populated by the search walker).
      onLoaded()
      return
    }
    let cancelled = false
    void node
      .getChildren!()
      .then((kids) => {
        node._children = kids
        if (!cancelled) onLoaded()
      })
      .catch((err: Error) => {
        node._childrenError = err instanceof Error ? err : new Error(String(err))
        if (!cancelled) onLoaded()
      })
    return () => {
      cancelled = true
    }
  }, [pending, node, onLoaded])

  const indent = `calc(${depth * 1.0}rem + 0.5rem)`

  const matchIndexes = search?.matchSet.get(node.id)
  const name = matchIndexes
    ? renderHighlighted(node.name, matchIndexes, isSelected)
    : node.name

  return (
    <li role="treeitem" aria-expanded={node.isContainer ? expanded : undefined}>
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
          "group/row flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm font-medium transition-colors",
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

      {/* Loading / error / empty states render as faux-children just
          below the container row. They aren't part of `visibleRows`
          (so keyboard nav skips them), but they keep visual parity
          with the previous tree. */}
      {expanded && pending && !node._childrenError && (
        <ul role="group" className="flex flex-col">
          <LoadingSkeletons depth={depth + 1} />
        </ul>
      )}
      {expanded && node._childrenError && (
        <ul role="group" className="flex flex-col">
          <li
            className="flex items-start gap-2 py-1.5 pr-2 text-xs text-destructive"
            style={{ paddingLeft: `calc(${(depth + 1) * 1.0}rem + 1.5rem)` }}
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{node._childrenError.message}</span>
          </li>
        </ul>
      )}
      {expanded &&
        node._children &&
        node._children.length === 0 &&
        !node._childrenError && (
          <ul role="group" className="flex flex-col">
            <li
              className="py-1.5 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `calc(${(depth + 1) * 1.0}rem + 1.5rem)` }}
            >
              (empty)
            </li>
          </ul>
        )}
    </li>
  )
}

/**
 * Find the next visible row (wrapping around) whose name (case-
 * insensitive) starts with the type-ahead `buffer`. Returns -1 on
 * no match.
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
  rows: VisibleRow[],
  fromIdx: number,
  buffer: string,
  includeCurrent: boolean,
): number {
  if (rows.length === 0 || buffer.length === 0) return -1
  const startOffset = includeCurrent ? 0 : 1
  for (let off = startOffset; off <= rows.length; off++) {
    const idx = (fromIdx + off) % rows.length
    const name = rows[idx].node.name.toLowerCase()
    if (name.startsWith(buffer)) return idx
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

function LoadingSkeletons({ depth }: { depth: number }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-2 py-1.5 pr-2"
          style={{ paddingLeft: `calc(${depth * 1.0}rem + 1.5rem)` }}
        >
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-12 shrink-0" />
        </li>
      ))}
    </>
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
    /\.(wav|mp3|ogg|flac|m4a|bars|bfsar|bfstm|bfwav|bfstp|bfwar|bfbnk|bfseq|bfgrp|bfwsd|wem|bnk|pck)$/.test(
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
