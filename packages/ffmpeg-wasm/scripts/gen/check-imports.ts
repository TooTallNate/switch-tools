/**
 * Walk every built `.so` under `src/extensions/` and list the
 * `env.*` imports that aren't satisfied by the base WASM's
 * exports. Useful for figuring out which symbols to add to
 * `c/exports.c` + the Makefile `--export=` list in one pass.
 */
import { readFileSync } from "node:fs"
import { readdirSync, statSync } from "node:fs"
import { resolve as pathResolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = pathResolve(fileURLToPath(import.meta.url), "..", "..", "..")
const pkgRoot = here

const baseWasm = readFileSync(pathResolve(pkgRoot, "src/ffmpeg.wasm"))
const baseMod = new WebAssembly.Module(baseWasm)
const baseExports = new Set(
	WebAssembly.Module.exports(baseMod).map((e) => e.name),
)

console.log(`base WASM exports: ${baseExports.size}`)
console.log()

// Symbols satisfied by the dynamic loader rather than the base
// WASM. Not "missing" from a loadability standpoint.
const LOADER_PROVIDED = new Set(["__memory_base", "__table_base"])

const extRoot = pathResolve(pkgRoot, "src/extensions")
const slugs = readdirSync(extRoot).filter((n) => {
	try {
		return statSync(pathResolve(extRoot, n)).isDirectory()
	} catch {
		return false
	}
})

const allMissing = new Map<string, Set<string>>() // symbol → which extensions need it

let okCount = 0
let unsatisfiedCount = 0
let parseErrorCount = 0
for (const slug of slugs) {
	const soPath = pathResolve(extRoot, slug, `${slug}.so`)
	let buf: Buffer
	try {
		buf = readFileSync(soPath)
	} catch {
		continue
	}
	let mod: WebAssembly.Module
	try {
		mod = new WebAssembly.Module(buf)
	} catch (err) {
		parseErrorCount++
		console.log(`${slug}: PARSE ERROR — ${(err as Error).message}`)
		continue
	}
	const imports = WebAssembly.Module.imports(mod)
	const envImports = imports
		.filter((i) => i.module === "env")
		.map((i) => i.name)
	const missing = envImports
		.filter((n) => !baseExports.has(n) && !LOADER_PROVIDED.has(n))
		.sort()
	if (missing.length === 0) {
		okCount++
		continue
	}
	unsatisfiedCount++
	for (const m of missing) {
		if (!allMissing.has(m)) allMissing.set(m, new Set())
		allMissing.get(m)!.add(slug)
	}
}

console.log(`OK: ${okCount}`)
console.log(`Unsatisfied: ${unsatisfiedCount}`)
console.log(`Parse errors: ${parseErrorCount}`)

console.log()
console.log(`unique missing symbols across all extensions: ${allMissing.size}`)
console.log()
for (const [sym, exts] of [...allMissing.entries()].sort()) {
	console.log(`  ${sym}    (needed by: ${[...exts].sort().join(", ")})`)
}
