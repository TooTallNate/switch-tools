/**
 * WEM RIFF chunk walker + fmt-chunk parser.
 */

/** Standard "RIFF" magic at offset 0 of every WEM. */
export const WEM_RIFF_MAGIC = 'RIFF';

/** Wwise codec id — the value of `wFormatTag` in the WEM's `fmt ` chunk. */
export type WemCodecId =
	| 0x0001
	| 0x0002
	| 0x0069
	| 0x0161
	| 0x0162
	| 0x0165
	| 0x0166
	| 0x3039
	| 0x3040
	| 0x3041
	| 0x8311
	| 0xaac0
	| 0xfff0
	| 0xfffb
	| 0xfffc
	| 0xfffe
	| 0xffff
	| number;

/** Human-readable codec names. Matches vgmstream's `wwise_codec_t` labels. */
export const WEM_CODEC_NAMES: Record<number, string> = {
	0x0001: 'PCM 16-bit LE',
	0x0002: 'IMA-ADPCM (or DSP/PTADPCM by extra_size)',
	0x0069: 'XBOX-IMA',
	0x0161: 'XWMA (WMAv2)',
	0x0162: 'XWMA Pro',
	0x0165: 'XMA2 (XMA2-chunk)',
	0x0166: 'XMA2 (fmt-chunk)',
	0x3039: 'Switch-Opus (OPUSNX)',
	0x3040: 'Ogg-Opus (standard)',
	0x3041: 'Wwise-Opus (OPUSWW)',
	0x8311: 'PTADPCM',
	0xaac0: 'AAC',
	0xfff0: 'NGC DSP-ADPCM',
	0xfffb: 'HEVAG',
	0xfffc: 'ATRAC9',
	0xfffe: 'PCMEX (Wwise authoring PCM)',
	0xffff: 'Wwise Vorbis',
};

/** A single RIFF sub-chunk of the WEM (e.g. "fmt ", "data", "smpl"). */
export interface WemChunk {
	/** 4-char ASCII id. */
	id: string;
	/** Byte offset of the chunk's *header* (the id + size pair) in the WEM blob. */
	offset: number;
	/** Size of the chunk's payload (does not include the 8-byte header). */
	size: number;
	/** Lazy `Blob` slice covering only the payload. */
	data: Blob;
}

/** Parsed `fmt ` chunk. Fields beyond `extra_size` are codec-specific. */
export interface WemFmt {
	codecId: WemCodecId;
	codecName: string;
	channels: number;
	sampleRate: number;
	avgBytesPerSec: number;
	blockAlign: number;
	bitsPerSample: number;
	/** `cbSize` — the WAVEFORMATEX-style "extra bytes" field, if present. */
	extraSize: number;
	/** The full fmt payload (read eagerly, since fmt is small). */
	rawPayload: Uint8Array;
}

/** Top-level parse result. */
export interface ParsedWem {
	/** Total file size as declared by the RIFF size field (often slightly off — Wwise quirk). */
	declaredSize: number;
	/** Top-level chunks (in file order). */
	chunks: WemChunk[];
	/** Parsed `fmt ` chunk. */
	fmt: WemFmt;
	/** Convenience pointer at the `data` chunk. */
	dataChunk: WemChunk | null;
}

/** Cheap (12-byte) magic check — needs both "RIFF" and "WAVE". */
export async function isWem(blob: Blob): Promise<boolean> {
	if (blob.size < 12) return false;
	const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	const riff =
		head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
	const wave =
		head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45;
	return riff && wave;
}

/** Parse a WEM. Reads only the chunk headers + the small `fmt ` payload. */
export async function parseWem(blob: Blob): Promise<ParsedWem> {
	if (blob.size < 12) {
		throw new Error(`Blob too small to be a WEM (${blob.size} bytes)`);
	}
	const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	if (
		head[0] !== 0x52 ||
		head[1] !== 0x49 ||
		head[2] !== 0x46 ||
		head[3] !== 0x46
	) {
		throw new Error('Bad RIFF magic — not a WEM');
	}
	if (
		head[8] !== 0x57 ||
		head[9] !== 0x41 ||
		head[10] !== 0x56 ||
		head[11] !== 0x45
	) {
		throw new Error('Bad WAVE magic — not a WEM');
	}
	const declaredSize = new DataView(
		head.buffer,
		head.byteOffset,
	).getUint32(4, true);

	const chunks: WemChunk[] = [];
	let off = 12;
	const fileSize = blob.size;
	while (off + 8 <= fileSize) {
		const hdr = new Uint8Array(await blob.slice(off, off + 8).arrayBuffer());
		const id = String.fromCharCode(hdr[0], hdr[1], hdr[2], hdr[3]);
		// Validate ASCII to detect malformed/truncated WEMs early.
		let asciiOk = true;
		for (let i = 0; i < 4; i++) {
			if (hdr[i] < 0x20 || hdr[i] > 0x7e) {
				asciiOk = false;
				break;
			}
		}
		if (!asciiOk) break;
		const size = new DataView(hdr.buffer, hdr.byteOffset).getUint32(4, true);
		const payloadStart = off + 8;
		const payloadEnd = Math.min(fileSize, payloadStart + size);
		chunks.push({
			id,
			offset: off,
			size,
			data: blob.slice(payloadStart, payloadEnd),
		});
		off = payloadStart + size;
		// Real RIFF aligns chunks to even bytes; Wwise WEMs do too.
		if (off & 1) off++;
		// Sanity break if size is bogus.
		if (size > fileSize) break;
	}

	const fmtChunk = chunks.find((c) => c.id === 'fmt ');
	if (!fmtChunk) throw new Error('WEM missing fmt chunk');
	const fmtBytes = new Uint8Array(await fmtChunk.data.arrayBuffer());
	if (fmtBytes.length < 0x10) {
		throw new Error(`WEM fmt chunk too small (${fmtBytes.length} bytes)`);
	}
	const fdv = new DataView(fmtBytes.buffer, fmtBytes.byteOffset, fmtBytes.byteLength);
	const codecId = fdv.getUint16(0, true) as WemCodecId;
	const channels = fdv.getUint16(2, true);
	const sampleRate = fdv.getUint32(4, true);
	const avgBytesPerSec = fdv.getUint32(8, true);
	const blockAlign = fdv.getUint16(12, true);
	const bitsPerSample = fdv.getUint16(14, true);
	const extraSize = fmtBytes.length >= 0x12 ? fdv.getUint16(16, true) : 0;

	const fmt: WemFmt = {
		codecId,
		codecName: WEM_CODEC_NAMES[codecId] ?? `Unknown (0x${codecId.toString(16)})`,
		channels,
		sampleRate,
		avgBytesPerSec,
		blockAlign,
		bitsPerSample,
		extraSize,
		rawPayload: fmtBytes,
	};
	const dataChunk = chunks.find((c) => c.id === 'data') ?? null;
	return { declaredSize, chunks, fmt, dataChunk };
}
