/**
 * FMOD Vorbis (FSB5 mode 15) → Ogg-Vorbis muxer.
 *
 * Each FSB5 Vorbis sample carries a 4-byte CRC32 in its
 * `VORBISDATA` metadata chunk that keys a precomputed Vorbis Setup
 * packet (we ship a 161-entry lookup table covering the codecs
 * shipped by every FMOD title since FMOD Studio 1.x).
 *
 * The audio data is a flat sequence of `(u16 packet_size, ...)`-
 * framed Vorbis packets. We rebuild a standard Ogg-Vorbis stream
 * by:
 *
 *   1. Building the Identification packet from the sample's
 *      channel count, frequency, and the FMOD-fixed blocksizes
 *      (short=0x100=256, long=0x800=2048).
 *   2. Building a minimal Comment packet.
 *   3. Using the precomputed Setup packet looked up by CRC32.
 *   4. For each audio packet, computing a per-packet block size
 *      from the mode index (first `mode_bits` bits of the packet),
 *      and a granule position from cumulative `(blocksize +
 *      prev_blocksize) / 4` PCM samples (Vorbis spec).
 *   5. Wrapping each header packet on its own Ogg page (BOS for
 *      ID, plain for Comment + Setup), and the audio packets
 *      across as many pages as needed (one packet per page is
 *      simplest; libvorbis decoders are happy with that).
 *
 * Mode bits: `ilog(mode_count - 1)`. With `mode_count = 1` there
 * are 0 mode bits (always short window). With `mode_count = 2`
 * there's 1 mode bit (per FMOD's static encoder configuration:
 * mode 0 = short, mode 1 = long — verified across all 161 known
 * setup packets).
 */

import type { ParsedFsb5Sample } from './types.js';
import type { FmodVorbisSetupPackets, FmodVorbisSetup } from './setup-packets.js';
import { METADATA_CHUNK_TYPE } from './parse.js';

// FMOD's fixed Vorbis blocksizes (powers of 2 → 256 and 2048 samples).
const BLOCKSIZE_SHORT = 0x100;
const BLOCKSIZE_LONG = 0x800;
const BLOCKSIZE_0_POW = 8; // log2(BLOCKSIZE_SHORT)
const BLOCKSIZE_1_POW = 11; // log2(BLOCKSIZE_LONG)

// Ogg page constants.
const HEADER_BYTES = 27;
const SEGMENT_SIZE = 255;
const MAX_SEGMENTS = 255;

const OGG_CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let r = i << 24;
		for (let j = 0; j < 8; j++) {
			r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
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

/**
 * Look up the FMOD Vorbis setup for a parsed FSB5 sample. Returns
 * null if the sample doesn't have a VORBISDATA chunk OR the CRC32
 * isn't in the lookup table.
 */
export function findVorbisSetup(
	sample: ParsedFsb5Sample,
	library: FmodVorbisSetupPackets,
): FmodVorbisSetup | null {
	const vd = sample.metadata[METADATA_CHUNK_TYPE.VORBISDATA];
	if (!vd || vd.length < 4) return null;
	const crc = new DataView(vd.buffer, vd.byteOffset).getUint32(0, true);
	return library.lookup(crc);
}

/**
 * Decode an FMOD Vorbis sample to an Ogg-Vorbis Blob.
 *
 * Throws if the sample doesn't have a VORBISDATA chunk, the CRC32
 * isn't in the library, or the data is structurally invalid.
 */
export function decodeFmodVorbisSample(
	sample: ParsedFsb5Sample,
	library: FmodVorbisSetupPackets,
): Blob {
	const setup = findVorbisSetup(sample, library);
	if (!setup) {
		const vd = sample.metadata[METADATA_CHUNK_TYPE.VORBISDATA];
		const crc = vd && vd.length >= 4
			? new DataView(vd.buffer, vd.byteOffset).getUint32(0, true)
			: -1;
		throw new Error(
			`FMOD Vorbis: no setup packet for CRC32 0x${crc >>> 0 ? crc.toString(16) : '<missing>'} (sample "${sample.name}"). The library covers ${library.count} known patterns; new ones turn up occasionally.`,
		);
	}

	// Build the three header packets.
	const idPacket = buildIdentificationPacket(sample.channels, sample.frequency);
	const commentPacket = buildCommentPacket();

	// Walk the audio packets and assemble.
	const audioPackets: Uint8Array[] = [];
	const granules: number[] = []; // cumulative PCM samples after each packet
	{
		const data = sample.data;
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		let off = 0;
		const modeBits = setup.modeCount > 1 ? Math.ceil(Math.log2(setup.modeCount)) : 0;
		let prevBlocksize = 0;
		let cumulative = 0;
		while (off + 2 <= data.length) {
			const packetSize = dv.getUint16(off, true);
			off += 2;
			if (packetSize === 0) break; // FMOD terminator
			if (off + packetSize > data.length) break;
			const packet = data.subarray(off, off + packetSize);
			off += packetSize;

			// Determine the block size from the mode index.
			let blocksize = BLOCKSIZE_SHORT;
			if (modeBits > 0 && packet.length >= 1) {
				// First byte's bit 0 = packet_type (0 for audio), bits 1..modeBits = mode_number.
				// Vorbis bitpacking is LSB-first within a byte.
				const modeNumber = (packet[0] >> 1) & ((1 << modeBits) - 1);
				// FMOD encoder convention: mode 0 = short, mode 1 = long.
				blocksize = modeNumber === 0 ? BLOCKSIZE_SHORT : BLOCKSIZE_LONG;
			}

			audioPackets.push(packet);
			if (prevBlocksize === 0) {
				// First audio packet contributes 0 to granule (Vorbis
				// requires at least one full overlap before sample
				// output starts).
				granules.push(0);
			} else {
				cumulative += (blocksize + prevBlocksize) / 4;
				granules.push(cumulative);
			}
			prevBlocksize = blocksize;
		}
	}

	if (audioPackets.length === 0) {
		throw new Error('FMOD Vorbis: no audio packets in sample');
	}

	// Build the Ogg stream.
	const serial = (Math.random() * 0xffffffff) >>> 0;
	const builder = new OggBuilder(serial);
	builder.appendPage([idPacket], 0n, /* bos */ true, /* eos */ false);
	builder.appendPage([commentPacket], 0n, false, false);
	builder.appendPage([setup.setup], 0n, false, false);
	for (let i = 0; i < audioPackets.length; i++) {
		const isLast = i === audioPackets.length - 1;
		builder.appendPage([audioPackets[i]], BigInt(granules[i]), false, isLast);
	}

	return builder.toBlob();
}

// ---------------------------------------------------------------
// Vorbis ID + Comment packet builders
// ---------------------------------------------------------------

function buildIdentificationPacket(channels: number, sampleRate: number): Uint8Array {
	// 30-byte fixed-size packet:
	//   "\x01vorbis"      7 bytes
	//   version u32       4 bytes  (=0)
	//   channels u8       1 byte
	//   sample_rate u32   4 bytes
	//   bitrate_max u32   4 bytes  (=0)
	//   bitrate_nom u32   4 bytes  (=0)
	//   bitrate_min u32   4 bytes  (=0)
	//   blocksize 0/1     1 byte   (4 bits each, packed LSB-first: pow0 in low nibble)
	//   framing u1        1 bit (in next byte; padded to a full byte)
	const out = new Uint8Array(30);
	out[0] = 0x01;
	out.set([0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 1); // "vorbis"
	const dv = new DataView(out.buffer);
	dv.setUint32(7, 0, true); // version
	out[11] = channels;
	dv.setUint32(12, sampleRate, true);
	dv.setUint32(16, 0, true); // bitrate_max
	dv.setUint32(20, 0, true); // bitrate_nom
	dv.setUint32(24, 0, true); // bitrate_min
	out[28] = (BLOCKSIZE_0_POW & 0xf) | ((BLOCKSIZE_1_POW & 0xf) << 4);
	out[29] = 0x01; // framing bit (LSB) padded with zeros
	return out;
}

function buildCommentPacket(): Uint8Array {
	const vendor = '@tootallnate/fsb5 (FMOD-Vorbis to Ogg-Vorbis)';
	const vendorBytes = new TextEncoder().encode(vendor);
	const totalLen = 7 + 4 + vendorBytes.length + 4 + 1;
	const out = new Uint8Array(totalLen);
	out[0] = 0x03;
	out.set([0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 1);
	const dv = new DataView(out.buffer);
	dv.setUint32(7, vendorBytes.length, true);
	out.set(vendorBytes, 11);
	dv.setUint32(11 + vendorBytes.length, 0, true); // 0 user comments
	out[totalLen - 1] = 0x01; // framing bit
	return out;
}

// ---------------------------------------------------------------
// Ogg page builder — duplicate of the one in wem-vorbis for now
// (tiny, no shared dep needed).
// ---------------------------------------------------------------

class OggBuilder {
	private pages: Uint8Array[] = [];
	private seqNo = 0;
	constructor(private serial: number) {}

	appendPage(
		packets: Uint8Array[],
		granulePos: bigint,
		bos: boolean,
		eos: boolean,
	) {
		const segments = this.buildSegmentTable(packets);
		if (segments.length > MAX_SEGMENTS) {
			throw new Error(
				`Ogg page would have ${segments.length} segments (>${MAX_SEGMENTS}); packet too large`,
			);
		}
		const totalPayload = segments.reduce((a, b) => a + b, 0);
		const headerSize = HEADER_BYTES + segments.length;
		const page = new Uint8Array(headerSize + totalPayload);
		const dv = new DataView(page.buffer);
		page[0] = 0x4f;
		page[1] = 0x67;
		page[2] = 0x67;
		page[3] = 0x53;
		page[4] = 0;
		let headerType = 0;
		if (bos) headerType |= 0x02;
		if (eos) headerType |= 0x04;
		page[5] = headerType;
		dv.setBigInt64(6, granulePos & 0xffffffffffffffffn, true);
		dv.setUint32(14, this.serial, true);
		dv.setUint32(18, this.seqNo++, true);
		dv.setUint32(22, 0, true);
		page[26] = segments.length;
		for (let i = 0; i < segments.length; i++) page[HEADER_BYTES + i] = segments[i];
		let off = headerSize;
		for (const pkt of packets) {
			page.set(pkt, off);
			off += pkt.length;
		}
		dv.setUint32(22, oggCrc32(page), true);
		this.pages.push(page);
	}

	toBlob(): Blob {
		let total = 0;
		for (const p of this.pages) total += p.length;
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of this.pages) {
			out.set(p, off);
			off += p.length;
		}
		return new Blob([out as unknown as BlobPart], {
			type: 'audio/ogg; codecs=vorbis',
		});
	}

	private buildSegmentTable(packets: Uint8Array[]): number[] {
		const segs: number[] = [];
		for (const pkt of packets) {
			const full = Math.floor(pkt.length / SEGMENT_SIZE);
			for (let i = 0; i < full; i++) segs.push(SEGMENT_SIZE);
			segs.push(pkt.length % SEGMENT_SIZE);
		}
		return segs;
	}
}
