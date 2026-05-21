/**
 * Build every generated extension, recording successes and
 * failures. Writes a summary to stdout + `dist/build-results.json`.
 *
 * Run with:
 *   node --experimental-strip-types scripts/gen/build-all.ts
 *
 * Use:
 *   --concurrency N    parallelism (default: CPU count)
 *   --filter REGEX     only build slugs matching the regex
 *   --keep-going       don't stop on first failure (default: keep going)
 */
import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, resolve as pathResolve } from "node:path"
import { fileURLToPath } from "node:url"

interface BuildResult {
	slug: string
	ok: boolean
	bytes?: number
	durationMs: number
	error?: string
	tail?: string
}

async function run(): Promise<void> {
	const args = process.argv.slice(2)
	const concurrencyArg = args.findIndex((a) => a === "--concurrency")
	const concurrency =
		concurrencyArg >= 0
			? parseInt(args[concurrencyArg + 1] ?? "", 10)
			: availableParallelism()
	const filterArg = args.findIndex((a) => a === "--filter")
	const filter =
		filterArg >= 0 ? new RegExp(args[filterArg + 1] ?? "") : null

	const here = dirname(fileURLToPath(import.meta.url))
	const pkgRoot = pathResolve(here, "..", "..")
	const extRoot = pathResolve(pkgRoot, "src", "extensions")
	const allSlugs = readdirSync(extRoot)
		.filter((n) => {
			try {
				return statSync(pathResolve(extRoot, n)).isDirectory()
			} catch {
				return false
			}
		})
		.filter((n) => !filter || filter.test(n))
		.sort()

	console.log(
		`Building ${allSlugs.length} extension(s) with concurrency ${concurrency}...`,
	)

	const results: BuildResult[] = []
	let nextIdx = 0
	let okCount = 0
	let failCount = 0
	const t0 = Date.now()
	let lastProgressMs = t0

	async function worker(): Promise<void> {
		while (true) {
			const i = nextIdx++
			if (i >= allSlugs.length) return
			const slug = allSlugs[i]!
			const dir = pathResolve(extRoot, slug)
			const start = Date.now()
			try {
				const out = await runMake(dir)
				const m = /Built .* \((\d+) bytes\)/.exec(out)
				const bytes = m ? parseInt(m[1]!, 10) : 0
				results.push({
					slug,
					ok: true,
					bytes,
					durationMs: Date.now() - start,
				})
				okCount++
			} catch (err) {
				const e = err as { stderr?: string; message?: string }
				const tail = (e.stderr ?? e.message ?? "")
					.split("\n")
					.filter((l) => /error|undefined|warning:|fatal/i.test(l))
					.slice(-6)
					.join("\n")
				results.push({
					slug,
					ok: false,
					durationMs: Date.now() - start,
					error: e.message ?? String(err),
					tail,
				})
				failCount++
			}
			const now = Date.now()
			if (now - lastProgressMs > 1000 || nextIdx >= allSlugs.length) {
				lastProgressMs = now
				const elapsed = ((now - t0) / 1000).toFixed(1)
				process.stderr.write(
					`\r[${(okCount + failCount).toString().padStart(4)}/${allSlugs.length}] ` +
						`ok=${okCount} fail=${failCount} elapsed=${elapsed}s     `,
				)
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))
	process.stderr.write("\n")

	// Sort: failures first (more interesting), then by slug.
	results.sort((a, b) => {
		if (a.ok !== b.ok) return a.ok ? 1 : -1
		return a.slug.localeCompare(b.slug)
	})

	const distDir = pathResolve(pkgRoot, "dist")
	mkdirSync(distDir, { recursive: true })
	writeFileSync(
		pathResolve(distDir, "build-results.json"),
		JSON.stringify({ okCount, failCount, results }, null, 2) + "\n",
	)

	console.log()
	console.log(
		`Done: ${okCount} ok, ${failCount} fail (${(((Date.now() - t0) / 1000) | 0)}s)`,
	)
	if (failCount > 0) {
		console.log()
		console.log("Failure summary (unique tail patterns):")
		const tailCounts = new Map<string, string[]>()
		for (const r of results) {
			if (r.ok) continue
			const key = (r.tail ?? "").trim().split("\n")[0] ?? "<no output>"
			if (!tailCounts.has(key)) tailCounts.set(key, [])
			tailCounts.get(key)!.push(r.slug)
		}
		const sorted = [...tailCounts.entries()].sort(
			(a, b) => b[1].length - a[1].length,
		)
		for (const [key, slugs] of sorted.slice(0, 20)) {
			console.log(
				`  ${slugs.length.toString().padStart(4)}× ${key.slice(0, 110)}`,
			)
			console.log(
				`        e.g.: ${slugs.slice(0, 3).join(", ")}${slugs.length > 3 ? ", ..." : ""}`,
			)
		}
	}
}

function runMake(dir: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("make", ["-s"], { cwd: dir })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b) => (stdout += b.toString()))
		child.stderr.on("data", (b) => (stderr += b.toString()))
		child.on("close", (code) => {
			if (code === 0) resolve(stdout)
			else reject(Object.assign(new Error(`make exited ${code}`), { stderr }))
		})
		child.on("error", reject)
	})
}

run().catch((e) => {
	console.error(e)
	process.exit(1)
})
