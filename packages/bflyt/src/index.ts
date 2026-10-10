/**
 * NintendoWare layout (`.bflyt`, magic `FLYT`) and layout animation
 * (`.bflan`, magic `FLAN`) — structural parser.
 *
 * Both share the NW binary header: magic[4], BOM u16, headerSize u16,
 * version u32, fileSize u32, sectionCount u16, pad u16, followed by
 * `magic[4] + u32 size` sections.
 *
 * BFLYT: `lyt1` (canvas), `txl1` / `fnl1` (texture / font name lists),
 * `mat1` (materials), a pane tree (`pan1` / `pic1` / `txt1` / `wnd1` /
 * `bnd1` / `prt1` / `scr1` / `ali1`, nested by `pas1` / `pae1`) and a
 * group tree (`grp1`, nested by `grs1` / `gre1`). Every pane starts
 * with the same 0x4C-byte header (flags, alpha, name, transform, size).
 *
 * BFLAN: `pat1` (tag name, frame range, groups) and `pai1` (frame size,
 * loop, textures, and per-pane / per-material animation entries with
 * their curve tags — `FLPA` transform, `FLVC` vertex colour, `FLTP`
 * texture pattern, …).
 *
 * Field layouts follow Switch-Toolbox's `Layout/CAFE` readers
 * (KillzXGaming, MIT). Rendering is out of scope; this exposes what an
 * archive browser needs to describe a layout.
 */

export interface NwHeader {
	magic: string;
	littleEndian: boolean;
	version: string;
	versionMajor: number;
	fileSize: number;
	sectionCount: number;
}

export type PaneKind = 'pan1' | 'pic1' | 'txt1' | 'wnd1' | 'bnd1' | 'prt1' | 'scr1' | 'ali1';

export interface LayoutPane {
	kind: PaneKind;
	name: string;
	visible: boolean;
	alpha: number;
	translate: [number, number, number];
	rotate: [number, number, number];
	scale: [number, number];
	width: number;
	height: number;
	/** `pic1` / `txt1` / `wnd1` material, resolved to its name. */
	material?: string;
	/** `txt1` text (UTF-16) and font. */
	text?: string;
	font?: string;
	/** `txt1` text ID label. */
	textId?: string;
	/** `prt1` referenced part layout. */
	partLayout?: string;
	children: LayoutPane[];
}

export interface LayoutGroup {
	name: string;
	panes: string[];
	children: LayoutGroup[];
}

export interface ParsedBflyt {
	header: NwHeader;
	name: string;
	width: number;
	height: number;
	textures: string[];
	fonts: string[];
	materials: string[];
	/** Root panes (normally a single `RootPane`). */
	panes: LayoutPane[];
	groups: LayoutGroup[];
	paneCount: number;
	/** Section magic → count. */
	sections: Record<string, number>;
}

export interface LayoutAnimTag {
	/** Curve tag magic, e.g. `FLPA`, `FLVC`, `FLTP`. */
	tag: string;
	/** Number of animated components under this tag. */
	curves: number;
	/** Total key frames across those curves. */
	keys: number;
}

export interface LayoutAnimEntry {
	/** Pane or material name. */
	name: string;
	/** 0 = pane, 1 = material, 2 = user data (per NW). */
	target: number;
	tags: LayoutAnimTag[];
}

export interface ParsedBflan {
	header: NwHeader;
	/** `pat1` tag (absent in some files). */
	tag: { name: string; order: number; startFrame: number; endFrame: number; childBinding: boolean; groups: string[] } | null;
	frameSize: number;
	loop: boolean;
	textures: string[];
	entries: LayoutAnimEntry[];
	sections: Record<string, number>;
}

/** Human-readable descriptions of BFLAN curve tags. */
export const ANIM_TAG_NAMES: Record<string, string> = {
	FLPA: 'pane SRT',
	FLVI: 'visibility',
	FLVC: 'vertex colour',
	FLMC: 'material colour',
	FLTS: 'texture SRT',
	FLTP: 'texture pattern',
	FLIM: 'indirect SRT',
	FLAC: 'alpha compare',
	FLFS: 'font shadow',
	FLCT: 'per-character transform',
	FLWN: 'window',
	FLEU: 'extended user data',
	FLMA: 'mask',
	FLDS: 'drop shadow',
	FLPM: 'procedural shape',
};

class Reader {
	readonly view: DataView;
	readonly bytes: Uint8Array;
	readonly le: boolean;
	constructor(bytes: Uint8Array, le: boolean) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.le = le;
	}
	u8(o: number) {
		return this.view.getUint8(o);
	}
	u16(o: number) {
		return this.view.getUint16(o, this.le);
	}
	i16(o: number) {
		return this.view.getInt16(o, this.le);
	}
	u32(o: number) {
		return this.view.getUint32(o, this.le);
	}
	f32(o: number) {
		return this.view.getFloat32(o, this.le);
	}
	/** NUL-terminated ASCII / UTF-8 string, bounded by `max` bytes. */
	cstr(o: number, max = 256): string {
		let end = o;
		const lim = Math.min(this.bytes.length, o + max);
		while (end < lim && this.bytes[end] !== 0) end++;
		return new TextDecoder().decode(this.bytes.subarray(o, end));
	}
	/** NUL-terminated UTF-16 string. */
	wstr(o: number, max = 8192): string {
		let s = '';
		for (let p = o; p + 1 < this.bytes.length && p < o + max * 2; p += 2) {
			const c = this.u16(p);
			if (c === 0) break;
			s += String.fromCharCode(c);
		}
		return s;
	}
	magic(o: number): string {
		return String.fromCharCode(this.bytes[o], this.bytes[o + 1], this.bytes[o + 2], this.bytes[o + 3]);
	}
}

interface Section {
	magic: string;
	start: number;
	size: number;
}

function readHeader(bytes: Uint8Array, expect: string): { r: Reader; header: NwHeader; sections: Section[] } {
	if (bytes.length < 0x14) throw new Error(`Buffer too small to be a ${expect} file`);
	const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
	if (magic !== expect) throw new Error(`Not a ${expect} file (magic "${magic}")`);
	const le = bytes[4] === 0xff && bytes[5] === 0xfe;
	const r = new Reader(bytes, le);
	const headerSize = r.u16(6);
	const version = r.u32(8);
	const sectionCount = r.u16(0x10);
	const header: NwHeader = {
		magic,
		littleEndian: le,
		version: `${version >>> 24}.${(version >>> 16) & 0xff}.${(version >>> 8) & 0xff}.${version & 0xff}`,
		versionMajor: version >>> 24,
		fileSize: r.u32(0x0c),
		sectionCount,
	};
	const sections: Section[] = [];
	let o = headerSize || 0x14;
	for (let i = 0; i < sectionCount && o + 8 <= bytes.length; i++) {
		const size = r.u32(o + 4);
		if (size < 8 || o + size > bytes.length) break;
		sections.push({ magic: r.magic(o), start: o, size });
		o += size;
	}
	return { r, header, sections };
}

function countSections(sections: Section[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of sections) out[s.magic] = (out[s.magic] ?? 0) + 1;
	return out;
}

/** `u16 count, pad, u32 offsets[count]` (relative to the table) + strings. */
function readNameList(r: Reader, s: Section): string[] {
	const count = r.u16(s.start + 8);
	const table = s.start + 12;
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(r.cstr(table + r.u32(table + i * 4)));
	return out;
}

const PANE_KINDS = new Set<string>(['pan1', 'pic1', 'txt1', 'wnd1', 'bnd1', 'prt1', 'scr1', 'ali1']);

export function parseBflyt(bytes: Uint8Array): ParsedBflyt {
	const { r, header, sections } = readHeader(bytes, 'FLYT');
	const out: ParsedBflyt = {
		header,
		name: '',
		width: 0,
		height: 0,
		textures: [],
		fonts: [],
		materials: [],
		panes: [],
		groups: [],
		paneCount: 0,
		sections: countSections(sections),
	};
	const paneStack: LayoutPane[][] = [out.panes];
	let lastPane: LayoutPane | null = null;
	const groupStack: LayoutGroup[][] = [out.groups];
	let lastGroup: LayoutGroup | null = null;

	for (const s of sections) {
		const p = s.start + 8;
		switch (s.magic) {
			case 'lyt1':
				out.width = r.f32(p + 4);
				out.height = r.f32(p + 8);
				out.name = r.cstr(p + 20);
				break;
			case 'txl1':
				out.textures = readNameList(r, s);
				break;
			case 'fnl1':
				out.fonts = readNameList(r, s);
				break;
			case 'mat1': {
				const count = r.u16(p);
				for (let i = 0; i < count; i++) out.materials.push(r.cstr(s.start + r.u32(p + 4 + i * 4), 0x1c));
				break;
			}
			case 'pas1':
				if (lastPane) paneStack.push(lastPane.children);
				break;
			case 'pae1':
				if (paneStack.length > 1) paneStack.pop();
				break;
			case 'grs1':
				if (lastGroup) groupStack.push(lastGroup.children);
				break;
			case 'gre1':
				if (groupStack.length > 1) groupStack.pop();
				break;
			case 'grp1': {
				const v5 = header.versionMajor >= 5;
				const name = r.cstr(p, v5 ? 34 : 24);
				const n = r.u16(p + (v5 ? 34 : 24));
				const first = p + (v5 ? 36 : 28);
				const panes: string[] = [];
				for (let i = 0; i < n && first + (i + 1) * 24 <= s.start + s.size; i++) panes.push(r.cstr(first + i * 24, 24));
				lastGroup = { name, panes, children: [] };
				groupStack[groupStack.length - 1].push(lastGroup);
				break;
			}
			default:
				if (PANE_KINDS.has(s.magic)) {
					lastPane = readPane(r, s, out, header);
					paneStack[paneStack.length - 1].push(lastPane);
					out.paneCount++;
				}
		}
	}
	return out;
}

function readPane(r: Reader, s: Section, layout: ParsedBflyt, header: NwHeader): LayoutPane {
	const p = s.start + 8;
	const flags = r.u8(p);
	const pane: LayoutPane = {
		kind: s.magic as PaneKind,
		name: r.cstr(p + 4, 0x18),
		visible: (flags & 1) !== 0,
		alpha: r.u8(p + 2),
		translate: [r.f32(p + 0x24), r.f32(p + 0x28), r.f32(p + 0x2c)],
		rotate: [r.f32(p + 0x30), r.f32(p + 0x34), r.f32(p + 0x38)],
		scale: [r.f32(p + 0x3c), r.f32(p + 0x40)],
		width: r.f32(p + 0x44),
		height: r.f32(p + 0x48),
		children: [],
	};
	const q = p + 0x4c; // pane-type payload
	const end = s.start + s.size;
	const mat = (i: number) => (i !== 0xffff ? layout.materials[i] : undefined);
	try {
		if (s.magic === 'pic1' && q + 18 <= end) {
			pane.material = mat(r.u16(q + 16));
		} else if (s.magic === 'txt1' && q + 0x30 <= end) {
			pane.material = mat(r.u16(q + 4));
			const fontIndex = r.u16(q + 6);
			if (fontIndex !== 0xffff) pane.font = layout.fonts[fontIndex];
			const textOffset = r.u32(q + 16);
			const nameOffset = r.u32(q + 44);
			if (textOffset && s.start + textOffset < end) pane.text = r.wstr(s.start + textOffset);
			if (nameOffset && s.start + nameOffset < end) pane.textId = r.cstr(s.start + nameOffset);
		} else if (s.magic === 'wnd1' && q + 0x1c <= end) {
			// Window content material sits after the frame header; keep it simple.
		} else if (s.magic === 'prt1' && q + 12 <= end) {
			const props = r.u32(q);
			const nameAt = q + 12 + props * 0x28;
			if (props < 1024 && nameAt < end) pane.partLayout = r.cstr(nameAt);
		}
	} catch {
		// payload is best-effort; the common header is enough to list it
	}
	void header;
	return pane;
}

export function parseBflan(bytes: Uint8Array): ParsedBflan {
	const { r, header, sections } = readHeader(bytes, 'FLAN');
	const out: ParsedBflan = {
		header,
		tag: null,
		frameSize: 0,
		loop: false,
		textures: [],
		entries: [],
		sections: countSections(sections),
	};
	for (const s of sections) {
		const p = s.start + 8;
		if (s.magic === 'pat1') {
			const order = r.u16(p);
			const groupCount = r.u16(p + 2);
			const nameOffset = r.u32(p + 4);
			const groupsOffset = r.u32(p + 8);
			const fp = p + 12 + (header.versionMajor >= 8 ? 4 : 0);
			const groups: string[] = [];
			for (let i = 0; i < groupCount; i++) groups.push(r.cstr(s.start + groupsOffset + i * 28, 28));
			out.tag = {
				name: r.cstr(s.start + nameOffset),
				order,
				startFrame: r.i16(fp),
				endFrame: r.i16(fp + 2),
				childBinding: r.u8(fp + 4) !== 0,
				groups,
			};
		} else if (s.magic === 'pai1') {
			out.frameSize = r.u16(p);
			out.loop = r.u8(p + 2) !== 0;
			const texCount = r.u16(p + 4);
			const entryCount = r.u16(p + 6);
			const entryTable = s.start + r.u32(p + 8);
			const texTable = p + 12;
			for (let i = 0; i < texCount; i++) out.textures.push(r.cstr(texTable + r.u32(texTable + i * 4)));
			for (let i = 0; i < entryCount; i++) {
				const e = s.start + r.u32(entryTable + i * 4);
				const tagCount = r.u8(e + 28);
				const target = r.u8(e + 29);
				const tags: LayoutAnimTag[] = [];
				for (let t = 0; t < tagCount; t++) {
					let tp = e + r.u32(e + 32 + t * 4);
					if (target === 2) tp += 4; // user-data tags carry an extra u32 first
					const n = r.u8(tp + 4);
					let keys = 0;
					for (let k = 0; k < n; k++) {
						const ce = tp + r.u32(tp + 8 + k * 4);
						keys += r.u16(ce + 4);
					}
					tags.push({ tag: r.magic(tp), curves: n, keys });
				}
				out.entries.push({ name: r.cstr(e, 28), target, tags });
			}
		}
	}
	return out;
}
