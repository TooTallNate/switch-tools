/* Service worker that backs the nx-archive virtual filesystem
 * (`/vfs/<resourceId>/<filename>` URLs).
 *
 * Background: many of our preview / download paths produce
 * `Blob`-shaped facades whose bytes are the deterministic result
 * of decrypting (AES-CTR, AES-XTS) or decompressing (DEFLATE,
 * LZ4, LZMA, zstd, Yaz0) some underlying file. `Blob` itself is
 * opaque to JS, so the only way to hand its bytes to native
 * consumers (<video>, <img>, <a download>, fetch()) is via
 * `URL.createObjectURL`, which requires the *whole* payload to
 * sit in browser-managed memory first. That materialisation is
 * what made the 231 MB FFX MP4 feel slow.
 *
 * The trick: register this service worker, then mint URLs that
 * the SW intercepts. Each fetch is forwarded to the originating
 * client (the page that registered the resource) via postMessage
 * over a `MessageChannel`. The client reads the requested byte
 * range from the underlying lazy facade and pumps chunks back
 * through the channel; the SW relays them into a `ReadableStream`
 * the browser consumes. The result:
 *
 *   - <video> seeks via HTTP Range requests, fetched only as
 *     needed. A 5 GB file plays without ever materialising in
 *     memory.
 *   - <a download> streams straight to disk through the browser's
 *     own download manager.
 *   - <img>, <iframe>, fetch() all just work.
 *
 * Protocol (SW ↔ client, per request):
 *
 *   SW → client (postMessage with transferred MessagePort):
 *     {
 *       type: 'vfs-request',
 *       resourceId: string,        // identifies which lazy resource
 *       rangeStart: number,        // inclusive
 *       rangeEnd: number,          // exclusive
 *       requestId: string,         // correlation id, opaque
 *     }
 *
 *   Client → SW (on the MessagePort):
 *     { type: 'chunk', requestId, data: ArrayBuffer (transferred) }
 *     { type: 'end', requestId }                  // success
 *     { type: 'error', requestId, message: string }  // failure
 *
 *   Client may send 'metadata' first to update the size / mime:
 *     { type: 'metadata', requestId, totalSize: number, mime: string }
 *
 * The client may produce metadata immediately when a request
 * comes in for the first time (so the SW knows Content-Length /
 * Content-Type) and stream bytes thereafter.
 */

// Cache version — bumped to invalidate the SW when this file changes.
// Browsers byte-diff the SW script to detect updates, so any
// material change here forces a re-install. The constant doubles
// as a tag for diagnostic logging.
const SW_VERSION = 'nx-archive-vfs-v5';

self.addEventListener('install', (event) => {
	// Take over immediately so reloads don't have to wait for the
	// previous SW to die. The page also calls `skipWaiting()` from
	// the activation handshake; this is belt-and-braces.
	event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
	// Claim all clients (open tabs) so they can start using the
	// /vfs/ URLs immediately rather than waiting until next navigation.
	event.waitUntil(self.clients.claim());
});

/**
 * Allow the page to trigger an immediate update path without a
 * navigation. The page posts {type:'skip-waiting'} when a new SW
 * is detected; we activate right away.
 */
self.addEventListener('message', (event) => {
	if (!event.data) return;
	if (event.data.type === 'skip-waiting') {
		self.skipWaiting();
	}
	if (event.data.type === 'claim-clients') {
		// Belt-and-braces for first-visit installs where the page
		// loaded uncontrolled. The activate-time clients.claim()
		// SHOULD handle this, but Firefox in particular has been
		// observed to leave the page uncontrolled until something
		// nudges the SW. Re-claim on demand.
		event.waitUntil(self.clients.claim());
	}
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// /vfs/<resourceId>/<filename> — per-resource streaming.
	if (url.pathname.startsWith('/vfs/')) {
		const rest = url.pathname.slice('/vfs/'.length);
		const slash = rest.indexOf('/');
		const resourceId = slash >= 0 ? rest.slice(0, slash) : rest;
		if (!resourceId) return;
		event.respondWith(handleVfsFetch(event, resourceId));
		return;
	}

	// /htdocs/<bundleId>/<path...> — bundle file lookup. Serves
	// the iframe document AND all of its subresources from one
	// origin so relative URLs (`./style.css`) and natural
	// navigations (`<a href="./other.html">`) just work.
	if (url.pathname.startsWith('/htdocs/')) {
		const rest = url.pathname.slice('/htdocs/'.length);
		const slash = rest.indexOf('/');
		if (slash < 0) {
			// No file path component — redirect to index.html so
			// `iframe.src="/htdocs/<id>/"` works.
			event.respondWith(
				new Response(null, {
					status: 302,
					headers: { Location: `${url.pathname.replace(/\/?$/, '/')}index.html` },
				}),
			);
			return;
		}
		const bundleId = rest.slice(0, slash);
		const filePath = decodeURIComponent(rest.slice(slash + 1));
		if (!bundleId || !filePath) return;
		event.respondWith(handleHtdocsFetch(event, bundleId, filePath));
		return;
	}
});

/**
 * Look up the originating client for this fetch and ask it to
 * stream bytes through a `MessagePort`. Returns the assembled
 * `Response` (potentially partial, depending on the Range header).
 */
async function handleVfsFetch(event, resourceId) {
	const client = await findRegistryClient(event);
	if (!client) {
		return new Response('vfs: no client available', { status: 503 });
	}

	// Parse Range header. We only honour single-range requests
	// (`bytes=N-M`) which is what every browser issues for media /
	// download streams.
	const rangeHeader = event.request.headers.get('range');
	const requestedRange = parseRangeHeader(rangeHeader);

	// Set up the MessageChannel: SW listens on `port1`, client
	// writes on `port2`. We don't yet know the resource's size, so
	// we kick off the request without a definite range; the client
	// will reply with a 'metadata' message first, and we'll re-issue
	// the actual byte range once the size is known.
	const channel = new MessageChannel();
	const requestId = crypto.randomUUID();

	// Promise that resolves to {response, headers} once metadata
	// arrives, then is piped into a ReadableStream as chunks land.
	return new Promise((resolveResponse) => {
		let resolved = false;
		let totalSize = null;
		let mime = 'application/octet-stream';
		let filename = null;
		let bytesEmitted = 0;
		let actualStart = 0;
		let actualEnd = 0;
		let streamController = null;

		channel.port1.onmessage = (msg) => {
			const m = msg.data;
			if (!m || m.requestId !== requestId) return;
			if (m.type === 'metadata') {
				totalSize = m.totalSize;
				mime = m.mime || mime;
				filename = m.filename || null;
				// Resolve the byte range now that we know the size.
				if (requestedRange) {
					actualStart = clampUint(requestedRange.start ?? 0, 0, totalSize);
					if (requestedRange.end !== undefined) {
						actualEnd = clampUint(requestedRange.end + 1, actualStart, totalSize);
					} else {
						actualEnd = totalSize;
					}
				} else {
					actualStart = 0;
					actualEnd = totalSize;
				}
				if (actualStart >= totalSize && totalSize > 0) {
					resolved = true;
					resolveResponse(
						new Response(null, {
							status: 416,
							headers: { 'Content-Range': `bytes */${totalSize}` },
						}),
					);
					try { channel.port1.close(); } catch {}
					return;
				}
				// Now ask the client for the resolved range.
				channel.port1.postMessage({
					type: 'start-stream',
					requestId,
					rangeStart: actualStart,
					rangeEnd: actualEnd,
				});
				const headers = new Headers();
				headers.set('Content-Type', mime);
				headers.set('Content-Length', String(actualEnd - actualStart));
				headers.set('Accept-Ranges', 'bytes');
				headers.set('Cache-Control', 'no-store');
				if (filename) {
					// Suggest the filename for downloads. The browser
					// also honours the <a download> attribute, which
					// takes precedence; this is for direct-URL saves.
					headers.set(
						'Content-Disposition',
						`attachment; filename*=UTF-8''${encodeRfc5987(filename)}`,
					);
				}
				let status = 200;
				if (requestedRange) {
					status = 206;
					headers.set(
						'Content-Range',
						`bytes ${actualStart}-${actualEnd - 1}/${totalSize}`,
					);
				}
				const stream = new ReadableStream({
					start(controller) {
						streamController = controller;
					},
					cancel(reason) {
						// Consumer aborted (seek away, tab close).
						// Tell the client to stop producing.
						try {
							channel.port1.postMessage({ type: 'cancel', requestId });
						} catch {}
						try { channel.port1.close(); } catch {}
					},
				});
				resolved = true;
				resolveResponse(new Response(stream, { status, headers }));
				return;
			}
			if (m.type === 'chunk' && streamController) {
				const data = m.data;
				bytesEmitted += data.byteLength;
				try {
					streamController.enqueue(new Uint8Array(data));
				} catch {
					// Consumer already closed; ignore.
				}
				return;
			}
			if (m.type === 'end' && streamController) {
				try { streamController.close(); } catch {}
				try { channel.port1.close(); } catch {}
				return;
			}
			if (m.type === 'error') {
				if (streamController) {
					try { streamController.error(new Error(m.message)); } catch {}
				}
				if (!resolved) {
					resolved = true;
					resolveResponse(
						new Response(`vfs: ${m.message}`, { status: 500 }),
					);
				}
				try { channel.port1.close(); } catch {}
				return;
			}
		};

		// Kick off the conversation by transferring the port to the
		// client. The client will reply with metadata first.
		client.postMessage(
			{
				type: 'vfs-request',
				resourceId,
				requestId,
				rangeHeader: rangeHeader ?? null,
			},
			[channel.port2],
		);

		// Watchdog: if the client doesn't respond within 30 s, give
		// up. This usually means the resource was unregistered or
		// the page navigated away.
		setTimeout(() => {
			if (!resolved) {
				resolved = true;
				resolveResponse(
					new Response('vfs: client timeout', { status: 504 }),
				);
				try { channel.port1.close(); } catch {}
			}
		}, 30_000);
	});
}

/**
 * Serve a single file from a registered htdocs bundle. The flow
 * is much simpler than handleVfsFetch:
 *
 *   1. Find the originating client.
 *   2. Send `{ type: 'htdocs-request', bundleId, path, requestId }`
 *      over a MessagePort.
 *   3. Wait for the client's response:
 *        - `response`: a single transferred ArrayBuffer of the
 *          file's bytes (possibly HTML-rewritten on the client
 *          side) + the resolved MIME type. Pack into a Response
 *          and we're done.
 *        - `not-found`: 404.
 *        - `error`: 500.
 *
 * No streaming, no Range parsing — htdocs files are uniformly
 * small (HTML/CSS/JPEGs), and we have nothing to gain from the
 * complexity here.
 */
async function handleHtdocsFetch(event, bundleId, path) {
	const client = await findRegistryClient(event);
	if (!client) {
		return new Response('vfs: no client available', { status: 503 });
	}

	const channel = new MessageChannel();
	const requestId = crypto.randomUUID();

	return new Promise((resolve) => {
		let settled = false;
		channel.port1.onmessage = (msg) => {
			const m = msg.data;
			if (!m || m.requestId !== requestId || settled) return;
			settled = true;
			if (m.type === 'response') {
				const headers = new Headers();
				headers.set('Content-Type', m.mime || 'application/octet-stream');
				headers.set('Content-Length', String(m.data.byteLength));
				headers.set('Cache-Control', 'no-store');
				resolve(new Response(m.data, { status: 200, headers }));
			} else if (m.type === 'not-found') {
				resolve(new Response(m.message ?? 'not found', { status: 404 }));
			} else {
				resolve(
					new Response(`vfs: ${m.message ?? 'error'}`, { status: 500 }),
				);
			}
			try { channel.port1.close(); } catch {}
		};
		client.postMessage(
			{ type: 'htdocs-request', bundleId, path, requestId },
			[channel.port2],
		);
		setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(new Response('vfs: client timeout', { status: 504 }));
				try { channel.port1.close(); } catch {}
			}
		}, 30_000);
	});
}

/**
 * Locate the page that holds the JS registry of vfs resources /
 * htdocs bundles for this request.
 *
 * Why this isn't just `clients.get(event.clientId)`: when a
 * subresource (CSS / image / nested fetch) is requested by an
 * iframe we're serving, `event.clientId` is the IFRAME's client
 * — not the parent page. The iframe has no JS registry; its
 * `message` events are ignored. We need to route to the top-
 * level window that registered the bundle.
 *
 * Strategy: prefer top-level WindowClients (`frameType ===
 * 'top-level'`); fall back to any window client if none are
 * top-level (rare, e.g. during a tab being restored). Returns
 * `null` if there are no clients at all (page being torn down).
 */
async function findRegistryClient(event) {
	const all = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	// Prefer the top-level frame that's currently focused — if the
	// user has multiple tabs open with this app, this routes the
	// request to the tab they're actively looking at.
	const tops = all.filter((c) => c.frameType === 'top-level');
	const focused = tops.find((c) => c.focused);
	if (focused) return focused;
	if (tops.length > 0) return tops[0];
	// As a last resort, accept any window client (auxiliary
	// popups, etc.). Iframes don't have registries so they
	// can't help, but a non-top-level window client at least
	// has JS we can post to.
	if (all.length > 0) return all[0];
	// Try `event.clientId` directly in case there's some context
	// the matchAll missed.
	if (event.clientId) {
		const c = await self.clients.get(event.clientId);
		if (c) return c;
	}
	return null;
}

function parseRangeHeader(value) {
	if (!value) return null;
	const m = /^bytes=(\d+)-(\d*)$/.exec(value);
	if (!m) return null;
	const start = parseInt(m[1], 10);
	const end = m[2] === '' ? undefined : parseInt(m[2], 10);
	if (!Number.isFinite(start)) return null;
	if (end !== undefined && (!Number.isFinite(end) || end < start)) return null;
	return { start, end };
}

function clampUint(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n | 0));
}

function encodeRfc5987(s) {
	return encodeURIComponent(s).replace(/['()]/g, escape).replace(/\*/g, '%2A');
}
