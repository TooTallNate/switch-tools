/** Per-sample parsed metadata. Created by `parseFsb5`. */
export interface ParsedFsb5Sample {
	/** Index in the FSB5 (0-based). */
	index: number;
	/**
	 * Sample name from the name table. Empty string if the FSB5
	 * has no name table; the parser fills in `"NNNN"` (zero-padded
	 * index) in that case.
	 */
	name: string;
	/** Audio sample rate in Hz. */
	frequency: number;
	/** Channel count (1=mono, 2=stereo, …). */
	channels: number;
	/** Number of decoded PCM frames (post-decode sample count). */
	numSamples: number;
	/** Offset within the FSB5 data area (bytes from `dataAreaStart`). */
	dataOffsetInData: number;
	/** Absolute offset within the input buffer (bytes from start of FSB5). */
	dataAbsoluteOffset: number;
	/** Subarray view into the input buffer covering this sample's payload. */
	data: Uint8Array;
	/**
	 * Metadata chunks keyed by `MetadataChunkType` numeric value.
	 * Each value is the chunk's raw payload bytes. Notable chunks:
	 *   - 1 (CHANNELS) — 1-byte channel count override
	 *   - 2 (FREQUENCY) — 4-byte u32 frequency override
	 *   - 3 (LOOP) — 8 bytes (loop_start, loop_end as u32)
	 *   - 11 (VORBISDATA) — first 4 bytes are a u32 CRC32 keying
	 *     the FMOD Vorbis setup-packet lookup
	 */
	metadata: Record<number, Uint8Array>;
}
