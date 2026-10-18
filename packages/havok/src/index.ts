/**
 * Havok binary packfiles: the physics, navmesh, cloth and ragdoll data of
 * many games (BotW's `.hkrb` rigid bodies, `.hkcl` cloth, `.hkrg` ragdolls,
 * `.shksc` static compounds, `.shknm2` navmeshes, `.shktmrb` terrain).
 *
 * This reads the container, not the objects. It reports the SDK version,
 * the sections, and every object's class, plus the names stored in the
 * data. Object layouts vary per SDK version and class, so decoding them
 * is out of scope.
 *
 * Layout (little-endian, as written by `hkPackfileWriter`; documented
 * by HavokLib, hkxpack and the Havok 2010 SDK headers):
 *
 *   0x00  u32 magic0 0x57E0E057, u32 magic1 0x10C0C010
 *   0x08  i32 user tag, i32 file version (8–11)
 *   0x10  u8 layout rules[4]: pointer size, little-endian, reuse padding, empty base class
 *   0x14  i32 section count
 *   0x18  i32 contents section index, i32 contents offset
 *   0x20  i32 class-name section index, i32 class-name offset
 *   0x28  char[16] contents version ("hk_2014.2.0-r1")
 *   0x38  i32 flags; version 11 adds u16 max predicate and u16 predicate size
 *   then one header per section (0x30 bytes, 0x40 from version 11 on):
 *         char[19] tag + 0xFF sentinel, then u32 absolute data start and
 *         the local / global / virtual fixup, exports, imports and end
 *         offsets (relative to the data start)
 *
 * The `__classnames__` section holds { u32 signature, u8 0x09, NUL name }
 * records. Each section's virtual fixups are { u32 object offset, u32
 * class-name section, u32 name offset } triples ending at 0xFFFFFFFF.
 * There is one per object, naming its class.
 */

export const HAVOK_MAGIC0 = 0x57e0e057;
export const HAVOK_MAGIC1 = 0x10c0c010;

export interface HavokSection {
	tag: string;
	dataStart: number;
	dataSize: number;
	/** Objects in this section, by class name. */
	objects: { offset: number; className: string }[];
}

export interface ParsedHavok {
	fileVersion: number;
	contentsVersion: string;
	pointerSize: number;
	littleEndian: boolean;
	sections: HavokSection[];
	/** The root object's class (usually `hkRootLevelContainer`). */
	contentsClass: string | null;
	/** Object count per class, most common first. */
	classCounts: [string, number][];
	/** Printable names found in the data sections (object and bone names). */
	names: string[];
}

export function isHavokPackfile(bytes: Uint8Array): boolean {
	if (bytes.length < 8) return false;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return v.getUint32(0, true) === HAVOK_MAGIC0 && v.getUint32(4, true) === HAVOK_MAGIC1;
}

function cstr(bytes: Uint8Array, off: number, max: number): string {
	let end = off;
	const limit = Math.min(bytes.length, off + max);
	while (end < limit && bytes[end] !== 0 && bytes[end] !== 0xff) end++;
	return String.fromCharCode(...bytes.subarray(off, end));
}

export function parseHavok(bytes: Uint8Array): ParsedHavok {
	if (!isHavokPackfile(bytes)) throw new Error('Not a Havok packfile (bad magic)');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const littleEndian = bytes[0x11] === 1;
	if (!littleEndian) throw new Error('Big-endian Havok packfiles are not supported');
	const fileVersion = v.getInt32(0x0c, true);
	const pointerSize = bytes[0x10]!;
	const numSections = v.getInt32(0x14, true);
	const contentsSection = v.getInt32(0x18, true);
	const contentsOffset = v.getInt32(0x1c, true);
	const contentsVersion = cstr(bytes, 0x28, 16);
	if (numSections < 0 || numSections > 64) throw new Error(`Bad Havok section count ${numSections}`);
	const headerSize = fileVersion >= 11 ? 0x40 : 0x30;
	// Version 11 can store a predicate array between the header and the
	// section headers; its padded size is the u16 at 0x3E.
	const first = 0x40 + (fileVersion >= 11 ? v.getUint16(0x3e, true) : 0);

	type Raw = { tag: string; start: number; local: number; global: number; virt: number; exports: number; end: number };
	const raws: Raw[] = [];
	for (let i = 0; i < numSections; i++) {
		const o = first + i * headerSize;
		if (o + 0x30 > bytes.length) throw new Error('Havok section header out of range');
		raws.push({
			tag: cstr(bytes, o, 19),
			start: v.getUint32(o + 0x14, true),
			local: v.getUint32(o + 0x18, true),
			global: v.getUint32(o + 0x1c, true),
			virt: v.getUint32(o + 0x20, true),
			exports: v.getUint32(o + 0x24, true),
			end: v.getUint32(o + 0x2c, true),
		});
	}

	const classNameAt = (section: number, off: number): string => {
		const s = raws[section];
		if (!s) return '?';
		return cstr(bytes, s.start + off, 128) || '?';
	};

	const sections: HavokSection[] = raws.map((s) => {
		const objects: HavokSection['objects'] = [];
		// Virtual fixups run from `virt` to `exports`.
		for (let o = s.start + s.virt; o + 12 <= s.start + s.exports && o + 12 <= bytes.length; o += 12) {
			const src = v.getUint32(o, true);
			if (src === 0xffffffff) continue;
			objects.push({ offset: src, className: classNameAt(v.getUint32(o + 4, true), v.getUint32(o + 8, true)) });
		}
		return { tag: s.tag, dataStart: s.start, dataSize: s.local, objects };
	});

	const counts = new Map<string, number>();
	for (const s of sections) for (const o of s.objects) counts.set(o.className, (counts.get(o.className) ?? 0) + 1);
	const contentsClass =
		sections[contentsSection]?.objects.find((o) => o.offset === contentsOffset)?.className ?? null;

	// Names: printable runs in the data sections that aren't class names.
	const classNames = new Set(counts.keys());
	const names: string[] = [];
	const seen = new Set<string>();
	for (const s of sections) {
		if (s.tag === '__classnames__' || s.tag === '__types__') continue;
		let start = -1;
		const end = Math.min(bytes.length, s.dataStart + s.dataSize);
		for (let i = s.dataStart; i < end; i++) {
			const c = bytes[i]!;
			const printable = c >= 0x20 && c < 0x7f;
			if (printable) {
				if (start < 0) start = i;
				continue;
			}
			if (c === 0 && start >= 0 && i - start >= 3) {
				const str = String.fromCharCode(...bytes.subarray(start, i));
				if (/^[A-Za-z_][\w .:\-/@]*$/.test(str) && !classNames.has(str) && !seen.has(str)) {
					seen.add(str);
					names.push(str);
				}
			}
			start = -1;
		}
	}

	return {
		fileVersion,
		contentsVersion,
		pointerSize,
		littleEndian,
		sections,
		contentsClass,
		classCounts: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
		names,
	};
}
