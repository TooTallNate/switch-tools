/**
 * FF7's LZSS variant. Used by `flevel.lgp` field-scene entries
 * (and various other FF7 PC assets — `.lzs` files, save-game
 * blobs, etc.). It's the Okumura LZSS with FF7's specific
 * window initialization + a 4-byte length-prefix header.
 *
 *   +-------------+------------------------+
 *   | u32 declLen | LZSS stream (declLen)  |
 *   +-------------+------------------------+
 *
 * Stream encoding: 1 control byte followed by 8 tokens. Control
 * bits are read LSB-first; bit = 1 → literal byte, bit = 0 →
 * back-reference (2 bytes):
 *
 *   byte1:  low 8 bits of offset
 *   byte2:  high nibble = top 4 bits of offset
 *           low nibble  = (length − 3)   →  length in [3, 18]
 *
 * The 12-bit raw offset is mapped to a "real" buffer offset via
 * a 4096-byte circular window initialised to zero whose write
 * head starts at `0xFEE = 4078`:
 *
 *   realOffset = tail − ((tail − 18 − raw) mod 4096)
 *
 * Two edge cases (both fire in real field files):
 *  - **Negative position** → emit a zero byte (window was pre-
 *    zeroed when authored).
 *  - **Run past tail** → byte i emits `output[realOffset + (i mod chunkLen)]`
 *    where `chunkLen = tail − realOffset`. This is the RLE-
 *    style wraparound used to encode runs of literally any
 *    repeating byte pattern with one reference.
 *
 * The 4-byte header length is `decompressedInputLength - 4` (i.e.
 * it counts the LZSS stream bytes, not the decompressed size).
 * We sanity-check it but proceed even when it mismatches — some
 * FF7 mods stash extra bytes after the legit stream.
 */
export interface LzssOptions {
	/**
	 * Hint for the output buffer's initial capacity. The true
	 * size isn't known until decompression finishes; passing a
	 * close upper bound avoids repeated Array growth. Defaults
	 * to 4× the input length.
	 */
	expectedSize?: number;
}

/**
 * Decompress an FF7 LZSS-wrapped byte stream.
 *
 * @throws RangeError if `input` is shorter than the 4-byte
 *   length header.
 */
export function decompressLzss(
	input: Uint8Array,
	options: LzssOptions = {},
): Uint8Array {
	if (input.length < 4) {
		throw new RangeError(
			`FF7 LZSS input too short (${input.length} bytes); need at least 4 for the length header`,
		);
	}
	// The header length is informational; we don't trust it as a
	// hard stop because some mods append junk. We DO use it to
	// pre-size the output for the common case where the data
	// expands ~2-4×.
	const headerLen =
		input[0]! |
		(input[1]! << 8) |
		(input[2]! << 16) |
		(input[3]! << 24);
	const streamEnd = Math.min(input.length, 4 + (headerLen >>> 0));

	// Output buffer starts at 4× input size (a typical expansion
	// ratio for FF7 field scenes) and grows geometrically. We
	// build into a Uint8Array directly rather than a JS array of
	// numbers — saves ~2× memory.
	let cap = Math.max(
		options.expectedSize ?? input.length * 4,
		input.length * 2,
	);
	let out = new Uint8Array(cap);
	let outLen = 0;

	const append = (b: number) => {
		if (outLen >= cap) {
			cap *= 2;
			const next = new Uint8Array(cap);
			next.set(out);
			out = next;
		}
		out[outLen++] = b;
	};

	let pos = 4;
	while (pos < streamEnd) {
		const ctrl = input[pos++]!;
		for (let bit = 0; bit < 8 && pos < streamEnd; bit++) {
			const isLiteral = (ctrl & (1 << bit)) !== 0;
			if (isLiteral) {
				append(input[pos++]!);
			} else {
				if (pos + 1 >= streamEnd) break;
				const b1 = input[pos++]!;
				const b2 = input[pos++]!;
				const rawOffset = ((b2 >> 4) << 8) | b1;
				const rawLength = b2 & 0x0f;
				const length = rawLength + 3;
				const tail = outLen;
				// Map 12-bit raw offset → absolute output position.
				// `tail - 18 - rawOffset` is the relative jump; mod
				// 4096 wraps it through the implicit zero window.
				const realOffset =
					tail - (((tail - 18 - rawOffset) % 4096 + 4096) % 4096);
				for (let i = 0; i < length; i++) {
					const p = realOffset + i;
					if (p < 0) {
						append(0);
					} else if (p >= tail) {
						// Run-past-tail: emit the chunk repeatedly.
						const chunk = tail - realOffset;
						if (chunk > 0) {
							append(out[realOffset + (i % chunk)]!);
						} else {
							append(0);
						}
					} else {
						append(out[p]!);
					}
				}
			}
		}
	}

	return out.subarray(0, outLen);
}

/**
 * Quick check whether `bytes` looks like an FF7 LZSS stream:
 * the declared length matches the actual stream length. Not a
 * strong check — any 4 random bytes could happen to match — but
 * it filters out obviously-wrong inputs cheaply.
 */
export function isLzss(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	const declared =
		bytes[0]! |
		(bytes[1]! << 8) |
		(bytes[2]! << 16) |
		(bytes[3]! << 24);
	return declared === bytes.length - 4;
}
