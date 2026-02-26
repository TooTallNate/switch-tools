/**
 * IVFC (Integrity Verification File Collection) hash tree builder.
 *
 * Used in Nintendo Switch NCA RomFS sections. Builds a 6-level SHA-256
 * hash tree where each level is the hash table of the level below it.
 *
 * Level 6 = actual data (RomFS)
 * Level 5 = SHA-256 hashes of level 6 blocks
 * Level 4 = SHA-256 hashes of level 5 blocks
 * ...
 * Level 1 = SHA-256 hashes of level 2 blocks
 * Master hash = SHA-256 of level 1
 *
 * Block size is 0x4000 (16KB) for all levels.
 *
 * Reference: hacbrewpack/ivfc.c, hacbrewpack/ivfc.h
 */

/** IVFC hash block size: 2^14 = 0x4000 = 16384 bytes */
export const IVFC_HASH_BLOCK_SIZE = 0x4000;

/** Number of IVFC levels (excluding the data level) */
const IVFC_NUM_LEVELS = 6;

/** IVFC magic: "IVFC" */
const IVFC_MAGIC = 0x43465649;

/** IVFC version identifier */
const IVFC_ID = 0x20000;

/** SHA-256 hash size */
const HASH_SIZE = 0x20;

/** IVFC header size: 0xE0 bytes */
export const IVFC_HEADER_SIZE = 0xe0;

/**
 * Align a value up to the given alignment.
 */
function align(value: number, alignment: number): number {
	const mask = alignment - 1;
	return (value + mask) & ~mask;
}

/**
 * SHA-256 hash a Uint8Array using Web Crypto.
 */
async function sha256(
	data: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	const hash = await crypto.subtle.digest('SHA-256', data);
	return new Uint8Array(hash);
}

/**
 * Create an IVFC level: hash each block of the source data with SHA-256.
 * Returns the hash data padded to the IVFC block size boundary.
 *
 * Optimized: hashes all blocks in parallel via Promise.all to reduce
 * per-block async overhead, and avoids redundant zero-fill for full blocks.
 */
async function createLevel(
	sourceData: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<{ hashes: Uint8Array; hashDataSize: number }> {
	const blockSize = IVFC_HASH_BLOCK_SIZE;
	const sourceSize = sourceData.length;

	// Calculate number of blocks and hash table size
	const numBlocks = Math.ceil(sourceSize / blockSize);
	const hashDataSize = numBlocks * HASH_SIZE;

	// Pad to block size boundary
	const paddedSize = align(hashDataSize, blockSize);
	const hashes = new Uint8Array(paddedSize);

	// Hash all blocks in parallel
	const hashPromises: Promise<Uint8Array>[] = [];
	for (let i = 0; i < numBlocks; i++) {
		const offset = i * blockSize;
		const remaining = sourceSize - offset;
		const readSize = Math.min(remaining, blockSize);

		if (readSize === blockSize) {
			// Full block — hash the subarray directly (no copy needed)
			hashPromises.push(
				sha256(sourceData.subarray(offset, offset + blockSize), crypto)
			);
		} else {
			// Partial (last) block — zero-pad a copy
			const block = new Uint8Array(blockSize);
			block.set(sourceData.subarray(offset, offset + readSize));
			hashPromises.push(sha256(block.subarray(0, readSize), crypto));
		}
	}

	const hashResults = await Promise.all(hashPromises);
	for (let i = 0; i < numBlocks; i++) {
		hashes.set(hashResults[i], i * HASH_SIZE);
	}

	return { hashes, hashDataSize };
}

/**
 * Result of building an IVFC hash tree.
 */
export interface IvfcResult {
	/** The IVFC header (0xE0 bytes) including the master hash */
	header: ArrayBuffer;

	/** Level data arrays, from level 1 (top) to level 5 (bottom).
	 *  Level 6 is the original data and is not included here. */
	levels: Uint8Array[];

	/** Total size of all level data (levels 1-5) */
	totalLevelSize: number;
}

/**
 * Build an IVFC hash tree from source data (typically a RomFS image).
 *
 * @param data - The source data (level 6). Must already be padded to IVFC_HASH_BLOCK_SIZE.
 * @param crypto - Optional Crypto implementation
 * @returns IVFC header and all intermediate level data
 */
export async function build(
	data: Uint8Array,
	crypto: Crypto = globalThis.crypto
): Promise<IvfcResult> {
	// Build levels from bottom (6) to top (1)
	// Level 6 = data, Level 5 = hashes of level 6, ..., Level 1 = hashes of level 2
	const levelData: Uint8Array[] = [];
	const levelHashDataSizes: number[] = [];
	const levelPaddedSizes: number[] = [];

	let currentSource = data;

	for (let level = 0; level < IVFC_NUM_LEVELS - 1; level++) {
		const { hashes, hashDataSize } = await createLevel(
			currentSource,
			crypto
		);
		levelData.unshift(hashes); // Prepend (we're building bottom-up but storing top-down)
		levelHashDataSizes.unshift(hashDataSize);
		levelPaddedSizes.unshift(hashes.length);
		currentSource = hashes;
	}

	// Calculate master hash = SHA-256 of level 1 (the top level, which is levelData[0])
	const masterHash = await sha256(levelData[0], crypto);

	// Build the IVFC header (0xE0 bytes)
	const header = new ArrayBuffer(IVFC_HEADER_SIZE);
	const view = new DataView(header);

	// IVFC header fields
	view.setUint32(0x00, IVFC_MAGIC, true); // magic = "IVFC"
	view.setUint32(0x04, IVFC_ID, true); // id = 0x20000
	view.setUint32(0x08, HASH_SIZE, true); // master_hash_size = 0x20
	view.setUint32(0x0c, IVFC_NUM_LEVELS + 1, true); // num_levels = 7 (6 hash levels + 1 data level)

	// Level headers (6 entries, each 0x18 bytes, starting at offset 0x10)
	// These describe levels 1-6 (level 6 = data itself)
	// The logical_offset for each level is the cumulative offset of all previous levels
	let logicalOffset = 0;
	for (let i = 0; i < IVFC_NUM_LEVELS - 1; i++) {
		const entryOffset = 0x10 + i * 0x18;
		const dataSize = levelPaddedSizes[i];

		// logical_offset (8 bytes)
		view.setBigUint64(entryOffset + 0x00, BigInt(logicalOffset), true);
		// hash_data_size (8 bytes)
		view.setBigUint64(entryOffset + 0x08, BigInt(dataSize), true);
		// block_size (4 bytes) — log2 of the block size
		view.setUint32(entryOffset + 0x10, 0x0e, true); // 2^14 = 0x4000
		// reserved (4 bytes) — already zero

		logicalOffset += dataSize;
	}

	// Level 6 entry (the actual data)
	{
		const entryOffset = 0x10 + (IVFC_NUM_LEVELS - 1) * 0x18;
		view.setBigUint64(entryOffset + 0x00, BigInt(logicalOffset), true);
		view.setBigUint64(entryOffset + 0x08, BigInt(data.length), true);
		view.setUint32(entryOffset + 0x10, 0x0e, true);
	}

	// Master hash at offset 0xC0 (0x20 bytes)
	new Uint8Array(header, 0xc0, HASH_SIZE).set(masterHash);

	// Calculate total level size
	let totalLevelSize = 0;
	for (const level of levelData) {
		totalLevelSize += level.length;
	}

	return {
		header,
		levels: levelData,
		totalLevelSize,
	};
}
