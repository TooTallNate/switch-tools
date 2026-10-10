/**
 * Decode any supported game-audio node to a browser-playable Blob (WAV
 * or Ogg), reusing the same decoders as the audio previews. The library
 * uses it for durations and waveform thumbnails. Browser-only.
 */

import { decodeHca, encodeToWav } from '@tootallnate/hca';
import { nintendoOpusToOggOpus } from '@tootallnate/wem';

import { decodeBwavToWavBlob } from '~/components/preview-pane';

import type { Node } from '../archive';
import {
	parseBfstmForAudioView,
	parseBfwavForAudioView,
	parseFmodSampleForView,
	parseWemForAudioView,
	prepareAudioBlobForBrowser,
} from '../preview';

/** Returns null when the format has no decoder (e.g. MIDI sequences). */
export async function decodeAudioBlob(node: Node, previewKind: string): Promise<Blob | null> {
	const blob = () => node.blob!();
	switch (previewKind) {
		case 'audio':
			return prepareAudioBlobForBrowser(await blob(), node.name);
		case 'bfwav-audio':
			return (await parseBfwavForAudioView(await blob())).wavBlob;
		case 'bfstm-audio':
			return (await parseBfstmForAudioView(await blob())).wavBlob;
		case 'bwav-audio':
			return decodeBwavToWavBlob(new Uint8Array(await (await blob()).arrayBuffer())).wavBlob;
		case 'wem-audio':
			return (await parseWemForAudioView(await blob())).decoded?.blob ?? null;
		case 'hca-audio': {
			const bytes = new Uint8Array(await (await blob()).arrayBuffer());
			const d = decodeHca(bytes, { awbKey: Number(node.meta?.awbSubkey ?? 0) });
			return new Blob([encodeToWav(d.channelCount, d.samplingRate, d.pcm, { bitDepth: 16 }) as BlobPart], { type: 'audio/wav' });
		}
		case 'nx-opus-audio': {
			const { ogg } = nintendoOpusToOggOpus(new Uint8Array(await (await blob()).arrayBuffer()));
			return new Blob([ogg as BlobPart], { type: 'audio/ogg; codecs=opus' });
		}
		case 'fmod-sample-audio': {
			const bank = node.meta?.fmodBankBlob as Blob | undefined;
			const index = node.meta?.fmodSampleIndex as number | undefined;
			if (!bank || index === undefined) return null;
			return (await parseFmodSampleForView(bank, index)).decoded?.blob ?? null;
		}
		default:
			return null;
	}
}
