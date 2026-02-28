// Reference: https://switchbrew.org/wiki/XCI#HFS0

// struct Hfs0Header {
//     u32 magic;
//     u32 file_count;
//     u32 string_table_size;
//     u32 padding;
// };
// static_assert(sizeof(Hfs0Header) == 0x10);

const SIZEOF_HEADER = 0x10;

// struct Hfs0FileTableEntry {
//     u64 data_offset;
//     u64 data_size;
//     u32 name_offset;
//     u32 hash_size;
//     u64 padding;
//     u8 hash[0x20];
// };
// static_assert(sizeof(Hfs0FileTableEntry) == 0x40);

const SIZEOF_FILE_ENTRY = 0x40;

const decoder = new TextDecoder();

export interface FileEntry {
	offset: bigint;
	size: bigint;
	nameOffset: number;
	hashSize: number;
	hash: Uint8Array;
	data: Blob;
}

/**
 * Parses an HFS0 (Hashed FileSystem) partition from a `Blob`.
 *
 * The `Blob` should start at the beginning of the HFS0 header.
 * Returns a map of file names to their entries (including lazy `Blob` references).
 */
export async function parseHfs0(blob: Blob) {
	const s = blob.slice(0, SIZEOF_HEADER);
	const buf = await s.arrayBuffer();
	const view = new DataView(buf);
	const magic = view.getUint32(0, true);
	if (magic !== 0x30534648 /* 'HFS0' */) {
		throw new Error('Not an HFS0 file');
	}
	const fileCount = view.getUint32(0x4, true);
	const stringTableSize = view.getUint32(0x8, true);

	const stringTableOffset = SIZEOF_HEADER + fileCount * SIZEOF_FILE_ENTRY;
	const stringTableBlob = blob.slice(
		stringTableOffset,
		stringTableOffset + stringTableSize,
	);
	const stringTableData = new Uint8Array(await stringTableBlob.arrayBuffer());

	const files = new Map<string, FileEntry>();
	const fileDataOffset = stringTableOffset + stringTableSize;
	for (let i = 0; i < fileCount; i++) {
		const offset = SIZEOF_HEADER + i * SIZEOF_FILE_ENTRY;
		const data = await blob
			.slice(offset, offset + SIZEOF_FILE_ENTRY)
			.arrayBuffer();
		const entryView = new DataView(data);
		const dataOffset = entryView.getBigUint64(0, true);
		const dataSize = entryView.getBigUint64(0x8, true);
		const nameOffset = entryView.getUint32(0x10, true);
		const hashSize = entryView.getUint32(0x14, true);
		// 0x18: u64 padding
		const hash = new Uint8Array(data, 0x20, 0x20);

		let nameEndOffset = 0;
		for (let j = nameOffset; j < stringTableSize; j++) {
			const ch = stringTableData[j];
			if (ch === 0) {
				nameEndOffset = j;
				break;
			}
		}
		const name = decoder.decode(
			stringTableData.subarray(nameOffset, nameEndOffset),
		);
		const fileContents = blob.slice(
			fileDataOffset + Number(dataOffset),
			fileDataOffset + Number(dataOffset + dataSize),
		);

		files.set(name, {
			offset: dataOffset,
			size: dataSize,
			nameOffset,
			hashSize,
			hash,
			data: fileContents,
		});
	}

	return {
		fileCount,
		stringTableSize,
		files,
	};
}
