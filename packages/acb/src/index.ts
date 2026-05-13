/**
 * @tootallnate/acb — CRI Audio Cue Bank parser.
 *
 * The ACB is a single `@UTF` table that describes the contents of
 * a companion AWB (Audio Wave Bank). Each row in the top-level
 * table is the bank itself; the cells of that row contain nested
 * `@UTF` sub-tables for cues / sequences / synths / waveforms /
 * cue-names / etc.
 *
 * For our use case — putting cue names on AWB-track tree children —
 * the two sub-tables we care about are:
 *
 *   - **`CueNameTable`**: a `{ CueIndex, CueName }` map giving the
 *     human-readable name for each cue.
 *   - **`CueTable`** (with `ReferenceType` + `ReferenceIndex`) plus
 *     **`WaveformTable`** (with `MemoryAwbId` / `StreamAwbId`):
 *     resolves a cue to the AWB track id its audio lives at.
 *
 * Together: walk each cue, follow it to a waveform, look up the AWB
 * id, attach the cue name to that AWB track.
 *
 * Real ACBs have many more tables — `BlockTable`, `EventTable`,
 * `BeatSyncInfoTable`, etc. — but they're orthogonal to the tree
 * naming use case. We surface the raw rows on {@link ParsedAcb}
 * for callers that want them.
 */

import {
	isUtfMagic,
	parseUtf,
	type ParsedUtf,
	type UtfValue,
} from './utf.js';

export {
	isUtfMagic,
	parseUtf,
	UtfParseError,
	UtfStorage,
	UtfType,
	UTF_MAGIC,
	type ParsedUtf,
	type UtfColumn,
	type UtfValue,
} from './utf.js';

/** Sniff `@UTF` magic at the start of the bytes. Convenience re-export. */
export function isAcbMagic(bytes: Uint8Array): boolean {
	return isUtfMagic(bytes);
}

export class AcbParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AcbParseError';
	}
}

/** Source of a cue's audio. */
export enum CueWaveformSource {
	/**
	 * The waveform's bytes are embedded in the ACB's own `AwbFile`
	 * blob (a small AFS2 bank used for sound effects that load
	 * fully into memory).
	 */
	Memory = 'memory',
	/**
	 * The waveform's bytes live in an external `.awb` companion
	 * file referenced by the ACB's `StreamAwbHash` table.
	 */
	Stream = 'stream',
}

/** Resolved cue → audio mapping. */
export interface AcbCue {
	/** Cue index in the original `CueTable`. */
	cueIndex: number;
	/** Human-readable cue name from `CueNameTable`. */
	name: string;
	/** Which AWB (embedded vs streamed) holds the waveform. */
	source: CueWaveformSource;
	/**
	 * Track id inside the source AWB. For memory cues this is
	 * `MemoryAwbId`; for stream cues this is `StreamAwbId`.
	 * `null` when the cue's reference type isn't a direct waveform
	 * (e.g. sequence or block) — we don't decode those.
	 */
	awbTrackId: number | null;
	/**
	 * For stream cues, the index into the ACB's `StreamAwbHash`
	 * table — i.e. which `.awb` file the track lives in when a
	 * bank has multiple streamed companions. `null` for memory cues.
	 */
	streamAwbPortNo: number | null;
}

/** Parsed ACB contents. */
export interface ParsedAcb {
	/** The bank's user-visible name (top-level `Name` cell). */
	name: string;
	/** The raw top-level row, in case the caller wants to inspect more fields. */
	root: Record<string, UtfValue>;
	/** Resolved cues with their AWB-track mappings. */
	cues: AcbCue[];
	/**
	 * The bank's embedded AWB (memory tracks), if any. Pass to
	 * `parseAwb` if you want to extract memory cues directly.
	 */
	embeddedAwb: Uint8Array | null;
	/**
	 * External stream-AWB references, in port order. Each entry's
	 * `name` is the basename (no extension) of the companion `.awb`
	 * file the caller should locate on disk.
	 */
	streamAwbs: Array<{ name: string; hash: Uint8Array | null }>;
}

/**
 * Parse an ACB byte buffer. The result includes pre-resolved cue
 * info; callers wanting the full UTF tree can re-parse via
 * {@link parseUtf} or read fields off `root` directly.
 */
export function parseAcb(bytes: Uint8Array): ParsedAcb {
	const utf = parseUtf(bytes);
	if (utf.rows.length === 0) {
		throw new AcbParseError('ACB UTF table has no rows.');
	}
	const root = utf.rows[0]!;
	const bankName = String(root['Name'] ?? '');

	// Sub-tables we need are themselves @UTF blobs. The parser
	// already decoded nested @UTF on read, so they show up as
	// ParsedUtf values — but defensive callers may have stomped
	// them or passed in a partial buffer; bail-soft when missing.
	const cueNameTable = subTable(root, 'CueNameTable');
	const cueTable = subTable(root, 'CueTable');
	const waveformTable = subTable(root, 'WaveformTable');
	const streamAwbHash = subTable(root, 'StreamAwbHash');

	// Build cueIndex → name map first.
	const cueNameByIndex = new Map<number, string>();
	if (cueNameTable) {
		for (const row of cueNameTable.rows) {
			const idx = Number(row['CueIndex'] ?? -1);
			const name = String(row['CueName'] ?? '');
			if (idx >= 0 && name) cueNameByIndex.set(idx, name);
		}
	}

	// Resolve each cue to its waveform (when direct).
	const cues: AcbCue[] = [];
	if (cueTable && waveformTable) {
		for (let i = 0; i < cueTable.rows.length; i++) {
			const cue = cueTable.rows[i]!;
			const referenceType = Number(cue['ReferenceType'] ?? 0);
			const referenceIndex = Number(cue['ReferenceIndex'] ?? -1);
			const name = cueNameByIndex.get(i) ?? '';
			// ReferenceType 1 = direct Waveform; other types (2 = Synth,
			// 3 = Sequence, …) need additional resolution we don't do here.
			if (referenceType !== 1 || referenceIndex < 0) {
				cues.push({
					cueIndex: i,
					name,
					source: CueWaveformSource.Memory,
					awbTrackId: null,
					streamAwbPortNo: null,
				});
				continue;
			}
			const wf = waveformTable.rows[referenceIndex];
			if (!wf) {
				cues.push({
					cueIndex: i,
					name,
					source: CueWaveformSource.Memory,
					awbTrackId: null,
					streamAwbPortNo: null,
				});
				continue;
			}
			const streaming = Number(wf['Streaming'] ?? 0);
			const isMemory = streaming === 0;
			const awbTrackId = isMemory
				? Number(wf['MemoryAwbId'] ?? -1)
				: Number(wf['StreamAwbId'] ?? -1);
			const streamAwbPortNo = isMemory
				? null
				: Number(wf['StreamAwbPortNo'] ?? 0);
			cues.push({
				cueIndex: i,
				name,
				source: isMemory
					? CueWaveformSource.Memory
					: CueWaveformSource.Stream,
				awbTrackId: awbTrackId >= 0 ? awbTrackId : null,
				streamAwbPortNo,
			});
		}
	}

	// Surface the embedded AWB and the list of stream-AWB names.
	const embeddedAwb =
		root['AwbFile'] instanceof Uint8Array
			? (root['AwbFile'] as Uint8Array)
			: null;
	const streamAwbs: ParsedAcb['streamAwbs'] = [];
	if (streamAwbHash) {
		for (const row of streamAwbHash.rows) {
			streamAwbs.push({
				name: String(row['Name'] ?? ''),
				hash: row['Hash'] instanceof Uint8Array ? (row['Hash'] as Uint8Array) : null,
			});
		}
	}

	return {
		name: bankName,
		root,
		cues,
		embeddedAwb,
		streamAwbs,
	};
}

/**
 * Build a lookup map from AWB track id → cue name for one of the
 * source AWBs (memory or a specific stream port). Returns an empty
 * Map when no cue in the ACB references the given source — that's
 * the natural state for a stream-only ACB when you ask for memory
 * names, and vice versa.
 *
 * When more than one cue maps to the same track id (rare but
 * legal — same waveform reused across multiple cues), the first
 * cue's name wins. The caller can walk `acb.cues` directly if it
 * needs the full mapping.
 */
export function cueNamesForAwb(
	acb: ParsedAcb,
	source: CueWaveformSource,
	streamAwbPortNo: number = 0,
): Map<number, string> {
	const out = new Map<number, string>();
	for (const cue of acb.cues) {
		if (cue.awbTrackId === null) continue;
		if (cue.source !== source) continue;
		if (source === CueWaveformSource.Stream && cue.streamAwbPortNo !== streamAwbPortNo) {
			continue;
		}
		if (!out.has(cue.awbTrackId)) {
			out.set(cue.awbTrackId, cue.name);
		}
	}
	return out;
}

function subTable(
	row: Record<string, UtfValue>,
	key: string,
): ParsedUtf | null {
	const v = row[key];
	if (!v || typeof v !== 'object') return null;
	// ParsedUtf has rows + columns + name; Uint8Array has byteLength
	// without rows. Defensive duck-type.
	if ('rows' in v && 'columns' in v) return v as ParsedUtf;
	return null;
}
