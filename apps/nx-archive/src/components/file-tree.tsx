import { useEffect, useState } from "react"
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
   * Clearing the search restores the manual expand state — that
   * lives per-row in `useState` and is preserved across this prop
   * toggling because the row component doesn't unmount.
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

export function FileTree({ root, selectedId, onSelect, search }: FileTreeProps) {
  return (
    <ul role="tree" className="text-sm">
      <TreeRow
        node={root}
        depth={0}
        selectedId={selectedId}
        onSelect={onSelect}
        defaultExpanded
        search={search}
      />
    </ul>
  )
}

interface TreeRowProps {
  node: Node
  depth: number
  selectedId?: string
  onSelect: (node: Node) => void
  defaultExpanded?: boolean
  search?: SearchFilter
}

function TreeRow({
  node,
  depth,
  selectedId,
  onSelect,
  defaultExpanded = false,
  search,
}: TreeRowProps) {
  const [manualExpanded, setManualExpanded] = useState(defaultExpanded)
  const [loading, setLoading] = useState(false)
  const [children, setChildren] = useState<Node[] | null>(node._children ?? null)
  const [error, setError] = useState<Error | null>(node._childrenError ?? null)

  // Search overrides expansion: any ancestor of a match expands
  // automatically, but the user's manual state is preserved for
  // when search clears.
  const forcedExpand =
    search?.searchActive && search.forcedExpandedIds.has(node.id)
  const expanded = manualExpanded || !!forcedExpand

  // Fetch children lazily on first expansion.
  //
  // Depend only on what should trigger a (re)fetch — `expanded` and `node`.
  // Putting `loading`/`children` in the dep array would re-enter the effect
  // when setLoading() runs, and StrictMode's mount/unmount/remount would
  // cancel the first in-flight promise, leaving the row stuck on skeletons.
  //
  // Result and error are cached on the node itself so that StrictMode's
  // remount can pick up the result of the previous (cancelled) attempt
  // without re-fetching. The same cache is shared with the search walker
  // (lib/search.ts), so a search expansion populates these and the tree
  // re-renders without a duplicate fetch.
  useEffect(() => {
    if (!expanded || !node.isContainer || !node.getChildren) return

    // Cached: hydrate state and skip the fetch.
    if (node._children) {
      setChildren(node._children)
      setLoading(false)
      return
    }
    if (node._childrenError) {
      setError(node._childrenError)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    void node
      .getChildren!()
      .then((kids) => {
        node._children = kids
        if (cancelled) return
        setChildren(kids)
        setLoading(false)
      })
      .catch((err: Error) => {
        node._childrenError = err instanceof Error ? err : new Error(String(err))
        if (cancelled) return
        setError(node._childrenError)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [expanded, node])

  const isSelected = selectedId === node.id

  // Filter visibility: when search is active, only show nodes whose
  // id is in `visibleIds` (the union of matches and their ancestors).
  // The root is always visible regardless.
  const isHiddenBySearch =
    search?.searchActive && depth > 0 && !search.visibleIds.has(node.id)
  if (isHiddenBySearch) return null

  const toggle = () => {
    if (node.isContainer) setManualExpanded((e) => !e)
    onSelect(node)
  }

  // Indent calculation — leave room on the left for the chevron
  const indent = `calc(${depth * 1.0}rem + 0.5rem)`

  // Build the displayed name with highlight ranges if this row is
  // a match.
  const matchIndexes = search?.matchSet.get(node.id)
  const name = matchIndexes
    ? renderHighlighted(node.name, matchIndexes, isSelected)
    : node.name

  return (
    <li role="treeitem" aria-expanded={node.isContainer ? expanded : undefined}>
      <button
        type="button"
        data-selected={isSelected || undefined}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" && node.isContainer) {
            e.preventDefault()
            setManualExpanded(true)
          }
          if (e.key === "ArrowLeft" && node.isContainer) {
            e.preventDefault()
            setManualExpanded(false)
          }
        }}
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

      {expanded && (
        <ul role="group" className="flex flex-col">
          {loading && <LoadingSkeletons depth={depth + 1} />}
          {error && (
            <li
              className="flex items-start gap-2 py-1.5 pr-2 text-xs text-destructive"
              style={{ paddingLeft: `calc(${(depth + 1) * 1.0}rem + 1.5rem)` }}
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{error.message}</span>
            </li>
          )}
          {children && children.length === 0 && !loading && (
            <li
              className="py-1.5 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `calc(${(depth + 1) * 1.0}rem + 1.5rem)` }}
            >
              (empty)
            </li>
          )}
          {children?.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              search={search}
            />
          ))}
        </ul>
      )}
    </li>
  )
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
    node.kind === "fs-folder"
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
  if (/\.(ttf|otf|ttc|otc|bfttf|bfotf|woff2?)$/.test(lower)) {
    return <TypeIcon className={cls} />
  }
  if (/\.(json|xml|txt|md|cfg|ini|toml|yml|yaml|csv|log)$/.test(lower)) {
    return <FileCode2Icon className={cls} />
  }
  return <FileTextIcon className={cls} />
}
