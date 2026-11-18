/**
 * Needle texture streaming (Sonic Frontiers), after HedgeLib++
 * `hl_hh_needle_texture_streaming.h`.
 *
 * A `.dds` inside a pac is often only a stub, `NTSI`:
 *
 *   'NTSI', version 1, unknown, package name size, 4x4 mip size, 4x4 mip index
 *   package name (`character` → `raw/texture_streaming/character.ntsp`)
 *   the 4x4 mip's bytes, then the texture's DDS header (with DX10)
 *
 * The package, `PSTN` version 1 (little-endian): entry count, blob
 * count, header size (u64); entries sorted by name hash (u32 hash,
 * first blob, blob count, width, height, u64 name offset); blobs (u64
 * data offset, u64 size), one per mip level, largest first. The mips
 * are linear (not block-linear), so stub header + blobs is a DDS.
 * The hash is Java's `String.hashCode` masked to 31 bits.
 */

export interface NtsiStub {
	packageName: string;
	mip4x4Index: number;
	mip4x4: Uint8Array;
	/** The DDS header (magic included), up to 0x94 bytes. */
	ddsHeader: Uint8Array;
}

export function isNtsi(bytes: Uint8Array): boolean {
	return bytes.length >= 24 && bytes[0] === 0x4e && bytes[1] === 0x54 && bytes[2] === 0x53 && bytes[3] === 0x49;
}

export function parseNtsi(bytes: Uint8Array): NtsiStub {
	if (!isNtsi(bytes)) throw new Error('Not an NTSI texture stub');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const nameSize = dv.getUint32(12, true), mipSize = dv.getUint32(16, true), mipIndex = dv.getUint32(20, true);
	let nameEnd = 24;
	while (nameEnd < 24 + nameSize && bytes[nameEnd] !== 0) nameEnd++;
	const packageName = new TextDecoder().decode(bytes.subarray(24, nameEnd));
	const mipAt = 24 + nameSize;
	const ddsAt = mipAt + mipSize;
	return { packageName, mip4x4Index: mipIndex, mip4x4: bytes.subarray(mipAt, ddsAt), ddsHeader: bytes.subarray(ddsAt, Math.min(bytes.length, ddsAt + 0x94)) };
}

export function ntspNameHash(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
	return h & 0x7fffffff;
}

export interface NtspEntry {
	name: string;
	hash: number;
	width: number;
	height: number;
	/** Mip levels, largest first: absolute file offset and size. */
	mips: { offset: number; size: number }[];
}

export interface NtspPackage {
	headerSize: number;
	entries: NtspEntry[];
	find(name: string): NtspEntry | null;
}

export function isNtsp(bytes: Uint8Array): boolean {
	return bytes.length >= 24 && bytes[0] === 0x50 && bytes[1] === 0x53 && bytes[2] === 0x54 && bytes[3] === 0x4e;
}

/** Header size of a package from its first 24 bytes. */
export function ntspHeaderSize(head: Uint8Array): number {
	if (!isNtsp(head)) throw new Error('Not a PSTN texture package');
	return Number(new DataView(head.buffer, head.byteOffset, head.byteLength).getBigUint64(16, true));
}

/** Parse a package's header (the first {@link ntspHeaderSize} bytes). */
export function parseNtsp(header: Uint8Array): NtspPackage {
	if (!isNtsp(header)) throw new Error('Not a PSTN texture package');
	const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const entryCount = dv.getUint32(8, true), blobCount = dv.getUint32(12, true);
	const headerSize = Number(dv.getBigUint64(16, true));
	const blobsAt = 24 + entryCount * 24;
	const blob = (i: number) => (i < blobCount && blobsAt + i * 16 + 16 <= header.length ? { offset: Number(dv.getBigUint64(blobsAt + i * 16, true)), size: Number(dv.getBigUint64(blobsAt + i * 16 + 8, true)) } : null);
	const entries: NtspEntry[] = [];
	for (let i = 0; i < entryCount; i++) {
		const o = 24 + i * 24;
		const first = dv.getUint32(o + 4, true), count = dv.getUint32(o + 8, true);
		const nameAt = Number(dv.getBigUint64(o + 16, true));
		let e = nameAt;
		while (e < header.length && header[e] !== 0) e++;
		const mips: NtspEntry['mips'] = [];
		for (let k = 0; k < count; k++) {
			const b = blob(first + k);
			if (b) mips.push(b);
		}
		entries.push({ name: new TextDecoder().decode(header.subarray(nameAt, e)), hash: dv.getUint32(o, true), width: dv.getUint16(o + 12, true), height: dv.getUint16(o + 14, true), mips });
	}
	const byName = new Map(entries.map((x) => [x.name, x]));
	return { headerSize, entries, find: (name) => byName.get(name.replace(/\.dds$/i, '')) ?? null };
}

/**
 * Rebuild a whole DDS from a stub and its mips (largest first). With
 * fewer mips than the header promises (say only the 4x4 one), the
 * header's size and mip count are rewritten to match.
 */
export function assembleDds(stub: NtsiStub, mips: Uint8Array[], width?: number, height?: number): Uint8Array {
	const header = stub.ddsHeader.slice();
	const dv = new DataView(header.buffer);
	if (width && height) {
		dv.setUint32(12, height, true);
		dv.setUint32(16, width, true);
	}
	dv.setUint32(28, mips.length, true);
	const total = header.length + mips.reduce((s, m) => s + m.length, 0);
	const out = new Uint8Array(total);
	out.set(header, 0);
	let o = header.length;
	for (const m of mips) {
		out.set(m, o);
		o += m.length;
	}
	return out;
}
