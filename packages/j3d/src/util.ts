/**
 * Shared byte plumbing for the J3D chunk parsers.
 *
 * Nothing in here is J3D-specific except {@link readJ3dStringTable} and
 * {@link j3dNameHash}, which implement the one data structure that shows up
 * in five different chunks (`MAT3`, `TEX1`, `JNT1`, `SHP1`, and the older
 * `MDL3`) and which is therefore worth writing exactly once.
 *
 * The J3D string table:
 *
 *   0x00 u16  count
 *   0x02 u16  0xFFFF        — a terminator/sentinel for the hash search below
 *   0x04 ...  count × { u16 hash, u16 offset }
 *   ...       the NUL-terminated strings themselves
 *
 * Both `offset` and the strings are relative to the start of the *table*, not
 * to the chunk. The `hash` is there so that the game can find a name without
 * doing string comparisons: JSystem hashes the name it's looking for, then
 * linearly scans the (tiny) table comparing 16-bit integers. The 0xFFFF
 * sentinel in the second field is what the scan stops on. We ignore the
 * hashes when reading — they're redundant once you have the strings — but
 * {@link j3dNameHash} is exported so writers can round-trip a table and so
 * tests can build fixtures that look like the real thing.
 *
 * Everything multi-byte is big-endian: these files were authored by Nintendo's
 * tooling in the native byte order of the GameCube's PowerPC "Gekko".
 */

/** Every chunk begins with `u32 magic` + `u32 size`; size includes those 8 bytes. */
export const CHUNK_HEADER_SIZE = 8;

/** Read `length` bytes at `offset` as an ASCII string, without bounds checks. */
export function readAscii(
	bytes: Uint8Array,
	offset: number,
	length: number,
): string {
	let s = '';
	for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
	return s;
}

/**
 * Decode a NUL-terminated name from `start`, stopping at `end` even when
 * there is no terminator, so a truncated file yields a short name rather
 * than an exception.
 *
 * Retail files are pure ASCII (occasionally shift-JIS for Japanese debug
 * names). We try UTF-8 — which is exactly right for ASCII — and fall back to
 * latin-1 so a shift-JIS name degrades into mojibake instead of U+FFFD soup.
 */
export function decodeName(
	bytes: Uint8Array,
	start: number,
	end: number,
): string {
	if (start < 0 || start >= end) return '';
	let stop = start;
	while (stop < end && bytes[stop] !== 0) stop++;
	const raw = bytes.subarray(start, stop);
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(raw);
	} catch {
		let s = '';
		for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
		return s;
	}
}

/**
 * Nintendo's 16-bit name hash, shared with RARC.
 *
 * The multiply-by-3 is cheap on the Gekko's integer unit (one `mulli`, or a
 * shift-and-add) while still spreading short ASCII names across all 16 bits.
 */
export function j3dNameHash(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 3 + (name.charCodeAt(i) & 0xff)) & 0xffff;
	}
	return hash;
}

/**
 * Read a J3D string table at absolute offset `offset`, refusing to read past
 * `limit` (normally the end of the enclosing chunk).
 *
 * Returns `null` when the table header or the entry array would not fit.
 * Individual string offsets that point outside the table yield `''` rather
 * than failing the whole table, because a single bogus name shouldn't cost
 * you the model.
 *
 * We deliberately do *not* require the 0xFFFF sentinel: some third-party
 * exporters write 0 there, and the field is meaningless to a reader that
 * doesn't do hash lookups.
 */
export function readJ3dStringTable(
	bytes: Uint8Array,
	offset: number,
	limit: number,
): string[] | null {
	if (offset < 0 || offset + 4 > limit) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint16(offset, false);
	const entriesEnd = offset + 4 + count * 4;
	if (entriesEnd > limit) return null;
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const p = offset + 4 + i * 4;
		const strOffset = view.getUint16(p + 2, false);
		const start = offset + strOffset;
		out.push(start >= offset && start < limit ? decodeName(bytes, start, limit) : '');
	}
	return out;
}
