/**
 * Identify a magic-less Trinity FlatBuffer by structure, and list the
 * file names it references (archives such as GFPAK store only name
 * hashes, so these names are what recovers them).
 */

import { FlatBuffer, type Table } from '@tootallnate/gfbmdl';

import { parseTrmdl, parseTrmmt, parseTrmsh, parseTrmtr } from './model.js';

export type TrinityKind = 'trmdl' | 'trmsh' | 'trmbf' | 'trmtr' | 'trskl' | 'trmmt';

const ok = (f: () => boolean): boolean => {
	try {
		return f();
	} catch {
		return false;
	}
};

const endsWith = (s: string | null, ext: string) => !!s && s.toLowerCase().endsWith(ext);

export function sniffTrinity(bytes: Uint8Array): TrinityKind | null {
	if (bytes.length < 16) return null;
	let t: Table;
	try {
		t = new FlatBuffer(bytes).root();
		if (!t.isSane()) return null;
	} catch {
		return null;
	}
	if (ok(() => t.tables(1).length > 0 && t.tables(1).every((r) => endsWith(r.str(0), '.trmsh')))) return 'trmdl';
	if (ok(() => endsWith(t.str(2), '.trmbf') && t.tables(1).length > 0)) return 'trmsh';
	if (
		ok(() => {
			const tables = t.tables(2);
			return (
				tables.length > 0 &&
				tables.every((m) => m.str(0) !== null && m.strings(1).every((f) => endsWith(f, '.trmtr'))) &&
				tables.some((m) => m.strings(1).length > 0)
			);
		})
	) {
		return 'trmmt';
	}
	if (
		ok(() => {
			const m = t.tables(1);
			return (
				m.length > 0 &&
				m.every((p) => !!p.str(0) && p.tables(2).every((x) => endsWith(x.str(1), '.bntx'))) &&
				m.some((p) => p.tables(2).length > 0)
			);
		})
	) {
		return 'trmtr';
	}
	// After materials: a material pass's shader name also reads as a byte vector.
	if (
		ok(() => {
			const b = t.tables(1);
			return b.length > 0 && t.slotCount <= 2 && b.every((x) => x.tables(1).length > 0 && x.tables(1).every((v) => (v.bytes(0)?.length ?? 0) > 0));
		})
	) {
		return 'trmbf';
	}
	if (
		ok(() => {
			const nodes = t.tables(1);
			return nodes.length > 0 && t.vectorLength(2) <= nodes.length && nodes.every((n) => n.str(0) !== null && n.table(1) !== null);
		})
	) {
		return 'trskl';
	}
	return null;
}

/** File names a Trinity file refers to (its siblings in the model folder). */
export function trinityReferencedNames(kind: TrinityKind, bytes: Uint8Array): string[] {
	try {
		switch (kind) {
			case 'trmdl': {
				const m = parseTrmdl(bytes);
				const out = [...m.meshes, ...m.materials];
				if (m.skeleton) out.push(m.skeleton);
				for (const mat of m.materials) {
					const stem = mat.replace(/\.trmtr$/i, '');
					out.push(`${stem}_rare.trmtr`, `${stem}.trmmt`);
				}
				for (const mesh of m.meshes) {
					out.push(mesh.replace(/\.trmsh$/i, '.trmbf'));
					// The model itself is usually named after its LOD 0 mesh.
					out.push(mesh.replace(/(_lod\d+)?\.trmsh$/i, '.trmdl'));
				}
				return out;
			}
			case 'trmsh':
				return [parseTrmsh(bytes).bufferFile].filter(Boolean);
			case 'trmmt':
				return parseTrmmt(bytes).tables.flatMap((t) => t.files);
			case 'trmtr':
				return [...new Set(parseTrmtr(bytes).materials.flatMap((m) => m.textures.map((x) => x.file)))];
			default:
				return [];
		}
	} catch {
		return [];
	}
}
