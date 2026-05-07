/**
 * FSB5 extraction from a parsed Bank.
 *
 * The flow:
 *   1. Find the SND chunk in the parsed bank.
 *   2. SND payload starts with some bytes of NUL padding (variable
 *      length — FMODBankDecryptor's heuristic: skip leading 0x00s
 *      until we hit something non-zero).
 *   3. Everything after the padding is either:
 *       - a plaintext FSB5 (`46 53 42 35 ...`), OR
 *       - an XOR-encrypted FSB5 (random-looking bytes).
 *
 * `extractEncryptedSnd` returns the raw bytes after the padding so
 * the caller can probe / decrypt them. `extractFsb5FromBank`
 * combines this with auto-key detection to produce a usable FSB5
 * `Uint8Array` in one call.
 */

import type { ParsedFmodBank } from './parse.js';
import { tryKnownKeysAndDecrypt, type KnownBankKey, type DecryptResult } from './decrypt.js';

export interface EncryptedSnd {
	/** Number of leading NUL bytes skipped at the start of the SND payload. */
	paddingBytes: number;
	/** SND payload bytes after the leading NUL padding (may already be FSB5 plaintext). */
	encryptedBytes: Uint8Array;
}

/** Read the SND chunk and trim leading NUL padding. Returns null if there's no SND chunk. */
export async function extractEncryptedSnd(
	parsed: ParsedFmodBank,
	source: Blob,
): Promise<EncryptedSnd | null> {
	const snd = parsed.sndChunk;
	if (!snd) return null;
	const sndPayloadEnd = Math.min(source.size, snd.offset + 8 + snd.size);
	const all = new Uint8Array(
		await source.slice(snd.offset + 8, sndPayloadEnd).arrayBuffer(),
	);
	let padding = 0;
	while (padding < all.length && padding < 64 && all[padding] === 0) padding++;
	return { paddingBytes: padding, encryptedBytes: all.subarray(padding) };
}

export interface Fsb5ExtractResult extends DecryptResult {
	/** Bytes of NUL padding skipped at the start of the SND payload. */
	paddingBytes: number;
}

/**
 * Combined extract + auto-decrypt. Returns the FSB5 bytes ready to
 * feed to `@tootallnate/fsb5`, plus metadata about whether
 * encryption was needed and which key matched (for UI display).
 */
export async function extractFsb5FromBank(
	parsed: ParsedFmodBank,
	source: Blob,
	extraKeys: ReadonlyArray<KnownBankKey> = [],
): Promise<Fsb5ExtractResult | null> {
	const enc = await extractEncryptedSnd(parsed, source);
	if (!enc) return null;
	const result = await tryKnownKeysAndDecrypt(parsed, source, extraKeys);
	return { ...result, paddingBytes: enc.paddingBytes };
}
