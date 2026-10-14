/**
 * Capcom MT Framework formats, as used by the Switch Resident Evil 0 / 1
 * HD remasters (`nativeNXx64`): ARC archives and TEX textures.
 *
 * Layouts from Lukas Cone's RevilLib (GPL; `src/arc.hpp`, `src/tex.cpp`,
 * `src/mtf_mod/*`), checked against the Switch files. All little-endian.
 *
 * - ARC (`'ARC\0'`, v7–9): u16 version, u16 count, then entries of
 *   path (64), type hash, compressed size, size (low 29 bits) + flags,
 *   [v9: an extra u32], data offset. Data is zlib unless the sizes match.
 *   Type hashes are `~crc32(className) & 0x7fffffff` (`rTexture` → `.tex`).
 * - TEX (v0xA0–0xA6): `'TEX\0'`, tier-0 bits (version 8, …, type 4 at 28),
 *   tier-1 bits (mips 6, width 13, height 13), u8 faces, u8 format,
 *   u16 depth, u32 buffer size, u32 offset per mip, then Tegra
 *   block-linear data.
 */
import { decodeBntxLayer, formatInfo, pickBlockHeight, type BntxAstcDecoder, type DecodedTexture } from '@tootallnate/bntx';

const dec = new TextDecoder('latin1');
const cstr = (b: Uint8Array, o: number, n: number) => {
	const s = b.subarray(o, o + n);
	const z = s.indexOf(0);
	return dec.decode(z >= 0 ? s.subarray(0, z) : s);
};

// ----- Hashes -----

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

/** MT Framework "jamcrc": the bit-inverted CRC-32 of the string. */
export function mtHash(s: string): number {
	let c = 0xffffffff;
	for (let i = 0; i < s.length; i++) c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
	return c >>> 0;
}

/** Type hashes of the resource classes we name. */
export const MT_TYPES: Record<number, string> = Object.fromEntries(
	[
		['rTexture', 'tex'], ['rModel', 'mod'], ['rMaterial', 'mrl'], ['rMotionList', 'lmt'], ['rEffectList', 'efl'],
		['rEffectAnim', 'ean'], ['rSoundBank', 'sbkr'], ['rSoundRequest', 'srqr'], ['rScheduler', 'sdl'], ['rCollision', 'sbc'],
		['rGUI', 'gui'], ['rGUIFont', 'gfd'], ['rMessage', 'gmd'], ['rShader', 'mfx'], ['rArchive', 'arc'], ['rChainCol', 'ccl'],
		['rChain', 'chn'], ['rSceneInfo', 'bscn'], ['rEventScript', 'bes2'], ['rSoundCurveSet', 'scs'], ['rSoundSequenceSe', 'sqs'],
		['rEffectStrip', 'efs'], ['rEffect2D', 'e2d'], ['rTextureDetailEdit', 'tde'], ['rDoorScene', 'bds2'],
	].map(([c, e]) => [mtHash(c!) & 0x7fffffff, e!]),
);

// ----- ARC -----

export interface MtArcEntry {
	/** Path with forward slashes and extension (`model/em/em02/em02.mod`). */
	name: string;
	typeHash: number;
	offset: number;
	compressedSize: number;
	size: number;
}

export function isMtArc(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x41 && head[1] === 0x52 && head[2] === 0x43 && head[3] === 0x00;
}

export function mtArcTableSize(head: Uint8Array): number {
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const version = dv.getUint16(4, true);
	const count = dv.getUint16(6, true);
	return 8 + count * (version >= 9 ? 84 : 80);
}

export function parseMtArc(bytes: Uint8Array): MtArcEntry[] {
	if (!isMtArc(bytes)) throw new Error('Not an MT Framework ARC');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint16(4, true);
	const count = dv.getUint16(6, true);
	const stride = version >= 9 ? 84 : 80;
	const out: MtArcEntry[] = [];
	const used = new Set<string>();
	for (let i = 0; i < count; i++) {
		const o = 8 + i * stride;
		const path = cstr(bytes, o, 64).replace(/\\/g, '/');
		const typeHash = dv.getUint32(o + 64, true);
		const ext = MT_TYPES[typeHash] ?? `${typeHash.toString(16).padStart(8, '0')}`;
		let name = `${path}.${ext}`;
		if (used.has(name)) name = `${path}_${i}.${ext}`;
		used.add(name);
		out.push({
			name,
			typeHash,
			compressedSize: dv.getUint32(o + 68, true),
			size: dv.getUint32(o + 72, true) & 0x1fffffff,
			offset: dv.getUint32(o + stride - 4, true),
		});
	}
	return out;
}

// ----- TEX -----

export interface MtTexInfo {
	version: number;
	width: number;
	height: number;
	mips: number;
	faces: number;
	format: number;
	cube: boolean;
	dataOffset: number;
}

export function isMtTex(head: Uint8Array): boolean {
	return head.length >= 16 && head[0] === 0x54 && head[1] === 0x45 && head[2] === 0x58 && head[3] === 0x00;
}

export function parseMtTex(bytes: Uint8Array): MtTexInfo {
	if (!isMtTex(bytes)) throw new Error('Not an MT Framework TEX');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const t0 = dv.getUint32(4, true);
	const t1 = dv.getUint32(8, true);
	const version = t0 & 0xff;
	const type = (t0 >>> 28) & 0xf;
	const mips = t1 & 0x3f;
	const width = (t1 >>> 6) & 0x1fff;
	const height = (t1 >>> 19) & 0x1fff;
	const faces = bytes[12]!;
	const format = bytes[13]!;
	const cube = type === 3;
	let o = 16;
	if (cube) o += 108; // spherical harmonics
	if (version < 0xa0) throw new Error(`MT TEX version 0x${version.toString(16)} is not supported`);
	o += 4 + mips * 4; // buffer size + mip offsets
	if (cube) o += 4;
	return { version, width, height, mips, faces, format, cube, dataOffset: o };
}

/** MT format → BNTX format code (Switch: BC4 / BC5 for the "compressed" greyscale / normal formats). */
const MT_TO_BNTX: Record<number, number> = {
	0x07: 0x0201, // R8
	0x13: 0x1a01, // BC1
	0x14: 0x1a01, // BC1A
	0x15: 0x1b01, // BC2
	0x16: 0x1b01,
	0x17: 0x1c01, // BC3
	0x18: 0x1c01,
	0x19: 0x1d01, // greyscale → BC4
	0x1e: 0x1a01, // compressed normal map (BC1)
	0x1f: 0x1e01, // derived normal map → BC5
	0x20: 0x1c01, 0x23: 0x1c01, 0x25: 0x1c01, 0x2a: 0x1c01, 0x2b: 0x1c01, 0x2f: 0x1c01,
	0x27: 0x0b01, // RGBA8
	0x28: 0x0b01,
	0x30: 0x2001, // BC7
	0x31: 0x2001, // BC7 (sRGB / premultiplied variant on Switch)
	0x37: 0x2001,
};

export function decodeMtTex(bytes: Uint8Array, astcDecoder?: BntxAstcDecoder): DecodedTexture & { format: number } {
	const t = parseMtTex(bytes);
	const code = MT_TO_BNTX[t.format];
	if (code === undefined) throw new Error(`MT TEX format 0x${t.format.toString(16)} is not supported`);
	const info = formatInfo(code);
	const hb = Math.ceil(t.height / info.blkHeight);
	const bh = pickBlockHeight(hb);
	const img = decodeBntxLayer(
		bytes,
		{
			index: 0,
			name: '',
			format: code,
			formatInfo: info,
			width: t.width,
			height: t.height,
			mipCount: t.mips,
			arrayLength: 1,
			blockHeightLog2: Math.log2(bh),
			imageSize: bytes.length - t.dataOffset,
			layerSize: bytes.length - t.dataOffset,
			mipOffset: t.dataOffset,
			srgb: info.srgb,
		},
		0,
		{ astcDecoder },
	);
	return { ...img, format: t.format };
}
