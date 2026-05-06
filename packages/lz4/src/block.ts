/**
 * LZ4 block-format decoder — the actual LZ77-style compression core.
 *
 * The block format is what the various LZ4 frame formats wrap around.
 * Each block is a stream of "sequences"; each sequence is a token byte
 * followed by some literals and (usually) a back-reference.
 *
 * Per-sequence layout:
 *
 *   ┌──────────┬──────────────────┬────────────┬───────────────────┬──────────────────┐
 *   │  token   │   extra literal  │  literals  │   back-ref offset │ extra match-len  │
 *   │ (1 byte) │   length bytes   │   (n×1)    │     (2 bytes LE)  │    bytes         │
 *   │  hi:lit  │   if lit==15     │            │                   │  if mlen_nib==15 │
 *   │  lo:mlen │                  │            │                   │                  │
 *   └──────────┴──────────────────┴────────────┴───────────────────┴──────────────────┘
 *
 * - High nibble of token = literal length (0–14, or 15 = "read more").
 * - Literals are copied verbatim to the output.
 * - Then a 2-byte LE offset (= position of source bytes, relative to
 *   the *current* output position).
 * - Low nibble of token = match length minus 4 (since LZ4 minmatch=4),
 *   again with 15 = "read more".
 * - The match copy must be byte-by-byte to support overlapping copies
 *   (e.g. offset=1 length=N produces an RLE run).
 *
 * "Read more" length extension: each subsequent byte adds its value
 * (0–255) to the running total; bytes < 255 terminate the chain.
 *
 * The final sequence in a block contains only literals (no match copy
 * follows) — we detect this by hitting end-of-input rather than via
 * any explicit marker.
 *
 * Reference: https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
 */

export interface DecodeBlockOptions {
	/**
	 * If `true`, the returned `Uint8Array` is sliced to the actual
	 * number of decoded bytes (which may be less than `outputSize`).
	 * Use this when `outputSize` is an *upper bound* — e.g. when
	 * decoding a frame-format block whose true size we don't know.
	 *
	 * If `false` (default), {@link decodeBlock} throws when the
	 * decoded size doesn't equal `outputSize`. This is the safer
	 * choice when the size is known exactly (e.g. Switch-firmware
	 * `.lz4` files, where the size is recorded out-of-band).
	 */
	allowShorter?: boolean;
}

/**
 * Decompress a single LZ4 block into a freshly-allocated `Uint8Array`
 * of (up to) `outputSize` bytes.
 *
 * Both `input.length` and `outputSize` must be known up-front — LZ4
 * blocks carry no self-describing size info; that's the job of the
 * surrounding frame format, or of an application-specific wrapper.
 *
 * Throws if the block is malformed in any way that would cause the
 * decoder to read or write past its buffers, or (if `allowShorter`
 * is unset) if the decoded payload doesn't exactly match `outputSize`.
 */
export function decodeBlock(
	input: Uint8Array,
	outputSize: number,
	opts: DecodeBlockOptions = {},
): Uint8Array {
	const out = new Uint8Array(outputSize);
	const inLen = input.length;
	let inPos = 0;
	let outPos = 0;

	while (inPos < inLen) {
		// --- Token byte ---
		const token = input[inPos++];

		// --- Literal length ---
		let literalLen = token >>> 4;
		if (literalLen === 0x0f) {
			literalLen += readLengthExtension(input, inPos);
			inPos = lastReadEnd;
		}

		// --- Copy literals ---
		if (literalLen > 0) {
			if (inPos + literalLen > inLen) {
				throw new Error(
					`LZ4: literal run of ${literalLen} bytes at inPos=${inPos} would exceed input length ${inLen}`,
				);
			}
			if (outPos + literalLen > outputSize) {
				throw new Error(
					`LZ4: literal run of ${literalLen} bytes would overflow output (outPos=${outPos}, outputSize=${outputSize})`,
				);
			}
			out.set(input.subarray(inPos, inPos + literalLen), outPos);
			inPos += literalLen;
			outPos += literalLen;
		}

		// The last sequence has only literals — no offset / match copy
		// follows. Detect by hitting end-of-input.
		if (inPos >= inLen) break;

		// --- Match offset (2 bytes LE) ---
		if (inPos + 2 > inLen) {
			throw new Error(`LZ4: truncated match offset at inPos=${inPos}`);
		}
		const offset = input[inPos] | (input[inPos + 1] << 8);
		inPos += 2;
		if (offset === 0) {
			throw new Error(
				`LZ4: invalid match offset 0 (corrupt block) at inPos=${inPos - 2}`,
			);
		}
		if (offset > outPos) {
			throw new Error(
				`LZ4: match offset ${offset} points before start of output (outPos=${outPos})`,
			);
		}

		// --- Match length ---
		let matchLen = (token & 0x0f) + 4;
		if ((token & 0x0f) === 0x0f) {
			matchLen += readLengthExtension(input, inPos);
			inPos = lastReadEnd;
		}
		if (outPos + matchLen > outputSize) {
			throw new Error(
				`LZ4: match copy of ${matchLen} bytes would overflow output (outPos=${outPos}, outputSize=${outputSize})`,
			);
		}

		// --- Match copy (byte-by-byte to support overlapping) ---
		// For offset==1 this is a 1-byte RLE run. For 1 < offset <
		// matchLen, the source positions overlap with positions we're
		// currently writing — by spec, the in-progress writes are
		// the values copied. A byte-by-byte loop handles this exactly.
		const src = outPos - offset;
		for (let i = 0; i < matchLen; i++) {
			out[outPos + i] = out[src + i];
		}
		outPos += matchLen;
	}

	if (opts.allowShorter) {
		// Shrink to the actual decoded length — the caller passed
		// `outputSize` as an upper bound only.
		return outPos === outputSize ? out : out.slice(0, outPos);
	}
	if (outPos !== outputSize) {
		throw new Error(
			`LZ4: decoded ${outPos} bytes but expected ${outputSize}`,
		);
	}
	return out;
}

/**
 * Read a variable-length-encoded length extension from `input`
 * starting at `pos`. Each byte adds its value (0–255) to the running
 * total; a value < 255 terminates the chain.
 *
 * Returns the *added* length (not the total — the caller adds the
 * initial 0xF nibble). The byte position just past the last consumed
 * byte is stashed in {@link lastReadEnd} so the caller can advance
 * its own input pointer without us having to box one up.
 */
function readLengthExtension(input: Uint8Array, pos: number): number {
	let added = 0;
	while (pos < input.length) {
		const b = input[pos++];
		added += b;
		if (b < 0xff) {
			lastReadEnd = pos;
			return added;
		}
	}
	throw new Error(`LZ4: truncated length extension at inPos=${pos}`);
}

/**
 * Sidechannel that {@link readLengthExtension} writes its
 * post-consumption position into. Module-level state is fine here:
 * `decodeBlock` is synchronous and single-threaded, so two
 * concurrent decodes can't race.
 */
let lastReadEnd = 0;
