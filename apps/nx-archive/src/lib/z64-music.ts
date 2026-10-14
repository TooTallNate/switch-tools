/**
 * Zelda 64 music: the `Audioseq` sequences played through `Audiobank`
 * soundfonts and `Audiotable` samples (`@tootallnate/n64-seq`'s z64
 * dialect), as a `music/` folder named from the zeldaret decomps.
 * Tables come from the `code` file; sequence 0 (sound effects) and
 * aliases are skipped.
 */

import {
	MM_SEQUENCE_NAMES,
	OOT_SEQUENCE_NAMES,
	encodeStereoWav,
	findZ64AudioTables,
	parseZ64Font,
	renderSeqEvents,
	runM64,
	z64SampleBanks,
	z64Sequence,
	type SeqBank,
	type Z64AudioTables,
} from '@tootallnate/n64-seq';
import { extractDmaFile, type DmaEntry, type Z64Fs } from '@tootallnate/z64-fs';
import type { Node } from './archive';

interface Audio {
	tables: Z64AudioTables;
	audioseq: Uint8Array;
	audiobank: Uint8Array;
	sampleBanks: (Uint8Array | null)[];
	fonts: Map<number, SeqBank>;
}

export function makeZ64MusicDir(id: string, romBlob: Blob, fs: Z64Fs, codeEntry: DmaEntry, mm: boolean): Node {
	const bytes = async (e: DmaEntry | undefined) => (e ? new Uint8Array(await (await extractDmaFile(romBlob, e)).arrayBuffer()) : null);
	let audioP: Promise<Audio | null> | null = null;
	const audio = () =>
		(audioP ??= (async () => {
			const byName = (n: string) => fs.entries.find((e) => e.name === n);
			const [audioseq, audiobank, audiotable, code] = await Promise.all([bytes(byName('Audioseq')), bytes(byName('Audiobank')), bytes(byName('Audiotable')), bytes(codeEntry)]);
			if (!audioseq || !audiobank || !audiotable || !code) return null;
			const tables = findZ64AudioTables(code, { audioseq: audioseq.length, audiobank: audiobank.length, audiotable: audiotable.length });
			return tables ? { tables, audioseq, audiobank, sampleBanks: z64SampleBanks(tables, audiotable), fonts: new Map() } : null;
		})());
	const names = mm ? MM_SEQUENCE_NAMES : OOT_SEQUENCE_NAMES;
	return {
		id,
		name: 'music',
		kind: 'directory',
		isContainer: true,
		format: 'Z64 sequences',
		getChildren: async () => {
			const a = await audio();
			if (!a) return [];
			return a.tables.sequences.flatMap((e, i): Node[] => {
				if (i === 0 || e.size === 0) return [];
				const name = `${String(i).padStart(3, '0')} ${names[i] ?? `seq_${i}`}.wav`;
				return [
					{
						id: `${id}/${name}`,
						name,
						kind: 'file',
						isContainer: false,
						size: e.size,
						format: 'Z64 sequence',
						meta: { decoded: true, contentKey: `z64seq:${e.romAddr}:${e.size}` },
						blob: async () => {
							const seq = z64Sequence(a.tables, a.audioseq, i);
							if (!seq) throw new Error('Missing sequence');
							const fonts = (a.tables.sequenceFonts[i] ?? []).map((f) => {
								let b = a.fonts.get(f);
								if (!b) a.fonts.set(f, (b = parseZ64Font(a.audiobank, a.tables.fonts[f]!, a.sampleBanks)));
								return b;
							});
							const r = runM64(seq, fonts, { dialect: 'z64', z64Variant: mm ? 'mm' : 'oot', maxSeconds: 240, afterLoopSeconds: 4 });
							if (r.events.length === 0) throw new Error('This sequence plays no notes (it may drive other sequences)');
							const wav = encodeStereoWav(renderSeqEvents(r.events, r.length + (r.looped ? 0 : 1.5), r.looped ? 4 : 0));
							return new Blob([wav as BlobPart], { type: 'audio/wav' });
						},
					},
				];
			});
		},
	};
}
