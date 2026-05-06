/**
 * Lazy-loaded zstd helpers for NCZ decompression.
 *
 * Uses `fzstd` — a tiny pure-JS zstd decoder that streams.
 */
import type { ZstdDecompressBlob, ZstdDecompressStream } from '@tootallnate/ncz';

let fzstdMod: typeof import('fzstd') | null = null;
async function getFzstd() {
	if (!fzstdMod) {
		fzstdMod = await import('fzstd');
	}
	return fzstdMod;
}

/** Decompress an entire compressed Blob into a Uint8Array. */
export const zstdDecompressBlob: ZstdDecompressBlob = async (blob) => {
	const fzstd = await getFzstd();
	const compressed = new Uint8Array(await blob.arrayBuffer());
	return fzstd.decompress(compressed);
};

/**
 * Streaming decompression. Wires fzstd's push-style decoder onto a
 * standard `ReadableStream` interface.
 */
export const zstdDecompressStream: ZstdDecompressStream = (input) => {
	const reader = input.getReader();
	let decoder: import('fzstd').Decompress | null = null;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const fzstd = await getFzstd();
			decoder = new fzstd.Decompress((chunk, isLast) => {
				if (chunk && chunk.length) controller.enqueue(chunk);
				if (isLast) controller.close();
			});
		},
		async pull(controller) {
			if (!decoder) return;
			const { value, done } = await reader.read();
			if (done) {
				try {
					// Flush — no-op input signals EOF
					decoder.push(new Uint8Array(0), true);
				} catch (err) {
					controller.error(err);
				}
				return;
			}
			try {
				decoder.push(value, false);
			} catch (err) {
				controller.error(err);
			}
		},
		cancel(reason) {
			reader.cancel(reason);
		},
	});
};
