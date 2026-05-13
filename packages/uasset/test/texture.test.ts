import { describe, expect, it } from 'vitest';
import {
	BULKDATA_ForceInlinePayload,
	BULKDATA_PayloadAtEndOfFile,
	BULKDATA_PayloadInSeperateFile,
	BULKDATA_SingleUse,
	getMipBytes,
	parseTexturePlatformDataFromTail,
	readMipFromUbulk,
	TextureParseError,
} from '../src/index.js';

/**
 * Build the tail bytes that follow the property-`None` terminator of
 * a cooked Texture2D export. Layout matches UE 4.27. All test inputs
 * are synthesized here — no commercial-game data.
 */
function buildTextureTail(opts: {
	leadingZeros?: number;
	pixelFormat: string;
	importedWidth: number;
	importedHeight: number;
	numSlices?: number;
	isCube?: boolean;
	firstMipToSerialize?: number;
	mips: Array<{
		width: number;
		height: number;
		depth?: number;
		bulkFlags: number;
		/** Inline payload (when bulkFlags & ForceInlinePayload). */
		inlineData?: Uint8Array;
		/** Declared data size (defaults to inlineData.length or 0). */
		dataSize?: number;
		/** Declared `offset` (defaults to 0). */
		offset?: number;
	}>;
}): Uint8Array {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const push = (b: Uint8Array): void => { chunks.push(b); };
	const u32 = (v: number): Uint8Array => {
		const o = new Uint8Array(4);
		new DataView(o.buffer).setUint32(0, v, true);
		return o;
	};
	const u16 = (v: number): Uint8Array => {
		const o = new Uint8Array(2);
		new DataView(o.buffer).setUint16(0, v, true);
		return o;
	};
	const i32 = (v: number): Uint8Array => {
		const o = new Uint8Array(4);
		new DataView(o.buffer).setInt32(0, v, true);
		return o;
	};
	const i64 = (v: number): Uint8Array => {
		const o = new Uint8Array(8);
		new DataView(o.buffer).setBigInt64(0, BigInt(v), true);
		return o;
	};
	const fstring = (s: string): Uint8Array => {
		const bytes = enc.encode(s + '\0');
		const out = new Uint8Array(4 + bytes.length);
		new DataView(out.buffer).setInt32(0, bytes.length, true);
		out.set(bytes, 4);
		return out;
	};
	// Variable-length leading prefix from parent UObject Serialize.
	const leading = opts.leadingZeros ?? 0;
	if (leading > 0) push(new Uint8Array(leading));
	// Strip flags + bCooked.
	push(u16(0x0001));   // UTexture::StripFlags
	push(u16(0x0001));   // UTexture2D::StripFlags
	push(u32(1));        // bCooked
	// FName pixelFormatName (we don't use this; the FString below is the
	// authoritative format identifier).
	push(u32(0));
	push(u32(0));
	push(u32(0));        // skipOffset (we don't validate)
	push(u32(0));        // UE 4.20+ extra zero
	push(u32(opts.importedWidth));
	push(u32(opts.importedHeight));
	let packedData = (opts.numSlices ?? 1) & 0x3fffffff;
	if (opts.isCube) packedData |= 0x80000000;
	push(u32(packedData >>> 0));
	push(fstring(opts.pixelFormat));
	push(u32(opts.firstMipToSerialize ?? 0));
	push(u32(opts.mips.length));
	for (const m of opts.mips) {
		const inline = (m.bulkFlags & BULKDATA_ForceInlinePayload) !== 0;
		const declaredSize = m.dataSize ?? (m.inlineData ? m.inlineData.length : 0);
		push(u32(1));                     // bCooked
		push(u32(m.bulkFlags));
		push(i32(declaredSize));
		push(i32(declaredSize));          // dataSize2 (matches)
		push(i64(m.offset ?? 0));
		if (inline) {
			push(m.inlineData ?? new Uint8Array(declaredSize));
		}
		push(u32(m.width));
		push(u32(m.height));
		push(u32(m.depth ?? 1));
	}
	push(u32(0));                       // bIsVirtual
	push(u32(0));                       // noneNameId lo
	push(u32(0));                       // noneNameId hi
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

describe('parseTexturePlatformDataFromTail', () => {
	it('decodes a single-mip inline ASTC texture', () => {
		// 4×4 ASTC 6×6 block = 16 bytes (one block covers the whole image).
		const pixelData = new Uint8Array(16);
		for (let i = 0; i < 16; i++) pixelData[i] = i + 1;
		const tail = buildTextureTail({
			pixelFormat: 'PF_ASTC_6x6',
			importedWidth: 4,
			importedHeight: 4,
			mips: [
				{
					width: 4,
					height: 4,
					bulkFlags: BULKDATA_ForceInlinePayload | BULKDATA_SingleUse,
					inlineData: pixelData,
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		expect(tpd.pixelFormat).toBe('PF_ASTC_6x6');
		expect(tpd.importedWidth).toBe(4);
		expect(tpd.importedHeight).toBe(4);
		expect(tpd.isCube).toBe(false);
		expect(tpd.numSlices).toBe(1);
		expect(tpd.mips).toHaveLength(1);
		const mip = tpd.mips[0]!;
		expect(mip.width).toBe(4);
		expect(mip.height).toBe(4);
		expect(mip.location).toBe('uexp-inline');
		expect(mip.bytes).not.toBeNull();
		expect(Array.from(mip.bytes!)).toEqual(Array.from(pixelData));
	});

	it('handles a cubemap (6 slices, isCube=true)', () => {
		const tail = buildTextureTail({
			pixelFormat: 'PF_ASTC_6x6',
			importedWidth: 32,
			importedHeight: 32,
			numSlices: 6,
			isCube: true,
			mips: [
				{
					width: 32,
					height: 32,
					bulkFlags: BULKDATA_ForceInlinePayload,
					inlineData: new Uint8Array(96),
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		expect(tpd.isCube).toBe(true);
		expect(tpd.numSlices).toBe(6);
	});

	it('mixes inline (uexp) and streamed (ubulk) mips correctly', () => {
		const tail = buildTextureTail({
			pixelFormat: 'PF_BC5',
			importedWidth: 256,
			importedHeight: 256,
			firstMipToSerialize: 0,
			mips: [
				{
					width: 256,
					height: 256,
					bulkFlags: BULKDATA_PayloadAtEndOfFile | BULKDATA_PayloadInSeperateFile,
					dataSize: 65536,
					offset: 0,
				},
				{
					width: 128,
					height: 128,
					bulkFlags: BULKDATA_ForceInlinePayload | BULKDATA_SingleUse,
					inlineData: new Uint8Array(16384),
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		expect(tpd.mips).toHaveLength(2);
		expect(tpd.mips[0]!.location).toBe('ubulk');
		expect(tpd.mips[0]!.dataSize).toBe(65536);
		expect(tpd.mips[0]!.bytes).toBeNull();
		expect(tpd.mips[1]!.location).toBe('uexp-inline');
		expect(tpd.mips[1]!.bytes!.length).toBe(16384);
	});

	it('throws on an empty buffer (cannot find strip flags)', () => {
		expect(() => parseTexturePlatformDataFromTail(new Uint8Array(0))).toThrowError(
			TextureParseError,
		);
	});

	it('throws on a tail without the strip-flags signature', () => {
		// 64 bytes of junk — none match the 01 00 01 00 01 00 00 00 pattern.
		const junk = new Uint8Array(64);
		for (let i = 0; i < junk.length; i++) junk[i] = 0xff;
		expect(() => parseTexturePlatformDataFromTail(junk)).toThrowError(TextureParseError);
	});

	it('throws on virtual textures (bIsVirtual=1)', () => {
		// Build a normal tail, then patch the trailing bIsVirtual word.
		const tail = buildTextureTail({
			pixelFormat: 'PF_BC1',
			importedWidth: 4,
			importedHeight: 4,
			mips: [
				{
					width: 4,
					height: 4,
					bulkFlags: BULKDATA_ForceInlinePayload,
					inlineData: new Uint8Array(8),
				},
			],
		});
		// bIsVirtual lives 8 bytes before the end (8 bytes of noneNameId after it).
		const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
		v.setUint32(tail.length - 12, 1, true);
		expect(() => parseTexturePlatformDataFromTail(tail)).toThrowError(/virtual textures/);
	});
});

describe('getMipBytes / readMipFromUbulk', () => {
	it('returns inline bytes verbatim when location is uexp-inline', () => {
		const data = new Uint8Array([1, 2, 3, 4]);
		const tail = buildTextureTail({
			pixelFormat: 'PF_BC1',
			importedWidth: 4,
			importedHeight: 4,
			mips: [
				{
					width: 4,
					height: 4,
					bulkFlags: BULKDATA_ForceInlinePayload,
					inlineData: data,
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		const out = getMipBytes(tpd.mips[0]!, null);
		expect(out).not.toBeNull();
		expect(Array.from(out!)).toEqual([1, 2, 3, 4]);
	});

	it('returns ubulk window when location is ubulk', () => {
		const tail = buildTextureTail({
			pixelFormat: 'PF_BC5',
			importedWidth: 16,
			importedHeight: 16,
			mips: [
				{
					width: 16,
					height: 16,
					bulkFlags: BULKDATA_PayloadAtEndOfFile | BULKDATA_PayloadInSeperateFile,
					dataSize: 4,
					offset: 8,
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		const ubulk = new Uint8Array(64);
		ubulk.set([0x10, 0x20, 0x30, 0x40], 8);
		const out = readMipFromUbulk(tpd.mips[0]!, ubulk)!;
		expect(Array.from(out)).toEqual([0x10, 0x20, 0x30, 0x40]);
	});

	it('throws when ubulk slice would go out of range', () => {
		const tail = buildTextureTail({
			pixelFormat: 'PF_BC5',
			importedWidth: 16,
			importedHeight: 16,
			mips: [
				{
					width: 16,
					height: 16,
					bulkFlags: BULKDATA_PayloadAtEndOfFile | BULKDATA_PayloadInSeperateFile,
					dataSize: 1000,
					offset: 0,
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		expect(() => readMipFromUbulk(tpd.mips[0]!, new Uint8Array(64))).toThrowError(
			/outside the .ubulk range/,
		);
	});

	it('getMipBytes returns null when ubulk required but not provided', () => {
		const tail = buildTextureTail({
			pixelFormat: 'PF_BC5',
			importedWidth: 16,
			importedHeight: 16,
			mips: [
				{
					width: 16,
					height: 16,
					bulkFlags: BULKDATA_PayloadAtEndOfFile | BULKDATA_PayloadInSeperateFile,
					dataSize: 4,
					offset: 0,
				},
			],
		});
		const tpd = parseTexturePlatformDataFromTail(tail);
		expect(getMipBytes(tpd.mips[0]!, null)).toBeNull();
	});
});
