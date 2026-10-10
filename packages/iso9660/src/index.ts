/**
 * ISO 9660 over CD sectors.
 *
 * Discs are read through a {@link SectorReader}, which hands out
 * either raw 2352-byte sectors (sync + header + subheader + data +
 * EDC/ECC, as in `.bin` images and PBP disc images) or cooked
 * 2048-byte user data (as in `.iso` images).
 *
 * PlayStation and other CD-XA discs tag files with extended
 * attributes in each directory record's system-use area. Form 2
 * (XA audio / STR video), interleaved and CD-DA files only make
 * sense as raw sectors, because their payload, subheaders or audio
 * samples don't fit the 2048-byte Form 1 view. {@link readIsoFile}
 * returns raw sectors for those and user data for everything else.
 */

export const RAW_SECTOR_SIZE = 2352;
export const USER_SECTOR_SIZE = 2048;

const SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

export interface SectorReader {
	/** Sector size handed out by `read`: 2352 (raw) or 2048 (cooked). */
	sectorSize: number;
	/** Total sectors in the image. */
	sectorCount: number;
	/** Read `count` consecutive sectors starting at `lba`. */
	read(lba: number, count: number): Promise<Uint8Array>;
}

/** CD-XA attributes of a directory record (big-endian in the record). */
export const XA_FORM1 = 0x0800;
export const XA_FORM2 = 0x1000;
export const XA_INTERLEAVED = 0x2000;
export const XA_CDDA = 0x4000;
export const XA_DIRECTORY = 0x8000;

export interface IsoEntry {
	/** `/`-separated path from the root, no leading slash, version suffix removed. */
	path: string;
	name: string;
	isDirectory: boolean;
	/** First sector. */
	lba: number;
	/** Size in bytes as recorded (2048 per sector, even for Form 2 / CD-DA files). */
	size: number;
	/** CD-XA attributes, when the record has an XA system-use field. */
	xaAttributes?: number;
	/** CD-XA file number (matches the subheader's file byte for interleaved files). */
	xaFileNumber?: number;
}

export interface ParsedIso {
	systemId: string;
	volumeId: string;
	/** Total sectors per the primary volume descriptor. */
	volumeSectors: number;
	entries: IsoEntry[];
}

/** True when `sector` starts with the CD sync pattern. */
export function hasSync(sector: Uint8Array): boolean {
	if (sector.length < 12) return false;
	for (let i = 0; i < 12; i++) if (sector[i] !== SYNC[i]) return false;
	return true;
}

/** The 2048-byte user data of a raw Mode 1 / Mode 2 Form 1 sector. */
export function rawUserData(sector: Uint8Array): Uint8Array {
	const mode = sector[15];
	const start = mode === 1 ? 16 : 24;
	return sector.subarray(start, start + USER_SECTOR_SIZE);
}

/** Wrap a raw `.bin` or cooked `.iso` image as a sector reader. */
export function blobSectorReader(blob: Blob, sectorSize: number, offset = 0): SectorReader {
	return {
		sectorSize,
		sectorCount: Math.floor((blob.size - offset) / sectorSize),
		async read(lba, count) {
			const start = offset + lba * sectorSize;
			return new Uint8Array(await blob.slice(start, start + count * sectorSize).arrayBuffer());
		},
	};
}

/**
 * Detect a disc image's layout from its first sectors. Returns the
 * sector size (2352 raw or 2048 cooked) or null when there's no
 * ISO 9660 primary volume descriptor at sector 16.
 */
export async function detectIsoImage(blob: Blob): Promise<number | null> {
	if (blob.size >= 17 * RAW_SECTOR_SIZE) {
		const pvd = new Uint8Array(await blob.slice(16 * RAW_SECTOR_SIZE, 17 * RAW_SECTOR_SIZE).arrayBuffer());
		if (hasSync(pvd) && isPvd(rawUserData(pvd))) return RAW_SECTOR_SIZE;
	}
	if (blob.size >= 17 * USER_SECTOR_SIZE) {
		const pvd = new Uint8Array(await blob.slice(16 * USER_SECTOR_SIZE, 17 * USER_SECTOR_SIZE).arrayBuffer());
		if (isPvd(pvd)) return USER_SECTOR_SIZE;
	}
	return null;
}

function isPvd(user: Uint8Array): boolean {
	return user[0] === 1 && user[1] === 0x43 && user[2] === 0x44 && user[3] === 0x30 && user[4] === 0x30 && user[5] === 0x31;
}

/** Read `count` sectors' user data (2048 each), whatever the reader's sector size. */
export async function readUserSectors(reader: SectorReader, lba: number, count: number): Promise<Uint8Array> {
	const bytes = await reader.read(lba, count);
	if (reader.sectorSize === USER_SECTOR_SIZE) return bytes;
	const out = new Uint8Array(count * USER_SECTOR_SIZE);
	for (let i = 0; i < count; i++) {
		const sector = bytes.subarray(i * RAW_SECTOR_SIZE, (i + 1) * RAW_SECTOR_SIZE);
		if (sector.length < RAW_SECTOR_SIZE) break;
		out.set(rawUserData(sector), i * USER_SECTOR_SIZE);
	}
	return out;
}

const latin1 = new TextDecoder('latin1');

function trimField(bytes: Uint8Array): string {
	return latin1.decode(bytes).replace(/[\s\0]+$/, '');
}

/** Parse the volume descriptor and the whole directory tree. */
export async function parseIso9660(reader: SectorReader): Promise<ParsedIso> {
	const pvd = await readUserSectors(reader, 16, 1);
	if (!isPvd(pvd)) throw new Error('No ISO 9660 primary volume descriptor at sector 16');
	const dv = new DataView(pvd.buffer, pvd.byteOffset, pvd.byteLength);
	const root = pvd.subarray(156, 156 + 34);
	const rootDv = new DataView(root.buffer, root.byteOffset, root.byteLength);
	const entries: IsoEntry[] = [];
	const seen = new Set<number>();

	const readDir = async (lba: number, size: number, prefix: string, depth: number): Promise<void> => {
		if (depth > 32 || seen.has(lba) || size <= 0) return;
		seen.add(lba);
		const count = Math.ceil(size / USER_SECTOR_SIZE);
		if (lba + count > reader.sectorCount) throw new Error(`ISO 9660 directory at sector ${lba} runs past the image`);
		const data = await readUserSectors(reader, lba, count);
		const subdirs: IsoEntry[] = [];
		let p = 0;
		while (p < Math.min(size, data.length)) {
			const len = data[p];
			if (len === 0) {
				// Records never straddle sectors: skip to the next one.
				p = (Math.floor(p / USER_SECTOR_SIZE) + 1) * USER_SECTOR_SIZE;
				continue;
			}
			if (p + len > data.length || len < 34) break;
			const rec = data.subarray(p, p + len);
			const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
			const nameLen = rec[32];
			const rawName = rec.subarray(33, 33 + nameLen);
			p += len;
			if (nameLen === 1 && (rawName[0] === 0 || rawName[0] === 1)) continue; // . and ..
			const name = latin1.decode(rawName).replace(/;\d+$/, '').replace(/\.$/, '');
			const flags = rec[25];
			const isDirectory = (flags & 2) !== 0;
			// System use area: after the name, padded to an even offset.
			const su = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
			let xaAttributes: number | undefined;
			let xaFileNumber: number | undefined;
			if (len - su >= 14 && rec[su + 6] === 0x58 && rec[su + 7] === 0x41) {
				xaAttributes = rdv.getUint16(su + 4, false);
				xaFileNumber = rec[su + 8];
			}
			const entry: IsoEntry = {
				path: prefix ? `${prefix}/${name}` : name,
				name,
				isDirectory,
				lba: rdv.getUint32(2, true),
				size: rdv.getUint32(10, true),
				xaAttributes,
				xaFileNumber,
			};
			entries.push(entry);
			if (isDirectory) subdirs.push(entry);
		}
		for (const d of subdirs) await readDir(d.lba, d.size, d.path, depth + 1);
	};
	await readDir(rootDv.getUint32(2, true), rootDv.getUint32(10, true), '', 0);
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		systemId: trimField(pvd.subarray(8, 40)),
		volumeId: trimField(pvd.subarray(40, 72)),
		volumeSectors: dv.getUint32(80, true),
		entries,
	};
}

/** True when an entry's data must be read as raw sectors (Form 2, interleaved or CD-DA). */
export function isRawEntry(entry: IsoEntry): boolean {
	return entry.xaAttributes !== undefined && (entry.xaAttributes & (XA_FORM2 | XA_INTERLEAVED | XA_CDDA)) !== 0;
}

/** True for CD-DA (audio track) entries. */
export function isCddaEntry(entry: IsoEntry): boolean {
	return entry.xaAttributes !== undefined && (entry.xaAttributes & XA_CDDA) !== 0;
}

/** Number of sectors an entry spans. */
export function entrySectors(entry: IsoEntry): number {
	return Math.ceil(entry.size / USER_SECTOR_SIZE);
}

/**
 * Byte size of {@link readIsoFile}'s result: raw entries span whole
 * 2352-byte sectors, the rest their recorded size.
 */
export function entryDataSize(entry: IsoEntry, reader: SectorReader): number {
	if (isRawEntry(entry) && reader.sectorSize === RAW_SECTOR_SIZE) return entrySectors(entry) * RAW_SECTOR_SIZE;
	return entry.size;
}

/**
 * Read a file. Raw entries return whole 2352-byte sectors (when the
 * reader has them); everything else returns its user data, trimmed
 * to the recorded size.
 */
export async function readIsoFile(reader: SectorReader, entry: IsoEntry): Promise<Uint8Array> {
	const count = Math.min(entrySectors(entry), Math.max(0, reader.sectorCount - entry.lba));
	if (isRawEntry(entry) && reader.sectorSize === RAW_SECTOR_SIZE) {
		return reader.read(entry.lba, count);
	}
	const data = await readUserSectors(reader, entry.lba, count);
	return data.subarray(0, Math.min(entry.size, data.length));
}

/** Convert a BCD byte (e.g. 0x59) to its value (59). */
export function bcd(v: number): number {
	return (v >> 4) * 10 + (v & 15);
}

/** Absolute LBA of an MSF address (2-second pregap removed). */
export function msfToLba(m: number, s: number, f: number): number {
	return (m * 60 + s) * 75 + f - 150;
}

/** Wrap raw CD-DA sectors (44.1 kHz stereo 16-bit LE) in a WAV header. */
export function cddaToWav(raw: Uint8Array): Uint8Array {
	const out = new Uint8Array(44 + raw.length);
	const dv = new DataView(out.buffer);
	const ascii = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
	};
	ascii(0, 'RIFF');
	dv.setUint32(4, 36 + raw.length, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, 2, true);
	dv.setUint32(24, 44100, true);
	dv.setUint32(28, 44100 * 4, true);
	dv.setUint16(32, 4, true);
	dv.setUint16(34, 16, true);
	ascii(36, 'data');
	dv.setUint32(40, raw.length, true);
	out.set(raw, 44);
	return out;
}
