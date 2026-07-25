/**
 * SNES BRR (Bit Rate Reduction) audio decoder.
 *
 * BRR is the native sample format of the SNES S-DSP. Sample data is a
 * flat sequence of 9-byte blocks; each block decodes to 16 PCM samples:
 *
 *   byte 0     = header
 *                  bit 0      = END flag (this is the last block)
 *                  bit 1      = LOOP flag (sample loops; the loop
 *                               point itself lives in the DSP "DIR"
 *                               table, not in the BRR stream)
 *                  bits 2-3   = filter (0-3)
 *                  bits 4-7   = shift / "range" (valid 0-12;
 *                               13-15 are degenerate, see below)
 *   bytes 1..8 = 16 nibbles of sample data, high nibble first.
 *                Each nibble is a *signed* 4-bit value (-8..7).
 *
 * Decoding a nibble `n` with shift `sh`:
 *
 *   sh <= 12 →  s = (n << sh) >> 1
 *   sh >  12 →  s = (n >> 3) << 11     (hardware quirk: -2048 for
 *                                       negative nibbles, 0 otherwise)
 *
 * Then an IIR filter is applied using the previous two *output*
 * samples p1 (most recent) and p2, with the canonical integer forms
 * from fullsnes / snes_spc:
 *
 *   filter 0:  s += 0
 *   filter 1:  s += (p1 * 15) >> 4
 *   filter 2:  s += (p1 * 61) >> 5;  s -= (p2 * 15) >> 4
 *   filter 3:  s += (p1 * 115) >> 6; s -= (p2 * 13) >> 4
 *
 * The result is clamped to signed 16-bit [-32768, 32767]. (Real
 * hardware additionally clips/wraps to 15 bits; for a decoder tool
 * the 16-bit clamp is the desirable behavior, so the 15-bit wrap is
 * intentionally *not* performed here.) Finally p2 = p1, p1 = s, and
 * `s` is emitted as an Int16 sample.
 *
 * References:
 *   - https://problemkaputt.de/fullsnes.htm#snesapudspbrrsamples
 *   - snes_spc (blargg) SPC_DSP.cpp
 */

const BLOCK_SIZE = 9;
const SAMPLES_PER_BLOCK = 16;

export interface DecodeBrrOptions {
	/** Stop at END flag (default true). When false, decode all input blocks. */
	stopAtEnd?: boolean;
	/**
	 * Decode the input this many times in sequence (default 1),
	 * carrying the IIR filter state (p1/p2) across passes.
	 *
	 * This approximates hardware looping for samples whose LOOP
	 * flag is set. The true loop *point* lives in the DSP's DIR
	 * sample directory (in APU RAM at runtime), not in the BRR
	 * stream, so it cannot be recovered from the bytes alone —
	 * repeating from the start is the closest static approximation,
	 * and exact for the common case of loop-start == sample-start.
	 * A short instrument loop played once is a couple-millisecond
	 * click; repeated, it becomes the sustained tone it's meant to
	 * be.
	 */
	repeat?: number;
}

export interface BrrDecodeResult {
	samples: Int16Array;
	/**
	 * Number of 9-byte blocks decoded. With `repeat > 1` this
	 * counts every pass (i.e. it can exceed the input block count).
	 */
	blocks: number;
	/** True if an END-flagged block was reached. */
	ended: boolean;
	/** True if any block had the LOOP flag. */
	loop: boolean;
}

/**
 * Decode a BRR byte stream into 16-bit signed PCM samples.
 *
 * Decoding stops at the first END-flagged block (unless
 * `stopAtEnd: false`), or when fewer than 9 bytes of input remain
 * (trailing partial blocks are ignored).
 */
export function decodeBrr(
	bytes: Uint8Array,
	opts: DecodeBrrOptions = {},
): BrrDecodeResult {
	const stopAtEnd = opts.stopAtEnd ?? true;
	const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
	const maxBlocksPerPass = Math.floor(bytes.length / BLOCK_SIZE);
	const maxBlocks = maxBlocksPerPass * repeat;
	const out = new Int16Array(maxBlocks * SAMPLES_PER_BLOCK);

	let blocks = 0;
	let ended = false;
	let loop = false;
	let p1 = 0;
	let p2 = 0;
	let outPos = 0;

	// Filter state (p1/p2) deliberately carries across passes — see
	// the `repeat` option's doc comment.
	for (let pass = 0; pass < repeat; pass++) {
		for (let block = 0; block < maxBlocksPerPass; block++) {
			const base = block * BLOCK_SIZE;
			const header = bytes[base];
			const shift = header >> 4;
			const filter = (header >> 2) & 3;

			for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
				const b = bytes[base + 1 + (i >> 1)];
				// High nibble first; sign-extend the 4-bit value.
				const raw = i & 1 ? b & 0x0f : b >> 4;
				const nibble = raw >= 8 ? raw - 16 : raw;

				let s: number;
				if (shift <= 12) {
					s = (nibble << shift) >> 1;
				} else {
					// Degenerate shift (13-15): hardware yields -2048 for
					// negative nibbles and 0 otherwise.
					s = (nibble >> 3) << 11;
				}

				switch (filter) {
					case 1:
						s += (p1 * 15) >> 4;
						break;
					case 2:
						s += (p1 * 61) >> 5;
						s -= (p2 * 15) >> 4;
						break;
					case 3:
						s += (p1 * 115) >> 6;
						s -= (p2 * 13) >> 4;
						break;
				}

				// Clamp to signed 16-bit.
				if (s > 32767) s = 32767;
				else if (s < -32768) s = -32768;

				p2 = p1;
				p1 = s;
				out[outPos++] = s;
			}

			blocks++;
			if (header & 0x02) loop = true;
			if (header & 0x01) {
				ended = true;
				// END terminates this pass; further passes restart
				// from the first block (loop approximation).
				if (stopAtEnd) break;
			}
		}
	}

	return {
		samples: blocks === maxBlocks ? out : out.subarray(0, outPos),
		blocks,
		ended,
		loop,
	};
}
