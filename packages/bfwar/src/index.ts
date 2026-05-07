/**
 * BFWAR — wave archive (`FWAR` magic). A simple two-block
 * NintendoWare container that bundles N inline BFWAVs:
 *
 *   ┌─────────────────────────────┐
 *   │ FWAR header           (~64) │  magic, BOM, version, file_size,
 *   │                             │  num_blocks, block table
 *   ├─────────────────────────────┤
 *   │ INFO block (id 0x6800)      │  count + N × SizedReference
 *   │                             │  (each ref → one inner FWAV)
 *   ├─────────────────────────────┤
 *   │ FILE block (id 0x6801)      │  concatenated FWAV payloads,
 *   │                             │  each padded to 0x20 alignment
 *   └─────────────────────────────┘
 *
 * Each INFO entry's `offset` is **relative to the FILE block
 * payload** (i.e. relative to `file_block_offset + 0x08`). BFWARs
 * don't store names for their inner waves — callers should number
 * them sequentially or look up names from the host BFSAR's STRG.
 *
 * References:
 *   - https://github.com/Gota7/Citric-Composer (SoundWaveArchive.cs)
 *   - https://github.com/KillzXGaming/Switch-Toolbox audio archive code
 */

/** ASCII "FWAR" — file magic at offset 0. */
export const BFWAR_MAGIC = 'FWAR';

const HEADER_MIN_SIZE = 0x14;
const BLOCK_ID_INFO = 0x6800;
const BLOCK_ID_FILE = 0x6801;

export type Endian = 'big' | 'little';

/**
 * One inline file entry from a BFWAR. The `data` Blob points
 * directly at the inner BFWAV's bytes inside the source archive
 * — feed it to `parseBfwav` (or just download it as `.bfwav`).
 */
export interface BfwarEntry {
	/** Sequential file index, 0-based. */
	index: number;
	/** Absolute byte offset of the inner FWAV in the source `Blob`. */
	offset: number;
	/** Size of the inner FWAV in bytes. */
	size: number;
	/**
	 * Sniffed magic of the inner file (almost always `'FWAV'`, but
	 * BFWAR is in principle a generic file container so we record
	 * whatever we see). `null` if unreadable.
	 */
	innerMagic: string | null;
	/** Lazy `Blob` view of the inner file. */
	data: Blob;
}

export interface ParsedBfwar {
	endian: Endian;
	version: number;
	fileSize: number;
	blockCount: number;
	entries: BfwarEntry[];
}

/** Cheap (4-byte) magic check. */
export async function isBfwar(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x46 /* F */ &&
		head[1] === 0x57 /* W */ &&
		head[2] === 0x41 /* A */ &&
		head[3] === 0x52 /* R */
	);
}

/**
 * Parse a BFWAR archive. Reads the header + INFO block (typically
 * a few hundred bytes total) and exposes each inner FWAV as a lazy
 * `Blob` slice into the source.
 */
export async function parseBfwar(blob: Blob): Promise<ParsedBfwar> {
	if (blob.size < HEADER_MIN_SIZE) {
		throw new Error(
			`Blob too small to be a BFWAR (${blob.size} bytes, need at least ${HEADER_MIN_SIZE})`,
		);
	}
	const head = new Uint8Array(
		await blob.slice(0, HEADER_MIN_SIZE).arrayBuffer(),
	);
	if (
		head[0] !== 0x46 ||
		head[1] !== 0x57 ||
		head[2] !== 0x41 ||
		head[3] !== 0x52
	) {
		throw new Error('Bad BFWAR magic');
	}
	const bomBE = head[4] === 0xfe && head[5] === 0xff;
	const bomLE = head[4] === 0xff && head[5] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid BFWAR byte-order mark: 0x${head[4].toString(16)}${head[5].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;
	const v0 = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const headerSize = v0.getUint16(6, isLittle);
	const version = v0.getUint32(8, isLittle);
	const fileSize = v0.getUint32(0x0c, isLittle);
	const blockCount = v0.getUint16(0x10, isLittle);
	if (blockCount < 2 || blockCount > 8) {
		throw new Error(`Implausible BFWAR block count: ${blockCount}`);
	}
	if (headerSize < HEADER_MIN_SIZE || headerSize > 0x100) {
		throw new Error(`Implausible BFWAR header size: 0x${headerSize.toString(16)}`);
	}

	const fullHeader = new Uint8Array(
		await blob.slice(0, headerSize).arrayBuffer(),
	);
	const v = new DataView(
		fullHeader.buffer,
		fullHeader.byteOffset,
		fullHeader.byteLength,
	);
	let infoOffset = 0;
	let infoSize = 0;
	let fileOffset = 0;
	for (let i = 0; i < blockCount; i++) {
		const o = 0x14 + i * 0x0c;
		if (o + 0x0c > fullHeader.length) break;
		const id = v.getUint16(o, isLittle);
		const off = v.getInt32(o + 4, isLittle);
		const size = v.getUint32(o + 8, isLittle);
		if (id === BLOCK_ID_INFO) {
			infoOffset = off;
			infoSize = size;
		} else if (id === BLOCK_ID_FILE) {
			fileOffset = off;
		}
	}
	if (!infoOffset || !fileOffset) {
		throw new Error('BFWAR missing INFO or FILE block');
	}
	const infoBytes = new Uint8Array(
		await blob.slice(infoOffset, infoOffset + infoSize).arrayBuffer(),
	);
	const iv = new DataView(
		infoBytes.buffer,
		infoBytes.byteOffset,
		infoBytes.byteLength,
	);
	if (
		infoBytes[0] !== 0x49 ||
		infoBytes[1] !== 0x4e ||
		infoBytes[2] !== 0x46 ||
		infoBytes[3] !== 0x4f
	) {
		throw new Error('Bad BFWAR INFO magic');
	}
	const count = iv.getUint32(0x08, isLittle);
	if (count > 0x10000) {
		throw new Error(`Implausible BFWAR file count: ${count}`);
	}
	const fileDataBase = fileOffset + 0x08;
	const entries: BfwarEntry[] = [];
	for (let i = 0; i < count; i++) {
		const eo = 0x0c + i * 0x0c;
		if (eo + 0x0c > infoBytes.length) break;
		// SizedReference: u16 typeId / u16 pad / s32 offset / u32 size.
		const typeId = iv.getUint16(eo, isLittle);
		const offsetRel = iv.getInt32(eo + 4, isLittle);
		const sz = iv.getUint32(eo + 8, isLittle);
		if (offsetRel === -1 || sz === 0 || typeId === 0) {
			// Null entry — preserve the slot so caller indices line up
			// with BFSAR file references that reach into this archive.
			entries.push({
				index: i,
				offset: 0,
				size: 0,
				innerMagic: null,
				data: new Blob([]),
			});
			continue;
		}
		const absStart = fileDataBase + offsetRel;
		const absEnd = absStart + sz;
		const safeEnd = absEnd > blob.size ? blob.size : absEnd;
		// Sniff the inner magic so the UI can label entries; this is a
		// 4-byte read and avoids materialising the whole inner file.
		let innerMagic: string | null = null;
		if (absStart + 4 <= blob.size) {
			const head4 = new Uint8Array(
				await blob.slice(absStart, absStart + 4).arrayBuffer(),
			);
			innerMagic = String.fromCharCode(
				head4[0],
				head4[1],
				head4[2],
				head4[3],
			);
		}
		entries.push({
			index: i,
			offset: absStart,
			size: sz,
			innerMagic,
			data: blob.slice(absStart, safeEnd),
		});
	}
	return {
		endian,
		version,
		fileSize,
		blockCount,
		entries,
	};
}
