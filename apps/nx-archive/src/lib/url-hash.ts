/**
 * Tiny URL-fragment state helper for the selected tree node.
 *
 * We use the location hash (`#…`) rather than the path because:
 *
 *   1. No server-rewrite config needed — any static host works.
 *   2. Hash changes never reload the page.
 *   3. Tree node ids contain path separators, square brackets,
 *      and the occasional control byte (e.g. Unity asset paths
 *      ending in `\0`). The hash is the most permissive part of
 *      a URL; we URI-encode on write and decode on read.
 *
 * The hook exposes:
 *
 *   - {@link readHashId} — synchronous accessor, useful at boot
 *     before React has mounted (we can route from the very first
 *     render).
 *   - {@link useHashId} — React hook returning the current id +
 *     a setter that takes a `mode` discriminating user clicks
 *     (`pushState`, adds to back-button history) from programmatic
 *     navigation (`replaceState`, silent).
 *
 * The setter coalesces no-op writes so we don't litter history
 * with redundant entries when components re-render with the
 * same id.
 */

import { useCallback, useEffect, useState } from 'react';

/** How a URL change should be recorded in browser history. */
export type HashUpdateMode = 'push' | 'replace';

/**
 * Encode a node id for use as a URL fragment.
 *
 * `encodeURIComponent` would escape every `/` as `%2F`, which is
 * correct but produces ugly URLs for slash-heavy archive paths
 * like `/wave.zip/wave1131.wd/wave1131_003.wav` →
 * `%2Fwave.zip%2Fwave1131.wd%2Fwave1131_003.wav`.
 *
 * URL fragments (RFC 3986 §3.5) are far more permissive than
 * query strings: most reserved characters (`/`, `?`, `:`, `@`,
 * `=`, `+`, `,`, `;`, `(`, `)`, etc.) are allowed unescaped.
 * Only a handful actually need encoding inside a fragment:
 *
 *   - `#` (would terminate the fragment)
 *   - whitespace (browsers normalise it inconsistently)
 *   - `%` (must be percent-encoded to disambiguate from
 *     legitimate escape sequences in the path)
 *   - non-ASCII (some browsers happily display these unescaped
 *     in the address bar but copy them encoded; we encode for
 *     consistency so the URL round-trips through copy/paste)
 *
 * We base-encode the id with `encodeURIComponent` to handle the
 * non-ASCII and control-byte cases correctly, then unescape the
 * "looks fine in a URL" set so the displayed URL stays readable.
 */
function encodeHashId(id: string): string {
	let s = encodeURIComponent(id);
	// Restore the characters that are perfectly legal in a
	// fragment but that `encodeURIComponent` overzealously
	// escapes. The set is the union of RFC 3986's `pchar`
	// (path-character) plus `/` and `?`, which is what makes
	// up a fragment.
	const restore: Record<string, string> = {
		'%2F': '/',
		'%3A': ':',
		'%40': '@',
		'%21': '!',
		'%24': '$',
		'%26': '&',
		"%27": "'",
		'%28': '(',
		'%29': ')',
		'%2A': '*',
		'%2B': '+',
		'%2C': ',',
		'%3B': ';',
		'%3D': '=',
		'%3F': '?',
		'%7E': '~',
	};
	s = s.replace(/%[0-9A-F]{2}/g, (m) => restore[m] ?? m);
	return s;
}

/** Decode the current `location.hash` to a node id (or `null`). */
export function readHashId(): string | null {
	if (typeof window === 'undefined') return null;
	const raw = window.location.hash;
	if (!raw || raw === '#') return null;
	try {
		return decodeURIComponent(raw.slice(1));
	} catch {
		return raw.slice(1);
	}
}

/** Write a node id (or `null` to clear) into `location.hash`. */
function writeHashId(id: string | null, mode: HashUpdateMode): void {
	if (typeof window === 'undefined') return;
	const targetHash = id ? '#' + encodeHashId(id) : '';
	// Build a URL whose only difference from the current location
	// is the hash, so we don't accidentally rewrite query or path.
	const url =
		window.location.pathname + window.location.search + targetHash;
	if (window.location.hash === targetHash) return;
	if (mode === 'push') window.history.pushState(null, '', url);
	else window.history.replaceState(null, '', url);
}

/**
 * Hook returning `[currentHashId, setHashId]`. The setter takes
 * a {@link HashUpdateMode}; user-initiated changes should pass
 * `'push'` so back/forward navigation works, programmatic
 * updates should pass `'replace'`.
 *
 * The hook also listens for `popstate` events so the back/forward
 * buttons update the React state.
 */
export function useHashId(): [
	string | null,
	(id: string | null, mode: HashUpdateMode) => void,
] {
	const [id, setId] = useState<string | null>(() => readHashId());

	useEffect(() => {
		const onPop = () => setId(readHashId());
		window.addEventListener('popstate', onPop);
		// Also listen to manual `hashchange` (some external links
		// or fragments-set-from-devtools fire this without popstate).
		window.addEventListener('hashchange', onPop);
		return () => {
			window.removeEventListener('popstate', onPop);
			window.removeEventListener('hashchange', onPop);
		};
	}, []);

	const setHashId = useCallback(
		(next: string | null, mode: HashUpdateMode) => {
			writeHashId(next, mode);
			setId(next);
		},
		[],
	);

	return [id, setHashId];
}
