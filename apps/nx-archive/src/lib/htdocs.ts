/**
 * `.htdocs` (Nintendo Switch offline manual) preview support.
 *
 * Switch games ship interactive HTML manuals inside `*.htdocs/` directories
 * in their RomFS. They're loaded by the Web Applet on the device and may
 * call `window.nx.*` functions to interact with the system. To preview
 * them in a browser we:
 *
 *  1. Walk the entire `.htdocs` directory tree once to build a `Map<path,
 *     blob: URL>`. Each file becomes a stable, same-origin object URL.
 *  2. For each HTML file we rewrite resource references — `src`, `href`,
 *     `srcset`, CSS `url(...)` / `@import` — to point at the matching
 *     blob URL based on the document's path.
 *  3. We inject a tiny shim that defines `window.nx` with the most
 *     common methods that offline manuals call (`sendMessage`,
 *     `addEventListener`, `endApplet`, `playSystemSe`, etc.) so the
 *     manual's JavaScript runs without crashing.
 *  4. We hand the rewritten HTML to a sandboxed `<iframe srcdoc>` for
 *     rendering.
 */

import type { Node } from './archive';

/** A flat (path → Blob) view of an `.htdocs` tree. */
export type HtdocsFiles = Map<string, Blob>;

/**
 * Walk an htdocs container's archive-tree node recursively,
 * resolving every leaf's `Blob` and keying it by `/`-joined
 * path relative to the container.
 *
 * This is the only adapter HtdocsPreview needs from the archive
 * layer — no `.htdocs`-specific shape lives anywhere else.
 * Containers (RomFS, ZIP, SARC, fs-directory, …) all expose the
 * same `Node` API, so this single walk works for any of them.
 *
 * Children are fetched via the standard lazy `getChildren()` /
 * `blob()` accessors; a recursive walk through the whole subtree
 * keeps the implementation symmetric across container types and
 * matches the existing recursive-walk pattern other previews use
 * (Texture2D `.resS` resolution, AudioClip `.resource`).
 */
export async function flattenHtdocsFromNode(
	root: Node,
	prefix = '',
): Promise<HtdocsFiles> {
	const out: HtdocsFiles = new Map();
	if (root.isContainer && root.getChildren) {
		const kids = root._children ?? (root._children = await root.getChildren());
		for (const child of kids) {
			const path = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.isContainer) {
				const sub = await flattenHtdocsFromNode(child, path);
				for (const [k, v] of sub) out.set(k, v);
			} else if (child.blob) {
				out.set(path, await child.blob());
			}
		}
	}
	return out;
}

/** Best-effort MIME type detection by extension. */
export function mimeTypeFor(path: string): string {
	const ext = path.toLowerCase().split('.').pop() ?? '';
	const map: Record<string, string> = {
		html: 'text/html;charset=utf-8',
		htm: 'text/html;charset=utf-8',
		xhtml: 'application/xhtml+xml',
		css: 'text/css;charset=utf-8',
		js: 'text/javascript;charset=utf-8',
		mjs: 'text/javascript;charset=utf-8',
		json: 'application/json;charset=utf-8',
		xml: 'application/xml;charset=utf-8',
		svg: 'image/svg+xml',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		bmp: 'image/bmp',
		ico: 'image/x-icon',
		woff: 'font/woff',
		woff2: 'font/woff2',
		ttf: 'font/ttf',
		otf: 'font/otf',
		mp3: 'audio/mpeg',
		mp4: 'video/mp4',
		webm: 'video/webm',
		ogg: 'audio/ogg',
		wav: 'audio/wav',
		txt: 'text/plain;charset=utf-8',
		md: 'text/markdown;charset=utf-8',
	};
	return map[ext] ?? 'application/octet-stream';
}

/**
 * A region table parsed from a `regions.js` file in the bundle.
 *
 * Switch offline manuals localise themselves with this exact pattern:
 *
 * ```js
 * var regions = {
 *   "All": "index_All.html",
 *   "0": "index_JP.html",
 *   "1": "index_US.html",
 *   …
 * };
 * ```
 *
 * The hardware applet opens the manual with `?r=N` in the query
 * string; an inline script in `index.html` reads the param, looks
 * up the corresponding HTML, and redirects via `location.href = …`.
 * Without `?r`, the page just sits there blank.
 *
 * We parse the table at bundle-build time so the preview UI can
 * surface a region dropdown and inject the chosen `?r` value into
 * the iframe's `location.search`.
 */
export interface RegionsTable {
	/** Path to the `regions.js` file inside the bundle (lookup key for urlFor). */
	scriptPath: string;
	/** The `regions` object as parsed: key → relative HTML path. */
	regions: Record<string, string>;
	/** Preferred default key — `'All'`, then `'1'` (US), else first defined. */
	defaultKey: string;
}

/**
 * A `{ path → object-URL }` index plus the original Blob for each file.
 * Object URLs are typed (we set the right MIME) so the iframe loads
 * scripts/CSS/etc. correctly.
 *
 * Construct via the static {@link build} method, which is asynchronous
 * because RomFS files coming out of an encrypted NCA are *lazy
 * decryption facades* — they implement the `Blob` interface but aren't
 * real `Blob` instances, and `URL.createObjectURL` (and the `Blob(...)`
 * constructor's `BlobPart` list) require real `Blob`s. Materializing
 * each file once at bundle-build time gets us a real Blob with the
 * right MIME for free, and htdocs trees are small in practice (a few
 * MB of HTML/CSS/JPEGs).
 *
 * Call `dispose()` to revoke every URL when finished.
 */
export class HtdocsBundle {
	readonly urls: Map<string, string>;
	readonly files: Map<string, Blob>;
	/**
	 * Map of directory path → parsed `regions.js` table found inside it.
	 * The directory key is the empty string for a `regions.js` at the
	 * bundle root.
	 *
	 * This is populated at build time by scanning every `regions.js`
	 * file found in the bundle. The preview UI uses it to surface a
	 * region picker when an HTML file in the same directory is loaded.
	 */
	readonly regionsByDir: Map<string, RegionsTable>;

	private constructor(
		files: Map<string, Blob>,
		urls: Map<string, string>,
		regionsByDir: Map<string, RegionsTable>,
	) {
		this.files = files;
		this.urls = urls;
		this.regionsByDir = regionsByDir;
	}

	/**
	 * Materialize every file in the htdocs tree into a real `Blob` (with
	 * the correct MIME) and produce a stable object URL for each. Also
	 * scans for `regions.js` files and parses each into a {@link RegionsTable}.
	 */
	static async build(files: HtdocsFiles): Promise<HtdocsBundle> {
		const realFiles = new Map<string, Blob>();
		const urls = new Map<string, string>();
		const regionsByDir = new Map<string, RegionsTable>();
		const regionsTexts = new Map<string, string>();
		for (const [path, blob] of files) {
			// Read the bytes through the public `Blob` API. For real
			// `Blob`s this is a cheap reference; for lazy facades this is
			// where decryption happens.
			const bytes = await blob.arrayBuffer();
			const real = new Blob([bytes], { type: mimeTypeFor(path) });
			realFiles.set(path, real);
			urls.set(path, URL.createObjectURL(real));
			// Stash the text of every `regions.js` for parsing below.
			if (/(?:^|\/)regions\.js$/i.test(path)) {
				regionsTexts.set(path, new TextDecoder('utf-8').decode(bytes));
			}
		}
		for (const [path, text] of regionsTexts) {
			const parsed = parseRegionsJs(text);
			if (!parsed) continue;
			const dir = path.includes('/')
				? path.slice(0, path.lastIndexOf('/'))
				: '';
			regionsByDir.set(dir, {
				scriptPath: path,
				regions: parsed,
				defaultKey: pickDefaultRegionKey(parsed),
			});
		}
		return new HtdocsBundle(realFiles, urls, regionsByDir);
	}

	urlFor(path: string): string | undefined {
		return this.urls.get(this.normalizePath(path));
	}

	hasFile(path: string): boolean {
		return this.urls.has(this.normalizePath(path));
	}

	/**
	 * Look up the {@link RegionsTable} whose `regions.js` lives in the
	 * same directory as `documentPath` (or any ancestor). Returns
	 * `undefined` if no matching table is registered — i.e. this
	 * document is not part of a region-routed manual.
	 */
	regionsForDocument(documentPath: string): RegionsTable | undefined {
		const norm = this.normalizePath(documentPath);
		const segments = norm.split('/');
		// Walk from the document's directory upward until we find a
		// matching regions.js.
		for (let i = segments.length - 1; i >= 0; i--) {
			const dir = segments.slice(0, i).join('/');
			const table = this.regionsByDir.get(dir);
			if (table) return table;
		}
		return undefined;
	}

	/** Find a likely entry-point HTML inside the bundle. */
	pickEntryPoint(): string | null {
		const candidates = [
			'index.html',
			'index.htm',
			'top.html',
			'main.html',
			'document.html',
		];
		for (const c of candidates) {
			if (this.hasFile(c)) return c;
		}
		// Fall back to the first .html / .htm in lexicographic order
		for (const path of [...this.urls.keys()].sort()) {
			if (/\.html?$/i.test(path)) return path;
		}
		return null;
	}

	dispose(): void {
		for (const url of this.urls.values()) URL.revokeObjectURL(url);
		this.urls.clear();
		this.files.clear();
	}

	/**
	 * Resolve a relative URL inside an htdocs document to the bundle path.
	 * Returns `null` if the resolved path is outside the bundle (external
	 * URL, mailto:, javascript:, anchor-only) — those should be left alone.
	 */
	resolvePath(documentPath: string, ref: string): string | null {
		const trimmed = ref.trim();
		if (!trimmed) return null;
		// Anchor-only / external schemes — never rewrite.
		if (
			trimmed.startsWith('#') ||
			/^(?:[a-z][a-z0-9+.-]*:)/i.test(trimmed)
		) {
			return null;
		}
		// Absolute path — interpret relative to the bundle root.
		const base = trimmed.startsWith('/')
			? ''
			: documentPath.split('/').slice(0, -1).join('/');
		const joined = base
			? `${base}/${trimmed.replace(/^\/+/, '')}`
			: trimmed.replace(/^\/+/, '');
		// Strip query / fragment for the lookup
		const clean = joined.split(/[?#]/, 1)[0];
		const normalized = this.normalizePath(clean);
		return this.urls.has(normalized) ? normalized : null;
	}

	private normalizePath(path: string): string {
		const parts: string[] = [];
		for (const seg of path.split('/')) {
			if (!seg || seg === '.') continue;
			if (seg === '..') parts.pop();
			else parts.push(seg);
		}
		return parts.join('/');
	}
}

// ---------------------------------------------------------------------------
// `regions.js` parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `regions = { ... }` object literal out of a
 * `regions.js` source file. Returns `null` if the file doesn't
 * match the well-known Switch manual pattern.
 *
 * We deliberately avoid `eval` / `new Function` here — `regions.js`
 * is one trusted file in a known shape, but parsing it directly
 * means we don't introduce a code-execution surface in the host
 * app. The format is rigid:
 *
 *   var regions = {
 *     "All": "index_All.html",
 *     "0":   "index_JP.html",
 *     …
 *   };
 *
 * Strings can be single- or double-quoted; whitespace + line breaks
 * are tolerated. Keys are usually decimal digits or `"All"`. Values
 * are HTML filenames relative to the directory containing
 * `regions.js`. Any line we can't parse is silently skipped — the
 * worst case is a missing region key, not a broken bundle.
 */
export function parseRegionsJs(source: string): Record<string, string> | null {
	// Find the `{ ... }` body of the assignment. We look for any of
	// `var regions = {`, `let regions = {`, `regions = {`, etc.
	const bodyMatch = source.match(
		/(?:var|let|const)?\s*regions\s*=\s*(\{[\s\S]*?\})\s*;?/,
	);
	if (!bodyMatch) return null;
	const body = bodyMatch[1];
	// Strip line + block comments — Switch manuals never have these but
	// we defend in depth.
	const stripped = body
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	// Match each `"key": "value"` pair. Allow either quoting style on
	// either side; trailing comma on the last entry is fine.
	const pairRe =
		/(?:"([^"\\]*)"|'([^'\\]*)')\s*:\s*(?:"([^"\\]*)"|'([^'\\]*)')/g;
	const out: Record<string, string> = {};
	let m: RegExpExecArray | null;
	while ((m = pairRe.exec(stripped))) {
		const key = m[1] ?? m[2] ?? '';
		const value = m[3] ?? m[4] ?? '';
		if (key && value) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Pick a sensible default region key from a parsed table. Order:
 *
 *   1. `"All"` — the language-neutral fallback page that most games
 *      ship; renders fine for any user.
 *   2. `"1"` — Nintendo's region id for the Americas (US English).
 *   3. The first defined key, lexicographically.
 */
export function pickDefaultRegionKey(regions: Record<string, string>): string {
	if ('All' in regions) return 'All';
	if ('1' in regions) return '1';
	return Object.keys(regions).sort()[0];
}

/**
 * Friendly display name for a region key. Switch's region ids are:
 *
 *   0 = JP, 1 = US (Americas), 2 = EU, 3 = AU, 4 = HongKongTaiwanKorea, 5 = China
 *
 * `"All"` (and any other non-numeric key) is passed through verbatim.
 */
export function regionDisplayName(key: string): string {
	const map: Record<string, string> = {
		'0': 'Japan',
		'1': 'Americas',
		'2': 'Europe',
		'3': 'Australia',
		'4': 'Hong Kong / Taiwan / Korea',
		'5': 'China',
	};
	return map[key] ?? key;
}

// ---------------------------------------------------------------------------
// HTML rewriting
// ---------------------------------------------------------------------------

/** Tag/attribute pairs whose values are URLs we want to rewrite. */
const URL_ATTRS: Array<[string, string]> = [
	['a', 'href'],
	['area', 'href'],
	['link', 'href'],
	['base', 'href'],
	['img', 'src'],
	['source', 'src'],
	['video', 'src'],
	['audio', 'src'],
	['track', 'src'],
	['iframe', 'src'],
	['frame', 'src'],
	['embed', 'src'],
	['object', 'data'],
	['script', 'src'],
	['use', 'href'],
	['use', 'xlink:href'],
	['image', 'href'],
	['image', 'xlink:href'],
	['form', 'action'],
];

const SRCSET_ATTRS = ['srcset', 'imagesrcset'];

/** A handler for navigation events from anchor clicks inside the iframe. */
export type NavigateHandler = (path: string) => void;

/**
 * Take a raw HTML string from the bundle at `documentPath`, rewrite
 * every URL reference to a same-origin object URL, and inject the
 * `window.nx` shim plus a click-interceptor that lets us route in-bundle
 * navigations back to the parent app instead of the iframe trying to
 * load a (now-broken) relative URL.
 *
 * `forcedSearch` (e.g. `"?r=1"`) overrides the iframe's
 * `location.search` getter before any page script runs. Used for
 * Switch offline manuals that gate their region routing on
 * `window.location.search` — without this they'd render blank in
 * the preview because our `srcdoc` iframes have no real URL.
 */
export function rewriteHtml(
	html: string,
	documentPath: string,
	bundle: HtdocsBundle,
	options: { nxShim: string; bridgeName: string; forcedSearch?: string },
): string {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// Rewrite plain URL attributes.
	for (const [tag, attr] of URL_ATTRS) {
		for (const el of Array.from(doc.querySelectorAll(tag))) {
			const v = el.getAttribute(attr);
			if (v == null) continue;
			rewriteAttr(el, attr, v, documentPath, bundle);
		}
	}
	// Rewrite srcset / imagesrcset (space-and-comma separated).
	for (const attr of SRCSET_ATTRS) {
		for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
			const v = el.getAttribute(attr);
			if (!v) continue;
			el.setAttribute(attr, rewriteSrcset(v, documentPath, bundle));
		}
	}
	// Rewrite inline <style> CSS and inline `style` attributes.
	for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
		styleEl.textContent = rewriteCss(
			styleEl.textContent ?? '',
			documentPath,
			bundle,
		);
	}
	for (const el of Array.from(doc.querySelectorAll('[style]'))) {
		const v = el.getAttribute('style');
		if (!v) continue;
		el.setAttribute('style', rewriteCss(v, documentPath, bundle));
	}

	// Inject the nx shim + a navigation bridge BEFORE any page scripts run.
	// We also (optionally) override `location.search` before anything
	// else runs so region-routed Switch manuals see the simulated `?r=N`
	// query string we picked from their `regions.js` table.
	const bootstrap = doc.createElement('script');
	bootstrap.textContent = `(function(){
	const bridge = '${options.bridgeName}';
	${options.forcedSearch ? buildLocationSearchOverride(options.forcedSearch) : ''}
	${options.nxShim}
	// Intercept anchor clicks so the parent can route to in-bundle docs
	// instead of having the iframe try (and fail) to do a real navigation.
	document.addEventListener('click', function(e) {
		var t = e.target;
		while (t && t.nodeType === 1 && t.tagName !== 'A' && t.tagName !== 'AREA') t = t.parentElement;
		if (!t || !t.getAttribute) return;
		// Prefer the resolved path stashed by the rewriter (relative to the
		// bundle root); fall back to the literal href for anything we
		// didn't rewrite.
		var href = t.getAttribute('data-htdocs-href') || t.getAttribute('href');
		if (!href) return;
		var trimmed = href.trim();
		if (trimmed[0] === '#') return;
		// Real external URLs and javascript:/mailto: links → leave for the browser.
		if (/^(?:[a-z][a-z0-9+.\\-]*:)/i.test(trimmed) && !/^blob:/i.test(trimmed)) return;
		e.preventDefault();
		try {
			window.parent.postMessage({ kind: bridge, type: 'navigate', href: href }, '*');
		} catch (err) {}
	}, true);
})();`;
	const head = doc.head ?? doc.documentElement;
	head.insertBefore(bootstrap, head.firstChild);

	return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

function rewriteAttr(
	el: Element,
	attr: string,
	value: string,
	documentPath: string,
	bundle: HtdocsBundle,
): void {
	const path = bundle.resolvePath(documentPath, value);
	if (!path) return;
	const url = bundle.urlFor(path);
	if (!url) return;
	// For <a href> we deliberately leave the relative path in place so
	// our click interceptor can route it through the parent (which then
	// re-renders the iframe with the new page rewritten in turn). If we
	// substituted the blob URL here, a click would navigate the iframe
	// directly to the blob — bypassing rewriting and breaking every
	// further relative reference inside that next document.
	if (el.tagName === 'A' || el.tagName === 'AREA') {
		// Stash the resolved bundle path for the click handler.
		el.setAttribute('data-htdocs-href', path);
		return;
	}
	el.setAttribute(attr, url);
}

function rewriteSrcset(
	value: string,
	documentPath: string,
	bundle: HtdocsBundle,
): string {
	// Format: `url descriptor, url descriptor, ...`
	return value
		.split(',')
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed) return part;
			const [url, ...rest] = trimmed.split(/\s+/);
			const path = bundle.resolvePath(documentPath, url);
			if (!path) return part;
			const u = bundle.urlFor(path);
			if (!u) return part;
			return [u, ...rest].join(' ');
		})
		.join(', ');
}

/**
 * Rewrite `url(...)` and `@import` references inside a CSS string.
 * Handles single-quoted, double-quoted, and unquoted forms.
 */
export function rewriteCss(
	css: string,
	documentPath: string,
	bundle: HtdocsBundle,
): string {
	const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+))\s*\)/g;
	const importRe = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"';)\s]+))\s*\)?/g;

	const replaceUrl = (raw: string): string => {
		const target = bundle.resolvePath(documentPath, raw);
		if (!target) return raw;
		return bundle.urlFor(target) ?? raw;
	};

	return css
		.replace(urlRe, (_match, dq, sq, bare) => {
			const raw = dq ?? sq ?? bare ?? '';
			const replaced = replaceUrl(raw);
			return `url("${replaced}")`;
		})
		.replace(importRe, (match, dq, sq, bare) => {
			const raw = dq ?? sq ?? bare ?? '';
			if (!raw) return match;
			const replaced = replaceUrl(raw);
			// Preserve whether the original used url() wrapper
			if (/url\(/i.test(match)) return `@import url("${replaced}")`;
			return `@import "${replaced}"`;
		});
}

/**
 * Build the snippet that overrides `location.search` for a srcdoc
 * iframe. Switch offline manuals gate their per-region routing on
 * `location.search`, but srcdoc iframes have no real URL so the
 * value is always `''` — leaving the page blank.
 *
 * We try two strategies because browsers vary on which is permitted
 * for the `Location` exotic object:
 *
 *   1. Define on the instance — works in Chrome / Edge / Safari.
 *   2. Fall back to `Location.prototype`.
 *
 * In addition to the override, we directly post a debug message so
 * the host nx-log panel can show whether the override took effect.
 *
 * Note: the host preview also has a separate, more reliable path —
 * if it knows the page is a region router, it skips loading the
 * router HTML entirely and goes straight to `regions[regionKey]`.
 * The override here is a defence in depth for cases where the host
 * heuristic misses the routing pattern.
 */
function buildLocationSearchOverride(forcedSearch: string): string {
	// JSON.stringify gives us a safely-escaped JS string literal.
	const lit = JSON.stringify(forcedSearch);
	return `
		var __searchInstalled = false;
		try {
			Object.defineProperty(location, 'search', {
				configurable: true,
				get: function() { return ${lit}; },
				set: function(v) {
					try {
						window.parent.postMessage(
							{ kind: bridge, type: 'navigate', href: location.pathname + String(v) },
							'*'
						);
					} catch (e) {}
				},
			});
			__searchInstalled = 'instance';
		} catch (e1) {
			try {
				var __locProto = Object.getPrototypeOf(location) || Location.prototype;
				Object.defineProperty(__locProto, 'search', {
					configurable: true,
					get: function() { return ${lit}; },
					set: function(v) {
						try {
							window.parent.postMessage(
								{ kind: bridge, type: 'navigate', href: location.pathname + String(v) },
								'*'
							);
						} catch (e) {}
					},
				});
				__searchInstalled = 'prototype';
			} catch (e2) {
				__searchInstalled = 'failed:' + (e1 && e1.message) + '|' + (e2 && e2.message);
			}
		}
		try {
			window.parent.postMessage(
				{ kind: bridge, type: 'debug', message: 'forcedSearch=' + ${JSON.stringify(forcedSearch)} + ' install=' + __searchInstalled + ' read=' + location.search },
				'*'
			);
		} catch (e) {}
	`;
}

// ---------------------------------------------------------------------------
// `window.nx` shim
// ---------------------------------------------------------------------------

/**
 * The body of the `window.nx` shim, injected as a `<script>` at the top
 * of every rewritten page. It's a string template (not a module) so it
 * runs in the iframe's scope.
 *
 * The implemented surface is the subset of the Switch's Web Applet
 * `window.nx` API that is plausibly called by offline (`*.htdocs/`) game
 * manuals. eShop-only methods (`window.nx.shop.*`) are intentionally
 * NOT stubbed since offline manuals never reach them, and stubbing them
 * could mask real bugs.
 *
 * Method surface (sources: switchbrew.org/wiki/Internet_Browser, the
 * kinnay/NintendoClients wiki entry for the eShop applet, and direct
 * inspection of retail offline manuals):
 *
 * Messaging:
 *   - sendMessage(string) → bool
 *   - addEventListener(name, cb)
 *   - removeEventListener(name, cb)
 * Applet lifecycle:
 *   - endApplet()
 *   - canHistoryBack() → bool
 * Audio / haptics:
 *   - playSystemSe(name)
 * Footer (A/B/X/Y button hints at the bottom of the screen):
 *   - footer.setDefaultAssign() / setAssign() / unsetAssign()
 * Keyboard / dialogs:
 *   - isKeyboardShown() → bool
 *   - setKeyboardChangedCallback(cb)
 *   - open1ButtonDialog({ message, buttonText }, cb)
 *   - open2ButtonDialog({ message, leftButtonText, rightButtonText }, cb)
 * System info:
 *   - system.productModel
 *   - system.version.comparable(a, b)
 *   - system.getAccountNickname(cb)
 *   - system.loadAccountProfileImage(cb)
 *   - system.isUserOperationLocked() / lockUserOperation() / unlockUserOperation()
 *   - system.makeErrorCode(major, minor)
 *   - system.showError(code)
 *
 * `bridgeName` is interpolated so postMessage exchanges with the parent
 * app are namespaced (avoids colliding with messages from other tools
 * the host page might use).
 */
export function buildNxShim(bridgeName: string): string {
	return `
		var __nxListeners = { message: [], keyboardChanged: [] };
		var __nxFooterAssigns = {};
		var __nxUserOperationLocked = false;
		var __nxNextRequestId = 1;
		var __nxPendingRequests = {};
		function __nxPost(payload) {
			try { window.parent.postMessage(Object.assign({ kind: '${bridgeName}' }, payload), '*'); } catch (e) {}
		}
		function __nxAddListener(name, cb) {
			if (typeof cb !== 'function') return;
			if (!__nxListeners[name]) __nxListeners[name] = [];
			__nxListeners[name].push(cb);
		}
		function __nxRemoveListener(name, cb) {
			var arr = __nxListeners[name]; if (!arr) return;
			var i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1);
		}
		function __nxFire(name, arg) {
			var arr = __nxListeners[name] || [];
			for (var i = 0; i < arr.length; i++) {
				try { arr[i](arg); } catch (e) {}
			}
		}
		// Asynchronous callback-style methods get a request id so a host
		// debug panel could in theory complete them later. For now they
		// fire their cb on the next microtask with safe defaults.
		function __nxAsync(cb, value) {
			if (typeof cb !== 'function') return;
			Promise.resolve().then(function() { try { cb(value); } catch (e) {} });
		}
		window.nx = {
			// ---- Messaging --------------------------------------------------
			sendMessage: function(s) {
				__nxPost({ type: 'sendMessage', message: String(s) });
				return true;
			},
			addEventListener: function(name, cb) { __nxAddListener(name, cb); },
			removeEventListener: function(name, cb) { __nxRemoveListener(name, cb); },

			// ---- Applet lifecycle ------------------------------------------
			endApplet: function() { __nxPost({ type: 'endApplet' }); },
			canHistoryBack: function() {
				try { return history.length > 1; } catch (e) { return false; }
			},

			// ---- Audio -----------------------------------------------------
			playSystemSe: function(name) {
				__nxPost({ type: 'playSystemSe', name: String(name) });
			},

			// ---- Footer (A/B/X/Y button hints) ----------------------------
			footer: {
				setDefaultAssign: function(button, label, fn) {
					__nxFooterAssigns[button] = { label: label, fn: fn, isDefault: true };
					__nxPost({ type: 'footer.setAssign', button: String(button), label: String(label) });
				},
				setAssign: function(button, label, fn) {
					__nxFooterAssigns[button] = { label: label, fn: fn, isDefault: false };
					__nxPost({ type: 'footer.setAssign', button: String(button), label: String(label) });
				},
				unsetAssign: function(button) {
					delete __nxFooterAssigns[button];
					__nxPost({ type: 'footer.unsetAssign', button: String(button) });
				},
			},

			// ---- Keyboard / dialogs ---------------------------------------
			isKeyboardShown: function() { return false; },
			setKeyboardChangedCallback: function(cb) {
				// Replace any previous handler — only one is supported.
				__nxListeners.keyboardChanged = typeof cb === 'function' ? [cb] : [];
			},
			open1ButtonDialog: function(opts, cb) {
				__nxPost({ type: 'dialog.open1', opts: opts });
				// Fall through immediately — the host can't easily intercept
				// the user input, so we just acknowledge and dismiss.
				__nxAsync(cb, 0);
			},
			open2ButtonDialog: function(opts, cb) {
				__nxPost({ type: 'dialog.open2', opts: opts });
				__nxAsync(cb, 0);
			},

			// ---- System info ----------------------------------------------
			system: {
				productModel: 'NX', // generic Switch model id
				version: {
					comparable: function(a, b) {
						// Lexical compare on dotted version strings; mirrors
						// what most Web Applet pages care about ("a >= b?").
						function parts(v) {
							return String(v || '').split('.').map(function(x) {
								var n = parseInt(x, 10);
								return isNaN(n) ? 0 : n;
							});
						}
						var pa = parts(a), pb = parts(b);
						var len = Math.max(pa.length, pb.length);
						for (var i = 0; i < len; i++) {
							var ai = pa[i] || 0, bi = pb[i] || 0;
							if (ai < bi) return -1;
							if (ai > bi) return 1;
						}
						return 0;
					},
				},
				getAccountNickname: function(cb) { __nxAsync(cb, 'nx-archive'); },
				loadAccountProfileImage: function(cb) { __nxAsync(cb, null); },
				isUserOperationLocked: function() { return __nxUserOperationLocked; },
				lockUserOperation: function() {
					__nxUserOperationLocked = true;
					__nxPost({ type: 'system.lockUserOperation' });
				},
				unlockUserOperation: function() {
					__nxUserOperationLocked = false;
					__nxPost({ type: 'system.unlockUserOperation' });
				},
				makeErrorCode: function(major, minor) {
					return String(major) + '-' + String(minor);
				},
				showError: function(code) { __nxPost({ type: 'system.showError', code: code }); },
			},

			// ---- Misc niceties --------------------------------------------
			getEnvironment: function() { return 'web-archive-preview'; },
			toString: function() { return '[nx-archive: window.nx stub]'; },
		};

		// Receive messages from the parent app for fan-in into nx event
		// listeners. Used by the parent's debug message panel.
		window.addEventListener('message', function(ev) {
			var d = ev.data; if (!d || d.kind !== '${bridgeName}') return;
			if (d.type === 'message') __nxFire('message', { data: d.data });
			if (d.type === 'keyboardChanged') __nxFire('keyboardChanged', d.shown);
			if (d.type === 'footer.invoke') {
				var f = __nxFooterAssigns[d.button];
				if (f && typeof f.fn === 'function') {
					try { f.fn(); } catch (e) {}
				}
			}
		});

		// Intercept programmatic navigation. Real Switch manuals frequently
		// do \`window.location.href = "other.html"\` to switch regional
		// pages, but our srcdoc iframes have an \`about:srcdoc\` base so
		// the browser would either fail silently or escape the bundle.
		// Route everything through the parent's navigation handler instead.
		try {
			var __locProto = Object.getPrototypeOf(location) || Location.prototype;
			var __origHrefDesc = Object.getOwnPropertyDescriptor(__locProto, 'href');
			if (__origHrefDesc && __origHrefDesc.set) {
				Object.defineProperty(location, 'href', {
					configurable: true,
					get: __origHrefDesc.get,
					set: function(v) { __nxPost({ type: 'navigate', href: String(v) }); },
				});
			}
			var __origAssign = location.assign && location.assign.bind(location);
			location.assign = function(v) { __nxPost({ type: 'navigate', href: String(v) }); };
			var __origReplace = location.replace && location.replace.bind(location);
			location.replace = function(v) { __nxPost({ type: 'navigate', href: String(v) }); };
		} catch (e) {}

		__nxPost({ type: 'ready', url: location.href });
	`.trim();
}
