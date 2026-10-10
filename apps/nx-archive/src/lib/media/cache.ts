/**
 * IndexedDB persistence for the media library, keyed by a content
 * fingerprint of the opened file, so reopening the same game shows its
 * library instantly instead of rescanning:
 *
 *  - `indexes`: the {@link MediaIndex} (items, gaps, stats).
 *  - `thumbs`: per-item thumbnails + facts learned while making them
 *    (durations, dimensions, triangle counts) or the failure message.
 *  - `kv`: archive-level caches for expensive container parses (e.g.
 *    GFPAK entry sniffing, which otherwise decompresses every entry).
 *
 * Everything degrades to a no-op when IndexedDB is unavailable
 * (private browsing, Bun/Node for the CLI).
 */

import type { MediaIndex, MediaInfo } from './types';

const DB_NAME = 'nx-archive-media';
const DB_VERSION = 1;
const STORES = ['indexes', 'thumbs', 'kv'] as const;
type Store = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		if (typeof indexedDB === 'undefined') return resolve(null);
		try {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return dbPromise;
}

async function tx<T>(store: Store, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
	const db = await openDb();
	if (!db) return undefined;
	return new Promise((resolve) => {
		try {
			const t = db.transaction(store, mode);
			const req = run(t.objectStore(store));
			t.oncomplete = () => resolve(req ? req.result : undefined);
			t.onerror = () => resolve(undefined);
			t.onabort = () => resolve(undefined);
		} catch {
			resolve(undefined);
		}
	});
}

const get = <T>(store: Store, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
const put = (store: Store, key: string, value: unknown) => tx(store, 'readwrite', (s) => void s.put(value, key));

// ---- file identity ----

async function sha256Hex(parts: ArrayBuffer[]): Promise<string> {
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const buf = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		buf.set(new Uint8Array(p), o);
		o += p.byteLength;
	}
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

const SAMPLE = 64 * 1024;

/**
 * Fingerprint of an opened file: name + size + a hash of its first and
 * last 64 KiB. Cheap (two small reads) and stable across sessions even
 * when `lastModified` changes on copy.
 */
export async function fileIdentity(file: Blob & { name?: string }): Promise<string> {
	const head = await file.slice(0, SAMPLE).arrayBuffer();
	const tail = file.size > SAMPLE ? await file.slice(Math.max(SAMPLE, file.size - SAMPLE)).arrayBuffer() : new ArrayBuffer(0);
	return `f:${file.name ?? ''}:${file.size}:${await sha256Hex([head, tail])}`;
}

/** Fingerprint of an opened directory: its name, file names and sizes. */
export async function directoryIdentity(name: string, files: { path: string; size: number }[]): Promise<string> {
	const listing = files
		.map((f) => `${f.path}\u0000${f.size}`)
		.sort()
		.join('\n');
	return `d:${name}:${await sha256Hex([new TextEncoder().encode(listing).buffer as ArrayBuffer])}`;
}

// ---- index ----

export function loadIndex(fileKey: string): Promise<MediaIndex | undefined> {
	return get<MediaIndex>('indexes', fileKey);
}

export async function saveIndex(fileKey: string, index: MediaIndex): Promise<void> {
	await put('indexes', fileKey, index);
}

// ---- thumbnails ----

export interface ThumbRecord {
	/** PNG thumbnail, absent when the item can't be thumbnailed. */
	blob?: Blob;
	info?: MediaInfo;
	error?: string;
	/** Thumbnail pipeline version — bump to regenerate. */
	v: number;
}

const thumbKey = (fileKey: string, itemId: string) => `${fileKey}\u0000${itemId}`;

export function loadThumb(fileKey: string, itemId: string): Promise<ThumbRecord | undefined> {
	return get<ThumbRecord>('thumbs', thumbKey(fileKey, itemId));
}

export async function saveThumb(fileKey: string, itemId: string, rec: ThumbRecord): Promise<void> {
	await put('thumbs', thumbKey(fileKey, itemId), rec);
}

// ---- archive caches ----

export interface PersistentCache {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
}

/** A key/value cache scoped to one opened file, for archive parsers. */
export function persistentCacheFor(fileKey: string): PersistentCache {
	return {
		get: <T>(key: string) => get<T>('kv', `${fileKey}\u0000${key}`),
		set: (key: string, value: unknown) => put('kv', `${fileKey}\u0000${key}`, value).then(() => undefined),
	};
}
