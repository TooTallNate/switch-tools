/**
 * Print scale shared by every model exported from one opened file.
 *
 * Game models use arbitrary units, so each export needs a units → mm
 * scale. Storing one scale per *base file* (the NSP / XCI / ROM /
 * directory the user opened) — rather than per model — keeps exports
 * from the same game proportional to each other: export Mario and
 * Bowser from the same file and Bowser prints bigger, as in the game.
 *
 * Persisted in localStorage as `{ [scopeKey]: mmPerUnit }`.
 */

const STORAGE_KEY = 'nx-archive:print-scale';

/** Largest dimension a model gets when its file has no scale yet. */
export const DEFAULT_TARGET_MM = 100;

function readAll(): Record<string, number> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : null;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
	} catch {
		return {};
	}
}

/** Saved mm-per-unit scale for a base file, or null if none yet. */
export function loadPrintScale(scopeKey: string): number | null {
	const v = readAll()[scopeKey];
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function savePrintScale(scopeKey: string, mmPerUnit: number): void {
	if (!(Number.isFinite(mmPerUnit) && mmPerUnit > 0)) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [scopeKey]: mmPerUnit }));
	} catch {
		// Private mode / quota: the scale just won't persist.
	}
}

/** Scale that makes a model `targetMm` along its largest dimension. */
export function defaultPrintScale(sizeUnits: readonly number[], targetMm = DEFAULT_TARGET_MM): number {
	const max = Math.max(...sizeUnits);
	return Number.isFinite(max) && max > 0 ? targetMm / max : 1;
}
