/**
 * SEAD (`.sab` / `.mab`) container parser.
 *
 * On-disk layout:
 *
 *   header (16 bytes + descriptor padded to next 16):
 *     0x00  4   magic            "sabf" or "mabf"
 *     0x04  1   versionMain      typically 0x02
 *     0x05  1   versionSub
 *     0x06  2   endian           0x0000=LE, 0x1000=BE
 *     0x08  1   sectionsCount    3 for .mab, 4 for .sab
 *     0x09  1   descriptorLen    (0 means 0x0F)
 *     0x0A  2   reserved
 *     0x0C  4   fileSize         must equal real size
 *     0x10  N   descriptor       ASCII, NUL-padded
 *                                (pad to next 16-byte boundary)
 *
 *   section table (16 bytes per entry):
 *     0x00  4   magic            "snd " / "seq " / "trk " / "mtrl"
 *                                ("musc" / "inst" / "mtrl" for .mab)
 *     0x04  1   version
 *     0x05  1   reserved
 *     0x06  2   entrySize        = 16
 *     0x08  4   offsetInFile     offset to section start, relative to file
 *     0x0C  4   reserved
 *
 *   per-section chunk header (at offsetInFile):
 *     0x00  1   version
 *     0x01  1   reserved
 *     0x02  2   size
 *     0x04  2   entryCount
 *     0x06  2   reserved
 *     0x08  N   array of u32 entry offsets, each relative to chunk start
 *
 *   "mtrl" entry (the playable audio stream):
 *     0x00  1   version
 *     0x01  1   reserved
 *     0x02  2   size             (typically 0x20 + extradata)
 *     0x04  1   channelCount
 *     0x05  1   codec            see SEAD_CODEC table
 *     0x06  2   mtrlNumber
 *     0x08  4   sampleRate
 *     0x0C  4   loopStartSamples
 *     0x10  4   loopEndSamples   (0 = no loop)
 *     0x14  4   extraDataSize
 *     0x18  4   streamSize
 *     0x1C  2   extraDataId      (HCA: low byte is XOR key start)
 *     0x1E  2   reserved
 *     0x20  N   extraData (codec-specific subheader)
 *     +N    M   streamData (the encoded codec payload)
 */

import { SEAD_CODEC, SEAD_XOR_KEY, codecName } from './codec-table.js';

export const SEAD_MAGIC_SAB = 0x66626173; // "sabf" LE
export const SEAD_MAGIC_MAB = 0x6662616d; // "mabf" LE

export class SeadParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SeadParseError';
	}
}

export interface SeadHeader {
	/** "sabf" or "mabf" */
	magic: 'sabf' | 'mabf';
	versionMain: number;
	versionSub: number;
	bigEndian: boolean;
	sectionsCount: number;
	descriptor: string;
	fileSize: number;
	/** Offset within the SOURCE BUFFER where the SEAD magic begins. */
	sourceOffset: number;
}

export interface SeadSectionEntry {
	magic: string;
	version: number;
	entrySize: number;
	offsetInFile: number;
}

export interface SeadMaterial {
	/** Index within the materials section. */
	index: number;
	/** Best-effort name derived from descriptor + index. */
	name: string;
	/** Codec ID (see SEAD_CODEC). */
	codec: number;
	codecLabel: string;
	channelCount: number;
	sampleRate: number;
	loopStart: number;
	loopEnd: number;
	hasLoop: boolean;
	/** The encoded codec payload, ready for downstream decode. */
	streamData: Uint8Array;
	/**
	 * Format-specific extras pulled from the codec's subheader.
	 * Always present but its shape depends on the codec — see
	 * {@link HcaExtras} et al.
	 */
	extras: HcaExtras | OggVorbisExtras | Atrac9Extras | GenericExtras;
}

export interface HcaExtras {
	codec: 'hca';
	hcaHeaderSize: number;
	frameSize: number;
	encrypted: boolean;
	keyStart: number;
	/** The HCA payload with the optional XOR already removed. */
	decryptedHca: Uint8Array;
}

export interface OggVorbisExtras {
	codec: 'ogg-vorbis';
	loopStartByte: number;
	loopEndByte: number;
	totalSamples: number;
	headerSize: number;
	seekTableSize: number;
}

export interface Atrac9Extras {
	codec: 'atrac9';
	blockAlign: number;
	blockSamples: number;
	channelMask: number;
	configData: number;
	samples: number;
	overlapDelay: number;
	encoderDelay: number;
	sampleRate: number;
	loopStart: number;
	loopEnd: number;
}

export interface GenericExtras {
	codec: 'pcm16le' | 'ms-adpcm' | 'xma2' | 'ms-mp3' | 'switch-opus' | 'dummy' | string;
	/** Raw subheader bytes for codecs we haven't specialised. */
	rawSubheader: Uint8Array;
}

export interface ParsedSead {
	header: SeadHeader;
	sections: SeadSectionEntry[];
	/** All entries from the `"mtrl"` section. */
	materials: SeadMaterial[];
}

/**
 * Scan `bytes` for the SEAD magic. Returns the offset where the
 * magic starts, or -1 if not found. Most file-on-disk SEAD blobs
 * have the magic at offset 0; Unity TextAsset wrappers and UE
 * uasset chunks can push it forward by a few bytes.
 */
export function findSeadMagic(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = Math.min(bytes.length - 16, 0x10000); // cap the scan
	for (let i = 0; i + 16 <= bytes.length && i < end; i++) {
		const m = view.getUint32(i, true);
		if (m === SEAD_MAGIC_SAB || m === SEAD_MAGIC_MAB) {
			// Validate by checking fileSize at +0x0C matches the remaining bytes.
			const fileSize = view.getUint32(i + 0x0c, true);
			if (fileSize === bytes.length - i) return i;
		}
	}
	// Fallback: looser scan — accept the magic even if fileSize
	// doesn't match (some Unity exports have trailing garbage).
	for (let i = 0; i + 16 <= bytes.length && i < end; i++) {
		const m = view.getUint32(i, true);
		if (m === SEAD_MAGIC_SAB || m === SEAD_MAGIC_MAB) return i;
	}
	return -1;
}

export function isSead(bytes: Uint8Array): boolean {
	return findSeadMagic(bytes) >= 0;
}

function readMagic4(view: DataView, off: number): string {
	let s = '';
	for (let i = 0; i < 4; i++) {
		const b = view.getUint8(off + i);
		if (b === 0) break;
		s += String.fromCharCode(b);
	}
	return s;
}

function readCString(bytes: Uint8Array, off: number, maxLen: number): string {
	let end = off;
	while (end < off + maxLen && bytes[end] !== 0) end++;
	return new TextDecoder('latin1').decode(bytes.subarray(off, end));
}

/**
 * Parse a SEAD container. If the magic isn't at offset 0, scans
 * up to 64 KB into the buffer for it (handles Unity TextAsset
 * wrap with arbitrary leading metadata).
 */
export function parseSead(bytes: Uint8Array): ParsedSead {
	const sourceOffset = findSeadMagic(bytes);
	if (sourceOffset < 0) {
		throw new SeadParseError('SEAD magic ("sabf" / "mabf") not found in buffer');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magicValue = view.getUint32(sourceOffset, true);
	const magic: 'sabf' | 'mabf' =
		magicValue === SEAD_MAGIC_SAB ? 'sabf' : 'mabf';
	const versionMain = view.getUint8(sourceOffset + 0x04);
	const versionSub = view.getUint8(sourceOffset + 0x05);
	const endianFlag = view.getUint16(sourceOffset + 0x06, true);
	const bigEndian = endianFlag === 0x1000;
	if (bigEndian) {
		throw new SeadParseError(
			'Big-endian SEAD files are not currently supported (only seen on PS3/360 ports)',
		);
	}
	const sectionsCount = view.getUint8(sourceOffset + 0x08);
	let descriptorLen = view.getUint8(sourceOffset + 0x09);
	if (descriptorLen === 0) descriptorLen = 0x0f;
	const fileSize = view.getUint32(sourceOffset + 0x0c, true);
	const descriptor = readCString(bytes, sourceOffset + 0x10, descriptorLen);
	const headerSize = 16 + descriptorLen + (16 - (descriptorLen % 16));

	const header: SeadHeader = {
		magic,
		versionMain,
		versionSub,
		bigEndian,
		sectionsCount,
		descriptor,
		fileSize,
		sourceOffset,
	};

	// Section table
	const sections: SeadSectionEntry[] = [];
	const sectionTableStart = sourceOffset + headerSize;
	for (let i = 0; i < sectionsCount; i++) {
		const off = sectionTableStart + i * 16;
		const secMagic = readMagic4(view, off);
		const version = view.getUint8(off + 0x04);
		const entrySize = view.getUint16(off + 0x06, true);
		const offsetInFile = view.getUint32(off + 0x08, true);
		sections.push({
			magic: secMagic,
			version,
			entrySize,
			offsetInFile,
		});
	}

	// Find the materials section.
	const mtrlSection = sections.find((s) => s.magic.startsWith('mtrl'));
	if (!mtrlSection) {
		throw new SeadParseError('No "mtrl" section in SEAD file');
	}
	const mtrlChunkStart = sourceOffset + mtrlSection.offsetInFile;
	const mtrlEntryCount = view.getUint16(mtrlChunkStart + 0x04, true);
	const materials: SeadMaterial[] = [];
	for (let i = 0; i < mtrlEntryCount; i++) {
		const relOff = view.getUint32(mtrlChunkStart + 0x10 + i * 4, true);
		// Dummy / deleted slot sentinel.
		if (relOff >= fileSize) continue;
		const matAbs = mtrlChunkStart + relOff;
		const mat = parseMaterial(bytes, view, matAbs, descriptor, i);
		if (mat) materials.push(mat);
	}

	return { header, sections, materials };
}

function parseMaterial(
	bytes: Uint8Array,
	view: DataView,
	abs: number,
	descriptor: string,
	index: number,
): SeadMaterial | null {
	if (abs + 0x20 > bytes.length) return null;
	const channelCount = view.getUint8(abs + 0x04);
	const codec = view.getUint8(abs + 0x05);
	const sampleRate = view.getUint32(abs + 0x08, true);
	const loopStart = view.getUint32(abs + 0x0c, true);
	const loopEnd = view.getUint32(abs + 0x10, true);
	const extraDataSize = view.getUint32(abs + 0x14, true);
	const streamSize = view.getUint32(abs + 0x18, true);
	const extraDataId = view.getUint16(abs + 0x1c, true);
	const extraOff = abs + 0x20;
	const streamOff = extraOff + extraDataSize;

	if (streamOff + streamSize > bytes.length) return null;

	const name = `${descriptor || 'mtrl'}/${index.toString().padStart(4, '0')}`;
	let streamData = bytes.subarray(streamOff, streamOff + streamSize);
	let extras: SeadMaterial['extras'];

	switch (codec) {
		case SEAD_CODEC.HCA: {
			const hcaHeaderSize = view.getUint16(extraOff + 0x02, true);
			const frameSize = view.getUint16(extraOff + 0x04, true);
			const encryptedByte = view.getUint8(extraOff + 0x0d);
			const encrypted = encryptedByte !== 0;
			const keyStart = extraDataId & 0xff;
			// The HCA payload (header + frames) starts at extraOff + 0x10
			// and continues into streamData. We want one contiguous blob.
			const hcaStart = extraOff + 0x10;
			const hcaTotalLen = streamOff + streamSize - hcaStart;
			const hcaRaw = bytes.subarray(hcaStart, hcaStart + hcaTotalLen);
			let decryptedHca = hcaRaw;
			if (encrypted) {
				decryptedHca = new Uint8Array(hcaRaw);
				// Header is plain; XOR only the frames that follow.
				for (let j = hcaHeaderSize; j < decryptedHca.length; j++) {
					decryptedHca[j]! ^=
						SEAD_XOR_KEY[(keyStart + (j - hcaHeaderSize)) % 256]!;
				}
			}
			extras = {
				codec: 'hca',
				hcaHeaderSize,
				frameSize,
				encrypted,
				keyStart,
				decryptedHca,
			};
			// For HCA, `streamData` overlaps with the HCA payload — we
			// keep it pointing at the codec data slice for raw export.
			streamData = decryptedHca;
			break;
		}
		case SEAD_CODEC.OGG_VORBIS: {
			const loopStartByte = view.getUint32(extraOff + 0x04, true);
			const loopEndByte = view.getUint32(extraOff + 0x08, true);
			const totalSamples = view.getUint32(extraOff + 0x0c, true);
			const headerSize = view.getUint32(extraOff + 0x10, true);
			const seekTableSize = view.getUint32(extraOff + 0x14, true);
			extras = {
				codec: 'ogg-vorbis',
				loopStartByte,
				loopEndByte,
				totalSamples,
				headerSize,
				seekTableSize,
			};
			break;
		}
		case SEAD_CODEC.ATRAC9: {
			extras = {
				codec: 'atrac9',
				blockAlign: view.getUint16(extraOff + 0x04, true),
				blockSamples: view.getUint16(extraOff + 0x06, true),
				channelMask: view.getUint32(extraOff + 0x08, true),
				configData: view.getUint32(extraOff + 0x0c, true),
				samples: view.getUint32(extraOff + 0x10, true),
				overlapDelay: view.getUint32(extraOff + 0x14, true),
				encoderDelay: view.getUint32(extraOff + 0x18, true),
				sampleRate: view.getUint32(extraOff + 0x1c, true),
				loopStart: view.getUint32(extraOff + 0x20, true),
				loopEnd: view.getUint32(extraOff + 0x24, true),
			};
			break;
		}
		default: {
			extras = {
				codec: codecName(codec),
				rawSubheader: bytes.subarray(extraOff, extraOff + extraDataSize),
			};
			break;
		}
	}

	return {
		index,
		name,
		codec,
		codecLabel: codecName(codec),
		channelCount,
		sampleRate,
		loopStart,
		loopEnd,
		hasLoop: loopEnd > 0,
		streamData,
		extras,
	};
}
