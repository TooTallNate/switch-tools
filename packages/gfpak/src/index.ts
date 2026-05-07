/**
 * GFLXPACK (`.gfpak`) — Game Freak's archive format.
 *
 * Used by Game Freak's Switch titles as the master container for
 * game assets — BNTX textures, .gfbmdl models,
 * .gfbanm animations, shaders, and so on. The format is built
 * around 64-bit FNV-1a hashes for both folder and file names; the
 * actual path strings are not stored, which means we can't
 * reconstruct a real path tree without an out-of-band hash
 * dictionary.
 *
 * What we *can* do is:
 *
 *   - List the file count, folder count, and per-folder file index
 *     ranges.
 *   - Decompress each entry's payload (LZ4 or raw — Zlib and Oodle
 *     compression types exist in the format spec but are uncommon
 *     in Switch shipped content).
 *   - Sniff the inner-file magic so callers can route entries to
 *     BNTX / BFRES / SARC / etc. previews even without a name.
 *   - For BNTX / BFRES / BNSH / BFSHA payloads the inner file's
 *     name lives at offset `0x10 + read_u32(0x10)` — we surface
 *     that as the entry's "embedded name" so file lists are at
 *     least partially human-readable.
 *
 * Wire layout:
 *
 *   0x00  char[8]  magic = "GFLXPACK"
 *   0x08  u32      version (0x100 = uncompressed; 0x1000 = Oodle build)
 *   0x0C  u32      padding
 *   0x10  u32      file_count
 *   0x14  u32      folder_count
 *   0x18  u64      file_info_offset
 *   0x20  u64      hash_array_offset (count × u64 path hashes)
 *   0x28  u64      folder_array_offset (count × Folder)
 *
 *   Folder = u64 hash + u32 fileCount + u32 padding
 *          + fileCount × { u64 fileHash, u32 index, u32 padding }
 *
 *   File info (24 bytes per entry):
 *     u16 level (always 9?)
 *     u16 compression_type (0=None, 1=Zlib, 2=LZ4, 3=Oodle)
 *     u32 decompressed_size
 *     u32 compressed_size
 *     u32 padding
 *     u64 file_offset (absolute, inside the source `Blob`)
 *
 * References (read line-by-line):
 *   - https://github.com/KillzXGaming/Switch-Toolbox `GFPAK.cs`
 *   - https://github.com/kwsch/pkNX `GFPack.cs`
 *   - https://github.com/anderlli0053/quickbms_scripts `pokemon_gflxpack.bms`
 */

import { decodeBlock as decodeLz4Block } from '@tootallnate/lz4';

export const GFPAK_MAGIC = 'GFLXPACK';

export enum GfpakCompression {
	None = 0,
	Zlib = 1,
	Lz4 = 2,
	Oodle = 3,
}

export interface GfpakFolder {
	/** Sequential index in the folder table. */
	index: number;
	/** FNV-1a 64-bit hash of the folder path. */
	hash: bigint;
	/** Indices of files belonging to this folder, in declaration order. */
	fileIndices: number[];
	/** FNV-1a 64-bit hashes of the per-file names within this folder. */
	fileHashes: bigint[];
}

export interface GfpakEntry {
	/** Sequential index in the file table. */
	index: number;
	/** FNV-1a 64-bit hash of the full path (folder + filename). */
	pathHash: bigint;
	/** Per-folder file-name hash, when known (otherwise the empty bigint). */
	fileHash: bigint;
	/** Hash of the parent folder, when known. */
	folderHash: bigint;
	/**
	 * "Embedded name" — for binary formats that store their original
	 * filename inside the payload (BNTX, BFRES, BNSH, BFSHA), this is
	 * that name. Empty string for everything else.
	 */
	embeddedName: string;
	/**
	 * Sniffed magic of the (decompressed) inner file. e.g. `'BNTX'`,
	 * `'FRES'`, `'YB'` for BYAML, `'SARC'`. `null` if too small or
	 * unreadable.
	 */
	innerMagic: string | null;
	/**
	 * Conventional file extension based on inner magic (`bntx`,
	 * `bfres`, `byaml`, `sarc`, `bin`, …).
	 */
	innerExt: string;
	/** Compression type from the file info block. */
	compression: GfpakCompression;
	/** Decompressed payload size. */
	decompressedSize: number;
	/** Compressed payload size on disk. */
	compressedSize: number;
	/** Absolute byte offset in the source `Blob` of the compressed payload. */
	dataOffset: number;
	/**
	 * Lazy decoder for this entry. Reads the compressed bytes from
	 * the source `Blob` and decompresses them, returning a fresh
	 * `Blob` of the inner payload.
	 */
	getData(): Promise<Blob>;
	/**
	 * Synthetic display name combining the inner format hint, the
	 * embedded name (when available), and the path hash. Used by
	 * archive UIs that need a readable fallback when the real path
	 * isn't recoverable.
	 */
	displayName: string;
}

export interface ParsedGfpak {
	version: number;
	fileCount: number;
	folderCount: number;
	folders: GfpakFolder[];
	entries: GfpakEntry[];
}

const HEADER_SIZE = 0x30;

/** Cheap (8-byte) magic check. */
export async function isGfpak(blob: Blob): Promise<boolean> {
	if (blob.size < 8) return false;
	const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
	const magic = new TextDecoder('ascii').decode(head);
	return magic === GFPAK_MAGIC;
}

/**
 * Parse a GFLXPACK archive. Reads the header, folder table, hash
 * array, and file-info block (typically a few KB even for huge
 * archives) and exposes each entry as a lazy decompress-on-demand
 * `getData()` callback.
 *
 * Throws for unsupported compression types (Zlib, Oodle) only when
 * the user actually tries to read an entry — listing the archive
 * works regardless.
 */
export async function parseGfpak(blob: Blob): Promise<ParsedGfpak> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a GFPAK (${blob.size} bytes, need at least ${HEADER_SIZE})`,
		);
	}
	const head = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
	const magic = new TextDecoder('ascii').decode(head.subarray(0, 8));
	if (magic !== GFPAK_MAGIC) {
		throw new Error(`Bad GFPAK magic: "${magic}"`);
	}
	const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const version = v.getUint32(0x08, true);
	const fileCount = v.getUint32(0x10, true);
	const folderCount = v.getUint32(0x14, true);
	const fileInfoOffset = Number(v.getBigUint64(0x18, true));
	const hashArrayOffset = Number(v.getBigUint64(0x20, true));
	const folderArrayOffset = Number(v.getBigUint64(0x28, true));
	if (fileCount > 0x100000) {
		throw new Error(`Implausible GFPAK file count: ${fileCount}`);
	}
	if (folderCount > 0x10000) {
		throw new Error(`Implausible GFPAK folder count: ${folderCount}`);
	}

	// --- Folder table: variable-length, walk sequentially. ---
	// Each folder header is 16 bytes (hash u64, count u32, pad u32),
	// followed by `count` × 16-byte entries (file hash u64, idx u32,
	// pad u32). To know the total size we need to walk it, so just
	// slurp from `folderArrayOffset` to the start of the next section
	// (whichever comes first: hashArrayOffset or fileInfoOffset).
	const folderEnd = Math.min(
		hashArrayOffset > folderArrayOffset ? hashArrayOffset : Number.MAX_SAFE_INTEGER,
		fileInfoOffset > folderArrayOffset ? fileInfoOffset : Number.MAX_SAFE_INTEGER,
		blob.size,
	);
	const folderBytes = new Uint8Array(
		await blob.slice(folderArrayOffset, folderEnd).arrayBuffer(),
	);
	const fv = new DataView(
		folderBytes.buffer,
		folderBytes.byteOffset,
		folderBytes.byteLength,
	);
	const folders: GfpakFolder[] = new Array(folderCount);
	const fileIndexToFolder = new Map<number, GfpakFolder>();
	const fileIndexHashInFolder = new Map<number, bigint>();
	let cursor = 0;
	for (let i = 0; i < folderCount; i++) {
		if (cursor + 16 > folderBytes.length) {
			throw new Error(`GFPAK folder table truncated at folder ${i}`);
		}
		const hash = fv.getBigUint64(cursor, true);
		const count = fv.getUint32(cursor + 8, true);
		cursor += 16;
		const fileIndices: number[] = new Array(count);
		const fileHashes: bigint[] = new Array(count);
		for (let j = 0; j < count; j++) {
			if (cursor + 16 > folderBytes.length) {
				throw new Error(
					`GFPAK folder ${i} file table truncated at entry ${j}`,
				);
			}
			const fileHash = fv.getBigUint64(cursor, true);
			const idx = fv.getUint32(cursor + 8, true);
			cursor += 16;
			fileIndices[j] = idx;
			fileHashes[j] = fileHash;
		}
		const folder: GfpakFolder = { index: i, hash, fileIndices, fileHashes };
		folders[i] = folder;
		for (let j = 0; j < count; j++) {
			fileIndexToFolder.set(fileIndices[j], folder);
			fileIndexHashInFolder.set(fileIndices[j], fileHashes[j]);
		}
	}

	// --- Hash array: fileCount × u64 ---
	const hashBytes = new Uint8Array(
		await blob
			.slice(hashArrayOffset, hashArrayOffset + fileCount * 8)
			.arrayBuffer(),
	);
	const hv = new DataView(
		hashBytes.buffer,
		hashBytes.byteOffset,
		hashBytes.byteLength,
	);
	const pathHashes: bigint[] = new Array(fileCount);
	for (let i = 0; i < fileCount; i++) {
		pathHashes[i] = hv.getBigUint64(i * 8, true);
	}

	// --- File info: fileCount × 24 bytes ---
	const fileInfoBytes = new Uint8Array(
		await blob
			.slice(fileInfoOffset, fileInfoOffset + fileCount * 24)
			.arrayBuffer(),
	);
	const iv = new DataView(
		fileInfoBytes.buffer,
		fileInfoBytes.byteOffset,
		fileInfoBytes.byteLength,
	);

	const entries: GfpakEntry[] = new Array(fileCount);
	for (let i = 0; i < fileCount; i++) {
		const fo = i * 24;
		// const level = iv.getUint16(fo, true); // always 9 in shipped content
		const compType = iv.getUint16(fo + 2, true) as GfpakCompression;
		const decompressedSize = iv.getUint32(fo + 4, true);
		const compressedSize = iv.getUint32(fo + 8, true);
		// const padding = iv.getUint32(fo + 12, true);
		const dataOffset = Number(iv.getBigUint64(fo + 16, true));
		const folder = fileIndexToFolder.get(i);
		const entry: GfpakEntry = {
			index: i,
			pathHash: pathHashes[i],
			fileHash: fileIndexHashInFolder.get(i) ?? 0n,
			folderHash: folder?.hash ?? 0n,
			embeddedName: '',
			innerMagic: null,
			innerExt: 'bin',
			compression: compType,
			decompressedSize,
			compressedSize,
			dataOffset,
			displayName: '',
			getData: async () =>
				decompressEntry(
					blob,
					dataOffset,
					compressedSize,
					decompressedSize,
					compType,
				),
		};
		entries[i] = entry;
	}

	// --- Sniff inner magic and embedded names for each entry. ---
	// We do this in one pass so the caller gets nicely-labelled
	// entries without having to wait for a separate per-file
	// inspection step.
	for (const entry of entries) {
		const sniff = await sniffEntry(blob, entry);
		entry.innerMagic = sniff.magic;
		entry.innerExt = sniff.ext;
		entry.embeddedName = sniff.embeddedName;
		entry.displayName = synthesizeDisplayName(entry);
	}

	return { version, fileCount, folderCount, folders, entries };
}

/**
 * Map a sniffed inner magic string to a conventional file
 * extension. Covers the formats Game Freak commonly bundles into a
 * GFPAK; falls through to `bin` for everything else.
 */
function extForMagic(magic: string | null): string {
	if (!magic) return 'bin';
	switch (magic) {
		case 'BNTX':
			return 'bntx';
		case 'FRES':
			return 'bfres';
		case 'BNSH':
			return 'bnsh';
		case 'FSHA':
			return 'bfsha';
		case 'SARC':
			return 'sarc';
		case 'Yaz0':
			return 'szs';
		case 'BY':
		case 'YB':
			return 'byaml';
		case 'FFNT':
			return 'bffnt';
		case 'FSTM':
			return 'bfstm';
		case 'FWAV':
			return 'bfwav';
		case 'VFXB':
			return 'ptcl';
		case 'AAMP':
			return 'aamp';
		default:
			return 'bin';
	}
}

interface SniffResult {
	magic: string | null;
	ext: string;
	embeddedName: string;
}

const FORMATS_WITH_EMBEDDED_NAME = new Set([
	'BNTX',
	'FRES',
	'BNSH',
	'FSHA',
]);

async function sniffEntry(blob: Blob, entry: GfpakEntry): Promise<SniffResult> {
	if (entry.decompressedSize < 4) {
		return { magic: null, ext: 'bin', embeddedName: '' };
	}
	// For uncompressed entries we can sniff directly from the source
	// Blob without decompressing. For compressed entries we have to
	// decompress at least the first few hundred bytes — but since
	// the embedded-name pointer is at offset 0x10 and most names
	// are short, peeking at the first 4 KB is plenty.
	let head: Uint8Array;
	if (entry.compression === GfpakCompression.None) {
		head = new Uint8Array(
			await blob
				.slice(entry.dataOffset, entry.dataOffset + Math.min(4096, entry.decompressedSize))
				.arrayBuffer(),
		);
	} else if (entry.compression === GfpakCompression.Lz4) {
		// Decompress just enough to read 4 KB of the inner payload.
		// LZ4's block decoder won't stop early though, so we have to
		// decode the whole thing. For massive entries we'd want a
		// smarter strategy, but in practice GFPAK entries
		// max out around a few MB.
		try {
			const full = await readDecompressedAsBytes(blob, entry);
			head = full.subarray(0, Math.min(4096, full.length));
		} catch {
			return { magic: null, ext: 'bin', embeddedName: '' };
		}
	} else {
		// Zlib / Oodle — we can't sniff without a decompressor.
		return { magic: null, ext: 'bin', embeddedName: '' };
	}
	const magic4 = new TextDecoder('ascii').decode(head.subarray(0, 4));
	let magic: string | null;
	if (head[0] === 0x59 && head[1] === 0x42) magic = 'YB';
	else if (head[0] === 0x42 && head[1] === 0x59) magic = 'BY';
	else if (/^[A-Z][A-Za-z0-9 ]{3}$/.test(magic4)) magic = magic4;
	else magic = null;
	const ext = extForMagic(magic);
	let embeddedName = '';
	if (magic && FORMATS_WITH_EMBEDDED_NAME.has(magic) && head.length >= 0x14) {
		const nameOffset = new DataView(
			head.buffer,
			head.byteOffset,
			head.byteLength,
		).getUint32(0x10, true);
		if (nameOffset > 0 && nameOffset + 1 < head.length) {
			let end = nameOffset;
			while (end < head.length && head[end] !== 0 && end - nameOffset < 256) {
				end++;
			}
			embeddedName = new TextDecoder('utf-8').decode(
				head.subarray(nameOffset, end),
			);
		}
	}
	return { magic, ext, embeddedName };
}

async function decompressEntry(
	blob: Blob,
	dataOffset: number,
	compressedSize: number,
	decompressedSize: number,
	compression: GfpakCompression,
): Promise<Blob> {
	const compBytes = new Uint8Array(
		await blob.slice(dataOffset, dataOffset + compressedSize).arrayBuffer(),
	);
	switch (compression) {
		case GfpakCompression.None:
			return new Blob([compBytes as BlobPart]);
		case GfpakCompression.Lz4: {
			const dec = decodeLz4Block(compBytes, decompressedSize);
			return new Blob([dec as BlobPart]);
		}
		case GfpakCompression.Zlib:
			throw new Error(
				'GFPAK Zlib compression is not yet supported in this package. ' +
					'Switch shipped content uses LZ4; Zlib appears in older 3DS-era files.',
			);
		case GfpakCompression.Oodle:
			throw new Error(
				'GFPAK Oodle compression is not supported. Oodle is a proprietary ' +
					"codec that requires Epic's `oo2core` library.",
			);
		default:
			throw new Error(
				`Unknown GFPAK compression type ${compression}`,
			);
	}
}

async function readDecompressedAsBytes(
	blob: Blob,
	entry: GfpakEntry,
): Promise<Uint8Array> {
	const data = await decompressEntry(
		blob,
		entry.dataOffset,
		entry.compressedSize,
		entry.decompressedSize,
		entry.compression,
	);
	return new Uint8Array(await data.arrayBuffer());
}

function synthesizeDisplayName(entry: GfpakEntry): string {
	const folderHex = entry.folderHash
		? `0x${entry.folderHash.toString(16).padStart(16, '0')}`
		: 'unknown';
	const fileHex = `0x${entry.pathHash.toString(16).padStart(16, '0')}`;
	const name = entry.embeddedName ? `${entry.embeddedName}.${entry.innerExt}` : `${fileHex}.${entry.innerExt}`;
	return `${folderHex}/${name}`;
}
