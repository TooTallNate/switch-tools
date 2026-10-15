/**
 * Bandai Namco NUS3 sound banks (`.nus3bank`), as used by Pokkén
 * Tournament (DX), Super Smash Bros. for Wii U / 3DS and other Namco
 * titles, plus the IDSP streams they carry.
 *
 * **NUS3BANK, little-endian.** `"NUS3"`, a u32 size, then `"BANKTOC "`
 * and a u32 TOC size. The TOC is a u32 chunk count and `(magic, size)`
 * pairs; the chunks follow back to back, each as `magic, u32 size,
 * data`. The chunks seen are PROP (project name, date), BINF (bank
 * name), GRP, DTON, TONE, JUNK (padding) and PACK (the stream data).
 *
 * **TONE.** A u32 count, then `(offset, size)` pairs relative to the
 * TONE data. Each tone starts with a u32, a u16 marker (0xFFFF for a
 * playable stream, 0x7F for a random/sequence container, which has no
 * stream of its own) and 6 more bytes, a u8 name length (NUL included)
 * and the name. At `align4(0x0D + nameLength)` come `u32 0`, `u32 8`
 * and the stream's PACK-relative offset and size. Empty (size 0 or
 * 12-byte stub) tones are skipped.
 *
 * **IDSP, big-endian.** Namco's multi-channel wrapper over Nintendo
 * DSP-ADPCM:
 *
 *     0x00  "IDSP"         0x04  0
 *     0x08  channels       0x0C  sample rate
 *     0x10  sample count   0x14  loop start (samples)
 *     0x18  loop end       0x1C  interleave (bytes per channel per block)
 *     0x20  offset of the first channel's DSP header
 *     0x24  DSP header size (0x60 each, consecutive)
 *     0x28  data offset    0x2C  data size per channel
 *
 * Each channel header is the standard 0x60-byte DSP header
 * (coefficients at +0x1C, initial history at +0x40).
 *
 * Sources: vgmstream `meta/nus3bank.c` and the Namco IDSP layout in
 * `meta/ngc_dsp_std.c`; checked against every bank in Pokkén
 * Tournament DX (7,414 IDSP streams, no other codecs).
 */
import { decodeFrames, makeDspState } from '@tootallnate/dsp-adpcm';

export interface Nus3Tone {
	/** Index in the TONE table. */
	index: number;
	name: string;
	/** Absolute offset of the stream in the bank. */
	offset: number;
	size: number;
	/** First four bytes of the stream (`"IDSP"`, `"OPUS"`, `"BNSF"`, …). */
	codec: string;
}

export interface Nus3Bank {
	/** Bank name from BINF, if present. */
	name: string | null;
	/** Playable streams, in TONE order. */
	tones: Nus3Tone[];
}

/** True for a NUS3BANK (as opposed to, say, a `.nus3conf`). */
export function isNus3Bank(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 0x18 && ascii(bytes, 0, 4) === 'NUS3' && ascii(bytes, 8, 8) === 'BANKTOC ';
}

function ascii(b: Uint8Array, o: number, n: number): string {
	let s = '';
	for (let i = 0; i < n && o + i < b.byteLength; i++) s += String.fromCharCode(b[o + i]!);
	return s;
}

function cstring(b: Uint8Array, o: number, max: number): string {
	let end = o;
	while (end < b.byteLength && end < o + max && b[end] !== 0) end++;
	return new TextDecoder('latin1').decode(b.subarray(o, end));
}

/**
 * Size of the bank header: everything before the PACK data. Callers
 * reading lazily can fetch this many bytes and pass them to
 * {@link parseNus3Bank}. Needs the first 0x18 bytes plus the TOC.
 */
export function nus3HeaderSize(bytes: Uint8Array): number {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(0x14, true);
	let off = 0x18 + count * 8;
	for (let i = 0; i < count; i++) {
		const magic = ascii(bytes, 0x18 + i * 8, 4);
		const size = dv.getUint32(0x1c + i * 8, true);
		if (magic === 'PACK') return off + 8;
		off += 8 + size;
	}
	return off;
}

/**
 * Parse a bank's chunk table and TONE list. `bytes` must cover at
 * least {@link nus3HeaderSize} bytes; stream data isn't read.
 */
export function parseNus3Bank(bytes: Uint8Array): Nus3Bank {
	if (!isNus3Bank(bytes)) throw new Error('Not a NUS3BANK');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(0x14, true);
	const chunks = new Map<string, { offset: number; size: number }>();
	let off = 0x18 + count * 8;
	for (let i = 0; i < count; i++) {
		const magic = ascii(bytes, 0x18 + i * 8, 4);
		const size = dv.getUint32(0x1c + i * 8, true);
		chunks.set(magic, { offset: off + 8, size });
		off += 8 + size;
	}
	const pack = chunks.get('PACK');
	const tone = chunks.get('TONE');
	if (!pack || !tone) throw new Error('NUS3BANK: missing TONE or PACK chunk');

	let name: string | null = null;
	const binf = chunks.get('BINF');
	if (binf && binf.offset + 0x0d <= bytes.byteLength) {
		// BINF: u32 0, u32 3?, u8 length, name.
		const len = bytes[binf.offset + 8]!;
		name = cstring(bytes, binf.offset + 9, len) || null;
	}

	const tones: Nus3Tone[] = [];
	const t = tone.offset;
	const toneCount = dv.getUint32(t, true);
	for (let i = 0; i < toneCount; i++) {
		const eo = dv.getUint32(t + 4 + i * 8, true);
		const es = dv.getUint32(t + 8 + i * 8, true);
		const e = t + eo;
		if (es < 0x10 || e + es > bytes.byteLength) continue;
		if (dv.getUint16(e + 4, true) !== 0xffff) continue;
		const nameLength = bytes[e + 0x0c]!;
		const q = e + ((0x0d + nameLength + 3) & ~3);
		if (q + 16 > e + es) continue;
		if (dv.getUint32(q + 4, true) !== 8) continue;
		const rel = dv.getUint32(q + 8, true);
		const size = dv.getUint32(q + 12, true);
		if (size === 0 || rel + size > pack.size) continue;
		const offset = pack.offset + rel;
		tones.push({
			index: i,
			name: cstring(bytes, e + 0x0d, nameLength),
			offset,
			size,
			codec: offset + 4 <= bytes.byteLength ? ascii(bytes, offset, 4) : '',
		});
	}
	return { name, tones };
}

export interface IdspInfo {
	channels: number;
	sampleRate: number;
	numSamples: number;
	/** Loop points in samples (end exclusive), when the stream loops. */
	loop: { start: number; end: number } | null;
}

export interface IdspDecoded extends IdspInfo {
	/** Interleaved PCM16. */
	samples: Int16Array;
}

/** Snap rates stored one off a standard value (Pokkén writes 47999). */
function snapRate(rate: number): number {
	for (const std of [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]) {
		if (Math.abs(rate - std) <= 2) return std;
	}
	return rate;
}

/** Read an IDSP stream's header fields. */
export function readIdspInfo(bytes: Uint8Array): IdspInfo {
	if (ascii(bytes, 0, 4) !== 'IDSP') throw new Error('Not an IDSP stream');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const channels = dv.getUint32(0x08, false);
	if (channels < 1 || channels > 16) throw new Error(`IDSP: bad channel count ${channels}`);
	const numSamples = dv.getUint32(0x10, false);
	const loopStart = dv.getUint32(0x14, false);
	const loopEnd = dv.getUint32(0x18, false);
	const firstHeader = dv.getUint32(0x20, false);
	const looped = firstHeader + 0x0e <= bytes.byteLength && dv.getUint16(firstHeader + 0x0c, false) !== 0;
	return {
		channels,
		sampleRate: snapRate(dv.getUint32(0x0c, false)),
		numSamples,
		// The header's loop end is inclusive; report it exclusive (as vgmstream does).
		loop: looped && loopEnd > loopStart ? { start: loopStart, end: Math.min(numSamples, loopEnd + 1) } : null,
	};
}

/** Decode an IDSP stream to interleaved PCM16. */
export function decodeIdsp(bytes: Uint8Array): IdspDecoded {
	const info = readIdspInfo(bytes);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const { channels, numSamples } = info;
	const interleave = dv.getUint32(0x1c, false);
	const firstHeader = dv.getUint32(0x20, false);
	const headerSize = dv.getUint32(0x24, false) || 0x60;
	const dataOffset = dv.getUint32(0x28, false);
	const perChannel = dv.getUint32(0x2c, false);

	// De-interleave each channel into one contiguous frame stream.
	const streams: Uint8Array[] = [];
	for (let c = 0; c < channels; c++) streams.push(new Uint8Array(perChannel));
	if (channels === 1 || interleave === 0) {
		for (let c = 0; c < channels; c++) {
			const start = dataOffset + c * perChannel;
			streams[c]!.set(bytes.subarray(start, Math.min(bytes.byteLength, start + perChannel)));
		}
	} else {
		for (let pos = 0, src = dataOffset; pos < perChannel; pos += interleave) {
			const n = Math.min(interleave, perChannel - pos);
			// A short final block is packed at its real size per channel.
			for (let c = 0; c < channels; c++, src += n) {
				if (src >= bytes.byteLength) break;
				streams[c]!.set(bytes.subarray(src, Math.min(bytes.byteLength, src + n)), pos);
			}
		}
	}

	const samples = new Int16Array(numSamples * channels);
	for (let c = 0; c < channels; c++) {
		const h = firstHeader + c * headerSize;
		const state = makeDspState(bytes.subarray(h + 0x1c, h + 0x3c), {
			littleEndian: false,
			hist1: dv.getInt16(h + 0x40, false),
			hist2: dv.getInt16(h + 0x42, false),
		});
		decodeFrames(streams[c]!, 0, numSamples, state, samples, c, channels);
	}
	return { ...info, samples };
}
