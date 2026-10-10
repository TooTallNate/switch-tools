/**
 * Viewer-agnostic 3D-print export pipeline: baked {@link ExportMesh}es
 * → scale to millimetres → (repair) → (smooth) → STL or painted 3MF.
 *
 * Geometry is converted to real millimetres *before* anything else, so
 * size-dependent settings (wall thickness for thickened sheets, plate
 * placement) are in the units the user prints in, and the output needs
 * no scaling (or unit conversion prompts) in the slicer.
 */

import {
	FULL_SPECTRUM_BUNDLE,
	buildFullSpectrum3MF,
	type MixRecipe,
	type PhysicalFilament,
} from './full-spectrum';
import {
	emitBinarySTL,
	loopSubdivide,
	weldByPosition,
	type ExportMesh,
} from './mesh-export';
import { buildPainted3MF, rgbToHex, splitDecals, type Rgb } from './mesh-export-3mf';
import { repairForPrinting, summarizeRepairs, type RepairReport, type RepairSummary } from './mesh-repair';
import { SNAPMAKER_U1, projectSettingsConfig, slicerProfile, type SlicerProfile } from './slicer-profile';
import { addStructuralSupports, type SupportReport } from './mesh-supports';

export type ExportFormat = 'stl' | '3mf' | '3mf-full-spectrum';

export interface ModelExportSettings {
	format: ExportFormat;
	/** Loop-subdivision passes. */
	subdivision: number;
	/** Make every part a closed solid (see `mesh-repair.ts`). */
	repair: boolean;
	/** Wall thickness for thickened open surfaces, in mm. */
	wallMm: number;
	/** Strut floating / barely attached parts to the rest (see `mesh-supports.ts`). */
	supports: boolean;
	/** Strut radius, in mm. */
	supportMm: number;
	/** Standard 3MF: filament count. */
	colors: number;
	/** Full Spectrum: maximum mixed filaments. */
	mixes: number;
	/** Full Spectrum: physical filament colours (hex), toolhead order. */
	base: string[];
	/**
	 * Standard 3MF: slicer profile to embed filament colours + stock
	 * presets for (`slicer-profile.ts`), or `'none'` for a plain 3MF.
	 * Full Spectrum always targets the Snapmaker U1.
	 */
	profile: string;
}

export const DEFAULT_EXPORT_SETTINGS: ModelExportSettings = {
	format: '3mf',
	subdivision: 0,
	repair: true,
	wallMm: 1.2,
	supports: true,
	supportMm: 1.2,
	colors: 4,
	mixes: 12,
	base: FULL_SPECTRUM_BUNDLE.map((f) => rgbToHex(f.rgb)),
	profile: SNAPMAKER_U1.id,
};

/** Printer the export is laid out for: always the U1 for Full Spectrum. */
export function targetProfile(s: Pick<ModelExportSettings, 'format' | 'profile'>): SlicerProfile | null {
	if (s.format === '3mf-full-spectrum') return SNAPMAKER_U1;
	if (s.format === 'stl') return null;
	return slicerProfile(s.profile);
}

/**
 * Model size in *print* axes (X width, Y depth, Z height), in the
 * baked meshes' units. Y-up sources are rotated to Z-up on export.
 */
export function printSize(meshes: readonly ExportMesh[], sourceAxis: 'y-up' | 'z-up'): [number, number, number] {
	const mn = [Infinity, Infinity, Infinity];
	const mx = [-Infinity, -Infinity, -Infinity];
	for (const m of meshes) {
		const p = m.positions;
		for (let i = 0; i < m.indices.length; i++) {
			const o = m.indices[i]! * 3;
			for (let k = 0; k < 3; k++) {
				const v = p[o + k]!;
				if (!Number.isFinite(v)) continue;
				if (v < mn[k]!) mn[k] = v;
				if (v > mx[k]!) mx[k] = v;
			}
		}
	}
	const d = mx.map((v, k) => (Number.isFinite(v - mn[k]!) ? v - mn[k]! : 0));
	// y-up: print Z = source Y, print Y = source Z.
	return sourceAxis === 'y-up' ? [d[0]!, d[2]!, d[1]!] : [d[0]!, d[1]!, d[2]!];
}

/** Copies of the meshes with positions multiplied by `scale`. */
export function scaleMeshes(meshes: readonly ExportMesh[], scale: number): ExportMesh[] {
	return meshes.map((m) => {
		const positions = new Float32Array(m.positions.length);
		for (let i = 0; i < positions.length; i++) positions[i] = m.positions[i]! * scale;
		return { ...m, positions };
	});
}

export function hexToRgb(hex: string): Rgb {
	const n = parseInt(hex.replace('#', ''), 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Full Spectrum base filaments; keep bundle names for unchanged colours. */
export function baseFilaments(hexes: readonly string[]): PhysicalFilament[] {
	return hexes.map((hex, i) => {
		const bundle = FULL_SPECTRUM_BUNDLE[i];
		const same = bundle && rgbToHex(bundle.rgb) === hex.toUpperCase();
		return { name: same ? bundle.name : `F${i + 1}`, rgb: hexToRgb(hex) };
	});
}

export interface ModelExportJob {
	meshes: readonly ExportMesh[];
	settings: ModelExportSettings;
	/** Millimetres per model unit. */
	mmPerUnit: number;
	sourceAxis: 'y-up' | 'z-up';
	/** File-name stem and pose suffix (e.g. `_Walk_f0012`). */
	stem: string;
	pose: string;
	/** Opened file the model came from (embedded in 3MF metadata). */
	source?: string;
	/** Human-readable model + pose, e.g. `CLOUD · Walk, frame 12`. */
	subject?: string;
}

export interface ModelExportResult {
	bytes: Uint8Array;
	fileName: string;
	mimeType: string;
	repair: RepairSummary | null;
	/** Struts added for floating / weakly attached parts. */
	supports: SupportReport | null;
	/** Standard 3MF palette (filament i + 1). */
	palette?: Rgb[];
	/** Profile whose presets + filament colours were embedded, if any. */
	profile?: SlicerProfile;
	/** Full Spectrum filaments + mixes. */
	fullSpectrum?: { base: readonly PhysicalFilament[]; mixes: MixRecipe[] };
}

/** What a 3MF records about its own export: source, pose, settings, supports. */
function exportMetadata(job: ModelExportJob, supports: SupportReport | null): Record<string, string> {
	const s = job.settings;
	const meta: Record<string, string> = {
		Application: 'nx-archive',
		CreationDate: new Date().toISOString().slice(0, 10),
		Model: job.stem,
	};
	if (job.source) meta.SourceFile = job.source;
	if (job.subject) meta.Pose = job.subject;
	meta.Scale = `${job.mmPerUnit} mm per model unit`;
	meta.ExportSettings = JSON.stringify({
		format: s.format,
		subdivision: s.subdivision,
		repair: s.repair,
		wallMm: s.wallMm,
		supports: s.supports,
		supportMm: s.supportMm,
		...(s.format === '3mf' && { colors: s.colors, profile: s.profile }),
		...(s.format === '3mf-full-spectrum' && { mixes: s.mixes, base: s.base }),
	});
	if (supports) meta.Supports = JSON.stringify(supports);
	return meta;
}

export function runModelExport(job: ModelExportJob): ModelExportResult {
	const { settings: s, stem, pose } = job;
	// Decals (painted-on eyes, …) aren't printed: paint them onto the
	// surface beneath instead, and keep them out of supports / repair.
	const split = splitDecals(scaleMeshes(job.meshes, job.mmPerUnit));
	let meshes = split.meshes;
	const decals = split.decals;
	let supports: SupportReport | null = null;
	if (s.supports) {
		const r = addStructuralSupports(meshes, { radiusMm: s.supportMm });
		meshes = r.meshes;
		supports = r.report;
	}
	const objectName = `${stem}${pose}${s.subdivision > 0 ? `_sub${s.subdivision}` : ''}`;
	const metadata = exportMetadata(job, supports);
	const sub = s.subdivision > 0 ? `_sub${s.subdivision}` : '';
	const repair = s.repair ? { minThickness: s.wallMm } : false;

	if (s.format === 'stl') {
		const reports: RepairReport[] = [];
		const cooked = meshes.map((m) => {
			let c = weldByPosition(m);
			if (repair) {
				const r = repairForPrinting(c, repair);
				reports.push(r.report);
				c = r;
			}
			for (let p = 0; p < s.subdivision; p++) c = loopSubdivide(c);
			return c;
		});
		return {
			bytes: emitBinarySTL(cooked, { header: `nx-archive ${stem}${pose}${sub}`, sourceAxis: job.sourceAxis }),
			fileName: `${stem}${pose}${sub}.stl`,
			mimeType: 'model/stl',
			repair: repair ? summarizeRepairs(reports) : null,
			supports,
		};
	}

	if (s.format === '3mf-full-spectrum') {
		const r = buildFullSpectrum3MF([...meshes], {
			base: baseFilaments(s.base),
			maxMixes: s.mixes,
			subdivisionPasses: s.subdivision,
			sourceAxis: job.sourceAxis,
			title: objectName,
			objectName,
			metadata,
			decals,
			repair,
		});
		const n = r.base.length + r.mixes.length;
		return {
			bytes: r.bytes,
			fileName: `${stem}${pose}${sub}_fs${n}.3mf`,
			mimeType: 'model/3mf',
			repair: r.repair,
			supports,
			fullSpectrum: { base: r.base, mixes: r.mixes },
		};
	}

	const profile = targetProfile(s);
	const r = buildPainted3MF([...meshes], {
		colorCount: s.colors,
		subdivisionPasses: s.subdivision,
		sourceAxis: job.sourceAxis,
		title: objectName,
		objectName,
		metadata,
		decals,
		repair,
		...(profile && {
			bedCenter: profile.bedCenter,
			// Filament colours ride along in the project settings.
			extraFiles: (palette: Rgb[]) => ({
				'Metadata/project_settings.config': projectSettingsConfig(profile, palette),
			}),
		}),
	});
	return {
		bytes: r.bytes,
		fileName: `${stem}${pose}${sub}_${r.palette.length}c.3mf`,
		mimeType: 'model/3mf',
		repair: r.repair,
		supports,
		palette: r.palette,
		profile: profile ?? undefined,
	};
}
