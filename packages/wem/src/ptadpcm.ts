/**
 * Platinum "PTADPCM" (Wwise codec 0x8311): a 4-bit ADPCM PlatinumGames
 * added to Wwise, used throughout Bayonetta 3 and Astral Chain.
 *
 * Ported from vgmstream's `ptadpcm_decoder.c` (reverse engineered from
 * the games' executables) and the PTADPCM branch of its `wwise.c`:
 *
 * - Each channel is coded in frames of `blockAlign / channels` bytes
 *   (0x24 or 0x104), interleaved frame by frame across channels.
 * - A frame starts with two 16-bit history samples (output as the
 *   frame's first two samples, older first) and a table index byte,
 *   then nibbles, low nibble first: `2 + (frameSize − 5) · 2` samples.
 * - Each nibble looks up `[step, nextIndex]` for the current index;
 *   the sample is `clamp16(step + 2·hist1 − hist2)`.
 */

/** `[index][nibble]` → `[step, next index]`; rows past 11 are zero. */
const TABLE: readonly (readonly (readonly [number, number])[])[] = [
	[[-14, 2], [-10, 2], [-7, 1], [-5, 1], [-3, 0], [-2, 0], [-1, 0], [0, 0], [0, 0], [1, 0], [2, 0], [3, 0], [5, 1], [7, 1], [10, 2], [14, 2]],
	[[-28, 3], [-20, 3], [-14, 2], [-10, 2], [-7, 1], [-5, 1], [-3, 1], [-1, 0], [1, 0], [3, 1], [5, 1], [7, 1], [10, 2], [14, 2], [20, 3], [28, 3]],
	[[-56, 4], [-40, 4], [-28, 3], [-20, 3], [-14, 2], [-10, 2], [-6, 2], [-2, 1], [2, 1], [6, 2], [10, 2], [14, 2], [20, 3], [28, 3], [40, 4], [56, 4]],
	[[-112, 5], [-80, 5], [-56, 4], [-40, 4], [-28, 3], [-20, 3], [-12, 3], [-4, 2], [4, 2], [12, 3], [20, 3], [28, 3], [40, 4], [56, 4], [80, 5], [112, 5]],
	[[-224, 6], [-160, 6], [-112, 5], [-80, 5], [-56, 4], [-40, 4], [-24, 4], [-8, 3], [8, 3], [24, 4], [40, 4], [56, 4], [80, 5], [112, 5], [160, 6], [224, 6]],
	[[-448, 7], [-320, 7], [-224, 6], [-160, 6], [-112, 5], [-80, 5], [-48, 5], [-16, 4], [16, 4], [48, 5], [80, 5], [112, 5], [160, 6], [224, 6], [320, 7], [448, 7]],
	[[-896, 8], [-640, 8], [-448, 7], [-320, 7], [-224, 6], [-160, 6], [-96, 6], [-32, 5], [32, 5], [96, 6], [160, 6], [224, 6], [320, 7], [448, 7], [640, 8], [896, 8]],
	[[-1792, 9], [-1280, 9], [-896, 8], [-640, 8], [-448, 7], [-320, 7], [-192, 7], [-64, 6], [64, 6], [192, 7], [320, 7], [448, 7], [640, 8], [896, 8], [1280, 9], [1792, 9]],
	[[-3584, 10], [-2560, 10], [-1792, 9], [-1280, 9], [-896, 8], [-640, 8], [-384, 8], [-128, 7], [128, 7], [384, 8], [640, 8], [896, 8], [1280, 9], [1792, 9], [2560, 10], [3584, 10]],
	[[-7168, 11], [-5120, 11], [-3584, 10], [-2560, 10], [-1792, 9], [-1280, 9], [-768, 9], [-256, 8], [256, 8], [768, 9], [1280, 9], [1792, 9], [2560, 10], [3584, 10], [5120, 11], [7168, 11]],
	[[-14336, 11], [-10240, 11], [-7168, 11], [-5120, 11], [-3584, 10], [-2560, 10], [-1536, 10], [-512, 9], [512, 9], [1536, 10], [2560, 10], [3584, 10], [5120, 11], [7168, 11], [10240, 11], [14336, 11]],
	[[-28672, 11], [-20480, 11], [-14336, 11], [-10240, 11], [-7168, 11], [-5120, 11], [-3072, 11], [-1024, 10], [1024, 10], [3072, 11], [5120, 11], [7168, 11], [10240, 11], [14336, 11], [20480, 11], [28672, 11]],
];

const clamp16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

/** Samples per channel for `bytes` of PTADPCM data. */
export function ptadpcmSampleCount(bytes: number, channels: number, frameSize: number): number {
	if (channels <= 0 || frameSize < 6) return 0;
	return Math.floor(bytes / (channels * frameSize)) * (2 + (frameSize - 5) * 2);
}

/**
 * Decode PTADPCM to interleaved 16-bit PCM. `blockAlign` is the WEM
 * `fmt` block alignment (one frame per channel).
 */
export function decodePtadpcm(data: Uint8Array, channels: number, blockAlign: number): Int16Array {
	const frameSize = Math.floor(blockAlign / Math.max(1, channels));
	if (frameSize < 6) throw new Error(`PTADPCM frame size ${frameSize} is too small`);
	const perFrame = 2 + (frameSize - 5) * 2;
	const blocks = Math.floor(data.length / (frameSize * channels));
	const out = new Int16Array(blocks * perFrame * channels);
	for (let b = 0; b < blocks; b++) {
		for (let ch = 0; ch < channels; ch++) {
			const f = (b * channels + ch) * frameSize;
			let hist2 = (data[f]! | (data[f + 1]! << 8)) << 16 >> 16;
			let hist1 = (data[f + 2]! | (data[f + 3]! << 8)) << 16 >> 16;
			let index = Math.min(12, data[f + 4]!);
			let o = (b * perFrame) * channels + ch;
			out[o] = hist2;
			o += channels;
			out[o] = hist1;
			o += channels;
			for (let i = 0; i < perFrame - 2; i++) {
				const byte = data[f + 5 + (i >> 1)]!;
				const nibble = i & 1 ? byte >> 4 : byte & 0xf;
				const row = TABLE[index];
				const step = row ? row[nibble]![0] : 0;
				index = row ? row[nibble]![1] : index;
				const sample = clamp16(step + 2 * hist1 - hist2);
				out[o] = sample;
				o += channels;
				hist2 = hist1;
				hist1 = sample;
			}
		}
	}
	return out;
}
