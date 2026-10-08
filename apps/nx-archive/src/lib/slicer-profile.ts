/**
 * Slicer profiles a 3MF export can target, so the file carries its
 * filament colours (and printer setup) instead of the user re-entering
 * them by hand.
 *
 * Filament colours can only be conveyed through
 * `Metadata/project_settings.config` (`filament_colour`): OrcaSlicer's
 * Materials-extension support (`m:colorgroup`) just assigns an object
 * to an extruder. But that file is a *project* config — opening the 3MF
 * as a project (OrcaSlicer's default on an empty plate) layers it over
 * factory defaults (`config.apply(FullPrintConfig::defaults())`), so a
 * config holding only our keys would wipe the printer profile (layer
 * G-code, retraction, …). Bambu-style project configs avoid that by
 * naming system presets and listing per-preset
 * `different_settings_to_system`: for every key *not* listed,
 * `PresetCollection::load_external_preset` takes the named system
 * preset's value, and the preset is then simply selected. So embedding
 * colours is only safe when we know real preset names for the printer —
 * hence explicit profiles rather than a generic "colours only" option.
 */

import { rgbToHex, type Rgb } from './mesh-export-3mf';

export interface SlicerProfile {
	id: string;
	label: string;
	/** Printer system preset (`printer_settings_id`). */
	printer: string;
	/** Default process system preset (`print_settings_id`). */
	process: string;
	/** Default filament system preset (`filament_settings_id`). */
	filament: string;
	/** `curr_bed_type`; filament bed temperatures depend on it. */
	bedType: string;
	/** Plate centre the model is placed at (mm). */
	bedCenter: readonly [number, number];
	/** Largest printable dimension (mm), for size warnings. */
	buildVolumeMm: number;
}

/**
 * Snapmaker U1 with the 0.4 mm nozzle (preset names from Snapmaker
 * Orca's `resources/profiles/Snapmaker/{machine,process,filament}`).
 * Printable area X 0.5–270.5, Y 1–271, height 270.
 */
export const SNAPMAKER_U1: SlicerProfile = {
	id: 'snapmaker-u1',
	label: 'Snapmaker U1 (0.4 nozzle)',
	printer: 'Snapmaker U1 (0.4 nozzle)',
	process: '0.20mm Standard @Snapmaker U1 (0.4 nozzle)',
	filament: 'Snapmaker PLA Basic @U1',
	bedType: 'Textured PEI Plate',
	bedCenter: [135.5, 136],
	buildVolumeMm: 270,
};

export const SLICER_PROFILES: readonly SlicerProfile[] = [SNAPMAKER_U1];

export function slicerProfile(id: string | null | undefined): SlicerProfile | null {
	return SLICER_PROFILES.find((p) => p.id === id) ?? null;
}

/**
 * `Metadata/project_settings.config` selecting the profile's stock
 * presets (nothing marked as differing) with the given filament colours.
 * `extra` adds further *project* options (e.g. mixed filaments).
 */
export function projectSettingsConfig(
	profile: SlicerProfile,
	filamentColors: readonly Rgb[],
	overrides: { process?: string; filament?: string; extra?: Record<string, unknown> } = {},
): string {
	const filament = overrides.filament ?? profile.filament;
	return JSON.stringify(
		{
			printer_settings_id: profile.printer,
			print_settings_id: overrides.process ?? profile.process,
			filament_settings_id: filamentColors.map(() => filament),
			// [process, filament 1..N, printer]
			different_settings_to_system: Array.from({ length: filamentColors.length + 2 }, () => ''),
			// Project options:
			filament_colour: filamentColors.map(rgbToHex),
			curr_bed_type: profile.bedType,
			...overrides.extra,
		},
		null,
		4,
	);
}
