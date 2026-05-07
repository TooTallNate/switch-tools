/**
 * FMOD Vorbis setup-packet lookup table loader.
 *
 * The shipped binary (`assets/fmod_vorbis_setup_packets.bin`)
 * contains 161 pre-built Vorbis setup packets keyed by CRC32 hash.
 * Each FSB5 sample's `VORBISDATA` metadata chunk's first u32 is
 * the CRC32 to look up.
 *
 * Format of the bin file (little-endian):
 *
 *   u32 count
 *   for each entry (sorted by CRC32 ascending):
 *     u32 crc32
 *     u32 setup_length
 *     u8  mode_count        (1 or 2; tells the audio rebuild how
 *                            many bits encode the mode index per
 *                            audio packet)
 *     bytes[setup_length] setup_packet  (already including the
 *       Vorbis "5"-type header byte + "vorbis" prefix; ready to
 *       be wrapped in an Ogg page)
 *
 * Total ~620 KB.
 */

export interface FmodVorbisSetup {
	/** CRC32 from the FSB5 sample's VORBISDATA chunk. */
	crc32: number;
	/** Number of Vorbis modes in this setup (always 1 or 2 in practice). */
	modeCount: number;
	/** The setup packet bytes (Vorbis packet type 5, ready for Ogg wrapping). */
	setup: Uint8Array;
}

export class FmodVorbisSetupPackets {
	private entries: FmodVorbisSetup[];

	constructor(bytes: Uint8Array) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const count = dv.getUint32(0, true);
		const entries: FmodVorbisSetup[] = [];
		let off = 4;
		for (let i = 0; i < count; i++) {
			if (off + 9 > bytes.length) throw new Error('setup-packets: truncated');
			const crc = dv.getUint32(off, true);
			const len = dv.getUint32(off + 4, true);
			const modeCount = bytes[off + 8];
			off += 9;
			if (off + len > bytes.length) throw new Error('setup-packets: payload truncated');
			entries.push({ crc32: crc, modeCount, setup: bytes.subarray(off, off + len) });
			off += len;
		}
		// Verify sorted (binary search relies on this).
		for (let i = 1; i < entries.length; i++) {
			if (entries[i].crc32 <= entries[i - 1].crc32) {
				throw new Error('setup-packets: entries not sorted by CRC32');
			}
		}
		this.entries = entries;
	}

	/** Number of available setup packets. */
	get count(): number {
		return this.entries.length;
	}

	/** Look up the setup record for a given CRC32, or null if unknown. */
	lookup(crc32: number): FmodVorbisSetup | null {
		// Binary search on sorted entries.
		let lo = 0;
		let hi = this.entries.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const e = this.entries[mid];
			if (e.crc32 === crc32) return e;
			if (e.crc32 < crc32) lo = mid + 1;
			else hi = mid - 1;
		}
		return null;
	}
}

/** Load the bundled setup-packet table from raw bytes. */
export function loadFmodVorbisSetupPackets(bytes: Uint8Array): FmodVorbisSetupPackets {
	return new FmodVorbisSetupPackets(bytes);
}
