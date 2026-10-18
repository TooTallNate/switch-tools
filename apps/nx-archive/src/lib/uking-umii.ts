/**
 * Breath of the Wild "UMii" NPCs: Koroks (and Rito, Goron, … townsfolk)
 * that the engine assembles from parts and recolours per actor.
 *
 * A Korok's body colours come from a shader parameter animation,
 * `UMii_Korogu_Body_ColorChange_fcl` in `Model/UMii_Korogu_Body.sbfres`,
 * where frame *n* holds the `const_color0` / `const_color1` of skin colour
 * *n*. Which colour an actor uses is in its `Actor/UMii/*.bumii` (AAMP),
 * under `korog`: `mask` (the face, matching `Npc_Korogu_M_###`) and
 * `skin_color`, with `body.race` = 1 for Koroks. A prebuilt
 * `Npc_Korogu_M_###` model takes the skin colour most of the game's actors
 * with that mask use (Korok Forest's `Npc_kokiri###`, the hidden Koroks, …).
 */
import { crc32, parseAamp } from '@tootallnate/aamp';

import type { Node } from './archive';
import { romfsFileFor } from './title-romfs';

async function childrenOf(node: Node): Promise<Node[]> {
	if (node._children) return node._children;
	if (!node.getChildren) return [];
	const kids = await node.getChildren();
	node._children = kids;
	return kids;
}

const KOROG = crc32('korog');
const MASK = crc32('mask');
const SKIN = crc32('skin_color');
const BODY = crc32('body');
const RACE = crc32('race');
const RACE_KOROG = 1;

/** Actor packs that may hold Korok bumii files. */
const KOROK_ACTORS = /Korok|Korogu|kokiri/i;

/** mask → skin colour index, from every Korok actor's bumii. Cached per actor folder. */
const skinTables = new Map<string, Promise<Map<number, number>>>();

async function korokSkinTable(packDir: Node): Promise<Map<number, number>> {
	const votes = new Map<number, Map<number, number>>();
	for (const pack of await childrenOf(packDir)) {
		if (!KOROK_ACTORS.test(pack.name)) continue;
		// Straight to `Actor/UMii`, without opening the rest of the pack.
		const actor = (await childrenOf(pack).catch(() => [] as Node[])).find((k) => k.name === 'Actor');
		const umii = actor && (await childrenOf(actor).catch(() => [] as Node[])).find((k) => k.name === 'UMii');
		if (!umii) continue;
		{
			for (const k of await childrenOf(umii).catch(() => [] as Node[])) {
				if (k.name.endsWith('.bumii') && k.blob) {
					try {
						const p = parseAamp(new Uint8Array(await (await k.blob()).arrayBuffer()));
						const race = p.root.objects.find((o) => o.hash === BODY)?.params.find((x) => x.hash === RACE)?.value;
						const korog = p.root.objects.find((o) => o.hash === KOROG);
						const mask = korog?.params.find((x) => x.hash === MASK)?.value;
						const skin = korog?.params.find((x) => x.hash === SKIN)?.value;
						if (race === RACE_KOROG && typeof mask === 'number' && typeof skin === 'number') {
							const v = votes.get(mask) ?? new Map<number, number>();
							v.set(skin, (v.get(skin) ?? 0) + 1);
							votes.set(mask, v);
						}
					} catch {
						// Not a readable bumii; skip.
					}
				}
			}
		}
	}
	const table = new Map<number, number>();
	for (const [mask, v] of votes) table.set(mask, [...v].sort((a, b) => b[1] - a[1])[0]![0]);
	return table;
}

/**
 * The skin colour the game gives a prebuilt Korok model
 * (`Npc_Korogu_M_###`), or null when the model isn't one or no actor
 * uses its mask.
 */
export async function korokSkinColor(model: Node): Promise<number | null> {
	const m = /^Npc_Korogu_M_(\d+)\./i.exec(model.name);
	if (!m) return null;
	const packDir = await romfsFileFor(model.id, 'Actor/Pack').catch(() => null);
	if (!packDir) return null;
	let table = skinTables.get(packDir.id);
	if (!table) skinTables.set(packDir.id, (table = korokSkinTable(packDir)));
	return (await table).get(Number(m[1])) ?? null;
}
