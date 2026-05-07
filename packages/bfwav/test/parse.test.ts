import { describe, it, expect } from 'vitest';
import { isBfwav, parseBfwav, decodeBfwavToPcm16, BFWAV_MAGIC, BfwavCodec } from '../src/index.js';

/**
 * Hand-built minimal BFWAV (DSP-ADPCM) for the parser. We keep the
 * sample data tiny — a single 14-sample frame per channel — to
 * avoid recreating a full DSP encoder in the test. The decoder
 * tests in `@tootallnate/dsp-adpcm` already prove the codec; here
 * we just verify the parser's offsets, channel walk, and end-to-end
 * dispatch all line up.
 */
function buildMinimalBfwav(numChannels = 1, codec = BfwavCodec.DspAdpcm) {
	const HEADER_SIZE = 0x40;
	const enc = new TextEncoder();
	const numSamples = 14;
	// Per-channel info struct: 0x10 bytes ref to sample data + 0x10
	// bytes ref to DSP info (when DSP). Layout (rel CI):
	//   0x00 u16 0x1F00 / u16 pad / s32 sample_data_offset
	//   0x08 u16 0x0300 / u16 pad / s32 adpcm_info_offset (rel CI)
	//   0x10 u32 reserved
	const CHINFO_SIZE = 0x14;
	const DSP_INFO_SIZE = 0x2e;

	// INFO block:
	//   0x00 'INFO' / u32 size
	//   0x08 codec u8 / loop u8 / pad u16
	//   0x0C sample_rate u32
	//   0x10 loop_start u32
	//   0x14 total_samples u32
	//   0x18 reserved u32
	//   0x1C [u32 channel_count, ref[N] of (typeId 0x7100, pad, s32 offset)]
	//          → each ref's offset is rel to chTableOff (=INFO+0x1C)
	//   then channel-info structs, then DSP info structs.
	const channelTableOff = 0x1c;
	const channelTableEntriesEnd =
		channelTableOff + 0x04 + numChannels * 0x08;
	const ciStart = channelTableEntriesEnd; // first channel info struct
	const dspStart = ciStart + numChannels * CHINFO_SIZE;
	const infoSize = align(dspStart + numChannels * DSP_INFO_SIZE, 4);

	// DATA block:
	//   0x00 'DATA' / u32 size
	//   0x08 sample bytes (per-channel, contiguous)
	const sampleBytesPerChannel = (() => {
		switch (codec) {
			case BfwavCodec.DspAdpcm: return 8;        // 14 samples / 1 frame
			case BfwavCodec.Pcm16:    return 14 * 2;    // 14 × s16
			case BfwavCodec.Pcm8:     return 14;        // 14 × s8
			default:                  return 8;
		}
	})();
	const dataPayload = sampleBytesPerChannel * numChannels;
	const dataSize = align(0x08 + dataPayload, 4);

	const fileSize = HEADER_SIZE + infoSize + dataSize;
	const out = new Uint8Array(fileSize);
	const v = new DataView(out.buffer);

	// Header
	out.set(enc.encode(BFWAV_MAGIC), 0);
	out[4] = 0xff; out[5] = 0xfe; // BOM = LE
	v.setUint16(6, HEADER_SIZE, true);
	v.setUint32(8, 0x00010200, true); // version
	v.setUint32(0x0c, fileSize, true);
	v.setUint16(0x10, 2, true); // num blocks
	// Block table
	const infoOffset = HEADER_SIZE;
	const dataOffset = HEADER_SIZE + infoSize;
	v.setUint16(0x14, 0x7000, true); // INFO id
	v.setInt32(0x18, infoOffset, true);
	v.setUint32(0x1c, infoSize, true);
	v.setUint16(0x20, 0x7001, true); // DATA id
	v.setInt32(0x24, dataOffset, true);
	v.setUint32(0x28, dataSize, true);

	// INFO block
	out.set(enc.encode('INFO'), infoOffset + 0x00);
	v.setUint32(infoOffset + 0x04, infoSize, true);
	v.setUint8(infoOffset + 0x08, codec);
	v.setUint8(infoOffset + 0x09, 0); // loop flag
	v.setUint32(infoOffset + 0x0c, 48000, true); // sample rate
	v.setUint32(infoOffset + 0x10, 0, true); // loop start
	v.setUint32(infoOffset + 0x14, numSamples, true); // total samples
	// Channel table
	v.setUint32(infoOffset + channelTableOff, numChannels, true);
	for (let c = 0; c < numChannels; c++) {
		const refOff = infoOffset + channelTableOff + 0x04 + c * 0x08;
		v.setUint16(refOff + 0, 0x7100, true);
		v.setInt32(refOff + 4, ciStart - channelTableOff + c * CHINFO_SIZE, true);
	}
	// Channel info structs
	for (let c = 0; c < numChannels; c++) {
		const ciAbs = ciStart + c * CHINFO_SIZE; // INFO-relative
		const ciOff = infoOffset + ciAbs;
		// Sample-data ref
		v.setUint16(ciOff + 0x00, 0x1f00, true);
		v.setInt32(ciOff + 0x04, c * sampleBytesPerChannel, true);
		if (codec === BfwavCodec.DspAdpcm) {
			// DSP-ADPCM info ref (relative to ciOff = INFO+ciAbs).
			const dspAbs = dspStart + c * DSP_INFO_SIZE; // INFO-relative
			v.setUint16(ciOff + 0x08, 0x0300, true);
			v.setInt32(ciOff + 0x0c, dspAbs - ciAbs, true);
		} else {
			// No ADPCM info for raw PCM codecs.
			v.setUint16(ciOff + 0x08, 0x0000, true);
			v.setInt32(ciOff + 0x0c, -1, true);
		}
		v.setUint32(ciOff + 0x10, 0, true);
	}
	// DSP info structs (16 zero coefs, then init/loop hist all 0)
	if (codec === BfwavCodec.DspAdpcm) {
		// already zeros
	} else if (codec === BfwavCodec.Pcm16) {
		// For PCM16, write some recognisable samples so we can verify
		// the decoder dispatch.
		const sampleStart = dataOffset + 0x08;
		for (let c = 0; c < numChannels; c++) {
			const dv = new DataView(out.buffer, sampleStart + c * numSamples * 2);
			for (let i = 0; i < numSamples; i++) {
				dv.setInt16(i * 2, (i + 1) * 100 * (c + 1), true);
			}
		}
	}

	// DATA block
	out.set(enc.encode('DATA'), dataOffset + 0x00);
	v.setUint32(dataOffset + 0x04, dataSize, true);
	// (Sample bytes already left as zeros for DSP, or filled above for PCM16.)

	return out;
}

function align(n: number, a: number): number {
	return (n + a - 1) & ~(a - 1);
}

describe('isBfwav', () => {
	it('detects the magic', async () => {
		const buf = buildMinimalBfwav();
		expect(await isBfwav(new Blob([buf as BlobPart]))).toBe(true);
	});
	it('rejects non-BFWAV', async () => {
		expect(await isBfwav(new Blob([new Uint8Array([0x42, 0x41, 0x52, 0x53])]))).toBe(false);
	});
});

describe('parseBfwav', () => {
	it('parses minimal mono DSP-ADPCM', async () => {
		const buf = buildMinimalBfwav(1);
		const parsed = await parseBfwav(new Blob([buf as BlobPart]));
		expect(parsed.codec).toBe(BfwavCodec.DspAdpcm);
		expect(parsed.codecName).toBe('DSP-ADPCM');
		expect(parsed.sampleRate).toBe(48000);
		expect(parsed.totalSamples).toBe(14);
		expect(parsed.channels).toHaveLength(1);
		expect(parsed.channels[0].coefs).not.toBeNull();
		expect(parsed.channels[0].coefs!.length).toBe(16);
	});

	it('parses minimal stereo DSP-ADPCM', async () => {
		const buf = buildMinimalBfwav(2);
		const parsed = await parseBfwav(new Blob([buf as BlobPart]));
		expect(parsed.channels).toHaveLength(2);
		expect(parsed.channels[0].sampleDataOffset).toBe(0);
		expect(parsed.channels[1].sampleDataOffset).toBe(8);
	});

	it('throws on bad magic', async () => {
		await expect(parseBfwav(new Blob([new Uint8Array(0x40)]))).rejects.toThrow(
			/BFWAV magic/,
		);
	});
});

describe('decodeBfwavToPcm16', () => {
	it('decodes a zero-filled DSP-ADPCM stream to all-zero PCM', async () => {
		const buf = buildMinimalBfwav(1);
		const parsed = await parseBfwav(new Blob([buf as BlobPart]));
		const { samples, numChannels, sampleRate } = await decodeBfwavToPcm16(parsed);
		expect(numChannels).toBe(1);
		expect(sampleRate).toBe(48000);
		expect(samples.length).toBe(14);
		expect(Array.from(samples)).toEqual(new Array(14).fill(0));
	});

	it('decodes stereo PCM16 by reading the raw sample bytes', async () => {
		const buf = buildMinimalBfwav(2, BfwavCodec.Pcm16);
		const parsed = await parseBfwav(new Blob([buf as BlobPart]));
		expect(parsed.codec).toBe(BfwavCodec.Pcm16);
		const { samples, numChannels } = await decodeBfwavToPcm16(parsed);
		expect(numChannels).toBe(2);
		// Frame i: [ch0=i*100, ch1=i*200].
		// (Builder writes (i+1)*100*(c+1) so first frame is [100, 200].)
		expect(samples[0]).toBe(100);
		expect(samples[1]).toBe(200);
		expect(samples[2]).toBe(200); // i=1, ch0
		expect(samples[3]).toBe(400); // i=1, ch1
	});
});
