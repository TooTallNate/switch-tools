/**
 * HCA header parser.
 *
 * Layout (big-endian fields except magic) — every chunk is keyed by
 * a 4-byte FOURCC; 3-char chunk names are null-padded to 4 bytes
 * (`fmt\0`, `dec\0`, `vbr\0`, `ath\0`, `rva\0`, `pad\0`). Encrypted
 * files have the high bit set on each FOURCC byte; we strip it at
 * compare time. Chunks always appear in this order, but the optional
 * ones (vbr, ath, loop, ciph, rva, comm, pad) may be omitted.
 *
 *   0x00  "HCA\0"          u32 magic-with-high-bits
 *   0x04  u16be version
 *   0x06  u16be dataOffset (bytes from file start to first block)
 *
 *   0x08  "fmt\0"          u32 chunk id (high-bit-keyed)
 *   0x0C  u8    channelCount
 *   0x0D  u24be samplingRate
 *   0x10  u32be blockCount
 *   0x14  u16be muteHeader
 *   0x16  u16be muteFooter
 *
 *   0x18  "comp" | "dec\0" u32 chunk id
 *         When `comp`:
 *           u16be blockSize, u8 r01..r08 + 2 reserved
 *         When `dec\0` (rare in the wild):
 *           u16be blockSize, u8 count1, u8 count2, u8 r3hi:r4lo,
 *           u8 enableCount2
 *
 *   optional "vbr\0"       u16be vbrR1 / u16be vbrR2  (var-bitrate header)
 *   optional "ath\0"       u16be athType
 *   optional "loop"        u32be loopStart, u32be loopEnd, u16be loopCount, u16be loopR1
 *   optional "ciph"        u16be ciphType
 *   optional "rva\0"       f32be volume
 *   optional "comm"        u8 commLen + commLen bytes (file comment)
 *   optional "pad\0"       — placeholder, no payload
 *
 *   then `dataOffset - 2` bytes of header, ending with a u16be CRC
 *   over everything before it.
 *
 * Ported from kohos/CriTools/src/hca.js (MIT).
 */

/** Decoded HCA header. Bit-for-bit the same fields as the on-disk form. */
export interface HcaHeader {
	version: number;
	dataOffset: number;
	channelCount: number;
	samplingRate: number;
	blockCount: number;
	muteHeader: number;
	muteFooter: number;

	/** Which `comp`/`dec ` flavour. `"comp"` is normal; `"dec "` is rare and only partially supported. */
	compdec: 'comp' | 'dec';
	blockSize: number;
	/** Common comp/dec field. */
	r01: number;
	r02: number;
	r03: number;
	r04: number;
	r05: number;
	r06: number;
	r07: number;
	r08: number;

	/** Variable-bitrate fields when the file uses VBR. */
	vbrR1: number | null;
	vbrR2: number | null;

	/** Absolute Threshold of Hearing weighting flavour. */
	athType: number;

	/** Loop region (in samples ÷ blockCount-relative). */
	loopStart: number | null;
	loopEnd: number | null;
	loopCount: number | null;

	/** Cipher type: 0 = none, 1 = static, 56 = key-derived. */
	ciphType: number;

	/** Volume multiplier from the `rva ` chunk; 1.0 when absent. */
	volume: number;

	/** Optional UTF-8 file comment from the `comm` chunk. */
	comment: string | null;
}

export class HcaHeaderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HcaHeaderError';
	}
}

/** Read a FOURCC and return whether it matches `expected` after stripping the high bit of each byte. */
function isFourCC(bytes: Uint8Array, offset: number, expected: string): boolean {
	if (offset + 4 > bytes.length) return false;
	for (let i = 0; i < 4; i++) {
		const c = bytes[offset + i]! & 0x7f;
		if (c !== expected.charCodeAt(i)) return false;
	}
	return true;
}

export function parseHcaHeader(bytes: Uint8Array): HcaHeader {
	if (bytes.length < 0x10) {
		throw new HcaHeaderError(`HCA header truncated: only ${bytes.length} bytes.`);
	}
	if (!isFourCC(bytes, 0, 'HCA\0')) {
		throw new HcaHeaderError(
			`HCA bad magic: got 0x${Array.from(bytes.subarray(0, 4))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')}`,
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	const version = dv.getUint16(0x04, false);
	const dataOffset = dv.getUint16(0x06, false);

	if (!isFourCC(bytes, 0x08, 'fmt\0')) {
		throw new HcaHeaderError(`HCA missing "fmt\\0" chunk at 0x08`);
	}
	const channelCount = bytes[0x0c]!;
	// `samplingRate` is a 24-bit BE int starting at 0x0d. The
	// canonical decode reads a 32-bit BE word at 0x0c (so the high
	// byte is `channelCount`) and masks off the top byte.
	const samplingRate = dv.getUint32(0x0c, false) & 0xffffff;
	const blockCount = dv.getUint32(0x10, false);
	const muteHeader = dv.getUint16(0x14, false);
	const muteFooter = dv.getUint16(0x16, false);
	if (channelCount < 1 || channelCount > 16) {
		throw new HcaHeaderError(`HCA invalid channelCount=${channelCount}`);
	}
	if (samplingRate < 1 || samplingRate > 0x7fffff) {
		throw new HcaHeaderError(`HCA invalid samplingRate=${samplingRate}`);
	}

	let p = 0x18;
	let compdec: 'comp' | 'dec';
	let blockSize: number;
	let r01 = 0,
		r02 = 0,
		r03 = 0,
		r04 = 0,
		r05 = 0,
		r06 = 0,
		r07 = 0,
		r08 = 0;
	if (isFourCC(bytes, p, 'comp')) {
		compdec = 'comp';
		p += 4;
		blockSize = dv.getUint16(p, false);
		p += 2;
		r01 = bytes[p++]!;
		r02 = bytes[p++]!;
		r03 = bytes[p++]!;
		r04 = bytes[p++]!;
		r05 = bytes[p++]!;
		r06 = bytes[p++]!;
		r07 = bytes[p++]!;
		r08 = bytes[p++]!;
		p += 2; // reserve1 + reserve2
	} else if (isFourCC(bytes, p, 'dec\0')) {
		compdec = 'dec';
		p += 4;
		blockSize = dv.getUint16(p, false);
		p += 2;
		r01 = bytes[p++]!; // count1
		r02 = bytes[p++]!; // count2
		const combined = bytes[p++]!;
		r03 = (combined >>> 4) & 0xf;
		r04 = combined & 0xf;
		const enableCount2 = bytes[p++]!;
		r05 = r01 + 1;
		r06 = enableCount2 ? r02 + 1 : r01 + 1;
		r07 = r05 - r06;
		r08 = 0;
	} else {
		throw new HcaHeaderError(`HCA missing "comp"/"dec\\0" chunk at 0x${p.toString(16)}`);
	}

	if (!(blockSize === 0 || (blockSize >= 1 && blockSize <= 0xffff))) {
		throw new HcaHeaderError(`HCA invalid blockSize=${blockSize}`);
	}
	if (!(r01 >= 0 && r01 <= r02 && r02 <= 0x1f)) {
		throw new HcaHeaderError(
			`HCA invalid comp ranges r01=${r01} r02=${r02}`,
		);
	}

	let vbrR1: number | null = null;
	let vbrR2: number | null = null;
	if (isFourCC(bytes, p, 'vbr\0')) {
		p += 4;
		vbrR1 = dv.getUint16(p, false);
		p += 2;
		vbrR2 = dv.getUint16(p, false);
		p += 2;
	}

	let athType: number;
	if (isFourCC(bytes, p, 'ath\0')) {
		p += 4;
		athType = dv.getUint16(p, false);
		p += 2;
	} else {
		athType = version < 0x200 ? 1 : 0;
	}

	let loopStart: number | null = null;
	let loopEnd: number | null = null;
	let loopCount: number | null = null;
	if (isFourCC(bytes, p, 'loop')) {
		p += 4;
		loopStart = dv.getUint32(p, false);
		p += 4;
		loopEnd = dv.getUint32(p, false);
		p += 4;
		loopCount = dv.getUint16(p, false);
		p += 2;
		p += 2; // loopR1
		if (
			!(
				loopStart >= 0 &&
				loopStart <= loopEnd &&
				loopEnd <= blockCount
			)
		) {
			throw new HcaHeaderError(
				`HCA invalid loop region [${loopStart}, ${loopEnd}] vs blockCount=${blockCount}`,
			);
		}
	}

	let ciphType = 0;
	if (isFourCC(bytes, p, 'ciph')) {
		p += 4;
		ciphType = dv.getUint16(p, false);
		p += 2;
		if (!(ciphType === 0 || ciphType === 1 || ciphType === 56)) {
			throw new HcaHeaderError(`HCA unknown ciphType=${ciphType}`);
		}
	}

	let volume = 1;
	if (isFourCC(bytes, p, 'rva\0')) {
		p += 4;
		volume = dv.getFloat32(p, false);
		p += 4;
	}

	let comment: string | null = null;
	if (isFourCC(bytes, p, 'comm')) {
		p += 4;
		const commLen = bytes[p++]!;
		if (commLen > 0) {
			const tail = bytes.subarray(p, p + commLen);
			comment = new TextDecoder().decode(tail).replace(/\0+$/, '');
			p += commLen;
		}
	}

	// "pad\0" has no payload; we just don't read past it.
	if (isFourCC(bytes, p, 'pad\0')) {
		p += 4;
	}

	return {
		version,
		dataOffset,
		channelCount,
		samplingRate,
		blockCount,
		muteHeader,
		muteFooter,
		compdec,
		blockSize,
		r01,
		r02,
		r03,
		r04,
		r05,
		r06,
		r07,
		r08,
		vbrR1,
		vbrR2,
		athType,
		loopStart,
		loopEnd,
		loopCount,
		ciphType,
		volume,
		comment,
	};
}

/**
 * Derive the (key1, key2) pair used by `initCiphTable(56, ...)` from
 * a user-supplied 64-bit HCA key, optionally mixed with an AWB-level
 * subkey. This is the only piece of code that needs BigInt (everything
 * else stays in 32-bit lanes).
 */
export function deriveSubkey(
	key: bigint | number,
	awbKey: number,
): { key1: number; key2: number } {
	let k = typeof key === 'bigint' ? key : BigInt(key);
	if (awbKey) {
		const mix =
			(BigInt(awbKey) << 16n) |
			BigInt(((~awbKey & 0xffff) + 2) & 0xffff);
		k = (k * mix) & 0xffffffffffffffffn;
	}
	return {
		key1: Number(k & 0xffffffffn),
		key2: Number((k >> 32n) & 0xffffffffn),
	};
}
