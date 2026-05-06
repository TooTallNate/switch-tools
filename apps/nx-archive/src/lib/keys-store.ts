/**
 * `prod.keys` storage + KeySet derivation for the browser.
 *
 * The raw keys text is persisted to `localStorage` so users only need
 * to supply it once per device. Derivation runs on demand and the
 * `KeySet` is cached in-memory.
 */

import { initializeKeySet, type KeySet } from '@tootallnate/nca';

const STORAGE_KEY = 'nx-archive:prod.keys';

let cached: { text: string; keySet: KeySet | null } | null = null;

export function getStoredKeysText(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

export function setStoredKeysText(text: string | null): void {
	try {
		if (text == null) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, text);
	} catch {
		/* localStorage may be disabled in private browsing */
	}
	// invalidate the in-memory cache
	cached = null;
}

/**
 * Validate that the supplied text contains the keys required for NCA
 * decryption. We only need `header_key` plus at least one
 * `key_area_key_application_*` entry to make progress.
 */
export function validateKeysText(text: string): {
	valid: boolean;
	missing: string[];
	count: number;
} {
	const missing: string[] = [];
	const required = ['header_key'];
	const lines = text.split(/\r?\n/);
	const found = new Set<string>();
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		found.add(line.slice(0, eq).trim().toLowerCase());
	}
	for (const req of required) {
		if (!found.has(req)) missing.push(req);
	}
	const hasAnyKak = Array.from(found).some((k) =>
		k.startsWith('key_area_key_application_'),
	);
	if (!hasAnyKak) missing.push('key_area_key_application_*');
	return { valid: missing.length === 0, missing, count: found.size };
}

export async function deriveKeySet(text: string): Promise<KeySet> {
	if (cached && cached.text === text && cached.keySet) return cached.keySet;
	const ks = await initializeKeySet(text);
	cached = { text, keySet: ks };
	return ks;
}

/**
 * Returns a previously-stored KeySet, deriving on first call.
 * Returns null if no keys are stored or derivation fails.
 */
export async function loadStoredKeySet(): Promise<{
	keySet: KeySet;
	text: string;
} | null> {
	const text = getStoredKeysText();
	if (!text) return null;
	try {
		const ks = await deriveKeySet(text);
		return { keySet: ks, text };
	} catch {
		return null;
	}
}
