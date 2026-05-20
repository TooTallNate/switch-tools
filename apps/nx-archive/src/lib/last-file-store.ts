/**
 * Persist the most-recently-opened file across page reloads.
 *
 * We use two strategies, layered:
 *
 *   1. **Static `<form>`/`<input>` in `index.html`** — handles
 *      Firefox's built-in file-input restoration. The browser
 *      restores the previously-selected file's `File` object on
 *      hard reload as long as the input lives in a named form
 *      that exists at DOM-parse time. (Chrome and Safari refuse
 *      this for security reasons, so it's a Firefox-only path.)
 *
 *   2. **`FileSystemFileHandle` in IndexedDB** (this module) —
 *      Chromium-only. When the user opens a file via
 *      `showOpenFilePicker()`, the returned handle is
 *      structured-cloneable and can be stashed in IDB; on
 *      reload we read it back, call `queryPermission`/
 *      `requestPermission` to revalidate access, and call
 *      `.getFile()` to obtain a fresh `File` object pointing at
 *      the same path. If the file moved or the permission was
 *      revoked, we surface the error and clear the stored
 *      handle so the user can re-pick.
 *
 * Firefox + Safari don't implement the File System Access API,
 * so on those browsers this module's accessors return `null`
 * and `isFileSystemAccessApiSupported()` returns `false`; the
 * UI silently falls back to the form-restoration path (Firefox)
 * or the user re-picks (Safari).
 */

const DB_NAME = 'nx-archive';
const DB_VERSION = 2;
const STORE = 'last-file-handle';
const KEY = 'main';

interface StoredHandle {
	/** The original `FileSystemFileHandle` from `showOpenFilePicker`. */
	handle: FileSystemFileHandle;
	/** Display name captured at pick time (in case `.getFile()` later fails). */
	name: string;
	/** File size captured at pick time, for the UI badge. */
	size: number;
	/** When the handle was last saved (ms since epoch). */
	savedAt: number;
}

/**
 * True iff the browser exposes `showOpenFilePicker` and
 * `FileSystemFileHandle.queryPermission`. Both are required for
 * the IDB-persist path; missing either means we fall back to
 * the static `<input>` form trick.
 */
export function isFileSystemAccessApiSupported(): boolean {
	if (typeof window === 'undefined') return false;
	const w = window as unknown as {
		showOpenFilePicker?: unknown;
		FileSystemFileHandle?: { prototype?: { queryPermission?: unknown } };
	};
	return (
		typeof w.showOpenFilePicker === 'function' &&
		typeof w.FileSystemFileHandle?.prototype?.queryPermission === 'function'
	);
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		// We share the `nx-archive` DB with oodle-store.ts and
		// bink2-store.ts; the upgrade transaction must create any
		// store that doesn't yet exist (existing users coming
		// from v1 will only have `oodle` + `bink2`; fresh installs
		// need all three).
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('oodle')) db.createObjectStore('oodle');
			if (!db.objectStoreNames.contains('bink2')) db.createObjectStore('bink2');
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Open `showOpenFilePicker()` and return the picked file +
 * handle, with the handle automatically persisted for next
 * reload. Throws `AbortError` if the user cancels.
 */
export async function pickFileWithHandle(): Promise<{
	file: File;
	handle: FileSystemFileHandle;
} | null> {
	if (!isFileSystemAccessApiSupported()) return null;
	const w = window as unknown as {
		showOpenFilePicker: (options?: {
			multiple?: boolean;
		}) => Promise<FileSystemFileHandle[]>;
	};
	const [handle] = await w.showOpenFilePicker({ multiple: false });
	if (!handle) return null;
	const file = await handle.getFile();
	await saveHandle(handle, file);
	return { file, handle };
}

/** Persist a `FileSystemFileHandle` for next-reload restoration. */
export async function saveHandle(
	handle: FileSystemFileHandle,
	file: File,
): Promise<void> {
	let db: IDBDatabase;
	try {
		db = await openDb();
	} catch {
		return;
	}
	return new Promise<void>((resolve) => {
		if (!db.objectStoreNames.contains(STORE)) {
			db.close();
			resolve();
			return;
		}
		const record: StoredHandle = {
			handle,
			name: file.name,
			size: file.size,
			savedAt: Date.now(),
		};
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put(record, KEY);
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

/** Drop the stored handle (called when the user closes the file). */
export async function clearHandle(): Promise<void> {
	let db: IDBDatabase;
	try {
		db = await openDb();
	} catch {
		return;
	}
	return new Promise<void>((resolve) => {
		if (!db.objectStoreNames.contains(STORE)) {
			db.close();
			resolve();
			return;
		}
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(KEY);
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

/**
 * Load the stored handle (if any). Returns null when nothing is
 * stored or when the API is unavailable.
 */
export async function loadStoredHandle(): Promise<StoredHandle | null> {
	if (!isFileSystemAccessApiSupported()) return null;
	let db: IDBDatabase;
	try {
		db = await openDb();
	} catch {
		return null;
	}
	return new Promise<StoredHandle | null>((resolve) => {
		if (!db.objectStoreNames.contains(STORE)) {
			db.close();
			resolve(null);
			return;
		}
		const tx = db.transaction(STORE, 'readonly');
		const req = tx.objectStore(STORE).get(KEY);
		req.onsuccess = () => {
			const v = req.result as StoredHandle | undefined;
			resolve(v && v.handle ? v : null);
		};
		req.onerror = () => resolve(null);
		tx.oncomplete = () => db.close();
		tx.onabort = () => db.close();
	});
}

/**
 * Status of a stored handle's read-permission grant.
 *
 *   - `'granted'`  — can immediately call `.getFile()` without
 *                    prompting the user.
 *   - `'prompt'`   — needs a user-initiated `requestPermission()`
 *                    call (most common on reload — Chrome resets
 *                    File System Access grants between sessions).
 *   - `'denied'`   — the user previously refused; we should clear
 *                    the stored handle.
 */
export type HandlePermissionState = 'granted' | 'prompt' | 'denied';

/**
 * Check the current permission state for a stored handle WITHOUT
 * prompting. The user must invoke a click handler that calls
 * {@link requestHandlePermission} to upgrade `'prompt'` →
 * `'granted'`.
 */
export async function queryHandlePermission(
	handle: FileSystemFileHandle,
): Promise<HandlePermissionState> {
	const h = handle as unknown as {
		queryPermission: (opts: {
			mode: 'read';
		}) => Promise<HandlePermissionState>;
	};
	try {
		return await h.queryPermission({ mode: 'read' });
	} catch {
		return 'denied';
	}
}

/**
 * Request read permission for the stored handle. MUST be called
 * from a user-gesture event handler (click, keyup, etc.) or the
 * browser will reject with `SecurityError`.
 */
export async function requestHandlePermission(
	handle: FileSystemFileHandle,
): Promise<HandlePermissionState> {
	const h = handle as unknown as {
		requestPermission: (opts: {
			mode: 'read';
		}) => Promise<HandlePermissionState>;
	};
	try {
		return await h.requestPermission({ mode: 'read' });
	} catch {
		return 'denied';
	}
}

/**
 * Resolve a stored handle to a fresh `File` object. Throws if
 * the user revoked permission or the underlying file was moved /
 * deleted.
 */
export async function getFileFromHandle(
	handle: FileSystemFileHandle,
): Promise<File> {
	return handle.getFile();
}
