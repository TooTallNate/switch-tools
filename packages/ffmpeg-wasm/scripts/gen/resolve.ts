/**
 * Dependency resolver: given a codec / demuxer / muxer name,
 * compute the transitive closure of CONFIG_* flags and the list
 * of object files (and corresponding source files) the extension
 * needs to compile.
 *
 * Inputs:
 *
 *   - `ConfigureData` (from `parse-configure.ts`) — the
 *     `_select`/`_deps` cascades.
 *
 *   - One or more `MakefileData` (from `parse-makefile.ts`) — the
 *     `OBJS-$(CONFIG_X) += ...` rules per library. We feed in
 *     both `libavcodec/Makefile` and `libavformat/Makefile`
 *     because helpers can live in either library
 *     (`RIFFDEC` is in libavformat but `mdct` is in libavcodec).
 *
 *   - `baseHelpers` — the set of lowercase helper names already
 *     compiled into the base WASM (see `enable-helpers.sh`). The
 *     resolver subtracts these from the closure so we don't
 *     re-emit object files that are already linked statically
 *     into `ffmpeg.wasm`.
 *
 * The closure is computed in lowercase (matching `configure`'s
 * convention) and uppercased only at the boundary when we need
 * to look up `OBJS-$(CONFIG_FOO)` in the Makefile.
 */
import type { ConfigureData } from "./parse-configure.ts"
import type { MakefileData } from "./parse-makefile.ts"

export interface MakefileSource {
	/** Library name, e.g. `"libavcodec"` or `"libavformat"`. */
	library: string
	/** Parsed makefile data for that library. */
	data: MakefileData
}

export interface ResolveResult {
	/**
	 * Object files needed by this extension, mapped to the
	 * library they live in. Excludes anything already in
	 * `baseObjs` (the unconditional library content) or
	 * `baseHelpers` (helpers already compiled into the base
	 * WASM). Each entry is the raw `*.o` token from the
	 * Makefile.
	 */
	objs: Array<{ library: string; obj: string }>
	/**
	 * Uppercase CONFIG_* flag names that need to be defined to
	 * 1 (in `config_components.h` / the shim header) so the
	 * upstream source files compile their relevant sections.
	 * Always includes the codec's own primary flag (e.g.
	 * `AAC_DECODER`); also includes every flag in the
	 * `_select` cascade.
	 */
	configFlags: string[]
	/**
	 * Lowercase helper names that the codec selects but that
	 * are already in the base. Returned for diagnostics — if
	 * an extension fails to build, this list tells you which
	 * base-helper symbols it expects to resolve.
	 */
	resolvedFromBase: string[]
}

export interface ResolveOptions {
	configure: ConfigureData
	makefiles: MakefileSource[]
	/**
	 * Lowercase helper names already in the base WASM.
	 * Mirror this against `scripts/enable-helpers.sh`'s
	 * `HELPERS` array.
	 */
	baseHelpers: Set<string>
}

/**
 * Resolve the closure for a single named codec/demuxer/muxer.
 *
 * `thing` should be lowercase (e.g. `"aac_decoder"`,
 * `"wav_demuxer"`, `"adts_muxer"`).
 */
export function resolve(thing: string, opts: ResolveOptions): ResolveResult {
	const visited = new Set<string>()
	const configFlags = new Set<string>()
	const objs: Array<{ library: string; obj: string }> = []
	const resolvedFromBase: string[] = []

	const stack = [thing]
	while (stack.length > 0) {
		const cur = stack.pop()!
		if (visited.has(cur)) continue
		visited.add(cur)

		// Items already in the base contribute nothing to the
		// extension's compile units. Record them for diagnostics
		// but skip the `OBJS-` lookup so the helper's `.o` files
		// don't end up duplicated.
		if (opts.baseHelpers.has(cur)) {
			resolvedFromBase.push(cur)
			continue
		}

		// Cascade through `_select`. We use `_select` only; `_deps`
		// is for environment-level requirements (CPU, OS, libs)
		// that don't apply to our pure-C WASM target.
		const selects = opts.configure.select.get(cur)
		if (selects) {
			for (const s of selects) stack.push(s)
		}

		// Look up OBJS-$(CONFIG_<UPPER>) across libraries. Some
		// helpers exist in multiple libraries (rare); we union
		// the object lists.
		const upper = cur.toUpperCase()
		let foundAny = false
		for (const { library, data } of opts.makefiles) {
			const list = data.conditionalObjs.get(upper)
			if (!list) continue
			foundAny = true
			for (const o of list) {
				// Some `OBJS-` lines reference `$(...)` macros for
				// arch-conditional bits — skip anything containing
				// `$` since we don't evaluate Makefile vars.
				if (o.includes("$")) continue
				objs.push({ library, obj: o })
			}
		}
		if (foundAny) configFlags.add(upper)
		// Items with no OBJS rule and not in the base are
		// silently ignored. These are typically meta-flags
		// (`mdct_select="fft"` where `fft` itself is in the
		// base helpers) or pure dependency anchors with no
		// source files.
	}

	// Drop duplicates while preserving first-occurrence order.
	const seen = new Set<string>()
	const dedupedObjs: Array<{ library: string; obj: string }> = []
	for (const entry of objs) {
		const key = `${entry.library}/${entry.obj}`
		if (seen.has(key)) continue
		seen.add(key)
		dedupedObjs.push(entry)
	}

	// Also subtract anything that's part of the unconditional
	// `OBJS = ...` of each library — those are already linked
	// into the base WASM.
	const baseObjsByLib = new Map<string, Set<string>>()
	for (const { library, data } of opts.makefiles) {
		baseObjsByLib.set(library, new Set(data.baseObjs))
	}
	const filtered = dedupedObjs.filter((e) => {
		const base = baseObjsByLib.get(e.library)
		return !base || !base.has(e.obj)
	})

	return {
		objs: filtered,
		configFlags: Array.from(configFlags).sort(),
		resolvedFromBase: resolvedFromBase.sort(),
	}
}
