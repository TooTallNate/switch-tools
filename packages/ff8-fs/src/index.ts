/**
 * @tootallnate/ff8-fs — Final Fantasy VIII archive-triplet
 * decoder. Each "archive" is three sibling files:
 *
 *   <name>.fl — null-terminated path list, one path per entry.
 *               Paths are the original Windows-style `c:\ff8\...`
 *               that the developers used at build time.
 *   <name>.fi — index: 12 bytes per entry, packed:
 *                 u32 uncompressedSize
 *                 u32 offsetInFs
 *                 u32 compressionFlag (0 = raw, 1 = LZSS)
 *               No header / no trailer / no padding.
 *   <name>.fs — payload: concatenated per-entry data.
 *               LZSS-flagged entries are wrapped exactly like
 *               FF7's per-LGP-entry LZSS streams (4-byte
 *               little-endian declared length + Okumura window).
 *
 * Same data lives in the original PC release and in the
 * Switch Remastered RomFS under `weepff8/game_data/data/…`.
 *
 * Usage:
 *
 * ```ts
 * import { parseFf8Triplet, readEntry } from '@tootallnate/ff8-fs';
 *
 * const arc = await parseFf8Triplet(flBlob, fiBlob, fsBlob);
 * for (const entry of arc.entries) {
 *   const bytes = await readEntry(entry);
 *   // ...
 * }
 * ```
 */

import { decompressLzss } from '@tootallnate/ff7-flevel';

export const FI_ENTRY_SIZE = 12 as const;

export class Ff8FsParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Ff8FsParseError';
	}
}

export interface Ff8Entry {
	/** Original Windows-style path from the `.fl` file. */
	path: string;
	/** Same path normalised to forward-slashes + lowercased. */
	pathNormalised: string;
	/** Final path segment (lowercase). */
	basename: string;
	uncompressedSize: number;
	offsetInFs: number;
	compressionFlag: number;
	/**
	 * Read the entry's data (decompressed if needed). The caller
	 * provides the `.fs` blob each time so we don't have to
	 * retain it across nodes.
	 */
	read: (fs: Blob) => Promise<Uint8Array>;
}

export interface ParsedFf8Triplet {
	entries: Ff8Entry[];
}

function decodeFl(fl: Uint8Array): string[] {
	// FFVIII paths are null-terminated, separated by 0x00 with
	// optional trailing `\r\n` line breaks in some authoring
	// tools. Switch port observed: '\r\n'-separated text (no NUL).
	const text = new TextDecoder('latin1').decode(fl);
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.replace(/\0+$/, '');
		if (trimmed.length > 0) lines.push(trimmed);
	}
	return lines;
}

function normalisePath(p: string): string {
	return p.replace(/\\/g, '/').toLowerCase();
}

export async function parseFf8Triplet(
	fl: Blob,
	fi: Blob,
	fs: Blob,
): Promise<ParsedFf8Triplet> {
	const flBytes = new Uint8Array(await fl.arrayBuffer());
	const fiBytes = new Uint8Array(await fi.arrayBuffer());

	if (fiBytes.length % FI_ENTRY_SIZE !== 0) {
		throw new Ff8FsParseError(
			`.fi file size (${fiBytes.length}) is not a multiple of ${FI_ENTRY_SIZE}`,
		);
	}
	const entryCount = fiBytes.length / FI_ENTRY_SIZE;
	const paths = decodeFl(flBytes);
	if (paths.length !== entryCount) {
		throw new Ff8FsParseError(
			`.fl declares ${paths.length} paths but .fi declares ${entryCount} entries`,
		);
	}

	const view = new DataView(
		fiBytes.buffer,
		fiBytes.byteOffset,
		fiBytes.byteLength,
	);
	const entries: Ff8Entry[] = new Array(entryCount);
	for (let i = 0; i < entryCount; i++) {
		const off = i * FI_ENTRY_SIZE;
		const uncompressedSize = view.getUint32(off + 0, true);
		const offsetInFs = view.getUint32(off + 4, true);
		const compressionFlag = view.getUint32(off + 8, true);
		const path = paths[i]!;
		const pathNormalised = normalisePath(path);
		const slash = pathNormalised.lastIndexOf('/');
		const basename =
			slash >= 0 ? pathNormalised.slice(slash + 1) : pathNormalised;
		entries[i] = {
			path,
			pathNormalised,
			basename,
			uncompressedSize,
			offsetInFs,
			compressionFlag,
			read: async (fsBlob: Blob) => readEntry(entries[i]!, fsBlob),
		};
	}
	return { entries };
}

/**
 * Read and decompress a single entry from the `.fs` payload.
 */
export async function readEntry(entry: Ff8Entry, fs: Blob): Promise<Uint8Array> {
	// We don't know the on-disk SIZE of compressed entries from
	// the FI header — only the uncompressed size + offset. Two
	// strategies:
	//   1. For raw (compressionFlag=0): read `uncompressedSize`
	//      bytes from the offset.
	//   2. For LZSS (compressionFlag=1): the LZSS stream is
	//      prefixed with a 4-byte declared compressed-length, so
	//      we read those 4 bytes first and then `4 + length` total.
	if (entry.compressionFlag === 0) {
		const slice = fs.slice(
			entry.offsetInFs,
			entry.offsetInFs + entry.uncompressedSize,
		);
		return new Uint8Array(await slice.arrayBuffer());
	}
	if (entry.compressionFlag === 1) {
		// Read the 4-byte length prefix first.
		const head = new Uint8Array(
			await fs.slice(entry.offsetInFs, entry.offsetInFs + 4).arrayBuffer(),
		);
		const compLen =
			head[0]! | (head[1]! << 8) | (head[2]! << 16) | (head[3]! << 24);
		const compressed = new Uint8Array(
			await fs
				.slice(entry.offsetInFs, entry.offsetInFs + 4 + compLen)
				.arrayBuffer(),
		);
		return decompressLzss(compressed, { expectedSize: entry.uncompressedSize });
	}
	throw new Ff8FsParseError(
		`Unknown compressionFlag ${entry.compressionFlag} for entry ${entry.path}`,
	);
}
