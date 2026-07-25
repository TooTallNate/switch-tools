/**
 * GameCube disc images (GCM / ISO).
 *
 * A GameCube disc opens with a 0x440-byte boot header, followed by
 * disc metadata, the apploader, the main executable, and a flat
 * filesystem table:
 *
 *   0x0000  boot.bin      game code, title, and the offsets below
 *   0x0440  bi2.bin       disc metadata (country, debug settings)
 *   0x2440  apploader     the loader the IPL runs to boot the game
 *   ...     main.dol      the game executable
 *   ...     FST           the filesystem table
 *
 * The FST is an array of 12-byte entries followed by a string table.
 * Rather than nesting, directories are expressed as ranges: a
 * directory entry records the index one past its last descendant, so
 * the tree is recovered by walking the flat array and tracking where
 * each directory ends. Entry 0 is the root, and its "next index" is
 * the total entry count — which is how a reader learns the table's
 * length in the first place.
 *
 * All integers are big-endian.
 *
 * Data is read through a caller-supplied {@link DiscReader}, so the
 * same parser serves a plain ISO on disk and a compressed RVZ image
 * being reconstructed on the fly.
 *
 * References:
 *   - https://www.gc-forever.com/yagcd/chap13.html (YAGCD, disc format)
 */

/** Reads `length` bytes at `offset` from a disc image. */
export type DiscReader = (
	offset: number,
	length: number,
) => Promise<Uint8Array>;

/** Magic at offset 0x1C of every GameCube disc. */
export const GCM_MAGIC = 0xc233_9f3d;

/** Offsets of the fixed structures. */
export const BOOT_SIZE = 0x440;
export const BI2_OFFSET = 0x440;
export const BI2_SIZE = 0x2000;
export const APPLOADER_OFFSET = 0x2440;

/**
 * Offset of the NKit marker.
 *
 * NKit is a shrinking format for GameCube/Wii images. Its defining trick is that
 * it isn't a wrapper: the original disc header stays at offset 0, so an NKit
 * image still looks and parses exactly like a plain disc. The marker is tucked
 * into the header's reserved area at 0x200, which a real disc leaves zeroed.
 */
export const NKIT_MARKER_OFFSET = 0x200;
/** Bytes per FST entry. */
export const FST_ENTRY_SIZE = 12;

function readU32(b: Uint8Array, o: number): number {
	return (
		((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
	);
}

/** `boot.bin` — the disc header. */
export interface GcmHeader {
	/** Six-character code, e.g. `GZLE01`. */
	gameId: string;
	/** Four-character game code portion. */
	gameCode: string;
	/** Two-character publisher code. */
	makerCode: string;
	discNumber: number;
	version: number;
	audioStreaming: boolean;
	/** Full game title from the header. */
	title: string;
	magicValid: boolean;
	/** Offset of the main executable (`main.dol`). */
	dolOffset: number;
	/** Offset of the filesystem table. */
	fstOffset: number;
	fstSize: number;
	maxFstSize: number;
	userPosition: number;
	userLength: number;
}

function decodeString(bytes: Uint8Array): string {
	let end = bytes.length;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) {
			end = i;
			break;
		}
	}
	let out = '';
	for (let i = 0; i < end; i++) {
		const c = bytes[i];
		// Titles are ASCII in practice; keep anything printable and
		// drop control bytes rather than emitting replacement chars.
		out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
	}
	return out.trim();
}

/** Parse the 0x440-byte boot header. */
export function parseGcmHeader(bytes: Uint8Array): GcmHeader {
	if (bytes.length < BOOT_SIZE) {
		throw new Error(
			`GCM: need ${BOOT_SIZE} bytes of boot header, got ${bytes.length}`,
		);
	}
	const gameCode = decodeString(bytes.subarray(0, 4));
	const makerCode = decodeString(bytes.subarray(4, 6));
	return {
		gameId: decodeString(bytes.subarray(0, 6)),
		gameCode,
		makerCode,
		discNumber: bytes[6],
		version: bytes[7],
		audioStreaming: bytes[8] !== 0,
		title: decodeString(bytes.subarray(0x20, 0x400)),
		magicValid: readU32(bytes, 0x1c) === GCM_MAGIC,
		dolOffset: readU32(bytes, 0x420),
		fstOffset: readU32(bytes, 0x424),
		fstSize: readU32(bytes, 0x428),
		maxFstSize: readU32(bytes, 0x42c),
		userPosition: readU32(bytes, 0x430),
		userLength: readU32(bytes, 0x434),
	};
}

/** Cheap check for a GameCube disc image. */
export function isGcm(bytes: Uint8Array): boolean {
	return bytes.length >= 0x20 && readU32(bytes, 0x1c) === GCM_MAGIC;
}

/** One node in the disc filesystem. */
export interface NkitInfo {
	/** Version string as stored, e.g. `'v01'`. */
	version: string;
	/**
	 * Size of the original, un-shrunk disc image. A standard GameCube disc is
	 * 1,459,978,240 bytes; the shrunk file will be smaller by however much junk
	 * was removed.
	 */
	originalSize: number;
}

/**
 * Detect and parse the NKit marker.
 *
 * `bytes` needs to cover at least `NKIT_MARKER_OFFSET + 0x14`. Returns `null`
 * for a plain image, which is the common case.
 *
 * Layout at 0x200: the ASCII text `NKIT` and a space, a version string, two
 * checksum-ish words we don't interpret, then the original image size at 0x210.
 */
export function parseNkitInfo(bytes: Uint8Array): NkitInfo | null {
	const at = NKIT_MARKER_OFFSET;
	if (bytes.length < at + 0x14) return null;
	if (
		bytes[at] !== 0x4e || // 'N'
		bytes[at + 1] !== 0x4b || // 'K'
		bytes[at + 2] !== 0x49 || // 'I'
		bytes[at + 3] !== 0x54 // 'T'
	) {
		return null;
	}
	let version = '';
	for (let i = at + 5; i < at + 8; i++) {
		const c = bytes[i];
		if (c >= 0x20 && c < 0x7f) version += String.fromCharCode(c);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { version, originalSize: view.getUint32(at + 0x10, false) };
}

export interface GcmEntry {
	name: string;
	/** Full path from the disc root, without a leading slash. */
	path: string;
	isDirectory: boolean;
	/** Files only: byte offset on the disc. */
	offset: number;
	/** Files only: byte length. */
	size: number;
	/** Index of this entry in the flat FST. */
	index: number;
	/** Directories only: children, in FST order. */
	children: GcmEntry[];
}

/**
 * Parse the FST into a tree.
 *
 * `fst` must hold the whole table: the entries *and* the string table
 * that follows them. Sizes come from {@link GcmHeader.fstSize}.
 */
export function parseFst(fst: Uint8Array): GcmEntry[] {
	if (fst.length < FST_ENTRY_SIZE) return [];
	// The root's "next index" field doubles as the entry count.
	const entryCount = readU32(fst, 8);
	if (entryCount === 0 || entryCount > 0x100000) return [];
	const stringTableOffset = entryCount * FST_ENTRY_SIZE;
	if (stringTableOffset > fst.length) return [];

	const nameAt = (nameOffset: number): string => {
		const start = stringTableOffset + nameOffset;
		if (start >= fst.length) return '';
		let end = start;
		while (end < fst.length && fst[end] !== 0) end++;
		return decodeString(fst.subarray(start, end));
	};

	/**
	 * Walk entries `[from, until)` as the contents of one directory.
	 *
	 * Directories declare where their subtree ends, so recursion is a
	 * matter of consuming that range rather than following pointers.
	 */
	const walk = (from: number, until: number, parentPath: string): GcmEntry[] => {
		const out: GcmEntry[] = [];
		let i = from;
		while (i < until && i < entryCount) {
			const o = i * FST_ENTRY_SIZE;
			if (o + FST_ENTRY_SIZE > fst.length) break;
			const isDirectory = fst[o] === 1;
			const nameOffset = (fst[o + 1] << 16) | (fst[o + 2] << 8) | fst[o + 3];
			const second = readU32(fst, o + 4);
			const third = readU32(fst, o + 8);
			const name = nameAt(nameOffset);
			const path = parentPath ? `${parentPath}/${name}` : name;

			if (isDirectory) {
				// `third` is the index one past the last descendant.
				const end = Math.min(third, entryCount);
				out.push({
					name,
					path,
					isDirectory: true,
					offset: 0,
					size: 0,
					index: i,
					children: walk(i + 1, end, path),
				});
				i = Math.max(end, i + 1);
			} else {
				out.push({
					name,
					path,
					isDirectory: false,
					offset: second,
					size: third,
					index: i,
					children: [],
				});
				i++;
			}
		}
		return out;
	};

	return walk(1, entryCount, '');
}

/** Everything needed to browse a disc. */
export interface GcmDisc {
	header: GcmHeader;
	/** Root-level entries. */
	entries: GcmEntry[];
	/** Total number of files (recursively). */
	fileCount: number;
	/** Total bytes across all files. */
	totalFileSize: number;
	/** Size of the apploader, from its own header. */
	apploaderSize: number;
	/** Size of `main.dol`, derived from its section table. */
	dolSize: number;
}

/**
 * Compute the size of `main.dol`.
 *
 * A DOL has no length field; its size is the furthest extent of its
 * seven text and eleven data sections, each of which records an
 * offset and a size in the 0x100-byte header.
 */
export function dolSizeFromHeader(dolHeader: Uint8Array): number {
	if (dolHeader.length < 0x100) return 0;
	let end = 0x100;
	for (let i = 0; i < 18; i++) {
		const offset = readU32(dolHeader, i * 4);
		const size = readU32(dolHeader, 0x90 + i * 4);
		if (offset > 0 && size > 0) end = Math.max(end, offset + size);
	}
	return end;
}

/** Read and parse a disc's header, apploader size, and filesystem. */
export async function parseGcm(read: DiscReader): Promise<GcmDisc> {
	const header = parseGcmHeader(await read(0, BOOT_SIZE));
	if (!header.magicValid) {
		throw new Error('GCM: missing 0xC2339F3D magic at 0x1C');
	}
	if (header.fstSize === 0 || header.fstOffset === 0) {
		throw new Error('GCM: disc header declares no filesystem table');
	}

	const fst = await read(header.fstOffset, header.fstSize);
	const entries = parseFst(fst);

	let fileCount = 0;
	let totalFileSize = 0;
	const visit = (list: GcmEntry[]) => {
		for (const e of list) {
			if (e.isDirectory) visit(e.children);
			else {
				fileCount++;
				totalFileSize += e.size;
			}
		}
	};
	visit(entries);

	// The apploader records its own size at 0x14, with a trailer at
	// 0x18 that also has to be included.
	const apploaderHeader = await read(APPLOADER_OFFSET, 0x20);
	const apploaderSize =
		0x20 + readU32(apploaderHeader, 0x14) + readU32(apploaderHeader, 0x18);

	const dolSize =
		header.dolOffset > 0
			? dolSizeFromHeader(await read(header.dolOffset, 0x100))
			: 0;

	return { header, entries, fileCount, totalFileSize, apploaderSize, dolSize };
}

/**
 * Highest byte offset reached by any file in the tree.
 *
 * This is what tells you whether an image is *addressable*. A shrunk image that
 * merely had its trailing junk removed keeps every file at its original offset,
 * so this stays inside the file and reads work unchanged. A variant that
 * compacted or reordered its interior would leave the FST describing positions
 * the file no longer has, and this would overshoot — at which point reads must
 * be refused rather than silently returning whatever now sits there.
 */
export function gcmMaxFileEnd(entries: GcmEntry[]): number {
	let max = 0;
	const visit = (list: GcmEntry[]): void => {
		for (const e of list) {
			if (e.isDirectory) visit(e.children);
			else if (e.offset + e.size > max) max = e.offset + e.size;
		}
	};
	visit(entries);
	return max;
}

/** Flatten a tree into a list of files, depth first. */
export function flattenFiles(entries: GcmEntry[]): GcmEntry[] {
	const out: GcmEntry[] = [];
	const visit = (list: GcmEntry[]) => {
		for (const e of list) {
			if (e.isDirectory) visit(e.children);
			else out.push(e);
		}
	};
	visit(entries);
	return out;
}
