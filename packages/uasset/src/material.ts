/**
 * Helpers for extracting structured data from UE `MaterialInstanceConstant`
 * and `Material` assets. Both classes expose their texture / scalar / vector
 * parameter values via property-tag arrays; the entry types are
 * `TextureParameterValue`, `ScalarParameterValue`, and `VectorParameterValue`.
 *
 * Each entry has the same generic shape:
 *
 *   struct TextureParameterValue {
 *     FMaterialParameterInfo ParameterInfo;
 *     UTexture*              ParameterValue;
 *     FGuid                  ExpressionGUID;
 *   }
 *
 *   struct FMaterialParameterInfo {
 *     FName Name;
 *     u8    Association;      (= 0 / GlobalParameter for non-layer params)
 *     i32   Index;            (= -1 for non-layer params)
 *   }
 *
 * The extractors here pluck out `Name → ParameterValue` pairs so the caller
 * (typically a UI that wants to apply textures to a model) doesn't have to
 * descend through the nested tag tree by hand.
 */

import type { UProperty, UValue } from './properties.js';

/** One decoded entry from a MaterialInstance's `TextureParameterValues` array. */
export interface MaterialTextureParameter {
	/** Slot name as declared on the parent Material (e.g. `"BaseColor"`, `"Normal"`). */
	parameterName: string;
	/**
	 * Raw `FPackageIndex` of the referenced texture asset.
	 *   - Negative → resolve via {@link resolveImportPackagePath}
	 *   - Positive → an export in the same .uasset
	 *   - Zero → unset (parameter has no texture)
	 */
	parameterValueIndex: number;
}

export interface MaterialScalarParameter {
	parameterName: string;
	value: number;
}

export interface MaterialVectorParameter {
	parameterName: string;
	/** Linear-color RGBA tuple (0..1 per channel). */
	value: { r: number; g: number; b: number; a: number };
}

/**
 * Extract every `TextureParameterValues[i] = { ParameterInfo.Name, ParameterValue }`
 * pair from a decoded property list. Entries whose ParameterValue is `None`
 * (FPackageIndex == 0) are skipped — those are slots the artist intentionally
 * cleared.
 *
 * @param properties  result of `readExportProperties(...).properties`
 */
export function extractTextureParameters(
	properties: UProperty[],
): MaterialTextureParameter[] {
	const out: MaterialTextureParameter[] = [];
	const tpv = properties.find((p) => p.name === 'TextureParameterValues');
	if (!tpv || tpv.value.kind !== 'array') return out;
	for (const entry of tpv.value.values) {
		const parsed = readParameterValueEntry(entry, 'ParameterValue');
		if (!parsed || parsed.value.kind !== 'object') continue;
		if (parsed.value.index === 0) continue; // intentionally cleared slot
		out.push({
			parameterName: parsed.parameterName,
			parameterValueIndex: parsed.value.index,
		});
	}
	return out;
}

/** Same as {@link extractTextureParameters} but for `ScalarParameterValues`. */
export function extractScalarParameters(
	properties: UProperty[],
): MaterialScalarParameter[] {
	const out: MaterialScalarParameter[] = [];
	const tpv = properties.find((p) => p.name === 'ScalarParameterValues');
	if (!tpv || tpv.value.kind !== 'array') return out;
	for (const entry of tpv.value.values) {
		const parsed = readParameterValueEntry(entry, 'ParameterValue');
		if (!parsed || parsed.value.kind !== 'float') continue;
		out.push({ parameterName: parsed.parameterName, value: parsed.value.value });
	}
	return out;
}

/**
 * Same as {@link extractTextureParameters} but for `VectorParameterValues`.
 * UE stores them as `LinearColor` native structs.
 */
export function extractVectorParameters(
	properties: UProperty[],
): MaterialVectorParameter[] {
	const out: MaterialVectorParameter[] = [];
	const tpv = properties.find((p) => p.name === 'VectorParameterValues');
	if (!tpv || tpv.value.kind !== 'array') return out;
	for (const entry of tpv.value.values) {
		const parsed = readParameterValueEntry(entry, 'ParameterValue');
		if (!parsed) continue;
		if (parsed.value.kind === 'struct' && parsed.value.native?.kind === 'LinearColor') {
			const lc = parsed.value.native;
			out.push({
				parameterName: parsed.parameterName,
				value: { r: lc.r, g: lc.g, b: lc.b, a: lc.a },
			});
		}
	}
	return out;
}

/**
 * Find the `Parent` ObjectProperty on a MaterialInstance — the import
 * index of the base Material this instance inherits from.
 *
 * Returns the FPackageIndex (negative = import, 0 = None).
 */
export function extractMaterialParentIndex(properties: UProperty[]): number {
	const parent = properties.find((p) => p.name === 'Parent');
	if (parent?.value.kind === 'object') return parent.value.index;
	return 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a `*ParameterValue` struct entry:
 *
 *   struct ScalarParameterValue {
 *     FMaterialParameterInfo ParameterInfo;
 *     float                  ParameterValue;        // or "ParameterValue" object / linear color
 *     FGuid                  ExpressionGUID;
 *   }
 *
 * Returns the inner `ParameterInfo.Name` (string) + the typed
 * ParameterValue payload, or null when the entry shape doesn't match.
 */
function readParameterValueEntry(
	entry: UValue,
	valueProp: string,
): { parameterName: string; value: UValue } | null {
	if (entry.kind !== 'struct' || !entry.properties) return null;
	let parameterName: string | null = null;
	let value: UValue | null = null;
	for (const sub of entry.properties) {
		if (sub.name === 'ParameterInfo' && sub.value.kind === 'struct' && sub.value.properties) {
			for (const inner of sub.value.properties) {
				if (inner.name === 'Name' && inner.value.kind === 'name') {
					parameterName = inner.value.value;
				}
			}
		} else if (sub.name === valueProp) {
			value = sub.value;
		}
	}
	if (parameterName === null || value === null) return null;
	return { parameterName, value };
}
