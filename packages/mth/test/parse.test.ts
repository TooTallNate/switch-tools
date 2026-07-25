import { describe, expect, it } from 'vitest';

import {
	MTH_FRAME_ALIGNMENT,
	mthFrameTicks,
	MTH_HEADER_SIZE,
	isMth,
	mthFrameJpeg,
	mthFrameJpegRaw,
	parseMth,
	parseMthHeader,
} from '../src/index.js';

interface FrameSpec {
	/** Payload bytes, before alignment padding is added. */
	payload: number[];
}

interface FileSpec {
	width?: number;
	height?: number;
	frameRate?: number;
	/** Declared count, when it should disagree with the frames supplied. */
	declaredCount?: number;
	frames?: FrameSpec[];
	audioOffset?: number;
	audioSize?: number;
	channels?: [number, number, number, number];
	videoOffset?: number;
	/** Truncate the finished buffer to this length. */
	truncateTo?: number;
}

/** A minimal JPEG whose scan holds the bytes given. */
function jpeg(scan: number[]): number[] {
	return [
		0xff, 0xd8, // SOI
		0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00, 0x3f, 0x00, // SOS
		...scan,
		0xff, 0xd9, // EOI
	];
}

const align = (n: number) =>
	(n + MTH_FRAME_ALIGNMENT - 1) & ~(MTH_FRAME_ALIGNMENT - 1);

/**
 * Build an MTH file.
 *
 * Each frame is laid out as a size word naming the *next* frame's total,
 * followed by the payload and enough padding to reach the alignment — the
 * arrangement the format actually uses, so the tests exercise the chain rather
 * than a table.
 */
function buildMth(spec: FileSpec = {}): Uint8Array {
	const frames = spec.frames ?? [{ payload: jpeg([0x01]) }];
	const videoOffset = spec.videoOffset ?? MTH_HEADER_SIZE;
	const totals = frames.map((f) => align(f.payload.length + 4));

	const size = videoOffset + totals.reduce((a, b) => a + b, 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);

	out.set([0x4d, 0x54, 0x48, 0x50], 0); // MTHP
	view.setInt16(0x04, 8, false);
	view.setInt16(0x06, 0, false);
	view.setInt32(0x08, 2, false);
	view.setInt32(0x0c, Math.max(0, ...totals), false);
	view.setInt32(0x10, spec.width ?? 448, false);
	view.setInt32(0x14, spec.height ?? 336, false);
	view.setInt32(0x18, spec.frameRate ?? 30, false);
	view.setInt32(0x1c, spec.declaredCount ?? frames.length, false);
	view.setInt32(0x20, videoOffset, false);
	view.setInt32(0x24, spec.audioOffset ?? 0, false);
	view.setInt32(0x28, totals[0] ?? 0, false);
	view.setInt32(0x2c, spec.audioSize ?? 0, false);
	for (let i = 0; i < 4; i++) {
		view.setInt32(0x30 + i * 4, spec.channels?.[i] ?? 0, false);
	}

	let at = videoOffset;
	frames.forEach((f, i) => {
		// The last frame points back at the first, as a loop.
		const next = i + 1 < frames.length ? totals[i + 1] : totals[0];
		view.setInt32(at, next, false);
		out.set(new Uint8Array(f.payload), at + 4);
		at += totals[i];
	});

	return spec.truncateTo === undefined ? out : out.subarray(0, spec.truncateTo);
}

describe('isMth', () => {
	it('accepts the magic', () => {
		expect(isMth(buildMth())).toBe(true);
	});

	it('rejects anything shorter than a header', () => {
		expect(isMth(new Uint8Array([0x4d, 0x54, 0x48, 0x50]))).toBe(false);
	});

	it('rejects other four-byte tags', () => {
		const b = buildMth();
		b[3] = 0x00;
		expect(isMth(b)).toBe(false);
	});
});

describe('parseMthHeader', () => {
	it('reads the fields as big-endian', () => {
		const h = parseMthHeader(buildMth({ width: 640, height: 480 }))!;
		expect(h.versionMajor).toBe(8);
		expect(h.versionMinor).toBe(0);
		expect(h.sizeMarker).toBe(2);
		expect(h.width).toBe(640);
		expect(h.height).toBe(480);
		expect(h.frameRate).toBe(30);
	});

	it('times the duration by display ticks, not the header field', () => {
		const h = parseMthHeader(
			buildMth({ frameRate: 30, frames: Array(60).fill({ payload: jpeg([1]) }) }),
		)!;
		expect(h.frameCount).toBe(60);
		// One frame per tick at 59.94 Hz, regardless of the field saying 30.
		expect(h.durationSeconds).toBeCloseTo(60 / 59.94, 5);
		// The field's own implication is kept for comparison, and differs.
		expect(h.declaredDurationSeconds).toBeCloseTo(2, 6);
		expect(h.durationSeconds).toBeLessThan(h.declaredDurationSeconds);
	});

	it('reports a silent file as video-only', () => {
		expect(parseMthHeader(buildMth())!.videoOnly).toBe(true);
	});

	it('does not claim video-only when an audio track is declared', () => {
		const h = parseMthHeader(buildMth({ audioOffset: 0x400, audioSize: 0x20 }))!;
		expect(h.videoOnly).toBe(false);
		expect(h.audioOffset).toBe(0x400);
	});

	it('does not claim video-only when an extra channel is declared', () => {
		const h = parseMthHeader(buildMth({ channels: [1, 0, 0, 0] }))!;
		expect(h.videoOnly).toBe(false);
	});

	it('rejects impossible geometry', () => {
		expect(parseMthHeader(buildMth({ width: 0 }))).toBeNull();
		expect(parseMthHeader(buildMth({ height: -1 }))).toBeNull();
		expect(parseMthHeader(buildMth({ width: 99999 }))).toBeNull();
	});

	it('rejects an impossible frame rate', () => {
		expect(parseMthHeader(buildMth({ frameRate: 0 }))).toBeNull();
		expect(parseMthHeader(buildMth({ frameRate: 1000 }))).toBeNull();
	});

	it('rejects a first frame that starts inside the header', () => {
		// 0x20 is inside the fixed header, so it cannot be a frame.
		const b = buildMth();
		new DataView(b.buffer).setInt32(0x20, 0x20, false);
		expect(parseMthHeader(b)).toBeNull();
	});

	it('rejects a first frame that runs past the end', () => {
		const b = buildMth();
		new DataView(b.buffer).setInt32(0x28, 0x10000, false);
		expect(parseMthHeader(b)).toBeNull();
	});

	it('rejects noise', () => {
		const noise = new Uint8Array(0x100);
		for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) & 0xff;
		expect(parseMthHeader(noise)).toBeNull();
	});
});

describe('parseMth', () => {
	it('walks the chain to the declared count', () => {
		const f = parseMth(
			buildMth({
				frames: [
					{ payload: jpeg([0x01]) },
					{ payload: jpeg([0x02, 0x03]) },
					{ payload: jpeg([0x04]) },
				],
			}),
		)!;
		expect(f.complete).toBe(true);
		expect(f.frames).toHaveLength(3);
		expect(f.frames.map((x) => x.index)).toEqual([0, 1, 2]);
	});

	it('tiles the file exactly', () => {
		const bytes = buildMth({
			frames: [{ payload: jpeg([1]) }, { payload: jpeg([2, 3, 4]) }],
		});
		const f = parseMth(bytes)!;
		const last = f.frames[f.frames.length - 1];
		expect(last.offset + last.size).toBe(bytes.length);
	});

	it('aligns every frame', () => {
		const f = parseMth(
			buildMth({
				frames: [{ payload: jpeg([1]) }, { payload: jpeg(Array(33).fill(2)) }],
			}),
		)!;
		for (const fr of f.frames) {
			expect(fr.size % MTH_FRAME_ALIGNMENT).toBe(0);
			expect(fr.offset % MTH_FRAME_ALIGNMENT).toBe(0);
		}
	});

	it("takes each frame's size from its predecessor", () => {
		const f = parseMth(
			buildMth({
				frames: [{ payload: jpeg([1]) }, { payload: jpeg(Array(40).fill(2)) }],
			}),
		)!;
		// Frame 0's stored `next` is frame 1's total size.
		expect(f.frames[0].nextSize).toBe(f.frames[1].size);
	});

	it('loops the last frame back to the first', () => {
		const f = parseMth(
			buildMth({ frames: [{ payload: jpeg([1]) }, { payload: jpeg([2]) }] }),
		)!;
		expect(f.frames[f.frames.length - 1].nextSize).toBe(f.frames[0].size);
	});

	it('reports an incomplete walk rather than throwing', () => {
		// Declares four frames but only two are present.
		const f = parseMth(
			buildMth({
				declaredCount: 4,
				frames: [{ payload: jpeg([1]) }, { payload: jpeg([2]) }],
			}),
		)!;
		expect(f.complete).toBe(false);
		expect(f.frames.length).toBeLessThan(4);
	});

	it('stops cleanly on a truncated file', () => {
		const full = buildMth({
			frames: [{ payload: jpeg([1]) }, { payload: jpeg([2]) }, { payload: jpeg([3]) }],
		});
		const f = parseMth(full.slice(0, full.length - MTH_FRAME_ALIGNMENT))!;
		expect(f.complete).toBe(false);
		expect(f.frames).toHaveLength(2);
	});

	it('honours a frame cap without claiming completeness', () => {
		const f = parseMth(
			buildMth({
				frames: [{ payload: jpeg([1]) }, { payload: jpeg([2]) }, { payload: jpeg([3]) }],
			}),
			0,
			2,
		)!;
		expect(f.frames).toHaveLength(2);
		expect(f.complete).toBe(false);
	});

	it('returns null when the header does not parse', () => {
		expect(parseMth(new Uint8Array(0x80))).toBeNull();
	});
});

describe('frame payloads', () => {
	it('hands back the stored bytes untouched', () => {
		const bytes = buildMth({ frames: [{ payload: jpeg([0xff, 0x11]) }] });
		const f = parseMth(bytes)!;
		const raw = mthFrameJpegRaw(bytes, f.frames[0])!;
		expect(raw[0]).toBe(0xff);
		expect(raw[1]).toBe(0xd8);
		// Bare 0xFF survives, which is exactly why it needs repair.
		const at = raw.indexOf(0x11);
		expect(raw[at - 1]).toBe(0xff);
	});

	it('re-stuffs the entropy data for a standard decoder', () => {
		const bytes = buildMth({ frames: [{ payload: jpeg([0xff, 0x11]) }] });
		const f = parseMth(bytes)!;
		const fixed = mthFrameJpeg(bytes, f.frames[0])!;
		expect(fixed).not.toBeNull();
		const at = fixed.indexOf(0x11);
		// The 0xFF now carries its stuffing byte.
		expect(fixed[at - 1]).toBe(0x00);
		expect(fixed[at - 2]).toBe(0xff);
	});

	it('drops the alignment padding when rebuilding', () => {
		// A one-byte scan pads out to a full block; the rebuilt JPEG should end at
		// its own EOI rather than carrying the padding along.
		const bytes = buildMth({ frames: [{ payload: jpeg([0x01]) }] });
		const f = parseMth(bytes)!;
		const fixed = mthFrameJpeg(bytes, f.frames[0])!;
		expect(fixed.length).toBeLessThan(f.frames[0].payloadSize);
		expect(fixed[fixed.length - 2]).toBe(0xff);
		expect(fixed[fixed.length - 1]).toBe(0xd9);
	});

	it('returns null for a payload outside the buffer', () => {
		const bytes = buildMth();
		const f = parseMth(bytes)!;
		const bogus = { ...f.frames[0], payloadOffset: bytes.length + 8 };
		expect(mthFrameJpegRaw(bytes, bogus)).toBeNull();
		expect(mthFrameJpeg(bytes, bogus)).toBeNull();
	});
});

describe('mthFrameTicks', () => {
	it('gives one tick per frame with no table', () => {
		const { offsets, totalTicks } = mthFrameTicks(4);
		expect([...offsets]).toEqual([0, 1, 2, 3]);
		expect(totalTicks).toBe(4);
	});

	it('holds frames for the stated number of ticks', () => {
		// One frame held 3 ticks, then two frames at 1 tick each.
		const { offsets, totalTicks } = mthFrameTicks(3, [
			[1, 3],
			[2, 1],
		]);
		expect([...offsets]).toEqual([0, 3, 4]);
		expect(totalTicks).toBe(5);
	});

	it('clamps a catch-all run to the frames that exist', () => {
		// The real tables end with an enormous count as a catch-all.
		const { offsets, totalTicks } = mthFrameTicks(3, [
			[1, 1],
			[65536, 2],
		]);
		expect([...offsets]).toEqual([0, 1, 3]);
		expect(totalTicks).toBe(5);
	});

	it('does not stack frames when the table runs out early', () => {
		const { offsets, totalTicks } = mthFrameTicks(4, [[2, 2]]);
		expect([...offsets]).toEqual([0, 2, 4, 5]);
		expect(totalTicks).toBe(6);
	});

	it('reproduces the opening movie timing', () => {
		// 1250x2 394x1 65536x2 over 3036 frames, from the executable.
		const { totalTicks } = mthFrameTicks(3036, [
			[1250, 2],
			[394, 1],
			[65536, 2],
		]);
		expect(totalTicks).toBe(5678);
		// 94.7s at 59.94 Hz, against 94.0s of paired music.
		expect(totalTicks / 59.94).toBeCloseTo(94.73, 1);
	});
});
