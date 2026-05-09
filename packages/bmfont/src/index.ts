/**
 * Parser for AngelCode BMFont descriptors.
 *
 * BMFont is a long-lived bitmap-font format produced by the
 * AngelCode "Bitmap Font Generator" tool and consumed by many
 * game engines: Cocos2d-x, MonoGame, Unity legacy GUI, Unreal
 * pre-Slate, Godot, libGDX, etc. A complete font ships as a
 * descriptor file (`.fnt`) plus one or more PNG atlas pages.
 *
 * Three on-disk encodings exist for the descriptor:
 *
 *   - **Binary** (`BMF\3`) — the format we parse here. Compact,
 *     fixed offsets, used by most modern toolchains.
 *   - **Text** (`info face=… size=…\n…`) — human-readable, line-
 *     based key/value pairs. Common in older Cocos2d projects.
 *   - **XML** (`<font><info ...></font>`) — most verbose; mostly
 *     legacy AngelCode-tool output.
 *
 * Only the binary format is implemented. The other two
 * encodings can be added later — the public types in this module
 * already mirror what they'd produce so swapping the parser
 * doesn't change the consumer-facing shape.
 *
 * Wire format (binary):
 *
 *   Header:
 *     magic     "BMF" (3 bytes)
 *     version   u8   (we accept v3; older v1/v2 use a similar
 *                    block layout but slightly different field
 *                    sizes — not seen in modern game data)
 *
 *   Then a sequence of typed blocks:
 *     [type:u8][size:i32 LE][payload of `size` bytes]
 *
 *   Block types:
 *     1 = info        face metadata + render settings
 *     2 = common      atlas-wide metrics + page count
 *     3 = pages       N × NUL-terminated page filenames
 *     4 = chars       array of 20-byte glyph records
 *     5 = kerning     optional; array of 10-byte kerning pairs
 *
 * Source spec: https://www.angelcode.com/products/bmfont/doc/file_format.html
 */

// ----- Public types -----

/** Bit flags packed into the info block's `bitField` byte. */
export interface BmfInfoFlags {
	smooth: boolean;
	unicode: boolean;
	italic: boolean;
	bold: boolean;
	fixedHeight: boolean;
}

/**
 * Per-face metadata (block 1). Mirrors the AngelCode `info` tag.
 *
 * `padding` and `spacing` are the values configured at packing
 * time; they don't affect rendering but are useful when re-
 * exporting / regenerating the atlas.
 */
export interface BmfInfo {
	/** Source font size in points (negative on some exports → use abs). */
	fontSize: number;
	flags: BmfInfoFlags;
	/** OEM charset id (0 = ANSI / default). */
	charSet: number;
	/** Stretch percentage (100 = no stretch). */
	stretchH: number;
	/** Antialiasing samples (1 = on, 0 = off). */
	aa: number;
	padding: { up: number; right: number; down: number; left: number };
	spacing: { horizontal: number; vertical: number };
	/** Outline thickness in pixels. */
	outline: number;
	/** Original font face name. */
	face: string;
}

/** Bit flags packed into the common block's `bitField` byte. */
export interface BmfCommonFlags {
	/** When true the atlas is "packed" — channels store separate glyphs. */
	packed: boolean;
}

/**
 * Atlas-wide metadata (block 2). Mirrors the AngelCode `common` tag.
 *
 * `lineHeight` is the vertical advance between baselines, `base` is
 * the baseline distance from the top of each glyph cell. `scaleW`
 * / `scaleH` are the atlas page dimensions in pixels.
 *
 * The `*Chnl` fields say how each channel of the atlas image
 * encodes glyph data. 0 = glyph, 1 = outline, 2 = glyph+outline,
 * 3 = zero, 4 = one. Most modern exports just use channel 3 (RGBA).
 */
export interface BmfCommon {
	lineHeight: number;
	base: number;
	scaleW: number;
	scaleH: number;
	pages: number;
	flags: BmfCommonFlags;
	alphaChnl: number;
	redChnl: number;
	greenChnl: number;
	blueChnl: number;
}

/**
 * One glyph record (block 4 entry). All offsets and sizes are in
 * pixels in the atlas page named by `page`.
 */
export interface BmfChar {
	/** Code point (UTF-32). */
	id: number;
	/** Glyph rectangle in the source page. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Pen-relative offset when drawing the glyph. */
	xoffset: number;
	yoffset: number;
	/** How much the cursor advances after drawing. */
	xadvance: number;
	/** Index into `pages[]`. */
	page: number;
	/** Channel mask (1=blue, 2=green, 4=red, 8=alpha, 15=all). */
	chnl: number;
}

export interface BmfKerning {
	first: number;
	second: number;
	amount: number;
}

export interface ParsedBmFont {
	version: number;
	info: BmfInfo;
	common: BmfCommon;
	/** Page filenames, 0-indexed. */
	pages: string[];
	chars: BmfChar[];
	kernings: BmfKerning[];
}

// ----- Public API -----

/** Cheap (4-byte) magic check. */
export function isBmfontBinary(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	return (
		bytes[0] === 0x42 && // B
		bytes[1] === 0x4d && // M
		bytes[2] === 0x46 && // F
		bytes[3] >= 1 && // version
		bytes[3] <= 3
	);
}

/**
 * Parse a binary BMFont descriptor (`BMF\3` magic) into typed
 * records. Throws on:
 *
 *   - Wrong magic / unsupported version.
 *   - Block payload sizes that don't match the spec (we treat any
 *     mismatch as corruption rather than silently ignoring extras
 *     — most exporters are tight).
 *
 * Unknown block types are skipped (forwards-compatible with
 * future v4+ extensions).
 */
export function parseBmfontBinary(bytes: Uint8Array): ParsedBmFont {
	if (!isBmfontBinary(bytes)) {
		throw new Error(
			`Not a BMFont binary file (expected magic "BMF\\3" at offset 0, got bytes ${[...bytes.slice(0, 4)]
				.map((b) => `0x${b.toString(16).padStart(2, '0')}`)
				.join(' ')})`,
		);
	}
	const version = bytes[3]!;
	if (version !== 3) {
		// v1 / v2 are theoretically possible but virtually unseen
		// in shipping game data. Punt rather than silently mis-
		// reading slightly-different field sizes.
		throw new Error(
			`Unsupported BMFont binary version ${version} (only v3 is implemented)`,
		);
	}
	const r = new Reader(bytes, 4);

	let info: BmfInfo | null = null;
	let common: BmfCommon | null = null;
	let pages: string[] = [];
	let chars: BmfChar[] = [];
	const kernings: BmfKerning[] = [];

	while (r.remaining() > 0) {
		const blockType = r.u8();
		const blockSize = r.i32();
		const payloadEnd = r.pos + blockSize;
		if (payloadEnd > r.length) {
			throw new Error(
				`BMFont: block type ${blockType} runs past end of file (size=${blockSize}, remaining=${r.length - r.pos})`,
			);
		}
		switch (blockType) {
			case 1:
				info = parseInfoBlock(r, blockSize);
				break;
			case 2:
				common = parseCommonBlock(r, blockSize);
				break;
			case 3:
				pages = parsePagesBlock(r, blockSize, common?.pages ?? 0);
				break;
			case 4:
				chars = parseCharsBlock(r, blockSize);
				break;
			case 5:
				kernings.push(...parseKerningBlock(r, blockSize));
				break;
			default:
				// Unknown — skip the payload and keep parsing.
				r.skip(blockSize);
				break;
		}
		// Defensive: re-anchor in case a sub-parser mis-counted.
		r.pos = payloadEnd;
	}

	if (!info) throw new Error('BMFont: missing info block (type 1)');
	if (!common) throw new Error('BMFont: missing common block (type 2)');
	if (pages.length === 0) {
		// `common.pages` says how many pages — if the pages block
		// was missing entirely we synthesize empty filenames so
		// callers can still iterate.
		pages = Array.from({ length: common.pages }, (_, i) => `page_${i}.png`);
	}
	return { version, info, common, pages, chars, kernings };
}

// ----- Block parsers -----

function parseInfoBlock(r: Reader, size: number): BmfInfo {
	const start = r.pos;
	const fontSize = r.i16();
	const bitField = r.u8();
	const charSet = r.u8();
	const stretchH = r.u16();
	const aa = r.u8();
	const paddingUp = r.u8();
	const paddingRight = r.u8();
	const paddingDown = r.u8();
	const paddingLeft = r.u8();
	const spacingHoriz = r.u8();
	const spacingVert = r.u8();
	const outline = r.u8();
	// fontName: NUL-terminated string filling the rest of the block.
	const nameBytes = size - (r.pos - start);
	const face = r.cstring(nameBytes);
	return {
		fontSize,
		flags: {
			smooth: (bitField & 0x80) !== 0,
			unicode: (bitField & 0x40) !== 0,
			italic: (bitField & 0x20) !== 0,
			bold: (bitField & 0x10) !== 0,
			fixedHeight: (bitField & 0x08) !== 0,
		},
		charSet,
		stretchH,
		aa,
		padding: {
			up: paddingUp,
			right: paddingRight,
			down: paddingDown,
			left: paddingLeft,
		},
		spacing: { horizontal: spacingHoriz, vertical: spacingVert },
		outline,
		face,
	};
}

function parseCommonBlock(r: Reader, size: number): BmfCommon {
	if (size !== 15) {
		throw new Error(`BMFont: common block has size ${size}, expected 15`);
	}
	const lineHeight = r.u16();
	const base = r.u16();
	const scaleW = r.u16();
	const scaleH = r.u16();
	const pages = r.u16();
	const bitField = r.u8();
	const alphaChnl = r.u8();
	const redChnl = r.u8();
	const greenChnl = r.u8();
	const blueChnl = r.u8();
	return {
		lineHeight,
		base,
		scaleW,
		scaleH,
		pages,
		flags: { packed: (bitField & 0x01) !== 0 },
		alphaChnl,
		redChnl,
		greenChnl,
		blueChnl,
	};
}

function parsePagesBlock(r: Reader, size: number, pageCount: number): string[] {
	if (pageCount === 0) {
		// Common block hadn't been parsed yet — just split on NUL
		// and return whatever's there.
		const out: string[] = [];
		const end = r.pos + size;
		while (r.pos < end) {
			const next = r.bytes.indexOf(0, r.pos);
			if (next < 0 || next >= end) {
				out.push(decodeCString(r.bytes.subarray(r.pos, end)));
				r.pos = end;
				break;
			}
			out.push(decodeCString(r.bytes.subarray(r.pos, next)));
			r.pos = next + 1;
		}
		return out;
	}
	// All page names are the same length (zero-padded to a fixed
	// stride). Compute stride = total / count.
	if (size % pageCount !== 0) {
		throw new Error(
			`BMFont: pages block size ${size} not divisible by page count ${pageCount}`,
		);
	}
	const stride = size / pageCount;
	const out: string[] = [];
	for (let i = 0; i < pageCount; i++) {
		const slice = r.bytes.subarray(r.pos, r.pos + stride);
		out.push(decodeCString(slice));
		r.pos += stride;
	}
	return out;
}

function parseCharsBlock(r: Reader, size: number): BmfChar[] {
	if (size % 20 !== 0) {
		throw new Error(
			`BMFont: chars block size ${size} not divisible by 20 (per-char struct size)`,
		);
	}
	const count = size / 20;
	const chars: BmfChar[] = new Array(count);
	for (let i = 0; i < count; i++) {
		chars[i] = {
			id: r.u32(),
			x: r.u16(),
			y: r.u16(),
			width: r.u16(),
			height: r.u16(),
			xoffset: r.i16(),
			yoffset: r.i16(),
			xadvance: r.i16(),
			page: r.u8(),
			chnl: r.u8(),
		};
	}
	return chars;
}

function parseKerningBlock(r: Reader, size: number): BmfKerning[] {
	if (size % 10 !== 0) {
		throw new Error(
			`BMFont: kerning block size ${size} not divisible by 10 (per-pair struct size)`,
		);
	}
	const count = size / 10;
	const out: BmfKerning[] = new Array(count);
	for (let i = 0; i < count; i++) {
		out[i] = { first: r.u32(), second: r.u32(), amount: r.i16() };
	}
	return out;
}

// ----- Reader -----

class Reader {
	pos: number;
	view: DataView;
	readonly length: number;

	constructor(public bytes: Uint8Array, start = 0) {
		this.pos = start;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.length = bytes.byteLength;
	}

	remaining(): number {
		return this.length - this.pos;
	}

	skip(n: number): void {
		this.pos += n;
	}

	u8(): number {
		return this.view.getUint8(this.pos++);
	}
	u16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	i16(): number {
		const v = this.view.getInt16(this.pos, true);
		this.pos += 2;
		return v;
	}
	u32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	i32(): number {
		const v = this.view.getInt32(this.pos, true);
		this.pos += 4;
		return v;
	}

	cstring(maxBytes: number): string {
		const slice = this.bytes.subarray(this.pos, this.pos + maxBytes);
		this.pos += maxBytes;
		return decodeCString(slice);
	}
}

function decodeCString(slice: Uint8Array): string {
	const nul = slice.indexOf(0);
	const end = nul >= 0 ? nul : slice.length;
	return new TextDecoder('utf-8').decode(slice.subarray(0, end));
}
