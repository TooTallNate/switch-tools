/**
 * Rare "1172" container.
 *
 * Rare's Nintendo 64 engine (GoldenEye 007, Perfect Dark) stores
 * nearly all of its assets as individually-compressed files laid
 * back-to-back in the ROM, each introduced by the two-byte
 * big-endian magic `0x1172`. Despite a long-standing reputation as
 * a bespoke Rare scheme, the payload is simply a **raw DEFLATE
 * stream** (RFC 1951, no zlib or gzip wrapper) — so it decodes with
 * the platform's own `DecompressionStream('deflate-raw')`, no WASM
 * and no hand-written LZ decoder.
 *
 * Layout:
 *
 *   +0  u16be  0x1172
 *   +2  ...    raw DEFLATE stream (self-terminating)
 *
 * There is no length field and no decompressed-size field: the
 * DEFLATE stream's own final-block flag ends it, and the next file
 * begins immediately after. Verified against GoldenEye 007 (USA):
 * 800 of 800 consecutive file pairs decompress completely within
 * the gap to the following file, so the ROM really is a contiguous
 * run of these containers.
 *
 * The ROM carries no usable index of these files, so
 * {@link scanRare1172} locates them by magic and confirms each one
 * by decompressing it. DEFLATE is strongly self-validating
 * (Huffman-coded block structure, explicit end-of-stream), which
 * makes the false-positive rate negligible.
 */

/** Big-endian magic introducing a Rare 1172 container. */
export const RARE_1172_MAGIC = 0x1172;

/** Does a Rare 1172 container start at `offset`? */
export function isRare1172(bytes: Uint8Array, offset = 0): boolean {
	return (
		offset >= 0 &&
		offset + 2 <= bytes.length &&
		bytes[offset] === 0x11 &&
		bytes[offset + 1] === 0x72
	);
}

/**
 * Inflate a raw DEFLATE stream using the platform's
 * `DecompressionStream`.
 *
 * Both ends of the transform can reject independently — a malformed
 * stream surfaces on the reader while the writer rejects separately
 * — so the writer's rejection is absorbed to avoid an unhandled
 * rejection escaping the call.
 */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error(
			'Rare 1172: DecompressionStream is unavailable in this environment',
		);
	}
	const stream = new DecompressionStream('deflate-raw');
	const writer = stream.writable.getWriter();
	const pump = (async () => {
		// Cast: lib.dom types `BufferSource` as ArrayBuffer-backed,
		// but a Uint8Array parameter is `ArrayBufferLike`. A slice of
		// a ROM buffer is never SharedArrayBuffer-backed in practice.
		await writer.write(bytes as unknown as BufferSource);
		await writer.close();
	})().catch(() => {
		// Surfaced on the reader instead.
	});

	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
		}
	} finally {
		await pump;
	}

	const out = new Uint8Array(total);
	let position = 0;
	for (const chunk of chunks) {
		out.set(chunk, position);
		position += chunk.length;
	}
	return out;
}

export interface DecompressRare1172Options {
	/**
	 * Exclusive end of the compressed data. Defaults to the end of
	 * the buffer.
	 *
	 * Bounding this matters when walking a ROM: DEFLATE terminates
	 * itself, so passing the whole remainder also works, but
	 * limiting the slice to the next file's offset keeps the
	 * decoder from scanning megabytes of trailing data.
	 */
	end?: number;
}

/**
 * Decompress the Rare 1172 container at `offset`.
 *
 * Throws if the magic is absent or the DEFLATE stream is malformed.
 */
export async function decompressRare1172(
	bytes: Uint8Array,
	offset = 0,
	options: DecompressRare1172Options = {},
): Promise<Uint8Array> {
	if (!isRare1172(bytes, offset)) {
		throw new Error(
			`Rare 1172: bad magic at 0x${offset.toString(16)} (expected 0x1172)`,
		);
	}
	const end = Math.min(options.end ?? bytes.length, bytes.length);
	if (end <= offset + 2) {
		throw new Error(`Rare 1172: empty payload at 0x${offset.toString(16)}`);
	}
	return inflateRaw(bytes.subarray(offset + 2, end));
}

/** A container located and confirmed by {@link scanRare1172}. */
export interface Rare1172File {
	/** Buffer offset of the `0x1172` magic. */
	offset: number;
	/** Decompressed size in bytes. */
	size: number;
}

export interface ScanRare1172Options {
	/**
	 * Ignore files smaller than this many bytes (default 64).
	 * Filters incidental byte pairs that happen to introduce a
	 * short valid stream.
	 */
	minSize?: number;
	/** Stop after this many files (default 65536). */
	limit?: number;
	/**
	 * Cap on the compressed span handed to the decoder for the
	 * final candidate, where there is no following file to bound it
	 * (default 1 MiB).
	 */
	maxCompressedSize?: number;
	/**
	 * Minimum size for a file that has no adjacent neighbour
	 * (default 4096; set 0 to disable).
	 *
	 * Rare ROMs store these containers back-to-back, so genuine
	 * files almost always end exactly where the next one begins.
	 * A hit with no neighbour is usually a coincidence: a byte pair
	 * elsewhere in a ROM that happens to introduce a short valid
	 * DEFLATE stream. The probability of that falls off sharply with
	 * length, so size is the right discriminator for isolated hits —
	 * and it must apply *only* to isolated ones, because Rare's
	 * small files are perfectly real (GoldenEye has ~1100 under 256
	 * bytes) while its largest file is legitimately isolated,
	 * because a stray 0x1172 inside its own compressed data hides
	 * the adjacency.
	 */
	isolatedMinSize?: number;
	/**
	 * Byte stride for the magic search (default 1).
	 *
	 * Nothing in the format aligns containers: because each file is
	 * a self-terminating DEFLATE stream of arbitrary length, the
	 * next one starts wherever the previous ended. GoldenEye's
	 * happen to land on even offsets, but assuming that would skip
	 * files in other ROMs, so the default checks every byte. Raise
	 * to 2 to halve the candidate count when the layout is known.
	 */
	alignment?: number;
}

/**
 * Find every Rare 1172 container in a buffer.
 *
 * Each candidate is bounded by the next candidate's offset, which
 * exploits the contiguous layout: a genuine file decompresses fully
 * within that span. Candidates that fail to decompress, or that
 * yield less than `minSize`, are dropped.
 */
export async function scanRare1172(
	bytes: Uint8Array,
	options: ScanRare1172Options = {},
): Promise<Rare1172File[]> {
	const minSize = options.minSize ?? 64;
	const limit = options.limit ?? 65536;
	const maxCompressedSize = options.maxCompressedSize ?? 1024 * 1024;
	const alignment = Math.max(1, options.alignment ?? 1);
	const isolatedMinSize = options.isolatedMinSize ?? 4096;

	const candidates: number[] = [];
	for (let offset = 0; offset + 2 <= bytes.length; offset += alignment) {
		if (bytes[offset] === 0x11 && bytes[offset + 1] === 0x72) {
			candidates.push(offset);
		}
	}

	const generousEnd = (offset: number) =>
		Math.min(bytes.length, offset + maxCompressedSize);

	// `endsAt` records where the file's compressed data stops, when
	// known — the adjacency signal the isolation filter uses.
	const out: Array<Rare1172File & { endsAt: number | null }> = [];
	for (let i = 0; i < candidates.length; i++) {
		const offset = candidates[i];
		let data: Uint8Array | null = null;
		let endsAt: number | null = null;

		// Fast path: bound by the next candidate. Files sit
		// back-to-back, so for a genuine file this is its exact
		// compressed extent.
		if (i + 1 < candidates.length) {
			try {
				data = await decompressRare1172(bytes, offset, {
					end: candidates[i + 1],
				});
				endsAt = candidates[i + 1];
			} catch {
				data = null;
			}
		}

		// Slow path: a stray 0x1172 *inside* this file's compressed
		// data would truncate the fast path and lose the file, so
		// retry unbounded and let DEFLATE find its own end. Only
		// reached for the rare colliding case.
		if (data === null) {
			try {
				data = await decompressRare1172(bytes, offset, {
					end: generousEnd(offset),
				});
			} catch {
				continue; // Not a container.
			}
		}

		if (data.length >= minSize) {
			out.push({ offset, size: data.length, endsAt });
			if (out.length >= limit) break;
		}
	}

	if (isolatedMinSize <= 0) {
		return out.map(({ offset, size }) => ({ offset, size }));
	}

	// A file is "adjacent" when it ends exactly where the next
	// accepted file starts, or when the previous accepted file ends
	// exactly where it starts.
	const kept: Rare1172File[] = [];
	for (let i = 0; i < out.length; i++) {
		const file = out[i];
		const next = out[i + 1];
		const prev = out[i - 1];
		const adjacent =
			(next !== undefined && file.endsAt === next.offset) ||
			(prev !== undefined && prev.endsAt === file.offset);
		if (adjacent || file.size >= isolatedMinSize) {
			kept.push({ offset: file.offset, size: file.size });
		}
	}
	return kept;
}
