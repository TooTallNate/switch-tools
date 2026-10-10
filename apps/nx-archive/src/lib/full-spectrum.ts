/**
 * Snapmaker U1 "Full Spectrum" export: more colours than toolheads by
 * painting with *mixed* virtual filaments that Snapmaker Orca prints
 * by alternating layers of two physical filaments along Z.
 *
 * How it maps onto Snapmaker Orca (verified against its source,
 * `src/libslic3r/MixedFilament.{hpp,cpp}`, `Format/bbs_3mf.cpp`,
 * `slic3r/GUI/Plater.cpp`):
 *
 *   - Mixed filaments are *virtual filament IDs* numbered after the
 *     physical ones: with 4 physical filaments the first enabled mix is
 *     filament 5, the next 6, … — so the existing `paint_color`
 *     encoding addresses them directly.
 *   - Mix recipes live in the project setting
 *     `mixed_filament_definitions`, a `;`-separated list of rows
 *     (`MixedFilamentManager::serialize_custom_entries`). Virtual IDs
 *     enumerate the *enabled, non-deleted* rows in serialized order.
 *   - With the "auto-generate gradients" preference on (the default for
 *     ≤ 4 filaments), Orca also creates all C(N,2) 50/50 pairs and
 *     appends any that the definitions don't mention. We therefore list
 *     our rows first and then every auto pair marked deleted, so our
 *     mixes land on IDs 5, 6, … whether the preference is on or off.
 *   - Snapmaker Orca reads `Metadata/project_settings.config` (JSON)
 *     from any 3MF and, on geometry import into an empty project,
 *     applies `filament_colour` and `mixed_filament_definitions`.
 *   - Mixed colours are previewed with FilamentMixer
 *     ({@link filamentMixerLerp}), after converting the mix percentage
 *     into an integer layer cadence (33 % → A, A, B). We predict mix
 *     colours the same way, so palettes match the slicer's swatches.
 *
 * Only Snapmaker Orca understands virtual filaments; other slicers
 * discard paint states above their physical filament count.
 */
import { filamentMixerBlend } from './filament-mixer';
import type { ExportMesh } from './mesh-export';
import {
	buildPainted3MF,
	rgbToHex,
	rgbToLab,
	type ColorBin,
	type Paint3mfOptions,
	type Rgb,
} from './mesh-export-3mf';
import type { RepairSummary } from './mesh-repair';
import { SNAPMAKER_U1, projectSettingsConfig } from './slicer-profile';

export interface PhysicalFilament {
	name: string;
	rgb: Rgb;
}

/**
 * Snapmaker PLA Full Spectrum Filament Bundle, in the toolhead order
 * Snapmaker's colour reference assumes (wiki "Full Spectrum Color
 * Reference", Table 1).
 */
export const FULL_SPECTRUM_BUNDLE: readonly PhysicalFilament[] = [
	{ name: 'Cyan', rgb: [0x08, 0xab, 0xfb] },
	{ name: 'Magenta', rgb: [0xd9, 0x3b, 0x90] },
	{ name: 'Yellow', rgb: [0xf9, 0xed, 0x3d] },
	{ name: 'Gray', rgb: [0x91, 0x99, 0xa4] },
];

/** Centre of the Snapmaker U1 plate (see {@link SNAPMAKER_U1}). */
export const U1_BED_CENTER: readonly [number, number] = SNAPMAKER_U1.bedCenter;

/**
 * Mix percentages (of the second component) offered as candidates.
 * Snapmaker recommends two-colour mixes with each component between
 * 33 % and 67 % for the most predictable results.
 */
export const DEFAULT_MIX_PERCENTS: readonly number[] = [33, 50, 67];

/** A two-component mixed filament. */
export interface MixRecipe {
	/** 1-based physical filament IDs, `a < b`. */
	a: number;
	b: number;
	/** Percentage of `b` (0–100), as stored in `mix_b_percent`. */
	mixB: number;
	/** Predicted appearance (Snapmaker Orca's preview colour). */
	rgb: Rgb;
}

/**
 * Layer cadence Snapmaker Orca derives from a mix percentage
 * (`effective_pair_preview_ratios`): the minor component gets one
 * layer, the major component `round(major / minor)` layers.
 */
export function pairLayerRatios(percentB: number): [number, number] {
	const b = Math.min(100, Math.max(0, Math.round(percentB)));
	if (b >= 100) return [0, 1];
	if (b <= 0) return [1, 0];
	const a = 100 - b;
	const bMajor = b >= a;
	const major = Math.max(1, Math.round((bMajor ? b : a) / Math.max(1, bMajor ? a : b)));
	return bMajor ? [1, major] : [major, 1];
}

/** Predicted colour of a pair mix, as Snapmaker Orca previews it. */
export function mixPreviewColor(base: readonly Rgb[], a: number, b: number, percentB: number): Rgb {
	const [ra, rb] = pairLayerRatios(percentB);
	// `blend_color_multi` folds colours in ascending filament-ID order.
	const [lo, hi, wLo, wHi] = a < b ? [a, b, ra, rb] : [b, a, rb, ra];
	return filamentMixerBlend([
		{ rgb: base[lo - 1]!, weight: wLo },
		{ rgb: base[hi - 1]!, weight: wHi },
	]);
}

/** Every pair × percentage combination of the physical filaments. */
export function mixCandidates(
	base: readonly Rgb[],
	percents: readonly number[] = DEFAULT_MIX_PERCENTS,
): MixRecipe[] {
	const out: MixRecipe[] = [];
	const seen = new Set<string>();
	for (let a = 1; a <= base.length; a++) {
		for (let b = a + 1; b <= base.length; b++) {
			for (const mixB of percents) {
				// Different percentages can round to the same cadence.
				const key = `${a},${b},${pairLayerRatios(mixB).join(':')}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ a, b, mixB, rgb: mixPreviewColor(base, a, b, mixB) });
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Gamut check
// ---------------------------------------------------------------------------

/** Plain black / white filaments offered as swaps for one toolhead. */
export const BLACK_FILAMENT: PhysicalFilament = { name: 'Black', rgb: [0, 0, 0] };
export const WHITE_FILAMENT: PhysicalFilament = { name: 'White', rgb: [0xff, 0xff, 0xff] };

/** CIE76 ΔE beyond which a colour counts as out of reach. */
const UNREACHABLE_DE = 20;

export interface GamutReport {
	/** Area-weighted mean ΔE from the surface to the nearest reachable colour. */
	meanError: number;
	/** Area fractions (0–1) more than ΔE 20 from anything reachable. */
	unreachable: { dark: number; light: number; other: number };
	/** Best single-toolhead swap to black / white, when it clearly helps. */
	suggestion: {
		/** 0-based toolhead index. */
		toolhead: number;
		filament: PhysicalFilament;
		meanError: number;
		/** Relative reduction of `meanError` (0–1). */
		improvement: number;
	} | null;
}

function labOf(c: Rgb): [number, number, number] {
	const o = new Float64Array(3);
	rgbToLab(c[0], c[1], c[2], o, 0);
	return [o[0]!, o[1]!, o[2]!];
}

/** Mean ΔE and per-bin nearest distances against the reachable colours. */
function gamutError(binLab: Float64Array, weights: Float64Array, base: readonly Rgb[], percents: readonly number[]) {
	const reach = [...base, ...mixCandidates(base, percents).map((m) => m.rgb)].map(labOf);
	const n = weights.length;
	const dist = new Float64Array(n);
	let sum = 0, wsum = 0;
	for (let i = 0; i < n; i++) {
		let best = Infinity;
		for (const r of reach) {
			const dl = binLab[i * 3]! - r[0], da = binLab[i * 3 + 1]! - r[1], db = binLab[i * 3 + 2]! - r[2];
			const d = dl * dl + da * da + db * db;
			if (d < best) best = d;
		}
		dist[i] = Math.sqrt(best);
		sum += dist[i]! * weights[i]!;
		wsum += weights[i]!;
	}
	return { mean: wsum > 0 ? sum / wsum : 0, dist, wsum };
}

/**
 * How well can these physical filaments (plus their layer mixes)
 * reproduce the model's colours? Flags near-black / near-white areas
 * that no mix reaches — the Full Spectrum bundle's darkest mix is a
 * mid purple (L* ≈ 45) and its lightest colour is yellow — and
 * suggests swapping one toolhead for black or white when that clearly
 * lowers the error.
 */
export function analyzeGamut(
	bins: readonly ColorBin[],
	base: readonly PhysicalFilament[],
	percents: readonly number[] = DEFAULT_MIX_PERCENTS,
): GamutReport {
	const n = bins.length;
	const binLab = new Float64Array(n * 3);
	const weights = new Float64Array(n);
	bins.forEach((b, i) => {
		rgbToLab(b.rgb[0], b.rgb[1], b.rgb[2], binLab, i * 3);
		weights[i] = b.weight;
	});
	const baseRgb = base.map((f) => f.rgb);
	const cur = gamutError(binLab, weights, baseRgb, percents);

	const unreachable = { dark: 0, light: 0, other: 0 };
	for (let i = 0; i < n; i++) {
		if (cur.dist[i]! <= UNREACHABLE_DE) continue;
		const L = binLab[i * 3]!;
		const chroma = Math.hypot(binLab[i * 3 + 1]!, binLab[i * 3 + 2]!);
		const share = weights[i]! / (cur.wsum || 1);
		if (L < 30) unreachable.dark += share;
		else if (L > 80 && chroma < 20) unreachable.light += share;
		else unreachable.other += share;
	}

	let suggestion: GamutReport['suggestion'] = null;
	if (unreachable.dark + unreachable.light >= 0.03) {
		for (const filament of [BLACK_FILAMENT, WHITE_FILAMENT]) {
			for (let t = 0; t < base.length; t++) {
				if (rgbToHex(baseRgb[t]!) === rgbToHex(filament.rgb)) continue;
				const swapped = baseRgb.slice();
				swapped[t] = filament.rgb;
				const e = gamutError(binLab, weights, swapped, percents).mean;
				if (!suggestion || e < suggestion.meanError) {
					suggestion = { toolhead: t, filament, meanError: e, improvement: 1 - e / (cur.mean || 1) };
				}
			}
		}
		// Only worth suggesting when it's a clear win.
		if (suggestion && suggestion.improvement < 0.15) suggestion = null;
	}
	return { meanError: cur.mean, unreachable, suggestion };
}

/**
 * Pick up to `maxMixes` mixes that best reproduce the surface colours.
 * Physical filaments are always available; mixes are added greedily by
 * how much they reduce the area-weighted CIELAB error, stopping early
 * once a mix would no longer make a meaningful difference.
 */
export function chooseMixes(
	bins: readonly ColorBin[],
	base: readonly Rgb[],
	maxMixes: number,
	percents: readonly number[] = DEFAULT_MIX_PERCENTS,
): MixRecipe[] {
	const candidates = mixCandidates(base, percents);
	const n = bins.length;
	if (n === 0 || maxMixes <= 0 || candidates.length === 0) return [];

	const binLab = new Float64Array(n * 3);
	bins.forEach((bin, i) => rgbToLab(bin.rgb[0], bin.rgb[1], bin.rgb[2], binLab, i * 3));
	const labOf = (c: Rgb) => {
		const o = new Float64Array(3);
		rgbToLab(c[0], c[1], c[2], o, 0);
		return o;
	};
	const dist = (i: number, l: Float64Array) => {
		const dl = binLab[i * 3]! - l[0]!;
		const da = binLab[i * 3 + 1]! - l[1]!;
		const db = binLab[i * 3 + 2]! - l[2]!;
		return dl * dl + da * da + db * db;
	};

	// Current per-bin error against the physical filaments.
	const cur = new Float64Array(n).fill(Infinity);
	for (const c of base) {
		const l = labOf(c);
		for (let i = 0; i < n; i++) cur[i] = Math.min(cur[i]!, dist(i, l));
	}
	let totalErr = 0;
	for (let i = 0; i < n; i++) totalErr += bins[i]!.weight * cur[i]!;
	const initialErr = totalErr;

	const candLab = candidates.map((c) => labOf(c.rgb));
	const chosen: MixRecipe[] = [];
	const used = new Set<number>();
	while (chosen.length < maxMixes) {
		let best = -1;
		let bestGain = 0;
		for (let c = 0; c < candidates.length; c++) {
			if (used.has(c)) continue;
			let gain = 0;
			for (let i = 0; i < n; i++) {
				const d = dist(i, candLab[c]!);
				if (d < cur[i]!) gain += bins[i]!.weight * (cur[i]! - d);
			}
			if (gain > bestGain) {
				bestGain = gain;
				best = c;
			}
		}
		// Stop when the best remaining mix improves things by < 0.5 % of
		// the physical-only error: it would barely be used.
		if (best < 0 || bestGain < initialErr * 0.005) break;
		used.add(best);
		chosen.push(candidates[best]!);
		for (let i = 0; i < n; i++) cur[i] = Math.min(cur[i]!, dist(i, candLab[best]!));
		totalErr -= bestGain;
	}
	return chosen;
}

/**
 * Serialize `mixed_filament_definitions`: our mixes (enabled, custom,
 * Ratio mode — the same fields Snapmaker Orca's Ratio dialog writes for
 * a two-colour mix), then every auto-generated pair marked deleted so
 * it can't take a virtual ID ahead of ours. See the file header.
 */
export function mixedFilamentDefinitions(mixes: readonly MixRecipe[], physicalCount: number): string {
	const rows: string[] = [];
	let stableId = 1;
	for (const m of mixes) {
		rows.push(
			`${m.a},${m.b},1,1,${m.mixB},0,g,w,m2,z0,xa0,xb0,d0,o0,u${stableId++},cm0`,
		);
	}
	for (let a = 1; a <= physicalCount; a++) {
		for (let b = a + 1; b <= physicalCount; b++) {
			rows.push(`${a},${b},0,0,50,0,g,w,m2,z0,xa0,xb0,d1,o1,u${stableId++}`);
		}
	}
	return rows.join(';');
}

/**
 * Full Spectrum overrides of the U1 profile: Snapmaker's dedicated
 * colour-mixing process and the Full Spectrum PLA filament profile.
 */
export const U1_FULL_SPECTRUM_PRESETS = {
	process: '0.10mm Color Mixing @Snapmaker U1 (0.4 nozzle)',
	filament: 'Snapmaker PLA Full Spectrum @U1 0.4 nozzle',
} as const;

/**
 * `Metadata/project_settings.config` carrying filaments + mixes, on top
 * of the stock U1 presets (see `slicer-profile.ts` for why naming
 * system presets is required). Mix recipes and "Subdivide Mix Layer"
 * are *project* options (`s_project_options`), applied directly.
 */
export function fullSpectrumProjectSettings(base: readonly Rgb[], mixes: readonly MixRecipe[]): string {
	return projectSettingsConfig(SNAPMAKER_U1, base, {
		...U1_FULL_SPECTRUM_PRESETS,
		extra: {
			mixed_filament_definitions: mixedFilamentDefinitions(mixes, base.length),
			// "Subdivide Mix Layer" + "Apply Subdivision to Infill":
			// finer layers in mixed regions, as Snapmaker recommends.
			dithering_local_z_mode: '1',
			dithering_local_z_infill: '1',
		},
	});
}

export interface FullSpectrumOptions {
	/** Physical filaments in toolhead order. Default: the Full Spectrum bundle. */
	base?: readonly PhysicalFilament[];
	/** Maximum number of mixed filaments to add. */
	maxMixes: number;
	/** Candidate mix percentages. */
	mixPercents?: readonly number[];
	subdivisionPasses?: number;
	sourceAxis?: 'y-up' | 'z-up';
	title?: string;
	/** Plate centre to place the model at. Default: the U1's. */
	bedCenter?: readonly [number, number];
	/** See {@link Paint3mfOptions.repair}. Default true. */
	repair?: Paint3mfOptions['repair'];
	/** See {@link Paint3mfOptions.decals}. */
	decals?: Paint3mfOptions['decals'];
	/** See {@link Paint3mfOptions.objectName}. */
	objectName?: string;
	/** See {@link Paint3mfOptions.metadata}. */
	metadata?: Paint3mfOptions['metadata'];
}

export interface FullSpectrumResult {
	bytes: Uint8Array;
	base: readonly PhysicalFilament[];
	/** Chosen mixes; mix i is painted as filament `base.length + 1 + i`. */
	mixes: MixRecipe[];
	triangleCount: number;
	repair: RepairSummary | null;
}

/** Build a Snapmaker Orca Full Spectrum 3MF. */
export function buildFullSpectrum3MF(meshes: ExportMesh[], options: FullSpectrumOptions): FullSpectrumResult {
	const base = options.base ?? FULL_SPECTRUM_BUNDLE;
	const baseRgb = base.map((f) => f.rgb);
	let mixes: MixRecipe[] = [];
	const result = buildPainted3MF(meshes, {
		colorCount: baseRgb.length,
		subdivisionPasses: options.subdivisionPasses,
		sourceAxis: options.sourceAxis,
		title: options.title,
		repair: options.repair,
		decals: options.decals,
		objectName: options.objectName,
		metadata: options.metadata,
		choosePalette: (bins) => {
			mixes = chooseMixes(bins, baseRgb, options.maxMixes, options.mixPercents);
			return [...baseRgb, ...mixes.map((m) => m.rgb)];
		},
		// Flat tops/bottoms only ever show one layer, so a layer-
		// alternation mix would print as one of its components there.
		flatSurfaceColors: baseRgb.length,
		// The project_settings.config makes Snapmaker Orca open this as
		// a project, which keeps file coordinates as-is.
		bedCenter: options.bedCenter ?? U1_BED_CENTER,
		description: () => fullSpectrumDescription(base, mixes),
		extraFiles: () => ({
			'Metadata/project_settings.config': fullSpectrumProjectSettings(baseRgb, mixes),
		}),
	});
	return {
		bytes: result.bytes,
		base,
		mixes,
		triangleCount: result.triangleCount,
		repair: result.repair,
	};
}

/** Human-readable recipe, e.g. `5=Cyan 67% + Yellow 33%`. */
export function mixLabel(base: readonly PhysicalFilament[], m: MixRecipe): string {
	return `${base[m.a - 1]!.name} ${100 - m.mixB}% + ${base[m.b - 1]!.name} ${m.mixB}%`;
}

function fullSpectrumDescription(base: readonly PhysicalFilament[], mixes: readonly MixRecipe[]): string {
	return (
		'Snapmaker Orca Full Spectrum. Filaments: ' +
		base.map((f, i) => `${i + 1}=${f.name} ${rgbToHex(f.rgb)}`).join(', ') +
		mixes.map((m, i) => `, ${base.length + 1 + i}=${mixLabel(base, m)}`).join('')
	);
}
