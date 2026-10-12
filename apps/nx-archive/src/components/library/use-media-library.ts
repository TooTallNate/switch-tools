/**
 * React state for the media library of the currently opened file:
 * loads a cached index (instant on reopen), otherwise runs the
 * automatic scan in the background, merges facts learned by the
 * thumbnail pipeline into items, and persists everything.
 *
 * The scan runs in a Web Worker (`~/lib/media/scan-client`) so it never
 * blocks rendering; when workers are unavailable it falls back to the
 * in-thread scanner over the shared tree.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Node } from "~/lib/archive"
import { loadIndex, saveIndex } from "~/lib/media/cache"
import type { KeySet } from "@tootallnate/nca"

import { ScanWorkerUnavailableError, scanInWorker, scanWorkerEnabled } from "~/lib/media/scan-client"
import type { ScanSource } from "~/lib/media/scan-worker"
import { scanMedia } from "~/lib/media/scanner"
import { ThumbnailService, type ItemPatch } from "~/lib/media/thumbnails"
import { MEDIA_INDEX_VERSION, type MediaIndex } from "~/lib/media/types"

/** How often thumbnail-learned facts (durations, sizes, statuses) re-render the library. */
const PATCH_FLUSH_MS = 500

export interface ScanProgress {
  visited: number
  path: string
}

/**
 * A stable object (same identity for the life of the opened file) whose
 * fields are refreshed every render; `version` changes when they do.
 * Keeping the identity stable stops React's dev-mode performance
 * tracks from diffing / cloning a 30k-item index on every snapshot.
 */
export interface MediaLibrary {
  /** Bumped whenever any field below changes. */
  version: number
  index: MediaIndex | null
  scanning: boolean
  progress: ScanProgress | null
  /** True when the current index came from IndexedDB. */
  fromCache: boolean
  thumbs: ThumbnailService | null
  /** Rescan, optionally expanding normally-skipped containers. */
  rescan: (opts?: { include?: string[]; deep?: boolean }) => void
  cancel: () => void
}

function applyPatches(index: MediaIndex, patches: Map<string, ItemPatch>): MediaIndex {
  if (patches.size === 0) return index
  return {
    ...index,
    items: index.items.filter((it) => !patches.get(it.id)?.drop).map((it) => {
      const p = patches.get(it.id)
      if (!p) return it
      return {
        ...it,
        kind: p.kind ?? it.kind,
        status: p.status ?? it.status,
        note: p.note ?? it.note,
        info: p.info ? { ...it.info, ...p.info } : it.info,
      }
    }),
  }
}

/** What a worker scan needs from the app: the opened source, and keys / prompts. */
export interface MediaLibraryEnv {
  source: ScanSource | null
  getKeys: () => KeySet | null
  requestKeys: () => void
  requestOodle: () => void
}

export function useMediaLibrary(
  root: Node | null,
  fileKey: string | null,
  base: { fileName: string; fileSize: number } | null,
  env?: MediaLibraryEnv,
): MediaLibrary {
  const envRef = useRef(env)
  envRef.current = env
  const [raw, setRaw] = useState<MediaIndex | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [patchVersion, setPatchVersion] = useState(0)
  const patches = useRef(new Map<string, ItemPatch>())
  const abortRef = useRef<AbortController | null>(null)
  const rawRef = useRef<MediaIndex | null>(null)
  rawRef.current = raw

  const persist = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePersist = useCallback(() => {
    if (!fileKey) return
    if (persist.current) clearTimeout(persist.current)
    persist.current = setTimeout(() => {
      const idx = rawRef.current
      if (idx?.complete) void saveIndex(fileKey, applyPatches(idx, patches.current))
    }, 1500)
  }, [fileKey])

  const thumbs = useMemo(() => {
    if (!root) return null
    // Each patch re-derives the whole index (and the view re-filters it),
    // so thumbnails' facts are coalesced into one update per interval.
    let flush: ReturnType<typeof setTimeout> | null = null
    return new ThumbnailService(fileKey, root, (id, patch) => {
      const prev = patches.current.get(id)
      patches.current.set(id, { ...prev, ...patch, info: { ...prev?.info, ...patch.info } })
      if (!flush) {
        flush = setTimeout(() => {
          flush = null
          setPatchVersion((v) => v + 1)
        }, PATCH_FLUSH_MS)
      }
      schedulePersist()
    })
  }, [root, fileKey, schedulePersist])
  useEffect(() => () => thumbs?.dispose(), [thumbs])

  const runScan = useCallback(
    async (opts: { include?: string[]; deep?: boolean } = {}) => {
      if (!root || !base) return
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setScanning(true)
      setFromCache(false)
      let lastProgress = 0
      const onUpdate = (idx: MediaIndex) => {
        if (!ac.signal.aborted) setRaw(idx)
      }
      const onProgress = (visited: number, path: string) => {
        const now = performance.now()
        if (now - lastProgress > 150 && !ac.signal.aborted) {
          lastProgress = now
          setProgress({ visited, path })
        }
      }
      const inThread = () =>
        scanMedia(
          root,
          { ...base, platform: root.format ?? "file" },
          {
            signal: ac.signal,
            include: opts.include ? new Set(opts.include) : undefined,
            deep: opts.deep,
            updateIntervalMs: 1200,
            onUpdate,
            onProgress,
          },
        )
      try {
        const e = envRef.current
        let result: MediaIndex
        if (e?.source && scanWorkerEnabled()) {
          try {
            result = await scanInWorker({
              source: e.source,
              fileKey,
              keys: e.getKeys(),
              base,
              include: opts.include,
              deep: opts.deep,
              signal: ac.signal,
              onUpdate,
              onProgress,
              onRequestKeys: e.requestKeys,
              onRequestOodle: e.requestOodle,
            })
          } catch (err) {
            if (ac.signal.aborted) return
            if (!(err instanceof ScanWorkerUnavailableError)) throw err
            console.warn("Scan worker unavailable, scanning on the main thread:", err.message)
            result = await inThread()
          }
        } else {
          result = await inThread()
        }
        if (ac.signal.aborted) return
        setRaw(result)
        if (fileKey && result.complete) void saveIndex(fileKey, applyPatches(result, patches.current))
      } finally {
        if (abortRef.current === ac) {
          setScanning(false)
          setProgress(null)
        }
      }
    },
    [root, base, fileKey],
  )

  // On open: cached index first, scan when there's none (or it's stale).
  useEffect(() => {
    abortRef.current?.abort()
    patches.current = new Map()
    setRaw(null)
    setFromCache(false)
    if (!root || !base) return
    let cancelled = false
    void (async () => {
      const cached = fileKey ? await loadIndex(fileKey) : undefined
      if (cancelled) return
      if (cached && cached.version === MEDIA_INDEX_VERSION) {
        setRaw(cached)
        setFromCache(true)
        if (cached.complete) return
      }
      await runScan()
    })()
    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, fileKey])

  const index = useMemo(
    () => (raw ? applyPatches(raw, patches.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw, patchVersion],
  )

  const stable = useRef<MediaLibrary | null>(null)
  if (!stable.current) {
    stable.current = {
      version: 0,
      index: null,
      scanning: false,
      progress: null,
      fromCache: false,
      thumbs: null,
      rescan: () => {},
      cancel: () => {},
    }
  }
  const lib = stable.current
  lib.version++
  lib.index = index
  lib.scanning = scanning
  lib.progress = progress
  lib.fromCache = fromCache
  lib.thumbs = thumbs
  lib.rescan = (opts) => void runScan(opts)
  lib.cancel = () => abortRef.current?.abort()
  return lib
}
