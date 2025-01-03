import { ArrayBufferStruct, u8, view, decodeCString } from '@nx.js/util';

export class Pfs0Header extends ArrayBufferStruct {
	//u32 magic;
	//u32 total_files;
	//u32 string_table_size;
	//u32 padding;
	static sizeof = 0x10 as const;

	get magic() {
		return view(this).getUint32(0x0, true);
	}
	set magic(v: number) {
		view(this).setUint32(0x0, v, true);
	}

	get totalFiles() {
		return view(this).getUint32(0x4, true);
	}
	set totalFiles(v: number) {
		view(this).setUint32(0x4, v, true);
	}

	get stringTableSize() {
		return view(this).getUint32(0x8, true);
	}
	set stringTableSize(v: number) {
		view(this).setUint32(0x8, v, true);
	}
}

export class Pfs0FileTable extends ArrayBufferStruct {
	//u64 data_offset;
	//u64 data_size;
	//u32 name_offset;
	//u32 padding;
	static sizeof = 0x18 as const;

	get offset() {
		return view(this).getBigUint64(0x0, true);
	}
	set offset(v: bigint) {
		view(this).setBigUint64(0x0, v, true);
	}

	get size() {
		return view(this).getBigUint64(0x8, true);
	}
	set size(v: bigint) {
		view(this).setBigUint64(0x8, v, true);
	}

	get nameOffset() {
		return view(this).getUint32(0x10, true);
	}
	set nameOffset(v: number) {
		view(this).setUint32(0x10, v, true);
	}
}
