/**
 * Write a {@link BitmapFont} as a TrueType font with real outlines,
 * so it works anywhere fonts do: CSS `@font-face`, canvas, design
 * tools, and outline-based tools such as text-to-3D-model generators.
 *
 * Each glyph's coverage bitmap is traced (./trace.ts) and scaled so
 * one pixel is `unitsPerEm / emSize` font units. The font has the
 * minimal required table set (OpenType spec, "Required tables"):
 * `cmap` (formats 4 and 12), `glyf`/`loca` (long offsets), `head`,
 * `hhea`, `hmtx`, `maxp` 1.0, `name`, `OS/2` v4 and `post` 3.0 (no
 * glyph names), plus a legacy `kern` table when the font has kerning
 * pairs. No hinting instructions.
 *
 * Source: the OpenType specification (Microsoft, v1.9).
 */

import { chooseTraceMode, trimGlyph, type BitmapFont } from './font.js';
import { traceCoverage, type TraceMode } from './trace.js';

export interface TtfOptions {
	/** Tracing strategy. Default 'auto' ({@link chooseTraceMode}). */
	trace?: TraceMode | 'auto';
	/** Smooth-mode fitting tolerance, in px. Default 0.2. */
	tolerance?: number;
	/** Coverage (0-255) at which a pixel counts as inside. Default 128. */
	threshold?: number;
	/** Creation / modification date written to `head`. Default now. */
	date?: Date;
	/** Version string, e.g. "1.000". Default "1.000". */
	version?: string;
}

interface Pt {
	x: number;
	y: number;
	on: boolean;
}

interface OutGlyph {
	contours: Pt[][];
	advance: number;
	codepoints: number[];
}

/** Build a TrueType (`.ttf`) font from a bitmap font. */
export function bitmapFontToTtf(font: BitmapFont, options: TtfOptions = {}): Uint8Array {
	const mode = !options.trace || options.trace === 'auto' ? chooseTraceMode(font) : options.trace;
	const emSize = font.emSize > 0 ? font.emSize : font.lineHeight || 16;
	// Whole font units per pixel where possible, so pixel fonts stay on the grid.
	const perPx = Math.max(1, Math.round(1000 / emSize));
	const upm = Math.min(16384, Math.max(16, Math.round(emSize * perPx)));
	const k = upm / emSize;

	const glyphs: OutGlyph[] = [notdef(upm, font.lineHeight * k, font.base * k)];
	const seen = new Set<number>();
	const sorted = [...font.glyphs].sort((a, b) => Math.min(...a.codepoints) - Math.min(...b.codepoints));
	for (const src of sorted) {
		const codepoints = src.codepoints.filter((cp) => !seen.has(cp) && cp > 0 && cp <= 0x10ffff);
		if (!codepoints.length) continue;
		for (const cp of codepoints) seen.add(cp);
		const g = trimGlyph(src);
		const traced = g.width && g.height
			? traceCoverage(g.coverage, g.width, g.height, { mode, tolerance: options.tolerance, threshold: options.threshold })
			: [];
		const contours = traced
			.map((c) =>
				compact(
					c.map((p) => ({
						x: Math.round((g.x + p.x) * k),
						y: Math.round((font.base - (g.y + p.y)) * k),
						on: p.on,
					})),
				),
			)
			.filter((c) => c.length >= 3);
		glyphs.push({ contours, advance: Math.max(0, Math.round(src.advance * k)), codepoints });
	}

	const gidOf = new Map<number, number>();
	glyphs.forEach((g, gid) => g.codepoints.forEach((cp) => gidOf.set(cp, gid)));

	const ascender = Math.round(font.base * k);
	const descender = -Math.round((font.lineHeight - font.base) * k);
	const date = options.date ?? new Date();
	const version = options.version ?? '1.000';
	const family = font.family.trim() || 'Bitmap Font';
	const style = font.style?.trim() || [font.bold && 'Bold', font.italic && 'Italic'].filter(Boolean).join(' ') || 'Regular';

	const glyf = buildGlyf(glyphs);
	const bounds = glyf.bounds;
	const fontBox: Box = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
	for (const g of bounds) {
		if (!g) continue;
		fontBox.xMin = Math.min(fontBox.xMin, g.xMin);
		fontBox.yMin = Math.min(fontBox.yMin, g.yMin);
		fontBox.xMax = Math.max(fontBox.xMax, g.xMax);
		fontBox.yMax = Math.max(fontBox.yMax, g.yMax);
	}
	const capHeight = heightOf(glyphs, bounds, gidOf, 0x48) ?? Math.round(ascender * 0.7);
	const xHeight = heightOf(glyphs, bounds, gidOf, 0x78) ?? Math.round(ascender * 0.5);

	const kerning = (font.kerning ?? [])
		.map((p) => ({ left: gidOf.get(p.first), right: gidOf.get(p.second), value: Math.round(p.amount * k) }))
		.filter((p): p is { left: number; right: number; value: number } => p.left !== undefined && p.right !== undefined && p.value !== 0);

	const tables: Record<string, Uint8Array> = {
		'OS/2': buildOs2({ glyphs, bounds, gidOf, upm, ascender, descender, fontBox, capHeight, xHeight, bold: !!font.bold, italic: !!font.italic, kerning: kerning.length > 0 }),
		cmap: buildCmap(gidOf),
		glyf: glyf.data,
		head: buildHead(upm, fontBox, date, !!font.bold, !!font.italic),
		hhea: buildHhea(glyphs, bounds, ascender, descender),
		hmtx: buildHmtx(glyphs, bounds),
		loca: glyf.loca,
		maxp: buildMaxp(glyphs),
		name: buildName(family, style, version),
		post: buildPost(upm),
	};
	if (kerning.length) tables.kern = buildKern(kerning);
	return assemble(tables);
}

/** Drop repeated points and on-curve points implied by their off-curve neighbours. */
function compact(pts: Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of pts) {
		const q = out[out.length - 1];
		if (!q || q.x !== p.x || q.y !== p.y) out.push(p);
		else if (p.on) q.on = true;
	}
	while (out.length > 1 && out[0]!.x === out[out.length - 1]!.x && out[0]!.y === out[out.length - 1]!.y) {
		if (out.pop()!.on) out[0]!.on = true;
	}
	const n = out.length;
	if (n < 3) return out;
	const keep = out.filter((p, i) => {
		if (!p.on) return true;
		const a = out[(i + n - 1) % n]!;
		const b = out[(i + 1) % n]!;
		return !(!a.on && !b.on && a.x + b.x === 2 * p.x && a.y + b.y === 2 * p.y);
	});
	// Keep at least one on-curve point to anchor the contour.
	return keep.some((p) => p.on) ? keep : out;
}

/** The "missing glyph" box: an outlined rectangle. */
function notdef(upm: number, lineHeight: number, base: number): OutGlyph {
	const w = Math.round(upm * 0.5);
	const top = Math.round(Math.min(base, lineHeight) * 0.9);
	const s = Math.max(1, Math.round(upm * 0.05));
	const x0 = s;
	const x1 = w - s;
	const outer = [
		{ x: x0, y: 0, on: true },
		{ x: x0, y: top, on: true },
		{ x: x1, y: top, on: true },
		{ x: x1, y: 0, on: true },
	];
	const inner = [
		{ x: x0 + s, y: s, on: true },
		{ x: x1 - s, y: s, on: true },
		{ x: x1 - s, y: top - s, on: true },
		{ x: x0 + s, y: top - s, on: true },
	];
	return { contours: top > 4 * s ? [outer, inner] : [], advance: w, codepoints: [] };
}

interface Box {
	xMin: number;
	yMin: number;
	xMax: number;
	yMax: number;
}

function heightOf(glyphs: OutGlyph[], bounds: (Box | null)[], gidOf: Map<number, number>, cp: number): number | null {
	const gid = gidOf.get(cp);
	if (gid === undefined || !glyphs[gid]) return null;
	return bounds[gid]?.yMax ?? null;
}

// ----- binary helpers -----

class Writer {
	private buf = new Uint8Array(256);
	private view = new DataView(this.buf.buffer);
	length = 0;
	private ensure(n: number) {
		if (this.length + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.length + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf);
		this.buf = next;
		this.view = new DataView(next.buffer);
	}
	u8(v: number) {
		this.ensure(1);
		this.view.setUint8(this.length++, v);
		return this;
	}
	i8(v: number) {
		this.ensure(1);
		this.view.setInt8(this.length++, v);
		return this;
	}
	u16(v: number) {
		this.ensure(2);
		this.view.setUint16(this.length, v);
		this.length += 2;
		return this;
	}
	i16(v: number) {
		this.ensure(2);
		this.view.setInt16(this.length, Math.max(-32768, Math.min(32767, v)));
		this.length += 2;
		return this;
	}
	u32(v: number) {
		this.ensure(4);
		this.view.setUint32(this.length, v >>> 0);
		this.length += 4;
		return this;
	}
	i64(v: bigint) {
		this.ensure(8);
		this.view.setBigInt64(this.length, v);
		this.length += 8;
		return this;
	}
	bytes(b: Uint8Array) {
		this.ensure(b.length);
		this.buf.set(b, this.length);
		this.length += b.length;
		return this;
	}
	tag(s: string) {
		for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 0x20);
		return this;
	}
	pad(align: number) {
		while (this.length % align) this.u8(0);
		return this;
	}
	setU32(at: number, v: number) {
		this.view.setUint32(at, v >>> 0);
	}
	data() {
		return this.buf.slice(0, this.length);
	}
}

function searchParams(count: number, unit: number) {
	let pow = 1;
	let log = 0;
	while (pow * 2 <= count) {
		pow *= 2;
		log++;
	}
	return { searchRange: pow * unit, entrySelector: log, rangeShift: count * unit - pow * unit };
}

// ----- tables -----

function buildGlyf(glyphs: OutGlyph[]): { data: Uint8Array; loca: Uint8Array; bounds: (Box | null)[] } {
	const w = new Writer();
	const loca = new Writer();
	const bounds: (Box | null)[] = [];
	for (const g of glyphs) {
		loca.u32(w.length);
		const pts = g.contours.flat();
		if (!pts.length) {
			bounds.push(null);
			continue;
		}
		const box = {
			xMin: Math.min(...pts.map((p) => p.x)),
			yMin: Math.min(...pts.map((p) => p.y)),
			xMax: Math.max(...pts.map((p) => p.x)),
			yMax: Math.max(...pts.map((p) => p.y)),
		};
		bounds.push(box);
		w.i16(g.contours.length).i16(box.xMin).i16(box.yMin).i16(box.xMax).i16(box.yMax);
		let end = -1;
		for (const c of g.contours) w.u16((end += c.length));
		w.u16(0); // no instructions
		const flags: number[] = [];
		const xs = new Writer();
		const ys = new Writer();
		let px = 0;
		let py = 0;
		for (const p of pts) {
			let f = p.on ? 1 : 0;
			const dx = p.x - px;
			const dy = p.y - py;
			px = p.x;
			py = p.y;
			if (dx === 0) f |= 0x10;
			else if (Math.abs(dx) <= 255) {
				f |= 0x02 | (dx > 0 ? 0x10 : 0);
				xs.u8(Math.abs(dx));
			} else xs.i16(dx);
			if (dy === 0) f |= 0x20;
			else if (Math.abs(dy) <= 255) {
				f |= 0x04 | (dy > 0 ? 0x20 : 0);
				ys.u8(Math.abs(dy));
			} else ys.i16(dy);
			flags.push(f);
		}
		// Run-length encode repeated flags.
		for (let i = 0; i < flags.length; ) {
			let run = 1;
			while (i + run < flags.length && flags[i + run] === flags[i] && run < 256) run++;
			if (run > 2) {
				w.u8(flags[i]! | 0x08).u8(run - 1);
			} else {
				for (let r = 0; r < run; r++) w.u8(flags[i]!);
			}
			i += run;
		}
		w.bytes(xs.data()).bytes(ys.data()).pad(4);
	}
	loca.u32(w.length);
	return { data: w.data(), loca: loca.data(), bounds };
}

function buildCmap(gidOf: Map<number, number>): Uint8Array {
	const cps = [...gidOf.keys()].sort((a, b) => a - b);
	const bmp = cps.filter((cp) => cp <= 0xffff);
	const full = cps.some((cp) => cp > 0xffff);

	// Format 4: runs of consecutive code points with a constant glyph delta.
	const segs: { start: number; end: number; delta: number }[] = [];
	for (const cp of bmp) {
		if (cp === 0xffff) continue;
		const gid = gidOf.get(cp)!;
		const last = segs[segs.length - 1];
		if (last && cp === last.end + 1 && gid - cp === last.delta) last.end = cp;
		else segs.push({ start: cp, end: cp, delta: gid - cp });
	}
	segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
	const f4 = new Writer();
	const segX2 = segs.length * 2;
	const sp = searchParams(segs.length, 2);
	f4.u16(4).u16(16 + segs.length * 8).u16(0).u16(segX2).u16(sp.searchRange).u16(sp.entrySelector).u16(sp.rangeShift);
	for (const s of segs) f4.u16(s.end);
	f4.u16(0);
	for (const s of segs) f4.u16(s.start);
	for (const s of segs) f4.u16((s.delta + 0x10000) & 0xffff);
	for (let i = 0; i < segs.length; i++) f4.u16(0);

	// Format 12: runs of consecutive code points and glyph ids.
	const groups: { start: number; end: number; gid: number }[] = [];
	for (const cp of cps) {
		const gid = gidOf.get(cp)!;
		const last = groups[groups.length - 1];
		if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
		else groups.push({ start: cp, end: cp, gid });
	}
	const f12 = new Writer();
	f12.u16(12).u16(0).u32(16 + groups.length * 12).u32(0).u32(groups.length);
	for (const g of groups) f12.u32(g.start).u32(g.end).u32(g.gid);

	// Encoding records share the two subtables; they must be sorted by platform, then encoding.
	const subtables: { platform: number; encoding: number; f12: boolean }[] = [
		{ platform: 0, encoding: 3, f12: false },
		...(full ? [{ platform: 0, encoding: 4, f12: true }] : []),
		{ platform: 3, encoding: 1, f12: false },
		...(full ? [{ platform: 3, encoding: 10, f12: true }] : []),
	];
	const w = new Writer();
	w.u16(0).u16(subtables.length);
	const offF4 = 4 + subtables.length * 8;
	const offF12 = offF4 + f4.length;
	for (const s of subtables) w.u16(s.platform).u16(s.encoding).u32(s.f12 ? offF12 : offF4);
	w.bytes(f4.data());
	if (full) w.bytes(f12.data());
	return w.data();
}

function buildHead(upm: number, box: Box, date: Date, bold: boolean, italic: boolean): Uint8Array {
	// LONGDATETIME: seconds since 1904-01-01.
	const secs = BigInt(Math.floor(date.getTime() / 1000) + 2082844800);
	return new Writer()
		.u32(0x00010000)
		.u32(0x00010000)
		.u32(0) // checkSumAdjustment, patched in assemble()
		.u32(0x5f0f3cf5)
		.u16(0x0009) // baseline at y=0, integer ppem scaling
		.u16(upm)
		.i64(secs)
		.i64(secs)
		.i16(box.xMin)
		.i16(box.yMin)
		.i16(box.xMax)
		.i16(box.yMax)
		.u16((bold ? 1 : 0) | (italic ? 2 : 0))
		.u16(8)
		.i16(2)
		.i16(1) // long loca offsets
		.i16(0)
		.data();
}

function buildHhea(glyphs: OutGlyph[], bounds: (Box | null)[], ascender: number, descender: number): Uint8Array {
	let advanceMax = 0;
	let minLsb = 0;
	let minRsb = 0;
	let maxExtent = 0;
	let any = false;
	glyphs.forEach((g, i) => {
		advanceMax = Math.max(advanceMax, g.advance);
		const b = bounds[i];
		if (!b) return;
		if (!any) {
			minLsb = b.xMin;
			minRsb = g.advance - b.xMax;
			maxExtent = b.xMax;
			any = true;
		}
		minLsb = Math.min(minLsb, b.xMin);
		minRsb = Math.min(minRsb, g.advance - b.xMax);
		maxExtent = Math.max(maxExtent, b.xMax);
	});
	const w = new Writer()
		.u32(0x00010000)
		.i16(ascender)
		.i16(descender)
		.i16(0)
		.u16(advanceMax)
		.i16(minLsb)
		.i16(minRsb)
		.i16(maxExtent)
		.i16(1)
		.i16(0)
		.i16(0);
	for (let i = 0; i < 4; i++) w.i16(0);
	return w.i16(0).u16(glyphs.length).data();
}

function buildHmtx(glyphs: OutGlyph[], bounds: (Box | null)[]): Uint8Array {
	const w = new Writer();
	glyphs.forEach((g, i) => w.u16(g.advance).i16(bounds[i]?.xMin ?? 0));
	return w.data();
}

function buildMaxp(glyphs: OutGlyph[]): Uint8Array {
	let maxPoints = 0;
	let maxContours = 0;
	for (const g of glyphs) {
		maxPoints = Math.max(maxPoints, g.contours.reduce((n, c) => n + c.length, 0));
		maxContours = Math.max(maxContours, g.contours.length);
	}
	const w = new Writer().u32(0x00010000).u16(glyphs.length).u16(maxPoints).u16(maxContours).u16(0).u16(0).u16(2);
	for (let i = 0; i < 8; i++) w.u16(0);
	return w.data();
}

function buildName(family: string, style: string, version: string): Uint8Array {
	const ps = `${family}-${style}`.replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, '').slice(0, 63) || 'BitmapFont';
	const records: [number, string][] = [
		[1, family],
		[2, style],
		[3, `${version};${ps}`],
		[4, style === 'Regular' ? family : `${family} ${style}`],
		[5, `Version ${version}`],
		[6, ps],
	];
	const enc = (s: string) => {
		const out = new Uint8Array(s.length * 2);
		for (let i = 0; i < s.length; i++) {
			out[i * 2] = s.charCodeAt(i) >> 8;
			out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
		}
		return out;
	};
	const strings = records.map(([, s]) => enc(s));
	const w = new Writer().u16(0).u16(records.length).u16(6 + records.length * 12);
	let off = 0;
	records.forEach(([id], i) => {
		w.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i]!.length).u16(off);
		off += strings[i]!.length;
	});
	for (const s of strings) w.bytes(s);
	return w.data();
}

function buildOs2(o: {
	glyphs: OutGlyph[];
	bounds: (Box | null)[];
	gidOf: Map<number, number>;
	upm: number;
	ascender: number;
	descender: number;
	fontBox: Box;
	capHeight: number;
	xHeight: number;
	bold: boolean;
	italic: boolean;
	kerning: boolean;
}): Uint8Array {
	const inked = o.glyphs.filter((g) => g.advance > 0);
	const avg = inked.length ? Math.round(inked.reduce((n, g) => n + g.advance, 0) / inked.length) : 0;
	const cps = [...o.gidOf.keys()].sort((a, b) => a - b);
	const first = Math.min(cps[0] ?? 0x20, 0xffff);
	const last = Math.min(cps[cps.length - 1] ?? 0x20, 0xffff);
	const sub = Math.round(o.upm * 0.65);
	const strike = Math.max(1, Math.round(o.upm * 0.05));
	const fsSelection = (o.italic ? 0x01 : 0) | (o.bold ? 0x20 : 0) | (!o.bold && !o.italic ? 0x40 : 0) | 0x80;
	const w = new Writer()
		.u16(4)
		.i16(avg)
		.u16(o.bold ? 700 : 400)
		.u16(5)
		.u16(0) // installable embedding
		.i16(sub)
		.i16(sub)
		.i16(0)
		.i16(Math.round(o.upm * 0.14))
		.i16(sub)
		.i16(sub)
		.i16(0)
		.i16(Math.round(o.upm * 0.48))
		.i16(strike)
		.i16(Math.round(o.xHeight / 2 + strike / 2))
		.i16(0);
	for (let i = 0; i < 10; i++) w.u8(0); // panose: any
	w.u32(unicodeRange1(cps)).u32(0).u32(0).u32(0);
	w.tag('NONE');
	w.u16(fsSelection).u16(first).u16(last);
	w.i16(o.ascender).i16(o.descender).i16(0);
	w.u16(Math.max(0, o.ascender, o.fontBox.yMax)).u16(Math.max(0, -o.descender, -o.fontBox.yMin));
	w.u32(1).u32(0); // code page: Latin 1
	w.i16(o.xHeight).i16(o.capHeight).u16(0).u16(0x20).u16(o.kerning ? 2 : 1);
	return w.data();
}

/** The ulUnicodeRange1 bits for the common scripts present. */
function unicodeRange1(cps: number[]): number {
	const ranges: [number, number, number][] = [
		[0, 0x0000, 0x007f], // Basic Latin
		[1, 0x0080, 0x00ff], // Latin-1 Supplement
		[2, 0x0100, 0x017f], // Latin Extended-A
		[3, 0x0180, 0x024f], // Latin Extended-B
		[7, 0x0370, 0x03ff], // Greek
		[9, 0x0400, 0x04ff], // Cyrillic
		[31, 0x2000, 0x206f], // General Punctuation
	];
	let bits = 0;
	for (const [bit, lo, hi] of ranges) if (cps.some((cp) => cp >= lo && cp <= hi)) bits |= 1 << bit;
	return bits >>> 0;
}

function buildPost(upm: number): Uint8Array {
	return new Writer()
		.u32(0x00030000)
		.u32(0)
		.i16(-Math.round(upm * 0.1))
		.i16(Math.max(1, Math.round(upm * 0.05)))
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0)
		.data();
}

function buildKern(pairs: { left: number; right: number; value: number }[]): Uint8Array {
	const sorted = [...pairs].sort((a, b) => a.left - b.left || a.right - b.right).slice(0, 10900);
	const sp = searchParams(sorted.length, 6);
	const w = new Writer().u16(0).u16(1).u16(0).u16(14 + sorted.length * 6).u16(0x0001).u16(sorted.length);
	w.u16(sp.searchRange).u16(sp.entrySelector).u16(sp.rangeShift);
	for (const p of sorted) w.u16(p.left).u16(p.right).i16(p.value);
	return w.data();
}

function checksum(data: Uint8Array): number {
	let sum = 0;
	const padded = data.length % 4 ? new Uint8Array(data.length + 4 - (data.length % 4)) : data;
	if (padded !== data) padded.set(data);
	const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
	for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
	return sum;
}

function assemble(tables: Record<string, Uint8Array>): Uint8Array {
	const tags = Object.keys(tables).sort();
	const n = tags.length;
	const sp = searchParams(n, 16);
	const w = new Writer().u32(0x00010000).u16(n).u16(sp.searchRange).u16(sp.entrySelector).u16(sp.rangeShift);
	let offset = 12 + n * 16;
	let headOffset = 0;
	for (const tag of tags) {
		const data = tables[tag]!;
		if (tag === 'head') headOffset = offset;
		w.tag(tag).u32(checksum(data)).u32(offset).u32(data.length);
		offset += Math.ceil(data.length / 4) * 4;
	}
	for (const tag of tags) w.bytes(tables[tag]!).pad(4);
	const out = w.data();
	const adjust = (0xb1b0afba - checksum(out)) >>> 0;
	new DataView(out.buffer).setUint32(headOffset + 8, adjust);
	return out;
}
