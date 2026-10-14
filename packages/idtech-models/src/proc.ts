/**
 * DOOM 3 BFG `.bproc`: a map's compiled render world
 * (`idRenderWorldLocal::InitFromMap` in `renderer/RenderWorld_load.cpp`,
 * id's GPL DOOM-3-BFG release).
 *
 *   u32 'PRO' 1, i32 entry count (big-endian), map name (string),
 *   i64 timestamp, then entries, each a type string:
 *   - `model` / `shadowmodel`: name (string) + a `BRMl` static model.
 *     The world's areas are `_area0` … `_areaN`; brush entities are
 *     inline models (`_inlinemodel…`).
 *   - `interAreaPortals`: area count, portal count, then per portal a
 *     point count, the two areas and the winding points (skipped).
 *   - `nodes`: count, then a plane (4 floats) and two children each
 *     (skipped).
 *
 *   Entry order varies: Switch files put the shadow models and portals
 *   before the area models.
 */
import { readStatic, type IdStaticModel } from './model.js';
import { Reader } from './reader.js';

export const BPROC_MAGIC = 0x50524f01;

export interface IdProc {
	mapName: string;
	/** Render models in file order (shadow models skipped). */
	models: (IdStaticModel & { entryName: string })[];
}

export function isBproc(head: Uint8Array): boolean {
	return head.length >= 4 && head[0] === 0x50 && head[1] === 0x52 && head[2] === 0x4f && head[3] === 0x01;
}

export function parseBproc(bytes: Uint8Array): IdProc {
	const r = new Reader(bytes);
	if (r.u32be() !== BPROC_MAGIC) throw new Error('Not a BFG binary proc (missing "PRO\\x01")');
	const numEntries = r.i32be();
	const mapName = r.string();
	r.time64be();
	const models: IdProc['models'] = [];
	let wide = false;
	for (let i = 0; i < numEntries; i++) {
		const type = r.string().toLowerCase();
		if (type === 'interareaportals') {
			r.i32be(); // numPortalAreas
			const portals = r.i32be();
			for (let p = 0; p < portals; p++) {
				const points = r.i32be();
				r.skip(8 + points * 12);
			}
			continue;
		}
		if (type === 'nodes') {
			r.skip(r.i32be() * 24);
			continue;
		}
		if (type !== 'model' && type !== 'shadowmodel') break;
		const entryName = r.string();
		const at = r.pos;
		let m: IdStaticModel;
		try {
			m = readStatic(r, wide);
		} catch (e) {
			if (wide) throw e;
			// Retry the model with 32-bit indices.
			r.pos = at;
			wide = true;
			m = readStatic(r, wide);
		}
		models.push({ ...m, entryName });
	}
	return { mapName, models };
}
