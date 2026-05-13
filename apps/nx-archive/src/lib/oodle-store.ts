/**
 * Storage + lazy-loader for the user-supplied `oodle.wasm` blob.
 *
 * Oodle Data Compression's source is governed by the Unreal Engine
 * EULA and can't be redistributed with this project. Users build
 * their own `oodle.wasm` via `@tootallnate/oodle-wasm` and upload it
 * through the app's settings sheet; the bytes are then stored in
 * IndexedDB (localStorage's string-based 5MB limit makes it a poor
 * fit for a 200KB-ish binary blob).
 *
 * We expose:
 *
 *   - `loadStoredOodleWasm()` — returns the cached bytes, fetching
 *     from IDB on first call. Returns null when no WASM is stored.
 *   - `setStoredOodleWasm(bytes)` — persists the bytes and resets
 *     the in-memory caches so the next `getOodleDecompressor()` call
 *     re-instantiates against the new bytes.
 *   - `getOodleDecompressor()` — returns a synchronous-looking
 *     `OodleDecompress` function backed by the cached
 *     `OodleDecoder` instance. Returns null when no WASM is stored.
 */

import { OodleDecoder } from '@tootallnate/oodle-wasm';

import type { OodleDecompress } from './archive.js';

const DB_NAME = 'nx-archive';
const DB_VERSION = 1;
const STORE = 'oodle';
const KEY = 'oodle.wasm';

// Module-level caches.
let cachedBytes: Uint8Array | null = null;
let cachedBytesLoaded = false;
let decoderPromise: Promise<OodleDecoder> | null = null;
let decompressorWrapper: OodleDecompress | null = null;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function readFromDb(): Promise<Uint8Array | null> {
	let db: IDBDatabase;
	try {
		db = await openDb();
	} catch {
		return null;
	}
	return new Promise<Uint8Array | null>((resolve) => {
		const tx = db.transaction(STORE, 'readonly');
		const req = tx.objectStore(STORE).get(KEY);
		req.onsuccess = () => {
			const v = req.result;
			if (v instanceof Uint8Array) resolve(v);
			else if (v instanceof ArrayBuffer) resolve(new Uint8Array(v));
			else resolve(null);
		};
		req.onerror = () => resolve(null);
		tx.oncomplete = () => db.close();
		tx.onabort = () => db.close();
	});
}

async function writeToDb(bytes: Uint8Array | null): Promise<void> {
	let db: IDBDatabase;
	try {
		db = await openDb();
	} catch {
		return;
	}
	return new Promise<void>((resolve) => {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		if (bytes === null) store.delete(KEY);
		else store.put(bytes, KEY);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			resolve();
		};
		tx.onabort = () => {
			db.close();
			resolve();
		};
	});
}

/** Load any previously-stored WASM bytes from IndexedDB. */
export async function loadStoredOodleWasm(): Promise<Uint8Array | null> {
	if (cachedBytesLoaded) return cachedBytes;
	cachedBytes = await readFromDb();
	cachedBytesLoaded = true;
	return cachedBytes;
}

/**
 * Replace the stored WASM bytes (or clear them if `bytes === null`)
 * and reset all derived caches so the next decompressor call uses
 * the new blob.
 */
export async function setStoredOodleWasm(bytes: Uint8Array | null): Promise<void> {
	cachedBytes = bytes;
	cachedBytesLoaded = true;
	// Dispose any decoder we built against the old bytes.
	if (decoderPromise) {
		decoderPromise.then((dec) => dec.dispose()).catch(() => {});
		decoderPromise = null;
	}
	decompressorWrapper = null;
	await writeToDb(bytes);
}

/**
 * Returns a decompressor backed by the stored WASM blob, or null
 * if no blob is stored. The decoder is instantiated lazily on
 * first use and cached for the lifetime of the page (the WASM
 * compile + instantiate is ~50ms cold; we don't want to pay it
 * once per PAK block).
 */
export function getOodleDecompressor(): OodleDecompress | null {
	if (!cachedBytesLoaded) {
		// Caller didn't await loadStoredOodleWasm() at boot — surface
		// nothing for now; loadStoredOodleWasm will trigger a re-eval
		// when it completes.
		return null;
	}
	if (!cachedBytes) return null;
	if (decompressorWrapper) return decompressorWrapper;
	const bytes = cachedBytes;
	// Wrap the async decoder creation into a serialised decode-fn.
	// `decoder.decompress` is synchronous but we expose an async
	// signature so first-call WASM compilation can complete before
	// any blocks come through.
	let pending: Promise<OodleDecoder> | null = null;
	const getDecoder = (): Promise<OodleDecoder> => {
		if (decoderPromise) return decoderPromise;
		if (!pending) pending = OodleDecoder.create(bytes);
		decoderPromise = pending;
		return decoderPromise;
	};
	decompressorWrapper = async (compressed, uncompressedSize) => {
		const dec = await getDecoder();
		return dec.decompress(compressed, uncompressedSize);
	};
	return decompressorWrapper;
}
