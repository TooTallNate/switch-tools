/**
 * Parser for FFmpeg's `configure` script. We only care about the
 * dependency-graph metadata — lines of the form
 *
 *     <thing>_select="a b c"
 *     <thing>_deps="..."
 *     <thing>_suggest="..."
 *
 * where `<thing>` is a codec / demuxer / muxer / parser / bsf /
 * filter / helper name in lowercase.
 *
 * What these mean (paraphrased from `configure` itself):
 *
 *   - `_deps` — hard requirements; if the dep is unavailable,
 *     the thing can't be enabled. Used for things like
 *     `vp9_cuvid_decoder_deps="cuda_llvm"`.
 *
 *   - `_select` — soft activation: enabling the thing forces the
 *     listed sub-components on. This is the bulk of what we
 *     need. For example,
 *     `aac_decoder_select="adts_header mdct15 mdct mpeg4audio sinewin"`
 *     means enabling the AAC decoder pulls in those five helpers.
 *
 *   - `_suggest` — optional / weak link. We currently ignore
 *     these (they're never required for a working build).
 *
 * The parser is intentionally tolerant: it does NOT evaluate
 * shell substitutions. If a value contains `$(VAR)` or other
 * shell expressions, we keep the literal tokens — downstream
 * code can skip what it doesn't recognise.
 */
import { readFileSync } from "node:fs"

export interface ConfigureData {
	/** Map from lowercase `<thing>` → list of selected sub-components. */
	select: Map<string, string[]>
	/** Map from lowercase `<thing>` → list of hard dependencies. */
	deps: Map<string, string[]>
}

/** Parse a configure script's text into structured data. */
export function parseConfigure(source: string): ConfigureData {
	const select = new Map<string, string[]>()
	const deps = new Map<string, string[]>()

	// We don't care about line continuations in `configure` — the
	// metadata lines we want are always single-line. Folding any
	// continuations would risk mangling shell heredocs.
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim()
		if (line.length === 0 || line.startsWith("#")) continue

		const m = /^([a-z][a-z0-9_]*)_(select|deps|suggest)=(.+)$/.exec(line)
		if (!m) continue
		const [, thing, kind, rhsRaw] = m

		// Strip surrounding quotes (single or double) if present.
		const rhs = stripQuotes(rhsRaw!.trim())
		const tokens = rhs.split(/\s+/).filter((t) => t.length > 0)
		if (tokens.length === 0) continue

		if (kind === "select") select.set(thing!, tokens)
		else if (kind === "deps") deps.set(thing!, tokens)
		// `suggest` deliberately ignored for now.
	}

	return { select, deps }
}

/** Convenience wrapper that reads a file and parses it. */
export function parseConfigureFile(path: string): ConfigureData {
	return parseConfigure(readFileSync(path, "utf8"))
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const f = s.charCodeAt(0)
		const l = s.charCodeAt(s.length - 1)
		if ((f === 0x22 && l === 0x22) || (f === 0x27 && l === 0x27)) {
			return s.slice(1, -1)
		}
	}
	return s
}
