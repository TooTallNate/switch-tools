/**
 * Classic libultra sound banks (`ALBankFile` ctl + tbl) as folders of
 * WAV leaves. Found by `findAlBankFiles` in `@tootallnate/n64-soundbank`
 * (GoldenEye 007's `sfx` and `instruments` banks, and other games on the
 * SDK's `libaudio`). Samples decode on demand.
 */

import { decodeAlSample, encodeWav, type LocatedAlBank } from '@tootallnate/n64-soundbank';
import type { Node } from './archive';

/** Names for a ROM's banks: GoldenEye's are `sfx` then `instruments`. */
function bankName(index: number, count: number, goldeneye: boolean): string {
	if (goldeneye && count === 2) return index === 0 ? 'sfx' : 'instruments';
	return `bank_${String(index).padStart(2, '0')}`;
}

export function makeAlBankDirNode(id: string, rom: Uint8Array, banks: LocatedAlBank[], options: { goldeneye?: boolean } = {}): Node {
	const dirFor = (bank: LocatedAlBank, index: number): Node => {
		const name = bankName(index, banks.length, !!options.goldeneye);
		const dirId = `${id}/${name}`;
		const tbl = rom.subarray(bank.tblOffset, bank.tblOffset + bank.tblSize);
		return {
			id: dirId,
			name,
			kind: 'directory',
			isContainer: true,
			format: 'N64 ALBank',
			getChildren: async () => {
				const width = Math.max(3, String(bank.samples.length).length);
				return bank.samples.map((s, i): Node => {
					const label = s.instrument < 0 ? 'perc' : `inst${String(s.instrument).padStart(3, '0')}`;
					const childName = `${String(i).padStart(width, '0')}_${label}_${s.sound}.wav`;
					const frames = s.type === 'adpcm' ? Math.floor(s.length / 9) * 16 : s.length >> 1;
					return {
						id: `${dirId}/${childName}`,
						name: childName,
						kind: 'file',
						isContainer: false,
						size: 44 + frames * 2,
						format: s.type === 'adpcm' ? 'VADPCM' : 'PCM16',
						meta: { contentKey: `albank:${bank.tblOffset}:${s.base}:${s.length}`, sampleRate: s.sampleRate },
						blob: async () => {
							const r = decodeAlSample(tbl, s);
							return new Blob([encodeWav(r.samples, s.sampleRate) as BlobPart], { type: 'audio/wav' });
						},
					};
				});
			},
		};
	};
	if (banks.length === 1) return { ...dirFor(banks[0]!, 0), id, name: 'audio' };
	return {
		id,
		name: 'audio',
		kind: 'directory',
		isContainer: true,
		format: 'N64 ALBank',
		getChildren: async () => banks.map(dirFor),
	};
}
