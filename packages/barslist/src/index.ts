/**
 * BARSLIST — `ARSL` magic. A tiny string-only manifest that names
 * a logical audio resource group and lists the BARS files belonging
 * to it. Used by various NintendoWare-based first-party Switch
 * titles as a sound-pack table-of-contents.
 *
 * Wire layout (offsets relative to file start):
 *
 *   0x00  char[4]  magic = "ARSL"
 *   0x04  u16      BOM (0xFEFF BE / 0xFFFE LE)
 *   0x06  u16      version (always 1)
 *   0x08  u32      name_offset (relative to `base`)
 *   0x0C  u32      entry_count
 *   0x10  u32×N    resource_offset[i] (each relative to `base`)
 *   base = 0x10 + N*4
 *   <NUL-terminated UTF-8 strings, in any order>
 *
 * All offsets — both the archive's own name and every per-entry
 * resource path — are relative to `base = 0x10 + count*4`, the byte
 * just past the offset table. They point into the string pool that
 * follows; strings are NUL-terminated and not length-prefixed.
 *
 * References:
 *   - https://github.com/kinnay/Jungle/blob/master/jungle/aal/barslist.py
 *   - https://github.com/moonlightfox3/SWITCHjs/blob/main/barslist.js
 *   - https://github.com/NanobotZ/BarsTool (companion BARS reader)
 */

export const BARSLIST_MAGIC = 'ARSL';

const HEADER_SIZE = 0x10;

export type Endian = 'big' | 'little';

export interface ParsedBarslist {
	endian: Endian;
	/** Version number from the header (always `1` in shipped files). */
	version: number;
	/** The archive's own name (typically the barslist's filename without extension). */
	name: string;
	/** Path strings to the BARS files this manifest references. */
	resources: string[];
}

/** Cheap (4-byte) magic check. */
export async function isBarslist(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
	return (
		head[0] === 0x41 /* A */ &&
		head[1] === 0x52 /* R */ &&
		head[2] === 0x53 /* S */ &&
		head[3] === 0x4c /* L */
	);
}

/**
 * Parse a BARSLIST file. Reads the entire file (typically a few
 * hundred bytes) into memory and returns the decoded name + path
 * strings.
 */
export async function parseBarslist(blob: Blob): Promise<ParsedBarslist> {
	if (blob.size < HEADER_SIZE) {
		throw new Error(
			`Blob too small to be a BARSLIST (${blob.size} bytes, need at least ${HEADER_SIZE})`,
		);
	}
	const all = new Uint8Array(await blob.arrayBuffer());
	if (
		all[0] !== 0x41 ||
		all[1] !== 0x52 ||
		all[2] !== 0x53 ||
		all[3] !== 0x4c
	) {
		throw new Error('Bad BARSLIST magic');
	}
	const bomBE = all[4] === 0xfe && all[5] === 0xff;
	const bomLE = all[4] === 0xff && all[5] === 0xfe;
	if (!bomBE && !bomLE) {
		throw new Error(
			`Invalid BARSLIST byte-order mark: 0x${all[4].toString(16)}${all[5].toString(16)}`,
		);
	}
	const endian: Endian = bomBE ? 'big' : 'little';
	const isLittle = !bomBE;
	const v = new DataView(all.buffer, all.byteOffset, all.byteLength);
	const version = v.getUint16(0x06, isLittle);
	if (version !== 1) {
		throw new Error(`Unsupported BARSLIST version: ${version}`);
	}
	const nameOffset = v.getUint32(0x08, isLittle);
	const count = v.getUint32(0x0c, isLittle);
	if (count > 0x10000) {
		throw new Error(`Implausible BARSLIST entry count: ${count}`);
	}
	if (HEADER_SIZE + count * 4 > all.length) {
		throw new Error('BARSLIST offset table runs past end of blob');
	}

	const base = HEADER_SIZE + count * 4;
	const name = readNulString(all, base + nameOffset);

	const resources: string[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const off = v.getUint32(HEADER_SIZE + i * 4, isLittle);
		resources[i] = readNulString(all, base + off);
	}

	return { endian, version, name, resources };
}

function readNulString(bytes: Uint8Array, offset: number): string {
	if (offset < 0 || offset >= bytes.length) {
		return '';
	}
	let end = offset;
	while (end < bytes.length && bytes[end] !== 0) end++;
	return new TextDecoder('utf-8').decode(bytes.subarray(offset, end));
}
