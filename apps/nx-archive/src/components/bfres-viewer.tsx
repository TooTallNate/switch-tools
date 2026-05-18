/**
 * 3D viewer for BFRES models. Pulls geometry out of the file via
 * `@tootallnate/bfres`'s `extractGeometry` and renders each shape
 * with Three.js. The viewer auto-frames the camera to the combined
 * bounding box of all shapes and provides orbit controls (drag to
 * rotate, scroll to zoom, right-drag to pan).
 *
 * Material handling: each shape's FMAT lists a sampler-to-texture
 * binding (e.g. `_a0` → `Bird`). We resolve the `_a0` (albedo)
 * binding against the BFRES's embedded BNTX bank, decode that
 * texture to RGBA8 via `@tootallnate/bntx`, and apply it as a
 * `MeshBasicMaterial.map`. Shapes with no albedo (or whose texture
 * isn't decodable) fall back to `MeshNormalMaterial` so they still
 * render.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from "react"
import { PauseIcon, PlayIcon } from "lucide-react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import {
  evaluateCurve,
  extractAnimations,
  extractGeometry,
  extractMaterials,
  extractSkeletons,
  parseBfres,
  BoneAnimDataOffset,
  type BfresAnimations,
  type BfresGeometry,
  type BfresMaterial,
  type BfresMaterialAnimFile,
  type BfresSkeletalAnim,
  type BfresSkeleton,
} from "@tootallnate/bfres"
import {
  parseBntx,
  decodeBntxLayer,
  type BntxAstcDecoder,
  type BntxTexture,
} from "@tootallnate/bntx"

import type { Node } from "~/lib/archive"
import { getAstcBlockDecoder } from "~/lib/astc"
import {
  emitBinarySTL,
  loopSubdivide,
  sanitizeStem,
  triggerDownload,
  weldByPosition,
  type IndexedMesh,
} from "~/lib/mesh-export"

/**
 * Error boundary that contains rendering exceptions to the BFRES
 * viewer pane instead of letting them blank the entire app.
 * Covers the long tail of Three.js / WebGL surprises that aren't
 * easy to predict ahead of time (driver bugs, lost contexts during
 * Vite HMR, GLSL compile failures on niche GPUs).
 */
class BfresViewerErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error) {
      return <ViewerError error={this.state.error} />
    }
    return this.props.children
  }
}

/** Inline error display — mirrors the ErrorFiller in preview-pane.tsx. */
function ViewerError({ error }: { error: Error }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
      <div className="text-sm font-medium text-destructive">
        Could not render this BFRES
      </div>
      <div className="max-w-md text-xs text-muted-foreground">
        {error.message}
      </div>
    </div>
  )
}

interface ShapeRecord {
  geom: BfresGeometry
  /** Three.js mesh — `SkinnedMesh` for shapes with skin attrs,
   *  plain `Mesh` otherwise. Kept so we can dispose it on unmount. */
  mesh: THREE.Mesh | THREE.SkinnedMesh
  /** True iff the user has toggled this shape on. Drives renderer visibility. */
  visible: boolean
  /** Whether we successfully bound an albedo texture from the BNTX. */
  hasAlbedo: boolean
  /**
   * Original bind-pose albedo for this shape. Captured at mount
   * time so the FMAA driver can restore it when material
   * animation stops or when the user picks "(no material anim)".
   * `null` for shapes that fell back to MeshNormalMaterial.
   */
  bindAlbedo: THREE.Texture | null
}

/**
 * One Three.js scene-graph mirror of an FSKL skeleton. We build
 * one of these per FMDL: an array of `THREE.Bone` parented in a
 * hierarchy, plus a `Skeleton` carrying the inverse-bind matrices
 * for skinning. SkinnedMeshes inside the same FMDL share these
 * bones so animation drives all of them together.
 */
interface FsklSceneSkeleton {
  /** Bone array, parallel to the source `BfresSkeleton.bones`. */
  bones: THREE.Bone[]
  /** Three.js skeleton wrapper over `bones`. */
  skeleton: THREE.Skeleton
  /** Source FSKL data — the curve-driven SRT animation needs
   *  to know each bone's bind-pose values to apply curve deltas. */
  source: BfresSkeleton
  /** Root bones (no parent). Add these to the scene to get the
   *  whole skeleton in the scene graph. */
  roots: THREE.Bone[]
}

/**
 * Lazy cache for the embedded BNTX bank's textures. We split the
 * cache in two layers:
 *
 *   - `byName` — the parsed BNTX descriptor for each texture, keyed
 *     by name.
 *   - `decoded` — memoised RGBA8 pixel buffers per texture name. A
 *     decode runs once per texture; multiple shapes can then
 *     synthesise their own Three.js `DataTexture` from the same
 *     pixel buffer with different wrap modes (the underlying
 *     `Uint8ClampedArray` is shared, so this is cheap).
 *
 * Different shapes need different wrap modes — pupil meshes have
 * UVs running far outside [0, 1] and need `ClampToEdgeWrapping` so
 * out-of-range samples hit the texture's transparent border. Eye-
 * sclera meshes (e.g. Nokonoko) have UVs in `[-1, 0]` that *do*
 * need `RepeatWrapping` so the negative-U samples wrap into the
 * authored [0, 1] region. We keep one `DataTexture` per (name,
 * wrap-mode) pair.
 */
type DecodedRgba = {
  pixels: Uint8ClampedArray
  width: number
  height: number
  srgb: boolean
}

/** A single source of decodable textures (one BNTX bank). */
interface BntxBank {
  byName: Map<string, BntxTexture>
  /** Source BNTX bytes — needed to deswizzle on demand. */
  bytes: Uint8Array
}

type BntxTextureCache = {
  /**
   * Lookup-priority-ordered list of banks. Texture names are
   * resolved against each bank in order, returning the first hit.
   * The model's own embedded BNTX is index 0; companion `.Tex.*`
   * BFRES files (e.g. BotW's split layout) are appended afterwards
   * so their textures fill in for any binding the model can't
   * resolve internally.
   */
  banks: BntxBank[]
  /** Memoised pixel buffers per texture name. */
  decoded: Map<string, DecodedRgba | null>
  /** Memoised `THREE.DataTexture`s keyed by `name|wrapMode`. */
  textures: Map<string, THREE.Texture | null>
  /**
   * Pre-resolved synchronous ASTC decoder. Lazily populated by the
   * BfresViewer at mount when any bank contains an ASTC texture; left
   * undefined when no ASTC textures are present (cheap-path stays
   * cheap — no WASM load).
   *
   * BCn textures don't touch this; the absence is OK for them.
   * ASTC textures fall back to "decode failed" when this is missing,
   * which surfaces as the existing "no texture" fallback.
   */
  astcDecoder?: BntxAstcDecoder
}

/** Locate `name` across `banks`; return its `BntxTexture` + raw bytes, or null. */
function findInBanks(
  banks: BntxBank[],
  name: string,
): { tex: BntxTexture; bytes: Uint8Array } | null {
  for (const b of banks) {
    const tex = b.byName.get(name)
    if (tex) return { tex, bytes: b.bytes }
  }
  return null
}

/**
 * Parse a BFRES blob and pull its embedded BNTX bank into a
 * lookup-friendly form. Returns `null` if there's no embedded
 * BNTX, or if it fails to parse.
 */
async function loadBntxBankFromBfres(blob: Blob): Promise<BntxBank | null> {
  try {
    const parsed = await parseBfres(blob)
    const ext = parsed.embeddedBntx
    if (!ext) return null
    const bytes = new Uint8Array(await ext.data.arrayBuffer())
    const bntx = parseBntx(bytes)
    const byName = new Map<string, BntxTexture>()
    for (const tex of bntx.textures) {
      if (tex.name) byName.set(tex.name, tex)
    }
    return { byName, bytes }
  } catch {
    return null
  }
}

/**
 * Read the embedded `textures.bntx` (or equivalent) from a BFRES
 * blob and return a name-indexed cache with a single bank.
 * Companion BNTX banks (e.g. from a BotW-style `*.Tex.sbfres`)
 * can be appended later via `cache.banks.push(...)`.
 */
/**
 * True iff any texture in any of `banks` uses an ASTC compression
 * format. Used to decide whether to lazy-load the ASTC WASM decoder
 * before the (sync) `decodeBntxLayer` path runs.
 */
function banksHaveAstc(banks: BntxBank[]): boolean {
  for (const bank of banks) {
    for (const tex of bank.byName.values()) {
      if (tex.formatInfo.isAstc) return true
    }
  }
  return false
}

/**
 * If `cache.astcDecoder` isn't set yet AND any of the cache's banks
 * have ASTC textures, lazy-load the decoder and store it on the
 * cache. Used both at initial construction and after appending
 * companion `.Tex.sbfres` / shared-texture banks (which may carry
 * ASTC even when the primary bank didn't).
 */
async function ensureAstcDecoder(cache: BntxTextureCache): Promise<void> {
  if (cache.astcDecoder) return
  if (!banksHaveAstc(cache.banks)) return
  cache.astcDecoder = await getAstcBlockDecoder()
}

async function loadEmbeddedBntxTextures(
  blob: Blob,
): Promise<BntxTextureCache | null> {
  const bank = await loadBntxBankFromBfres(blob)
  if (!bank) return null
  const cache: BntxTextureCache = {
    banks: [bank],
    decoded: new Map(),
    textures: new Map(),
  }
  await ensureAstcDecoder(cache)
  return cache
}

/**
 * Resolve a node by its hierarchical id, walking from `root` and
 * expanding lazy `getChildren()` along the way. Caches expanded
 * children on the parent (`node._children`) so subsequent walks
 * don't re-expand the same containers.
 *
 * Node ids are slash-delimited paths assembled from each level's
 * stable name; segments are matched against direct children's
 * `id` (NOT against `name`, since some containers — Yaz0 + SARC
 * wrappers, IoStore — emit children whose name is the same as
 * their parent but whose id differs by a `/` suffix).
 */
async function findNodeById(root: Node, targetId: string): Promise<Node | null> {
  if (root.id === targetId) return root
  // The id of any descendant must start with the root's id +
  // separator. Bail early if not.
  if (!targetId.startsWith(root.id + "/") && root.id !== "") return null
  let cur: Node = root
  while (cur.id !== targetId) {
    if (!cur.getChildren) return null
    let kids = cur._children
    if (!kids) {
      try {
        kids = await cur.getChildren()
        cur._children = kids
      } catch {
        return null
      }
    }
    // Pick the longest-prefix-matching child. Children's ids are
    // always prefixed with the parent's id + "/" + something, but
    // there may be siblings whose ids are themselves prefixes of
    // each other (rare, but possible) so we pick the most
    // specific match.
    let best: Node | null = null
    for (const k of kids) {
      if (k.id === targetId || targetId.startsWith(k.id + "/")) {
        if (!best || k.id.length > best.id.length) best = k
      }
    }
    if (!best) return null
    cur = best
  }
  return cur
}

/**
 * Walk up a node's id to the BFRES file's logical "directory" —
 * the first ancestor that contains plain BFRES siblings. The
 * subtle bit: the user typically selects the *inner* BFRES inside
 * a Yaz0+SARC wrapper, so the immediate parent is the wrapper
 * file (`Foo.sbfres` / `Foo.szs`), and the wrapper's parent is
 * the actual model directory containing all the sibling wrappers
 * we want to scan.
 *
 * Returns the directory node, or `null` if we can't get there
 * (e.g. selected a top-level BFRES with no surrounding archive).
 */
async function findBfresSiblingDirectory(
  root: Node,
  selected: Node,
): Promise<Node | null> {
  // Build the chain of ancestors by trimming id suffixes one
  // segment at a time. Note: we can't just split on "/" because
  // ids contain literal "/" inside container names (e.g.
  // `archive/path/with/slashes`). The convention in this codebase
  // is that each level's id IS the parent's id plus "/" plus one
  // segment, so trimming the last "/foo" tail walks to the
  // parent.
  const ids: string[] = []
  let cur = selected.id
  while (cur && cur !== root.id) {
    const slash = cur.lastIndexOf("/")
    if (slash <= 0) break
    cur = cur.slice(0, slash)
    ids.push(cur)
  }
  // Try each ancestor in order (closest first). The first one
  // that has at least one BFRES-like sibling is our model dir.
  for (const id of ids) {
    const node = await findNodeById(root, id)
    if (!node || !node.getChildren) continue
    let kids = node._children
    if (!kids) {
      try {
        kids = await node.getChildren()
        node._children = kids
      } catch {
        continue
      }
    }
    let bfresLike = 0
    for (const k of kids) {
      if (/\.s?bfres(\.zs)?$/i.test(k.name)) bfresLike++
    }
    if (bfresLike >= 2) return node
  }
  return null
}

/**
 * Companion BFRES blobs sharing a name stem with the model file —
 * BotW / Splatoon / Odyssey split layouts where textures and
 * animations live next to the model rather than embedded.
 */
interface CompanionBlobs {
  textures: Blob[]
  animations: Blob[]
}

/**
 * Strip the BFRES extension chain from a filename to compare
 * stems: `Animal_Bear.sbfres` → `Animal_Bear`,
 * `Animal_Bear.Tex.sbfres` → `Animal_Bear.Tex`,
 * `Animal_Bear_Animation.bfres.zs` → `Animal_Bear_Animation`.
 */
function stripBfresExt(name: string): string {
  return name.replace(/\.s?bfres(\.zs)?$/i, "")
}

/**
 * Walk an `.sbfres` SARC wrapper down to the inner BFRES blob.
 * Most wrappers contain exactly one nested BFRES file (named
 * identically to the wrapper); some have a sibling `TexInfo.txt`
 * but no other BFRES. Returns the inner BFRES blob, or `null` if
 * the wrapper is shaped unexpectedly.
 *
 * If the node IS already a plain BFRES (no SARC wrap), we just
 * return its own blob.
 */
async function unwrapInnerBfresBlob(node: Node): Promise<Blob | null> {
  if (!node.getChildren) {
    // Leaf BFRES — its own blob is what we want.
    return node.blob ? node.blob() : null
  }
  let kids = node._children
  if (!kids) {
    try {
      kids = await node.getChildren()
      node._children = kids
    } catch {
      return null
    }
  }
  // Look for a single BFRES child (the convention).
  const inner = kids.find((k) => /\.s?bfres(\.zs)?$/i.test(k.name))
  if (!inner || !inner.blob) return null
  return inner.blob()
}

/**
 * Find companion `*.Tex.*` and `*_Animation.*` BFRES blobs that
 * match `selected`'s name stem in the same directory.
 *
 * The matchers are deliberately permissive — different titles use
 * slightly different conventions:
 *
 *   - BotW: `Foo.sbfres` ↔ `Foo.Tex.sbfres` ↔ `Foo_Animation.sbfres`.
 *   - Splatoon: `Foo.bfres` ↔ `Foo.Tex.bfres`, animations in
 *     `Foo_Anim.bfres` or grouped under a sibling directory.
 *   - Odyssey / 3D World: `Foo.szs` ↔ `Foo.Tex.szs` ↔
 *     `Foo_Animation.szs`.
 *
 * We accept any sibling whose stem starts with the model's stem
 * AND whose remaining suffix matches one of `.Tex` / `_Animation`
 * / `_Anim` / `.Animation` patterns. False positives in this
 * heuristic only cost us a parse + drop on the merge side, so
 * we err generous.
 */
async function findCompanionBfresBlobs(
  root: Node | null,
  selected: Node,
): Promise<CompanionBlobs> {
  const empty: CompanionBlobs = { textures: [], animations: [] }
  if (!root) return empty
  const dir = await findBfresSiblingDirectory(root, selected)
  if (!dir || !dir.getChildren) return empty
  let kids = dir._children
  if (!kids) {
    try {
      kids = await dir.getChildren()
      dir._children = kids
    } catch {
      return empty
    }
  }

  // Find the entry that corresponds to `selected` so we can take
  // its stem. We can't just use `selected.name` directly because
  // `selected` is the *inner* BFRES; the sibling we're scanning
  // is the *outer* SARC wrapper (same name + extension though).
  const selectedStem = stripBfresExt(selected.name)

  const textures: Blob[] = []
  const animations: Blob[] = []
  await Promise.all(
    kids.map(async (k) => {
      if (!/\.s?bfres(\.zs)?$/i.test(k.name)) return
      const stem = stripBfresExt(k.name)
      if (stem === selectedStem) return // skip self
      // Texture-companion suffixes.
      const isTexture = /^(.*?)(\.Tex|\.Texture)$/i.exec(stem)
      // Animation-companion suffixes.
      const isAnim = /^(.*?)(_Animation|_Anim|\.Animation)$/i.exec(stem)
      const matched = isTexture ?? isAnim
      if (!matched) return
      // The captured stem must match `selectedStem` exactly —
      // otherwise we'd pick up unrelated siblings that happen to
      // end in `.Tex` (e.g. `OtherModel.Tex.sbfres` when we're
      // viewing `MyModel.sbfres`).
      if (matched[1] !== selectedStem) return
      const blob = await unwrapInnerBfresBlob(k)
      if (!blob) return
      if (isTexture) textures.push(blob)
      else animations.push(blob)
    }),
  )

  return { textures, animations }
}

/**
 * Cap on how many sibling `.Tex.sbfres` archives we'll lazily
 * parse looking for missing texture names. Stops the scan from
 * running away on huge BotW-style directories with thousands of
 * Tex archives — the heuristic-prefix ranking below should land
 * the answer in the first few attempts in practice.
 */
const MAX_LAZY_TEX_SCAN = 24

/**
 * After companion-merge, BotW-style models sometimes still have
 * unresolved texture bindings that point to *shared* texture
 * archives (e.g. the Mannequin model uses `Link_Belt_A_*`
 * textures which live in a separate Link archive, not in the
 * mannequin's own `*.Tex.sbfres`). The game knows where to find
 * them via the parent actor pack's BYAML manifest, which we
 * don't load — but we can recover most cases with a heuristic
 * prefix scan.
 *
 * Approach:
 *   1. Walk every shape's material and collect the set of
 *      texture names that the model wants but the cache doesn't
 *      yet have.
 *   2. For each missing name, take its leading underscore-
 *      delimited word(s) as a prefix hint
 *      (`Link_Belt_A_Alb` → `Link`, `Link_Belt`, `Link_Belt_A`).
 *   3. Score every sibling `.Tex.sbfres` by how well its file
 *      stem matches one of those prefixes. Higher = more
 *      specific match.
 *   4. Walk the candidates in score order, parsing each BNTX
 *      header (cheap relative to full decode), and when one
 *      contains any of the still-missing names, append its bank
 *      to the cache. Stop when all names are resolved or the
 *      scan limit is hit.
 *
 * This costs at most {@link MAX_LAZY_TEX_SCAN} extra Yaz0+SARC+
 * BFRES+BNTX-header parses, all gated on at least one missing
 * texture remaining. For models where the direct companion
 * already supplies everything (most cases), no extra work runs.
 */
async function resolveSharedTextureBanks(
  root: Node | null,
  selected: Node,
  materials: BfresMaterial[][],
  cache: BntxTextureCache | null,
): Promise<BntxBank[]> {
  if (!root) return []
  // Collect missing albedo names. We only chase `_a0` (and
  // fallback `_a1`/`_a2`) bindings — normal/specular maps are
  // ignored because we don't render with them yet, so resolving
  // them would just inflate the scan budget.
  const albedoSamplers = new Set(["_a0", "_a1", "_a2"])
  const wanted = new Set<string>()
  for (const matsForModel of materials) {
    for (const m of matsForModel) {
      for (const b of m.bindings) {
        if (albedoSamplers.has(b.samplerName)) wanted.add(b.textureName)
      }
    }
  }
  // Subtract names already provided by the existing cache banks.
  if (cache) {
    for (const bank of cache.banks) {
      for (const name of wanted) {
        if (bank.byName.has(name)) wanted.delete(name)
      }
    }
  }
  if (wanted.size === 0) return []

  const dir = await findBfresSiblingDirectory(root, selected)
  if (!dir || !dir.getChildren) return []
  let kids = dir._children
  if (!kids) {
    try {
      kids = await dir.getChildren()
      dir._children = kids
    } catch {
      return []
    }
  }

  // Build the set of prefixes to score against. For each missing
  // name, take every possible underscore-delimited prefix in
  // descending specificity (longest first). E.g.
  // `Link_Belt_A_Alb` → [`Link_Belt_A_Alb`, `Link_Belt_A`,
  // `Link_Belt`, `Link`].
  const prefixes = new Set<string>()
  for (const name of wanted) {
    const parts = name.split("_")
    for (let i = parts.length; i >= 1; i--) {
      prefixes.add(parts.slice(0, i).join("_"))
    }
  }

  // Score each sibling .Tex archive. Score = length of the
  // longest prefix that matches the archive's stem (case-
  // insensitive, prefix match against the part of the stem
  // before `.Tex`). Skip the model's own companion (already
  // merged) and non-Tex files.
  const selectedStem = stripBfresExt(selected.name)
  type Candidate = { node: Node; score: number }
  const candidates: Candidate[] = []
  for (const k of kids) {
    if (!/\.s?bfres(\.zs)?$/i.test(k.name)) continue
    const stem = stripBfresExt(k.name)
    if (stem === selectedStem) continue
    const isTexture = /^(.*?)(\.Tex|\.Texture)$/i.exec(stem)
    if (!isTexture) continue
    const archiveStem = isTexture[1]!
    if (archiveStem === selectedStem) continue // already-merged direct companion
    let bestScore = 0
    const stemLower = archiveStem.toLowerCase()
    for (const p of prefixes) {
      const pLower = p.toLowerCase()
      // Match if archive stem starts with the prefix AND the
      // following character is either end-of-string or `_`
      // (so `Link_*.Tex.*` matches prefix `Link` but
      // `LinkTime.Tex.*` doesn't).
      if (
        stemLower === pLower ||
        (stemLower.startsWith(pLower) &&
          stemLower[pLower.length] === "_")
      ) {
        if (p.length > bestScore) bestScore = p.length
      }
    }
    if (bestScore > 0) candidates.push({ node: k, score: bestScore })
  }
  // Most-specific match first.
  candidates.sort((a, b) => b.score - a.score)

  const found: BntxBank[] = []
  const remaining = new Set(wanted)
  let scanned = 0
  for (const c of candidates) {
    if (remaining.size === 0) break
    if (scanned >= MAX_LAZY_TEX_SCAN) break
    scanned++
    const blob = await unwrapInnerBfresBlob(c.node).catch(() => null)
    if (!blob) continue
    const bank = await loadBntxBankFromBfres(blob)
    if (!bank) continue
    let hits = 0
    for (const name of remaining) {
      if (bank.byName.has(name)) {
        remaining.delete(name)
        hits++
      }
    }
    // Only keep banks that actually contributed at least one
    // missing texture — otherwise we'd bloat the cache (and the
    // first-hit lookup loop) with archives that just happen to
    // share a name prefix.
    if (hits > 0) found.push(bank)
  }
  return found
}

/**
 * Resolve the albedo texture for a single shape: walk the parent
 * model's material list, find the `_a0` sampler binding (or
 * `_a1` / `_a2` as a fallback for shapes that put their main map
 * in a different slot), and decode it via `@tootallnate/bntx`.
 *
 * Returns `null` if no albedo binding exists, or if the texture
 * format isn't decodable yet (the BNTX decoder only covers the
 * common subset of BC1/3/4/5/7 + uncompressed RGBA8).
 */
/**
 * Choose which FMDL is the "primary" rig for the multi-FMDL
 * cross-attachment heuristic — return its model index, or `-1` if
 * the BFRES is single-FMDL or all FMDLs are tied. Used to mount
 * single-bone secondary FMDLs (e.g. `Pupil` in MK8 character
 * BFRES) onto the primary FMDL's `Head` bone, since the BFRES
 * file itself contains no explicit cross-FMDL link (that's stored
 * in the parent SARC / BYAML config in real games).
 */
function pickPrimaryFmdl(skeletons: BfresSkeleton[]): number {
  if (skeletons.length < 2) return -1
  let best = 0
  for (let i = 1; i < skeletons.length; i++) {
    if (skeletons[i].bones.length > skeletons[best].bones.length) best = i
  }
  // Only treat the largest as "primary" if it's substantially
  // bigger than the others — avoids hijacking BFRES files that
  // legitimately contain multiple comparable models.
  for (let i = 0; i < skeletons.length; i++) {
    if (i !== best && skeletons[i].bones.length >= skeletons[best].bones.length / 2) {
      return -1
    }
  }
  return best
}

function findBone(
  skel: BfresSkeleton,
  name: string,
): { matrix: Float32Array } | null {
  const b = skel.bones.find((bb) => bb.name === name)
  return b ? { matrix: b.worldMatrix } : null
}

/**
 * Compute the bone-attach world matrix for a shape, or `null` if
 * no transform should be applied (i.e. vertices are already in
 * model bind-pose space).
 *
 * Rules:
 *   - `vertexSkinCount === 0` → vertices in `bones[boneIndex]`'s
 *     local space; multiply by that bone's world matrix.
 *   - `vertexSkinCount === 1` → vertices in
 *     `bones[skinBoneIndexList[0]]`'s local space; multiply by
 *     that bone's world matrix.
 *   - `vertexSkinCount >= 2` → smooth-skinned, vertices already
 *     in model bind-pose space; leave at identity.
 *   - **Multi-FMDL heuristic**: if this shape lives in a
 *     secondary single-bone FMDL (no real rig of its own) and the
 *     primary FMDL has a `Head` bone, mount the shape on the
 *     primary's `Head`. Used for Yoshi-style "Pupil" sub-models.
 */
function pickShapeMatrix(
  g: BfresGeometry,
  skeletons: BfresSkeleton[],
  primaryModelIndex: number,
  primaryHead: { matrix: Float32Array } | null,
): Float32Array | null {
  const skel = skeletons[g.modelIndex]
  if (!skel) return null

  // Multi-FMDL heuristic — for secondary FMDLs whose own
  // skeleton is just a single root-pose bone (e.g. MK8's "Pupil"
  // sub-FMDL), mount on the primary FMDL's `Head` bone using its
  // full world matrix (translation + rotation). Verified against
  // Yoshi: pupils' authored X=3.19..5.57 maps through Head's
  // rotation to land just above the body, on the front of the
  // head, at the eye position.
  //
  // The BFRES file itself contains no explicit cross-FMDL link —
  // commercial games store that in the parent SARC/BYAML. The
  // `Head` heuristic catches the common case (character Pupil
  // sub-models); single-FMDL BFRES and BFRES with a primary FMDL
  // that has no `Head` bone are unaffected.
  if (
    g.modelIndex !== primaryModelIndex &&
    primaryHead &&
    skel.bones.length === 1 &&
    isIdentityishMatrix(skel.bones[0].worldMatrix)
  ) {
    return primaryHead.matrix
  }

  if (g.vertexSkinCount === 0) {
    const b = skel.bones[g.boneIndex]
    return b && !isIdentityishMatrix(b.worldMatrix) ? b.worldMatrix : null
  }
  if (g.vertexSkinCount === 1 && g.skinBoneIndexList.length > 0) {
    const idx = g.skinBoneIndexList[0]
    const b = skel.bones[idx]
    return b && !isIdentityishMatrix(b.worldMatrix) ? b.worldMatrix : null
  }
  // `vertexSkinCount >= 2` — vertices already in model bind-pose.
  return null
}

/**
 * Build a Three.js scene-graph mirror of one FSKL skeleton:
 *   - One `THREE.Bone` per source bone, parented per the FSKL
 *     hierarchy.
 *   - A `THREE.Skeleton` wrapper carrying inverse-bind matrices
 *     so SkinnedMeshes can perform LBS.
 *   - The bone's bind-pose `position` / `quaternion` / `scale` are
 *     loaded from the source's local SRT so the rig is in bind
 *     pose by default. Animation later overrides these.
 */
/**
 * Convert BFRES Euler XYZ angles `(rx, ry, rz)` to a quaternion
 * matching BfresLibrary's `STMath.FromEulerAngles` — which builds
 * the quaternion as `qz · qy · qx`. This is **not** equivalent to
 * Three.js's `Euler('XYZ')` (which is actually `qx · qy · qz` per
 * its `makeRotationFromEuler`'s XYZ branch), so we have to do the
 * composition manually. Writes into `out` and returns it for
 * chaining.
 */
function eulerXyzToQuaternionBfres(
  rx: number,
  ry: number,
  rz: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5)
  const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5)
  const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5)
  // qx = (sx, 0, 0, cx); qy = (0, sy, 0, cy); qz = (0, 0, sz, cz).
  // Hamilton product `q1 * q2`:
  //   x = w1*x2 + x1*w2 + y1*z2 - z1*y2
  //   y = w1*y2 - x1*z2 + y1*w2 + z1*x2
  //   z = w1*z2 + x1*y2 - y1*x2 + z1*w2
  //   w = w1*w2 - x1*x2 - y1*y2 - z1*z2
  // Compute qzqy = qz * qy:
  const qzqy_x = cz * 0 + 0 * cy + 0 * sy - sz * sy // = -sz*sy
  const qzqy_y = cz * sy - 0 * sy + 0 * cy + sz * 0 // = cz*sy
  const qzqy_z = cz * 0 + 0 * sy - 0 * 0 + sz * cy // = sz*cy
  const qzqy_w = cz * cy - 0 * 0 - 0 * sy - sz * 0 // = cz*cy
  // Then (qzqy) * qx:
  out.x = qzqy_w * sx + qzqy_x * cx + qzqy_y * 0 - qzqy_z * 0 // = qzqy_w*sx + qzqy_x*cx
  out.y = qzqy_w * 0 - qzqy_x * 0 + qzqy_y * cx + qzqy_z * sx // = qzqy_y*cx + qzqy_z*sx
  out.z = qzqy_w * 0 + qzqy_x * 0 - qzqy_y * sx + qzqy_z * cx // = -qzqy_y*sx + qzqy_z*cx
  out.w = qzqy_w * cx - qzqy_x * sx - qzqy_y * 0 - qzqy_z * 0 // = qzqy_w*cx - qzqy_x*sx
  return out
}

function buildSceneSkeleton(source: BfresSkeleton): FsklSceneSkeleton {
  // We set each bone's PRS by **decomposing the source's already-
  // composed `localMatrix`**, rather than feeding the raw Euler XYZ
  // angles into `THREE.Euler('XYZ')`. The two conventions look the
  // same on paper but produce different rotation matrices:
  //   - BfresLibrary's `STMath.FromEulerAngles` builds the
  //     quaternion as `Qz · Qy · Qx`, giving the matrix
  //     `Mz · My · Mx` — i.e. when applied to a vector, rotate
  //     about X first, then Y, then Z (intrinsic XYZ).
  //   - Three.js's `Euler('XYZ')` actually computes `Mx · My · Mz`
  //     (verified against the source: `makeRotationFromEuler`'s
  //     XYZ branch). Applied as `M·v` it rotates Z first, then Y,
  //     then X — the OPPOSITE order.
  // Going via `localMatrix.decompose()` sidesteps the convention
  // mismatch entirely; whatever the source intends, the matrix we
  // computed in the parser is authoritative.
  const tmpMat = new THREE.Matrix4()
  const bones: THREE.Bone[] = source.bones.map((sb) => {
    const b = new THREE.Bone()
    b.name = sb.name
    tmpMat.fromArray(sb.localMatrix as unknown as number[])
    tmpMat.decompose(b.position, b.quaternion, b.scale)
    return b
  })

  // Parent the bones into a tree per the source's parentIndex.
  const roots: THREE.Bone[] = []
  for (let i = 0; i < bones.length; i++) {
    const sb = source.bones[i]!
    if (sb.parentIndex < 0 || sb.parentIndex >= bones.length) {
      roots.push(bones[i]!)
    } else {
      bones[sb.parentIndex]!.add(bones[i]!)
    }
  }

  // Inverse-bind matrices come straight from the source. Wrap each
  // in a `THREE.Matrix4`; the underlying Float32Array is shared
  // (Matrix4 reads `elements` as a length-16 view).
  const boneInverses = source.bones.map((sb) => {
    const m = new THREE.Matrix4()
    m.fromArray(sb.inverseBindMatrix as unknown as number[])
    return m
  })
  const skeleton = new THREE.Skeleton(bones, boneInverses)
  return { bones, skeleton, source, roots }
}

/** Look up a `THREE.Bone` by name in a scene skeleton. */
function findThreeBone(
  sceneSkel: FsklSceneSkeleton,
  name: string,
): THREE.Bone | null {
  return sceneSkel.bones.find((b) => b.name === name) ?? null
}

/**
 * Remap per-vertex skin indices into direct skeleton-bone indices
 * usable by Three.js's `SkinnedMesh.skinIndex` attribute.
 *
 * BFRES per-vertex `_i0` values index into the FSKL skeleton's
 * `matrixToBoneList` array — that array is the global "skin matrix
 * table", and each entry is a bone index. (The per-shape
 * `skinBoneIndexList` is a sparse subset metadata used by the
 * engine to know which matrices to upload to the GPU; it is NOT
 * indexed by `_i0`.) Confirmed against Peach's eye shape:
 * `_i0[v] = 11` resolves through `matrixToBoneList[11] = 13` =
 * the `Head` bone, which is correct for an eye vertex.
 */
function remapSkinIndices(
  raw: Float32Array,
  matrixToBoneList: Uint16Array,
): Uint16Array {
  const out = new Uint16Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const idx = raw[i]! | 0
    out[i] = idx >= 0 && idx < matrixToBoneList.length ? matrixToBoneList[idx]! : 0
  }
  return out
}

/**
 * Apply a {@link BfresSkeletalAnim} to a Three.js scene skeleton at
 * frame `t`. For each animated bone, evaluate the per-channel
 * curves and fold them with the bone's base/bind-pose values, then
 * write into the matching `THREE.Bone`.
 *
 * Bones not animated by this clip retain their bind-pose values.
 */
function applySkeletalAnim(
  sceneSkel: FsklSceneSkeleton,
  anim: BfresSkeletalAnim,
  t: number,
): void {
  // Reset every bone to its bind pose first. Without this, a clip
  // that doesn't touch a particular channel would inherit values
  // from whatever the previous clip left there.
  // We decompose each bone's source `localMatrix` (which uses our
  // `Mz·My·Mx` Euler convention) rather than re-running Three.js's
  // `Euler('XYZ')` (which uses the OPPOSITE order). See
  // {@link eulerXyzToQuaternionBfres} for the convention details.
  const tmpMat = new THREE.Matrix4()
  for (let i = 0; i < sceneSkel.bones.length; i++) {
    const sb = sceneSkel.source.bones[i]!
    const tb = sceneSkel.bones[i]!
    tmpMat.fromArray(sb.localMatrix as unknown as number[])
    tmpMat.decompose(tb.position, tb.quaternion, tb.scale)
  }

  // Apply each bone-anim track.
  for (const ba of anim.boneAnims) {
    const boneIdx = sceneSkel.bones.findIndex((b) => b.name === ba.name)
    if (boneIdx < 0) continue
    const tb = sceneSkel.bones[boneIdx]!
    const sb = sceneSkel.source.bones[boneIdx]!
    // Start with the bone's bind-pose values from the rig. Channels
    // present in this anim's base data overwrite them (per the
    // FSKA `FlagsBase` flags) and animated curves further overwrite
    // those at the current frame. Falling back to bind pose for
    // missing channels is what the engine does — using the FSKA
    // track's zero-defaults when a base channel isn't present
    // produces a degenerate transform that crumples the rig.
    let sx = sb.scale[0], sy = sb.scale[1], sz = sb.scale[2]
    let rx = sb.rotation[0], ry = sb.rotation[1], rz = sb.rotation[2]
    let rw = sb.rotation[3]
    let tx = sb.position[0], ty = sb.position[1], tz = sb.position[2]
    // If the track's base values are non-default, use them. The
    // BFRES extractor sets each base channel to bind pose defaults
    // (1/1/1, 0/0/0/1, 0/0/0) when the corresponding `FlagsBase`
    // bit is unset — so a non-default value means the file
    // explicitly stored a base value that should override the rig.
    // Heuristic: if any of (scale, rotate, translate) base differs
    // from defaults, prefer it. This is approximate but matches the
    // observed behaviour on MK8 character clips.
    const SX = ba.baseScale[0], SY = ba.baseScale[1], SZ = ba.baseScale[2]
    if (SX !== 1 || SY !== 1 || SZ !== 1) { sx = SX; sy = SY; sz = SZ }
    const RX = ba.baseRotation[0], RY = ba.baseRotation[1], RZ = ba.baseRotation[2], RW = ba.baseRotation[3]
    if (RX !== 0 || RY !== 0 || RZ !== 0 || RW !== 1) { rx = RX; ry = RY; rz = RZ; rw = RW }
    const TX = ba.baseTranslation[0], TY = ba.baseTranslation[1], TZ = ba.baseTranslation[2]
    if (TX !== 0 || TY !== 0 || TZ !== 0) { tx = TX; ty = TY; tz = TZ }

    for (const c of ba.curves) {
      const value = evaluateCurve(c, t)
      switch (c.animDataOffset) {
        case BoneAnimDataOffset.ScaleX: sx = value; break
        case BoneAnimDataOffset.ScaleY: sy = value; break
        case BoneAnimDataOffset.ScaleZ: sz = value; break
        case BoneAnimDataOffset.TranslateX: tx = value; break
        case BoneAnimDataOffset.TranslateY: ty = value; break
        case BoneAnimDataOffset.TranslateZ: tz = value; break
        case BoneAnimDataOffset.RotateX: rx = value; break
        case BoneAnimDataOffset.RotateY: ry = value; break
        case BoneAnimDataOffset.RotateZ: rz = value; break
        case BoneAnimDataOffset.RotateW: rw = value; break
      }
    }
    tb.position.set(tx, ty, tz)
    tb.scale.set(sx, sy, sz)
    if (anim.rotationMode === 'eulerXYZ') {
      eulerXyzToQuaternionBfres(rx, ry, rz, tb.quaternion)
    } else {
      tb.quaternion.set(rx, ry, rz, rw)
    }
  }
}

/**
 * Build a `THREE.Group` visualising every FMDL's FSKL skeleton:
 *
 *   - parent→child bone segments (line strip, one color per FMDL)
 *   - small spheres at each bone's world position
 *   - a tiny set of XYZ axes at world origin so we can see the
 *     model's coordinate frame at a glance
 *
 * Used for debugging — toggle via the "Show skeleton" checkbox.
 */
function buildSkeletonGroup(skeletons: BfresSkeleton[]): THREE.Group {
  const group = new THREE.Group()
  group.name = "skeleton-overlay"
  group.renderOrder = 999 // draw on top of meshes
  // Color palette per-FMDL — primary (most bones) gets cyan; the
  // others rotate through magenta / yellow / orange so we can
  // tell which sub-FMDL a stray bone belongs to.
  const palette = [0x00ffff, 0xff00ff, 0xffff00, 0xff8800, 0x88ff00]
  for (let mi = 0; mi < skeletons.length; mi++) {
    const skel = skeletons[mi]
    if (!skel.bones.length) continue
    const color = palette[mi % palette.length]
    const lineMat = new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    })
    const positions: number[] = []
    for (const b of skel.bones) {
      if (b.parentIndex < 0 || b.parentIndex >= skel.bones.length) continue
      const p = skel.bones[b.parentIndex].worldMatrix
      const m = b.worldMatrix
      positions.push(p[12], p[13], p[14], m[12], m[13], m[14])
    }
    if (positions.length) {
      const lg = new THREE.BufferGeometry()
      lg.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      )
      const lines = new THREE.LineSegments(lg, lineMat)
      lines.renderOrder = 999
      group.add(lines)
    }
    // Bone-tip markers (one tiny sphere per bone). Reuse one
    // SphereGeometry across all instances via InstancedMesh-lite
    // (just regular Mesh per bone — bone count is small, ≤ ~50).
    const sphereGeom = new THREE.SphereGeometry(0.04, 6, 6)
    const sphereMat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
    })
    for (const b of skel.bones) {
      const sphere = new THREE.Mesh(sphereGeom, sphereMat)
      sphere.position.set(b.worldMatrix[12], b.worldMatrix[13], b.worldMatrix[14])
      sphere.renderOrder = 999
      // Scale spheres relative to bone reach so they're visible on
      // both Yoshi (~10 unit reach) and tiny Bird (~0.1 unit reach).
      group.add(sphere)
    }
  }
  // World-origin axes for orientation reference.
  const axisLen =
    Math.max(
      ...skeletons.flatMap((s) =>
        s.bones.map((b) =>
          Math.hypot(b.worldMatrix[12], b.worldMatrix[13], b.worldMatrix[14]),
        ),
      ),
      1,
    ) * 0.5
  group.add(new THREE.AxesHelper(axisLen))
  return group
}

function disposeSkeletonGroup(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh | THREE.LineSegments
    if (m.geometry) m.geometry.dispose()
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) mat.dispose()
    }
  })
}

/**
 * Cheap "is this matrix the identity?" check — avoids computing a
 * Three.js Mesh transform when there's nothing to apply.
 */
function isIdentityishMatrix(m: Float32Array): boolean {
  const eps = 1e-5
  return (
    Math.abs(m[0] - 1) < eps && Math.abs(m[5] - 1) < eps && Math.abs(m[10] - 1) < eps &&
    Math.abs(m[1]) < eps && Math.abs(m[2]) < eps &&
    Math.abs(m[4]) < eps && Math.abs(m[6]) < eps &&
    Math.abs(m[8]) < eps && Math.abs(m[9]) < eps &&
    Math.abs(m[12]) < eps && Math.abs(m[13]) < eps && Math.abs(m[14]) < eps
  )
}

/**
 * Compute a tight bounding box over a shape's UV array. Returns
 * `null` for shapes with no UVs.
 */
function uvRange(g: BfresGeometry): {
  minU: number
  maxU: number
  minV: number
  maxV: number
} | null {
  if (!g.uvs || g.uvs.length === 0) return null
  let minU = Infinity, maxU = -Infinity
  let minV = Infinity, maxV = -Infinity
  for (let i = 0; i < g.uvs.length; i += 2) {
    const u = g.uvs[i]
    const v = g.uvs[i + 1]
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  return { minU, maxU, minV, maxV }
}

/**
 * Pick the right texture-wrap mode for a shape based on its UV
 * range:
 *
 *   - Span > 1.5 in either axis → likely a pupil-style mesh whose
 *     authored UVs deliberately extend far outside [0, 1] expecting
 *     the engine to clamp to a transparent border. Use
 *     `ClampToEdgeWrapping`. (RepeatWrapping would produce a tiled
 *     grid of pupil copies.)
 *   - Otherwise (UVs within or slightly outside [0, 1]) → use
 *     `RepeatWrapping` so meshes with negative-U coordinates (e.g.
 *     Nokonoko's `Body__m_Eye` in U=[-0.97, -0.03]) sample the
 *     authored [0, 1] region rather than clamping to a black edge
 *     pixel.
 */
function pickWrapMode(g: BfresGeometry): THREE.Wrapping {
  const r = uvRange(g)
  if (!r) return THREE.RepeatWrapping
  const spanU = r.maxU - r.minU
  const spanV = r.maxV - r.minV
  if (spanU > 1.5 || spanV > 1.5) return THREE.ClampToEdgeWrapping
  return THREE.RepeatWrapping
}

function pickAlbedo(
  geom: BfresGeometry,
  materials: BfresMaterial[][],
  cache: BntxTextureCache | null,
): THREE.Texture | null {
  if (!cache) return null
  const mat = materials[geom.modelIndex]?.[geom.materialIndex]
  if (!mat) return null
  // Switch BFRES samplers use a leading-underscore naming
  // convention: `_a0`/`_a1`/`_a2` are albedo, `_n0` normal,
  // `_s0` specular, etc. We try each albedo slot in order.
  const albedoSamplers = ["_a0", "_a1", "_a2"]
  let textureName: string | null = null
  for (const want of albedoSamplers) {
    const b = mat.bindings.find((bb) => bb.samplerName === want)
    if (b) {
      textureName = b.textureName
      break
    }
  }
  if (!textureName) return null

  const wrap = pickWrapMode(geom)
  const wrapKey = wrap === THREE.ClampToEdgeWrapping ? "clamp" : "repeat"
  const cacheKey = `${textureName}|${wrapKey}`
  // Already built a Three.js texture for this (name, wrap-mode) pair?
  if (cache.textures.has(cacheKey)) {
    return cache.textures.get(cacheKey) ?? null
  }

  // Decode the raw RGBA pixels once per texture name (memoised).
  // Search every bank in priority order so companion `.Tex.sbfres`
  // banks (BotW-style split layout) fill in for textures the
  // model's own embedded BNTX doesn't carry.
  let decoded = cache.decoded.get(textureName) ?? null
  if (!cache.decoded.has(textureName)) {
    const found = findInBanks(cache.banks, textureName)
    if (found) {
      try {
        const d = decodeBntxLayer(found.bytes, found.tex, 0, {
          astcDecoder: cache.astcDecoder,
        })
        decoded = {
          pixels: new Uint8ClampedArray(
            d.pixels.buffer,
            d.pixels.byteOffset,
            d.pixels.byteLength,
          ),
          width: d.width,
          height: d.height,
          srgb: found.tex.srgb,
        }
      } catch {
        decoded = null
      }
    }
    cache.decoded.set(textureName, decoded)
  }
  if (!decoded) {
    cache.textures.set(cacheKey, null)
    return null
  }

  const tex = new THREE.DataTexture(
    decoded.pixels,
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  tex.colorSpace = decoded.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  // `flipY` and the UV V-flip both stay OFF — that's the empirically
  // correct combination for the BFRES corpus we've tested.
  tex.flipY = false
  tex.wrapS = wrap
  tex.wrapT = wrap
  tex.minFilter = THREE.LinearMipMapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  cache.textures.set(cacheKey, tex)
  return tex
}

/**
 * Resolve a texture by name through the bank cache, with the
 * given wrap mode. Returns the Three.js `DataTexture` or `null`
 * if the name doesn't exist in any bank, or its bytes can't be
 * decoded. The result is memoised inside the cache so repeat
 * lookups for the same `(name, wrap)` pair don't re-decode.
 *
 * Used by the FMAA driver to swap in flipbook textures on the
 * fly. Identical decode pipeline as `pickAlbedo`'s tail half;
 * factored out so we don't repeat ourselves.
 */
function getTextureByName(
  cache: BntxTextureCache,
  textureName: string,
  wrap: THREE.Wrapping,
): THREE.Texture | null {
  const wrapKey = wrap === THREE.ClampToEdgeWrapping ? "clamp" : "repeat"
  const cacheKey = `${textureName}|${wrapKey}`
  if (cache.textures.has(cacheKey)) return cache.textures.get(cacheKey) ?? null
  let decoded = cache.decoded.get(textureName) ?? null
  if (!cache.decoded.has(textureName)) {
    const found = findInBanks(cache.banks, textureName)
    if (found) {
      try {
        const d = decodeBntxLayer(found.bytes, found.tex, 0, {
          astcDecoder: cache.astcDecoder,
        })
        decoded = {
          pixels: new Uint8ClampedArray(
            d.pixels.buffer,
            d.pixels.byteOffset,
            d.pixels.byteLength,
          ),
          width: d.width,
          height: d.height,
          srgb: found.tex.srgb,
        }
      } catch {
        decoded = null
      }
    }
    cache.decoded.set(textureName, decoded)
  }
  if (!decoded) {
    cache.textures.set(cacheKey, null)
    return null
  }
  const tex = new THREE.DataTexture(
    decoded.pixels,
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  tex.colorSpace = decoded.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.flipY = false
  tex.wrapS = wrap
  tex.wrapT = wrap
  tex.minFilter = THREE.LinearMipMapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  cache.textures.set(cacheKey, tex)
  return tex
}

/**
 * Walk a texture-pattern animation's keyframe list and return
 * the `textureIndex` active at frame `t`. Texture-pattern
 * curves are stepwise: the index at frame `t` is whatever the
 * latest keyframe at-or-before `t` says.
 */
function lookupTexturePatternIndex(
  entries: { frame: number; textureIndex: number }[],
  t: number,
): number {
  if (entries.length === 0) return 0
  // Binary-search would be marginally faster but typical FMAA
  // tracks have <30 keyframes so a linear scan is fine.
  let chosen = entries[0]!.textureIndex
  for (const e of entries) {
    if (e.frame <= t) chosen = e.textureIndex
    else break
  }
  return chosen
}

/**
 * Restore each shape's bind-pose albedo. Used when no FMAA is
 * active — without this the last FMAA-driven texture would
 * stick around forever.
 */
function resetMaterialAnim(shapes: ShapeRecord[]): void {
  for (const shape of shapes) {
    if (!(shape.mesh.material instanceof THREE.Material)) continue
    const m = shape.mesh.material as THREE.Material & {
      map?: THREE.Texture | null
    }
    if (m.map !== shape.bindAlbedo) {
      m.map = shape.bindAlbedo ?? null
      m.needsUpdate = true
    }
  }
}

/**
 * Apply one FMAA's material-animation state to the rendered
 * shapes for the given frame. For each `materialAnim` in the
 * file:
 *
 *   1. Find the shape(s) whose FMAT material name matches
 *      the materialAnim's name (e.g. `m_Eye`).
 *   2. For each `(samplerName, entries)` texture-pattern in
 *      that materialAnim, look up the active `textureIndex`
 *      at frame `t`.
 *   3. Resolve `textureNames[textureIndex]` to a Three.js
 *      texture via {@link getTextureByName} and assign it as
 *      the matching mesh's `material.map`.
 *
 * We only drive the `_a0` / `_a1` (albedo) samplers — those
 * are the ones we already use for rendering. The other
 * samplers' patterns are decoded but ignored here.
 */
function applyMaterialAnim(
  shapes: ShapeRecord[],
  materials: BfresMaterial[][],
  cache: BntxTextureCache,
  fmaa: BfresMaterialAnimFile,
  t: number,
): void {
  // Track stats so we can spot which path didn't fire when no
  // visible change happens. `console.log`s a one-line summary
  // per call (gated on a window-scoped flag so we can flip it
  // off after debugging).
  const dbg = (window as unknown as { __FMAA_DEBUG?: boolean }).__FMAA_DEBUG
  let stats = {
    matAnims: 0,
    shapesMatched: 0,
    samplersMatched: 0,
    texturesSwapped: 0,
    sampledTextures: [] as string[],
  }
  // One-shot detail dump on first call, gated on debug flag.
  const dbgDetailed = (window as unknown as { __FMAA_DUMP?: boolean }).__FMAA_DUMP
  if (dbgDetailed) {
    ;(window as unknown as { __FMAA_DUMP?: boolean }).__FMAA_DUMP = false
    // eslint-disable-next-line no-console
    console.log(`[FMAA] DUMP ${fmaa.name}:`, {
      frameCount: fmaa.frameCount,
      loop: fmaa.loop,
      baked: fmaa.baked,
      materialAnimsCount: fmaa.materialAnims.length,
      textureNamesCount: fmaa.textureNames.length,
      textureNames: fmaa.textureNames,
      materialAnims: fmaa.materialAnims.map((ma) => ({
        name: ma.name,
        curvesCount: ma.curves.length,
        texturePatternsSize: ma.texturePatterns.size,
        texturePatternsKeys: Array.from(ma.texturePatterns.keys()),
        firstPatternEntries: Array.from(ma.texturePatterns.entries()).map(
          ([s, e]) => ({ sampler: s, count: e.length, first8: e.slice(0, 8) }),
        ),
      })),
    })
    // Also dump the live shapes' material names so we can see
    // why the name match fails.
    // eslint-disable-next-line no-console
    console.log(`[FMAA] DUMP shapes:`, shapes.map((s) => {
      const mat = materials[s.geom.modelIndex]?.[s.geom.materialIndex]
      return {
        modelIndex: s.geom.modelIndex,
        materialIndex: s.geom.materialIndex,
        materialName: mat?.name,
        bindings: mat?.bindings.map((b) => `${b.samplerName}=${b.textureName}`),
      }
    }))
  }
  for (const ma of fmaa.materialAnims) {
    if (ma.texturePatterns.size === 0) continue
    stats.matAnims++
    // Find every shape whose material matches `ma.name`. A
    // given material can be shared across multiple shapes
    // (e.g. Yoshi's two pupil shapes share `m_PupilL` /
    // `m_PupilR` accordingly) so we don't `break` after the
    // first hit.
    for (const shape of shapes) {
      const mat = materials[shape.geom.modelIndex]?.[shape.geom.materialIndex]
      if (!mat || mat.name !== ma.name) continue
      stats.shapesMatched++
      const mesh = shape.mesh
      if (!(mesh.material instanceof THREE.Material)) continue
      // We only have one texture slot in our renderer — the
      // material's `.map` — and `pickAlbedo` filled it from
      // the FIRST albedo sampler the material binds (`_a0`
      // first, `_a1` if absent, …). Only animate THAT slot.
      // Yoshi's pupil materials, for example, bind both
      // `_a0` (eyeball) and `_a1` (pupil overlay); the FMAA
      // animates `_a1` but we render via `_a0`. Writing the
      // pupil-overlay texture into our single slot would
      // overwrite the eyeball with a tiled-grid pupil sheet.
      // For multi-texture materials that needs a real shader
      // with `_a0` + `_a1` compositing — out of scope here.
      const albedoSamplers = ["_a0", "_a1", "_a2"]
      let activeSampler: string | null = null
      for (const s of albedoSamplers) {
        if (mat.bindings.find((b) => b.samplerName === s)) {
          activeSampler = s
          break
        }
      }
      if (!activeSampler) continue
      const entries = ma.texturePatterns.get(activeSampler)
      if (!entries || entries.length === 0) continue
      stats.samplersMatched++
      const idx = lookupTexturePatternIndex(entries, t)
      const newTexName = fmaa.textureNames[idx]
      if (!newTexName) continue
      stats.sampledTextures.push(`${ma.name}.${activeSampler}=${newTexName}`)
      const wrap = pickWrapMode(shape.geom)
      const newTex = getTextureByName(cache, newTexName, wrap)
      if (!newTex) continue
      const m = mesh.material as THREE.Material & {
        map?: THREE.Texture | null
      }
      if (m.map !== newTex) {
        m.map = newTex
        m.needsUpdate = true
        stats.texturesSwapped++
      }
    }
  }
  if (dbg) {
    // eslint-disable-next-line no-console
    console.log(
      `[FMAA] t=${t.toFixed(1)} ${fmaa.name}: ` +
        `matAnims=${stats.matAnims} shapesMatched=${stats.shapesMatched} ` +
        `samplersMatched=${stats.samplersMatched} swapped=${stats.texturesSwapped}` +
        (stats.sampledTextures.length
          ? ` [${stats.sampledTextures.slice(0, 3).join(", ")}${stats.sampledTextures.length > 3 ? ", ..." : ""}]`
          : ""),
    )
  }
}

/**
 * Sample every vertex of a single shape into world space, taking
 * skeletal-animation deformation into account. Returns an indexed
 * mesh so subsequent processing (welding, subdivision) can stay
 * O(triangles) without re-walking the skin.
 *
 * SkinnedMeshes use `applyBoneTransform()` so the result reflects
 * the *current* bone poses (i.e. whatever frame of whatever
 * animation the viewer is currently sitting on). Plain Meshes
 * (e.g. Pupil sub-FMDLs parented to a Head bone) inherit the
 * bone's world transform via the scene-graph; we just apply
 * `matrixWorld` directly.
 */
function bakeShapeToWorld(record: ShapeRecord): IndexedMesh | null {
  const geom = record.mesh.geometry
  const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined
  const idx = geom.getIndex()
  if (!pos || !idx) return null

  const vertexCount = pos.count
  const positions = new Float32Array(vertexCount * 3)
  const tmp = new THREE.Vector3()
  const isSkinned = (record.mesh as THREE.SkinnedMesh).isSkinnedMesh
  for (let v = 0; v < vertexCount; v++) {
    tmp.fromBufferAttribute(pos, v)
    if (isSkinned) {
      // `applyBoneTransform` reads skinIndex/skinWeight from the
      // geometry, looks up matrices on the bound skeleton, and
      // writes the skinned position back into `tmp`. With our
      // identity bindMatrix/bindMatrixInverse the bind transform
      // is a no-op, leaving us with `world_current * inv_bind *
      // v_model_bind` (or `world_current * v_bone_local` for
      // rigid-skin shapes that use identity inverses).
      ;(record.mesh as THREE.SkinnedMesh).applyBoneTransform(v, tmp)
    } else {
      tmp.applyMatrix4(record.mesh.matrixWorld)
    }
    positions[v * 3 + 0] = tmp.x
    positions[v * 3 + 1] = tmp.y
    positions[v * 3 + 2] = tmp.z
  }

  // Copy the index buffer to a Uint32Array up front so subsequent
  // passes have a uniform integer type to work with regardless of
  // whether Three.js gave us 16- or 32-bit indices.
  const idxArr = idx.array as ArrayLike<number>
  const indices = new Uint32Array(idxArr.length)
  for (let i = 0; i < idxArr.length; i++) indices[i] = idxArr[i]!

  return { positions, indices }
}

// `weldByPosition` and `loopSubdivide` are imported from
// `~/lib/mesh-export` — shared with the static-mesh / phyre
// viewers and used by `exportPosedSTL` below.


/**
 * Bake all currently-visible meshes — including any skeletal-
 * animation deformation applied for the active frame — into a
 * binary STL file and trigger a browser download.
 *
 * Pipeline:
 *
 *   1. For each visible shape, sample posed world-space
 *      positions ({@link bakeShapeToWorld}).
 *   2. Weld duplicate-position vertices ({@link weldByPosition})
 *      so seams don't masquerade as boundary edges in the next
 *      step.
 *   3. Optionally apply N passes of Loop subdivision
 *      ({@link loopSubdivide}); each pass quadruples the triangle
 *      count and smooths corners.
 *   4. Convert from BFRES Y-up to slicer Z-up by rotating −90°
 *      about the X axis.
 *   5. Compute flat per-triangle normals (cross product of two
 *      edges) and emit a binary STL: 80-byte free-form header,
 *      uint32 triangle count, then 50 bytes per triangle.
 *
 * Triangles whose vertices contain non-finite components after
 * baking (rare, but defensive — a malformed skin weight could
 * produce this) are dropped rather than written with garbage
 * values that might crash the slicer.
 */
function exportPosedSTL(
  shapes: ShapeRecord[],
  scene: THREE.Scene,
  baseName: string,
  suffix: string,
  subdivisionPasses: number,
): void {
  // Make sure every mesh's `matrixWorld` and every Skeleton's
  // `boneMatrices` reflect the current pose. The render loop
  // does this once per frame, but the user could in principle
  // hit "Download" before the first render — call explicitly to
  // be safe.
  scene.updateMatrixWorld(true)
  for (const r of shapes) {
    if (!r.visible) continue
    if ((r.mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      ;(r.mesh as THREE.SkinnedMesh).skeleton.update()
    }
  }

  // Per-shape: bake → weld → subdivide. We keep meshes separate
  // through these steps because cross-shape vertex sharing isn't
  // meaningful for BFRES (different shapes have different
  // materials and topologies that happen to coincide spatially).
  const cooked: IndexedMesh[] = []
  for (const r of shapes) {
    if (!r.visible) continue
    const baked = bakeShapeToWorld(r)
    if (!baked) continue
    let m = weldByPosition(baked)
    for (let p = 0; p < subdivisionPasses; p++) {
      m = loopSubdivide(m)
    }
    cooked.push(m)
  }

  if (cooked.length === 0) return

  // Slicer-friendly export: BFRES is Y-up, so let the emitter
  // rotate to Z-up. Header note + subdivision count get baked
  // into the STL header for traceability.
  const headerNote =
    `nx-archive BFRES export ${baseName}${suffix}` +
    (subdivisionPasses > 0 ? ` sub${subdivisionPasses}` : "")
  const bytes = emitBinarySTL(cooked, {
    header: headerNote,
    sourceAxis: "y-up",
  })

  const stem = sanitizeStem(baseName) || "model"
  const subSuffix = subdivisionPasses > 0 ? `_sub${subdivisionPasses}` : ""
  const fileName = `${stem}${suffix}${subSuffix}.stl`
  triggerDownload(bytes, fileName, "model/stl")
}

/**
 * Props for {@link BfresViewer}. `root` is the archive's root
 * `Node` and is used to discover companion BFRES siblings (BotW-
 * style split layouts where textures and animations live in
 * `*.Tex.sbfres` / `*_Animation.sbfres` next to the model). When
 * `root` is omitted (or no companions are found), the viewer
 * still works on a single self-contained BFRES file.
 */
interface BfresViewerProps {
  node: Node
  root?: Node | null
}

export function BfresViewer({ node, root }: BfresViewerProps) {
  return (
    <BfresViewerErrorBoundary>
      <BfresViewerInner node={node} root={root ?? null} />
    </BfresViewerErrorBoundary>
  )
}

function BfresViewerInner({ node, root }: { node: Node; root: Node | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [shapes, setShapes] = useState<ShapeRecord[] | null>(null)
  const skeletonsRef = useRef<BfresSkeleton[] | null>(null)
  const sceneSkeletonsRef = useRef<FsklSceneSkeleton[] | null>(null)
  const animationsRef = useRef<BfresAnimations | null>(null)
  // Texture cache + materials kept in refs so the FMAA driver
  // can look up textures by name and find the right material on
  // the right shape. The shapes themselves live in React state
  // (toggled visibility), but the supporting metadata that the
  // animation driver needs is too noisy to put in state — we'd
  // rebuild every effect on every frame tick.
  const textureCacheRef = useRef<BntxTextureCache | null>(null)
  const materialsRef = useRef<BfresMaterial[][] | null>(null)
  const [showSkeleton, setShowSkeleton] = useState(false)
  // STL export options. `stlSubdivision` is the number of Loop
  // subdivision passes applied before STL emit — 0 = raw mesh
  // (fastest, smallest file, blocky look on low-poly characters);
  // 1 = ~4× tris (recommended for Switch character meshes); 2 =
  // ~16× tris (overkill for most prints, but available).
  const [stlSubdivision, setStlSubdivision] = useState<number>(1)
  // Animation playback state. `currentAnim` indexes into
  // `animations.skeletal` (or -1 for "no animation, bind pose").
  const [currentAnim, setCurrentAnim] = useState<number>(-1)
  // Active FMAA (material animation) index, parallel to
  // `currentAnim` for FSKAs. `-1` means "no material anim" —
  // textures stay at the bind-pose albedo. FMAA is decoupled
  // from FSKA: the user picks each independently and they tick
  // together on the same frame counter.
  const [currentMatAnim, setCurrentMatAnim] = useState<number>(-1)
  const [playing, setPlaying] = useState<boolean>(true)
  const [frame, setFrame] = useState<number>(0)
  // Animation timing — lives in a ref so the rAF loop can read it
  // without forcing React rerenders 60×/sec.
  const animTimingRef = useRef<{
    lastTimestamp: number
    fps: number
  }>({ lastTimestamp: 0, fps: 30 })
  // Controls for the rendered scene live outside React state so we
  // can mutate them in event handlers without re-rendering.
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    animationId: number
    skeletonGroup: THREE.Group | null
  } | null>(null)

  // ---- Load + extract geometry from the BFRES blob ----
  useEffect(() => {
    let cancelled = false
    setError(null)
    setShapes(null)

    void (async () => {
      try {
        const blob = await node.blob!()
        // Run primary extraction + companion search in parallel.
        // Companion search can be slow on huge archives because
        // it has to expand every sibling's lazy `getChildren()`
        // tree, but it only blocks the spinner if the model
        // itself happens to parse instantly.
        const [
          geoms,
          materials,
          skeletons,
          animations,
          textureCache,
          companions,
        ] = await Promise.all([
          extractGeometry(blob),
          extractMaterials(blob),
          extractSkeletons(blob),
          extractAnimations(blob),
          loadEmbeddedBntxTextures(blob),
          findCompanionBfresBlobs(root, node).catch(
            (): CompanionBlobs => ({ textures: [], animations: [] }),
          ),
        ])
        if (cancelled) return
        if (geoms.length === 0) {
          setError(
            new Error(
              "BFRES has no extractable geometry (no FMDL with triangle shapes).",
            ),
          )
          return
        }

        // Merge companion textures into the cache (or create a
        // cache from scratch if the model itself had no embedded
        // BNTX, which is the common case for BotW-style splits).
        let mergedTextures = textureCache
        if (companions.textures.length > 0) {
          const companionBanks = (
            await Promise.all(companions.textures.map(loadBntxBankFromBfres))
          ).filter((b): b is BntxBank => b !== null)
          if (companionBanks.length > 0) {
            if (!mergedTextures) {
              mergedTextures = {
                banks: companionBanks,
                decoded: new Map(),
                textures: new Map(),
              }
            } else {
              mergedTextures.banks.push(...companionBanks)
            }
            await ensureAstcDecoder(mergedTextures)
          }
        }
        // Second-pass: if any albedo bindings still aren't
        // satisfied, look for shared texture archives in sibling
        // `.Tex.sbfres` files (BotW Mannequin → `Link.Tex.sbfres`,
        // etc.). Cheap when nothing's missing; bounded scan when
        // it is.
        const sharedBanks = await resolveSharedTextureBanks(
          root,
          node,
          materials,
          mergedTextures,
        ).catch(() => [])
        if (sharedBanks.length > 0) {
          if (!mergedTextures) {
            mergedTextures = {
              banks: sharedBanks,
              decoded: new Map(),
              textures: new Map(),
            }
          } else {
            mergedTextures.banks.push(...sharedBanks)
          }
          await ensureAstcDecoder(mergedTextures)
        }
        // Same idea for animations: append every clip pulled from
        // companion `*_Animation.*` BFRES files to the model's own
        // animations list. The viewer drives bones by *name*, so
        // a clip from a companion file will animate the model's
        // skeleton just fine as long as the bone names match (they
        // do for Nintendo first-party titles — the artists use a
        // single canonical skeleton across all assets for a given
        // character).
        let mergedAnimations = animations
        if (companions.animations.length > 0) {
          const companionAnims = await Promise.all(
            companions.animations.map((b) =>
              extractAnimations(b).catch(
                (): BfresAnimations => ({
                  skeletal: [],
                  material: [],
                  boneVis: [],
                  shape: [],
                  scene: [],
                }),
              ),
            ),
          )
          mergedAnimations = {
            skeletal: [
              ...animations.skeletal,
              ...companionAnims.flatMap((a) => a.skeletal),
            ],
            material: [
              ...animations.material,
              ...companionAnims.flatMap((a) => a.material),
            ],
            boneVis: [
              ...animations.boneVis,
              ...companionAnims.flatMap((a) => a.boneVis),
            ],
            shape: [
              ...animations.shape,
              ...companionAnims.flatMap((a) => a.shape),
            ],
            scene: [
              ...animations.scene,
              ...companionAnims.flatMap((a) => a.scene),
            ],
          }
        }
        if (cancelled) return

        skeletonsRef.current = skeletons
        animationsRef.current = mergedAnimations
        textureCacheRef.current = mergedTextures
        materialsRef.current = materials

        // Build a Three.js scene-graph skeleton per FMDL — array of
        // `THREE.Bone`s parented in a hierarchy, plus an `Skeleton`
        // wrapper carrying the inverse-bind matrices. SkinnedMeshes
        // bind to one of these so animation drives them all.
        const sceneSkeletons = skeletons.map(buildSceneSkeleton)
        sceneSkeletonsRef.current = sceneSkeletons

        // Pre-pick a "primary" FMDL for the multi-FMDL attachment
        // heuristic. The primary FMDL is the one with the most
        // bones (i.e. an actual rig with a Head bone). Secondary
        // FMDLs that contain only one identity-pose bone get
        // mounted on the primary FMDL's `Head` bone if it has one
        // — this is how Yoshi-style "Pupil" sub-models join the
        // body, since the BFRES file itself contains no explicit
        // cross-FMDL link (that lives in the parent SARC/BYAML).
        const primaryModelIndex = pickPrimaryFmdl(skeletons)
        const primaryHeadBone =
          primaryModelIndex >= 0
            ? findThreeBone(sceneSkeletons[primaryModelIndex]!, "Head")
            : null
        const primaryHeadSourceMatrix =
          primaryModelIndex >= 0
            ? findBone(skeletons[primaryModelIndex]!, "Head")
            : null

        const records: ShapeRecord[] = geoms.map((g) => {
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(g.positions, 3),
          )
          if (g.normals) {
            geometry.setAttribute(
              "normal",
              new THREE.BufferAttribute(g.normals, 3),
            )
          }
          if (g.uvs) {
            geometry.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2))
          }
          geometry.setIndex(new THREE.BufferAttribute(g.indices, 1))
          if (!g.normals) geometry.computeVertexNormals()

          // Pick a material: prefer the resolved albedo texture,
          // fall back to flat-shaded normal-vis if there isn't one.
          const albedo = pickAlbedo(g, materials, mergedTextures)
          // Many Switch albedo textures (BC3 specifically) carry
          // meaningful alpha — pupil textures are a clear example,
          // with ~57% of pixels alpha=0 to make the eye visible
          // only in a small central region. Without alphaTest those
          // transparent pixels render as opaque-but-textured, which
          // produces the "tiled pupil grid" effect we saw on Peach.
          // alphaTest discards alpha<0.5 fragments in the GPU
          // before depth-write, also avoiding z-fighting between
          // the pupil mesh and surrounding eye geometry.
          const material: THREE.Material = albedo
            ? new THREE.MeshBasicMaterial({
                map: albedo,
                side: THREE.DoubleSide,
                color: 0xffffff,
                transparent: true,
                alphaTest: 0.5,
              })
            : new THREE.MeshNormalMaterial({
                flatShading: false,
                side: THREE.DoubleSide,
              })

          // Build either a `SkinnedMesh` (shapes with skin attrs)
          // or a plain `Mesh` (rigid shapes — typically the Pupil
          // sub-FMDL).
          const sceneSkel = sceneSkeletons[g.modelIndex]
          let mesh: THREE.Mesh | THREE.SkinnedMesh
          if (g.skinIndices && g.skinWeights && sceneSkel && sceneSkel.bones.length > 0) {
            // Per-vertex `_i0` is an index into the shape's
            // `skinBoneIndexList`, which itself stores indices into
            // the FSKL skeleton. Three.js's `skinIndex` attribute
            // wants direct skeleton indices, so remap once here.
            const skinIndex = remapSkinIndices(
              g.skinIndices,
              sceneSkel.source.matrixToBoneList,
            )
            geometry.setAttribute(
              "skinIndex",
              new THREE.Uint16BufferAttribute(skinIndex, 4),
            )
            geometry.setAttribute(
              "skinWeight",
              new THREE.BufferAttribute(g.skinWeights, 4),
            )
            const skinned = new THREE.SkinnedMesh(geometry, material)
            // Pick the right `THREE.Skeleton` instance to bind
            // against. The bone array is shared across all
            // SkinnedMeshes in the same FMDL (so animation drives
            // them in lockstep), but the *inverse-bind matrices*
            // depend on what space the shape's vertices live in:
            //
            //   - Smooth-skinned shapes (`vertexSkinCount >= 2`)
            //     have vertices in model bind-pose space; the
            //     inverse-bind matrices from the FSKL
            //     (`inv(world_bind)`) are correct, because the
            //     shader does `world_current * inv(world_bind) * v`
            //     which is identity in bind pose.
            //
            //   - Rigid-skinned shapes (`vertexSkinCount === 1`)
            //     in BFRES store vertices in *bone-local* space
            //     (e.g. Yoshi's eye is authored at Y≈0..1.5,
            //     not Y≈8 where the Head bone lives). For these
            //     the shader needs `world_current * v_bone_local`
            //     directly, so the inverse-bind matrix must be
            //     **identity**. Otherwise the eye lands at bone-
            //     local origin in bind pose, on the floor.
            //
            // Build a separate `THREE.Skeleton` for the rigid
            // case, sharing the same bones but with identity
            // inverses, so this override doesn't leak into
            // smooth-skinned meshes that use the same skeleton.
            const bindSkel =
              g.vertexSkinCount === 1
                ? new THREE.Skeleton(
                    sceneSkel.bones,
                    sceneSkel.bones.map(() => new THREE.Matrix4()),
                  )
                : sceneSkel.skeleton
            // CRITICAL: pass an explicit bindMatrix (identity here)
            // so Three.js's `bind()` does NOT call
            // `skeleton.calculateInverses()` — that would recompute
            // the inverse-bind matrices from the current bone
            // matrixWorlds, throwing away whichever bind matrices
            // we just chose.
            skinned.bind(bindSkel, new THREE.Matrix4())
            // SkinnedMeshes are typically frustum-culled by their
            // *static* AABB which doesn't account for animation —
            // disable to avoid pop-out when bones move.
            skinned.frustumCulled = false
            mesh = skinned
          } else {
            mesh = new THREE.Mesh(geometry, material)
            // Multi-FMDL Pupil-style shapes: parent the mesh to the
            // primary FMDL's Head bone so it follows head animation
            // automatically. Identified by "this FMDL's only bone
            // is at identity AND we have a primary Head".
            if (
              g.modelIndex !== primaryModelIndex &&
              sceneSkel &&
              sceneSkel.bones.length === 1 &&
              primaryHeadBone &&
              isIdentityishMatrix(sceneSkel.source.bones[0]!.worldMatrix)
            ) {
              primaryHeadBone.add(mesh)
              // Mesh stays at its authored local position; the bone's
              // animated world matrix carries it.
            } else {
              // Fallback: shapes whose authored vertices live in some
              // bone's local space (e.g. `vertexSkinCount === 0` with
              // a non-identity boneIndex). Apply a static bone
              // transform — won't animate, but at least lands at the
              // bind-pose location.
              const attach = pickShapeMatrix(
                g,
                skeletons,
                primaryModelIndex,
                primaryHeadSourceMatrix,
              )
              if (attach) {
                const m = new THREE.Matrix4().fromArray(attach)
                m.decompose(mesh.position, mesh.quaternion, mesh.scale)
              }
            }
          }
          mesh.name = g.name
          return {
            geom: g,
            mesh,
            visible: true,
            hasAlbedo: !!albedo,
            bindAlbedo: albedo,
          }
        })
        setShapes(records)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [node.id, node])

  // ---- Set up Three.js renderer once shapes are ready ----
  useEffect(() => {
    if (!shapes || !containerRef.current) return
    const container = containerRef.current

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: false,
      })
    } catch (err) {
      // No WebGL context available (headless browsers, very old
      // hardware, certain VM environments). Surface a clear error
      // instead of crashing the React tree.
      setError(
        err instanceof Error
          ? err
          : new Error("WebGL is not available in this browser"),
      )
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio)
    // sRGB output so albedo textures (which we tag as sRGB) display
    // with correct gamma. Three.js tone-maps linearly through this
    // pipeline by default since r152.
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const updateSize = () => {
      const { clientWidth, clientHeight } = container
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / Math.max(1, clientHeight)
      camera.updateProjectionMatrix()
    }

    container.appendChild(renderer.domElement)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"

    const scene = new THREE.Scene()
    scene.background = null

    // Add some ambient + directional fill so even non-textured meshes
    // read clearly. (MeshNormalMaterial doesn't actually need lights,
    // but if we swap to standard material later these stay relevant.)
    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(2, 4, 3)
    scene.add(dir)

    // Combined bounding box from each shape's mesh — computed in
    // world space so it accounts for per-shape bone-attach matrices
    // (Yoshi's eye lifted to head height, etc.). Falls back to the
    // raw geometry AABB for shapes whose mesh hasn't been rendered
    // yet (matrixWorld is up-to-date because we set position /
    // quaternion / scale and matrixAutoUpdate is true; calling
    // updateMatrixWorld(true) here forces recompute).
    const bb = new THREE.Box3()
    const tmpBox = new THREE.Box3()
    for (const r of shapes) {
      r.mesh.updateMatrixWorld(true)
      const geom = r.mesh.geometry
      if (!geom.boundingBox) geom.computeBoundingBox()
      tmpBox.copy(geom.boundingBox!).applyMatrix4(r.mesh.matrixWorld)
      bb.union(tmpBox)
    }
    const center = new THREE.Vector3()
    bb.getCenter(center)
    const size = new THREE.Vector3()
    bb.getSize(size)
    const radius = Math.max(size.x, size.y, size.z) || 1

    const camera = new THREE.PerspectiveCamera(45, 1, radius * 0.01, radius * 100)
    // Position the camera up-and-back, looking at the model centre.
    camera.position.set(
      center.x + radius * 1.5,
      center.y + radius * 1.5,
      center.z + radius * 2.5,
    )
    camera.lookAt(center)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.copy(center)
    controls.dampingFactor = 0.1
    controls.enableDamping = true
    controls.update()

    // Add the meshes to the scene (visibility driven by the React
    // `shapes` state via the `visible` flag).
    for (const r of shapes) {
      r.mesh.visible = r.visible
      // SkinnedMeshes go straight under the scene root. Plain
      // meshes parented to a bone (multi-FMDL Pupil case) already
      // have a parent in the scene graph; leave them alone.
      if (!r.mesh.parent) scene.add(r.mesh)
    }
    // Add scene-skeleton root bones so their world matrices are
    // computed each frame. SkinnedMeshes look up bones by reference,
    // so they need to be in the scene graph (any branch is fine).
    if (sceneSkeletonsRef.current) {
      for (const ss of sceneSkeletonsRef.current) {
        for (const root of ss.roots) {
          // A root bone might already be in the scene if e.g. it's
          // hosting a Pupil mesh as a descendant — but bones don't
          // have a parent unless we explicitly added them, so safe
          // to add unconditionally.
          if (!root.parent) scene.add(root)
        }
      }
    }

    let animationId = 0
    const loop = () => {
      try {
        // Drive the active animation forward in time. Frame state
        // is held in a ref so we don't burn React rerenders per
        // frame; the React `frame` state is only updated on user
        // interaction (scrubber) or for the UI's frame counter.
        const ctx = sceneRef.current
        if (ctx) {
          // (No-op here; per-frame anim sampling is in a separate
          // useEffect that subscribes to `currentAnim` / `playing` /
          // `frame`.)
        }
        controls.update()
        renderer.render(scene, camera)
        animationId = requestAnimationFrame(loop)
      } catch (err) {
        // Hot-reload edge case: the GL context can be lost between
        // frames. Don't keep scheduling more frames; surface the
        // error instead.
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    }
    updateSize()
    animationId = requestAnimationFrame(loop)

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      animationId,
      skeletonGroup: null,
    }

    // Resize handling — observe the container, not just window.
    const ro = new ResizeObserver(updateSize)
    ro.observe(container)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(animationId)
      controls.dispose()
      // Dispose every geometry / material / texture we created.
      // Multiple shapes can share the same `DataTexture` (same
      // texture name + wrap-mode pairing), so dedupe before
      // disposing — calling `.dispose()` twice on the same texture
      // is a no-op in Three.js but flags it as disposed mid-loop.
      const seenTextures = new Set<THREE.Texture>()
      for (const r of shapes) {
        r.mesh.geometry.dispose()
        if (r.mesh.material instanceof THREE.Material) {
          const m = r.mesh.material as THREE.Material & { map?: THREE.Texture }
          if (m.map && !seenTextures.has(m.map)) {
            seenTextures.add(m.map)
            m.map.dispose()
          }
          r.mesh.material.dispose()
        }
      }
      renderer.dispose()
      renderer.domElement.remove()
      sceneRef.current = null
    }
  }, [shapes])

  // ---- Manual scrub: apply animation at the current frame
  // when paused (the rAF loop below only runs while playing). ----
  useEffect(() => {
    if (playing) return
    const sceneSkeletons = sceneSkeletonsRef.current
    const animations = animationsRef.current
    if (!sceneSkeletons || !animations || !shapes) return
    const skelAnim =
      currentAnim >= 0 ? animations.skeletal[currentAnim] : null
    if (skelAnim) {
      for (const ss of sceneSkeletons) {
        applySkeletalAnim(ss, skelAnim, frame)
      }
    }
    // FMAA at the same frame, decoupled from FSKA. The two
    // are independently selected — the user can scrub through
    // a skeletal pose while a face flipbook continues to tick.
    const matAnim =
      currentMatAnim >= 0 ? animations.material[currentMatAnim] : null
    const cache = textureCacheRef.current
    const materials = materialsRef.current
    if (matAnim && cache && materials) {
      applyMaterialAnim(shapes, materials, cache, matAnim, frame)
    } else if (shapes) {
      resetMaterialAnim(shapes)
    }
  }, [playing, frame, currentAnim, currentMatAnim, shapes])

  // ---- Animation playback driver ----
  // When an animation is selected and playing, advance the frame
  // each rAF tick (fixed at the BFRES default 30 fps unless the
  // file says otherwise — Nintendo BFRES doesn't store an explicit
  // FPS, the convention is `frameCount` is in 30 fps frames).
  // On every frame we re-evaluate every animated bone's curves and
  // write into the `THREE.Bone`s of the scene skeleton; the bound
  // SkinnedMeshes deform automatically next render. FMAA is
  // applied alongside on the same frame counter.
  useEffect(() => {
    const sceneSkeletons = sceneSkeletonsRef.current
    const animations = animationsRef.current
    if (!sceneSkeletons || !animations || !shapes) return
    const skelAnim =
      currentAnim >= 0 ? animations.skeletal[currentAnim] : null
    const matAnim =
      currentMatAnim >= 0 ? animations.material[currentMatAnim] : null

    // Reset to bind pose when no skeletal animation is selected.
    if (!skelAnim) {
      const tmpMat = new THREE.Matrix4()
      for (const ss of sceneSkeletons) {
        for (let i = 0; i < ss.bones.length; i++) {
          const sb = ss.source.bones[i]!
          const tb = ss.bones[i]!
          tmpMat.fromArray(sb.localMatrix as unknown as number[])
          tmpMat.decompose(tb.position, tb.quaternion, tb.scale)
        }
      }
    }
    // Reset materials when no FMAA is selected.
    if (!matAnim) resetMaterialAnim(shapes)

    // Nothing to drive in the loop if neither's selected, OR
    // if we're paused — manual-scrub effect handles displayed
    // pose while paused.
    if ((!skelAnim && !matAnim) || !playing) return

    let cancelled = false
    let lastTimestamp = 0
    // Drive playback off whichever animation has the longer
    // frame count. With both selected we want the LCM to loop
    // cleanly, but for a v1 just take the max — the shorter
    // one will keep ticking past its end (clamped) which is
    // visually fine for short FMAAs that loop within a long
    // FSKA.
    const fps = 30 // BFRES convention
    const skelFrames = skelAnim ? Math.max(1, skelAnim.frameCount) : 1
    const matFrames = matAnim ? Math.max(1, matAnim.frameCount) : 1
    const totalFrames = Math.max(skelFrames, matFrames)
    // Whether the longest-running animation loops. End-of-clip
    // detection only triggers when the *driving* animation
    // doesn't loop; if either loops we just keep going.
    const drivingLoops =
      (skelAnim?.loop ?? false) || (matAnim?.loop ?? false)
    let localFrame = frame
    if (!drivingLoops && localFrame >= totalFrames - 1) localFrame = 0

    const tick = (timestamp: number) => {
      if (cancelled) return
      let endReached = false
      if (lastTimestamp > 0) {
        const dt = (timestamp - lastTimestamp) / 1000
        localFrame += dt * fps
        if (localFrame >= totalFrames) {
          if (drivingLoops) {
            localFrame %= totalFrames
          } else {
            localFrame = totalFrames - 1
            endReached = true
          }
        }
      }
      lastTimestamp = timestamp

      // Apply both animations at the same frame. FMAA frame
      // counts may be smaller than FSKA's; we wrap the FMAA
      // frame around its own length so it loops as it usually
      // does in-game.
      if (skelAnim) {
        for (const ss of sceneSkeletons) {
          applySkeletalAnim(ss, skelAnim, localFrame)
        }
      }
      if (matAnim) {
        const cache = textureCacheRef.current
        const materials = materialsRef.current
        if (cache && materials) {
          const matFrame = matAnim.loop
            ? localFrame % Math.max(1, matAnim.frameCount)
            : Math.min(localFrame, matAnim.frameCount - 1)
          applyMaterialAnim(shapes, materials, cache, matAnim, matFrame)
        }
      }

      const rounded = Math.floor(localFrame)
      setFrame((cur) => (cur === rounded ? cur : rounded))

      if (endReached) {
        // Stop the rAF loop and flip the React-state `playing`
        // flag so the play/pause button reads "Play" again.
        // Setting `playing` to false also re-fires this effect
        // (it's in the dep list), which tears down via the
        // cleanup return below.
        setPlaying(false)
        return
      }
      requestAnimationFrame(tick)
    }
    const id = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
    // We intentionally don't list `frame` here — the rAF loop reads
    // it via the closure'd `localFrame` and only writes to React
    // state for UI display. Re-running the effect on every frame
    // tick would tear down and rebuild the rAF loop unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, currentAnim, currentMatAnim, playing])

  // ---- Skeleton wireframe overlay ----
  // Driven by `showSkeleton`: when on, build a Group of LineSegments
  // (parent→child bone connections, color-coded per-FMDL) plus
  // small markers at each bone tip and a tiny axes helper at world
  // origin. Toggling off disposes the group. Used purely for
  // debugging bone-attach positioning bugs.
  useEffect(() => {
    const ctx = sceneRef.current
    if (!ctx) return
    if (ctx.skeletonGroup) {
      ctx.scene.remove(ctx.skeletonGroup)
      disposeSkeletonGroup(ctx.skeletonGroup)
      ctx.skeletonGroup = null
    }
    if (!showSkeleton || !skeletonsRef.current) return
    const group = buildSkeletonGroup(skeletonsRef.current)
    ctx.scene.add(group)
    ctx.skeletonGroup = group
    return () => {
      const c = sceneRef.current
      if (c?.skeletonGroup === group) {
        c.scene.remove(group)
        disposeSkeletonGroup(group)
        c.skeletonGroup = null
      }
    }
  }, [showSkeleton, shapes])

  // ---- Toggle visibility of a single shape ----
  // We deliberately mutate the existing `ShapeRecord` array in
  // place (rather than allocating a new one) and then nudge a
  // small counter to force a re-render. Replacing the array
  // would change its referential identity, which would re-fire
  // every effect that depends on `[shapes]` — including the
  // scene-creation effect, which would tear down the renderer
  // and dispose the very meshes we just toggled.
  const [, setVisibilityTick] = useState(0)
  const toggleShape = (index: number) => {
    if (!shapes) return
    const r = shapes[index]
    if (!r) return
    r.visible = !r.visible
    r.mesh.visible = r.visible
    setVisibilityTick((t) => t + 1)
  }

  if (error) return <ViewerError error={error} />
  if (!shapes) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Decoding geometry…
      </div>
    )
  }

  const skeletalAnims = animationsRef.current?.skeletal ?? []
  const materialAnims = animationsRef.current?.material ?? []
  const activeAnim = currentAnim >= 0 ? skeletalAnims[currentAnim] : null
  const activeMatAnim =
    currentMatAnim >= 0 ? materialAnims[currentMatAnim] : null
  // Scrubber range = the longer of the two selected animations.
  // Either being selected enables playback / scrub UI.
  const scrubMax = Math.max(
    activeAnim ? activeAnim.frameCount - 1 : 0,
    activeMatAnim ? activeMatAnim.frameCount - 1 : 0,
  )
  const totalFrames = scrubMax
  const anyAnimSelected = currentAnim >= 0 || currentMatAnim >= 0

  return (
    // Outer column lays out the canvas, control bars, and the
    // per-shape toggle grid. Crucially we do NOT take `h-full`
    // here: the parent (BfresPreview) is inside a vertically
    // scrolling region, and a fixed-height viewer with a long
    // shape list would clip the toggles or overlap whatever
    // the parent paints below us. Instead the canvas itself
    // gets an explicit height, and everything else flows.
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        className="relative h-[420px] overflow-hidden rounded-md border bg-gradient-to-b from-muted/40 to-background"
      />
      {/* Animation control bar — renders when the BFRES has at
          least one skeletal or material animation. The two
          dropdowns each select one clip independently; play /
          pause and the frame scrubber drive both at once on a
          shared frame counter. */}
      {(skeletalAnims.length > 0 || materialAnims.length > 0) ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {skeletalAnims.length > 0 && (
            <select
              value={currentAnim}
              onChange={(e) => {
                const idx = Number(e.target.value)
                setCurrentAnim(idx)
                setFrame(0)
                if (idx >= 0) setPlaying(true)
              }}
              title="Skeletal animation (FSKA) — drives bone movement"
              className="rounded-md border bg-card px-2 py-1"
            >
              <option value={-1}>(no skeletal — bind pose)</option>
              {skeletalAnims.map((a, i) => (
                <option key={i} value={i}>
                  {a.name} ({a.frameCount}f{a.loop ? ", loop" : ""})
                </option>
              ))}
            </select>
          )}
          {materialAnims.length > 0 && (
            <select
              value={currentMatAnim}
              onChange={(e) => {
                const idx = Number(e.target.value)
                setCurrentMatAnim(idx)
                setFrame(0)
                if (idx >= 0) setPlaying(true)
              }}
              title="Material animation (FMAA) — drives texture flips, eye blinks, glow pulses, etc."
              className="rounded-md border bg-card px-2 py-1"
            >
              <option value={-1}>(no material anim)</option>
              {materialAnims.map((a, i) => (
                <option key={i} value={i}>
                  {a.name} ({a.frameCount}f{a.loop ? ", loop" : ""})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            disabled={!anyAnimSelected}
            aria-label={playing ? "Pause animation" : "Play animation"}
            title={playing ? "Pause" : "Play"}
            className="inline-flex items-center justify-center rounded-md border bg-card p-1.5 disabled:opacity-50"
          >
            {playing ? (
              <PauseIcon className="size-4" />
            ) : (
              <PlayIcon className="size-4" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={totalFrames}
            step={1}
            value={Math.min(frame, totalFrames)}
            onChange={(e) => {
              setFrame(Number(e.target.value))
              setPlaying(false)
            }}
            disabled={!anyAnimSelected}
            className="flex-1"
          />
          <span className="font-mono text-muted-foreground tabular-nums">
            {anyAnimSelected ? `${Math.min(frame, totalFrames)} / ${totalFrames}` : "—"}
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <span>Smooth</span>
          <select
            value={stlSubdivision}
            onChange={(e) => setStlSubdivision(Number(e.target.value))}
            title="Loop subdivision passes applied before STL export. Each pass quadruples the triangle count and rounds out corners."
            className="rounded-md border bg-card px-1.5 py-0.5"
          >
            <option value={0}>None</option>
            <option value={1}>1× (4× tris)</option>
            <option value={2}>2× (16× tris)</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            const ctx = sceneRef.current
            if (!ctx || !shapes) return
            // Encode the active animation + frame into the STL
            // file name so a sequence of exports stays orderable
            // by name. Bind pose gets a clean "_bind" suffix.
            const safeName = (s: string) =>
              s.replace(/[^A-Za-z0-9._-]+/g, "_")
            const suffix = activeAnim
              ? `_${safeName(activeAnim.name)}_f${String(
                  Math.min(frame, totalFrames),
                ).padStart(4, "0")}`
              : "_bind"
            exportPosedSTL(
              shapes,
              ctx.scene,
              node.name,
              suffix,
              stlSubdivision,
            )
          }}
          disabled={!shapes || shapes.length === 0}
          title="Download the current pose as a binary STL (Z-up, slicer-ready)"
          className="rounded-md border bg-card px-2 py-1 disabled:opacity-50"
        >
          Download STL
        </button>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showSkeleton}
            onChange={(e) => setShowSkeleton(e.target.checked)}
            className="h-3 w-3"
          />
          <span>Show skeleton</span>
        </label>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {shapes.map((r, i) => {
          const tris = r.geom.indices.length / 3
          return (
            <label
              key={i}
              className="flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs"
            >
              <input
                type="checkbox"
                checked={r.visible}
                onChange={() => toggleShape(i)}
                className="h-3 w-3"
              />
              <span className="truncate" title={r.geom.name}>
                {r.geom.name || `(unnamed shape ${i})`}
              </span>
              {r.hasAlbedo ? (
                <span
                  className="shrink-0 rounded-sm bg-primary/15 px-1 text-[9px] font-medium uppercase tracking-wider text-primary"
                  title="Albedo texture bound from embedded BNTX"
                >
                  Tex
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                {r.geom.vertexCount}v / {tris}t
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
