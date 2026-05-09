/**
 * Collapsible inspector views for arbitrary JSON-shaped data,
 * built on `react-inspector`.
 *
 * Two flavours:
 *
 *   - {@link JsonInspector}  — pure JSON / YAML / JS-object data.
 *     Just hands the value to `react-inspector` with our shared
 *     theme. Use this for `.json` / `.yaml` previews.
 *   - {@link UnityObjectInspector} — adds Unity-specific value
 *     transformations on top: `Uint8Array` collapses to a hex-peek
 *     chip instead of expanding into thousands of numeric keys,
 *     `bigint` strips the `n` suffix, PPtr-shaped objects
 *     (`{ m_FileID, m_PathID }`) render as a single non-expandable
 *     badge.
 *
 * Both share the same `react-inspector` theme so the look is
 * consistent across the app.
 */

import { useMemo } from "react"
import {
  ObjectInspector,
  ObjectName,
  ObjectLabel,
  ObjectRootLabel,
} from "react-inspector"
import { useTheme } from "next-themes"

// ---------------------------------------------------------------------------
// Public components
// ---------------------------------------------------------------------------

export interface JsonInspectorProps {
  /** Any JSON-shaped value (objects, arrays, strings, numbers, …). */
  data: unknown
  /** Optional name shown next to the root node. */
  name?: string
  /** Initial expand depth. Default 1 — the root expanded, children collapsed. */
  expandLevel?: number
}

/**
 * Render arbitrary JSON-shaped data as a collapsible tree. Mounts a
 * single `react-inspector` `<ObjectInspector>` with our shared
 * theme. Pass any JS value the JSON spec can describe (objects,
 * arrays, strings, numbers, booleans, null) plus `bigint` and
 * `Date` (which `react-inspector` handles natively).
 */
export function JsonInspector({
  data,
  name,
  expandLevel = 1,
}: JsonInspectorProps) {
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === "dark" ? darkTheme : lightTheme
  return (
    <div className="overflow-x-auto rounded-md border bg-background p-3">
      <ObjectInspector
        data={data}
        name={name}
        // react-inspector accepts theme objects at runtime even
        // though the type declares string only. See the README's
        // theming section for the full list of supported keys.
        // @ts-expect-error theme prop accepts both theme name strings and theme objects
        theme={theme}
        expandLevel={expandLevel}
      />
    </div>
  )
}

export interface UnityObjectInspectorProps extends JsonInspectorProps {}

/**
 * Variant of {@link JsonInspector} for Unity-decoded values. Adds
 * a custom `nodeRenderer` and a value pre-walker that:
 *
 *   - **`Uint8Array`** (e.g. `m_FontData`, embedded textures,
 *     MonoScript blobs) renders as a compact `Uint8Array(N bytes)`
 *     chip with a hex peek of the first 16 bytes — instead of
 *     expanding into thousands of numeric-keyed entries.
 *   - **`bigint`** (used for Unity `pathId`s and other 64-bit
 *     fields) renders as a plain decimal string, dropping the `n`
 *     suffix.
 *   - **PPtr** objects (`{ m_FileID, m_PathID }`) collapse to a
 *     single non-expandable badge formatted like
 *     `PPtr<fileId=0, pathId=…>`.
 */
export function UnityObjectInspector({
  data,
  name,
  expandLevel = 1,
}: UnityObjectInspectorProps) {
  const prepared = useMemo(
    () => prepareUnityValueForInspector(data),
    [data],
  )
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === "dark" ? darkTheme : lightTheme
  return (
    <div className="overflow-x-auto rounded-md border bg-background p-3">
      <ObjectInspector
        data={prepared}
        name={name}
        // @ts-expect-error theme prop accepts both theme name strings and theme objects
        theme={theme}
        nodeRenderer={UnityNodeRenderer}
        expandLevel={expandLevel}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Unity-specific opaque ref markers + pre-walker
// ---------------------------------------------------------------------------

const BYTES_TYPE = "__nx_bytes__"
const PPTR_TYPE = "__nx_pptr__"

interface BytesRef {
  __type: typeof BYTES_TYPE
  length: number
  hexPeek: string
}

interface PPtrRef {
  __type: typeof PPTR_TYPE
  fileId: number
  pathId: string
}

function isBytesRef(value: unknown): value is BytesRef {
  if (value === null || typeof value !== "object") return false
  const desc = Object.getOwnPropertyDescriptor(value, "__type")
  return desc?.value === BYTES_TYPE
}

function isPPtrRef(value: unknown): value is PPtrRef {
  if (value === null || typeof value !== "object") return false
  const desc = Object.getOwnPropertyDescriptor(value, "__type")
  return desc?.value === PPTR_TYPE
}

/**
 * Build an opaque object that carries data on non-enumerable
 * properties so `react-inspector` won't render expansion arrows or
 * iterate into it. Our `nodeRenderer` detects the ref via the
 * non-enumerable `__type` and renders a custom inline label.
 */
function makeOpaqueRef(props: Record<string, unknown>): unknown {
  const opaque = Object.create(null)
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(opaque, k, { value: v, enumerable: false })
  }
  return opaque
}

function bytesRef(bytes: Uint8Array): unknown {
  const peek = bytes.subarray(0, 16)
  const hex = Array.from(peek)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
  return makeOpaqueRef({
    __type: BYTES_TYPE,
    length: bytes.length,
    hexPeek: hex,
  })
}

function pptrRef(fileId: number, pathId: bigint | number): unknown {
  return makeOpaqueRef({
    __type: PPTR_TYPE,
    fileId,
    pathId: typeof pathId === "bigint" ? pathId.toString() : String(pathId),
  })
}

/**
 * Recognise Unity's PPtr serialisation shape. PPtr<T> has exactly
 * two fields, `m_FileID` (i32) and `m_PathID` (i64). Some Unity
 * versions add a `m_Type` field for `MonoScript` references; we
 * tolerate that as a third field.
 */
function isPPtrShape(o: Record<string, unknown>): boolean {
  if (!("m_FileID" in o) || !("m_PathID" in o)) return false
  const keys = Object.keys(o)
  if (keys.length > 3) return false
  if (typeof o.m_FileID !== "number") return false
  if (typeof o.m_PathID !== "bigint" && typeof o.m_PathID !== "number") {
    return false
  }
  return true
}

/**
 * Recursively transform a decoded Unity value tree into a form
 * `react-inspector` renders well. Plain objects / arrays are walked
 * (returning new copies); leaves we want to handle specially get
 * replaced with opaque refs that the `nodeRenderer` intercepts.
 *
 * Cycle protection isn't needed — Unity's TypeTree-decoded values
 * are pure JSON-shaped trees with no back references.
 */
export function prepareUnityValueForInspector(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") {
    // react-inspector renders bigints as `123n`. Strip the `n`
    // suffix so 64-bit ids read like the path-id strings used
    // elsewhere in the UI (download names, KvBlock headers, etc).
    return value.toString()
  }
  if (value instanceof Uint8Array) return bytesRef(value)
  if (Array.isArray(value)) {
    return value.map(prepareUnityValueForInspector)
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    if (isPPtrShape(o)) {
      return pptrRef(o.m_FileID as number, o.m_PathID as bigint | number)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      out[k] = prepareUnityValueForInspector(v)
    }
    return out
  }
  return value
}

interface NodeRendererProps {
  depth: number
  name?: string
  data: unknown
  isNonenumerable?: boolean
  expanded?: boolean
}

function UnityNodeRenderer({
  depth,
  name,
  data,
  isNonenumerable,
}: NodeRendererProps) {
  if (isBytesRef(data)) {
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        <BytesLabel data={data} />
      </span>
    )
  }
  if (isPPtrRef(data)) {
    return (
      <span>
        {name != null && <ObjectName name={name} />}
        {name != null && <span>: </span>}
        <PPtrLabel data={data} />
      </span>
    )
  }
  if (depth === 0) {
    return <ObjectRootLabel name={name} data={data} />
  }
  return (
    <ObjectLabel name={name} data={data} isNonenumerable={isNonenumerable} />
  )
}

function BytesLabel({ data }: { data: BytesRef }) {
  const summary =
    data.length === 0
      ? "empty"
      : `${data.length.toLocaleString()} bytes · ${data.hexPeek}${data.length > 16 ? " …" : ""}`
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded border bg-muted/50 px-1.5 py-0 align-baseline font-mono text-[10px] text-muted-foreground"
      title={`Uint8Array(${data.length}) — first ${Math.min(16, data.length)} bytes shown`}
    >
      <span className="text-foreground">Uint8Array</span>
      <span>({summary})</span>
    </span>
  )
}

function PPtrLabel({ data }: { data: PPtrRef }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded border bg-muted/50 px-1.5 py-0 align-baseline font-mono text-[10px] text-muted-foreground"
      title={`PPtr fileId=${data.fileId} pathId=${data.pathId}`}
    >
      <span className="text-foreground">PPtr</span>
      <span>
        {data.fileId === 0
          ? `pathId=${data.pathId}`
          : `fileId=${data.fileId}, pathId=${data.pathId}`}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Theme — maps to the app's shadcn / Tailwind v4 CSS variables so the
// inspector colors track the active light/dark theme automatically.
// ---------------------------------------------------------------------------

const sharedTheme = {
  BASE_FONT_FAMILY: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
  BASE_FONT_SIZE: "12px",
  BASE_LINE_HEIGHT: 1.45,
  BASE_BACKGROUND_COLOR: "transparent",
  OBJECT_PREVIEW_ARRAY_MAX_PROPERTIES: 6,
  OBJECT_PREVIEW_OBJECT_MAX_PROPERTIES: 5,
  HTML_TAGNAME_TEXT_TRANSFORM: "lowercase" as const,
  ARROW_MARGIN_RIGHT: 4,
  ARROW_FONT_SIZE: 11,
  TREENODE_FONT_FAMILY: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
  TREENODE_FONT_SIZE: "12px",
  TREENODE_LINE_HEIGHT: 1.45,
  TREENODE_PADDING_LEFT: 14,
}

const lightTheme = {
  ...sharedTheme,
  BASE_COLOR: "oklch(0.205 0 0)",
  OBJECT_NAME_COLOR: "oklch(0.205 0 0)",
  OBJECT_VALUE_NULL_COLOR: "oklch(0.5 0 0)",
  OBJECT_VALUE_UNDEFINED_COLOR: "oklch(0.5 0 0)",
  OBJECT_VALUE_REGEXP_COLOR: "oklch(0.5 0.2 280)",
  OBJECT_VALUE_STRING_COLOR: "oklch(0.45 0.18 145)",
  OBJECT_VALUE_SYMBOL_COLOR: "oklch(0.45 0.18 145)",
  OBJECT_VALUE_NUMBER_COLOR: "oklch(0.5 0.18 250)",
  OBJECT_VALUE_BOOLEAN_COLOR: "oklch(0.5 0.18 30)",
  OBJECT_VALUE_FUNCTION_PREFIX_COLOR: "oklch(0.5 0.2 280)",
  ARROW_COLOR: "oklch(0.5 0 0)",
}

const darkTheme = {
  ...sharedTheme,
  BASE_COLOR: "oklch(0.95 0 0)",
  OBJECT_NAME_COLOR: "oklch(0.95 0 0)",
  OBJECT_VALUE_NULL_COLOR: "oklch(0.6 0 0)",
  OBJECT_VALUE_UNDEFINED_COLOR: "oklch(0.6 0 0)",
  OBJECT_VALUE_REGEXP_COLOR: "oklch(0.7 0.18 280)",
  OBJECT_VALUE_STRING_COLOR: "oklch(0.75 0.18 145)",
  OBJECT_VALUE_SYMBOL_COLOR: "oklch(0.75 0.18 145)",
  OBJECT_VALUE_NUMBER_COLOR: "oklch(0.72 0.18 250)",
  OBJECT_VALUE_BOOLEAN_COLOR: "oklch(0.7 0.18 30)",
  OBJECT_VALUE_FUNCTION_PREFIX_COLOR: "oklch(0.7 0.18 280)",
  ARROW_COLOR: "oklch(0.6 0 0)",
}
