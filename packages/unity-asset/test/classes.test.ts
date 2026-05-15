/**
 * Hardcoded-layout class-decoder tests.
 *
 * The on-disc layouts these readers target are stable across the
 * Unity versions we claim to support; the tests pin a few
 * representative samples so format drift is caught loudly.
 */

import { describe, expect, it } from 'vitest';
import {
	parseUnityAudioClip,
	parseUnityFont,
	parseUnityMonoScript,
	parseUnityTextAsset,
	parseUnityTexture2D,
	parseUnityVersion,
	uvAtLeast,
	uvBelow,
	UnityReader,
} from '../src/index.js';

// ---------------------------------------------------------------------
// Version-comparison helpers
// ---------------------------------------------------------------------

describe('parseUnityVersion / uvAtLeast / uvBelow', () => {
	it('parses major / minor / patch out of a full version string', () => {
		const v = parseUnityVersion('2018.4.36f1');
		expect(v.major).toBe(2018);
		expect(v.minor).toBe(4);
		expect(v.patch).toBe(36);
		expect(v.raw).toBe('2018.4.36f1');
	});

	it('parses without a build-type suffix', () => {
		const v = parseUnityVersion('2021.3.10');
		expect(v.major).toBe(2021);
		expect(v.minor).toBe(3);
		expect(v.patch).toBe(10);
	});

	it('returns a zeroed version when the string is unparseable', () => {
		const v = parseUnityVersion('garbage');
		expect(v.major).toBe(0);
		expect(v.minor).toBe(0);
		expect(v.patch).toBe(0);
	});

	it('uvAtLeast compares major / minor / patch correctly', () => {
		const v = parseUnityVersion('2020.2.3');
		expect(uvAtLeast(v, 2018)).toBe(true);
		expect(uvAtLeast(v, 2020, 2)).toBe(true);
		expect(uvAtLeast(v, 2020, 2, 3)).toBe(true);
		expect(uvAtLeast(v, 2020, 2, 4)).toBe(false);
		expect(uvAtLeast(v, 2021)).toBe(false);
		expect(uvAtLeast(v, 2017)).toBe(true);
		expect(uvAtLeast(v, 2020, 1, 99)).toBe(true);
	});

	it('uvBelow is the strict inverse of uvAtLeast', () => {
		const v = parseUnityVersion('2018.4.0');
		expect(uvBelow(v, 2020)).toBe(true);
		expect(uvBelow(v, 2018, 4)).toBe(false);
		expect(uvBelow(v, 2018, 5)).toBe(true);
	});
});

// ---------------------------------------------------------------------
// Reader primitives
// ---------------------------------------------------------------------

describe('UnityReader', () => {
	it('reads a Unity-style length-prefixed string with align-to-4 padding', () => {
		// Layout: u32 length(5) + "hello" + 3 pad bytes
		const bytes = new Uint8Array(12);
		const dv = new DataView(bytes.buffer);
		dv.setUint32(0, 5, true);
		bytes.set([0x68, 0x65, 0x6c, 0x6c, 0x6f], 4); // "hello"
		const r = new UnityReader(bytes);
		expect(r.string()).toBe('hello');
		// After read+align, offset should be at 12 (4 + 5 padded to 8).
		expect(r.offset).toBe(12);
	});

	it("read+align works even when the string's length is already aligned", () => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setUint32(0, 4, true);
		bytes.set([0x61, 0x62, 0x63, 0x64], 4); // "abcd"
		const r = new UnityReader(bytes);
		expect(r.string()).toBe('abcd');
		expect(r.offset).toBe(8);
	});

	it('reads a u32-prefixed bytes blob with align-to-4', () => {
		const bytes = new Uint8Array(12);
		new DataView(bytes.buffer).setUint32(0, 5, true);
		bytes.set([1, 2, 3, 4, 5], 4);
		const r = new UnityReader(bytes);
		const got = r.bytes_();
		expect(Array.from(got)).toEqual([1, 2, 3, 4, 5]);
		expect(r.offset).toBe(12);
	});

	it('reads i32 / u32 / i64 / u64 / f32', () => {
		const bytes = new Uint8Array(32);
		const dv = new DataView(bytes.buffer);
		dv.setInt32(0, -42, true);
		dv.setUint32(4, 0xdeadbeef, true);
		dv.setBigInt64(8, -1n, true);
		dv.setBigUint64(16, 0xfffffffffffffffen, true);
		dv.setFloat32(24, 1.5, true);
		const r = new UnityReader(bytes);
		expect(r.i32()).toBe(-42);
		expect(r.u32()).toBe(0xdeadbeef);
		expect(r.i64()).toBe(-1n);
		expect(r.u64()).toBe(0xfffffffffffffffen);
		expect(r.f32()).toBe(1.5);
	});
});

// ---------------------------------------------------------------------
// TextAsset
// ---------------------------------------------------------------------

describe('parseUnityTextAsset', () => {
	it('round-trips a small ASCII script', () => {
		const name = 'config';
		const script = 'hello\nworld\n';
		// Build the on-disc bytes manually.
		const nameBytes = new TextEncoder().encode(name);
		const scriptBytes = new TextEncoder().encode(script);
		// name string: u32 len + bytes + pad to 4
		const namePadded = (nameBytes.length + 3) & ~3;
		// script bytes: u32 len + bytes + pad to 4
		const scriptPadded = (scriptBytes.length + 3) & ~3;
		const out = new Uint8Array(4 + namePadded + 4 + scriptPadded);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, nameBytes.length, true);
		out.set(nameBytes, 4);
		dv.setUint32(4 + namePadded, scriptBytes.length, true);
		out.set(scriptBytes, 4 + namePadded + 4);
		const parsed = parseUnityTextAsset(out);
		expect(parsed.m_Name).toBe(name);
		expect(Array.from(parsed.m_Script)).toEqual(Array.from(scriptBytes));
		expect(parsed.m_ScriptAsString).toBe(script);
	});

	it('hides the UTF-8 view for binary payloads', () => {
		// Build a TextAsset whose script bytes are all high-bit
		// "control"-ish values that look like garbage to UTF-8.
		const nameBytes = new TextEncoder().encode('save');
		const scriptBytes = new Uint8Array(64).fill(0x80);
		const namePadded = (nameBytes.length + 3) & ~3;
		const scriptPadded = (scriptBytes.length + 3) & ~3;
		const out = new Uint8Array(4 + namePadded + 4 + scriptPadded);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, nameBytes.length, true);
		out.set(nameBytes, 4);
		dv.setUint32(4 + namePadded, scriptBytes.length, true);
		out.set(scriptBytes, 4 + namePadded + 4);
		const parsed = parseUnityTextAsset(out);
		expect(parsed.m_Name).toBe('save');
		expect(parsed.m_Script.length).toBe(64);
		// Garbage UTF-8 → m_ScriptAsString suppressed.
		expect(parsed.m_ScriptAsString).toBeUndefined();
	});
});

// ---------------------------------------------------------------------
// Texture2D
// ---------------------------------------------------------------------

describe('parseUnityTexture2D', () => {
	it('reads width / height / format from a Unity 2018.4 layout', () => {
		// Build a synthetic Texture2D matching what we observed
		// against kq_20.13's `UISprite` (32×32 RGBA32, streamed).
		// We assemble the bytes by hand so the test stays
		// self-contained.
		const buf: number[] = [];
		const pushU32 = (n: number) => {
			buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
		};
		const pushString = (s: string) => {
			pushU32(s.length);
			for (const c of s) buf.push(c.charCodeAt(0));
			while (buf.length % 4 !== 0) buf.push(0);
		};
		const pushBool = (b: boolean) => buf.push(b ? 1 : 0);
		const align4 = () => {
			while (buf.length % 4 !== 0) buf.push(0);
		};
		pushString('UISprite');
		pushU32(4); // m_ForcedFallbackFormat
		pushBool(false); // m_DownscaleFallback
		align4();
		pushU32(32); // m_Width
		pushU32(32); // m_Height
		pushU32(5460); // m_CompleteImageSize
		pushU32(4); // m_TextureFormat (RGBA32)
		pushU32(6); // m_MipCount
		pushBool(false); // m_IsReadable
		pushBool(false); // m_StreamingMipmaps
		align4();
		pushU32(0); // m_StreamingMipmapsPriority
		pushU32(1); // m_ImageCount
		pushU32(2); // m_TextureDimension
		// GLTextureSettings
		pushU32(1); // m_FilterMode
		pushU32(0); // m_Aniso
		pushU32(0); // m_MipBias
		pushU32(0); // m_WrapU
		pushU32(0); // m_WrapV
		pushU32(0); // m_WrapW
		pushU32(0); // m_LightmapFormat
		pushU32(0); // m_ColorSpace
		// image data size = 0 (streamed)
		pushU32(0);
		// m_StreamData
		pushU32(0); // offset
		pushU32(5460); // size
		pushString('resources.assets.resS');
		const bytes = new Uint8Array(buf);
		const t = parseUnityTexture2D(bytes, '2018.4.36f1');
		expect(t.m_Name).toBe('UISprite');
		expect(t.m_Width).toBe(32);
		expect(t.m_Height).toBe(32);
		expect(t.m_TextureFormat).toBe(4);
		expect(t.m_CompleteImageSize).toBe(5460);
		expect(t.m_MipCount).toBe(6);
		expect(t['image data'].length).toBe(0);
		expect(t.m_StreamData?.size).toBe(5460);
		expect(t.m_StreamData?.path).toBe('resources.assets.resS');
	});
});

// ---------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------

describe('parseUnityFont', () => {
	it('finds a length-prefixed OTF blob past arbitrary surrounding fields', () => {
		// Layout: name + line-spacing + 32 bytes of arbitrary fields +
		// length-prefixed payload of 4096 bytes (4 OTTO bytes + filler).
		// Crossing the MIN_FONT_BYTES = 1024 threshold ensures the
		// "tight match" first pass accepts the candidate; a tail < 64
		// bytes keeps it inside the trailer-length window.
		const buf: number[] = [];
		const pushU32 = (n: number) =>
			buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
		const pushString = (s: string) => {
			pushU32(s.length);
			for (const c of s) buf.push(c.charCodeAt(0));
			while (buf.length % 4 !== 0) buf.push(0);
		};
		pushString('MyFont');
		const f32buf = new Uint8Array(4);
		new DataView(f32buf.buffer).setFloat32(0, 1.5, true);
		for (const b of f32buf) buf.push(b);
		// 32 bytes of arbitrary mid-object fields.
		for (let i = 0; i < 32; i++) buf.push(i & 0xff);
		const fontPayload = new Uint8Array(4096);
		fontPayload.set([0x4f, 0x54, 0x54, 0x4f]);
		for (let i = 4; i < fontPayload.length; i++) fontPayload[i] = i & 0xff;
		pushU32(fontPayload.length);
		for (const b of fontPayload) buf.push(b);
		const bytes = new Uint8Array(buf);
		const f = parseUnityFont(bytes);
		expect(f.m_Name).toBe('MyFont');
		expect(f.m_FontData).toBeDefined();
		expect(Array.from(f.m_FontData!.slice(0, 4))).toEqual([
			0x4f,
			0x54,
			0x54,
			0x4f,
		]);
		expect(f.m_FontData!.length).toBe(4096);
	});

	it("ignores spurious sfnt-magic byte sequences inside other fields", () => {
		// Build a Font where the m_Name length itself looks like the
		// start of an sfnt magic. Without the "minimum font size"
		// guard the heuristic would happily return a 17-byte "font"
		// starting at the name field. Mirrors the kq_20.13's
		// `Vermin-Vibes-1989` false-positive case.
		const buf: number[] = [];
		const pushU32 = (n: number) =>
			buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
		// Name is exactly 17 chars; padded m_Name field is 4 + 20 = 24
		// bytes. Then we emit the line-spacing + 1024 bytes of
		// arbitrary data containing what LOOKS like a font header at a
		// non-aligned position.
		const name = 'A'.repeat(17);
		pushU32(name.length);
		for (const c of name) buf.push(c.charCodeAt(0));
		while (buf.length % 4 !== 0) buf.push(0);
		// m_LineSpacing
		for (let i = 0; i < 4; i++) buf.push(0);
		// 1024 bytes of arbitrary fields. Embed the false-positive
		// pattern `00 01 00 00` at a 4-byte boundary; the preceding
		// u32 names a tiny size (well below the 1024-byte minimum)
		// so the new heuristic rejects it.
		for (let i = 0; i < 1024; i++) buf.push(0);
		// Drop in a "fake" magic + tiny prefix
		const fakeOff = 100;
		buf[fakeOff - 4] = 0x40;
		buf[fakeOff - 3] = 0;
		buf[fakeOff - 2] = 0;
		buf[fakeOff - 1] = 0;
		buf[fakeOff + 0] = 0x00;
		buf[fakeOff + 1] = 0x01;
		buf[fakeOff + 2] = 0x00;
		buf[fakeOff + 3] = 0x00;
		const f = parseUnityFont(new Uint8Array(buf));
		expect(f.m_Name).toBe(name);
		// The false-positive magic at offset 100 announces 64 bytes,
		// far below MIN_FONT_BYTES = 1024 — rejected.
		expect(f.m_FontData).toBeUndefined();
	});

	it('returns no font data when no sfnt magic is present', () => {
		const buf: number[] = [];
		const pushU32 = (n: number) =>
			buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
		const pushString = (s: string) => {
			pushU32(s.length);
			for (const c of s) buf.push(c.charCodeAt(0));
			while (buf.length % 4 !== 0) buf.push(0);
		};
		pushString('Empty');
		for (let i = 0; i < 32; i++) buf.push(0);
		const f = parseUnityFont(new Uint8Array(buf));
		expect(f.m_Name).toBe('Empty');
		expect(f.m_FontData).toBeUndefined();
	});
});

// ---------------------------------------------------------------------
// AudioClip
// ---------------------------------------------------------------------

describe('parseUnityAudioClip', () => {
	it('reads channels / sample-rate / streaming-path for a Unity 5+ clip', () => {
		const buf: number[] = [];
		const pushU32 = (n: number) =>
			buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
		const pushI64 = (n: bigint) => {
			const dv = new DataView(new ArrayBuffer(8));
			dv.setBigInt64(0, n, true);
			for (let i = 0; i < 8; i++) buf.push(dv.getUint8(i));
		};
		const pushF32 = (n: number) => {
			const dv = new DataView(new ArrayBuffer(4));
			dv.setFloat32(0, n, true);
			for (let i = 0; i < 4; i++) buf.push(dv.getUint8(i));
		};
		const pushString = (s: string) => {
			pushU32(s.length);
			for (const c of s) buf.push(c.charCodeAt(0));
			while (buf.length % 4 !== 0) buf.push(0);
		};
		const pushBool = (b: boolean) => buf.push(b ? 1 : 0);
		const align4 = () => {
			while (buf.length % 4 !== 0) buf.push(0);
		};
		pushString('Footstep');
		pushU32(0); // m_LoadType
		pushU32(2); // m_Channels
		pushU32(44100); // m_Frequency
		pushU32(16); // m_BitsPerSample
		pushF32(2.5); // m_Length
		pushBool(false); // m_IsTrackerFormat
		align4();
		pushU32(-1 >>> 0); // m_SubsoundIndex
		pushBool(true); // m_PreloadAudioData
		pushBool(false); // m_LoadInBackground
		pushBool(false); // m_Legacy3D
		align4();
		pushString('sharedassets1.resource');
		pushI64(0x100n); // m_Offset
		pushI64(0x4000n); // m_Size
		pushU32(2); // m_CompressionFormat
		const a = parseUnityAudioClip(new Uint8Array(buf), '2018.4.36f1');
		expect(a.m_Name).toBe('Footstep');
		expect(a.m_Channels).toBe(2);
		expect(a.m_Frequency).toBe(44100);
		expect(a.m_BitsPerSample).toBe(16);
		expect(a.m_Length).toBe(2.5);
		expect(a.m_Source).toBe('sharedassets1.resource');
		expect(a.m_Offset).toBe(0x100n);
		expect(a.m_Size).toBe(0x4000n);
		expect(a.m_CompressionFormat).toBe(2);
	});
});

// ---------------------------------------------------------------------
// MonoScript
// ---------------------------------------------------------------------

describe('parseUnityMonoScript', () => {
	it('reads class / namespace / assembly names', () => {
		const buf: number[] = [];
		const pushU32 = (n: number) =>
			buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
		const pushI32 = (n: number) => pushU32(n >>> 0);
		const pushString = (s: string) => {
			pushU32(s.length);
			for (const c of s) buf.push(c.charCodeAt(0));
			while (buf.length % 4 !== 0) buf.push(0);
		};
		pushString('PlayerController');
		pushI32(0); // m_ExecutionOrder
		// 16-byte properties hash
		for (let i = 0; i < 16; i++) buf.push(i);
		pushString('PlayerController');
		pushString('Game');
		pushString('Assembly-CSharp.dll');
		buf.push(0); // m_IsEditorScript
		const m = parseUnityMonoScript(new Uint8Array(buf));
		expect(m.m_Name).toBe('PlayerController');
		expect(m.m_ExecutionOrder).toBe(0);
		expect(m.m_ClassName).toBe('PlayerController');
		expect(m.m_Namespace).toBe('Game');
		expect(m.m_AssemblyName).toBe('Assembly-CSharp.dll');
		expect(m.m_IsEditorScript).toBe(false);
		expect(m.m_PropertiesHash?.length).toBe(16);
	});
});
