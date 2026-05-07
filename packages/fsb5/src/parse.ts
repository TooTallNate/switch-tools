/**
 * FSB5 (FMOD Sample Bank, version 5) parser.
 *
 * # File layout
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ FSB5Header (60 bytes for version=1, 64 for version=0)    │
 *   │   "FSB5"                              4                  │
 *   │   version u32                         4                  │
 *   │   numSamples u32                      4                  │
 *   │   sampleHeadersSize u32               4                  │
 *   │   nameTableSize u32                   4                  │
 *   │   dataSize u32                        4                  │
 *   │   mode u32 (SoundFormat enum)         4                  │
 *   │   "zero" (8 bytes — flags or padding) 8                  │
 *   │   "hash" (16 bytes)                   16                 │
 *   │   "dummy" (8 bytes)                   8                  │
 *   │   [version=0 only] unknown u32        4                  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Sample headers (sampleHeadersSize bytes)                 │
 *   │   each sample: 8-byte packed header                      │
 *   │     bit  0    : has_more_chunks (1) / no chunks (0)      │
 *   │     bits 1-4  : frequency code (1=8000, 2=11000, 3=11025,│
 *   │                                 4=16000, 5=22050,        │
 *   │                                 6=24000, 7=32000,        │
 *   │                                 8=44100, 9=48000)        │
 *   │     bit  5    : channels (0=1, 1=2)                      │
 *   │     bits 6-33 : dataOffset / 16  (u28 → byte offset *16) │
 *   │     bits 34-63: numSamples (u30, decoded PCM frames)     │
 *   │   followed by zero or more 4-byte metadata chunks if     │
 *   │   has_more_chunks was set:                               │
 *   │     bit  0    : has_next                                 │
 *   │     bits 1-24 : chunk_size (24 bits)                     │
 *   │     bits 25-31: chunk_type (7 bits, MetadataChunkType)   │
 *   │     followed by chunk_size bytes of payload              │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Name table (nameTableSize bytes; may be 0)               │
 *   │   array of u32 offsets (numSamples entries)              │
 *   │   followed by NUL-terminated name strings                │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Sample data (dataSize bytes)                             │
 *   │   raw codec-specific payloads, concatenated              │
 *   │   each sample's data is at `dataOffset` (relative to     │
 *   │   the start of this section), runs until the next        │
 *   │   sample's offset (or end-of-data for the last).         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The sample header is a packed 64-bit word and we read it as
 * (lo, hi) u32 pair to avoid BigInt where possible — see
 * `unpackSampleHeader`. The bit layout matches python-fsb5's
 * `bits(raw, start, n)` decomposition.
 */

import type { ParsedFsb5Sample } from './types.js';

/** Codec values stored in the FSB5 header `mode` field. */
export const SOUND_FORMAT = {
	NONE: 0,
	PCM8: 1,
	PCM16: 2,
	PCM24: 3,
	PCM32: 4,
	PCMFLOAT: 5,
	GCADPCM: 6,
	IMAADPCM: 7,
	VAG: 8,
	HEVAG: 9,
	XMA: 10,
	MPEG: 11,
	CELT: 12,
	AT9: 13,
	XWMA: 14,
	VORBIS: 15,
} as const;
export type SoundFormat = (typeof SOUND_FORMAT)[keyof typeof SOUND_FORMAT];

export const SOUND_FORMAT_NAMES: Record<number, string> = {
	0: 'NONE',
	1: 'PCM8',
	2: 'PCM16',
	3: 'PCM24',
	4: 'PCM32',
	5: 'PCMFLOAT',
	6: 'GCADPCM',
	7: 'IMAADPCM',
	8: 'VAG',
	9: 'HEVAG',
	10: 'XMA',
	11: 'MPEG',
	12: 'CELT',
	13: 'AT9',
	14: 'XWMA',
	15: 'VORBIS',
};

/** Frequency code → Hz lookup (FSB5 sample-header packed encoding). */
export const FREQUENCY_VALUES: Record<number, number> = {
	1: 8000,
	2: 11000,
	3: 11025,
	4: 16000,
	5: 22050,
	6: 24000,
	7: 32000,
	8: 44100,
	9: 48000,
};

/** Per-sample metadata chunk types. */
export const METADATA_CHUNK_TYPE = {
	CHANNELS: 1,
	FREQUENCY: 2,
	LOOP: 3,
	XMASEEK: 6,
	DSPCOEFF: 7,
	XWMADATA: 10,
	VORBISDATA: 11,
} as const;
export type MetadataChunkType = (typeof METADATA_CHUNK_TYPE)[keyof typeof METADATA_CHUNK_TYPE];

export interface ParsedFsb5Header {
	version: number;
	numSamples: number;
	sampleHeadersSize: number;
	nameTableSize: number;
	dataSize: number;
	mode: SoundFormat;
	modeName: string;
	/** Total bytes of header before the sample table starts. */
	headerSize: number;
}

export interface ParsedFsb5 {
	header: ParsedFsb5Header;
	samples: ParsedFsb5Sample[];
	/** Absolute offset (within the input bytes) where sample-data starts. */
	dataAreaStart: number;
}

/** Cheap (4-byte) magic check. */
export function isFsb5(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x46 &&
		bytes[1] === 0x53 &&
		bytes[2] === 0x42 &&
		bytes[3] === 0x35
	);
}

/**
 * Parse an FSB5 file from raw bytes. The result holds:
 *   - the parsed header
 *   - one entry per sample with codec metadata + a `Uint8Array`
 *     subarray view into the original buffer (zero-copy)
 *
 * Note: the buffer must outlive the parsed result, since sample
 * `data` fields are subarray views.
 */
export function parseFsb5(bytes: Uint8Array): ParsedFsb5 {
	if (!isFsb5(bytes)) throw new Error('parseFsb5: not an FSB5 file (bad magic)');
	if (bytes.length < 60) throw new Error('parseFsb5: header truncated');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint32(4, true);
	const numSamples = dv.getUint32(8, true);
	const sampleHeadersSize = dv.getUint32(12, true);
	const nameTableSize = dv.getUint32(16, true);
	const dataSize = dv.getUint32(20, true);
	const mode = dv.getUint32(24, true) as SoundFormat;
	// 28..36 = "zero" (8 bytes), 36..52 = hash (16), 52..60 = dummy (8)
	const headerSize = version === 0 ? 64 : 60;

	const sampleTableStart = headerSize;
	const nameTableStart = sampleTableStart + sampleHeadersSize;
	const dataAreaStart = nameTableStart + nameTableSize;
	if (dataAreaStart + dataSize > bytes.length) {
		throw new Error(
			`parseFsb5: declared sizes exceed buffer (${dataAreaStart + dataSize} > ${bytes.length})`,
		);
	}

	// Walk the sample table.
	const samples: ParsedFsb5Sample[] = [];
	let off = sampleTableStart;
	for (let i = 0; i < numSamples; i++) {
		// 64-bit packed header. Read as two LE u32s and decompose by bits.
		const lo = dv.getUint32(off, true);
		const hi = dv.getUint32(off + 4, true);
		off += 8;
		const hasMore = lo & 0x1;
		const freqCode = (lo >>> 1) & 0xf;
		const channelBit = (lo >>> 5) & 0x1;
		const channels = channelBit + 1;
		// dataOffset is bits 6..33 (a 28-bit field straddling the two u32s).
		// Lo bits 6..31 = 26 bits, hi bits 0..1 = 2 bits.
		const dataOffsetRaw =
			((lo >>> 6) | ((hi & 0x3) << 26)) >>> 0; // 28 bits
		const dataOffsetInData = dataOffsetRaw * 16;
		// numSamples is bits 34..63 (30 bits): (hi >>> 2) & 0x3FFFFFFF
		const numSamplesField = (hi >>> 2) >>> 0;

		const metadata: Record<number, Uint8Array> = {};
		let next = hasMore;
		while (next) {
			if (off + 4 > bytes.length) throw new Error('FSB5 metadata chunk truncated');
			const raw = dv.getUint32(off, true);
			off += 4;
			next = raw & 0x1;
			const chunkSize = (raw >>> 1) & 0xffffff; // 24 bits
			const chunkType = (raw >>> 25) & 0x7f;    // 7 bits
			if (off + chunkSize > bytes.length) throw new Error('FSB5 metadata chunk payload truncated');
			metadata[chunkType] = bytes.subarray(off, off + chunkSize);
			off += chunkSize;
		}

		// Resolve frequency: explicit FREQUENCY chunk overrides the code.
		let frequency: number;
		const freqChunk = metadata[METADATA_CHUNK_TYPE.FREQUENCY];
		if (freqChunk && freqChunk.length >= 4) {
			frequency = new DataView(
				freqChunk.buffer,
				freqChunk.byteOffset,
			).getUint32(0, true);
		} else if (FREQUENCY_VALUES[freqCode] !== undefined) {
			frequency = FREQUENCY_VALUES[freqCode];
		} else {
			throw new Error(
				`FSB5 sample ${i}: unknown frequency code ${freqCode} and no FREQUENCY metadata`,
			);
		}

		// Resolve channel count: CHANNELS chunk overrides the bit (the bit
		// only covers 1 vs 2; >=3-channel banks need the chunk).
		const channelsChunk = metadata[METADATA_CHUNK_TYPE.CHANNELS];
		const realChannels = channelsChunk && channelsChunk.length >= 1
			? channelsChunk[0]
			: channels;

		samples.push({
			index: i,
			name: '', // resolved later from the name table
			frequency,
			channels: realChannels,
			numSamples: numSamplesField,
			dataOffsetInData,
			dataAbsoluteOffset: dataAreaStart + dataOffsetInData,
			data: new Uint8Array(0), // filled below once we know slice ends
			metadata,
		});
	}

	// Compute each sample's data slice [start, nextStart).
	for (let i = 0; i < samples.length; i++) {
		const start = samples[i].dataAbsoluteOffset;
		const end = i + 1 < samples.length
			? samples[i + 1].dataAbsoluteOffset
			: dataAreaStart + dataSize;
		samples[i].data = bytes.subarray(start, end);
	}

	// Read name table (if present): u32[numSamples] offsets relative to
	// the start of the name table, followed by NUL-terminated strings.
	if (nameTableSize > 0 && numSamples > 0) {
		const nt = bytes.subarray(nameTableStart, nameTableStart + nameTableSize);
		const ntDv = new DataView(nt.buffer, nt.byteOffset, nt.byteLength);
		for (let i = 0; i < numSamples; i++) {
			const nameOff = ntDv.getUint32(i * 4, true);
			let end = nameOff;
			while (end < nt.length && nt[end] !== 0) end++;
			samples[i].name = new TextDecoder('utf-8').decode(nt.subarray(nameOff, end));
		}
	} else {
		// Fall back to numeric names.
		for (const s of samples) s.name = s.index.toString().padStart(4, '0');
	}

	return {
		header: {
			version,
			numSamples,
			sampleHeadersSize,
			nameTableSize,
			dataSize,
			mode,
			modeName: SOUND_FORMAT_NAMES[mode] ?? `UNKNOWN_${mode}`,
			headerSize,
		},
		samples,
		dataAreaStart,
	};
}
