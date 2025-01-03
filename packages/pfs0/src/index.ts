/**
 * Reference: https://switchbrew.org/wiki/NCA#PFS0
 */
import { decodeCString } from '@nx.js/util';
import { Pfs0FileTable, Pfs0Header } from './types';

export * from './types';

export async function decode(data: Blob): Promise<Map<string, Blob>> {
	const { magic, totalFiles, stringTableSize } = new Pfs0Header(
		await data.slice(0, Pfs0Header.sizeof).arrayBuffer()
	);

	if (magic !== 0x30534650 /* 'PFS0' */) {
		throw new Error('Not a PFS0 file');
	}

	const fileTableStart = Pfs0Header.sizeof;
	const fileTableSize = Pfs0FileTable.sizeof * totalFiles;
	const stringTableEnd = fileTableStart + fileTableSize + stringTableSize;
	const fileTableAndStringTable = await data
		.slice(fileTableStart, stringTableEnd)
		.arrayBuffer();

	const files = new Map<string, Blob>();
	for (let i = 0; i < totalFiles; i++) {
		const { offset, size, nameOffset } = new Pfs0FileTable(
			fileTableAndStringTable,
			Pfs0FileTable.sizeof * i
		);
		const stringTableEntry = new Uint8Array(
			fileTableAndStringTable,
			fileTableSize + nameOffset
		);
		const name = decodeCString(stringTableEntry);
		const blob = data.slice(
			stringTableEnd + Number(offset),
			stringTableEnd + Number(offset + size)
		);
		files.set(name, blob);
	}
	return files;
}

export async function encode(files: Map<string, Blob>): Promise<ArrayBuffer> {
	let size = Pfs0Header.sizeof;
	size += Pfs0FileTable.sizeof * files.size;

	let fileOffset = 0;
	let stringTableSize = 0;
	const fileTable: {
		offset: number;
		size: number;
		nameOffset: number;
	}[] = [];
	const names: Uint8Array[] = [];

	for (const [name, blob] of files) {
		const nameBuf = new TextEncoder().encode(name);
		names.push(nameBuf);
		fileTable.push({
			offset: fileOffset,
			size: blob.size,
			nameOffset: stringTableSize,
		});

		size += blob.size;
		fileOffset += blob.size;
		stringTableSize += nameBuf.byteLength + 1;
	}

	// Align string table to 16 bytes
	stringTableSize = align(stringTableSize, 0x10);

	size += stringTableSize;

	const buf = new ArrayBuffer(size);

	const header = new Pfs0Header(buf);
	header.magic = 0x30534650 /* 'PFS0' */;
	header.totalFiles = files.size;
	header.stringTableSize = stringTableSize;

	const fileTableStart = Pfs0Header.sizeof;
	const stringTableStart = fileTableStart + Pfs0FileTable.sizeof * files.size;

	// Populate file table
	for (let i = 0; i < fileTable.length; i++) {
		const { offset, size, nameOffset } = fileTable[i];
		const entry = new Pfs0FileTable(
			buf,
			fileTableStart + Pfs0FileTable.sizeof * i
		);
		entry.offset = BigInt(offset);
		entry.size = BigInt(size);
		entry.nameOffset = nameOffset;
	}

	// Populate string table
	let stringTableOffset = stringTableStart;
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const entry = new Uint8Array(buf, stringTableOffset);
		entry.set(name);
		stringTableOffset += name.length + 1;
	}

	let dataStart = stringTableStart + stringTableSize;
	for (const blob of files.values()) {
		const data = new Uint8Array(buf, dataStart, blob.size);
		data.set(new Uint8Array(await blob.arrayBuffer()));
		dataStart += blob.size;
	}

	return buf;
}

function align(size: number, byteSize: number) {
	const remainder = size % byteSize;
	if (remainder === 0) {
		return size;
	}
	return size + byteSize - remainder;
}
