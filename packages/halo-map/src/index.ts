/**
 * Parser for Halo: Combat Evolved cache files (`.map`).
 *
 * A cache file is a 0x800-byte header (`head` … `foot`, stored
 * little-endian so the magic reads `daeh` on disk) followed by the
 * tag data. On the original Xbox release (`version` 5) everything
 * after the header is one zlib stream; PC maps (7) and Custom
 * Edition maps (609) are stored raw.
 *
 * The tag index lives at `tagIndexOffset` in the (decompressed)
 * file. It is a small header followed by one 32-byte entry per tag.
 * Pointers inside tag data are virtual addresses; the file offset of
 * an address is `address - base + tagIndexOffset`, where `base` is
 * the tag array pointer minus the index header size.
 *
 * Struct layouts follow Invader's tag definitions
 * (https://github.com/SnowyMouse/invader).
 */

export * from './bitmap.js';
export * from './sound.js';
export * from './model.js';

/** Header magic `head`, little-endian. */
const HEAD = 0x68656164;
/** Footer magic `foot`, little-endian. */
const FOOT = 0x666f6f74;

/** Size of the cache file header. */
export const HALO_MAP_HEADER_SIZE = 0x800;

export interface HaloMapHeader {
	/** 5 = Xbox, 7 = PC retail, 609 = Custom Edition. */
	version: number;
	/** Size of the whole file once decompressed (header included). */
	decompressedSize: number;
	/** File offset of the tag index. */
	tagIndexOffset: number;
	/** Size of the tag data region starting at `tagIndexOffset`. */
	tagDataSize: number;
	/** Scenario name, e.g. `a10`. */
	name: string;
	/** Build string, e.g. `01.10.12.2276`. */
	build: string;
	/** 0 = campaign, 1 = multiplayer, 2 = user interface. */
	type: number;
	/** True when the body is zlib-compressed (Xbox). */
	compressed: boolean;
}

export interface HaloTag {
	/** Index in the tag array. */
	index: number;
	/** Primary class fourcc, e.g. `bitm`, `snd!`, `mode`. */
	tagClass: string;
	/** Parent classes (`obje` for `bipd`, …); empty strings when unused. */
	parentClasses: [string, string];
	/** Tag ID (salt << 16 | index). */
	id: number;
	/** Tag path, backslash-separated, without the class extension. */
	path: string;
	/** Virtual address of the tag's data. */
	dataAddress: number;
	/** File offset of the tag's data, or -1 when outside this map. */
	dataOffset: number;
	/** True when the tag's data lives in a shared resource map (PC). */
	external: boolean;
}

export interface HaloMap {
	header: HaloMapHeader;
	/** The decompressed file. */
	bytes: Uint8Array;
	view: DataView;
	tags: HaloTag[];
	/** Tag ID of the scenario. */
	scenarioId: number;
	/** Map a virtual address to a file offset (-1 when out of range). */
	offsetOf(address: number): number;
	/** Look up a tag by ID. */
	tagById(id: number): HaloTag | undefined;
}

export class HaloMapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HaloMapError';
	}
}

function cString(bytes: Uint8Array, start: number, max: number): string {
	let end = start;
	while (end < start + max && end < bytes.length && bytes[end] !== 0) end++;
	let s = '';
	for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
	return s;
}

/** Convert a little-endian fourcc value to its string (`0xffffffff` → ''). */
export function fourcc(value: number): string {
	if (value === 0xffffffff || value === 0) return '';
	return String.fromCharCode(
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	);
}

/** True when `bytes` starts with a Halo cache file header. */
export function isHaloMap(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, true) !== HEAD) return false;
	const version = dv.getUint32(4, true);
	return version === 5 || version === 6 || version === 7 || version === 609;
}

/** Parse the 0x800-byte cache file header. */
export function parseHaloMapHeader(bytes: Uint8Array): HaloMapHeader {
	if (!isHaloMap(bytes) || bytes.length < HALO_MAP_HEADER_SIZE) {
		throw new HaloMapError('Not a Halo cache file');
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0x7fc, true) !== FOOT) {
		throw new HaloMapError('Missing cache file footer');
	}
	const version = dv.getUint32(4, true);
	return {
		version,
		decompressedSize: dv.getUint32(8, true),
		tagIndexOffset: dv.getUint32(0x10, true),
		tagDataSize: dv.getUint32(0x14, true),
		name: cString(bytes, 0x20, 32),
		build: cString(bytes, 0x40, 32),
		type: dv.getUint32(0x60, true),
		compressed: version === 5,
	};
}

/**
 * Read a cache file into memory, inflating the Xbox zlib body. The
 * result always has the plain layout (header + tag data), so
 * `parseHaloMap` can address it with file offsets.
 */
export async function readHaloMap(blob: Blob): Promise<Uint8Array> {
	const head = new Uint8Array(
		await blob.slice(0, HALO_MAP_HEADER_SIZE).arrayBuffer(),
	);
	const header = parseHaloMapHeader(head);
	if (!header.compressed) {
		return new Uint8Array(await blob.arrayBuffer());
	}
	const out = new Uint8Array(header.decompressedSize);
	out.set(head, 0);
	// The zlib body is followed by zero padding up to the sector size.
	// Browsers' DecompressionStream rejects trailing bytes ("junk after
	// end"), so trim the padding first. The Adler-32 trailer can itself
	// end in zero bytes, so retry with up to 3 of them restored.
	const end = await lastNonZero(blob);
	let lastError: unknown;
	for (let extra = 0; extra <= 3; extra++) {
		const stop = Math.min(blob.size, end + 1 + extra);
		try {
			await inflateInto(blob.slice(HALO_MAP_HEADER_SIZE, stop), out, HALO_MAP_HEADER_SIZE);
			return out;
		} catch (err) {
			lastError = err;
			if (stop >= blob.size) break;
		}
	}
	throw lastError;
}

/** Offset of the last non-zero byte of `blob` (scans back in 64 KiB steps). */
async function lastNonZero(blob: Blob): Promise<number> {
	const step = 0x10000;
	for (let end = blob.size; end > 0; end -= step) {
		const start = Math.max(0, end - step);
		const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());
		for (let i = chunk.length - 1; i >= 0; i--) {
			if (chunk[i] !== 0) return start + i;
		}
	}
	return -1;
}

/** Inflate a zlib stream into `out` starting at `pos`; throws unless `out` fills exactly. */
async function inflateInto(body: Blob, out: Uint8Array, pos: number): Promise<void> {
	const reader = body
		.stream()
		.pipeThrough(new DecompressionStream('deflate'))
		.getReader();
	// Stop as soon as the known output size is reached: some runtimes
	// never signal `done` for file-backed streams.
	try {
		while (pos < out.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const n = Math.min(value.length, out.length - pos);
			out.set(n === value.length ? value : value.subarray(0, n), pos);
			pos += n;
		}
	} catch (err) {
		if (pos < out.length) throw err;
	} finally {
		reader.cancel().catch(() => {});
	}
	if (pos < out.length) {
		throw new HaloMapError(`Map body inflated to ${pos} bytes, expected ${out.length}`);
	}
}

/** Parse the tag index of a (decompressed) cache file. */
export function parseHaloMap(bytes: Uint8Array): HaloMap {
	const header = parseHaloMapHeader(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const idx = header.tagIndexOffset;
	if (idx + 0x28 > bytes.length) {
		throw new HaloMapError('Tag index is outside the file');
	}
	const tagArrayAddress = view.getUint32(idx, true);
	const scenarioId = view.getUint32(idx + 4, true);
	const tagCount = view.getUint32(idx + 0x0c, true);
	// Xbox index header is 0x24 bytes; PC adds a model data size field.
	const indexHeaderSize = header.version === 5 ? 0x24 : 0x28;
	const base = tagArrayAddress - indexHeaderSize;
	const end = idx + header.tagDataSize;
	const offsetOf = (address: number): number => {
		const off = address - base + idx;
		return address >= base && off < Math.min(end, bytes.length) ? off : -1;
	};

	const tags: HaloTag[] = [];
	const byId = new Map<number, HaloTag>();
	const arrayOffset = offsetOf(tagArrayAddress);
	if (arrayOffset < 0 || arrayOffset + tagCount * 32 > bytes.length) {
		throw new HaloMapError('Tag array is outside the file');
	}
	for (let i = 0; i < tagCount; i++) {
		const e = arrayOffset + i * 32;
		const pathOffset = offsetOf(view.getUint32(e + 0x10, true));
		const dataAddress = view.getUint32(e + 0x14, true);
		// For PC resource tags, +0x18 is non-zero and dataAddress is an index.
		const external = view.getUint32(e + 0x18, true) !== 0;
		const tag: HaloTag = {
			index: i,
			tagClass: fourcc(view.getUint32(e, true)),
			parentClasses: [
				fourcc(view.getUint32(e + 4, true)),
				fourcc(view.getUint32(e + 8, true)),
			],
			id: view.getUint32(e + 0x0c, true),
			path: pathOffset >= 0 ? cString(bytes, pathOffset, 256) : '',
			dataAddress,
			dataOffset: external ? -1 : offsetOf(dataAddress),
			external,
		};
		tags.push(tag);
		byId.set(tag.id, tag);
	}
	return {
		header,
		bytes,
		view,
		tags,
		scenarioId,
		offsetOf,
		tagById: (id) => byId.get(id),
	};
}

/** A tag reflexive (count + address), resolved to a file offset. */
export interface Reflexive {
	count: number;
	offset: number;
}

/** Read the reflexive at `offset` (count u32, address u32, unused u32). */
export function readReflexive(map: HaloMap, offset: number): Reflexive {
	const count = map.view.getUint32(offset, true);
	const address = map.view.getUint32(offset + 4, true);
	if (count === 0) return { count: 0, offset: -1 };
	const resolved = map.offsetOf(address);
	if (resolved < 0) return { count: 0, offset: -1 };
	return { count, offset: resolved };
}

/** File extension Halo's tools use for each tag class. */
export const TAG_CLASS_EXTENSIONS: Record<string, string> = {
	bitm: 'bitmap',
	'snd!': 'sound',
	mode: 'model',
	mod2: 'gbxmodel',
	scnr: 'scenario',
	sbsp: 'scenario_structure_bsp',
	bipd: 'biped',
	vehi: 'vehicle',
	weap: 'weapon',
	scen: 'scenery',
	font: 'font',
	ustr: 'unicode_string_list',
	str: 'string_list',
	antr: 'model_animations',
	coll: 'model_collision_geometry',
	shad: 'shader',
	senv: 'shader_environment',
	soso: 'shader_model',
	effe: 'effect',
	lsnd: 'sound_looping',
	snde: 'sound_environment',
};
