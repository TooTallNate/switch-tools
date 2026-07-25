/**
 * J3D container: the outer wrapper shared by `.bmd` and `.bdl` models.
 *
 * "J3D" is the model format of Nintendo's JSystem engine — the one behind
 * *The Legend of Zelda: The Wind Waker* and *Twilight Princess*, *Super Mario
 * Sunshine*, *Pikmin*, *Luigi's Mansion*, and the GameCube *Animal Crossing*.
 * A model is a flat, chunked container, in the same spirit as RIFF: a small
 * fixed header followed by a series of self-describing sections.
 *
 * Header, 0x20 bytes:
 *
 *   0x00 char[8] magic       — 'J3D2bmd3', 'J3D2bdl4', or the older
 *                              'J3D1bmd1' / 'J3D1bmd2'
 *   0x08 u32     fileSize
 *   0x0C u32     chunkCount
 *   0x10 u8[16]  padding     — usually the ASCII tag 'SVR3' ("SuperVisor
 *                              Revision 3", the internal name of the tool
 *                              that wrote the file) followed by 0xFF fill
 *   0x20 ...     chunks
 *
 * Then each chunk:
 *
 *   0x00 u32 magic  — 'INF1', 'VTX1', 'EVP1', 'DRW1', 'JNT1', 'SHP1',
 *                     'MAT3', 'MDL3', 'TEX1'
 *   0x04 u32 size   — **includes** these 8 header bytes
 *   0x08 ...  payload
 *
 * You walk the file by repeatedly advancing `size`, which is why a `size` of
 * 0 (or anything under 8) has to be rejected explicitly: otherwise a corrupt
 * or truncated file turns the walk into an infinite loop, and in a file
 * browser a hang is much worse than an error message.
 *
 * The difference between `bmd` and `bdl` is only the presence of `MDL3`: a
 * `.bdl` carries a pre-baked list of GX register writes (a "display list" for
 * the *material* state, as opposed to the geometry display lists in `SHP1`)
 * so the game can bind a material by DMA-ing bytes straight at the command
 * processor instead of walking `MAT3` and issuing individual register writes.
 * Everything else is identical, so we parse both with one code path and only
 * record which flavour we saw.
 *
 * The single most important structural rule, and the source of most bugs in
 * third-party J3D readers: **every offset stored inside a chunk is relative to
 * the start of that chunk, i.e. to the chunk's own magic — not to the payload
 * and not to the file.** The struct *fields* documented in the individual
 * chunk modules, on the other hand, are listed relative to the payload (chunk
 * + 8), because that's how every reference documents them. So an `INF1` whose
 * fields occupy payload 0x00..0x0F stores `hierarchyOffset = 0x18`, which is
 * 0x08 (chunk header) + 0x10 (fields). We resolve all of that here via
 * {@link chunkOffset} so the individual parsers never do the arithmetic
 * themselves.
 *
 * References:
 *   - http://wiki.tockdom.com/wiki/BMD_and_BDL_(File_Format)
 *   - https://wiki.cloudmodding.com/tww/BMD_and_BDL
 *   - noclip.website, src/Common/JSYSTEM/J3D/J3DLoader.ts
 */

import { CHUNK_HEADER_SIZE, readAscii } from './util.js';

/** Size of the fixed container header, and therefore the offset of chunk 0. */
export const J3D_HEADER_SIZE = 0x20;

/** A located chunk. `offset` is absolute; `size` includes the 8-byte header. */
export interface J3dChunk {
	magic: string;
	offset: number;
	size: number;
}

export interface J3dContainer {
	/** 'bmd' or 'bdl', taken from bytes 4..6 of the magic. */
	kind: 'bmd' | 'bdl';
	/** The whole 8-character magic, e.g. `J3D2bmd3`. */
	version: string;
	/** File size as claimed by the header (informational; may be short). */
	fileSize: number;
	/** Chunk count as claimed by the header. */
	chunkCount: number;
	/** The chunks actually found, in file order. */
	chunks: J3dChunk[];
}

/**
 * Cheap magic check. Safe to call on arbitrary bytes.
 *
 * We check `J3D`, then a version digit, then `bmd`/`bdl`. The final character
 * is a sub-version digit (`bmd1`, `bmd2`, `bmd3`, `bdl4`) and we accept any
 * digit there rather than enumerating the four combinations seen at retail —
 * the chunk walk is what actually validates the file, and being generous here
 * costs nothing.
 */
export function isJ3d(bytes: Uint8Array, offset = 0): boolean {
	if (!Number.isInteger(offset) || offset < 0) return false;
	if (offset + J3D_HEADER_SIZE > bytes.length) return false;
	if (
		bytes[offset] !== 0x4a || // 'J'
		bytes[offset + 1] !== 0x33 || // '3'
		bytes[offset + 2] !== 0x44 // 'D'
	) {
		return false;
	}
	const versionDigit = bytes[offset + 3];
	if (versionDigit < 0x30 || versionDigit > 0x39) return false;
	const kind = readAscii(bytes, offset + 4, 3);
	if (kind !== 'bmd' && kind !== 'bdl') return false;
	const subVersion = bytes[offset + 7];
	return subVersion >= 0x30 && subVersion <= 0x39;
}

/**
 * Walk the container. Returns `null` on a bad magic or a malformed chunk
 * table, rather than throwing, so callers can sniff-and-parse in one step
 * while iterating an unknown archive.
 *
 * A chunk whose `size` is under 8 or which runs past the end of the buffer
 * fails the whole parse. That's deliberate: both cases mean we've lost sync
 * with the chunk table, so anything we produced after that point would be
 * fiction.
 *
 * `chunkCount` from the header is honoured as the expected number of chunks,
 * but the buffer is the hard limit: files padded out with trailing garbage
 * (common when a model is extracted from a disc image) still parse.
 */
export function parseJ3dContainer(
	bytes: Uint8Array,
	offset = 0,
): J3dContainer | null {
	if (!isJ3d(bytes, offset)) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = readAscii(bytes, offset, 8);
	const kind = version.substring(4, 7) as 'bmd' | 'bdl';
	const fileSize = view.getUint32(offset + 0x08, false);
	const chunkCount = view.getUint32(offset + 0x0c, false);

	// Trust `fileSize` only when it's self-consistent; otherwise fall back to
	// the buffer. A model embedded in a bigger buffer (e.g. a RARC we didn't
	// slice) needs the header's size to know where to stop; a model padded by
	// an extractor needs the opposite.
	const limit =
		fileSize >= J3D_HEADER_SIZE && offset + fileSize <= bytes.length
			? offset + fileSize
			: bytes.length;

	// Sanity bound before we loop: no J3D file has ever had more than ~9
	// chunks, but a corrupt u32 could ask us to spin for four billion.
	if (chunkCount > 0xffff) return null;

	const chunks: J3dChunk[] = [];
	let p = offset + J3D_HEADER_SIZE;
	for (let i = 0; i < chunkCount; i++) {
		if (p + CHUNK_HEADER_SIZE > limit) break;
		const magic = readAscii(bytes, p, 4);
		const size = view.getUint32(p + 4, false);
		// `size` includes the header, so anything below 8 cannot advance `p`.
		if (size < CHUNK_HEADER_SIZE) return null;
		if (p + size > limit) return null;
		chunks.push({ magic, offset: p, size });
		p += size;
	}

	return { kind, version, fileSize, chunkCount, chunks };
}

/** First chunk with the given magic, or `null`. */
export function findChunk(
	chunks: readonly J3dChunk[],
	magic: string,
): J3dChunk | null {
	for (const c of chunks) if (c.magic === magic) return c;
	return null;
}

/**
 * Sanity-check a chunk against the buffer it supposedly lives in.
 *
 * {@link parseJ3dContainer} already guarantees this, but the chunk parsers are
 * exported individually (handy for tests and for tools that only care about
 * one section), so each one re-validates rather than trusting its caller.
 */
export function validateChunk(bytes: Uint8Array, chunk: J3dChunk): boolean {
	if (!Number.isInteger(chunk.offset) || chunk.offset < 0) return false;
	if (!Number.isInteger(chunk.size) || chunk.size < CHUNK_HEADER_SIZE) {
		return false;
	}
	return chunk.offset + chunk.size <= bytes.length;
}

/**
 * Resolve a chunk-relative offset to an absolute one, checking that at least
 * `need` bytes are available inside the chunk. Returns -1 when the offset is
 * unusable — which includes 0, the format's universal "this table is absent"
 * marker (no real table can start inside the chunk's own 8-byte header).
 */
export function chunkOffset(chunk: J3dChunk, rel: number, need = 1): number {
	if (!Number.isInteger(rel) || rel < CHUNK_HEADER_SIZE) return -1;
	if (need < 0) return -1;
	if (rel + need > chunk.size) return -1;
	return chunk.offset + rel;
}
