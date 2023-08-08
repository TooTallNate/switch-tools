const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Read:
//  - https://github.com/jakcron/libpietendo/blob/194b77d6ea9077dda6b03a79c593d2c1f2f7e9f2/include/pietendo/hac/define/romfs.h#L21
//  - https://github.com/jakcron/nstool/blob/development-tip/src/RomfsProcess.cpp

// Write:
//  - https://github.com/switchbrew/switch-tools/blob/master/src/romfs.c

const DIR_ENTRY_SIZE = 0x18; // (plus the name, aligned to 4 bytes)
const FILE_ENTRY_SIZE = 0x20; // (plus the name, aligned to 4 bytes)
const ROMFS_HEADER_SIZE = 0x50;
const ROMFS_ENTRY_EMPTY = 0xffffffff;
const ROMFS_FILEPARTITION_OFS = 0x200;

export async function parseHeader(blob: Blob) {
	const buf = blob.slice(0, 0x50);
	const arr = await buf.arrayBuffer();
	const view = new DataView(arr);
	const headerSize = view.getBigUint64(0, true);
	const dirHashBucketOffset = view.getBigUint64(0x8, true);
	const dirHashBucketLength = view.getBigUint64(0x10, true);
	const dirEntryOffset = view.getBigUint64(0x18, true);
	const dirEntryLength = view.getBigUint64(0x20, true);
	const fileHashBucketOffset = view.getBigUint64(0x28, true);
	const fileHashBucketLength = view.getBigUint64(0x30, true);
	const fileEntryOffset = view.getBigUint64(0x38, true);
	const fileEntryLength = view.getBigUint64(0x40, true);
	const dataOffset = view.getBigUint64(0x48, true);

	return {
		headerSize,
		dirHashBucketOffset,
		dirHashBucketLength,
		dirEntryOffset,
		dirEntryLength,
		fileHashBucketOffset,
		fileHashBucketLength,
		fileEntryOffset,
		fileEntryLength,
		dataOffset,
	};
}

export async function decode(blob: Blob): Promise<RomFsEntry> {
	const header = await parseHeader(blob);
	const dirsByOffset: Map<number, RomFsEntry> = new Map();

	const dirEntries = await parseDirEntry(
		blob,
		Number(header.dirEntryOffset),
		Number(header.dirEntryLength)
	);
	for (const dirEntry of dirEntries) {
		const dir: RomFsEntry = Object.create(null);
		dirsByOffset.set(dirEntry.offset, dir);
		if (dirEntry.offset !== 0) {
			const parentDir = dirsByOffset.get(dirEntry.parentOffset);
			if (!parentDir) {
				throw new Error(
					`No dir entry at offset ${dirEntry.parentOffset}`
				);
			}
			parentDir[dirEntry.name] = dir;
		}
	}

	const fileEntries = await parseFileEntry(
		blob,
		Number(header.fileEntryOffset),
		Number(header.fileEntryLength)
	);
	for (const fileEntry of fileEntries) {
		const parentDir = dirsByOffset.get(fileEntry.parentOffset);
		if (!parentDir) {
			throw new Error(`No dir entry at offset ${fileEntry.parentOffset}`);
		}
		const dataStart =
			Number(header.dataOffset) + Number(fileEntry.dataOffset);
		const dataEnd = dataStart + Number(fileEntry.dataSize);
		const file = blob.slice(dataStart, dataEnd);
		parentDir[fileEntry.name] = file;
	}

	const rootDir = dirsByOffset.get(0);
	if (!rootDir) {
		throw new Error('No root directory in RomFS');
	}
	return rootDir;
}

interface DirEntry {
	offset: number;
	parentOffset: number;
	siblingOffset: number;
	childOffset: number;
	fileOffset: number;
	hashSiblingOffset: number;
	nameSize: number;
	name: string;
}

interface FileEntry {
	offset: number;
	parentOffset: number;
	siblingOffset: number;
	dataOffset: bigint;
	dataSize: bigint;
	hashSiblingOffset: number;
	nameSize: number;
	name: string;
}

async function parseDirEntry(blob: Blob, offset: number, length: number) {
	const buf = await blob.slice(offset, offset + length).arrayBuffer();
	const view = new DataView(buf);
	const entries: DirEntry[] = [];
	for (let addr = 0; addr < length; ) {
		const nameSize = view.getUint32(addr + 20, true);
		const name = decoder.decode(buf.slice(addr + 24, addr + 24 + nameSize));
		entries.push({
			offset: addr,
			parentOffset: view.getUint32(addr, true),
			siblingOffset: view.getUint32(addr + 4, true),
			childOffset: view.getUint32(addr + 8, true),
			fileOffset: view.getUint32(addr + 12, true),
			hashSiblingOffset: view.getUint32(addr + 16, true),
			nameSize,
			name,
		});
		addr += align(DIR_ENTRY_SIZE + nameSize, 4);
	}
	return entries;
}

async function parseFileEntry(blob: Blob, offset: number, length: number) {
	const buf = await blob.slice(offset, offset + length).arrayBuffer();
	const view = new DataView(buf);
	const entries: FileEntry[] = [];
	for (let addr = 0; addr < length; ) {
		const nameSize = view.getUint32(addr + 28, true);
		const nameStart = addr + 32;
		const name = decoder.decode(buf.slice(nameStart, nameStart + nameSize));
		entries.push({
			offset: addr,
			parentOffset: view.getUint32(addr, true),
			siblingOffset: view.getUint32(addr + 4, true),
			dataOffset: view.getBigUint64(addr + 8, true),
			dataSize: view.getBigUint64(addr + 16, true),
			hashSiblingOffset: view.getUint32(addr + 24, true),
			nameSize,
			name,
		});
		addr += align(FILE_ENTRY_SIZE + nameSize, 4);
	}
	return entries;
}

function align(size: number, byteSize: number) {
	const remainder = size % byteSize;
	if (remainder === 0) {
		return size;
	}
	return size + byteSize - remainder;
}

function calcPathHash(
	parent: number,
	path: Uint8Array,
	start: number,
	pathLen: number
): number {
	let hash: number = parent ^ 123456789;
	for (let i = 0; i < pathLen; i++) {
		hash = (hash >>> 5) | (hash << 27);
		hash ^= path[start + i];
	}

	return hash >>> 0; // Ensure the result is an unsigned 32-bit integer
}

function romfsGetHashTableCount(numEntries: number): number {
	if (numEntries < 3) {
		return 3;
	} else if (numEntries < 19) {
		return numEntries | 1;
	}
	let count = numEntries;
	while (
		count % 2 === 0 ||
		count % 3 === 0 ||
		count % 5 === 0 ||
		count % 7 === 0 ||
		count % 11 === 0 ||
		count % 13 === 0 ||
		count % 17 === 0
	) {
		count++;
	}
	return count;
}

export type RomFsEntry = {
	[name: string]: RomFsEntry | Blob;
};

function walkFs(
	fs: RomFsEntry,
	dirEntries: DirEntry[],
	fileEntries: FileEntry[],
	fileBlobs: Map<FileEntry, Blob>,
	parentDir: DirEntry,
	dirEntryOffset: number,
	fileEntryOffset: number,
	dataOffset: bigint
) {
	let prevDir: DirEntry | undefined;
	let prevFile: FileEntry | undefined;
	for (const name of Object.keys(fs).sort()) {
		const value = fs[name];
		const nameSize = encoder.encode(name).length;
		if (value instanceof Blob) {
			// File
			const fileEntry: FileEntry = {
				offset: fileEntryOffset,
				parentOffset: parentDir.offset,
				siblingOffset: ROMFS_ENTRY_EMPTY,
				dataOffset,
				dataSize: BigInt(value.size),
				hashSiblingOffset: ROMFS_ENTRY_EMPTY,
				nameSize,
				name,
			};
			fileBlobs.set(fileEntry, value);
			fileEntries.push(fileEntry);
			if (prevFile) {
				prevFile.siblingOffset = fileEntry.offset;
			}
			prevFile = fileEntry;
			if (parentDir.fileOffset === ROMFS_ENTRY_EMPTY) {
				parentDir.fileOffset = fileEntry.offset;
			}
			fileEntryOffset += FILE_ENTRY_SIZE + align(nameSize, 4);
			dataOffset += BigInt(align(value.size, 0x10));
		} else {
			// Directory
			const dirEntry: DirEntry = {
				offset: dirEntryOffset,
				parentOffset: parentDir.offset,
				siblingOffset: ROMFS_ENTRY_EMPTY,
				childOffset: ROMFS_ENTRY_EMPTY,
				fileOffset: ROMFS_ENTRY_EMPTY,
				hashSiblingOffset: ROMFS_ENTRY_EMPTY,
				nameSize,
				name,
			};
			dirEntries.push(dirEntry);
			if (prevDir) {
				prevDir.siblingOffset = dirEntry.offset;
			}
			prevDir = dirEntry;
			if (parentDir.childOffset === ROMFS_ENTRY_EMPTY) {
				parentDir.childOffset = dirEntry.offset;
			}
			dirEntryOffset += DIR_ENTRY_SIZE + align(nameSize, 4);
			const offsets = walkFs(
				value,
				dirEntries,
				fileEntries,
				fileBlobs,
				dirEntry,
				dirEntryOffset,
				fileEntryOffset,
				dataOffset
			);
			dirEntryOffset = offsets.dirEntryOffset;
			fileEntryOffset = offsets.fileEntryOffset;
			dataOffset = offsets.dataOffset;
		}
	}
	return { dirEntryOffset, fileEntryOffset, dataOffset };
}

export async function encode(fs: RomFsEntry) {
	const blobParts: BlobPart[] = [];
	const dirEntries: DirEntry[] = [];
	const fileEntries: FileEntry[] = [];
	const fileBlobs: Map<FileEntry, Blob> = new Map();

	// Add the implicit root level directory entry
	const rootDirEntry: DirEntry = {
		offset: 0,
		parentOffset: 0,
		siblingOffset: ROMFS_ENTRY_EMPTY,
		childOffset: ROMFS_ENTRY_EMPTY,
		fileOffset: ROMFS_ENTRY_EMPTY,
		hashSiblingOffset: ROMFS_ENTRY_EMPTY,
		nameSize: 0,
		name: '',
	};
	dirEntries.push(rootDirEntry);

	// Walk the `fs` to populate the `dirEntries` and `filesEntries`
	const offsets = walkFs(
		fs,
		dirEntries,
		fileEntries,
		fileBlobs,
		rootDirEntry,
		DIR_ENTRY_SIZE,
		0,
		0n
	);

	// Determine file partition size
	let file_partition_size = 0;
	for (const entry of fileEntries) {
		const blob = fileBlobs.get(entry);
		if (!blob) {
			// Shouldn't happen
			throw new Error('No blob');
		}
		file_partition_size = align(file_partition_size, 0x10);
		file_partition_size += blob.size;
	}

	const dir_hash_table_entry_count = romfsGetHashTableCount(
		dirEntries.length
	);
	const file_hash_table_entry_count = romfsGetHashTableCount(
		fileEntries.length
	);
	const dir_hash_table_size = 4 * dir_hash_table_entry_count;
	const file_hash_table_size = 4 * file_hash_table_entry_count;
	const dir_hash_table_ofs = align(
		file_partition_size + ROMFS_FILEPARTITION_OFS,
		4
	);
	const dir_table_ofs = dir_hash_table_ofs + dir_hash_table_size;
	const file_hash_table_ofs = dir_table_ofs + offsets.dirEntryOffset;
	const file_table_ofs = file_hash_table_ofs + file_hash_table_size;

	// Output the RomFS header
	const header = new ArrayBuffer(ROMFS_HEADER_SIZE);
	const headerArr = new BigUint64Array(header);
	headerArr[0] = BigInt(ROMFS_HEADER_SIZE);
	headerArr[1] = BigInt(dir_hash_table_ofs);
	headerArr[2] = BigInt(dir_hash_table_size);
	headerArr[3] = BigInt(dir_table_ofs);
	headerArr[4] = BigInt(offsets.dirEntryOffset);
	headerArr[5] = BigInt(file_hash_table_ofs);
	headerArr[6] = BigInt(file_hash_table_size);
	headerArr[7] = BigInt(file_table_ofs);
	headerArr[8] = BigInt(offsets.fileEntryOffset);
	headerArr[9] = BigInt(ROMFS_FILEPARTITION_OFS);
	blobParts.push(header);

	const dir_table = new ArrayBuffer(offsets.dirEntryOffset);
	const file_table = new ArrayBuffer(offsets.fileEntryOffset);

	const dir_hash_table = new Uint32Array(dir_hash_table_entry_count);
	for (let i = 0; i < dir_hash_table_entry_count; i++) {
		dir_hash_table[i] = ROMFS_ENTRY_EMPTY;
	}

	const file_hash_table = new Uint32Array(file_hash_table_entry_count);
	for (let i = 0; i < file_hash_table_entry_count; i++) {
		file_hash_table[i] = ROMFS_ENTRY_EMPTY;
	}

	// Populate dir table and dir hash table
	const dirTableView = new DataView(dir_table);
	for (const dirEntry of dirEntries) {
		const parentEntry = dirEntries.find(
			(e) => e.offset === dirEntry.parentOffset
		);
		const name =
			dirEntry === rootDirEntry
				? new Uint8Array(0)
				: encoder.encode(`/${dirEntry.name}`);
		const hash = calcPathHash(
			parentEntry?.offset ?? 0,
			name,
			1,
			dirEntry.nameSize
		);
		dirEntry.hashSiblingOffset =
			dir_hash_table[hash % dir_hash_table_entry_count];
		dir_hash_table[hash % dir_hash_table_entry_count] = dirEntry.offset;

		dirTableView.setUint32(dirEntry.offset, dirEntry.parentOffset, true);
		dirTableView.setUint32(
			dirEntry.offset + 4,
			dirEntry.siblingOffset,
			true
		);
		dirTableView.setUint32(dirEntry.offset + 8, dirEntry.childOffset, true);
		dirTableView.setUint32(dirEntry.offset + 12, dirEntry.fileOffset, true);
		dirTableView.setUint32(
			dirEntry.offset + 16,
			dirEntry.hashSiblingOffset,
			true
		);
		dirTableView.setUint32(dirEntry.offset + 20, dirEntry.nameSize, true);
		encoder.encodeInto(
			dirEntry.name,
			new Uint8Array(dir_table, dirEntry.offset + 24)
		);
	}

	// Populate file table and file hash table
	const fileTableView = new DataView(file_table);
	for (const fileEntry of fileEntries) {
		const { offset, parentOffset } = fileEntry;
		const parentEntry = dirEntries.find((e) => e.offset === parentOffset);
		const name = encoder.encode(`/${fileEntry.name}`);
		const hash = calcPathHash(
			parentEntry?.offset ?? 0,
			name,
			1,
			fileEntry.nameSize
		);
		fileEntry.hashSiblingOffset =
			file_hash_table[hash % file_hash_table_entry_count];
		file_hash_table[hash % file_hash_table_entry_count] = fileEntry.offset;

		fileTableView.setUint32(offset, fileEntry.parentOffset, true);
		fileTableView.setUint32(offset + 4, fileEntry.siblingOffset, true);
		fileTableView.setBigUint64(offset + 8, fileEntry.dataOffset, true);
		fileTableView.setBigUint64(offset + 16, fileEntry.dataSize, true);
		fileTableView.setUint32(offset + 24, fileEntry.hashSiblingOffset, true);
		fileTableView.setUint32(offset + 28, fileEntry.nameSize, true);
		encoder.encodeInto(
			fileEntry.name,
			new Uint8Array(file_table, offset + 32)
		);
	}

	// Output padding up until ROMFS_FILEPARTITION_OFS
	blobParts.push(
		new ArrayBuffer(ROMFS_FILEPARTITION_OFS - header.byteLength)
	);

	let bytesUsed = ROMFS_FILEPARTITION_OFS;

	// Output the file partition data
	for (let i = 0; i < fileEntries.length; i++) {
		const blob = fileBlobs.get(fileEntries[i]);
		if (!blob) throw new Error('No blob');
		blobParts.push(blob);
		bytesUsed += blob.size;

		if (i !== fileEntries.length - 1) {
			// Output padding to align to 0x10, except for the final file
			const padding = align(blob.size, 0x10) - blob.size;
			if (padding !== 0) {
				blobParts.push(new ArrayBuffer(padding));
				bytesUsed += padding;
			}
		}
	}

	// Output padding until `dir_hash_table_ofs`
	let padding = dir_hash_table_ofs - bytesUsed;
	if (padding > 0) {
		blobParts.push(new ArrayBuffer(padding));
		bytesUsed += padding;
	}

	// Output dir hash table
	blobParts.push(dir_hash_table);
	bytesUsed += dir_hash_table_size;

	// Output padding until `dir_table_ofs`
	padding = dir_table_ofs - bytesUsed;
	if (padding > 0) {
		blobParts.push(new ArrayBuffer(padding));
		bytesUsed += padding;
	}

	// Output dir table
	blobParts.push(dir_table);
	bytesUsed += dir_table.byteLength;

	// Output padding until `file_hash_table_ofs`
	padding = file_hash_table_ofs - bytesUsed;
	if (padding > 0) {
		blobParts.push(new ArrayBuffer(padding));
		bytesUsed += padding;
	}

	// Output file hash table
	blobParts.push(file_hash_table);
	bytesUsed += file_hash_table_size;

	// Output padding until `file_table_ofs`
	padding = file_table_ofs - bytesUsed;
	if (padding > 0) {
		blobParts.push(new ArrayBuffer(padding));
		bytesUsed += padding;
	}

	// Output file table
	blobParts.push(file_table);
	bytesUsed += file_table.byteLength;

	return new Blob(blobParts);
}
