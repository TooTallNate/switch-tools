// Reference: https://switchbrew.org/wiki/NCA#PFS0

// struct Header {
//     u32 magic;
//     u32 file_count;
//     u32 string_table_size;
//     u32 reserved;
// };
// static_assert(sizeof(Header) == 0x10);

const SIZEOF_HEADER = 0x10;

// struct FileEntry {
//     u64 offset;
//     u64 size;
//     u32 string_table_offset;
//     u32 pad;
// };
// static_assert(sizeof(FileEntry) == 0x18);

const SIZEOF_FILE_ENTRY = 0x18;

const decoder = new TextDecoder();

export interface FileEntry {
	offset: bigint;
	size: bigint;
	stringTableOffset: number;
	pad: number;
	data: Blob;
}

/**
 *
 * @param blob
 * @returns
 */
export async function parseNsp(blob: Blob) {
	const s = blob.slice(0, SIZEOF_HEADER);
	const buf = await s.arrayBuffer();
	const view = new DataView(buf);
	const magic = view.getUint32(0, true);
	if (magic !== 0x30534650 /* 'PFS0' */) {
		throw new Error('Not a PFS0 file');
	}
	const fileCount = view.getUint32(0x4, true);
	const stringTableSize = view.getUint32(0x8, true);
	const reserved = view.getUint32(0xc, true);
	if (reserved !== 0) {
		throw new Error('Reserved must be 0');
	}
	const stringTableOffset = SIZEOF_HEADER + fileCount * SIZEOF_FILE_ENTRY;
	const stringTableBlob = blob.slice(
		stringTableOffset,
		stringTableOffset + stringTableSize
	);
	const stringTableData = new Uint8Array(await stringTableBlob.arrayBuffer());

	const files = new Map<string, FileEntry>();
	const fileDataOffset = stringTableOffset + stringTableSize;
	for (let i = 0; i < fileCount; i++) {
		const offset = SIZEOF_HEADER + i * SIZEOF_FILE_ENTRY;
		const data = await blob
			.slice(offset, offset + SIZEOF_FILE_ENTRY)
			.arrayBuffer();
		const view = new DataView(data);
		const fileEntry = {
			offset: view.getBigUint64(0, true),
			size: view.getBigUint64(0x8, true),
			stringTableOffset: view.getUint32(0x10, true),
			pad: view.getUint32(0x14, true),
		};

		let nameEndOffset = 0;
		for (let j = fileEntry.stringTableOffset; j < stringTableSize; j++) {
			const ch = stringTableData[j];
			if (ch === 0) {
				nameEndOffset = j;
				break;
			}
		}
		const name = decoder.decode(
			stringTableData.subarray(fileEntry.stringTableOffset, nameEndOffset)
		);
		const fileContents = blob.slice(
			fileDataOffset + Number(fileEntry.offset),
			fileDataOffset + Number(fileEntry.offset + fileEntry.size)
		);

		files.set(name, {
			offset: fileEntry.offset,
			size: fileEntry.size,
			stringTableOffset: fileEntry.stringTableOffset,
			pad: fileEntry.pad,
			data: fileContents,
		});
	}

	return {
		fileCount,
		stringTableSize,
		reserved,
		files,
	};
}

function bswap64(buffer: ArrayBuffer, offset: number) {
	const arr = new Uint8Array(buffer, offset, 8);
	for (let i = 0; i < 4; i++) {
		const v = arr[i];
		arr[i] = arr[7 - i];
		arr[7 - i] = v;
	}
}

export function ncmContentIdToString(contentId: ArrayBuffer) {
	if (contentId.byteLength !== 0x10) {
		throw new Error('Content ID must be 16 bytes');
	}
	const arr = new BigUint64Array(contentId.slice(0));
	bswap64(arr.buffer, 0);
	bswap64(arr.buffer, 8);
	return `${arr[0].toString(16).padStart(16, '0')}${arr[1]
		.toString(16)
		.padStart(16, '0')}`;
}

export function stringToNcmContentId(contentId: string): ArrayBuffer {
	if (contentId.length < 32) {
		throw new Error('Content ID must be at least 32 characters');
	}
	const arr = new BigUint64Array([
		BigInt(`0x${contentId.slice(0, 16)}`),
		BigInt(`0x${contentId.slice(16, 32)}`),
	]);
	bswap64(arr.buffer, 0);
	bswap64(arr.buffer, 8);
	return arr.buffer;
}
