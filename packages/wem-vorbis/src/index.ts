/**
 * `@tootallnate/wem-vorbis` — decode Wwise Vorbis (codec id 0xFFFF)
 * WEMs into standard Ogg-Vorbis Blobs that browsers can play.
 *
 * TypeScript port of hcs64's [ww2ogg](https://github.com/hcs64/ww2ogg)
 * (BSD-3-Clause), narrowed to the **Wwise V62** format used by all
 * Switch-era titles (2018+) — Pokémon Legends Arceus, Hollow Knight,
 * NieR, Bayonetta 3, etc. Older Wwise versions (V34 / V44 / V48 /
 * V52 / V53 / V56) are out of scope; throw a clear error.
 *
 * Switch-era V62 is identified by:
 *   - WEM `fmt ` chunk size = 0x42 (66 bytes)
 *   - fmt's `extra_size` field = 0x30 (48 bytes after the 18-byte
 *     WAVEFORMATEX prefix)
 *   - No standalone "vorb" chunk (vorb data is faked at fmt+0x18)
 *
 * Public API:
 *
 *   ```ts
 *   import { wemVorbisToOggVorbis, codebookLibraryFromBytes } from '@tootallnate/wem-vorbis';
 *
 *   const codebookBytes = await fetch('/assets/packed_codebooks_aoTuV_603.bin')
 *     .then(r => r.arrayBuffer())
 *     .then(b => new Uint8Array(b));
 *   const lib = codebookLibraryFromBytes(codebookBytes);
 *
 *   const oggBlob = await wemVorbisToOggVorbis(parsedWem, lib);
 *   audioElement.src = URL.createObjectURL(oggBlob);
 *   ```
 *
 * The codebook library file (`packed_codebooks_aoTuV_603.bin`) is
 * shipped in `node_modules/@tootallnate/wem-vorbis/assets/` for
 * convenience but must be loaded by the consumer (browser bundler
 * / `fetch` / `import.meta.resolve`); the package itself doesn't
 * embed it.
 */

export { CodebookLibrary } from './codebook.js';
export { OggBuilder } from './ogg.js';
export { BitReader, BitWriter, ilog } from './bit-stream.js';

import { BitReader, BitWriter } from './bit-stream.js';
import { CodebookLibrary } from './codebook.js';
import { OggBuilder } from './ogg.js';
import {
	buildAllHeaders,
	type VorbisRebuildConfig,
	type RebuiltHeaders,
} from './setup.js';

/** Construct a `CodebookLibrary` from raw bytes (e.g. fetched at runtime). */
export function codebookLibraryFromBytes(bytes: Uint8Array): CodebookLibrary {
	return new CodebookLibrary(bytes);
}

/**
 * Per-WEM Vorbis configuration extracted from the input. We only
 * support the Wwise V62 layout — anything else throws.
 */
export interface ParsedWemVorbis {
	channels: number;
	sampleRate: number;
	avgBytesPerSec: number;
	blocksize0Pow: number;
	blocksize1Pow: number;
	loopCount: number;
	loopStart: number;
	loopEnd: number;
	/** Compact setup packet payload (no header, no Wwise framing). */
	setupPacket: Uint8Array;
	/** Concatenated audio packet stream (each prefixed with a 2-byte LE size, no granule). */
	audioPackets: Uint8Array;
	/** Whether mod_packets is on (per-packet window-type rebuild needed for Vorbis). */
	modPackets: boolean;
	/** Sample count for the EOS granule. */
	sampleCount: number;
}

/**
 * Parse the Vorbis-specific bits of a WEM file. The caller is
 * expected to have already extracted the `fmt ` chunk payload, the
 * `data` chunk bytes, and identified the WEM as codec 0xFFFF.
 *
 * `dataChunk` is the raw payload of the WEM's RIFF "data" chunk
 * (everything after the `data`/size prelude).
 *
 * Throws if the WEM isn't V62.
 */
export function parseWemVorbisV62(
	fmtPayload: Uint8Array,
	dataChunk: Uint8Array,
): ParsedWemVorbis {
	if (fmtPayload.length !== 0x42) {
		throw new Error(
			`Wwise Vorbis: only V62 (fmt size 0x42) supported, got 0x${fmtPayload.length.toString(16)}`,
		);
	}
	const dv = new DataView(fmtPayload.buffer, fmtPayload.byteOffset, fmtPayload.byteLength);
	const codecId = dv.getUint16(0, true);
	if (codecId !== 0xffff) throw new Error(`not a Vorbis WEM (codec 0x${codecId.toString(16)})`);
	const channels = dv.getUint16(2, true);
	const sampleRate = dv.getUint32(4, true);
	const avgBytesPerSec = dv.getUint32(8, true);
	const blockAlign = dv.getUint16(12, true);
	const bps = dv.getUint16(14, true);
	const extraSize = dv.getUint16(16, true);
	if (blockAlign !== 0 || bps !== 0) {
		throw new Error('Wwise Vorbis: expected block_align=0, bps=0');
	}
	if (extraSize !== 0x30) {
		throw new Error(
			`Wwise Vorbis: expected extra_size 0x30 (V62), got 0x${extraSize.toString(16)}`,
		);
	}

	// "vorb" data is faked at fmt+0x18 — relative byte offsets within fmtPayload below.
	const VORB = 0x18;
	const sampleCount = dv.getUint32(VORB + 0x00, true);
	// mod_signal at vorb+0x04 — see ww2ogg wwriff.cpp:351-371.
	const modSignal = dv.getUint32(VORB + 0x04, true);
	const modPackets =
		modSignal !== 0x4a &&
		modSignal !== 0x4b &&
		modSignal !== 0x69 &&
		modSignal !== 0x70;
	const setupPacketOffset = dv.getUint32(VORB + 0x10, true);
	const firstAudioPacketOffset = dv.getUint32(VORB + 0x14, true);
	// uid at vorb+0x24 (we don't use it)
	const blocksize0Pow = fmtPayload[VORB + 0x28];
	const blocksize1Pow = fmtPayload[VORB + 0x29];

	if (setupPacketOffset >= dataChunk.length || firstAudioPacketOffset > dataChunk.length) {
		throw new Error('Wwise Vorbis: setup/audio offsets out of range');
	}

	// Read the setup packet — same 2-byte (no_granule) header as audio.
	const setupHeaderSize = 2; // _no_granule = true
	const setupSize = new DataView(
		dataChunk.buffer,
		dataChunk.byteOffset + setupPacketOffset,
		2,
	).getUint16(0, true);
	const setupPayloadStart = setupPacketOffset + setupHeaderSize;
	const setupPacket = dataChunk.subarray(setupPayloadStart, setupPayloadStart + setupSize);
	if (setupPayloadStart + setupSize > dataChunk.length) {
		throw new Error('Wwise Vorbis: setup packet truncated');
	}
	if (setupPayloadStart + setupSize !== firstAudioPacketOffset) {
		throw new Error(
			`Wwise Vorbis: first audio packet doesn't follow setup (setup ends at ${setupPayloadStart + setupSize}, first audio at ${firstAudioPacketOffset})`,
		);
	}

	const audioPackets = dataChunk.subarray(firstAudioPacketOffset);

	return {
		channels,
		sampleRate,
		avgBytesPerSec,
		blocksize0Pow,
		blocksize1Pow,
		loopCount: 0,
		loopStart: 0,
		loopEnd: 0,
		setupPacket,
		audioPackets,
		modPackets,
		sampleCount,
	};
}

/**
 * Top-level: turn a parsed Wwise V62 Vorbis WEM into a standard
 * Ogg-Vorbis Blob.
 *
 * The flow is:
 *   1. Rebuild the three Vorbis header packets from the WEM's
 *      compact setup, using `cbLibrary` to look up codebooks.
 *   2. Walk the audio packets one at a time, fixing the first byte
 *      to encode (packet_type=0, mode_number, prev_window_type,
 *      next_window_type, …) — Wwise strips these bits, so we have
 *      to reconstruct them by peeking at the next packet's mode.
 *   3. Wrap each rebuilt packet in an Ogg page with proper granule
 *      and CRC. Final page gets EOS + total-sample granule.
 */
export async function wemVorbisToOggVorbis(
	parsed: ParsedWemVorbis,
	cbLibrary: CodebookLibrary,
): Promise<Blob> {
	const cfg: VorbisRebuildConfig = {
		channels: parsed.channels,
		sampleRate: parsed.sampleRate,
		avgBytesPerSec: parsed.avgBytesPerSec,
		blocksize0Pow: parsed.blocksize0Pow,
		blocksize1Pow: parsed.blocksize1Pow,
		loopCount: parsed.loopCount,
		loopStart: parsed.loopStart,
		loopEnd: parsed.loopEnd,
		setupPacket: parsed.setupPacket,
		codebooks: cbLibrary,
		inlineCodebooks: false,
	};

	const headers: RebuiltHeaders = buildAllHeaders(cfg);

	const serial = (Math.random() * 0xffffffff) >>> 0;
	const ogg = new OggBuilder(serial);
	// Header packets: each on its own page with granule = 0.
	ogg.appendPage([headers.identification], 0n, /* bos */ true, /* eos */ false);
	ogg.appendPage([headers.comment], 0n, false, false);
	ogg.appendPage([headers.setup], 0n, false, false);

	// Walk audio packets. Each packet has a 2-byte LE size prefix
	// and no granule (V62, _no_granule=true).
	const audio = parsed.audioPackets;
	const blocksize0 = 1 << parsed.blocksize0Pow;
	const blocksize1 = 1 << parsed.blocksize1Pow;
	const HEADER_SIZE = 2;

	// Pre-scan: collect each packet's (offset, size, modeNumber) so we
	// can look ahead for next-window-type without re-reading bits.
	interface PacketInfo {
		offset: number; // offset into `audio`
		size: number;
		payloadOffset: number; // offset of the actual Vorbis bits
	}
	const packets: PacketInfo[] = [];
	{
		let off = 0;
		while (off + HEADER_SIZE <= audio.length) {
			const size = new DataView(audio.buffer, audio.byteOffset + off, 2).getUint16(0, true);
			const payloadOffset = off + HEADER_SIZE;
			if (payloadOffset + size > audio.length) {
				// Truncated final packet — break.
				break;
			}
			if (size > 0) packets.push({ offset: off, size, payloadOffset });
			off = payloadOffset + size;
		}
	}
	if (packets.length === 0) throw new Error('no Vorbis audio packets found');

	// Helper: read the mode_number of a packet (first `modeBits` bits).
	const readModeNumber = (pkt: PacketInfo): number => {
		const br = new BitReader(audio, pkt.payloadOffset);
		return br.readUint(headers.modeBits);
	};

	// Compute per-packet sample positions for granule. Each packet
	// produces (blocksize_prev/4 + blocksize_curr/4) PCM samples,
	// where the block-flag of each packet selects the window size.
	// First packet contributes only blocksize_curr/4 (no prev).
	const granules: number[] = new Array(packets.length);
	let cumulativeSamples = 0;
	let prevBlockSize = 0;
	for (let i = 0; i < packets.length; i++) {
		const modeNumber = readModeNumber(packets[i]);
		const blockFlag = headers.modeBlockflag[modeNumber];
		const currBlockSize = blockFlag ? blocksize1 : blocksize0;
		if (i === 0) {
			cumulativeSamples += currBlockSize / 4;
		} else {
			cumulativeSamples += prevBlockSize / 4 + currBlockSize / 4;
		}
		granules[i] = cumulativeSamples;
		prevBlockSize = currBlockSize;
	}

	// Rebuild and emit each audio packet.
	let prevBlockflag = false;
	for (let i = 0; i < packets.length; i++) {
		const pkt = packets[i];
		const pktBytes = audio.subarray(pkt.payloadOffset, pkt.payloadOffset + pkt.size);
		const bw = new BitWriter(pkt.size + 8);

		if (parsed.modPackets) {
			// Restore the stripped bits at the head of the packet.
			// OUT: 1-bit packet_type (0 = audio).
			bw.writeBit(0);
			// IN/OUT: modeBits-bit mode_number.
			const br = new BitReader(audio, pkt.payloadOffset);
			const modeNumber = br.readUint(headers.modeBits);
			bw.writeUint(modeNumber, headers.modeBits);
			// IN: remaining (8 - modeBits) bits of the first byte.
			const remainder = br.readUint(8 - headers.modeBits);

			if (headers.modeBlockflag[modeNumber]) {
				// Long window — peek next packet's mode for next_window_type.
				let nextBlockflag = false;
				if (i + 1 < packets.length) {
					const nextMode = readModeNumber(packets[i + 1]);
					nextBlockflag = headers.modeBlockflag[nextMode];
				}
				bw.writeBit(prevBlockflag ? 1 : 0);
				bw.writeBit(nextBlockflag ? 1 : 0);
			}
			prevBlockflag = headers.modeBlockflag[modeNumber];
			bw.writeUint(remainder, 8 - headers.modeBits);

			// Then copy the rest of the packet bytes verbatim.
			for (let b = 1; b < pkt.size; b++) {
				bw.writeUint(pktBytes[b], 8);
			}
		} else {
			// No mod_packets: copy the packet bytes verbatim, byte-aligned.
			for (let b = 0; b < pkt.size; b++) {
				bw.writeUint(pktBytes[b], 8);
			}
		}

		bw.flushByte();
		const isLast = i === packets.length - 1;
		const granule = isLast ? BigInt(parsed.sampleCount) : BigInt(granules[i]);
		ogg.appendPage([bw.toUint8Array().slice()], granule, false, isLast);
	}

	return ogg.toBlob();
}
