/**
 * AFS2 / AWB audio wave bank parser.
 *
 * CRI Middleware's AWB ("Audio Wave Bank") is the binary half of
 * their ACB/AWB sound-data pair: an indexed container that packs
 * many encoded audio tracks into a single file, sample-id keyed.
 * The companion ACB ships a UTF table that maps human-readable
 * cue names to AWB sample ids, but for a playable preview the AWB
 * alone is enough — every track stands on its own.
 *
 * Wire format (little-endian, magic = `AFS2`):
 *
 *   0x00  u8[4]   magic            "AFS2"
 *   0x04  u8      type             always 0x01 / 0x02 (subtype)
 *   0x05  u8      offsetSize       4 or 2 — width of each track offset
 *   0x06  u8      idSize           2 (only width seen in the wild)
 *   0x07  u8      reserved
 *   0x08  u32     trackCount
 *   0x0C  u16     alignment        usually 32; each track aligned up to this
 *   0x0E  u16     subkey           per-bank HCA subkey (0 when unencrypted)
 *   0x10  u16[]   trackIds         `trackCount` × u16
 *         u32[]   trackOffsets     `trackCount + 1` × u32 (LE):
 *                                  offsets[i] = start of track i,
 *                                  offsets[trackCount] = first byte
 *                                  past the last track.
 *                                  Each start is then padded UP to
 *                                  `alignment` before the track data
 *                                  begins.
 *
 * The size table is `trackCount + 1` entries: track `i` spans
 * `[align(offsets[i]), offsets[i+1])`. The last entry is purely
 * an end-of-data marker.
 *
 * Most AWBs we've seen embed HCA (CRI's compressed audio) but the
 * format itself is codec-agnostic — the per-track bytes could be
 * anything. Consumers should sniff the first 4 bytes of each
 * track to identify the inner codec.
 *
 * Refs:
 *   - vgmstream (ISC) `src/meta/awb.c`
 *   - kohos/CriTools (MIT) `src/afs2.js`
 *   - https://wiki.vg-resource.com/AFS2
 */

export const AWB_MAGIC = 0x32534641; // "AFS2" in little-endian u32

/** Parsed AFS2 / AWB container. */
export interface ParsedAwb {
	/**
	 * Header subtype (offset 0x04). `0x01` / `0x02` in the wild; mostly
	 * informational — doesn't affect parsing.
	 */
	subtype: number;
	/** Track-offset width: 2 or 4 bytes. */
	offsetSize: 2 | 4;
	/** Track-id width: 2 bytes (only value seen so far). */
	idSize: 2;
	/** Total number of tracks in the bank. */
	trackCount: number;
	/** Alignment applied to each track's start offset. Usually 32. */
	alignment: number;
	/**
	 * Per-bank HCA subkey. Combined with the per-file HCA key to
	 * derive the cipher state. 0 when the bank is unencrypted.
	 */
	subkey: number;
	/** Per-track records, in serialized order. */
	tracks: AwbTrack[];
}

/** One track inside an AWB. */
export interface AwbTrack {
	/** Track id from the AWB's id table. ACB references this. */
	id: number;
	/** Absolute byte offset of the first track byte. */
	offset: number;
	/** Track length in bytes. */
	size: number;
}

export class AwbParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AwbParseError';
	}
}

/** Sniff the AFS2 magic without parsing the rest. */
export function isAwbMagic(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	return (
		bytes[0] === 0x41 &&
		bytes[1] === 0x46 &&
		bytes[2] === 0x53 &&
		bytes[3] === 0x32
	);
}

/**
 * Parse the AFS2 header out of `bytes`. Only the first
 * `0x10 + trackCount * idSize + (trackCount + 1) * offsetSize`
 * bytes are touched — pass a small head slice when reading a
 * large file lazily.
 */
export function parseAwb(bytes: Uint8Array): ParsedAwb {
	if (!isAwbMagic(bytes)) {
		throw new AwbParseError(
			`Bad AFS2 magic: expected "AFS2", got 0x${Array.from(
				bytes.subarray(0, Math.min(4, bytes.length)),
			)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')}`,
		);
	}
	if (bytes.length < 0x10) {
		throw new AwbParseError(
			`AFS2 header truncated: need at least 16 bytes, got ${bytes.length}`,
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const subtype = dv.getUint8(0x04);
	const offsetSize = dv.getUint8(0x05);
	const idSize = dv.getUint8(0x06);
	if (offsetSize !== 2 && offsetSize !== 4) {
		throw new AwbParseError(
			`Unsupported AFS2 offset width: ${offsetSize} (expected 2 or 4)`,
		);
	}
	if (idSize !== 2) {
		throw new AwbParseError(
			`Unsupported AFS2 id width: ${idSize} (only 2 is implemented)`,
		);
	}
	const trackCount = dv.getUint32(0x08, true);
	const alignment = dv.getUint16(0x0c, true);
	const subkey = dv.getUint16(0x0e, true);
	if (trackCount > 1_000_000) {
		throw new AwbParseError(
			`Implausible track count: ${trackCount}; refusing to allocate.`,
		);
	}
	if (alignment === 0) {
		throw new AwbParseError('AFS2 alignment cannot be zero.');
	}

	// Required tail size: ids + (n+1) offsets.
	const tableBytes = trackCount * idSize + (trackCount + 1) * offsetSize;
	if (0x10 + tableBytes > bytes.length) {
		throw new AwbParseError(
			`AFS2 header table truncated: need 0x${(0x10 + tableBytes).toString(16)} bytes, have 0x${bytes.length.toString(16)}`,
		);
	}

	const ids = new Array<number>(trackCount);
	for (let i = 0; i < trackCount; i++) {
		ids[i] = dv.getUint16(0x10 + i * 2, true);
	}

	const offsets = new Array<number>(trackCount + 1);
	const offsetTableStart = 0x10 + trackCount * 2;
	for (let i = 0; i <= trackCount; i++) {
		const o = offsetTableStart + i * offsetSize;
		offsets[i] =
			offsetSize === 2
				? dv.getUint16(o, true)
				: dv.getUint32(o, true);
	}

	// Round each track start up to alignment, then size = next - aligned_start.
	const tracks: AwbTrack[] = new Array(trackCount);
	for (let i = 0; i < trackCount; i++) {
		let start = offsets[i]!;
		const mod = start % alignment;
		if (mod !== 0) start += alignment - mod;
		const end = offsets[i + 1]!;
		tracks[i] = { id: ids[i]!, offset: start, size: Math.max(0, end - start) };
	}

	return { subtype, offsetSize, idSize: 2, trackCount, alignment, subkey, tracks };
}

/**
 * Convenience for the common case: read just the header bytes
 * (offset 0, length `headBytes`) from a `Blob`, parse them, and
 * return the parsed AWB plus per-track `Blob.slice(...)` references
 * for lazy track extraction.
 *
 * The default `headBytes` (64 KiB) is enough for any AWB seen in
 * the wild — even with a million tracks the table only reaches
 * 0x10 + 1M × (2 + 4) ≈ 6 MiB; trim the default when reading
 * known-small banks for a tighter network read.
 */
export async function parseAwbBlob(
	blob: Blob,
	headBytes = 0x10000,
): Promise<{
	parsed: ParsedAwb;
	tracks: Array<{ id: number; offset: number; size: number; blob: Blob }>;
}> {
	const head = await blob.slice(0, Math.min(headBytes, blob.size)).arrayBuffer();
	const parsed = parseAwb(new Uint8Array(head));
	const tracks = parsed.tracks.map((t) => ({
		id: t.id,
		offset: t.offset,
		size: t.size,
		blob: blob.slice(t.offset, t.offset + t.size),
	}));
	return { parsed, tracks };
}
