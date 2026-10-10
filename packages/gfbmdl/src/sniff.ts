/**
 * Identify a magic-less GFLX FlatBuffer (as found unnamed inside a
 * GFPAK) by its root-table shape:
 *
 *  - **gfbmdl**: 9–11 slots, bounding box present, and mesh 0's vertex
 *    layout decodes (Position first, known formats, data length a
 *    multiple of the stride).
 *  - **gfbanm**: 1–5 slots (vtable trimmed after the last present
 *    field) with a small Config table whose FPS is 1–120.
 *  - **gfbanmcfg**: exactly 7 slots, and slot 6's animation list
 *    references `*.gfbanm` files.
 *
 * Verified across every FlatBuffers entry of Pokémon: Let's Go,
 * Pikachu!'s 643 GFPAKs (794 / 7476 / 1233 hits respectively, with no
 * false positives).
 */

import { FlatBuffer, type Table } from './flatbuffers.js';
import { BUFFER_FORMAT_SIZE } from './model.js';

export type GflxKind = 'gfbmdl' | 'gfbanm' | 'gfbanmcfg';

export function sniffGflx(bytes: Uint8Array): GflxKind | null {
	try {
		if (bytes.length < 16) return null;
		const fb = new FlatBuffer(bytes);
		const rootPos = fb.view.getUint32(0, true);
		if (rootPos < 4 || rootPos + 4 > bytes.length) return null;
		const r = fb.root();
		if (!r.isSane()) return null;
		const sane = (t: Table | null): t is Table => t !== null && t.pos > 0 && t.pos < bytes.length && t.isSane();

		if (r.slotCount >= 9 && r.slotCount <= 11 && r.has(1)) {
			const meshes = r.vector(8);
			if (meshes && meshes.length > 0 && meshes.length < 100000) {
				const mesh0 = r.tables(8)[0];
				if (sane(mesh0)) {
					const attrs = mesh0.tables(1);
					const ok =
						attrs.length > 0 &&
						attrs.length < 16 &&
						attrs.every(
							(a) =>
								a.isSane() &&
								a.u32(0) <= 14 &&
								BUFFER_FORMAT_SIZE[a.u32(1)] !== undefined &&
								a.u32(2) >= 1 &&
								a.u32(2) <= 4,
						);
					if (ok && attrs[0].u32(0) === 0) {
						const stride = attrs.reduce((s, a) => s + BUFFER_FORMAT_SIZE[a.u32(1)] * a.u32(2), 0);
						const data = mesh0.vector(2);
						if (data && stride > 0 && data.length % stride === 0) return 'gfbmdl';
					}
				}
			}
		}

		if (r.slotCount >= 1 && r.slotCount <= 5 && r.has(0)) {
			const cfg = r.table(0);
			if (sane(cfg) && cfg.slotCount <= 3 && cfg.objectSize <= 16) {
				const fps = cfg.u32(2);
				if (fps > 0 && fps <= 120) return 'gfbanm';
			}
		}

		if (r.slotCount === 7 && r.has(6)) {
			const list = r.table(6);
			const refs = sane(list) ? list.tables(0) : [];
			if (refs.length && /\.gfbanm$/i.test(refs[0].str(1) ?? '')) return 'gfbanmcfg';
		}
	} catch {
		// fall through
	}
	return null;
}
