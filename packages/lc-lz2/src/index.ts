/**
 * LC_LZ2 decompressor.
 *
 * LC_LZ2 ("Lunar Compress format 2") is the LZ variant used by
 * Super Mario World for its compressed graphics files, and adopted
 * by the SMW romhacking ecosystem (Lunar Magic, Asar tooling) as a
 * general-purpose format. It is a command-stream codec — not a
 * bit-oriented LZ — which makes it cheap to decode and unusually
 * easy to validate.
 *
 * Wire format: a flat sequence of commands, terminated by a 0xFF
 * byte. Each command starts with a header byte:
 *
 *   Normal header  `CCCLLLLL`
 *     CCC   = command (0-6; 7 escapes to the extended form)
 *     LLLLL = length - 1  (1..32)
 *
 *   Extended header `111CCCLL LLLLLLLL`  (i.e. top 3 bits set)
 *     CCC        = command (0-6)
 *     LL+8 bits  = length - 1  (1..1024)
 *
 * Commands:
 *
 *   0 — Direct copy.      Copy `length` literal bytes from input.
 *   1 — Byte fill.        Read 1 byte; emit it `length` times.
 *   2 — Word fill.        Read 2 bytes; emit them alternately for
 *                         `length` output bytes total.
 *   3 — Increasing fill.  Read 1 byte b; emit b, b+1, b+2, …
 *                         (`length` bytes, wrapping at 256).
 *   4 — Repeat.           Read a 2-byte BIG-ENDIAN absolute offset
 *                         into the output produced so far; copy
 *                         `length` bytes from there. Copies are
 *                         byte-by-byte, so overlapping ranges
 *                         produce run-length behaviour.
 *
 * Commands 5 and 6 are unused by the format and are treated as
 * errors, as are all out-of-bounds reads/writes. This strictness is
 * what makes the codec usable for *scanning*: a wrong guess at a
 * data offset reliably throws rather than emitting garbage.
 *
 * References:
 *   - https://www.smwcentral.net/?p=viewthread&t=13167 (format notes)
 *   - Lunar Compress (FuSoYa) — the reference implementation
 */

/** Decompression result: the payload plus how much input it used. */
export interface Lz2Result {
	bytes: Uint8Array;
	/**
	 * Number of input bytes consumed, including the 0xFF
	 * terminator. Useful for walking a bank of back-to-back
	 * compressed blocks.
	 */
	consumed: number;
}

export interface DecompressLz2Options {
	/**
	 * Hard cap on output size (default 1 MiB). Guards against
	 * pathological or misidentified input producing a runaway
	 * allocation.
	 */
	maxOutputSize?: number;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

/**
 * Decompress an LC_LZ2 stream starting at `offset`.
 *
 * Throws on a malformed stream: truncated input, an unused command
 * id, a back-reference past the end of the data produced so far, or
 * output exceeding `maxOutputSize`.
 */
export function decompressLz2(
	src: Uint8Array,
	offset = 0,
	options: DecompressLz2Options = {},
): Lz2Result {
	const maxOutput = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT;
	if (offset < 0 || offset >= src.length) {
		throw new RangeError(
			`LC_LZ2: start offset ${offset} outside input (${src.length} bytes)`,
		);
	}

	// Grow-on-demand output buffer — the format carries no
	// decompressed-size field.
	let out = new Uint8Array(4096);
	let outLen = 0;
	const ensure = (extra: number) => {
		const need = outLen + extra;
		if (need > maxOutput) {
			throw new RangeError(
				`LC_LZ2: output exceeds ${maxOutput} bytes (runaway or misidentified stream)`,
			);
		}
		if (need <= out.length) return;
		let cap = out.length;
		while (cap < need) cap *= 2;
		const bigger = new Uint8Array(Math.min(cap, maxOutput));
		bigger.set(out.subarray(0, outLen));
		out = bigger;
	};

	let p = offset;
	const readByte = (): number => {
		if (p >= src.length) {
			throw new RangeError('LC_LZ2: truncated input');
		}
		return src[p++];
	};

	for (;;) {
		const header = readByte();
		if (header === 0xff) break; // end of stream

		let command: number;
		let length: number;
		if ((header & 0xe0) === 0xe0) {
			// Extended header: 111CCCLL LLLLLLLL
			command = (header >> 2) & 7;
			length = (((header & 3) << 8) | readByte()) + 1;
		} else {
			command = (header >> 5) & 7;
			length = (header & 0x1f) + 1;
		}

		switch (command) {
			case 0: {
				// Direct copy.
				if (p + length > src.length) {
					throw new RangeError('LC_LZ2: truncated direct copy');
				}
				ensure(length);
				out.set(src.subarray(p, p + length), outLen);
				outLen += length;
				p += length;
				break;
			}
			case 1: {
				// Byte fill.
				const value = readByte();
				ensure(length);
				out.fill(value, outLen, outLen + length);
				outLen += length;
				break;
			}
			case 2: {
				// Word fill.
				const a = readByte();
				const b = readByte();
				ensure(length);
				for (let i = 0; i < length; i++) {
					out[outLen++] = i & 1 ? b : a;
				}
				break;
			}
			case 3: {
				// Increasing fill.
				const base = readByte();
				ensure(length);
				for (let i = 0; i < length; i++) {
					out[outLen++] = (base + i) & 0xff;
				}
				break;
			}
			case 4: {
				// Repeat from an absolute offset in the output.
				const hi = readByte();
				const lo = readByte();
				const from = (hi << 8) | lo;
				if (from >= outLen) {
					throw new RangeError(
						`LC_LZ2: back-reference to 0x${from.toString(16)} past output end (${outLen})`,
					);
				}
				ensure(length);
				// Byte-by-byte: overlapping copies are intentional
				// and produce run-length runs.
				for (let i = 0; i < length; i++) {
					out[outLen++] = out[from + i];
				}
				break;
			}
			default:
				throw new RangeError(
					`LC_LZ2: unused command ${command} at 0x${(p - 1).toString(16)}`,
				);
		}
	}

	return { bytes: out.slice(0, outLen), consumed: p - offset };
}

/**
 * Convenience wrapper returning just the decompressed bytes.
 */
export function decompressLz2Bytes(
	src: Uint8Array,
	offset = 0,
	options?: DecompressLz2Options,
): Uint8Array {
	return decompressLz2(src, offset, options).bytes;
}

/**
 * Cheap plausibility probe: does `offset` look like the start of an
 * LC_LZ2 stream? Decompresses fully and applies size sanity checks.
 *
 * Returns the result on success, `null` on any failure. Intended
 * for scanning ROMs whose compressed-block locations aren't known
 * from a pointer table.
 */
export function tryDecompressLz2(
	src: Uint8Array,
	offset: number,
	options: DecompressLz2Options & {
		/** Minimum plausible output size (default 64). */
		minOutputSize?: number;
	} = {},
): Lz2Result | null {
	const minOutput = options.minOutputSize ?? 64;
	try {
		const result = decompressLz2(src, offset, options);
		if (result.bytes.length < minOutput) return null;
		// Require actual compression — an "expansion" is almost
		// always a false positive on random data.
		if (result.consumed >= result.bytes.length) return null;
		return result;
	} catch {
		return null;
	}
}
