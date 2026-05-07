/**
 * Lazy syntax highlighting via Shiki, scoped to the small set of
 * languages most likely to show up inside Switch archives:
 *
 *   - JSON (game manifests, BCAT configs, etc.)
 *   - HTML / XML / SVG / plist (offline manuals, settings, vector icons)
 *   - JavaScript / TypeScript family (htdocs scripts, packed JS)
 *   - CSS (htdocs stylesheets)
 *   - YAML / TOML (occasional dev/build artifacts)
 *
 * We use Shiki's built-in `engine-javascript` engine instead of the
 * default Oniguruma/WASM one. The JS engine is a few hundred KB
 * smaller and has no WASM init cost. The trade-off: a handful of
 * exotic grammars don't compile to it (because they use Oniguruma-
 * specific regex features). All of the common languages above
 * compile cleanly.
 *
 * The highlighter is created lazily on first use and cached for the
 * lifetime of the page. Switching themes (light↔dark) doesn't
 * recreate it — Shiki bundles both themes once.
 */

import {
	createHighlighterCore,
	type HighlighterCore,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Singleton highlighter; populated on first call to
 * {@link getHighlighter}.
 *
 * The grammars and themes below are imported via explicit dynamic
 * `import()` so Vite can tree-shake everything else in
 * `@shikijs/langs` / `@shikijs/themes` away. We deliberately avoid
 * importing `bundledLanguages` / `bundledThemes` from `shiki` itself
 * — those records reference *every* language thunk, and even though
 * the values are lazy, Vite's static analysis ends up emitting a
 * chunk per language (~300 KB of JS overhead from cpp / wolfram /
 * emacs-lisp etc. just to *register* the dynamic imports).
 */
let cached: Promise<HighlighterCore> | null = null;

/**
 * Get (or lazily create) the shared `Highlighter` instance. Subsequent
 * calls return the same promise so concurrent renders don't fight over
 * initialisation.
 */
export function getHighlighter(): Promise<HighlighterCore> {
	if (!cached) {
		cached = createHighlighterCore({
			engine: createJavaScriptRegexEngine(),
			themes: [
				import('@shikijs/themes/github-light'),
				import('@shikijs/themes/github-dark-dimmed'),
			],
			langs: [
				import('@shikijs/langs/json'),
				import('@shikijs/langs/html'),
				import('@shikijs/langs/xml'),
				import('@shikijs/langs/javascript'),
				import('@shikijs/langs/typescript'),
				import('@shikijs/langs/jsx'),
				import('@shikijs/langs/tsx'),
				import('@shikijs/langs/css'),
				import('@shikijs/langs/yaml'),
				import('@shikijs/langs/toml'),
			],
		});
	}
	return cached;
}

/** The themes we ship — one for light mode, one for dark. */
const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark-dimmed';

/**
 * Map a file path / extension to the Shiki language name to use.
 * Returns `null` for files we don't want to highlight (plain text,
 * markdown, configs the user is more likely to scan than edit).
 *
 * The deliberate omissions — `.md`, `.txt`, `.log`, `.cfg`, `.ini`,
 * `.csv`, `.srt`, plus C / Rust / Go source — keep the highlighter
 * payload small. Anything not in this map falls through to plain
 * text rendering, which is identical to the old behaviour.
 */
export function languageForFile(filename: string): SupportedLang | null {
	const lower = filename.toLowerCase();
	const dot = lower.lastIndexOf('.');
	const ext = dot >= 0 ? lower.slice(dot + 1) : '';
	switch (ext) {
		case 'json':
		case 'webmanifest':
			return 'json';
		case 'html':
		case 'htm':
		case 'xhtml':
			return 'html';
		case 'xml':
		case 'plist':
		case 'svg':
			return 'xml';
		case 'js':
		case 'mjs':
		case 'cjs':
			return 'javascript';
		case 'ts':
		case 'mts':
		case 'cts':
			return 'typescript';
		case 'jsx':
			return 'jsx';
		case 'tsx':
			return 'tsx';
		case 'css':
			return 'css';
		case 'yaml':
		case 'yml':
			return 'yaml';
		case 'toml':
			return 'toml';
		default:
			return null;
	}
}

/**
 * Languages this module knows how to highlight — the union of
 * grammars dynamically imported by {@link getHighlighter}.
 */
export type SupportedLang =
	| 'json'
	| 'html'
	| 'xml'
	| 'javascript'
	| 'typescript'
	| 'jsx'
	| 'tsx'
	| 'css'
	| 'yaml'
	| 'toml';

/**
 * Render `code` as syntax-highlighted HTML for the given language and
 * theme. Returns Shiki's `<pre><code>…</code></pre>` HTML, with inline
 * `style` attributes carrying the colours. The caller drops the HTML
 * straight into the DOM via `dangerouslySetInnerHTML`.
 *
 * If `lang` is unsupported (e.g. a typo on our side) Shiki silently
 * falls back to plain text rendering — so this never throws on
 * unknown input, only on malformed grammars (which we never have at
 * runtime since they're loaded statically above).
 */
export async function highlightCode(
	code: string,
	lang: SupportedLang,
	theme: 'light' | 'dark',
): Promise<string> {
	const hi = await getHighlighter();
	return hi.codeToHtml(code, {
		lang,
		theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
	});
}
