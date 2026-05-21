/**
 * Extract the external-library lists from FFmpeg's `configure`
 * script. These are the canonical buckets that determine our
 * shipping policy:
 *
 *   EXTERNAL_LIBRARY_GPL_LIST       — GPL externals (libx264, ...)
 *   EXTERNAL_LIBRARY_NONFREE_LIST   — non-free (libfdk_aac, ...)
 *   EXTERNAL_LIBRARY_VERSION3_LIST  — LGPLv3/GPLv3 externals
 *   EXTERNAL_LIBRARY_LIST           — everything else (permissive)
 *   EXTERNAL_AUTODETECT_LIBRARY_LIST — system libs (zlib, lzma, ...)
 *
 * Each list in `configure` is a multi-line shell array:
 *
 *   EXTERNAL_LIBRARY_GPL_LIST="
 *       avisynth
 *       frei0r
 *       libcdio
 *       ...
 *   "
 *
 * We extract them by scanning for `NAME="` ... matching `"` block.
 */
import { readFileSync } from "node:fs"

export interface ExternalLibs {
	gpl: Set<string>
	nonfree: Set<string>
	version3: Set<string>
	all: Set<string>
}

const LIST_NAMES = [
	"EXTERNAL_LIBRARY_GPL_LIST",
	"EXTERNAL_LIBRARY_NONFREE_LIST",
	"EXTERNAL_LIBRARY_VERSION3_LIST",
	"EXTERNAL_LIBRARY_GPLV3_LIST",
	"EXTERNAL_LIBRARY_LIST",
	"EXTERNAL_AUTODETECT_LIBRARY_LIST",
] as const

function extractList(source: string, name: string): Set<string> {
	const re = new RegExp(`^${name}="([\\s\\S]*?)"`, "m")
	const m = re.exec(source)
	if (!m) return new Set()
	return new Set(
		m[1]!
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(
				(s) =>
					s.length > 0 && !s.startsWith("$") /* skip nested list refs */,
			),
	)
}

export function parseExternalLibs(source: string): ExternalLibs {
	const lists: Record<string, Set<string>> = {}
	for (const n of LIST_NAMES) lists[n] = extractList(source, n)

	const all = new Set<string>()
	for (const n of LIST_NAMES) {
		for (const lib of lists[n]!) all.add(lib)
	}

	return {
		gpl: lists["EXTERNAL_LIBRARY_GPL_LIST"]!,
		nonfree: lists["EXTERNAL_LIBRARY_NONFREE_LIST"]!,
		version3: new Set([
			...lists["EXTERNAL_LIBRARY_VERSION3_LIST"]!,
			...lists["EXTERNAL_LIBRARY_GPLV3_LIST"]!,
		]),
		all,
	}
}

export function parseExternalLibsFile(path: string): ExternalLibs {
	return parseExternalLibs(readFileSync(path, "utf8"))
}
