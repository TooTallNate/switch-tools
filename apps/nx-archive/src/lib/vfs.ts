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

/**
 * Register an htdocs-style bundle. Returns the bundle id, which
 * the caller composes with file paths to mint URLs:
 *
 *   const id = registerVfsBundle(bundle);
 *   iframe.src = `/htdocs/${id}/index.html`;
 *
 * Returns `null` when the SW isn't available.
 */
export function registerVfsBundle(bundle: VfsBundle): string | null {
	if (!state.swReady) return null;
	const id = crypto.randomUUID();
	state.bundles.set(id, bundle);
	return id;
}

/**
 * Build a complete URL for a path inside a previously-registered
 * bundle. Convenience wrapper around the path concatenation +
 * URL encoding.
 */
export function vfsBundleUrl(bundleId: string, path: string): string {
	// Each path segment gets URL-encoded so spaces / unicode in
	// htdocs filenames survive the round-trip.
	const safe = path
		.split('/')
		.filter((s) => s.length > 0)
		.map((s) => encodeURIComponent(s))
		.join('/');
	return `${location.origin}/htdocs/${bundleId}/${safe}`;
}

/**
 * Drop a previously-registered bundle. Idempotent. After this,
 * any in-flight fetches for the bundle's paths return 404.
 */
export function unregisterVfsBundle(bundleId: string | null | undefined): void {
	if (!bundleId) return;
	state.bundles.delete(bundleId);
}

/**
 * A bundle of related files served at `/htdocs/<bundleId>/<path>`.
 * Used by the htdocs preview to expose a Switch offline manual's
 * directory tree to a real iframe without first materialising
 * every file's bytes into memory.
 *
 * Unlike a single {@link VfsResource}, bundles have:
 *
 *   - A directory of paths, each pointing at a `Blob` (real or
 *     facade) for that file's bytes.
 *   - A `rewriteHtml(path, html)` hook so the bundle's HTML
 *     documents can be transformed at the byte boundary — we
 *     inject the `window.nx` shim and navigation bridge there.
 *   - A MIME-type lookup keyed on path (the SW uses this so the
 *     iframe sees the right Content-Type for `.css` etc).
 */
export interface VfsBundle {
	/** Look up a file by its in-bundle path. Returns null for unknown paths. */
	lookup(path: string): { blob: Blob; mime: string } | null;
	/**
	 * Optional transformer for HTML responses. Called with the
	 * file's bytes already decoded as a UTF-8 string; the returned
	 * string is what the SW sends as the response body.
	 */
	rewriteHtml?(path: string, html: string): string;
}

interface VfsState {
	swReady: boolean;
	resources: Map<string, VfsResource>;
	bundles: Map<string, VfsBundle>;
}

const state: VfsState = {
	swReady: false,
	resources: new Map(),
	bundles: new Map(),
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
			// Attach the message handler FIRST so we don't miss any
			// messages that come in while we're waiting for the SW
			// to take control.
			navigator.serviceWorker.addEventListener('message', onSwMessage);

			const reg = await navigator.serviceWorker.register('/sw.js', {
				scope: '/',
			});

			// Drive any installing SW to skip the waiting phase so it
			// activates immediately, even when older tabs of this app
			// are still open with the previous SW. `skipWaiting()` in
			// the SW pairs with this; the message is what lets it run
			// AT install time rather than at next navigation.
			const tellWorkerToSkip = (w: ServiceWorker | null): void => {
				if (!w) return;
				if (w.state === 'installed' || w.state === 'activating') {
					w.postMessage({ type: 'skip-waiting' });
				} else {
					w.addEventListener('statechange', () => {
						if (w.state === 'installed') {
							w.postMessage({ type: 'skip-waiting' });
						}
					});
				}
			};
			tellWorkerToSkip(reg.installing);
			tellWorkerToSkip(reg.waiting);
			reg.addEventListener('updatefound', () => {
				tellWorkerToSkip(reg.installing);
			});

			// Now wait for the page to be CONTROLLED by an active SW.
			// Three possible paths to the goal state:
			//
			//   1. `navigator.serviceWorker.controller` is already set
			//      (page was loaded under an active SW from a previous
			//      visit). Done immediately.
			//   2. `controllerchange` fires — the SW called
			//      `clients.claim()` on activate.
			//   3. We poll periodically as a safety net for browsers
			//      that fire `controllerchange` slightly outside the
			//      window between our pre-check and listener attach.
			//
			// We ALSO nudge the SW with a `claim-clients` message
			// once it's activated, in case its activate-time
			// `clients.claim()` already ran without effect (observed
			// in Firefox under some conditions where the page loaded
			// uncontrolled and the activate event fired before our
			// listeners were attached). The SW responds by calling
			// `clients.claim()` again, which triggers
			// `controllerchange` on this page.
			if (!navigator.serviceWorker.controller) {
				// Wait for an active worker to exist (might still be
				// installing on a fresh visit), then ask it to claim.
				navigator.serviceWorker.ready
					.then((readyReg) => {
						if (readyReg.active && !navigator.serviceWorker.controller) {
							readyReg.active.postMessage({ type: 'claim-clients' });
						}
					})
					.catch(() => {
						/* ignore — the wait below will time out */
					});
				await waitForController(15_000);
			}
			if (!navigator.serviceWorker.controller) {
				console.warn(
					'[vfs] service worker registered but not controlling this page',
				);
				return false;
			}
		} catch (err) {
			console.warn('[vfs] service worker registration failed:', err);
			return false;
		}
		state.swReady = true;
		return true;
	})();
	return initPromise;
}

/**
 * Wait until this page has an active controlling service worker
 * (i.e. `navigator.serviceWorker.controller` is non-null). Polls
 * every 100 ms in addition to listening for `controllerchange`
 * so we don't miss an event that fires between the two checks.
 *
 * Resolves either when the controller appears or when `timeoutMs`
 * elapses. Returns no signal; callers should re-check
 * `navigator.serviceWorker.controller` after.
 */
async function waitForController(timeoutMs: number): Promise<void> {
	if (navigator.serviceWorker.controller) return;
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			navigator.serviceWorker.removeEventListener(
				'controllerchange',
				onChange,
			);
			clearInterval(poll);
			clearTimeout(timer);
			resolve();
		};
		const onChange = (): void => {
			if (navigator.serviceWorker.controller) finish();
		};
		navigator.serviceWorker.addEventListener('controllerchange', onChange);
		// Polling safety net.
		const poll = setInterval(() => {
			if (navigator.serviceWorker.controller) finish();
		}, 100);
		// Hard timeout.
		const timer = setTimeout(finish, timeoutMs);
	});
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
	if (!m) return;
	if (m.type === 'vfs-request') {
		handleVfsRequest(event);
		return;
	}
	if (m.type === 'htdocs-request') {
		handleHtdocsRequest(event);
		return;
	}
}

function handleVfsRequest(event: MessageEvent): void {
	const m = event.data;
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
				try {
					port.postMessage({ type: 'chunk', requestId, data: ab }, [ab]);
				} catch {
					// Port closed mid-stream — the consumer cancelled
					// and the SW relayed the cancel by closing the
					// port. Treat as a clean abort, not an error.
					cancelled = true;
					break;
				}
			}
			if (!cancelled) {
				try { port.postMessage({ type: 'end', requestId }); } catch { /* ignore */ }
			}
		} catch (err) {
			// `resource.read()` itself threw — either a real decode
			// error (key mismatch, bad bytes) OR the resource was
			// unregistered between the lookup and the read (the
			// `resource` variable closed over the registry entry,
			// but the underlying source — typically an NCA section
			// — might still error if its key was evicted).
			//
			// Either way, surface to the SW. If the port is already
			// closed (cancel race) the postMessage is a silent
			// no-op per spec, so we don't need to guard.
			if (!cancelled) {
				try {
					port.postMessage({
						type: 'error',
						requestId,
						message: err instanceof Error ? err.message : String(err),
					});
				} catch { /* port closed */ }
			}
		} finally {
			try { port.close(); } catch { /* ignore */ }
		}
	});
	port.start();
}

/**
 * Resolve a bundle lookup and reply with the file's bytes +
 * MIME. HTML files are passed through the bundle's optional
 * `rewriteHtml` hook so the htdocs preview can inject the
 * `window.nx` shim before any of the page's own scripts run.
 *
 * Bundle responses are sent as a single message (not streamed)
 * because manual files are small in practice — a few MB of
 * HTML/CSS/JPEGs total. If a bundle ever grows large enough for
 * this to matter we can switch to the streaming protocol used by
 * `vfs-request`.
 */
function handleHtdocsRequest(event: MessageEvent): void {
	const { bundleId, path, requestId } = event.data;
	const port = event.ports[0];
	if (!port) return;
	(async () => {
		const bundle = state.bundles.get(bundleId);
		if (!bundle) {
			port.postMessage({
				type: 'error',
				requestId,
				message: `bundle ${bundleId} not registered`,
			});
			return;
		}
		const file = bundle.lookup(path);
		if (!file) {
			port.postMessage({
				type: 'not-found',
				requestId,
				message: `bundle ${bundleId}: file ${path} not found`,
			});
			return;
		}
		try {
			let bytes: Uint8Array;
			const mime = file.mime;
			// Match `text/html` and `text/html;charset=…` (the bundle's
			// MIME helper appends charset). Same for any other HTML
			// flavour that might appear.
			const isHtml = /^text\/html\b/i.test(mime);
			if (isHtml && bundle.rewriteHtml) {
				const html = await file.blob.text();
				const rewritten = bundle.rewriteHtml(path, html);
				bytes = new TextEncoder().encode(rewritten);
			} else {
				const buf = await file.blob.arrayBuffer();
				bytes = new Uint8Array(buf);
			}
			// Transfer the ArrayBuffer for a zero-copy hand-off.
			const ab = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(ab).set(bytes);
			port.postMessage(
				{ type: 'response', requestId, data: ab, mime },
				[ab],
			);
		} catch (err) {
			port.postMessage({
				type: 'error',
				requestId,
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			try { port.close(); } catch { /* ignore */ }
		}
	})();
}

/**
 * Convenience: register a `Blob`-shaped value (real or facade)
 * as a vfs resource and return its URL.
 *
 * Wraps the blob's `slice` / `stream` API in a chunked cache so
 * small Range requests don't repeatedly pay the Web Crypto /
 * decompression fixed-cost overhead. See {@link wrapWithChunkCache}.
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
	return registerVfsResource(
		wrapWithChunkCache({
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
		}),
	);
}

// ============================================================================
// Chunked read-ahead cache
// ============================================================================

/**
 * Cache chunk size. Reads are aligned UP to this size, decrypted /
 * decompressed once, and served from memory thereafter. 4 MiB is
 * a good compromise:
 *
 *   - Big enough to amortise Web Crypto's per-call overhead
 *     (each `crypto.subtle.encrypt` adds 5-10ms of fixed cost
 *     regardless of payload size — for AES-CTR over ~1 KB MP4
 *     sample atoms that's ruinous).
 *   - Small enough that the first chunk arrives in under ~100ms
 *     on typical hardware, so the play-press latency is bounded.
 *   - A multiple of the AES block size (16 B), so chunk reads
 *     align with the underlying section's block boundaries.
 *   - Roughly a single HTTP Range scrub-ahead window for a 4K
 *     video at typical bitrates — most sequential playback ends
 *     up entirely cache-resident.
 */
const CACHE_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Per-resource cache memory budget. When the sum of all chunks
 * for a single resource exceeds this, the oldest unused chunks
 * are evicted (LRU). Multiple resources can be active at once;
 * each gets its own budget.
 *
 * 64 MiB allows ~16 chunks of read-ahead per resource — plenty
 * for sustained sequential playback while still leaving room
 * for other previews and the rest of the app's allocations.
 */
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Wrap a {@link VfsResource} with a chunked read-ahead cache.
 *
 * Each call to `read(start, end)` is split into one or more
 * `CACHE_CHUNK_SIZE`-aligned chunks. Chunks are cached in a
 * per-resource LRU keyed on `chunkIndex = floor(start /
 * CACHE_CHUNK_SIZE)`; subsequent reads for any byte range
 * within those chunks return from memory.
 *
 * Concurrent reads for the same chunk share the in-flight
 * Promise — no double decryption.
 *
 * Why this matters: <video> elements parse MP4 atom tables at
 * playback start, issuing hundreds of small (1-10 KB) Range
 * requests against random offsets in the file. Without this
 * cache, each request triggers a fresh `crypto.subtle.encrypt`
 * call with significant fixed-cost overhead — making the
 * play-press latency on a lazy AES-CTR facade feel sluggish
 * even though the actual decrypt math is trivial.
 */
function wrapWithChunkCache(resource: VfsResource): VfsResource {
	interface CacheEntry {
		/** Set during decryption; resolves to the chunk's bytes once ready. */
		promise: Promise<Uint8Array>;
		/** Filled in after `promise` resolves so we can size the LRU. */
		bytes: Uint8Array | null;
		/** Monotonic tick used by the LRU to age entries. */
		lastUsed: number;
	}
	const cache = new Map<number, CacheEntry>();
	let tick = 0;
	let cachedBytes = 0;

	const readChunkBytes = async (chunkIndex: number): Promise<Uint8Array> => {
		const chunkStart = chunkIndex * CACHE_CHUNK_SIZE;
		const chunkEnd = Math.min(chunkStart + CACHE_CHUNK_SIZE, resource.size);
		// Pull the whole chunk through the underlying reader. We
		// concatenate yields because callers may produce arbitrary
		// chunk sizes (LazyCtrSection's stream() emits 64 KB
		// pieces, for example).
		const pieces: Uint8Array[] = [];
		let total = 0;
		for await (const piece of resource.read(chunkStart, chunkEnd)) {
			pieces.push(piece);
			total += piece.byteLength;
		}
		const out = new Uint8Array(chunkEnd - chunkStart);
		let off = 0;
		for (const p of pieces) {
			out.set(p, off);
			off += p.byteLength;
		}
		// Underlying reader may have produced fewer bytes than we
		// asked for (e.g. malformed source) — trim if necessary.
		return total < out.length ? out.subarray(0, total) : out;
	};

	const getChunk = (chunkIndex: number): Promise<Uint8Array> => {
		const existing = cache.get(chunkIndex);
		if (existing) {
			existing.lastUsed = ++tick;
			return existing.promise;
		}
		const promise = readChunkBytes(chunkIndex);
		const entry: CacheEntry = {
			promise,
			bytes: null,
			lastUsed: ++tick,
		};
		cache.set(chunkIndex, entry);
		// Fill in the size + run eviction once the bytes land.
		void promise
			.then((bytes) => {
				entry.bytes = bytes;
				cachedBytes += bytes.byteLength;
				evictIfNeeded();
			})
			.catch(() => {
				// Failed read — drop the entry so we don't memoise
				// the error forever. The next request will retry.
				cache.delete(chunkIndex);
			});
		return promise;
	};

	const evictIfNeeded = (): void => {
		if (cachedBytes <= CACHE_BUDGET_BYTES) return;
		// Sort by lastUsed ascending and drop the oldest until we
		// fit. This is O(N log N) per eviction but N is bounded by
		// `CACHE_BUDGET_BYTES / CACHE_CHUNK_SIZE` ≈ 16, so it's
		// effectively constant time.
		const entries = [...cache.entries()].sort(
			(a, b) => a[1].lastUsed - b[1].lastUsed,
		);
		for (const [idx, entry] of entries) {
			if (cachedBytes <= CACHE_BUDGET_BYTES) break;
			if (!entry.bytes) continue; // still in flight, can't evict
			cache.delete(idx);
			cachedBytes -= entry.bytes.byteLength;
		}
	};

	return {
		size: resource.size,
		mime: resource.mime,
		filename: resource.filename,
		async *read(start, end) {
			// Walk the requested byte range chunk by chunk.
			let cursor = start;
			while (cursor < end) {
				const chunkIndex = Math.floor(cursor / CACHE_CHUNK_SIZE);
				const chunkStart = chunkIndex * CACHE_CHUNK_SIZE;
				const chunkBytes = await getChunk(chunkIndex);
				const offsetInChunk = cursor - chunkStart;
				const bytesAvailable = chunkBytes.byteLength - offsetInChunk;
				if (bytesAvailable <= 0) {
					// Truncated source — nothing more to yield.
					return;
				}
				const wanted = end - cursor;
				const len = Math.min(bytesAvailable, wanted);
				yield chunkBytes.subarray(
					offsetInChunk,
					offsetInChunk + len,
				);
				cursor += len;
			}
		},
	};
}
