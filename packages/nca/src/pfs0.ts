/**
 * PFS0 (Partition File System 0) builder with hash table support for NCA use.
 *
 * This is a self-contained PFS0 implementation that also supports creating
 * SHA-256 hash tables as needed for NCA section headers (ExeFS, Logo, Meta).
 *
 * String table alignment: 0x20 bytes (matching hacbrewpack).
 * Hash table padding: 0x200 bytes (PFS0_PADDING_SIZE).
 *
 * Reference: hacbrewpack/pfs0.c, hacbrewpack/pfs0.h
 */

import { sha256 } from './crypto.js';

const PFS0_MAGIC = 0x30534650; // "PFS0"
const HEADER_SIZE = 0x10;
const FILE_ENTRY_SIZE = 0x18;
const STRING_TABLE_ALIGNMENT = 0x20;
const HASH_TABLE_PADDING = 0x200;

export interface Pfs0File {
	name: string;
	data: Uint8Array;
}

/**
 * Build a PFS0 archive from a list of files.
 * File ordering matches the input array order.
 *
 * @param files - Files to include in the PFS0
 * @returns PFS0 binary data
 */
export function buildPfs0(files: Pfs0File[]): Uint8Array {
	const encoder = new TextEncoder();

	// Build string table and file entries
	let stringTableSize = 0;
	const names: Uint8Array[] = [];
	const stringTableOffsets: number[] = [];
	let fileDataOffset = 0;

	for (const file of files) {
		const nameBytes = encoder.encode(file.name);
		names.push(nameBytes);
		stringTableOffsets.push(stringTableSize);
		stringTableSize += nameBytes.length + 1; // +1 for null terminator
	}

	// Align string table to 0x20 boundary
	stringTableSize =
		(stringTableSize + (STRING_TABLE_ALIGNMENT - 1)) &
		~(STRING_TABLE_ALIGNMENT - 1);

	// Calculate total size
	const fileEntryTableSize = FILE_ENTRY_SIZE * files.length;
	const headerAndTables = HEADER_SIZE + fileEntryTableSize + stringTableSize;
	let totalDataSize = 0;
	for (const file of files) {
		totalDataSize += file.data.length;
	}

	const totalSize = headerAndTables + totalDataSize;
	const buffer = new Uint8Array(totalSize);
	const view = new DataView(buffer.buffer);

	// Write PFS0 header
	view.setUint32(0x00, PFS0_MAGIC, true);
	view.setUint32(0x04, files.length, true);
	view.setUint32(0x08, stringTableSize, true);
	// 0x0C: reserved (0)

	// Write file entries
	fileDataOffset = 0;
	for (let i = 0; i < files.length; i++) {
		const entryOffset = HEADER_SIZE + i * FILE_ENTRY_SIZE;
		// offset (8 bytes, relative to start of data region)
		view.setBigUint64(entryOffset + 0x00, BigInt(fileDataOffset), true);
		// size (8 bytes)
		view.setBigUint64(
			entryOffset + 0x08,
			BigInt(files[i].data.length),
			true
		);
		// string_table_offset (4 bytes)
		view.setUint32(entryOffset + 0x10, stringTableOffsets[i], true);
		// reserved (4 bytes, already 0)
		fileDataOffset += files[i].data.length;
	}

	// Write string table
	const stringTableStart = HEADER_SIZE + fileEntryTableSize;
	for (let i = 0; i < names.length; i++) {
		buffer.set(names[i], stringTableStart + stringTableOffsets[i]);
		// Null terminator is already 0 from the zero-filled buffer
	}

	// Write file data
	let dataWriteOffset = headerAndTables;
	for (const file of files) {
		buffer.set(file.data, dataWriteOffset);
		dataWriteOffset += file.data.length;
	}

	return buffer;
}

export interface Pfs0HashResult {
	/** The SHA-256 hash table (padded to HASH_TABLE_PADDING boundary) */
	hashTable: Uint8Array;
	/** Size of the actual hash data (before padding) */
	hashTableSize: number;
	/** Offset where the PFS0 data starts (after hash table + padding) */
	pfs0Offset: number;
}

/**
 * Create a SHA-256 hash table for a PFS0 archive.
 * Each block of `blockSize` bytes is hashed with SHA-256.
 *
 * @param pfs0Data - The PFS0 binary data
 * @param blockSize - Hash block size (e.g., 0x10000 for ExeFS, 0x1000 for Logo/Meta)
 * @returns Hash table data and metadata
 */
export async function createPfs0HashTable(
	pfs0Data: Uint8Array,
	blockSize: number,
	crypto: Crypto = globalThis.crypto
): Promise<Pfs0HashResult> {
	const numBlocks = Math.ceil(pfs0Data.length / blockSize);
	const hashTableSize = numBlocks * 0x20; // 32 bytes per SHA-256 hash

	// Pad hash table to HASH_TABLE_PADDING boundary
	const paddedSize =
		hashTableSize +
		((HASH_TABLE_PADDING - (hashTableSize % HASH_TABLE_PADDING)) %
			HASH_TABLE_PADDING);
	const hashTable = new Uint8Array(paddedSize);

	// Hash each block
	const block = new Uint8Array(blockSize);
	for (let i = 0; i < numBlocks; i++) {
		const offset = i * blockSize;
		const remaining = pfs0Data.length - offset;
		const readSize = Math.min(remaining, blockSize);

		block.fill(0);
		block.set(pfs0Data.subarray(offset, offset + readSize));

		const hash = await sha256(block.subarray(0, readSize), crypto);
		hashTable.set(hash, i * 0x20);
	}

	return {
		hashTable,
		hashTableSize,
		pfs0Offset: paddedSize,
	};
}

/**
 * Calculate the master hash for a PFS0 hash table.
 * This is the SHA-256 of the actual hash data (not the padding).
 */
export async function calculatePfs0MasterHash(
	hashTable: Uint8Array,
	hashTableSize: number,
	crypto: Crypto = globalThis.crypto
): Promise<Uint8Array> {
	return sha256(hashTable.subarray(0, hashTableSize), crypto);
}
