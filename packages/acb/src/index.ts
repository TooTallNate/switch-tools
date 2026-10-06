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
	 * `null` when the cue resolves to no waveform. When a cue plays
	 * several waveforms this is the first. See {@link waveforms}.
	 */
	awbTrackId: number | null;
	/**
	 * For stream cues, the index into the ACB's `StreamAwbHash`
	 * table — i.e. which `.awb` file the track lives in when a
	 * bank has multiple streamed companions. `null` for memory cues.
	 */
	streamAwbPortNo: number | null;
	/** Every waveform the cue reaches (through synths / sequences), in order. */
	waveforms: AcbCueWaveform[];
}

/** One waveform a cue plays. */
export interface AcbCueWaveform {
	source: CueWaveformSource;
	awbTrackId: number;
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

	// Resolve each cue to the waveform(s) it plays.
	const resolver = new ReferenceResolver(root);
	const cues: AcbCue[] = [];
	if (cueTable) {
		for (let i = 0; i < cueTable.rows.length; i++) {
			const cue = cueTable.rows[i]!;
			const name = cueNameByIndex.get(i) ?? '';
			const waveforms = resolver.resolve(
				Number(cue['ReferenceType'] ?? 0),
				Number(cue['ReferenceIndex'] ?? -1),
			);
			const first = waveforms[0];
			cues.push({
				cueIndex: i,
				name,
				source: first?.source ?? CueWaveformSource.Memory,
				awbTrackId: first?.awbTrackId ?? null,
				streamAwbPortNo: first?.streamAwbPortNo ?? null,
				waveforms,
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
		for (const wf of cue.waveforms) {
			if (wf.source !== source) continue;
			if (source === CueWaveformSource.Stream && wf.streamAwbPortNo !== streamAwbPortNo) {
				continue;
			}
			if (!out.has(wf.awbTrackId)) out.set(wf.awbTrackId, cue.name);
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

/** `ReferenceType` / reference-item type codes. */
const REF_WAVEFORM = 1;
const REF_SYNTH = 2;
const REF_SEQUENCE = 3;
/** Track-event commands that start playback of a referenced item. */
const CMD_NOTE_ON = 2000;
const CMD_NOTE_ON_WITH_NO = 2003;
/** Guard against cyclic or pathologically deep reference graphs. */
const MAX_REFERENCE_DEPTH = 16;

/**
 * Follows a cue's reference to the waveform(s) it ultimately plays.
 *
 * - **Waveform** (1): a `WaveformTable` row.
 * - **Synth** (2): `SynthTable.ReferenceItems` is a list of big-endian
 *   `(u16 type, u16 index)` pairs naming waveforms, synths or sequences.
 * - **Sequence** (3): `SequenceTable.TrackIndex` is a big-endian u16
 *   list of `TrackTable` rows. Each track's `TrackEventTable[EventIndex]`
 *   `Command` blob is a run of `(u16 code, u8 size, data)` commands,
 *   where noteOn commands (2000 / 2003) carry a `(u16 type, u16 index)`
 *   reference.
 *
 * Block sequences and other reference kinds resolve to nothing.
 * Reference: vgmstream `src/meta/acb.c` (ISC).
 */
class ReferenceResolver {
	private readonly waveformTable: ParsedUtf | null;
	private readonly synthTable: ParsedUtf | null;
	private readonly sequenceTable: ParsedUtf | null;
	private readonly trackTable: ParsedUtf | null;
	private readonly trackEventTable: ParsedUtf | null;

	constructor(root: Record<string, UtfValue>) {
		this.waveformTable = subTable(root, 'WaveformTable');
		this.synthTable = subTable(root, 'SynthTable');
		this.sequenceTable = subTable(root, 'SequenceTable');
		this.trackTable = subTable(root, 'TrackTable');
		// Older ACBs name the event table `CommandTable`.
		this.trackEventTable = subTable(root, 'TrackEventTable') ?? subTable(root, 'CommandTable');
	}

	resolve(type: number, index: number, depth = 0, seen = new Set<string>()): AcbCueWaveform[] {
		if (index < 0 || depth > MAX_REFERENCE_DEPTH) return [];
		const key = `${type}:${index}`;
		if (seen.has(key)) return [];
		seen.add(key);
		switch (type) {
			case REF_WAVEFORM:
				return this.waveform(index);
			case REF_SYNTH: {
				const row = this.synthTable?.rows[index];
				const items = row ? bytesCell(row['ReferenceItems']) : null;
				if (!items) return [];
				const out: AcbCueWaveform[] = [];
				for (let o = 0; o + 4 <= items.length; o += 4) {
					const t = (items[o]! << 8) | items[o + 1]!;
					const i = (items[o + 2]! << 8) | items[o + 3]!;
					out.push(...this.resolve(t, i, depth + 1, seen));
				}
				return out;
			}
			case REF_SEQUENCE: {
				const row = this.sequenceTable?.rows[index];
				const tracks = row ? bytesCell(row['TrackIndex']) : null;
				if (!tracks) return [];
				const numTracks = Number(row!['NumTracks'] ?? tracks.length / 2);
				const out: AcbCueWaveform[] = [];
				for (let k = 0; k < numTracks && k * 2 + 2 <= tracks.length; k++) {
					const trackIndex = (tracks[k * 2]! << 8) | tracks[k * 2 + 1]!;
					out.push(...this.track(trackIndex, depth + 1, seen));
				}
				return out;
			}
			default:
				return [];
		}
	}

	private waveform(index: number): AcbCueWaveform[] {
		const wf = this.waveformTable?.rows[index];
		if (!wf) return [];
		const isMemory = Number(wf['Streaming'] ?? 0) === 0;
		const id = isMemory ? Number(wf['MemoryAwbId'] ?? -1) : Number(wf['StreamAwbId'] ?? -1);
		if (id < 0) return [];
		return [
			{
				source: isMemory ? CueWaveformSource.Memory : CueWaveformSource.Stream,
				awbTrackId: id,
				streamAwbPortNo: isMemory ? null : Number(wf['StreamAwbPortNo'] ?? 0),
			},
		];
	}

	private track(index: number, depth: number, seen: Set<string>): AcbCueWaveform[] {
		const row = this.trackTable?.rows[index];
		if (!row) return [];
		const eventIndex = Number(row['EventIndex'] ?? -1);
		const event = eventIndex >= 0 ? this.trackEventTable?.rows[eventIndex] : undefined;
		const cmd = event ? bytesCell(event['Command']) : null;
		if (!cmd) return [];
		const out: AcbCueWaveform[] = [];
		for (let o = 0; o + 3 <= cmd.length; ) {
			const code = (cmd[o]! << 8) | cmd[o + 1]!;
			const size = cmd[o + 2]!;
			const data = o + 3;
			if (code === 0 && size === 0) break;
			if ((code === CMD_NOTE_ON || code === CMD_NOTE_ON_WITH_NO) && size >= 4 && data + 4 <= cmd.length) {
				const t = (cmd[data]! << 8) | cmd[data + 1]!;
				const i = (cmd[data + 2]! << 8) | cmd[data + 3]!;
				out.push(...this.resolve(t, i, depth + 1, seen));
			}
			o = data + size;
		}
		return out;
	}
}

function bytesCell(v: UtfValue | undefined): Uint8Array | null {
	return v instanceof Uint8Array ? v : null;
}
