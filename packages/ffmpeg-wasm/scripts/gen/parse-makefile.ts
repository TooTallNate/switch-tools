/**
 * Parser for FFmpeg's per-library Makefiles
 * (`libavcodec/Makefile`, `libavformat/Makefile`, ...).
 *
 * What we extract:
 *
 *   - `OBJS-$(CONFIG_FOO) += a.o b.o ...`
 *     → `{ "FOO": ["a.o", "b.o"] }`
 *
 *   - `OBJS = ...`  (the unconditional base OBJS for the library —
 *     these are part of libavcodec.a / libavformat.a regardless
 *     of any codec being enabled)
 *
 *   - `SHLIBOBJS-$(CONFIG_X) += ...` and other variants are
 *     ignored — we only care about static-link object files.
 *
 * Multi-line continuations (lines ending in `\`) are folded.
 * Comments and blank lines are stripped.
 *
 * The parser is intentionally tolerant: it does NOT try to fully
 * expand variables, evaluate functions, or follow includes. If a
 * line uses a `$(VAR)` we don't know how to resolve, we keep the
 * literal text — downstream code can flag or ignore those.
 */
import { readFileSync } from "node:fs"

export interface MakefileData {
	/** Unconditional `OBJS = ...` files (the base library content). */
	baseObjs: string[]
	/**
	 * Conditional `OBJS-$(CONFIG_X) += ...` rules. Multiple `+=`
	 * for the same X accumulate. Map key is the CONFIG name
	 * WITHOUT the `CONFIG_` prefix (e.g. `"AAC_DECODER"`).
	 */
	conditionalObjs: Map<string, string[]>
}

/**
 * Parse a Makefile string into structured data. Caller is
 * responsible for reading the file; this function operates on
 * pure text so it's easy to unit-test.
 */
export function parseMakefile(source: string): MakefileData {
	const lines = foldContinuations(source)

	const baseObjs: string[] = []
	const conditional = new Map<string, string[]>()

	for (const rawLine of lines) {
		const line = stripComment(rawLine).trim()
		if (line.length === 0) continue

		// `OBJS = a.o b.o ...` (no `+=`, no condition)
		const baseMatch = /^OBJS\s*=\s*(.+)$/.exec(line)
		if (baseMatch) {
			for (const o of splitObjects(baseMatch[1]!)) baseObjs.push(o)
			continue
		}

		// `OBJS-$(CONFIG_FOO) += a.o b.o ...`
		const condMatch =
			/^OBJS-\$\(CONFIG_([A-Z0-9_]+)\)\s*\+=\s*(.+)$/.exec(line)
		if (condMatch) {
			const key = condMatch[1]!
			const list = conditional.get(key) ?? []
			for (const o of splitObjects(condMatch[2]!)) list.push(o)
			conditional.set(key, list)
			continue
		}
	}

	return { baseObjs, conditionalObjs: conditional }
}

/** Convenience wrapper that reads a file and parses it. */
export function parseMakefileFile(path: string): MakefileData {
	return parseMakefile(readFileSync(path, "utf8"))
}

/**
 * Fold lines ending in `\` into the next physical line. Returns
 * the unfolded array of logical lines. Trailing whitespace on
 * the continuation marker is collapsed to a single space.
 */
function foldContinuations(source: string): string[] {
	const out: string[] = []
	let acc = ""
	for (const physical of source.split("\n")) {
		if (physical.endsWith("\\")) {
			acc += physical.slice(0, -1) + " "
			continue
		}
		out.push(acc + physical)
		acc = ""
	}
	if (acc.length > 0) out.push(acc)
	return out
}

/** Strip everything from the first un-escaped `#` to end-of-line. */
function stripComment(line: string): string {
	const idx = line.indexOf("#")
	return idx < 0 ? line : line.slice(0, idx)
}

/**
 * Split the right-hand side of an assignment into individual
 * object-file tokens. We split on whitespace and accept any
 * `*.o` token verbatim. Tokens containing `$(...)` are kept as-is
 * (downstream code can decide to ignore or process them).
 */
function splitObjects(rhs: string): string[] {
	return rhs
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
}
