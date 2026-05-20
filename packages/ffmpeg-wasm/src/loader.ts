/**
 * WASM Dynamic Linking — extension loader.
 *
 * Loads `wasm32-wasip1` shared-library (`.so`) extensions compiled
 * against the base `ffmpeg.wasm`. Extensions can call libav
 * functions directly through dynamic linking: they share linear
 * memory + the indirect function table with the main module, and
 * their `env.*` imports resolve against the main module's exports.
 *
 * The base WASM is built with `--mexec-model=reactor` +
 * `--export=__indirect_function_table` + `--export=__stack_pointer`
 * (see `Makefile`). Extensions are built with `--shared` so they
 * carry a `dylink.0` custom section describing memory + table
 * requirements.
 *
 * Adapted from quickjs-wasi's `extensions.ts`. The dynamic-linking
 * machinery is generic — only the per-extension init-function
 * name differs.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Description of an extension to load. */
export interface ExtensionDescriptor {
	/**
	 * Display name (used in errors). The convention is the lower-
	 * case codec name (e.g. `"bink2"`).
	 */
	name: string;
	/** WASM bytes or pre-compiled module. */
	wasm: BufferSource | WebAssembly.Module;
}

/** Metadata about a loaded extension. */
export interface LoadedExtension {
	name: string;
	module: WebAssembly.Module;
	instance: WebAssembly.Instance;
	dylink: DylinkInfo;
	memoryBase: number;
	tableBase: number;
	/** Codec pointers the extension provided (already registered with base). */
	codecs: number[];
	/** Demuxer pointers the extension provided (already registered with base). */
	demuxers: number[];
}

/** Parsed `dylink.0` custom section. */
export interface DylinkInfo {
	memorySize: number;
	memoryAlignment: number;
	tableSize: number;
	tableAlignment: number;
}

// ---------------------------------------------------------------------------
// dylink.0 parser (WebAssembly tool-conventions §dylink.0)
// ---------------------------------------------------------------------------

/** WASM section subtype for memory-info inside `dylink.0`. */
const WASM_DYLINK_MEM_INFO = 1;

/** Read a ULEB128 from a byte buffer at `state.offset`, advance. */
function readULEB128(bytes: Uint8Array, state: { offset: number }): number {
	let result = 0;
	let shift = 0;
	while (true) {
		const b = bytes[state.offset++]!;
		result |= (b & 0x7f) << shift;
		if ((b & 0x80) === 0) break;
		shift += 7;
	}
	return result >>> 0;
}

/**
 * Parse the `dylink.0` custom section of a WASM module if
 * present. Returns null when the module isn't a shared library.
 */
function parseDylink(module: WebAssembly.Module): DylinkInfo | null {
	const sections = WebAssembly.Module.customSections(module, 'dylink.0');
	if (sections.length === 0) return null;
	const bytes = new Uint8Array(sections[0]!);
	const state = { offset: 0 };
	const info: DylinkInfo = {
		memorySize: 0,
		memoryAlignment: 0,
		tableSize: 0,
		tableAlignment: 0,
	};
	while (state.offset < bytes.length) {
		const subId = bytes[state.offset++]!;
		const subSize = readULEB128(bytes, state);
		const subEnd = state.offset + subSize;
		if (subId === WASM_DYLINK_MEM_INFO) {
			info.memorySize = readULEB128(bytes, state);
			info.memoryAlignment = readULEB128(bytes, state);
			info.tableSize = readULEB128(bytes, state);
			info.tableAlignment = readULEB128(bytes, state);
		}
		state.offset = subEnd;
	}
	return info;
}

// ---------------------------------------------------------------------------
// Extension loader
// ---------------------------------------------------------------------------

/**
 * Instantiate an extension and link it against the main module's
 * exports. Returns the loaded-extension record (including the
 * extension's `WebAssembly.Instance`, from which the host can pull
 * the codec-pointer accessor via `instance.exports.ffmpeg_ext_<name>_codec()`).
 *
 * `mainExports` is the main module's `instance.exports`. We need:
 *   - `memory`
 *   - `__indirect_function_table`
 *   - `__stack_pointer`
 *   - `malloc` (to allocate the extension's static-data region)
 *   - All the libav functions the extension imports
 */
export async function loadExtension(
	descriptor: ExtensionDescriptor,
	mainExports: WebAssembly.Exports,
): Promise<LoadedExtension> {
	// Compile.
	const module =
		descriptor.wasm instanceof WebAssembly.Module
			? descriptor.wasm
			: await WebAssembly.compile(descriptor.wasm);

	// Parse dylink.0.
	const dylink = parseDylink(module);
	if (!dylink) {
		throw new Error(
			`Extension "${descriptor.name}" is not a WASM shared library (missing dylink.0 custom section)`,
		);
	}

	const memory = mainExports.memory as WebAssembly.Memory;
	const table = mainExports.__indirect_function_table as WebAssembly.Table;
	const stackPointer = mainExports.__stack_pointer as WebAssembly.Global;
	const malloc = mainExports.malloc as (n: number) => number;
	if (!memory)
		throw new Error(
			`Main module is missing 'memory' export (required for extension loading)`,
		);
	if (!table)
		throw new Error(
			`Main module is missing '__indirect_function_table' export`,
		);
	if (!stackPointer)
		throw new Error(`Main module is missing '__stack_pointer' export`);
	if (typeof malloc !== 'function')
		throw new Error(`Main module is missing 'malloc' export`);

	// Allocate memory for the extension's static data inside the
	// main module's heap (so the extension can free / mutate it
	// using the same allocator).
	let memoryBase = 0;
	if (dylink.memorySize > 0) {
		memoryBase = malloc(dylink.memorySize);
		if (!memoryBase) {
			throw new Error(
				`Extension "${descriptor.name}": malloc(${dylink.memorySize}) for static data failed`,
			);
		}
		// Zero-init.
		new Uint8Array(memory.buffer, memoryBase, dylink.memorySize).fill(0);
	}

	// Grow the function table.
	const tableBase = table.length;
	if (dylink.tableSize > 0) {
		table.grow(dylink.tableSize);
	}

	// Build the import object. The extension imports its data /
	// code bases as globals; its libav function imports resolve
	// against `mainExports`.
	const imports = WebAssembly.Module.imports(module);
	const env: Record<string, WebAssembly.ImportValue> = {
		memory,
		__indirect_function_table: table,
		__memory_base: new WebAssembly.Global(
			{ value: 'i32', mutable: false },
			memoryBase,
		),
		__table_base: new WebAssembly.Global(
			{ value: 'i32', mutable: false },
			tableBase,
		),
		__stack_pointer: stackPointer,
	};

	const missing: string[] = [];
	for (const imp of imports) {
		if (imp.module !== 'env') continue;
		if (imp.name in env) continue; // already set above
		const resolved = mainExports[imp.name];
		if (resolved === undefined) {
			missing.push(imp.name);
			continue;
		}
		env[imp.name] = resolved as WebAssembly.ImportValue;
	}
	if (missing.length > 0) {
		throw new Error(
			`Extension "${descriptor.name}" imports unresolved symbol(s): ${missing.join(', ')}.\n` +
				`Add them to the base WASM via -Wl,--export=<symbol> in ffmpeg-wasm/Makefile and reference them in c/exports.c.`,
		);
	}

	// Instantiate. The extension may also have GOT.mem / GOT.func
	// imports for symbols that should be looked up by-name at
	// runtime; we satisfy those with mutable globals for now —
	// they get patched by `__wasm_apply_data_relocs` post-init.
	const got: Record<string, WebAssembly.Global> = {};
	for (const imp of imports) {
		if (imp.module === 'GOT.mem' || imp.module === 'GOT.func') {
			got[imp.name] = new WebAssembly.Global(
				{ value: 'i32', mutable: true },
				0,
			);
		}
	}

	const instance = await WebAssembly.instantiate(module, {
		env,
		'GOT.mem': got,
		'GOT.func': got,
	});

	// Apply data relocations + run static initialisers.
	const applyRelocs = instance.exports.__wasm_apply_data_relocs as
		| (() => void)
		| undefined;
	if (applyRelocs) applyRelocs();
	const callCtors = instance.exports.__wasm_call_ctors as
		| (() => void)
		| undefined;
	if (callCtors) callCtors();

	// Auto-register codecs and demuxers the extension advertises.
	// Convention: an extension exports zero or more `ffmpeg_ext_*_codec`
	// and `ffmpeg_ext_*_demuxer` symbols (plus optional `_codec_1`,
	// `_codec_2`, ... for multi-codec extensions like bink-audio
	// which carries both DCT and RDFT variants). Each accessor
	// returns the address of an FFCodec / AVInputFormat inside the
	// extension's static data; the base ffmpeg_register_*() store
	// the pointer in g_codecs[] / g_demuxers[].
	const registerCodec = mainExports.ffmpeg_register_codec as
		| ((ptr: number) => number)
		| undefined;
	const registerDemuxer = mainExports.ffmpeg_register_demuxer as
		| ((ptr: number) => number)
		| undefined;
	if (typeof registerCodec !== 'function')
		throw new Error(`Main module is missing 'ffmpeg_register_codec' export`);
	if (typeof registerDemuxer !== 'function')
		throw new Error(`Main module is missing 'ffmpeg_register_demuxer' export`);

	const codecs: number[] = [];
	const demuxers: number[] = [];
	for (const exportName of Object.keys(instance.exports)) {
		const fn = instance.exports[exportName];
		if (typeof fn !== 'function') continue;
		if (/^ffmpeg_ext_[A-Za-z0-9_]+_codec(_\d+)?$/.test(exportName)) {
			const ptr = (fn as () => number)();
			if (!ptr) continue;
			if (registerCodec(ptr) < 0) {
				throw new Error(
					`Extension "${descriptor.name}": ffmpeg_register_codec() failed for ${exportName} (registry full?)`,
				);
			}
			codecs.push(ptr);
		} else if (/^ffmpeg_ext_[A-Za-z0-9_]+_demuxer(_\d+)?$/.test(exportName)) {
			const ptr = (fn as () => number)();
			if (!ptr) continue;
			if (registerDemuxer(ptr) < 0) {
				throw new Error(
					`Extension "${descriptor.name}": ffmpeg_register_demuxer() failed for ${exportName} (registry full?)`,
				);
			}
			demuxers.push(ptr);
		}
	}

	return {
		name: descriptor.name,
		module,
		instance,
		dylink,
		memoryBase,
		tableBase,
		codecs,
		demuxers,
	};
}
