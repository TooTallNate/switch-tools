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
 * Streaming zstd decompression that adapts fzstd's push-style decoder
 * onto a standard `ReadableStream` interface.
 *
 * Why this is non-trivial: the natural one-line wrapper —
 *
 *     pull = async () => decoder.push(await reader.read(), false)
 *
 * — deadlocks on any real-world stream. zstd typically needs to
 * consume *several* input chunks before producing the first byte of
 * decompressed output (the decoder buffers until it has a full
 * compressed block). The stream's `pull` contract says: if `pull`
 * returns without enqueueing anything, the stream stops calling
 * `pull` until its buffer drains. With no output, the buffer is
 * already empty, so there's nothing to drain → no further `pull`
 * call → permanent hang.
 *
 * The fix is to keep feeding input inside a single `pull` call
 * until the decoder produces at least one output chunk or we
 * actually reach end-of-input.
 */
export const zstdDecompressStream: ZstdDecompressStream = (input) => {
	const reader = input.getReader();
	let decoder: import('fzstd').Decompress | null = null;
	const decoderReady = (async () => {
		const fzstd = await getFzstd();
		return fzstd;
	})();

	// Output chunks emitted by fzstd during the most recent `push()`
	// call, and a flag set when the decoder signalled end-of-stream.
	let pendingChunks: Uint8Array[] = [];
	let decoderClosed = false;

	return new ReadableStream<Uint8Array>({
		async start() {
			const fzstd = await decoderReady;
			decoder = new fzstd.Decompress((chunk, isLast) => {
				if (chunk && chunk.length) pendingChunks.push(chunk);
				if (isLast) decoderClosed = true;
			});
		},
		async pull(controller) {
			if (!decoder) await decoderReady;
			// Keep feeding input until either the decoder produces
			// some output, or we run out of input data.
			while (pendingChunks.length === 0 && !decoderClosed) {
				const { value, done } = await reader.read();
				try {
					if (done) {
						// Flush — empty input + isLast=true signals EOF.
						decoder!.push(new Uint8Array(0), true);
						break;
					}
					decoder!.push(value, false);
				} catch (err) {
					controller.error(err);
					return;
				}
			}
			// Drain whatever fzstd produced into the consumer.
			for (const c of pendingChunks) controller.enqueue(c);
			pendingChunks = [];
			if (decoderClosed) controller.close();
		},
		cancel(reason) {
			reader.cancel(reason);
		},
	});
};
