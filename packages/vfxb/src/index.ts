/**
 * VFXB: NintendoWare's particle effect binary (`.ptcl`, BotW's
 * `.sesetlist`).
 *
 * The file is a tree of sections. Effect data comes first (`ESTA`
 * emitter-set table → `ESET` emitter sets → `EMTR` emitters), then the
 * graphics resources it uses: `GRTF` textures (an embedded BNTX), `GRSN`
 * / `GRSC` shaders and compute shaders (BNSH), and `G3PR` primitive
 * models (BFRES). Effects without their own textures leave `GRTF` empty
 * and use a shared resource instead.
 *
 * Header: "VFXB    " (8 bytes), u16 graphics version, u16 VFX version,
 * u16 BOM, u8 alignment, u8 target offset, u32 at 0x10 (0x20), u16 first
 * section offset at 0x16, u32 file size at 0x1C, then a short name ("Game")
 * at 0x20.
 *
 * Section header (0x20 bytes, offsets relative to the section start,
 * 0xFFFFFFFF = none), after Switch Toolbox's `VFXB.cs` and EffectLibrary:
 *
 *   0x00 magic, 0x04 u32 size, 0x08 u32 children offset,
 *   0x0C u32 next sibling offset, 0x10 u32 attribute offset,
 *   0x14 u32 binary offset, 0x18 u32, 0x1C u16 child count
 *
 * `ESET` and `EMTR` store their name at binary + 0x10. A resource section's
 * binary is the embedded file, recognised by its magic.
 */

export interface VfxbSection {
	magic: string;
	offset: number;
	size: number;
	/** Emitter set / emitter name, when the section has one. */
	name: string | null;
	children: VfxbSection[];
}

export interface VfxbResource {
	/** Owning section: GRTF, GRSN, GRSC or G3PR. */
	section: string;
	/** Embedded file's magic: BNTX, BNSH or FRES. */
	kind: 'BNTX' | 'BNSH' | 'FRES';
	offset: number;
	size: number;
}

export interface ParsedVfxb {
	graphicsVersion: number;
	vfxVersion: number;
	name: string;
	sections: VfxbSection[];
	resources: VfxbResource[];
	emitterSets: { name: string; emitters: string[] }[];
}

export function isVfxb(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === 'VFXB    ';
}

const NONE = 0xffffffff;
const NAMED = new Set(['ESET', 'EMTR']);

export function parseVfxb(bytes: Uint8Array): ParsedVfxb {
	if (!isVfxb(bytes)) throw new Error('Not a VFXB file (bad magic)');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint16(0x0c, true) !== 0xfeff) throw new Error('Big-endian VFXB is not supported');
	const graphicsVersion = v.getUint16(0x08, true);
	const vfxVersion = v.getUint16(0x0a, true);
	const headerSize = v.getUint16(0x16, true) || 0x40;
	const cstr = (off: number, max: number) => {
		let end = off;
		const limit = Math.min(bytes.length, off + max);
		while (end < limit && bytes[end] !== 0) end++;
		return new TextDecoder().decode(bytes.subarray(off, end));
	};
	const name = cstr(0x20, 0x20);
	const resources: VfxbResource[] = [];
	let visited = 0;

	// `count` bounds a child chain: a last child's "next" offset is just
	// its length, not a terminator. The top-level chain has no count and
	// ends at the first non-section.
	const readChain = (start: number, depth: number, count: number | null): VfxbSection[] => {
		const out: VfxbSection[] = [];
		let off = start;
		while (off >= 0 && off + 0x20 <= bytes.length && (count === null || out.length < count)) {
			if (++visited > 100_000 || depth > 32) throw new Error('VFXB section tree too large');
			const magic = String.fromCharCode(...bytes.subarray(off, off + 4));
			if (!/^[A-Z0-9_]{4}$/.test(magic)) {
				if (count === null && out.length > 0) break;
				throw new Error(`Bad VFXB section magic at 0x${off.toString(16)}`);
			}
			const size = v.getUint32(off + 4, true);
			const childOff = v.getUint32(off + 8, true);
			const nextOff = v.getUint32(off + 0x0c, true);
			const binOff = v.getUint32(off + 0x14, true);
			const bin = binOff === NONE ? -1 : off + binOff;
			const sectionName = NAMED.has(magic) && bin >= 0 ? cstr(bin + 0x10, 0x40) || null : null;
			if (bin >= 0 && bin + 8 <= bytes.length) {
				const inner = String.fromCharCode(...bytes.subarray(bin, bin + 4));
				if (inner === 'BNTX' || inner === 'BNSH' || inner === 'FRES') {
					const innerSize = v.getUint32(bin + 0x1c, true);
					const fileSize = innerSize > 0 && bin + innerSize <= bytes.length ? innerSize : Math.min(size, bytes.length - bin);
					resources.push({ section: magic, kind: inner, offset: bin, size: fileSize });
				}
			}
			const childCount = v.getUint16(off + 0x1c, true);
			const children = childOff === NONE || childCount === 0 ? [] : readChain(off + childOff, depth + 1, childCount);
			out.push({ magic, offset: off, size, name: sectionName, children });
			if (nextOff === NONE || nextOff === 0) break;
			off += nextOff;
		}
		return out;
	};
	const sections = readChain(headerSize, 0, null);

	const emitterSets: ParsedVfxb['emitterSets'] = [];
	const walk = (list: VfxbSection[]) => {
		for (const s of list) {
			if (s.magic === 'ESET') {
				const emitters: string[] = [];
				const collect = (l: VfxbSection[]) => {
					for (const c of l) {
						if (c.magic === 'EMTR' && c.name) emitters.push(c.name);
						collect(c.children);
					}
				};
				collect(s.children);
				emitterSets.push({ name: s.name ?? '', emitters });
			} else walk(s.children);
		}
	};
	walk(sections);
	return { graphicsVersion, vfxVersion, name, sections, resources, emitterSets };
}
