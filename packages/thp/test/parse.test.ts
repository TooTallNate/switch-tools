import { describe, expect, it } from 'vitest';

import {
	THP_COMPONENT_SLOTS,
	THP_HEADER_SIZE,
	ThpComponentType,
	ThpVersion,
	decodeThpAudio,
	isThp,
	parseThp,
	parseThpAudioFrame,
	parseThpHeader,
	thpFrameJpeg,
	thpFrameJpegRaw,
	thpRestuffJpeg,
} from '../src/index.js';

/**
 * Synthetic THP builder.
 *
 * Frames are given *deliberately different* sizes so that a walk which
 * advanced by `nextFrameSize` instead of the current frame's size would
 * desynchronise immediately and the tests would catch it.
 */

interface FrameSpec {
	/** JPEG payload; a marker-only stub is fine for container tests. */
	jpeg: Uint8Array;
	/** Extra bytes after the EOI marker, to exercise trimming. */
	jpegPad?: number;
	audio?: {
		sampleCount: number;
		/** Per channel; defaults to a 16-entry ramp offset by channel. */
		coefficients?: Int16Array[];
		history?: { hist1: number; hist2: number }[];
		/** Per-channel ADPCM bytes. Sized automatically when omitted. */
		data?: Uint8Array[];
	};
}

interface BuildSpec {
	version?: number;
	fps?: number;
	width?: number;
	height?: number;
	channelCount?: number;
	sampleRate?: number;
	/** Total sample count written into the header; defaults to the frame sum. */
	declaredSampleCount?: number;
	frames: FrameSpec[];
	/** Truncate the emitted file to this many bytes. */
	truncateTo?: number;
	/** Omit the audio component entirely (video-only file). */
	videoOnly?: boolean;
}

/**
 * A minimal but structurally real JPEG: SOI, DQT, SOS, entropy data, EOI.
 *
 * The SOS segment matters — without it there is no scan for
 * {@link thpFrameJpeg} to re-stuff, and it would (correctly) refuse the frame.
 * `scan` is emitted verbatim so tests can plant raw 0xFF bytes in it.
 */
function jpegStub(scan: number[] = [0x40, 0x41, 0x42, 0x43]): Uint8Array {
	const out: number[] = [
		0xff, 0xd8, // SOI
		0xff, 0xdb, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03, // DQT (short, contents irrelevant)
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
		...scan,
		0xff, 0xd9, // EOI
	];
	return new Uint8Array(out);
}

/** Byte length of `jpegStub`'s fixed header (everything before the scan). */
const STUB_HEADER_LEN = 20;

function align32(n: number): number {
	return (n + 31) & ~31;
}

function buildThp(spec: BuildSpec): Uint8Array {
	const version = spec.version ?? ThpVersion.V1_1;
	const hasExtras = version >= ThpVersion.V1_1;
	const channelCount = spec.channelCount ?? 2;
	const hasAudio = !spec.videoOnly;
	const componentCount = hasAudio ? 2 : 1;
	const frameHeaderSize = 8 + 4 * componentCount;

	// --- component table ---
	const compBytes: number[] = [];
	const pushU32 = (arr: number[], v: number) => {
		arr.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
	};
	pushU32(compBytes, componentCount);
	const tags = new Array(THP_COMPONENT_SLOTS).fill(0xff);
	tags[0] = ThpComponentType.VIDEO;
	if (hasAudio) tags[1] = ThpComponentType.AUDIO;
	compBytes.push(...tags);
	pushU32(compBytes, spec.width ?? 640);
	pushU32(compBytes, spec.height ?? 480);
	if (hasExtras) pushU32(compBytes, 0);
	let totalSamples = 0;
	for (const f of spec.frames) totalSamples += f.audio?.sampleCount ?? 0;
	if (hasAudio) {
		pushU32(compBytes, channelCount);
		pushU32(compBytes, spec.sampleRate ?? 32000);
		pushU32(compBytes, spec.declaredSampleCount ?? totalSamples);
		if (hasExtras) pushU32(compBytes, 0);
	}

	const componentDataOffset = THP_HEADER_SIZE;
	const firstFrameOffset = componentDataOffset + compBytes.length;

	// --- frame payloads ---
	const built = spec.frames.map((f) => {
		const videoBytes = new Uint8Array(f.jpeg.length + (f.jpegPad ?? 0));
		videoBytes.set(f.jpeg, 0);
		for (let i = f.jpeg.length; i < videoBytes.length; i++) videoBytes[i] = 0x00;

		let audioBytes = new Uint8Array(0);
		if (hasAudio && f.audio) {
			const chanSize =
				f.audio.data?.[0]?.length ??
				Math.ceil(f.audio.sampleCount / 14) * 8;
			const state = channelCount * 16 * 2 + channelCount * 4;
			audioBytes = new Uint8Array(8 + state + chanSize * channelCount);
			const av = new DataView(audioBytes.buffer);
			av.setUint32(0, chanSize, false);
			av.setUint32(4, f.audio.sampleCount, false);
			// Coefficients for every channel first, contiguously...
			for (let c = 0; c < channelCount; c++) {
				const table =
					f.audio.coefficients?.[c] ??
					Int16Array.from({ length: 16 }, (_, k) => c * 100 + k);
				for (let k = 0; k < 16; k++) {
					av.setInt16(8 + (c * 16 + k) * 2, table[k], false);
				}
			}
			// ...then all the history values.
			const histBase = 8 + channelCount * 16 * 2;
			for (let c = 0; c < channelCount; c++) {
				const h = f.audio.history?.[c] ?? { hist1: 0, hist2: 0 };
				av.setInt16(histBase + c * 4, h.hist1, false);
				av.setInt16(histBase + c * 4 + 2, h.hist2, false);
			}
			const dataBase = histBase + channelCount * 4;
			for (let c = 0; c < channelCount; c++) {
				const src = f.audio.data?.[c];
				if (src) audioBytes.set(src.subarray(0, chanSize), dataBase + c * chanSize);
			}
		}
		const parts = frameHeaderSize + videoBytes.length + audioBytes.length;
		return { videoBytes, audioBytes, size: align32(parts) };
	});

	const dataSize = built.reduce((a, f) => a + f.size, 0);
	const totalLen = firstFrameOffset + dataSize;
	const out = new Uint8Array(totalLen);
	const view = new DataView(out.buffer);

	// --- file header ---
	out.set([0x54, 0x48, 0x50, 0x00], 0);
	view.setUint32(0x04, version, false);
	view.setUint32(0x08, Math.max(...built.map((f) => f.videoBytes.length + f.audioBytes.length), 0), false);
	view.setUint32(0x0c, Math.max(...spec.frames.map((f) => f.audio?.sampleCount ?? 0), 0), false);
	view.setFloat32(0x10, spec.fps ?? 29.97, false);
	view.setUint32(0x14, spec.frames.length, false);
	view.setUint32(0x18, built[0]?.size ?? 0, false);
	view.setUint32(0x1c, dataSize, false);
	view.setUint32(0x20, componentDataOffset, false);
	view.setUint32(0x24, 0, false);
	view.setUint32(0x28, firstFrameOffset, false);
	let lastOff = firstFrameOffset;
	for (let i = 0; i < built.length - 1; i++) lastOff += built[i].size;
	view.setUint32(0x2c, lastOff, false);
	out.set(new Uint8Array(compBytes), componentDataOffset);

	// --- frames ---
	let at = firstFrameOffset;
	built.forEach((f, i) => {
		view.setUint32(at, built[i + 1]?.size ?? 0, false); // nextFrameSize
		view.setUint32(at + 4, built[i - 1]?.size ?? 0, false); // previousFrameSize
		view.setUint32(at + 8, f.videoBytes.length, false);
		if (hasAudio) view.setUint32(at + 12, f.audioBytes.length, false);
		out.set(f.videoBytes, at + frameHeaderSize);
		if (f.audioBytes.length) {
			out.set(f.audioBytes, at + frameHeaderSize + f.videoBytes.length);
		}
		at += f.size;
	});

	return spec.truncateTo === undefined
		? out
		: out.subarray(0, Math.min(out.length, spec.truncateTo));
}

/** Three frames of visibly different sizes. */
function threeFrames(): BuildSpec {
	return {
		frames: [
			{ jpeg: jpegStub(), audio: { sampleCount: 14 } },
			{ jpeg: jpegStub(new Array(200).fill(0x5a)), audio: { sampleCount: 28 } },
			{ jpeg: jpegStub(new Array(60).fill(0x33)), audio: { sampleCount: 14 } },
		],
	};
}

describe('isThp', () => {
	it('accepts the magic and rejects others', () => {
		expect(isThp(buildThp(threeFrames()))).toBe(true);
		const rarc = new Uint8Array(THP_HEADER_SIZE);
		rarc.set([0x52, 0x41, 0x52, 0x43], 0);
		expect(isThp(rarc)).toBe(false);
		// 'THP' without the NUL is not the magic.
		const near = new Uint8Array(THP_HEADER_SIZE);
		near.set([0x54, 0x48, 0x50, 0x20], 0);
		expect(isThp(near)).toBe(false);
		expect(isThp(new Uint8Array(8))).toBe(false);
		expect(isThp(buildThp(threeFrames()), -1)).toBe(false);
	});
});

describe('parseThpHeader', () => {
	it('reads the header and both component descriptors', () => {
		const h = parseThpHeader(buildThp(threeFrames()))!;
		expect(h).not.toBeNull();
		expect(h.versionName).toBe('1.1');
		expect(h.frameCount).toBe(3);
		expect(h.fps).toBeCloseTo(29.97, 2);
		expect(h.video).toEqual({ width: 640, height: 480, videoType: 0 });
		expect(h.audio?.channelCount).toBe(2);
		expect(h.audio?.sampleRate).toBe(32000);
		expect(h.audio?.sampleCount).toBe(56);
		expect(h.durationSeconds).toBeCloseTo(3 / 29.97, 4);
	});

	it('sizes the frame header as 8 + 4 per component', () => {
		expect(parseThpHeader(buildThp(threeFrames()))!.frameHeaderSize).toBe(16);
		const videoOnly = buildThp({ ...threeFrames(), videoOnly: true });
		const h = parseThpHeader(videoOnly)!;
		expect(h.audio).toBeNull();
		expect(h.frameHeaderSize).toBe(12);
	});

	it('honours the narrower 1.0 descriptors', () => {
		// 1.0 omits videoType and numData, so the audio descriptor starts four
		// bytes earlier. Reading 1.1 widths against a 1.0 file shifts the audio
		// fields and is the classic way to get a nonsense sample rate.
		const h = parseThpHeader(
			buildThp({ ...threeFrames(), version: ThpVersion.V1_0 }),
		)!;
		expect(h.versionName).toBe('1.0');
		expect(h.video).toEqual({ width: 640, height: 480, videoType: 0 });
		expect(h.audio?.channelCount).toBe(2);
		expect(h.audio?.sampleRate).toBe(32000);
	});

	it('skips the full 16-slot component tag array', () => {
		// The tag array is a fixed 16 bytes even with 2 components. If it were
		// read as `componentCount` bytes the width would be misread as a tag.
		const h = parseThpHeader(buildThp(threeFrames()))!;
		expect(h.video!.width).toBe(640);
		expect(h.componentTypes).toEqual([
			ThpComponentType.VIDEO,
			ThpComponentType.AUDIO,
		]);
	});

	it('rejects malformed headers', () => {
		expect(parseThpHeader(new Uint8Array(0x60))).toBeNull();
		// Unknown version.
		const badVer = buildThp(threeFrames());
		new DataView(badVer.buffer).setUint32(0x04, 0x00020000, false);
		expect(parseThpHeader(badVer)).toBeNull();
		// Zero frames.
		const noFrames = buildThp(threeFrames());
		new DataView(noFrames.buffer).setUint32(0x14, 0, false);
		expect(parseThpHeader(noFrames)).toBeNull();
		// Absurd fps.
		const badFps = buildThp(threeFrames());
		new DataView(badFps.buffer).setFloat32(0x10, 0, false);
		expect(parseThpHeader(badFps)).toBeNull();
		// Component table pointing past the end.
		const badComp = buildThp(threeFrames());
		new DataView(badComp.buffer).setUint32(0x20, 0xfffff0, false);
		expect(parseThpHeader(badComp)).toBeNull();
		// Component count of zero.
		const zeroComp = buildThp(threeFrames());
		new DataView(zeroComp.buffer).setUint32(THP_HEADER_SIZE, 0, false);
		expect(parseThpHeader(zeroComp)).toBeNull();
	});

	it('rejects a file with no video component', () => {
		const noVideo = buildThp(threeFrames());
		// Turn the video tag into an unknown component.
		noVideo[THP_HEADER_SIZE + 4] = 0x7f;
		expect(parseThpHeader(noVideo)).toBeNull();
	});
});

describe('parseThp — frame walk', () => {
	it('advances by the current frame size, not nextFrameSize', () => {
		// The three frames have distinct sizes on purpose: walking by
		// `nextFrameSize` would land at the wrong offsets from frame 1 onward.
		const bytes = buildThp(threeFrames());
		const f = parseThp(bytes)!;
		expect(f.frames).toHaveLength(3);

		let expected = f.header.firstFrameOffset;
		for (const fr of f.frames) {
			expect(fr.offset).toBe(expected);
			expected += fr.size;
		}
		// And the last offset must agree with the header's own claim.
		expect(f.frames[2].offset).toBe(f.header.lastFrameOffset);
		// Sizes really are distinct, so the test above is discriminating.
		expect(new Set(f.frames.map((x) => x.size)).size).toBe(3);
	});

	it('keeps the size chain and padding self-consistent', () => {
		const f = parseThp(buildThp(threeFrames()))!;
		const total = f.frames.reduce((a, x) => a + x.size, 0);
		expect(total).toBe(f.header.dataSize);
		for (const fr of f.frames) {
			const parts = f.header.frameHeaderSize + fr.videoSize + fr.audioSize;
			expect(fr.size).toBe((parts + 31) & ~31);
			if (fr.index > 0) {
				expect(fr.previousSize).toBe(f.frames[fr.index - 1].size);
			}
		}
		expect(f.frames[2].nextSize).toBe(0);
	});

	it('places payload offsets after the frame header, video before audio', () => {
		const f = parseThp(buildThp(threeFrames()))!;
		for (const fr of f.frames) {
			expect(fr.videoOffset).toBe(fr.offset + f.header.frameHeaderSize);
			expect(fr.audioOffset).toBe(fr.videoOffset + fr.videoSize);
		}
	});

	it('reports no audio payload for a video-only file', () => {
		const f = parseThp(buildThp({ ...threeFrames(), videoOnly: true }))!;
		for (const fr of f.frames) {
			expect(fr.audioOffset).toBe(-1);
			expect(fr.audioSize).toBe(0);
			expect(fr.videoOffset).toBe(fr.offset + 12);
		}
	});

	it('stops early on a truncated file instead of throwing', () => {
		const full = buildThp(threeFrames());
		const f = parseThp(full.slice(0, full.length - 40))!;
		expect(f).not.toBeNull();
		expect(f.frames.length).toBeLessThan(3);
		expect(f.frames.length).toBeGreaterThan(0);
	});
});

describe('thpFrameJpeg', () => {
	it('byte-stuffs every 0xFF in the entropy data', () => {
		// THP omits stuffing, which is the single reason browsers refuse these
		// frames. Each raw 0xFF must come back as FF 00.
		const bytes = buildThp({
			frames: [{ jpeg: jpegStub([0x11, 0xff, 0x22, 0xff, 0x33]), audio: { sampleCount: 14 } }],
		});
		const f = parseThp(bytes)!;
		const jpeg = thpFrameJpeg(bytes, f.frames[0])!;
		expect(jpeg).not.toBeNull();
		const scan = [...jpeg.subarray(STUB_HEADER_LEN)];
		expect(scan).toEqual([0x11, 0xff, 0x00, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9]);
	});

	it('copies the header segments through untouched', () => {
		const bytes = buildThp({ frames: [{ jpeg: jpegStub(), audio: { sampleCount: 14 } }] });
		const f = parseThp(bytes)!;
		const jpeg = thpFrameJpeg(bytes, f.frames[0])!;
		expect([...jpeg.subarray(0, STUB_HEADER_LEN)]).toEqual([
			...jpegStub().subarray(0, STUB_HEADER_LEN),
		]);
	});

	it('stuffs FFD0-FFD7 rather than treating them as restart markers', () => {
		// The frames declare no DRI, so a byte pair that looks like a restart
		// marker is really just compressed data and must be stuffed like any
		// other 0xFF. Preserving it as a marker corrupts the scan.
		const bytes = buildThp({
			frames: [{ jpeg: jpegStub([0xff, 0xd0, 0xff, 0xd7]), audio: { sampleCount: 14 } }],
		});
		const f = parseThp(bytes)!;
		const scan = [...thpFrameJpeg(bytes, f.frames[0])!.subarray(STUB_HEADER_LEN)];
		expect(scan).toEqual([0xff, 0x00, 0xd0, 0xff, 0x00, 0xd7, 0xff, 0xd9]);
	});

	it('emits exactly one trailing EOI even when the payload is padded', () => {
		const bytes = buildThp({
			frames: [{ jpeg: jpegStub([0x01, 0x02]), jpegPad: 3, audio: { sampleCount: 14 } }],
		});
		const f = parseThp(bytes)!;
		const jpeg = thpFrameJpeg(bytes, f.frames[0])!;
		expect(jpeg[jpeg.length - 2]).toBe(0xff);
		expect(jpeg[jpeg.length - 1]).toBe(0xd9);
		// The 3 padding bytes after the source EOI must not survive.
		expect(jpeg[jpeg.length - 3]).toBe(0x02);
		// And there is only one EOI in the output.
		let count = 0;
		for (let i = 0; i < jpeg.length - 1; i++) {
			if (jpeg[i] === 0xff && jpeg[i + 1] === 0xd9) count++;
		}
		expect(count).toBe(1);
	});

	it('returns the untouched payload from thpFrameJpegRaw', () => {
		const bytes = buildThp({
			frames: [{ jpeg: jpegStub([0xff, 0x22]), audio: { sampleCount: 14 } }],
		});
		const f = parseThp(bytes)!;
		const raw = thpFrameJpegRaw(bytes, f.frames[0])!;
		expect(raw).toHaveLength(f.frames[0].videoSize);
		// Still unstuffed, i.e. genuinely raw.
		expect([...raw.subarray(STUB_HEADER_LEN, STUB_HEADER_LEN + 2)]).toEqual([0xff, 0x22]);
	});

	it('refuses a payload with no SOS segment', () => {
		// Without a scan there is nothing to stuff and no way to know where the
		// entropy data begins, so this must fail loudly rather than emit junk.
		const noSos = new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
		const bytes = buildThp({ frames: [{ jpeg: noSos, audio: { sampleCount: 14 } }] });
		const f = parseThp(bytes)!;
		expect(thpFrameJpeg(bytes, f.frames[0])).toBeNull();
	});

	it('returns null when the frame has no video', () => {
		const bytes = buildThp(threeFrames());
		const f = parseThp(bytes)!;
		expect(thpFrameJpeg(bytes, { ...f.frames[0], videoOffset: -1 })).toBeNull();
		expect(thpFrameJpegRaw(bytes, { ...f.frames[0], videoOffset: -1 })).toBeNull();
	});
});

describe('parseThpAudioFrame', () => {
	it('reads all coefficients contiguously, then all history values', () => {
		// The trap: reading per-channel [coefs, history] pairs instead. That
		// misreading returns channel 1's first two coefficients as channel 0's
		// history, so we make those values distinctive and assert they don't
		// leak into `history`.
		const coefficients = [
			Int16Array.from({ length: 16 }, (_, k) => 1000 + k),
			Int16Array.from({ length: 16 }, (_, k) => 2000 + k),
		];
		const history = [
			{ hist1: -11, hist2: -22 },
			{ hist1: -33, hist2: -44 },
		];
		const bytes = buildThp({
			frames: [{ jpeg: jpegStub(), audio: { sampleCount: 28, coefficients, history } }],
		});
		const f = parseThp(bytes)!;
		const af = parseThpAudioFrame(bytes, f.frames[0], 2)!;

		expect(af.sampleCount).toBe(28);
		expect(af.channelSize).toBe(16); // ceil(28/14) * 8
		expect([...af.coefficients[0]]).toEqual([...coefficients[0]]);
		expect([...af.coefficients[1]]).toEqual([...coefficients[1]]);
		expect(af.history).toEqual(history);
		// The interleaved misreading would have produced 2000 / 2001 here.
		expect(af.history[0].hist1).not.toBe(2000);
		expect(af.history[0].hist2).not.toBe(2001);
		// Data starts after 8 + 64 + 8 bytes of header for stereo.
		expect(af.dataOffset).toBe(f.frames[0].audioOffset + 8 + 64 + 8);
		expect(af.coefficientsOffset).toBe(f.frames[0].audioOffset + 8);
	});

	it('scales its state block with the channel count', () => {
		const bytes = buildThp({
			channelCount: 1,
			frames: [{ jpeg: jpegStub(), audio: { sampleCount: 14 } }],
		});
		const f = parseThp(bytes)!;
		const af = parseThpAudioFrame(bytes, f.frames[0], 1)!;
		// Mono: 8 + 32 + 4.
		expect(af.dataOffset).toBe(f.frames[0].audioOffset + 8 + 32 + 4);
	});

	it('returns null for a frame with no audio or a truncated one', () => {
		const bytes = buildThp(threeFrames());
		const f = parseThp(bytes)!;
		expect(parseThpAudioFrame(bytes, { ...f.frames[0], audioOffset: -1 }, 2)).toBeNull();
		expect(parseThpAudioFrame(bytes, { ...f.frames[0], audioSize: 4 }, 2)).toBeNull();
		expect(parseThpAudioFrame(bytes, f.frames[0], 0)).toBeNull();
	});
});

describe('decodeThpAudio', () => {
	/**
	 * A DSP-ADPCM frame whose header selects coefficient pair 0 with scale 0.
	 * With a zeroed coefficient table the predictor contributes nothing, so each
	 * output sample is just the sign-extended nibble — which makes the expected
	 * PCM exactly predictable.
	 */
	function flatAdpcmFrame(nibbles: number[]): Uint8Array {
		const out = new Uint8Array(8);
		out[0] = 0x00; // coef index 0, scale 0
		for (let i = 0; i < 14; i += 2) {
			out[1 + i / 2] = ((nibbles[i] & 0x0f) << 4) | (nibbles[i + 1] & 0x0f);
		}
		return out;
	}

	it('decodes to interleaved PCM with the declared length', () => {
		const zero = () => new Int16Array(16);
		const bytes = buildThp({
			frames: [
				{
					jpeg: jpegStub(),
					audio: {
						sampleCount: 14,
						coefficients: [zero(), zero()],
						data: [
							flatAdpcmFrame([1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]),
							flatAdpcmFrame([7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1]),
						],
					},
				},
			],
		});
		const f = parseThp(bytes)!;
		const a = decodeThpAudio(bytes, f)!;
		expect(a.sampleRate).toBe(32000);
		expect(a.channelCount).toBe(2);
		expect(a.sampleCount).toBe(14);
		expect(a.samples).toHaveLength(28);
		// Left channel is the ascending pattern, right the descending one —
		// which also proves the channels weren't swapped or concatenated.
		expect(a.samples[0]).toBe(1);
		expect(a.samples[1]).toBe(7);
		expect(a.samples[2]).toBe(2);
		expect(a.samples[3]).toBe(6);
	});

	it('caps at the declared total rather than the frame padding', () => {
		// Two frames of 14 samples each, but the header claims only 20.
		const bytes = buildThp({
			declaredSampleCount: 20,
			frames: [
				{ jpeg: jpegStub(), audio: { sampleCount: 14 } },
				{ jpeg: jpegStub(new Array(8).fill(0x11)), audio: { sampleCount: 14 } },
			],
		});
		const a = decodeThpAudio(bytes, parseThp(bytes)!)!;
		expect(a.sampleCount).toBe(20);
		expect(a.samples).toHaveLength(40);
	});

	it('returns a divisible-by-channels sample buffer', () => {
		// The invariant `encodeWav` enforces.
		const bytes = buildThp(threeFrames());
		const a = decodeThpAudio(bytes, parseThp(bytes)!)!;
		expect(a.samples.length % a.channelCount).toBe(0);
		expect(a.samples.length).toBe(a.sampleCount * a.channelCount);
	});

	it('returns null for a video-only file', () => {
		const bytes = buildThp({ ...threeFrames(), videoOnly: true });
		expect(decodeThpAudio(bytes, parseThp(bytes)!)).toBeNull();
	});
});


describe('thpRestuffJpeg', () => {
	/**
	 * A minimal but structurally valid JPEG whose scan carries bare `0xFF`
	 * bytes, as THP's encoder emits them.
	 */
	function jpegWithBareFF(scan: number[]): Uint8Array {
		return new Uint8Array([
			0xff, 0xd8, // SOI
			0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00, 0x3f, 0x00, // SOS
			...scan,
			0xff, 0xd9, // EOI
		]);
	}

	it('inserts a zero after every 0xFF in the entropy data', () => {
		const out = thpRestuffJpeg(jpegWithBareFF([0x01, 0xff, 0x02]))!;
		expect(out).not.toBeNull();
		expect([...out]).toEqual([
			0xff, 0xd8,
			0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00, 0x3f, 0x00,
			0x01, 0xff, 0x00, 0x02,
			0xff, 0xd9,
		]);
	});

	it('stuffs bytes that merely look like restart markers', () => {
		// The frames declare no DRI, so FFD0-FFD7 is compressed data, not a
		// marker, and preserving it would desynchronise the decoder.
		const out = thpRestuffJpeg(jpegWithBareFF([0xff, 0xd0, 0x07]))!;
		expect([...out].slice(12)).toEqual([0xff, 0x00, 0xd0, 0x07, 0xff, 0xd9]);
	});

	it('leaves already-stuffed data unchanged', () => {
		const out = thpRestuffJpeg(jpegWithBareFF([0xff, 0x00, 0x09]))!;
		// The existing 0x00 is data; the 0xFF preceding it still gets its own.
		expect([...out].slice(12)).toEqual([0xff, 0x00, 0x00, 0x09, 0xff, 0xd9]);
	});

	it('terminates with exactly one EOI', () => {
		const out = thpRestuffJpeg(jpegWithBareFF([0x01, 0x02]))!;
		expect(out[out.length - 2]).toBe(0xff);
		expect(out[out.length - 1]).toBe(0xd9);
		// No other EOI survives inside the output.
		let eois = 0;
		for (let i = 12; i < out.length - 1; i++) {
			if (out[i] === 0xff && out[i + 1] === 0xd9) eois++;
		}
		expect(eois).toBe(1);
	});

	it('returns null when there is no scan to walk', () => {
		expect(thpRestuffJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
	});
});
