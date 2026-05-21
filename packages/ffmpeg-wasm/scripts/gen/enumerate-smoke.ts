/**
 * Smoke check for the enumerator + classifier. Lists the full
 * upstream codec/demuxer/muxer set with classifications so we
 * can eyeball how much of FFmpeg's universe we can ship as
 * native extensions.
 */
import { enumerateFromFiles } from "./enumerate.ts"
import { parseConfigureFile } from "./parse-configure.ts"
import { parseExternalLibsFile } from "./parse-external-libs.ts"
import { parseMakefileFile } from "./parse-makefile.ts"

const ROOT = new URL("../../build/ffmpeg/", import.meta.url).pathname

const configure = parseConfigureFile(ROOT + "configure")
const externals = parseExternalLibsFile(ROOT + "configure")

const entries = enumerateFromFiles({
	ffmpegRoot: ROOT.replace(/\/$/, ""),
	configure,
	makefiles: [
		{ library: "libavcodec", data: parseMakefileFile(ROOT + "libavcodec/Makefile") },
		{ library: "libavformat", data: parseMakefileFile(ROOT + "libavformat/Makefile") },
	],
	gplLibs: externals.gpl,
	nonfreeLibs: externals.nonfree,
	version3Libs: externals.version3,
	allExternalLibs: externals.all,
})

const byClass: Record<string, number> = {}
const byKindAndClass: Record<string, Record<string, number>> = {}
for (const e of entries) {
	byClass[e.classification] = (byClass[e.classification] ?? 0) + 1
	if (!byKindAndClass[e.kind]) byKindAndClass[e.kind] = {}
	byKindAndClass[e.kind][e.classification] =
		(byKindAndClass[e.kind][e.classification] ?? 0) + 1
}

console.log("By classification:")
for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${k.padEnd(12)} ${v}`)
}
console.log()
console.log("By kind × classification:")
for (const kind of Object.keys(byKindAndClass).sort()) {
	console.log(`  ${kind}:`)
	for (const [k, v] of Object.entries(byKindAndClass[kind]!).sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(`    ${k.padEnd(12)} ${v}`)
	}
}

console.log()
console.log(
	`Total native (shippable): ${entries.filter((e) => e.classification === "native").length}`,
)

console.log()
console.log("Sample external (gpl, nonfree, version3):")
for (const c of ["gpl", "nonfree", "version3", "external"] as const) {
	const items = entries.filter((e) => e.classification === c)
	if (items.length === 0) continue
	console.log(
		`  ${c} (${items.length}): ${items.slice(0, 8).map((e) => e.thing).join(", ")}${items.length > 8 ? ", ..." : ""}`,
	)
}
