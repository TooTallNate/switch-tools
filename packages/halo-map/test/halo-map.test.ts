import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	decodeBitmap,
	decodeSoundClip,
	decodeXboxAdpcm,
	fourcc,
	isHaloMap,
	parseBitmapTag,
	parseHaloMap,
	parseModelTag,
	parseSoundTag,
	readHaloMap,
	unswizzle,
} from '../src/index.js';

const IDX = 0x1000;
const BASE = 0x803a6000;
const DATA_SIZE = 0xa00;
const PIXELS = 0x800;
const SAMPLES = 0x900;

/** Little-endian fourcc value as stored in the tag array. */
const cc = (s: string) => (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);

/** Morton (NV2A) index of (x, y) for a 4×4 texture. */
const morton4 = (x: number, y: number) => (x & 1) | ((y & 1) << 1) | ((x & 2) << 1) | ((y & 2) << 2);

/** A decompressed Xbox map with one `bitm`, one `snd!` and one `mode` tag. */
function buildMap(): Uint8Array {
	const b = new Uint8Array(IDX + DATA_SIZE);
	const v = new DataView(b.buffer);
	const ascii = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
	};
	const addr = (off: number) => BASE + (off - IDX);
	const refl = (o: number, count: number, target: number) => {
		v.setUint32(o, count, true);
		v.setUint32(o + 4, addr(target), true);
	};

	// Header.
	ascii(0, 'daeh');
	v.setUint32(4, 5, true);
	v.setUint32(8, b.length, true);
	v.setUint32(0x10, IDX, true);
	v.setUint32(0x14, DATA_SIZE, true);
	ascii(0x20, 'test');
	ascii(0x40, '01.10.12.2276');
	v.setUint32(0x60, 1, true);
	ascii(0x7fc, 'toof');

	// Bitmap pixels: 4×4 A8R8G8B8, swizzled. Texel (x, y) = (r=x*60, g=y*60, b=7, a=255).
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			const o = PIXELS + morton4(x, y) * 4;
			b[o] = 7; // B
			b[o + 1] = y * 60; // G
			b[o + 2] = x * 60; // R
			b[o + 3] = 255; // A
		}
	}
	// One mono Xbox ADPCM block: predictor 1000, step index 0, all-zero nibbles.
	v.setInt16(SAMPLES, 1000, true);

	// Tag index header + 3 entries.
	v.setUint32(IDX, addr(IDX + 0x24), true);
	v.setUint32(IDX + 4, 0xe1740000, true);
	v.setUint32(IDX + 0x0c, 3, true);
	ascii(IDX + 0x20, 'sgat');
	const tags: [string, string, number, number][] = [
		['bitm', 'ui\\bitmaps\\logo', 0x200, 0xe1740000],
		['snd!', 'sound\\sfx\\beep', 0x300, 0xe1750001],
		['mode', 'scenery\\box\\box', 0x600, 0xe1760002],
	];
	tags.forEach(([cls, path, data, id], i) => {
		const e = IDX + 0x24 + i * 32;
		v.setUint32(e, cc(cls), true);
		v.setUint32(e + 4, 0xffffffff, true);
		v.setUint32(e + 8, 0xffffffff, true);
		v.setUint32(e + 0x0c, id, true);
		const name = IDX + 0x100 + i * 0x40;
		ascii(name, path);
		v.setUint32(e + 0x10, addr(name), true);
		v.setUint32(e + 0x14, addr(IDX + data), true);
	});

	// bitm: bitmap data reflexive → one 4×4 swizzled a8r8g8b8.
	refl(IDX + 0x200 + 0x60, 1, IDX + 0x280);
	const bd = IDX + 0x280;
	ascii(bd, 'mtib');
	v.setUint16(bd + 4, 4, true);
	v.setUint16(bd + 6, 4, true);
	v.setUint16(bd + 8, 1, true);
	v.setUint16(bd + 0x0a, 0, true); // 2d
	v.setUint16(bd + 0x0c, 11, true); // a8r8g8b8
	v.setUint16(bd + 0x0e, 1 << 3, true); // swizzled
	v.setUint16(bd + 0x14, 1, true);
	v.setUint32(bd + 0x18, PIXELS, true);
	v.setUint32(bd + 0x1c, 64, true);

	// snd!: 22050 Hz mono Xbox ADPCM, one pitch range, one permutation.
	const snd = IDX + 0x300;
	v.setUint16(snd + 0x04, 13, true);
	v.setUint16(snd + 0x6e, 1, true);
	refl(snd + 0x98, 1, IDX + 0x400);
	ascii(IDX + 0x400, 'default');
	v.setUint16(IDX + 0x400 + 0x2c, 1, true);
	refl(IDX + 0x400 + 0x3c, 1, IDX + 0x480);
	const perm = IDX + 0x480;
	ascii(perm, 'beep');
	v.setUint16(perm + 0x28, 1, true);
	v.setUint16(perm + 0x2a, 0xffff, true);
	v.setUint32(perm + 0x40, 36, true);
	v.setUint32(perm + 0x48, SAMPLES, true);

	// mode: one geometry, one strip part with a 4-vertex quad.
	const mode = IDX + 0x600;
	v.setFloat32(mode + 0x30, 1, true);
	v.setFloat32(mode + 0x34, 1, true);
	refl(mode + 0xd0, 1, IDX + 0x700);
	refl(IDX + 0x700 + 0x24, 1, IDX + 0x740);
	const part = IDX + 0x740;
	v.setUint16(part + 0x44, 1, true); // strip
	v.setUint32(part + 0x48, 2, true); // 4 indices
	v.setUint32(part + 0x4c, addr(IDX + 0x800), true);
	v.setUint16(part + 0x54, 5, true); // compressed model vertices
	v.setUint32(part + 0x58, 4, true);
	v.setUint32(part + 0x64, addr(IDX + 0x820), true);
	[0, 1, 2, 3].forEach((n, i) => v.setUint16(IDX + 0x800 + i * 2, n, true));
	v.setUint32(IDX + 0x820 + 4, addr(IDX + 0x840), true);
	const quad = [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
		[1, 1, 0],
	];
	quad.forEach(([x, y, z], i) => {
		const o = IDX + 0x840 + i * 32;
		v.setFloat32(o, x, true);
		v.setFloat32(o + 4, y, true);
		v.setFloat32(o + 8, z, true);
		v.setUint32(o + 0x0c, (511 << 22) >>> 0, true); // normal (0, 0, 1)
		v.setInt16(o + 0x18, x * 32767, true);
		v.setInt16(o + 0x1a, y * 32767, true);
	});
	return b;
}

/** Xbox on-disc layout: raw header + zlib body + zero sector padding. */
function compress(map: Uint8Array): Uint8Array {
	const body = deflateSync(map.subarray(0x800));
	const out = new Uint8Array(0x800 + body.length + 2048);
	out.set(map.subarray(0, 0x800), 0);
	out.set(body, 0x800);
	return out;
}

describe('halo-map', () => {
	const plain = buildMap();

	it('detects cache files', () => {
		expect(isHaloMap(plain)).toBe(true);
		expect(isHaloMap(new Uint8Array(16))).toBe(false);
		expect(fourcc(cc('snd!'))).toBe('snd!');
		expect(fourcc(0xffffffff)).toBe('');
	});

	it('inflates Xbox maps despite trailing sector padding', async () => {
		const bytes = await readHaloMap(new Blob([compress(plain)]));
		expect(Buffer.from(bytes).equals(Buffer.from(plain))).toBe(true);
	});

	it('parses the tag index', () => {
		const map = parseHaloMap(plain);
		expect(map.header).toMatchObject({ version: 5, name: 'test', build: '01.10.12.2276', compressed: true });
		expect(map.tags.map((t) => [t.tagClass, t.path])).toEqual([
			['bitm', 'ui\\bitmaps\\logo'],
			['snd!', 'sound\\sfx\\beep'],
			['mode', 'scenery\\box\\box'],
		]);
		expect(map.tagById(0xe1750001)?.tagClass).toBe('snd!');
	});

	it('decodes swizzled bitmaps', () => {
		const map = parseHaloMap(plain);
		const [bm] = parseBitmapTag(map, map.tags[0]);
		expect(bm).toMatchObject({ width: 4, height: 4, format: 'a8r8g8b8', type: '2d', swizzled: true });
		const img = decodeBitmap(map, bm);
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) {
				const o = (y * 4 + x) * 4;
				expect([...img.pixels.subarray(o, o + 4)]).toEqual([x * 60, y * 60, 7, 255]);
			}
		}
	});

	it('unswizzles non-square textures', () => {
		// 4×2: Morton interleaves x0, y0, x1.
		const src = Uint8Array.from([0, 1, 4, 5, 2, 3, 6, 7]);
		expect([...unswizzle(src, 4, 2, 1)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('decodes Xbox ADPCM sounds to WAV', () => {
		const map = parseHaloMap(plain);
		const sound = parseSoundTag(map, map.tags[1])!;
		expect(sound).toMatchObject({ sampleRate: 22050, channels: 1, format: 'xbox-adpcm', soundClass: 13 });
		expect(sound.clips).toHaveLength(1);
		expect(sound.clips[0]).toMatchObject({ name: 'default / beep', pieces: [{ offset: SAMPLES, size: 36 }] });
		const wav = decodeSoundClip(map, sound, sound.clips[0]);
		const dv = new DataView(wav.buffer);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
		expect(dv.getUint32(24, true)).toBe(22050);
		expect(dv.getUint32(40, true)).toBe(65 * 2);
		// All-zero nibbles at step index 0 add nothing: the predictor holds.
		for (let i = 0; i < 65; i++) expect(dv.getInt16(44 + i * 2, true)).toBe(1000);
	});

	it('interleaves stereo ADPCM channels', () => {
		const block = new Uint8Array(72);
		const dv = new DataView(block.buffer);
		dv.setInt16(0, 100, true);
		dv.setInt16(4, -100, true);
		const pcm = decodeXboxAdpcm(block, 2);
		expect(pcm).toHaveLength(130);
		expect([pcm[0], pcm[1], pcm[128], pcm[129]]).toEqual([100, -100, 100, -100]);
	});

	it('decodes compressed model geometry from strips', () => {
		const map = parseHaloMap(plain);
		const model = parseModelTag(map, map.tags[2])!;
		expect(model.geometries).toEqual([0]);
		expect(model.parts).toHaveLength(1);
		const [part] = model.parts;
		expect([...part.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
		// Strip 0,1,2,3 → (0,1,2) and the odd triangle flipped to (2,1,3).
		expect([...part.indices]).toEqual([0, 1, 2, 2, 1, 3]);
		expect([...part.normals.subarray(0, 3)]).toEqual([0, 0, 1]);
		expect(part.uvs[2]).toBeCloseTo(1);
	});
});
