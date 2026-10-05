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
	type Rgb,
} from './mesh-export-3mf';

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

/** `Metadata/project_settings.config` carrying filaments + mixes. */
export function fullSpectrumProjectSettings(base: readonly Rgb[], mixes: readonly MixRecipe[]): string {
	return JSON.stringify(
		{
			filament_colour: base.map(rgbToHex),
			mixed_filament_definitions: mixedFilamentDefinitions(mixes, base.length),
		},
		null,
		4,
	);
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
}

export interface FullSpectrumResult {
	bytes: Uint8Array;
	base: readonly PhysicalFilament[];
	/** Chosen mixes; mix i is painted as filament `base.length + 1 + i`. */
	mixes: MixRecipe[];
	triangleCount: number;
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
		choosePalette: (bins) => {
			mixes = chooseMixes(bins, baseRgb, options.maxMixes, options.mixPercents);
			return [...baseRgb, ...mixes.map((m) => m.rgb)];
		},
		// Flat tops/bottoms only ever show one layer, so a layer-
		// alternation mix would print as one of its components there.
		flatSurfaceColors: baseRgb.length,
		description: () => fullSpectrumDescription(base, mixes),
		extraFiles: () => ({
			'Metadata/project_settings.config': fullSpectrumProjectSettings(baseRgb, mixes),
		}),
	});
	return { bytes: result.bytes, base, mixes, triangleCount: result.triangleCount };
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
