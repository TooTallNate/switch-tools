/**
 * PSP `EBOOT.PBP` files.
 *
 * A PBP is a 0x28-byte header (`\0PBP`, version, then eight u32
 * offsets) followed by its sections: PARAM.SFO, ICON0.PNG,
 * ICON1.PMF, PIC0.PNG, PIC1.PNG, SND0.AT3, DATA.PSP and DATA.PSAR.
 *
 * PlayStation games converted for the PSP (official PSN releases
 * and popstation-style conversions) keep the CD image in DATA.PSAR:
 *
 *  - `PSISOIMG0000`: one disc. A table at +0x4000 has one 32-byte
 *    entry (offset, length, …) per block of 16 raw 2352-byte
 *    sectors; blocks are raw-deflated, or stored when their length
 *    is exactly 16 × 2352. Block data starts at +0x100000. The CD
 *    table of contents is at +0x800, the disc ID at +0x400.
 *  - `PSTITLEIMG000000`: several discs; u32 offsets of each disc's
 *    PSISOIMG (relative to DATA.PSAR) are at +0x200.
 *
 * Official releases encrypt the PSISOIMG header; those can't be
 * read without the PSP's keys.
 */
import { bcd, msfToLba, RAW_SECTOR_SIZE, type SectorReader } from '@tootallnate/iso9660';
import { decompressLzrc } from './lzrc.js';
import { decryptPgd, isPgd } from './pgd.js';

export { decompressLzrc } from './lzrc.js';
export { decryptPgd, isPgd, PgdError } from './pgd.js';

export const PBP_SECTIONS = [
	'PARAM.SFO',
	'ICON0.PNG',
	'ICON1.PMF',
	'PIC0.PNG',
	'PIC1.PNG',
	'SND0.AT3',
	'DATA.PSP',
	'DATA.PSAR',
] as const;

export interface PbpSection {
	name: (typeof PBP_SECTIONS)[number];
	offset: number;
	size: number;
}

export interface CdTrack {
	number: number;
	/** True for audio (CD-DA) tracks. */
	audio: boolean;
	/** First sector of the track (index 01). */
	lba: number;
	/** Sector count up to the next track or the lead-out. */
	sectors: number;
}

export interface PbpDisc {
	/** 0-based disc index. */
	index: number;
	/** Disc ID from the PSISOIMG header, e.g. `SLUS00726`. */
	gameId: string;
	/** Offset of this disc's PSISOIMG in the PBP. */
	offset: number;
	/** End of this disc's block data in the PBP. */
	end: number;
	/** True for official (PGD-encrypted, LZRC-compressed) releases. */
	encrypted: boolean;
	sectorCount: number;
	tracks: CdTrack[];
	/** Raw 2352-byte sector reader over the disc image. */
	reader: SectorReader;
}

export interface ParsedPbp {
	version: number;
	sections: PbpSection[];
	/** PARAM.SFO key/values (TITLE, DISC_ID, CATEGORY, …). */
	sfo: Record<string, string | number>;
	/** PlayStation discs in DATA.PSAR (empty for native PSP games). */
	discs: PbpDisc[];
	/** Discs that couldn't be opened (e.g. encrypted PSN releases). */
	discErrors: string[];
}

export class PbpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PbpError';
	}
}

const ascii = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

/** True when `bytes` starts with the PBP magic. */
export function isPbp(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x50 && bytes[2] === 0x42 && bytes[3] === 0x50;
}

/** Parse a PARAM.SFO key/value table. */
export function parseSfo(bytes: Uint8Array): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	if (bytes.length < 20 || ascii.decode(bytes.subarray(0, 4)) !== '\0PSF') return out;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const keyTable = dv.getUint32(8, true);
	const dataTable = dv.getUint32(12, true);
	const count = dv.getUint32(16, true);
	for (let i = 0; i < count; i++) {
		const e = 20 + i * 16;
		if (e + 16 > bytes.length) break;
		const keyOffset = keyTable + dv.getUint16(e, true);
		const fmt = dv.getUint16(e + 2, true);
		const len = dv.getUint32(e + 4, true);
		const dataOffset = dataTable + dv.getUint32(e + 12, true);
		let end = keyOffset;
		while (end < bytes.length && bytes[end]) end++;
		const key = ascii.decode(bytes.subarray(keyOffset, end));
		if (fmt === 0x0404) out[key] = dv.getUint32(dataOffset, true);
		else out[key] = utf8.decode(bytes.subarray(dataOffset, dataOffset + len)).replace(/\0+$/, '');
	}
	return out;
}

const BLOCK_SECTORS = 16;
const BLOCK_SIZE = BLOCK_SECTORS * RAW_SECTOR_SIZE; // 0x9300
const INDEX_OFFSET = 0x4000;
const DATA_OFFSET = 0x100000;
const CACHE_BLOCKS = 64;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Parse a PSISOIMG CD table of contents (10-byte Q-subchannel entries). */
export function parsePsisoToc(toc: Uint8Array): { tracks: CdTrack[]; leadOut: number } {
	const starts: { number: number; audio: boolean; lba: number }[] = [];
	let leadOut = 0;
	for (let o = 0; o + 10 <= toc.length; o += 10) {
		const ctrl = toc[o];
		const point = toc[o + 2];
		if (ctrl === 0 && point === 0) break;
		const lba = msfToLba(bcd(toc[o + 7]), bcd(toc[o + 8]), bcd(toc[o + 9]));
		if (point === 0xa2) leadOut = lba;
		else if (point >= 1 && point <= 0x99) {
			starts.push({ number: bcd(point), audio: (ctrl & 0x40) === 0, lba: Math.max(0, lba) });
		}
	}
	starts.sort((a, b) => a.lba - b.lba);
	const tracks = starts.map((t, i) => ({
		...t,
		sectors: Math.max(0, (i + 1 < starts.length ? starts[i + 1].lba : leadOut) - t.lba),
	}));
	return { tracks, leadOut };
}

/** Size of the encrypted PSISOIMG header PGD (official EBOOTs), from +0x400. */
const ISO_HEADER_PGD_SIZE = 0xb6600;

async function openPsisoImage(blob: Blob, offset: number, index: number, versionKey?: Uint8Array): Promise<PbpDisc> {
	const head = new Uint8Array(await blob.slice(offset, offset + INDEX_OFFSET).arrayBuffer());
	if (ascii.decode(head.subarray(0, 12)) !== 'PSISOIMG0000') {
		throw new PbpError(`Disc ${index + 1}: missing PSISOIMG header`);
	}
	// `meta` is the PSISOIMG region from +0x400: disc ID, TOC at +0x400,
	// block table at +0x3C00. Official releases encrypt it as a PGD and
	// compress blocks with LZRC; popstation conversions store it plain
	// and use raw deflate.
	let meta: Uint8Array;
	const encrypted = isPgd(head.subarray(0x400));
	if (encrypted) {
		const pgd = new Uint8Array(await blob.slice(offset + 0x400, offset + 0x400 + ISO_HEADER_PGD_SIZE).arrayBuffer());
		try {
			meta = decryptPgd(pgd, versionKey);
		} catch (err) {
			throw new PbpError(`Disc ${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		meta = new Uint8Array(await blob.slice(offset + 0x400, offset + DATA_OFFSET).arrayBuffer());
	}
	// Stored like `_SLUS_00726` (NUL-padded).
	const gameId = ascii.decode(meta.subarray(0, 0x10)).replace(/\0[\s\S]*$/, '').replace(/^_+/, '');
	const { tracks, leadOut } = parsePsisoToc(meta.subarray(0x400, 0x800));

	// Entries: u32 offset, u16 size, u16 marker, 16-byte hash, padding.
	// Official images flag real blocks with marker 1 and leave junk
	// blocks at 0; popstation leaves every marker at 0.
	const table = meta.subarray(INDEX_OFFSET - 0x400);
	const iv = new DataView(table.buffer, table.byteOffset, table.byteLength);
	const entries: { offset: number; length: number; marker: number }[] = [];
	for (let o = 0; o + 32 <= table.length; o += 32) {
		const length = iv.getUint16(o + 4, true);
		if (length === 0) break;
		entries.push({ offset: iv.getUint32(o, true), length, marker: iv.getUint16(o + 6, true) });
	}
	const markers = entries.some((e) => e.marker !== 0);
	const blocks = markers ? entries.filter((e) => e.marker !== 0) : entries;
	if (!blocks.length) throw new PbpError(`Disc ${index + 1}: empty block index (encrypted PSN EBOOT?)`);
	const sectorCount = Math.min(blocks.length * BLOCK_SECTORS, leadOut > 0 ? Math.max(leadOut, 1) : Infinity);

	const cache = new Map<number, Promise<Uint8Array>>();
	const block = (k: number): Promise<Uint8Array> => {
		let p = cache.get(k);
		if (p) {
			cache.delete(k);
			cache.set(k, p);
			return p;
		}
		const b = blocks[k];
		p = (async () => {
			const start = offset + DATA_OFFSET + b.offset;
			const data = new Uint8Array(await blob.slice(start, start + b.length).arrayBuffer());
			if (b.length >= BLOCK_SIZE) return data.subarray(0, BLOCK_SIZE);
			const out = encrypted ? decompressLzrc(data, BLOCK_SIZE) : await inflateRaw(data);
			if (out.length < BLOCK_SIZE && k < blocks.length - 1) {
				throw new PbpError(`Disc ${index + 1}: block ${k} inflated to ${out.length} bytes`);
			}
			return out;
		})();
		p.catch(() => cache.delete(k));
		cache.set(k, p);
		while (cache.size > CACHE_BLOCKS) cache.delete(cache.keys().next().value!);
		return p;
	};

	const reader: SectorReader = {
		sectorSize: RAW_SECTOR_SIZE,
		sectorCount,
		async read(lba, count) {
			const end = Math.min(lba + count, sectorCount);
			const out = new Uint8Array(Math.max(0, end - lba) * RAW_SECTOR_SIZE);
			let pos = 0;
			for (let s = lba; s < end; ) {
				const k = Math.floor(s / BLOCK_SECTORS);
				const data = await block(k);
				const first = s - k * BLOCK_SECTORS;
				const n = Math.min(BLOCK_SECTORS - first, end - s);
				out.set(data.subarray(first * RAW_SECTOR_SIZE, (first + n) * RAW_SECTOR_SIZE), pos);
				pos += n * RAW_SECTOR_SIZE;
				s += n;
			}
			return out;
		},
	};
	const last = entries[entries.length - 1];
	const end = offset + DATA_OFFSET + last.offset + last.length;
	return { index, gameId, offset, end, sectorCount, tracks, reader, encrypted };
}


/** Find the next `PSISOIMG0000` header at a 16-byte boundary in [from, to). */
async function findPsiso(blob: Blob, from: number, to: number): Promise<number | null> {
	const start = Math.ceil(from / 16) * 16;
	const bytes = new Uint8Array(await blob.slice(start, Math.min(to, blob.size)).arrayBuffer());
	const magic = [0x50, 0x53, 0x49, 0x53, 0x4f, 0x49, 0x4d, 0x47, 0x30, 0x30, 0x30, 0x30];
	for (let o = 0; o + 12 <= bytes.length; o += 16) {
		let ok = true;
		for (let i = 0; i < 12 && ok; i++) ok = bytes[o + i] === magic[i];
		if (ok) return start + o;
	}
	return null;
}

/** Parse a PBP's sections, PARAM.SFO and any PlayStation discs. */
export interface ParsePbpOptions {
	/**
	 * The game's 16-byte version key (KEYS.BIN), to verify encrypted
	 * discs against. Optional: it is recovered from the PGD MAC.
	 */
	versionKey?: Uint8Array;
}

export async function parsePbp(blob: Blob, options: ParsePbpOptions = {}): Promise<ParsedPbp> {
	const head = new Uint8Array(await blob.slice(0, 0x28).arrayBuffer());
	if (!isPbp(head)) throw new PbpError('Not a PBP file');
	const dv = new DataView(head.buffer);
	const offsets = PBP_SECTIONS.map((_, i) => dv.getUint32(8 + i * 4, true));
	const sections: PbpSection[] = PBP_SECTIONS.map((name, i) => {
		const end = i + 1 < offsets.length ? offsets[i + 1] : blob.size;
		return { name, offset: offsets[i], size: Math.max(0, end - offsets[i]) };
	});
	const sfoSection = sections[0];
	const sfo = sfoSection.size
		? parseSfo(new Uint8Array(await blob.slice(sfoSection.offset, sfoSection.offset + sfoSection.size).arrayBuffer()))
		: {};

	const psar = sections[7];
	const discs: PbpDisc[] = [];
	const discErrors: string[] = [];
	const open = async (off: number): Promise<PbpDisc | null> => {
		try {
			const disc = await openPsisoImage(blob, off, discs.length + discErrors.length, options.versionKey);
			discs.push(disc);
			return disc;
		} catch (err) {
			discErrors.push(err instanceof Error ? err.message : String(err));
			return null;
		}
	};
	if (psar.size >= 16) {
		const magic = ascii.decode(new Uint8Array(await blob.slice(psar.offset, psar.offset + 16).arrayBuffer()));
		if (magic.startsWith('PSISOIMG0000')) {
			await open(psar.offset);
		} else if (magic.startsWith('PSTITLEIMG000000')) {
			let table: Uint8Array = new Uint8Array(await blob.slice(psar.offset + 0x200, psar.offset + 0x200 + 0x2a0).arrayBuffer());
			if (isPgd(table)) {
				// Official multi-disc releases encrypt the disc map.
				try {
					table = decryptPgd(table, options.versionKey);
				} catch {
					table = new Uint8Array(0);
				}
			}
			const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
			const offsets: number[] = [];
			if (table.length >= 20) {
				for (let i = 0; i < 5; i++) {
					const rel = tv.getUint32(i * 4, true);
					if (rel && psar.offset + rel < blob.size) offsets.push(psar.offset + rel);
				}
			}
			if (offsets.length) {
				for (const off of offsets) await open(off);
			} else {
				// The disc table is in an encrypted PGD block: chain from
				// one disc's end to the next PSISOIMG header instead.
				let next = await findPsiso(blob, psar.offset + 0x200, psar.offset + 0x100000);
				while (next !== null && discs.length < 5) {
					const disc = await open(next);
					if (!disc) break;
					next = await findPsiso(blob, disc.end, disc.end + 0x100000);
				}
			}
		}
	}
	return { version: dv.getUint32(4, true), sections, sfo, discs, discErrors };
}
