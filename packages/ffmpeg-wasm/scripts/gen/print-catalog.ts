/**
 * Demo: load every built extension and print the live catalog
 * (analogous to `ffmpeg -decoders / -muxers / -demuxers`).
 *
 * Useful to eyeball the output of the introspection API. The
 * vitest suite covers the same paths programmatically.
 *
 * Run with:
 *   node --experimental-strip-types scripts/gen/print-catalog.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"

import { Ffmpeg } from "../../src/index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = pathResolve(here, "..", "..")
const baseWasm = readFileSync(pathResolve(pkgRoot, "src/ffmpeg.wasm"))

const extRoot = pathResolve(pkgRoot, "src/extensions")
const slugs = readdirSync(extRoot).filter((n) => {
	try {
		const s = statSync(pathResolve(extRoot, n))
		if (!s.isDirectory()) return false
		statSync(pathResolve(extRoot, n, `${n}.so`))
		return true
	} catch {
		return false
	}
})

const exts = slugs.map((s) => ({
	name: s,
	wasm: readFileSync(pathResolve(extRoot, s, `${s}.so`)),
}))

const ff = await Ffmpeg.create({ wasm: baseWasm, extensions: exts })

const codecs = ff.listCodecs()
const demuxers = ff.listDemuxers()
const muxers = ff.listMuxers()

console.log(`Loaded ${exts.length} extensions`)
console.log()
console.log(`Codecs (${codecs.length}):`)
console.log(`  D E  Type     Name         Long name`)
console.log(`  --   -------  -----------  ----------`)
for (const c of codecs) {
	const flags = (c.isDecoder ? "D" : ".") + (c.isEncoder ? "E" : ".")
	console.log(
		`  ${flags}   ${c.mediaType.padEnd(7)}  ${c.name.padEnd(11)}  ${c.longName}`,
	)
}
console.log()
console.log(`Demuxers (${demuxers.length}):`)
console.log(`  Name      Extensions  Long name`)
console.log(`  --------  ----------  ----------`)
for (const d of demuxers) {
	console.log(
		`  ${d.name.padEnd(8)}  ${(d.extensions ?? "").padEnd(10)}  ${d.longName}`,
	)
}
console.log()
console.log(`Muxers (${muxers.length}):`)
console.log(`  Name      Extensions  Long name`)
console.log(`  --------  ----------  ----------`)
for (const m of muxers) {
	console.log(
		`  ${m.name.padEnd(8)}  ${(m.extensions ?? "").padEnd(10)}  ${m.longName}`,
	)
}
ff.dispose()
