/**
 * Compile a WASM module from a Vite `?url` import.
 *
 * In the browser (pages and workers) the import is a fetchable URL.
 * Under Bun (the headless `scripts/media-scan.ts` CLI) it resolves to
 * an absolute filesystem path, which `fetch` rejects, so read it from
 * disk instead.
 */
export function compileWasmUrl(url: string): Promise<WebAssembly.Module> {
	const proc = (globalThis as { process?: { versions?: Record<string, string> } }).process;
	if (url.startsWith('/') && (proc?.versions?.bun || proc?.versions?.node) && typeof document === 'undefined') {
		const fs = 'node:fs/promises';
		return import(/* @vite-ignore */ fs).then((m: { readFile(p: string): Promise<Uint8Array> }) => m.readFile(url)).then((b) => WebAssembly.compile(b as BufferSource));
	}
	return typeof WebAssembly.compileStreaming === 'function'
		? WebAssembly.compileStreaming(fetch(url))
		: fetch(url)
				.then((r) => r.arrayBuffer())
				.then((b) => WebAssembly.compile(b));
}
