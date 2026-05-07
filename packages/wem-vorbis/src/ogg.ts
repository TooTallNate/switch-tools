/**
 * Ogg-Vorbis page muxer.
 *
 * Same Ogg framing as our Opus muxer (RFC 3533) — `OggS` magic,
 * 27-byte header + segment table + payload, CRC-32 with poly
 * 0x04C11DB7 — but with Vorbis-specific conventions:
 *
 *   - Page 0  (BOS)            : Identification packet (30-byte payload)
 *   - Page 1                   : Comment packet
 *   - Page 2                   : Setup packet
 *   - Page 3..N                : Audio packets, granule_pos = number of
 *                                PCM samples decoded up to and including
 *                                the last packet on this page
 *   - Last audio page (EOS)    : granule_pos = total samples
 *
 * Unlike Opus (which has a fixed 48 kHz internal rate) Vorbis's
 * granule is in source-sample units, computed from per-packet block
 * sizes. We mirror ww2ogg's approach: the caller supplies a
 * monotonic `granule` for each page boundary, and the muxer just
 * stamps it into the page header.
 *
 * Multiple packets per page are allowed and we batch them; ww2ogg
 * by default emits each Wwise packet on its own page (matching the
 * structure of the input WEM, which has packet-aligned granule
 * info), and we follow that convention for simplicity.
 */

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
 * Builder for an Ogg-Vorbis bitstream. Each call to `appendPage`
 * emits a single Ogg page containing the given packet payload(s).
 * Packets that exceed `255 × 255` bytes (a hard Ogg limit per page)
 * must be split — but Vorbis audio packets are always far smaller,
 * and the three header packets fit easily, so we don't bother
 * with cross-page packet continuation here.
 */
export class OggBuilder {
	private pages: Uint8Array[] = [];
	private seqNo = 0;

	constructor(private serial: number) {}

	/**
	 * Append a single page consisting of one or more concatenated
	 * Vorbis packets. `granulePos` is the absolute sample position
	 * after the last *complete* packet on this page (or 0 for the
	 * three header pages).
	 */
	appendPage(
		packets: Uint8Array[],
		granulePos: bigint | number,
		bos: boolean,
		eos: boolean,
		continued = false,
	): void {
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
		// "OggS"
		page[0] = 0x4f;
		page[1] = 0x67;
		page[2] = 0x67;
		page[3] = 0x53;
		page[4] = 0; // stream_structure_version
		let headerType = 0;
		if (continued) headerType |= 0x01;
		if (bos) headerType |= 0x02;
		if (eos) headerType |= 0x04;
		page[5] = headerType;
		// granule_position (s64 LE; 0xFFFFFFFFFFFFFFFF means "no granule").
		const gAsBig = typeof granulePos === 'bigint' ? granulePos : BigInt(granulePos);
		dv.setBigInt64(6, gAsBig, true);
		dv.setUint32(14, this.serial, true);
		dv.setUint32(18, this.seqNo++, true);
		dv.setUint32(22, 0, true); // CRC placeholder
		page[26] = segments.length;
		for (let i = 0; i < segments.length; i++) page[HEADER_BYTES + i] = segments[i];

		// Payload.
		let payloadOff = headerSize;
		for (const pkt of packets) {
			page.set(pkt, payloadOff);
			payloadOff += pkt.length;
		}

		// CRC over the entire page (header + segment_table + payload),
		// with the CRC field zeroed out (already is).
		dv.setUint32(22, oggCrc32(page), true);
		this.pages.push(page);
	}

	toUint8Array(): Uint8Array {
		let total = 0;
		for (const p of this.pages) total += p.length;
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of this.pages) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	}

	toBlob(): Blob {
		return new Blob([this.toUint8Array() as unknown as BlobPart], {
			type: 'audio/ogg; codecs=vorbis',
		});
	}

	private buildSegmentTable(packets: Uint8Array[]): number[] {
		const segs: number[] = [];
		for (const pkt of packets) {
			const full = Math.floor(pkt.length / SEGMENT_SIZE);
			for (let i = 0; i < full; i++) segs.push(SEGMENT_SIZE);
			segs.push(pkt.length % SEGMENT_SIZE); // 0 for exact multiple — terminator segment
		}
		return segs;
	}
}
