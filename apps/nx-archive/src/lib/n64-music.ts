/**
 * N64 sequenced music (Super Mario 64 / Mario Kart 64 audio library) as a
 * `music/` folder of WAVs rendered on demand by `@tootallnate/n64-seq`:
 * the M64 sequence played through the game's own instrument banks (one
 * pass of the loop, then a fade). Sequence 0 is the sound-effect player
 * and is skipped.
 */

import { SeqBankCache, renderSeqWav, type SeqLibrary } from '@tootallnate/n64-seq';
import type { Node } from './archive';

export function makeN64MusicDir(id: string, rom: Uint8Array, lib: SeqLibrary, names?: readonly string[]): Node {
	let cache: SeqBankCache | null = null;
	return {
		id,
		name: 'music',
		kind: 'directory',
		isContainer: true,
		format: 'N64 sequences',
		getChildren: async () =>
			lib.sequences.flatMap((s, i): Node[] => {
				if (i === 0) return [];
				const label = names?.[i] ?? `seq_${String(i).padStart(2, '0')}`;
				const name = `${label}.wav`;
				return [
					{
						id: `${id}/${name}`,
						name,
						kind: 'file',
						isContainer: false,
						size: s.length,
						format: 'M64 sequence',
						// Rendering takes ~0.3 s; never hash it for duplicates.
						meta: { decoded: true, contentKey: `m64:${lib.seqOffset + s.offset}:${s.length}` },
						blob: async () => {
							cache ??= new SeqBankCache(rom, lib);
							const r = renderSeqWav(rom, lib, i, cache);
							if (!r) throw new Error('This sequence plays no notes');
							return new Blob([r.wav as BlobPart], { type: 'audio/wav' });
						},
					},
				];
			}),
	};
}
