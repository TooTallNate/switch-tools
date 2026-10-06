/**
 * Identifies the opened base file (NSP / XCI / ROM / directory) for 3D
 * export, so every model exported from it shares one print scale (see
 * `~/lib/print-scale`). Provided by the app around the preview pane;
 * viewers read it via {@link useModelExportScope}.
 */
import { createContext, useContext } from "react"

export interface ModelExportScope {
  /** Stable identity of the base file (persisted scale key). */
  key: string
  /** Display name, e.g. "Super Mario Odyssey.nsp". */
  label: string
}

export const ModelExportScopeContext = createContext<ModelExportScope | null>(null)

/** The current base file, or a shared fallback outside any opened file. */
export function useModelExportScope(): ModelExportScope {
  return useContext(ModelExportScopeContext) ?? { key: "(none)", label: "this file" }
}
