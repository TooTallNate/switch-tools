const decoder = new TextDecoder();

// Read:
//  - https://github.com/jakcron/libpietendo/blob/194b77d6ea9077dda6b03a79c593d2c1f2f7e9f2/include/pietendo/hac/define/romfs.h#L21
//  - https://github.com/jakcron/nstool/blob/development-tip/src/RomfsProcess.cpp

// Write:
//  - https://github.com/switchbrew/switch-tools/blob/master/src/romfs.c

const DIR_ENTRY_SIZE = 0x18; // (plus the name, aligned to 4 bytes)
const FILE_ENTRY_SIZE = 0x20; // (plus the name, aligned to 4 bytes)

export async function parseHeader(blob: Blob) {
	const buf = blob.slice(0, 0x50);
	const arr = await buf.arrayBuffer();
	const view = new DataView(arr);
	const headerSize = view.getBigInt64(0, true);
	const dirHashBucketOffset = view.getBigInt64(0x8, true);
	const dirHashBucketLength = view.getBigInt64(0x10, true);
	const dirEntryOffset = view.getBigInt64(0x18, true);
	const dirEntryLength = view.getBigInt64(0x20, true);
	const fileHashBucketOffset = view.getBigInt64(0x28, true);
	const fileHashBucketLength = view.getBigInt64(0x30, true);
	const fileEntryOffset = view.getBigInt64(0x38, true);
	const fileEntryLength = view.getBigInt64(0x40, true);
	const dataOffset = view.getBigInt64(0x48, true);

	//console.log({
	//	headerSize,
	//	dirHashBucketOffset,
	//	dirHashBucketLength,
	//	dirEntryOffset,
	//	dirEntryLength,
	//	fileHashBucketOffset,
	//	fileHashBucketLength,
	//	fileEntryOffset,
	//	fileEntryLength,
	//	dataOffset,
	//});

	const dirEntries = await parseDirEntry(
		blob,
		Number(dirEntryOffset),
		Number(dirEntryLength)
	);
	//console.log(dirEntries);

	const fileEntries = await parseFileEntry(
		blob,
		Number(fileEntryOffset),
		Number(fileEntryLength)
	);
	//console.log(fileEntries);

	//for (const fileEntry of fileEntries) {
	//	let { parentOffset } = fileEntry;
	//	const pathParts = [fileEntry.name];
	//	while (parentOffset !== 0) {
	//		const parent = dirEntries.find(
	//			(dir) => dir.offset === parentOffset
	//		);
	//		if (!parent) break;
	//		pathParts.unshift(parent.name);
	//		parentOffset = parent.parentOffset;
	//	}
	//	console.log(pathParts.join('/'));

	//	//const dataStart = Number(dataOffset + fileEntry.dataOffset);
	//	//const dataEnd = dataStart + Number(fileEntry.dataSize);
	//	//const data = await blob.slice(dataStart, dataEnd).arrayBuffer();
	//	//console.log(decoder.decode(data));
	//}

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
		dirEntries,
		fileEntries,
	};
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
			dataOffset: view.getBigInt64(addr + 8, true),
			dataSize: view.getBigInt64(addr + 16, true),
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
