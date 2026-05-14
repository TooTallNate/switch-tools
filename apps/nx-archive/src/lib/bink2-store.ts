/**
 * Storage + lazy-loader for the user-supplied `bink2.wasm` blob.
 *
 * The Bink 2 decoder source (`bbit-git/cnc-ra-libs`) is GPL-3.0
 * licensed, so the compiled WASM artifact is also GPL-3.0 and we
 * don't redistribute it with this MIT project. Users build their
 * own via `@tootallnate/bink2-wasm` and upload it through the app
 * header; the bytes are stored in IndexedDB (separately from the
 * Oodle blob — different format, different license, different
 * subsystem).
 *
 * Exports:
 *
 *   - `loadStoredBink2Wasm()` — return the cached bytes, fetching
 *     from IDB on first call. Returns null when nothing is stored.
 *   - `setStoredBink2Wasm(bytes)` — persist (or clear) the bytes.
 *   - `getBink2Wasm()` — synchronous accessor for code paths that
 *     just want the bytes (e.g. to feed `Bink2Decoder.create`).
 *
 * Each `Bink2Decoder` owns its own WebAssembly instance (and ~70 MB
 * of linear memory for the file copy), so we deliberately don't
 * cache a long-lived decoder here — callers create one per preview
 * and dispose it when the preview unmounts.
 */

const DB_NAME = 'nx-archive'
const DB_VERSION = 1
const STORE = 'bink2'
const KEY = 'bink2.wasm'

let cachedBytes: Uint8Array | null = null
let cachedBytesLoaded = false

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		// We share the `nx-archive` DB with oodle-store.ts but use a
		// separate object store. Both stores must be created in the
		// same upgrade transaction.
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains('oodle')) db.createObjectStore('oodle')
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

async function readFromDb(): Promise<Uint8Array | null> {
	let db: IDBDatabase
	try {
		db = await openDb()
	} catch {
		return null
	}
	return new Promise<Uint8Array | null>((resolve) => {
		// The store may not exist on first run if the DB was created
		// by an older version that only had `oodle`. We guard with
		// objectStoreNames here so we surface the typical "no stored
		// bytes" case rather than a NotFoundError.
		if (!db.objectStoreNames.contains(STORE)) {
			db.close()
			resolve(null)
			return
		}
		const tx = db.transaction(STORE, 'readonly')
		const req = tx.objectStore(STORE).get(KEY)
		req.onsuccess = () => {
			const v = req.result
			if (v instanceof Uint8Array) resolve(v)
			else if (v instanceof ArrayBuffer) resolve(new Uint8Array(v))
			else resolve(null)
		}
		req.onerror = () => resolve(null)
		tx.oncomplete = () => db.close()
		tx.onabort = () => db.close()
	})
}

async function writeToDb(bytes: Uint8Array | null): Promise<void> {
	let db: IDBDatabase
	try {
		db = await openDb()
	} catch {
		return
	}
	return new Promise<void>((resolve) => {
		if (!db.objectStoreNames.contains(STORE)) {
			db.close()
			resolve()
			return
		}
		const tx = db.transaction(STORE, 'readwrite')
		const store = tx.objectStore(STORE)
		if (bytes === null) store.delete(KEY)
		else store.put(bytes, KEY)
		tx.oncomplete = () => {
			db.close()
			resolve()
		}
		tx.onerror = () => {
			db.close()
			resolve()
		}
		tx.onabort = () => {
			db.close()
			resolve()
		}
	})
}

/** Load any previously-stored WASM bytes from IndexedDB. */
export async function loadStoredBink2Wasm(): Promise<Uint8Array | null> {
	if (cachedBytesLoaded) return cachedBytes
	cachedBytes = await readFromDb()
	cachedBytesLoaded = true
	return cachedBytes
}

/** Replace (or clear) the stored WASM bytes. */
export async function setStoredBink2Wasm(bytes: Uint8Array | null): Promise<void> {
	cachedBytes = bytes
	cachedBytesLoaded = true
	await writeToDb(bytes)
}

/** Synchronous accessor — returns the cached bytes or null if not yet loaded. */
export function getBink2Wasm(): Uint8Array | null {
	return cachedBytesLoaded ? cachedBytes : null
}
