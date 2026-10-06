/**
 * Wwise's Switch-Opus (codec id 0x3039) → standard Ogg-Opus muxer.
 *
 * # Switch-Opus framing
 *
 * In a Wwise OPUSNX WEM, the `data` chunk's payload is laid out as:
 *
 *   ┌───────────────────────────────────┐
 *   │ Seek table (u32 seek_size bytes)  │  (sample_pos lookup, ignored)
 *   ├───────────────────────────────────┤
 *   │ Opus packets, each prefixed with  │
 *   │   u32 packet_size (BE),           │  ← number of Opus payload bytes
 *   │   u32 final_range  (BE),          │  ← Opus encoder state, ignored
 *   │   <packet_size> bytes (Opus pkt)  │
 *   └───────────────────────────────────┘
 *
 * `seek_size` is read from the fmt chunk at `fmt_offset + 0x24`
 * (i.e. fmt-payload byte 0x24 → bytes 0x24..0x28 of `rawPayload`).
 *
 * `num_samples` (total decoded samples, post-decoder-delay) is at
 * fmt-payload offset 0x18.
 *
 * The Opus packets themselves are standard libopus packets — we
 * just need to wrap them in an Ogg-Opus stream so the browser's
 * built-in Opus decoder can play them via `<audio>`.
 *
 * # Ogg-Opus output
 *
 * RFC 7845 specifies how Opus is wrapped in Ogg:
 *
 *   - Page 0  (BOS): "OpusHead" identification packet (19 bytes)
 *   - Page 1       : "OpusTags"  comment packet (~30 bytes)
 *   - Page 2..N    : Opus audio packets, with granule_position
 *                    = total decoded sample count up to and
 *                    including the last packet on this page
 *   - Last page (EOS): granule_position = total samples
 *
 * Each Ogg page has a 27-byte header + segment_table (1 byte per
 * segment). A packet of size N is split into ceil(N/255) segments;
 * if N is a multiple of 255 we append an explicit zero-length
 * terminator segment.
 *
 * Ogg pages must keep payload (segments + segment_table) ≤ 65025
 * bytes (255 segments × 255 bytes max). For Switch-Opus at 192 kbps
 * each packet is ~480 bytes ≈ 2 segments, so we can fit ~50 packets
 * per page. We use ~25 packets per page (= 0.5s of audio) which is
 * a comfortable middle ground for both file size and seekability.
 *
 * # CRC
 *
 * Ogg uses CRC-32 with polynomial 0x04C11DB7 (the same one used by
 * Ethernet/MPEG/PNG, MSB-first, no inversion). The CRC is computed
 * over the entire page (header + segment_table + payload) with the
 * CRC field itself zeroed out, then patched into the header.
 */

import type { ParsedWem } from './parse.js';

// 48 kHz is fixed for all Opus streams (RFC 7845).
const OPUS_RATE = 48000;
// Opus pre-skip: standard recommendation, also what Wwise/vgmstream uses.
const OPUS_PRE_SKIP = 120;
// Opus packets per Ogg page. Tuned for ~0.5s of audio per page.
const PACKETS_PER_PAGE = 25;

/**
 * Convert a Wwise Switch-Opus (0x3039) WEM into a standard Ogg-Opus
 * `Blob` that browsers can play directly.
 *
 * @throws if the WEM isn't OPUSNX or its fmt chunk is too short.
 */
export async function wemSwitchOpusToOggOpus(parsed: ParsedWem): Promise<Blob> {
	const { fmt, dataChunk } = parsed;
	if (fmt.codecId !== 0x3039) {
		throw new Error(
			`Not a Switch-Opus WEM (codec_id=0x${fmt.codecId.toString(16)})`,
		);
	}
	if (!dataChunk) throw new Error('OPUSNX WEM missing data chunk');
	if (fmt.rawPayload.length < 0x28) {
		throw new Error(
			`OPUSNX fmt chunk too small (${fmt.rawPayload.length}, need 0x28)`,
		);
	}
	const fdv = new DataView(
		fmt.rawPayload.buffer,
		fmt.rawPayload.byteOffset,
		fmt.rawPayload.byteLength,
	);
	const numSamples = fdv.getInt32(0x18, true);
	// 0x1c: null
	// 0x20: data_size_minus_seek (we recompute from data.size for safety)
	const seekSize = fdv.getUint32(0x24, true);

	// Read the entire data chunk into memory. WEMs are small (≤
	// ~10 MB even for long music tracks), so this is safe.
	const dataAll = new Uint8Array(await dataChunk.data.arrayBuffer());
	if (dataAll.length < seekSize) {
		throw new Error(
			`OPUSNX data chunk shorter (${dataAll.length}) than seek_size (${seekSize})`,
		);
	}
	const opusFramed = dataAll.subarray(seekSize);

	return framedOpusToOggOpus(opusFramed, {
		channels: fmt.channels,
		sampleRate: fmt.sampleRate,
		numSamples,
		preSkip: OPUS_PRE_SKIP,
	});
}

/**
 * Remux Nintendo-framed Opus packets into an Ogg-Opus `Blob`.
 *
 * Nintendo's framing (shared by Wwise OPUSNX WEMs and standalone
 * Nintendo Opus streams) is a run of packets, each prefixed with a
 * big-endian u32 payload size and a u32 encoder final-range value.
 * A zero size ends the stream.
 */
export function framedOpusToOggOpus(
	framed: Uint8Array,
	info: { channels: number; sampleRate: number; numSamples?: number; preSkip?: number },
): Blob {
	const preSkip = info.preSkip ?? OPUS_PRE_SKIP;
	const numSamples = info.numSamples ?? 0;
	const packets: Uint8Array[] = [];
	{
		let off = 0;
		const dv = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
		while (off + 8 <= framed.length) {
			const pktSize = dv.getUint32(off, false); // BE!
			// final_range at off+4 (ignored)
			off += 8;
			if (pktSize === 0) break;
			if (off + pktSize > framed.length) {
				// Truncated final packet; bail.
				break;
			}
			packets.push(framed.subarray(off, off + pktSize));
			off += pktSize;
		}
	}
	if (packets.length === 0) {
		throw new Error('Opus stream has no decodable packets');
	}

	// Build the Ogg-Opus stream.
	const serial = (Math.random() * 0xffffffff) >>> 0;
	const builder = new OggBuilder(serial);

	// Page 0: OpusHead (BOS).
	builder.appendPage(
		[buildOpusHead(info.channels, preSkip, info.sampleRate)],
		0n,
		/* bos */ true,
		/* eos */ false,
	);

	// Page 1: OpusTags.
	builder.appendPage([buildOpusTags()], 0n, /* bos */ false, /* eos */ false);

	// Pages 2+: audio. Granule = cumulative decoded samples (incl.
	// pre-skip), derived from each packet's TOC byte.
	let cumulativeSamples = BigInt(preSkip);
	for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
		const slice = packets.slice(i, i + PACKETS_PER_PAGE);
		for (const pkt of slice) {
			cumulativeSamples += BigInt(opusPacketSamples(pkt, OPUS_RATE));
		}
		const isLast = i + PACKETS_PER_PAGE >= packets.length;
		// On the last page, set granule to numSamples + pre_skip if known.
		const granule =
			isLast && numSamples > 0 ? BigInt(numSamples + preSkip) : cumulativeSamples;
		builder.appendPage(slice, granule, /* bos */ false, /* eos */ isLast);
	}

	return builder.toBlob();
}

// ---------------------------------------------------------------------------
// Standalone Nintendo Opus (`.lopus` / `.nop`, header id 0x80000001).
// ---------------------------------------------------------------------------

const NX_OPUS_HEADER_ID = 0x80000001;
const NX_OPUS_DATA_ID = 0x80000004;

export interface NintendoOpusInfo {
	channels: number;
	sampleRate: number;
	/** Encoder pre-skip in samples (0x1C), or the standard 120 if unset. */
	preSkip: number;
	/** Absolute offset of the framed packet data. */
	dataOffset: number;
	/** Byte length of the framed packet data. */
	dataSize: number;
}

/** True if `bytes` starts with the Nintendo Opus header id `0x80000001`. */
export function isNintendoOpus(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x01 &&
		bytes[1] === 0x00 &&
		bytes[2] === 0x00 &&
		bytes[3] === 0x80
	);
}

/**
 * Parse a Nintendo Opus header (as used by Switch titles directly and
 * inside CRI AWB banks, e.g. Super Mario RPG's music):
 *
 * ```
 * 0x00 u32 0x80000001  header id
 * 0x04 u32 header size
 * 0x08 u8  version
 * 0x09 u8  channel count
 * 0x0A u16 frame size (0 = VBR)
 * 0x0C u32 sample rate
 * 0x10 u32 offset of the data chunk
 * 0x1C u16 pre-skip
 * data chunk: u32 0x80000004, u32 size, framed packets
 * ```
 *
 * Reference: vgmstream `src/meta/opus.c`.
 */
export function parseNintendoOpus(bytes: Uint8Array): NintendoOpusInfo {
	if (bytes.length < 0x20) throw new Error('Nintendo Opus header truncated');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, true) !== NX_OPUS_HEADER_ID) {
		throw new Error('Not a Nintendo Opus stream (missing 0x80000001 header)');
	}
	const channels = bytes[0x09]!;
	const sampleRate = dv.getUint32(0x0c, true);
	const chunk = dv.getUint32(0x10, true);
	if (chunk + 8 > bytes.length || dv.getUint32(chunk, true) !== NX_OPUS_DATA_ID) {
		throw new Error('Nintendo Opus data chunk (0x80000004) not found');
	}
	if (channels < 1 || channels > 2) {
		throw new Error(`Nintendo Opus with ${channels} channels is not supported (mono/stereo only)`);
	}
	const dataSize = Math.min(dv.getUint32(chunk + 4, true), bytes.length - (chunk + 8));
	const preSkip = dv.getUint16(0x1c, true) || OPUS_PRE_SKIP;
	return { channels, sampleRate, preSkip, dataOffset: chunk + 8, dataSize };
}

/** Remux a standalone Nintendo Opus stream into a playable Ogg-Opus `Blob`. */
export function nintendoOpusToOggOpus(bytes: Uint8Array): { info: NintendoOpusInfo; ogg: Blob } {
	const info = parseNintendoOpus(bytes);
	const ogg = framedOpusToOggOpus(bytes.subarray(info.dataOffset, info.dataOffset + info.dataSize), {
		channels: info.channels,
		sampleRate: info.sampleRate,
		preSkip: info.preSkip,
	});
	return { info, ogg };
}

// ---------------------------------------------------------------------------
// OpusHead / OpusTags builders.
// ---------------------------------------------------------------------------

function buildOpusHead(
	channels: number,
	preSkip: number,
	originalSampleRate: number,
): Uint8Array {
	// RFC 7845 §5.1
	const head = new Uint8Array(19);
	const enc = new TextEncoder();
	head.set(enc.encode('OpusHead'), 0);   // 8-byte magic
	head[8] = 1;                            // version
	head[9] = Math.max(1, Math.min(255, channels));
	const dv = new DataView(head.buffer);
	dv.setUint16(10, preSkip, true);
	dv.setUint32(12, originalSampleRate, true);
	dv.setInt16(16, 0, true);              // output gain (Q7.8 dB)
	head[18] = 0;                          // channel mapping family (0 = mono/stereo only)
	return head;
}

function buildOpusTags(): Uint8Array {
	// RFC 7845 §5.2 — minimal valid OpusTags: magic, vendor, 0 user comments.
	const enc = new TextEncoder();
	const vendor = enc.encode('@tootallnate/wem');
	const out = new Uint8Array(8 + 4 + vendor.length + 4);
	out.set(enc.encode('OpusTags'), 0);
	const dv = new DataView(out.buffer);
	dv.setUint32(8, vendor.length, true);
	out.set(vendor, 12);
	dv.setUint32(12 + vendor.length, 0, true); // 0 user comments
	return out;
}

// ---------------------------------------------------------------------------
// Opus TOC byte parsing — used to derive samples per packet.
// ---------------------------------------------------------------------------

/** Number of 48 kHz samples encoded by an Opus packet, given its TOC byte. */
function opusPacketSamples(packet: Uint8Array, sampleRate: number): number {
	if (packet.length === 0) return 0;
	const toc = packet[0];
	const config = (toc >> 3) & 0x1f;
	const code = toc & 0x03;
	// Frame size lookup (RFC 6716 §3.1).
	// Configs 0–3: SILK NB (8 kHz)
	// Configs 4–7: SILK MB (12 kHz)
	// Configs 8–11: SILK WB (16 kHz)
	// Configs 12–13: Hybrid SWB (24 kHz)
	// Configs 14–15: Hybrid FB (48 kHz)
	// Configs 16–19: CELT NB
	// Configs 20–23: CELT WB
	// Configs 24–27: CELT SWB
	// Configs 28–31: CELT FB
	// frame_ms by config-mod-4:
	//   SILK (0-11): 10, 20, 40, 60 ms
	//   Hybrid (12-15): 10, 20 ms
	//   CELT (16-31): 2.5, 5, 10, 20 ms
	let frameSamples: number;
	if (config < 12) {
		// SILK
		const ms = [10, 20, 40, 60][config & 3];
		frameSamples = (sampleRate * ms) / 1000;
	} else if (config < 16) {
		// Hybrid: only 10 or 20 ms
		const ms = (config & 1) === 0 ? 10 : 20;
		frameSamples = (sampleRate * ms) / 1000;
	} else {
		// CELT
		const idx = config & 3;
		const ms = [2.5, 5, 10, 20][idx];
		frameSamples = Math.round((sampleRate * ms) / 1000);
	}
	// Frame count from code:
	//   0 → 1 frame
	//   1 → 2 frames
	//   2 → 2 frames (different sizes, but always 2)
	//   3 → variable (read from second byte's low 6 bits)
	let frameCount: number;
	if (code === 0) frameCount = 1;
	else if (code === 1) frameCount = 2;
	else if (code === 2) frameCount = 2;
	else {
		// code 3 — frame count is in byte 1, low 6 bits.
		if (packet.length < 2) frameCount = 1;
		else frameCount = packet[1] & 0x3f;
		if (frameCount === 0) frameCount = 1;
	}
	return frameSamples * frameCount;
}

// ---------------------------------------------------------------------------
// Ogg page builder.
// ---------------------------------------------------------------------------

class OggBuilder {
	private pages: Uint8Array[] = [];
	private seqNo = 0;
	constructor(private serial: number) {}

	appendPage(packets: Uint8Array[], granulePos: bigint, bos: boolean, eos: boolean) {
		const segments = this.buildSegmentTable(packets);
		if (segments.length > 255) {
			// Should not happen given our PACKETS_PER_PAGE cap; bail loudly.
			throw new Error(
				`Ogg page would have ${segments.length} segments (>255)`,
			);
		}
		const totalPayload = segments.reduce((a, b) => a + b, 0);
		const headerSize = 27 + segments.length;
		const page = new Uint8Array(headerSize + totalPayload);
		const dv = new DataView(page.buffer);
		// "OggS"
		page[0] = 0x4f;
		page[1] = 0x67;
		page[2] = 0x67;
		page[3] = 0x53;
		page[4] = 0;                                              // version
		let headerType = 0;
		if (bos) headerType |= 0x02;
		if (eos) headerType |= 0x04;
		page[5] = headerType;
		// granule_position (s64 LE, but Ogg treats it as opaque)
		dv.setBigUint64(6, granulePos & 0xffffffffffffffffn, true);
		dv.setUint32(14, this.serial, true);
		dv.setUint32(18, this.seqNo++, true);
		dv.setUint32(22, 0, true);                                 // CRC placeholder
		page[26] = segments.length;
		for (let i = 0; i < segments.length; i++) page[27 + i] = segments[i];

		// Payload.
		let payloadOff = headerSize;
		for (const pkt of packets) {
			page.set(pkt, payloadOff);
			payloadOff += pkt.length;
		}

		// CRC.
		const crc = oggCrc32(page);
		dv.setUint32(22, crc, true);
		this.pages.push(page);
	}

	toBlob(): Blob {
		// Total size & concat.
		let total = 0;
		for (const p of this.pages) total += p.length;
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of this.pages) {
			out.set(p, off);
			off += p.length;
		}
		return new Blob([out as unknown as BlobPart], { type: 'audio/ogg; codecs=opus' });
	}

	private buildSegmentTable(packets: Uint8Array[]): number[] {
		const segs: number[] = [];
		for (const pkt of packets) {
			const full = Math.floor(pkt.length / 255);
			for (let i = 0; i < full; i++) segs.push(255);
			segs.push(pkt.length % 255); // final lacing value (0 if exact multiple — terminator)
		}
		return segs;
	}
}

// ---------------------------------------------------------------------------
// CRC-32, Ogg flavour.
// Polynomial 0x04C11DB7, MSB-first, init 0, no input/output reflection.
// (Same as MPEG/Ethernet, but Ogg specifies init=0 and no inversion.)
// ---------------------------------------------------------------------------

const OGG_CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let r = i << 24;
		for (let j = 0; j < 8; j++) {
			r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
		}
		t[i] = r >>> 0;
	}
	return t;
})();

function oggCrc32(bytes: Uint8Array): number {
	let crc = 0;
	for (let i = 0; i < bytes.length; i++) {
		crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
	}
	return crc;
}
