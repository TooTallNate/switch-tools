/**
 * Trinity animation companions. A Legends: Arceus clip is a pair of
 * files sharing a stem (`pm0094_00_00_00000_defaultwait01_loop`):
 *
 *   .tranm  bone tracks — a GFBANM clip (parse with
 *           `parseGfbanm` from `@tootallnate/gfbmdl`)
 *   .tracm  per mesh shape: visibility (and material curves)
 *
 * Visibility matters for models that ship alternative meshes: Gengar
 * has both `normaltongue` and `longtongue` shapes, and all but its
 * tongue attacks hide the long one.
 *
 * Schema: pkZukan/PokeDocs `LA/Flatbuffers/Animation/tracm.fbs`.
 */

import { FlatBuffer } from '@tootallnate/gfbmdl';

export interface TracmClip {
	/** Clip length in frames. */
	frameCount: number;
	fps: number;
	/** Mesh shape name → visible, for shapes with a visibility track. */
	visibility: Map<string, boolean>;
}

export function parseTracm(bytes: Uint8Array): TracmClip {
	const t = new FlatBuffer(bytes).root();
	if (!t.isSane()) throw new Error('Not a FlatBuffer');
	const config = t.table(0);
	const visibility = new Map<string, boolean>();
	for (const track of t.tables(1)) {
		const path = track.str(0);
		// material_flags → info → union { type (u8), TrackFlag_Bool { value } }.
		const info = track.table(5)?.table(2);
		if (!path || !info || info.u8(0) === 0) continue;
		visibility.set(path, info.table(1)?.bool(0, false) ?? false);
	}
	return { frameCount: config?.u32(1) ?? 0, fps: config?.u32(2) ?? 0, visibility };
}
