// Reference: https://github.com/nicoboss/nsz
// Reference: sphaira's yati/ncz.hpp and yati/yati.cpp
//
// NCZ is a compressed NCA format. The layout is:
//
// [0x0000 - 0x3FFF]  First 0x4000 bytes of the NCA (uncompressed header)
// [0x4000]           NCZ Section Header { magic: u64, section_count: u64 }
// [0x4010]           Section[] (each 0x30 bytes)
// [variable]         Optional Block Header { magic: u64, version: u8, type: u8,
//                      padding: u8, block_size_exp: u8, block_count: u32,
//                      decompressed_size: u64 }
// [variable]         Block[] (u32 compressed sizes, if block header present)
// [variable]         Compressed data (zstd stream or individual zstd blocks)
//
// After zstd decompression, the resulting plaintext must be re-encrypted
// using AES-128-CTR with the keys and counters from the section headers
// before being written to content storage.

const NCZ_HEADER_SIZE = 0x4000;
const NCZ_SECTION_MAGIC = 0x4e54_4345_535a_434en; // "NCZESECT"
const NCZ_BLOCK_MAGIC = 0x4e43_5a42_4c4f_434bn; // "NCZBLOCK"
const NCZ_BLOCK_VERSION = 2;
const NCZ_BLOCK_TYPE = 1;

const SIZEOF_NCZ_HEADER = 16; // magic(8) + section_count(8)
const SIZEOF_NCZ_SECTION = 0x30; // offset(8) + size(8) + crypto_type(8) + padding(8) + key(16) + counter(16)
const SIZEOF_NCZ_BLOCK_HEADER = 24; // magic(8) + version(1) + type(1) + padding(1) + block_size_exp(1) + block_count(4) + decompressed_size(8)
const SIZEOF_NCZ_BLOCK_ENTRY = 4; // compressed size (u32)

// NCA encryption types (from libnx / switchbrew)
const ENCRYPTION_TYPE_AES_CTR = 3;

export interface NczSection {
	offset: bigint;
	size: bigint;
	cryptoType: bigint;
	key: Uint8Array;
	counter: Uint8Array;
}

export interface NczBlockHeader {
	version: number;
	type: number;
	blockSizeExponent: number;
	blockCount: number;
	decompressedSize: bigint;
}

export interface NczBlockInfo {
	/** Absolute byte offset of this compressed block within the NCZ file. */
	offset: number;
	/** Compressed size of this block. */
	size: number;
}

export interface NczResult {
	/** The actual NCA size derived from the NCZ metadata. */
	ncaSize: bigint;
	/** A `ReadableStream` of the decompressed and re-encrypted NCA data. */
	stream: ReadableStream<Uint8Array>;
	/** Parsed NCZ section headers. */
	sections: NczSection[];
	/** Parsed NCZ block header (if block mode). */
	blockHeader: NczBlockHeader | null;
}

/**
 * A function that decompresses a zstd-compressed `Blob` into a `Uint8Array`.
 *
 * This is used for block-mode NCZ, where each block is independently compressed.
 */
export type ZstdDecompressBlob = (blob: Blob) => Promise<Uint8Array>;

/**
 * A function that creates a `ReadableStream<Uint8Array>` of decompressed data
 * from a zstd-compressed input `ReadableStream<Uint8Array>`.
 *
 * This is used for stream-mode NCZ, where the entire body is one zstd stream.
 */
export type ZstdDecompressStream = (
	input: ReadableStream<Uint8Array>,
) => ReadableStream<Uint8Array>;

export interface NczOptions {
	/**
	 * The `Crypto` implementation to use for AES-CTR re-encryption.
	 * Defaults to `globalThis.crypto`.
	 */
	crypto?: Crypto;

	/**
	 * Decompresses a zstd-compressed `Blob` into a `Uint8Array`.
	 * Required for block-mode NCZ files.
	 *
	 * If not provided and a block-mode NCZ is encountered, an error is thrown.
	 */
	decompressBlob?: ZstdDecompressBlob;

	/**
	 * Creates a decompressed `ReadableStream` from a zstd-compressed input stream.
	 * Required for stream-mode NCZ files.
	 *
	 * If not provided and a stream-mode NCZ is encountered, an error is thrown.
	 */
	decompressStream?: ZstdDecompressStream;
}

/**
 * Decompresses an NCZ (compressed NCA) `Blob`, returning the actual NCA size
 * and a `ReadableStream` that produces the decompressed + re-encrypted NCA data.
 *
 * The stream output is a valid encrypted NCA that can be written directly to
 * Nintendo Switch content storage (NCM placeholder).
 *
 * Since zstd decompression is not universally available via the same API across
 * runtimes, the caller must provide the decompression functions via `options`.
 *
 * @example
 * ```ts
 * // nx.js runtime (has DecompressionStream('zstd'))
 * const result = await decompressNcz(blob, {
 *   decompressStream: (input) =>
 *     input.pipeThrough(new DecompressionStream('zstd')),
 *   decompressBlob: async (blob) => {
 *     const ds = new DecompressionStream('zstd');
 *     const reader = blob.stream().pipeThrough(ds).getReader();
 *     const chunks = [];
 *     let total = 0;
 *     for (;;) {
 *       const { done, value } = await reader.read();
 *       if (done) break;
 *       chunks.push(value);
 *       total += value.length;
 *     }
 *     const out = new Uint8Array(total);
 *     let off = 0;
 *     for (const c of chunks) { out.set(c, off); off += c.length; }
 *     return out;
 *   },
 * });
 * ```
 *
 * @param blob The NCZ file data.
 * @param options Configuration including zstd decompressor functions and optional `Crypto` override.
 */
export async function decompressNcz(
	blob: Blob,
	options: NczOptions,
): Promise<NczResult> {
	const cryptoProvider = options.crypto ?? globalThis.crypto;

	// 1. Read the NCA header (first 0x4000 bytes, passed through as-is)
	const ncaHeaderBlob = blob.slice(0, NCZ_HEADER_SIZE);
	const ncaHeaderBuf = await ncaHeaderBlob.arrayBuffer();

	// 2. Parse the NCZ section header
	const sectionHeaderOffset = NCZ_HEADER_SIZE;
	const sectionHeaderBuf = await blob
		.slice(sectionHeaderOffset, sectionHeaderOffset + SIZEOF_NCZ_HEADER)
		.arrayBuffer();
	const sectionHeaderView = new DataView(sectionHeaderBuf);
	const magic = sectionHeaderView.getBigUint64(0, true);
	if (magic !== NCZ_SECTION_MAGIC) {
		throw new Error(
			`Not an NCZ file (expected section magic 0x${NCZ_SECTION_MAGIC.toString(16)}, got 0x${magic.toString(16)})`,
		);
	}
	const sectionCount = Number(sectionHeaderView.getBigUint64(8, true));

	// 3. Parse section entries
	const sectionsOffset = sectionHeaderOffset + SIZEOF_NCZ_HEADER;
	const sectionsSize = sectionCount * SIZEOF_NCZ_SECTION;
	const sectionsBuf = await blob
		.slice(sectionsOffset, sectionsOffset + sectionsSize)
		.arrayBuffer();
	const sections: NczSection[] = [];
	for (let i = 0; i < sectionCount; i++) {
		const off = i * SIZEOF_NCZ_SECTION;
		const view = new DataView(sectionsBuf, off, SIZEOF_NCZ_SECTION);
		const key = new Uint8Array(
			sectionsBuf.slice(off + 0x20, off + 0x20 + 0x10),
		);
		const counter = new Uint8Array(
			sectionsBuf.slice(off + 0x20 + 0x10, off + 0x20 + 0x20),
		);
		sections.push({
			offset: view.getBigUint64(0, true),
			size: view.getBigUint64(8, true),
			cryptoType: view.getBigUint64(16, true),
			key,
			counter,
		});
	}

	// 4. Try to parse block header
	const blockHeaderOffset = sectionsOffset + sectionsSize;
	const blockHeaderBuf = await blob
		.slice(blockHeaderOffset, blockHeaderOffset + SIZEOF_NCZ_BLOCK_HEADER)
		.arrayBuffer();
	const blockHeaderView = new DataView(blockHeaderBuf);
	const blockMagic = blockHeaderView.getBigUint64(0, true);

	let blockHeader: NczBlockHeader | null = null;
	let blocks: NczBlockInfo[] = [];
	let compressedDataOffset: number;

	if (blockMagic === NCZ_BLOCK_MAGIC) {
		// Block mode
		const version = blockHeaderView.getUint8(8);
		const type = blockHeaderView.getUint8(9);
		// byte 10 is padding
		const blockSizeExponent = blockHeaderView.getUint8(11);
		const blockCount = blockHeaderView.getUint32(12, true);
		const decompressedSize = blockHeaderView.getBigUint64(16, true);

		if (version !== NCZ_BLOCK_VERSION) {
			throw new Error(
				`Invalid NCZ block version: ${version} (expected ${NCZ_BLOCK_VERSION})`,
			);
		}
		if (type !== NCZ_BLOCK_TYPE) {
			throw new Error(
				`Invalid NCZ block type: ${type} (expected ${NCZ_BLOCK_TYPE})`,
			);
		}
		if (blockSizeExponent < 14 || blockSizeExponent > 32) {
			throw new Error(
				`Invalid NCZ block size exponent: ${blockSizeExponent} (must be 14-32)`,
			);
		}

		blockHeader = {
			version,
			type,
			blockSizeExponent,
			blockCount,
			decompressedSize,
		};

		// Read block size array
		const blockArrayOffset = blockHeaderOffset + SIZEOF_NCZ_BLOCK_HEADER;
		const blockArraySize = blockCount * SIZEOF_NCZ_BLOCK_ENTRY;
		const blockArrayBuf = await blob
			.slice(blockArrayOffset, blockArrayOffset + blockArraySize)
			.arrayBuffer();
		const blockArrayView = new DataView(blockArrayBuf);

		// Compute absolute offsets for each block
		compressedDataOffset = blockArrayOffset + blockArraySize;
		let currentOffset = compressedDataOffset;
		for (let i = 0; i < blockCount; i++) {
			const compressedSize = blockArrayView.getUint32(i * 4, true);
			blocks.push({ offset: currentOffset, size: compressedSize });
			currentOffset += compressedSize;
		}
	} else {
		// Stream mode — compressed data starts right after sections.
		// The block header bytes we read are actually the start of the zstd stream.
		compressedDataOffset = blockHeaderOffset;
	}

	// 5. Compute the total NCA size
	let ncaSize: bigint;
	if (blockHeader) {
		ncaSize = BigInt(NCZ_HEADER_SIZE) + blockHeader.decompressedSize;
	} else {
		// Derive from section metadata: the NCA body ends at the furthest section end
		let maxEnd = 0n;
		for (const s of sections) {
			const end = s.offset + s.size;
			if (end > maxEnd) maxEnd = end;
		}
		ncaSize = maxEnd;
	}

	// 6. Build the output ReadableStream
	const subtle = cryptoProvider.subtle;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			// Emit the NCA header as-is (encrypted)
			controller.enqueue(new Uint8Array(ncaHeaderBuf));

			// Track how many decompressed body bytes we've written
			// (relative to the NCA body, i.e. after the 0x4000 header)
			let written = 0n;

			// Import all section AES keys upfront
			const sectionKeys: (CryptoKey | null)[] = [];
			for (const section of sections) {
				if (section.cryptoType >= BigInt(ENCRYPTION_TYPE_AES_CTR)) {
					const key = await subtle.importKey(
						'raw',
						section.key.buffer as ArrayBuffer,
						{ name: 'AES-CTR' },
						false,
						['encrypt'],
					);
					sectionKeys.push(key);
				} else {
					sectionKeys.push(null);
				}
			}

			/**
			 * Find the section covering the given NCA body offset and
			 * return a CryptoKey + counter for AES-CTR re-encryption.
			 */
			function findSection(offset: bigint) {
				for (let i = 0; i < sections.length; i++) {
					const s = sections[i];
					if (offset >= s.offset && offset < s.offset + s.size) {
						return { section: s, key: sectionKeys[i], index: i };
					}
				}
				throw new Error(`NCZ: no section found for offset ${offset}`);
			}

			/**
			 * Re-encrypt a chunk of decompressed NCA body data at the given
			 * body offset using the appropriate section's AES-CTR key.
			 */
			async function reencrypt(
				data: Uint8Array,
				bodyOffset: bigint,
			): Promise<Uint8Array> {
				const result = new Uint8Array(data.length);
				let dataOff = 0;

				while (dataOff < data.length) {
					const currentOffset = bodyOffset + BigInt(dataOff);
					const { section, key } = findSection(currentOffset);

					// How much of this chunk falls within the current section
					const sectionEnd = section.offset + section.size;
					const remaining = Number(sectionEnd - currentOffset);
					const chunkLen = Math.min(remaining, data.length - dataOff);
					const chunk = data.subarray(dataOff, dataOff + chunkLen);

					if (key && section.cryptoType >= BigInt(ENCRYPTION_TYPE_AES_CTR)) {
						// Build the AES-CTR counter for this offset.
						// The counter is 16 bytes: first 8 bytes from section counter,
						// last 8 bytes are the big-endian block offset (offset >> 4).
						const counter = new Uint8Array(16);
						counter.set(section.counter.subarray(0, 8), 0);
						const blockNum = currentOffset >> 4n;
						const blockNumView = new DataView(counter.buffer, 8, 8);
						blockNumView.setBigUint64(0, blockNum, false); // big-endian

						const encrypted = await subtle.encrypt(
							{ name: 'AES-CTR', counter, length: 128 },
							key,
							chunk.buffer.slice(
								chunk.byteOffset,
								chunk.byteOffset + chunk.byteLength,
							) as ArrayBuffer,
						);
						result.set(new Uint8Array(encrypted), dataOff);
					} else {
						// No encryption needed for this section
						result.set(chunk, dataOff);
					}

					dataOff += chunkLen;
				}

				return result;
			}

			try {
				if (blocks.length > 0 && blockHeader) {
					// Block mode: decompress each block individually
					if (!options.decompressBlob) {
						throw new Error(
							'NCZ block mode requires a `decompressBlob` function in options',
						);
					}

					const decompressedBlockSize = 1 << blockHeader.blockSizeExponent;

					for (let i = 0; i < blocks.length; i++) {
						const block = blocks[i];

						// Determine expected decompressed size for this block
						let expectedSize = decompressedBlockSize;
						if (i === blocks.length - 1) {
							// Last block may be smaller
							const remainder = Number(
								blockHeader.decompressedSize % BigInt(decompressedBlockSize),
							);
							if (remainder !== 0) {
								expectedSize = remainder;
							}
						}

						// Is this block actually compressed?
						const isCompressed = block.size < expectedSize;

						const blockBlob = blob.slice(
							block.offset,
							block.offset + block.size,
						);

						let decompressed: Uint8Array;
						if (isCompressed) {
							decompressed = await options.decompressBlob(blockBlob);
						} else {
							// Block is stored uncompressed
							decompressed = new Uint8Array(await blockBlob.arrayBuffer());
						}

						// Re-encrypt and emit
						const encrypted = await reencrypt(decompressed, written);
						controller.enqueue(encrypted);
						written += BigInt(decompressed.length);
					}
				} else {
					// Stream mode: entire compressed body is one zstd stream
					if (!options.decompressStream) {
						throw new Error(
							'NCZ stream mode requires a `decompressStream` function in options',
						);
					}

					const compressedBlob = blob.slice(compressedDataOffset);
					const decompressedStream = options.decompressStream(
						compressedBlob.stream(),
					);

					const reader = decompressedStream.getReader();
					// Accumulate into chunks and re-encrypt
					const FLUSH_SIZE = 4 * 1024 * 1024; // 4MB
					const accumulator = new Uint8Array(FLUSH_SIZE);
					let accOffset = 0;

					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;

						let srcOff = 0;
						while (srcOff < value.length) {
							const copyLen = Math.min(
								value.length - srcOff,
								FLUSH_SIZE - accOffset,
							);
							accumulator.set(
								value.subarray(srcOff, srcOff + copyLen),
								accOffset,
							);
							accOffset += copyLen;
							srcOff += copyLen;

							if (accOffset >= FLUSH_SIZE) {
								const encrypted = await reencrypt(
									accumulator.subarray(0, accOffset),
									written,
								);
								controller.enqueue(encrypted);
								written += BigInt(accOffset);
								accOffset = 0;
							}
						}
					}

					// Flush remaining
					if (accOffset > 0) {
						const encrypted = await reencrypt(
							accumulator.subarray(0, accOffset),
							written,
						);
						controller.enqueue(encrypted);
						written += BigInt(accOffset);
					}
				}

				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});

	return { ncaSize, stream, sections, blockHeader };
}

/**
 * Returns `true` if the given `Blob` is an NCZ file
 * (has the NCZ section magic at offset 0x4000).
 */
export async function isNcz(blob: Blob): Promise<boolean> {
	if (blob.size < NCZ_HEADER_SIZE + SIZEOF_NCZ_HEADER) {
		return false;
	}
	const buf = await blob
		.slice(NCZ_HEADER_SIZE, NCZ_HEADER_SIZE + 8)
		.arrayBuffer();
	const magic = new DataView(buf).getBigUint64(0, true);
	return magic === NCZ_SECTION_MAGIC;
}
