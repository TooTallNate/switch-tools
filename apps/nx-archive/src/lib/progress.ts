/**
 * Shared progress-event types for nx-archive's decompression /
 * decryption operations.
 *
 * Mirrors the {@link ProgressEvent} type exported by every
 * `@tootallnate/*` decompressor (NCZ, Yaz0, ...) so callers don't
 * need to translate between shapes.
 */
export interface ProgressEvent {
	bytesIn: number;
	bytesOut: number;
	bytesInTotal?: number;
	bytesOutTotal?: number;
}

export type OnProgress = (e: ProgressEvent) => void;

/**
 * Format bytes as a human-readable string. Matches the formatting
 * conventions used by `formatBytes` elsewhere in the app but lives
 * here to keep the progress lib self-contained.
 */
export function formatBytesShort(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
	if (n < 1024) return `${n} B`;
	const kb = n / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(2)} MB`;
	return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Compute a percentage from a ProgressEvent. Prefers `bytesOut /
 * bytesOutTotal` (more meaningful for the user — what they're
 * waiting for), falls back to the input ratio. Returns `null`
 * when neither total is known.
 */
export function progressPercent(e: ProgressEvent | null): number | null {
	if (!e) return null;
	if (e.bytesOutTotal && e.bytesOutTotal > 0) {
		return Math.min(100, (e.bytesOut / e.bytesOutTotal) * 100);
	}
	if (e.bytesInTotal && e.bytesInTotal > 0) {
		return Math.min(100, (e.bytesIn / e.bytesInTotal) * 100);
	}
	return null;
}
