/**
 * BioWare Aurora archives (Knights of the Old Republic I / II), from
 * xoreos (`src/aurora/keyfile.cpp`, `biffile.cpp`, `erffile.cpp`,
 * `rimfile.cpp`). All little-endian.
 *
 * - KEY (`chitin.key`, `'KEY V1  '`): BIF list (size, name offset,
 *   u16 name size, u16 drive) and resource list (16-byte resref, u16 type,
 *   u32 id = bif index << 20 | resource index).
 * - BIF (`'BIFFV1  '`): variable resources (id, offset, size, type).
 *   Names come only from the KEY.
 * - ERF / MOD / SAV (`'ERF V1.0'` …): localized description, key list
 *   (resref, id, u16 type, pad), resource list (offset, size).
 * - RIM (`'RIM V1.0'`): reserved u32, count, offset; entries of resref,
 *   u16 type, id + pad, offset, size (32 bytes).
 */

/** Aurora resource type id → extension (the types KotOR uses). */
export const AURORA_TYPES: Record<number, string> = {
	0: 'res', 1: 'bmp', 2: 'mve', 3: 'tga', 4: 'wav', 6: 'plt', 7: 'ini', 8: 'bmu', 9: 'mpg', 10: 'txt',
	2000: 'plh', 2001: 'tex', 2002: 'mdl', 2003: 'thg', 2005: 'fnt', 2007: 'lua', 2008: 'slt', 2009: 'nss', 2010: 'ncs',
	2011: 'mod', 2012: 'are', 2013: 'set', 2014: 'ifo', 2015: 'bic', 2016: 'wok', 2017: '2da', 2018: 'tlk', 2022: 'txi',
	2023: 'git', 2024: 'bti', 2025: 'uti', 2026: 'btc', 2027: 'utc', 2029: 'dlg', 2030: 'itp', 2031: 'btt', 2032: 'utt',
	2033: 'dds', 2034: 'bts', 2035: 'uts', 2036: 'ltr', 2037: 'gff', 2038: 'fac', 2039: 'bte', 2040: 'ute', 2041: 'btd',
	2042: 'utd', 2043: 'btp', 2044: 'utp', 2045: 'dft', 2046: 'gic', 2047: 'gui', 2048: 'css', 2049: 'ccs', 2050: 'btm',
	2051: 'utm', 2052: 'dwk', 2053: 'pwk', 2054: 'btg', 2055: 'utg', 2056: 'jrl', 2057: 'sav', 2058: 'utw', 2059: '4pc',
	2060: 'ssf', 2061: 'hak', 2062: 'nwm', 2063: 'bik', 2064: 'ndb', 2065: 'ptm', 2066: 'ptt', 2076: 'jpg', 2078: 'ogg',
	2110: 'png', 3000: 'lyt', 3001: 'vis', 3002: 'rim', 3003: 'pth', 3004: 'lip', 3005: 'bwm', 3006: 'txb', 3007: 'tpc',
	3008: 'mdx', 3009: 'rsv', 3010: 'sig', 3011: 'mab', 3012: 'qst', 3013: 'sto', 3015: 'hex', 3016: 'mdx2', 3017: 'txb2',
	3022: 'fsm', 3023: 'art', 3024: 'amp', 3025: 'cwa', 3028: 'bip', 9997: 'erf', 9998: 'bif', 9999: 'key',
};

export function auroraExtension(type: number): string {
	return AURORA_TYPES[type] ?? `type${type}`;
}

export interface AuroraResource {
	/** `resref.ext`. */
	name: string;
	resref: string;
	type: number;
	offset: number;
	size: number;
}

const dec = new TextDecoder('latin1');
function fixed(b: Uint8Array, o: number, n: number): string {
	const s = b.subarray(o, o + n);
	const z = s.indexOf(0);
	return dec.decode(z >= 0 ? s.subarray(0, z) : s);
}
function magic(b: Uint8Array): string {
	return dec.decode(b.subarray(0, 8));
}

export interface KeyFile {
	bifs: string[];
	/** Per resource: name, type, which BIF and which index in it. */
	resources: { resref: string; type: number; bif: number; index: number }[];
}

export function isKey(head: Uint8Array): boolean {
	return head.length >= 8 && magic(head).startsWith('KEY V1');
}

export function parseKey(bytes: Uint8Array): KeyFile {
	if (!isKey(bytes)) throw new Error('Not an Aurora KEY');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const v11 = magic(bytes) === 'KEY V1.1';
	const bifCount = dv.getUint32(8, true);
	const resCount = dv.getUint32(12, true);
	const o = v11 ? 20 : 16;
	const offFiles = dv.getUint32(o, true);
	const offRes = dv.getUint32(o + 4, true);
	const bifs: string[] = [];
	for (let i = 0; i < bifCount; i++) {
		const b = offFiles + i * (v11 ? 12 : 12);
		const nameOff = dv.getUint32(b + 4, true);
		const nameSize = v11 ? dv.getUint32(b + 8, true) : dv.getUint16(b + 8, true);
		bifs.push(fixed(bytes, nameOff, nameSize).replace(/\\/g, '/').replace(/^\//, ''));
	}
	const stride = v11 ? 26 : 22;
	const resources: KeyFile['resources'] = [];
	for (let i = 0; i < resCount; i++) {
		const b = offRes + i * stride;
		const id = dv.getUint32(b + 18, true);
		const bif = v11 ? (dv.getUint32(b + 22, true) >>> 20) & 0xfff : id >>> 20;
		resources.push({ resref: fixed(bytes, b, 16).toLowerCase(), type: dv.getUint16(b + 16, true), bif, index: id & 0xfffff });
	}
	return { bifs, resources };
}

export interface BifEntry {
	index: number;
	offset: number;
	size: number;
	type: number;
}

export function isBif(head: Uint8Array): boolean {
	return head.length >= 8 && magic(head).startsWith('BIFFV1');
}

export function bifHeaderSize(head: Uint8Array): number {
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const v11 = magic(head) === 'BIFFV1.1';
	return dv.getUint32(16, true) + dv.getUint32(8, true) * (v11 ? 20 : 16);
}

/** Parse a BIF's resource table (`bytes` needs the header + table; see {@link bifHeaderSize}). */
export function parseBif(bytes: Uint8Array): BifEntry[] {
	if (!isBif(bytes)) throw new Error('Not an Aurora BIF');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const v11 = magic(bytes) === 'BIFFV1.1';
	const n = dv.getUint32(8, true);
	const off = dv.getUint32(16, true);
	const stride = v11 ? 20 : 16;
	const out: BifEntry[] = [];
	for (let i = 0; i < n; i++) {
		const b = off + i * stride + (v11 ? 8 : 4);
		out.push({ index: i, offset: dv.getUint32(b, true), size: dv.getUint32(b + 4, true), type: dv.getUint32(b + 8, true) });
	}
	return out;
}

/** Name a BIF's entries from its KEY (`bifIndex` = position in `key.bifs`). */
export function nameBifEntries(entries: BifEntry[], key: KeyFile | null, bifIndex: number): AuroraResource[] {
	const names = new Map<number, string>();
	if (key) for (const r of key.resources) if (r.bif === bifIndex) names.set(r.index, r.resref);
	return entries.map((e) => {
		const resref = names.get(e.index) ?? `res_${e.index}`;
		return { name: `${resref}.${auroraExtension(e.type)}`, resref, type: e.type, offset: e.offset, size: e.size };
	});
}

export function isErf(head: Uint8Array): boolean {
	if (head.length < 8) return false;
	const m = magic(head);
	return /^(ERF |MOD |SAV |HAK )V1\.0$/.test(m) || m === 'RIM V1.0';
}

/** ERF / MOD / SAV / HAK (V1.0) or RIM archives. */
export function parseErf(bytes: Uint8Array): AuroraResource[] {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const m = magic(bytes);
	const out: AuroraResource[] = [];
	if (m === 'RIM V1.0') {
		const n = dv.getUint32(12, true);
		let off = dv.getUint32(16, true);
		if (off === 0) off = 120;
		for (let i = 0; i < n; i++) {
			const b = off + i * 32;
			const resref = fixed(bytes, b, 16).toLowerCase();
			const type = dv.getUint16(b + 16, true);
			out.push({ name: `${resref}.${auroraExtension(type)}`, resref, type, offset: dv.getUint32(b + 24, true), size: dv.getUint32(b + 28, true) });
		}
		return out;
	}
	if (!isErf(bytes)) throw new Error('Not an Aurora ERF / RIM');
	const n = dv.getUint32(16, true);
	const offKeys = dv.getUint32(24, true);
	const offRes = dv.getUint32(28, true);
	for (let i = 0; i < n; i++) {
		const k = offKeys + i * 24;
		const resref = fixed(bytes, k, 16).toLowerCase();
		const type = dv.getUint16(k + 20, true);
		out.push({ name: `${resref}.${auroraExtension(type)}`, resref, type, offset: dv.getUint32(offRes + i * 8, true), size: dv.getUint32(offRes + i * 8 + 4, true) });
	}
	return out;
}

/** Bytes needed to parse an ERF's tables (header + key list + resource list). */
export function erfTablesEnd(head: Uint8Array): number {
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const m = magic(head);
	if (m === 'RIM V1.0') {
		const n = dv.getUint32(12, true);
		const off = dv.getUint32(16, true) || 120;
		return off + n * 32;
	}
	const n = dv.getUint32(16, true);
	return Math.max(dv.getUint32(24, true) + n * 24, dv.getUint32(28, true) + n * 8);
}
