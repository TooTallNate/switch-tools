/**
 * PlayStation discs: PSP-style `.pbp` conversions and raw `.bin` /
 * cooked `.iso` CD images.
 *
 * Disc files are read sector by sector through a {@link SectorReader}.
 * CD-XA files get media treatment:
 *
 *  - STR movies (MDEC video sectors) are leaves the video preview
 *    decodes (`meta.psxStr`).
 *  - XA audio files (interleaved audio channels, e.g. voice and
 *    music banks) open as folders with one `.wav` per channel.
 *  - CD-DA entries and audio tracks become `.wav` files.
 *
 * Everything else goes through the normal child dispatch, backed by
 * a {@link SectorFileBlob} that reads only the sectors a slice needs.
 */
import {
	cddaToWav,
	entryDataSize,
	isCddaEntry,
	isRawEntry,
	parseIso9660,
	RAW_SECTOR_SIZE,
	USER_SECTOR_SIZE,
	readUserSectors,
	type IsoEntry,
	type SectorReader,
} from '@tootallnate/iso9660';
import { parsePbp, type CdTrack, type ParsedPbp } from '@tootallnate/pbp';
import { decodeXaStream, hasStrVideo, isCookedStr, pcm16ToWav, scanXaStreams } from '@tootallnate/psx-str';
import type { Node } from './archive';
import { detectFf7PsxModel } from './ff7-psx';

/** Builds a child node the normal way (injected by archive.ts). */
export type ChildFor = (id: string, name: string, blob: Blob) => Promise<Node>;

/**
 * A Blob view of a disc file that reads sectors on demand. Raw files
 * (Form 2 / CD-DA) are concatenated 2352-byte sectors; the rest is
 * user data. Only `slice`, `arrayBuffer`, `bytes`, `text` and
 * `stream` work — hand {@link materialize}d Blobs to browser APIs.
 */
export class SectorFileBlob extends Blob {
	constructor(
		private readonly reader: SectorReader,
		private readonly lba: number,
		private readonly raw: boolean,
		private readonly start: number,
		private readonly end: number,
	) {
		super([]);
		Object.defineProperty(this, 'size', { value: Math.max(0, end - start) });
	}

	override slice(start = 0, end?: number): Blob {
		const len = this.end - this.start;
		const s = Math.min(len, start < 0 ? Math.max(0, len + start) : start);
		const e = end === undefined ? len : Math.min(len, end < 0 ? Math.max(0, len + end) : end);
		return new SectorFileBlob(this.reader, this.lba, this.raw, this.start + s, this.start + Math.max(s, e));
	}

	async read(): Promise<Uint8Array> {
		const unit = this.raw ? RAW_SECTOR_SIZE : USER_SECTOR_SIZE;
		if (this.end <= this.start) return new Uint8Array(0);
		const first = Math.floor(this.start / unit);
		const count = Math.ceil(this.end / unit) - first;
		const bytes = this.raw
			? await this.reader.read(this.lba + first, count)
			: await readUserSectors(this.reader, this.lba + first, count);
		const off = this.start - first * unit;
		return bytes.slice(off, off + (this.end - this.start));
	}

	override async arrayBuffer(): Promise<ArrayBuffer> {
		return (await this.read()).buffer as ArrayBuffer;
	}

	override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
		return (await this.read()) as Uint8Array<ArrayBuffer>;
	}

	override async text(): Promise<string> {
		return new TextDecoder().decode(await this.read());
	}

	override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
		return new ReadableStream({
			start: async (controller) => {
				try {
					controller.enqueue((await this.read()) as Uint8Array<ArrayBuffer>);
					controller.close();
				} catch (err) {
					controller.error(err);
				}
			},
		});
	}
}

/** Read a SectorFileBlob (or any Blob) into a real, browser-usable Blob. */
export async function materialize(blob: Blob, type = ''): Promise<Blob> {
	if (!(blob instanceof SectorFileBlob)) return blob;
	return new Blob([(await blob.read()) as BlobPart], { type });
}

const WAV_HEADER = 44;

function compareNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function directoryNode(id: string, name: string, getChildren: () => Promise<Node[]>): Node {
	return { id, name, kind: 'directory', isContainer: true, format: 'directory', getChildren };
}

/** Folder of per-channel WAVs for an XA audio file. */
function xaFolderNode(id: string, name: string, reader: SectorReader, entry: IsoEntry, size: number): Node {
	let rawP: Promise<Uint8Array> | null = null;
	const raw = () => (rawP ??= new SectorFileBlob(reader, entry.lba, true, 0, size).read());
	const base = name.replace(/\.[^.]+$/, '');
	return {
		id,
		name,
		kind: 'psx-xa',
		isContainer: true,
		size,
		format: 'XA audio',
		blob: async () => materialize(new SectorFileBlob(reader, entry.lba, true, 0, size)),
		getChildren: async () => {
			const bytes = await raw();
			const streams = scanXaStreams(bytes);
			const multiFile = new Set(streams.map((s) => s.file)).size > 1;
			return streams.map((st): Node => {
				const ch = String(st.channel).padStart(2, '0');
				const childName = multiFile ? `${base}_f${st.file}_ch${ch}.wav` : `${base}_ch${ch}.wav`;
				return {
					id: `${id}/${childName}`,
					name: childName,
					kind: 'file',
					isContainer: false,
					size: WAV_HEADER + st.sampleFrames * st.channels * 2,
					format: `XA ADPCM ${st.channels === 2 ? 'stereo' : 'mono'} ${st.sampleRate} Hz`,
					meta: { xaFile: st.file, xaChannel: st.channel },
					blob: async () => {
						const pcm = decodeXaStream(await raw(), st.file, st.channel);
						return new Blob([pcm16ToWav(pcm.samples, pcm.channels, pcm.sampleRate) as BlobPart], { type: 'audio/wav' });
					},
				};
			});
		},
	};
}

/** One disc file → node, with XA / STR / CD-DA handled here. */
async function fileNode(id: string, reader: SectorReader, entry: IsoEntry, childFor: ChildFor): Promise<Node> {
	const raw = isRawEntry(entry) && reader.sectorSize === RAW_SECTOR_SIZE;
	const size = entryDataSize(entry, reader);
	if (raw && isCddaEntry(entry)) {
		const name = `${entry.name}.wav`;
		const audio = new SectorFileBlob(reader, entry.lba, true, 0, size);
		return {
			id: `${id}/${name}`,
			name,
			kind: 'file',
			isContainer: false,
			size: WAV_HEADER + size,
			format: 'CD-DA',
			blob: async () => new Blob([cddaToWav(await audio.read()) as BlobPart], { type: 'audio/wav' }),
		};
	}
	const blob = new SectorFileBlob(reader, entry.lba, raw, 0, size);
	const childId = `${id}/${entry.name}`;
	if (raw) {
		const head = await blob.slice(0, 64 * RAW_SECTOR_SIZE).arrayBuffer();
		const headBytes = new Uint8Array(head);
		if (hasStrVideo(headBytes)) {
			return {
				id: childId,
				name: entry.name,
				kind: 'file',
				isContainer: false,
				size,
				format: 'STR (MDEC)',
				meta: { psxStr: true },
				blob: async () => materialize(blob),
			};
		}
		if (scanXaStreams(headBytes).length) return xaFolderNode(childId, entry.name, reader, entry, size);
		return {
			id: childId,
			name: entry.name,
			kind: 'file',
			isContainer: false,
			size,
			format: 'CD-XA',
			blob: async () => materialize(blob),
		};
	}
	// STR movies stored as plain Form 1 data (no XA subheaders).
	if (/\.str$/i.test(entry.name) && isCookedStr(new Uint8Array(await blob.slice(0, 4).arrayBuffer()))) {
		return {
			id: childId,
			name: entry.name,
			kind: 'file',
			isContainer: false,
			size,
			format: 'STR (MDEC)',
			meta: { psxStr: true },
			blob: async () => materialize(blob),
		};
	}
	// Final Fantasy VII battle / field models (recognised by parsing them).
	if (/\.(lzs|bcx)$/i.test(entry.name) && size <= 2 * 1024 * 1024) {
		const kind = detectFf7PsxModel(entry.name, await blob.read());
		if (kind) {
			return {
				id: childId,
				name: entry.name,
				kind: 'file',
				isContainer: false,
				size,
				format: kind === 'battle' ? 'FF7 battle model' : 'FF7 field model',
				meta: { ff7PsxModel: kind },
				blob: async () => materialize(blob),
			};
		}
	}
	const node = await childFor(childId, entry.name, blob);
	// Leaves hand their blob to browser APIs, which can't read the facade.
	if (!node.isContainer && node.blob) {
		let real: Promise<Blob> | null = null;
		const orig = node.blob;
		node.blob = async (opts) => (real ??= orig(opts).then((b) => materialize(b)));
	}
	return node;
}

/** CD audio tracks no CD-DA directory entry already covers. */
function looseAudioTracks(id: string, reader: SectorReader, tracks: CdTrack[], entries: IsoEntry[]): Node[] {
	const covered = new Set(entries.filter(isCddaEntry).map((e) => e.lba));
	return tracks
		.filter((t) => t.audio && t.sectors > 0 && !covered.has(t.lba))
		.map((t): Node => {
			const name = `Track ${String(t.number).padStart(2, '0')}.wav`;
			const bytes = t.sectors * RAW_SECTOR_SIZE;
			return {
				id: `${id}/${name}`,
				name,
				kind: 'file',
				isContainer: false,
				size: WAV_HEADER + bytes,
				format: 'CD-DA',
				blob: async () => new Blob([cddaToWav(await reader.read(t.lba, t.sectors)) as BlobPart], { type: 'audio/wav' }),
			};
		});
}

/** Children of a disc: its ISO 9660 tree plus any loose CD audio tracks. */
export async function psxDiscChildren(id: string, reader: SectorReader, tracks: CdTrack[], childFor: ChildFor): Promise<Node[]> {
	const iso = await parseIso9660(reader);
	type Dir = { dirs: Map<string, Dir>; files: IsoEntry[] };
	const root: Dir = { dirs: new Map(), files: [] };
	for (const e of iso.entries) {
		let d = root;
		const parts = e.path.split('/');
		for (const p of parts.slice(0, -1)) {
			let next = d.dirs.get(p);
			if (!next) d.dirs.set(p, (next = { dirs: new Map(), files: [] }));
			d = next;
		}
		if (e.isDirectory) {
			if (!d.dirs.has(e.name)) d.dirs.set(e.name, { dirs: new Map(), files: [] });
		} else {
			d.files.push(e);
		}
	}
	const build = async (dirId: string, d: Dir): Promise<Node[]> => {
		const dirs = [...d.dirs.keys()].sort(compareNames).map((n) => directoryNode(`${dirId}/${n}`, n, () => build(`${dirId}/${n}`, d.dirs.get(n)!)));
		const files = await Promise.all(d.files.sort((a, b) => compareNames(a.name, b.name)).map((e) => fileNode(dirId, reader, e, childFor)));
		return [...dirs, ...files];
	};
	const children = await build(id, root);
	const loose = looseAudioTracks(`${id}/CD audio`, reader, tracks, iso.entries);
	if (loose.length) children.push(directoryNode(`${id}/CD audio`, 'CD audio', async () => loose));
	return children;
}

/** Container node for a raw (`.bin`) or cooked (`.iso`) PlayStation / CD-ROM image. */
export function makeCdImageNode(id: string, name: string, blob: Blob, reader: SectorReader, childFor: ChildFor): Node {
	return {
		id,
		name,
		kind: 'cd-image',
		isContainer: true,
		size: blob.size,
		format: reader.sectorSize === RAW_SECTOR_SIZE ? 'CD image (raw)' : 'ISO 9660',
		blob: async () => blob,
		getChildren: () => psxDiscChildren(id, reader, [], childFor),
	};
}

const SECTION_FORMATS: Record<string, string> = {
	'PARAM.SFO': 'SFO',
	'ICON0.PNG': 'PNG',
	'PIC0.PNG': 'PNG',
	'PIC1.PNG': 'PNG',
	'ICON1.PMF': 'PMF',
	'SND0.AT3': 'ATRAC3',
	'DATA.PSP': 'PSP executable',
	'DATA.PSAR': 'PSAR',
};

/** Container node for a PSP `.pbp` (PlayStation conversions show their discs). */
export function makePbpNode(id: string, name: string, blob: Blob, childFor: ChildFor): Node {
	let parsed: Promise<ParsedPbp> | null = null;
	const parse = () => (parsed ??= parsePbp(blob));
	return {
		id,
		name,
		kind: 'pbp',
		isContainer: true,
		size: blob.size,
		format: 'PBP',
		blob: async () => blob,
		getChildren: async () => {
			const pbp = await parse();
			const children: Node[] = [];
			pbp.discs.forEach((disc) => {
				const discName = pbp.discs.length > 1 ? `Disc ${disc.index + 1}` : 'disc';
				const discId = `${id}/${discName}`;
				children.push({
					...directoryNode(discId, discName, () => psxDiscChildren(discId, disc.reader, disc.tracks, childFor)),
					kind: 'cd-image',
					format: disc.gameId ? `PlayStation disc (${disc.gameId})` : 'PlayStation disc',
					size: disc.sectorCount * RAW_SECTOR_SIZE,
				});
			});
			for (const s of pbp.sections) {
				// DATA.PSAR is the disc image shown above.
				if (!s.size || (s.name === 'DATA.PSAR' && pbp.discs.length && !pbp.discErrors.length)) continue;
				children.push({
					id: `${id}/${s.name}`,
					name: s.name,
					kind: 'file',
					isContainer: false,
					size: s.size,
					format: s.name === 'DATA.PSAR' && pbp.discErrors.length ? 'PSAR (encrypted disc image)' : SECTION_FORMATS[s.name],
					meta:
						s.name === 'PARAM.SFO'
							? { sfo: pbp.sfo }
							: s.name === 'DATA.PSAR' && pbp.discErrors.length
								? { psarError: pbp.discErrors.join(' ') }
								: undefined,
					blob: async () => blob.slice(s.offset, s.offset + s.size, s.name.endsWith('.PNG') ? 'image/png' : ''),
				});
			}
			return children;
		},
	};
}
