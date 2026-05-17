/**
 * Virtual filesystem bridge between this page and the
 * `/vfs/<resourceId>` service worker (`public/sw.js`).
 *
 * Usage:
 *
 *   const url = registerVfsResource({
 *     size: blob.size,
 *     mime: 'video/mp4',
 *     filename: 'cutscene.mp4',
 *     async read(start, end) {
 *       return new Uint8Array(await blob.slice(start, end).arrayBuffer());
 *     },
 *   });
 *
 *   <video src={url} />        // streams via Range requests
 *   <a href={url} download />  // streams straight to disk
 *
 *   // When done (component unmount, page navigation):
 *   unregisterVfsResource(url);
 *
 * The SW intercepts the request, asks us (via `postMessage`) for
 * the requested byte range, and we pump chunks back through a
 * `MessageChannel`. The browser sees a normal streaming HTTP
 * response and never holds the full payload.
 *
 * This is the lazy-resource equivalent of `URL.createObjectURL`
 * for a `Blob`. The crucial difference: blob URLs require the
 * full payload to be in browser memory; vfs URLs let us produce
 * bytes on demand, chunk-by-chunk, with seek support.
 *
 * Fallback: if the service worker isn't registered / supported,
 * {@link registerVfsResource} returns `null` and callers must
 * fall back to materialising into a real Blob and using
 * `URL.createObjectURL`. {@link isVfsAvailable} reports the
 * current status.
 */

/**
 * The interface a registered resource must implement.
 *
 * `read(start, end)` may be called multiple times concurrently
 * by the SW (e.g. when a video element issues several Range
 * requests in parallel for buffering). Implementations should
 * be safe for concurrent calls; the easiest way is to keep all
 * state in the closure and let each call slice into the same
 * underlying source independently.
 */
export interface VfsResource {
	/** Total size in bytes. The browser needs this for Content-Length. */
	readonly size: number;
	/**
	 * Final MIME type. Used as `Content-Type` so the browser
	 * picks the right decoder.
	 */
	readonly mime: string;
	/**
	 * Suggested filename for direct-URL downloads. The
	 * <a download> attribute on the consumer site takes
	 * precedence; this is the fallback when the URL is opened
	 * directly.
	 */
	readonly filename?: string;
	/**
	 * Read the byte range `[start, end)` and yield chunks. May
	 * `throw` to signal a fatal error (the SW will surface this
	 * as `500 Internal Server Error` to the consumer).
	 */
	read(start: number, end: number): AsyncIterable<Uint8Array>;
}

/**
 * True iff the service worker is active and ready to serve
 * `/vfs/` URLs. Callers should branch on this and fall back to
 * `URL.createObjectURL` when it's false.
 */
export function isVfsAvailable(): boolean {
	return state.swReady;
}

/**
 * Register a resource and return a stable URL that the browser
 * can fetch. The URL stays valid until you call
 * {@link unregisterVfsResource} (or the tab closes).
 *
 * Returns `null` when the SW isn't available — callers should
 * fall back to a real-Blob path in that case.
 */
export function registerVfsResource(resource: VfsResource): string | null {
	if (!state.swReady) return null;
	const id = crypto.randomUUID();
	state.resources.set(id, resource);
	const safeName = resource.filename
		? encodeURIComponent(resource.filename)
		: 'data.bin';
	return `${location.origin}/vfs/${id}/${safeName}`;
}

/**
 * Drop a previously-registered resource. Idempotent. After this
 * any in-flight reads error with `vfs: resource not found` and
 * new fetches return 404.
 */
export function unregisterVfsResource(url: string | null | undefined): void {
	if (!url) return;
	const m = /^https?:\/\/[^/]+\/vfs\/([^/]+)/.exec(url);
	if (!m) return;
	state.resources.delete(m[1]);
}

interface VfsState {
	swReady: boolean;
	resources: Map<string, VfsResource>;
}

const state: VfsState = {
	swReady: false,
	resources: new Map(),
};

/**
 * Register the service worker and wire up the message handler.
 * Call this once at app startup, before any other vfs APIs.
 * Resolves once the SW is active and ready to serve URLs.
 *
 * Safe to call multiple times — subsequent calls return the same
 * cached registration.
 */
let initPromise: Promise<boolean> | null = null;
export function initVfs(): Promise<boolean> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
			return false;
		}
		try {
			const reg = await navigator.serviceWorker.register('/sw.js', {
				scope: '/',
			});
			// If a new SW is installing, ask it to skip-waiting so we
			// can use it immediately rather than waiting for all old
			// tabs to close.
			if (reg.waiting) reg.waiting.postMessage({ type: 'skip-waiting' });
			reg.addEventListener('updatefound', () => {
				const w = reg.installing;
				if (!w) return;
				w.addEventListener('statechange', () => {
					if (w.state === 'installed' && navigator.serviceWorker.controller) {
						w.postMessage({ type: 'skip-waiting' });
					}
				});
			});
			// We need this page to be CONTROLLED by the SW before
			// minting any /vfs/ URLs — only then will fetches against
			// those URLs route through the SW. `controller` is set
			// when the page is loaded under an active SW, OR when the
			// SW takes control via `clients.claim()` (which our SW's
			// `activate` handler does). `register()` resolving doesn't
			// guarantee either.
			if (!navigator.serviceWorker.controller) {
				await Promise.race([
					new Promise<void>((resolve) => {
						const handler = (): void => {
							if (navigator.serviceWorker.controller) {
								navigator.serviceWorker.removeEventListener(
									'controllerchange',
									handler,
								);
								resolve();
							}
						};
						navigator.serviceWorker.addEventListener(
							'controllerchange',
							handler,
						);
					}),
					// Cap the wait so a stuck registration doesn't keep
					// the app blocked forever. After 5 s give up; the
					// fallback path will materialise lazy facades the
					// old way.
					new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
				]);
			}
			if (!navigator.serviceWorker.controller) {
				console.warn('[vfs] service worker registered but not controlling this page');
				return false;
			}
		} catch (err) {
			console.warn('[vfs] service worker registration failed:', err);
			return false;
		}
		navigator.serviceWorker.addEventListener('message', onSwMessage);
		state.swReady = true;
		return true;
	})();
	return initPromise;
}

/**
 * Handle a `vfs-request` message from the SW. The SW transfers a
 * `MessagePort` we use to send back metadata and chunks.
 *
 * Flow:
 *
 *   1. Look up the resource by id; reply with `metadata`
 *      describing the size / mime so the SW can set
 *      Content-Length / Content-Type.
 *   2. Wait for the SW's `start-stream` message (which carries
 *      the resolved byte range — the SW computes it from the
 *      Range header now that it knows the total size).
 *   3. Pump chunks through `port.postMessage({type: 'chunk',
 *      data})`, with the underlying ArrayBuffer transferred so
 *      it's a zero-copy hand-off.
 *   4. Send `{type: 'end'}` when done, or `{type: 'error'}` on
 *      failure.
 */
function onSwMessage(event: MessageEvent): void {
	const m = event.data;
	if (!m || m.type !== 'vfs-request') return;
	const port = event.ports[0];
	if (!port) return;
	const { resourceId, requestId } = m;
	const resource = state.resources.get(resourceId);
	if (!resource) {
		port.postMessage({
			type: 'error',
			requestId,
			message: `resource ${resourceId} not registered`,
		});
		try { port.close(); } catch { /* ignore */ }
		return;
	}
	// Send metadata first so the SW can resolve the byte range.
	port.postMessage({
		type: 'metadata',
		requestId,
		totalSize: resource.size,
		mime: resource.mime,
		filename: resource.filename ?? null,
	});

	let cancelled = false;
	port.addEventListener('message', async (msg) => {
		const r = msg.data;
		if (!r || r.requestId !== requestId) return;
		if (r.type === 'cancel') {
			cancelled = true;
			return;
		}
		if (r.type !== 'start-stream') return;
		const { rangeStart, rangeEnd } = r;
		try {
			for await (const chunk of resource.read(rangeStart, rangeEnd)) {
				if (cancelled) break;
				// Copy into a fresh ArrayBuffer we can transfer (the
				// caller's chunk may be a view into a larger buffer
				// we shouldn't detach).
				const ab = new ArrayBuffer(chunk.byteLength);
				new Uint8Array(ab).set(chunk);
				port.postMessage({ type: 'chunk', requestId, data: ab }, [ab]);
			}
			if (!cancelled) {
				port.postMessage({ type: 'end', requestId });
			}
		} catch (err) {
			port.postMessage({
				type: 'error',
				requestId,
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			try { port.close(); } catch { /* ignore */ }
		}
	});
	port.start();
}

/**
 * Convenience: register a `Blob`-shaped value (real or facade)
 * as a vfs resource and return its URL.
 *
 * The resource's `read(start, end)` calls `blob.slice(start,
 * end).stream()` to get chunks. For real Blobs this is a lazy
 * view; for facades (NCA AES-CTR sections, ZIP DEFLATE) the
 * underlying transform's chunked stream() is consumed.
 */
export function registerBlobAsVfsResource(
	blob: Blob,
	mime: string,
	filename?: string,
): string | null {
	if (!state.swReady) return null;
	return registerVfsResource({
		size: blob.size,
		mime,
		filename,
		async *read(start, end) {
			// blob.slice() is a view for real Blobs; lazy facades
			// chain through their own slice() implementation. Either
			// way the returned blob's stream() yields the requested
			// range only.
			const sliced = blob.slice(start, end);
			if (typeof sliced.stream === 'function') {
				const reader = sliced.stream().getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) yield value;
				}
			} else {
				const buf = await sliced.arrayBuffer();
				yield new Uint8Array(buf);
			}
		},
	});
}
