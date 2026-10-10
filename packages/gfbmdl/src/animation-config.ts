/**
 * GFBANMCFG — a model's animation state table. We only need the
 * `Animations` list (slot 6), which maps a state name to the file it
 * plays: `{ Name: "ba01_jump01", File: "pm0025_00_ba01_jump01.gfbanm" }`.
 * That gives friendly clip names and lets archive browsers recover the
 * file names of hash-named GFPAK entries.
 */

import { FlatBuffer } from './flatbuffers.js';

export interface GfbanmcfgAnimationRef {
	name: string;
	file: string;
}

export interface GfbanmcfgConfig {
	animations: GfbanmcfgAnimationRef[];
}

export function parseGfbanmcfg(bytes: Uint8Array): GfbanmcfgConfig {
	if (bytes.length < 8) throw new Error('Buffer too small to be a GFBANMCFG');
	const r = new FlatBuffer(bytes).root();
	if (!r.isSane()) throw new Error('Not a GFBANMCFG (invalid FlatBuffers root table)');
	const animations = (r.table(6)?.tables(0) ?? []).map((a) => ({
		name: a.str(0) ?? '',
		file: a.str(1) ?? '',
	}));
	return { animations };
}
