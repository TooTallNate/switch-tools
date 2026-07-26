import { describe, expect, it } from 'vitest';

import {
	HSD_ARCHIVE_ALIGNMENT,
	HSD_HEADER_SIZE,
	HSD_VTXDESC_SIZE,
	decodeHsdImage,
	hsdAllRoots,
	hsdJoints,
	hsdMesh,
	hsdImages,
	hsdRelocations,
	hsdRootKind,
	isHsd,
	isHsdHeader,
	parseHsdArchive,
	parseHsdFile,
} from '../src/index.js';

interface RootSpec { name: string; dataOffset?: number; extern?: boolean }
interface ArchiveSpec {
	dataSize?: number;
	relocations?: number[];
	roots?: RootSpec[];
	version?: string;
	/** Emit a size that disagrees with the real length, to test rejection. */
	declaredSize?: number;
}

/** Build one archive. */
function buildArchive(spec: ArchiveSpec = {}): Uint8Array {
	const dataSize = spec.dataSize ?? 64;
	const relocations = spec.relocations ?? [];
	const roots = spec.roots ?? [{ name: 'Test_joint' }];
	const normal = roots.filter((r) => !r.extern);
	const extern = roots.filter((r) => r.extern);

	const strings: number[] = [];
	const nameOffsets = new Map<string, number>();
	for (const r of [...normal, ...extern]) {
		nameOffsets.set(r.name, strings.length);
		for (const c of r.name) strings.push(c.charCodeAt(0));
		strings.push(0);
	}

	const size =
		HSD_HEADER_SIZE + dataSize + relocations.length * 4 + roots.length * 8 + strings.length;
	const out = new Uint8Array(size);
	const v = new DataView(out.buffer);
	v.setUint32(0x00, spec.declaredSize ?? size, false);
	v.setUint32(0x04, dataSize, false);
	v.setUint32(0x08, relocations.length, false);
	v.setUint32(0x0c, normal.length, false);
	v.setUint32(0x10, extern.length, false);
	if (spec.version) {
		for (let i = 0; i < 4 && i < spec.version.length; i++) {
			out[0x14 + i] = spec.version.charCodeAt(i);
		}
	}
	let at = HSD_HEADER_SIZE + dataSize;
	for (const r of relocations) { v.setUint32(at, r, false); at += 4; }
	for (const r of [...normal, ...extern]) {
		v.setUint32(at, r.dataOffset ?? 0, false);
		v.setUint32(at + 4, nameOffsets.get(r.name)!, false);
		at += 8;
	}
	out.set(new Uint8Array(strings), at);
	return out;
}

/** Concatenate archives at 32-byte aligned offsets, as animation files do. */
function buildChain(specs: ArchiveSpec[]): Uint8Array {
	const parts = specs.map(buildArchive);
	const align = (n: number) => (n + HSD_ARCHIVE_ALIGNMENT - 1) & ~(HSD_ARCHIVE_ALIGNMENT - 1);
	let total = 0;
	for (const p of parts) total += align(p.length);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) { out.set(p, at); at += align(p.length); }
	return out;
}

describe('parseHsdArchive', () => {
	it('derives the whole layout from the five counts', () => {
		const bytes = buildArchive({ dataSize: 32, relocations: [0, 4, 8] });
		const a = parseHsdArchive(bytes)!;
		expect(a).not.toBeNull();
		expect(a.dataOffset).toBe(HSD_HEADER_SIZE);
		expect(a.dataSize).toBe(32);
		expect(a.relocationOffset).toBe(HSD_HEADER_SIZE + 32);
		expect(a.relocationCount).toBe(3);
		expect(a.stringTableOffset).toBe(HSD_HEADER_SIZE + 32 + 12 + 8);
		expect(a.size).toBe(bytes.length);
	});

	it('accepts a non-zero version tag instead of treating it as corruption', () => {
		// The field at 0x14 is four ASCII characters, not flags. Rejecting a
		// non-zero value here throws away 179 valid files on the Melee disc.
		const a = parseHsdArchive(buildArchive({ version: '001B' }))!;
		expect(a).not.toBeNull();
		expect(a.version).toBe('001B');
		expect(parseHsdArchive(buildArchive())!.version).toBe('');
	});

	it('reads roots and extern roots with their names', () => {
		const a = parseHsdArchive(
			buildArchive({
				roots: [
					{ name: 'PlyFox_Share_joint', dataOffset: 16 },
					{ name: 'Other_figatree' },
					{ name: 'Ref_joint', extern: true },
				],
			}),
		)!;
		expect(a.roots).toHaveLength(3);
		expect(a.roots[0].name).toBe('PlyFox_Share_joint');
		expect(a.roots[0].dataOffset).toBe(16);
		expect(a.roots[0].absoluteOffset).toBe(a.dataOffset + 16);
		expect(a.roots[0].extern).toBe(false);
		// Extern roots come after the normal ones.
		expect(a.roots[2].extern).toBe(true);
		expect(a.roots[2].name).toBe('Ref_joint');
	});

	it('rejects a layout that does not fit the declared size', () => {
		expect(parseHsdArchive(new Uint8Array(HSD_HEADER_SIZE))).toBeNull();
		const bytes = buildArchive();
		const bad = bytes.slice();
		// Claim far more relocations than the archive can hold.
		new DataView(bad.buffer).setUint32(0x08, 0xffff, false);
		expect(parseHsdArchive(bad)).toBeNull();
	});

	it('rejects a size that overruns the buffer', () => {
		const bytes = buildArchive();
		const bad = bytes.slice();
		new DataView(bad.buffer).setUint32(0x00, bytes.length + 4096, false);
		expect(parseHsdArchive(bad)).toBeNull();
	});

	it('rejects noise', () => {
		expect(isHsd(new Uint8Array(256))).toBe(false);
		expect(isHsd(new Uint8Array(256).fill(0xff))).toBe(false);
		expect(isHsd(buildArchive())).toBe(true);
	});
});

describe('parseHsdFile', () => {
	it('yields a chain of one for a plain archive', () => {
		const f = parseHsdFile(buildArchive())!;
		expect(f.archives).toHaveLength(1);
		expect(f.complete).toBe(true);
	});

	it('walks concatenated archives at 32-byte alignment', () => {
		// Melee's animation files hold hundreds of these. Advancing by the raw
		// size rather than the aligned size desyncs on the second archive.
		const f = parseHsdFile(
			buildChain([
				{ roots: [{ name: 'A_figatree' }], dataSize: 20 },
				{ roots: [{ name: 'B_figatree' }], dataSize: 36 },
				{ roots: [{ name: 'C_figatree' }], dataSize: 8 },
			]),
		)!;
		expect(f.archives).toHaveLength(3);
		expect(f.complete).toBe(true);
		expect(hsdAllRoots(f).map((r) => r.name)).toEqual([
			'A_figatree',
			'B_figatree',
			'C_figatree',
		]);
		// Every archive after the first must begin on the alignment boundary.
		for (const a of f.archives) {
			expect(a.offset % HSD_ARCHIVE_ALIGNMENT).toBe(0);
		}
	});

	it('reports an incomplete walk rather than throwing', () => {
		const chain = buildChain([{ dataSize: 20 }, { dataSize: 20 }]);
		// Corrupt the second archive's header.
		const cut = chain.slice(0, chain.length - 8);
		const f = parseHsdFile(cut);
		expect(f).not.toBeNull();
		expect(f!.archives.length).toBeGreaterThanOrEqual(1);
	});

	it('returns null when nothing parses', () => {
		expect(parseHsdFile(new Uint8Array(64))).toBeNull();
	});
});

describe('hsdRelocations', () => {
	it('returns data-block-relative pointer offsets', () => {
		const bytes = buildArchive({ dataSize: 32, relocations: [0, 8, 28] });
		const a = parseHsdArchive(bytes)!;
		expect([...hsdRelocations(bytes, a)]).toEqual([0, 8, 28]);
	});
});

describe('hsdRootKind', () => {
	it('does not mistake animation trees for scene graphs', () => {
		// These end in _joint but are not joint trees; HSD_MatAnimJoint is a
		// twelve-byte { child, next, matanim } and walking it as a joint would
		// invent a transform from adjacent data.
		expect(hsdRootKind('PlyKirby5K_Share_matanim_joint')).toBe(
			'material animation',
		);
		expect(hsdRootKind('PlyFox_Share_shapeanim_joint')).toBe('shape animation');
		// The genuine scene-graph spellings must still come through.
		expect(hsdRootKind('PlyKirby5K_Share_joint')).toBe('scene graph');
		expect(hsdRootKind('map_top_joint')).toBe('scene graph');
		expect(hsdRootKind('map_topN_joint')).toBe('scene graph');
	});

	it('maps the naming convention to a readable label', () => {
		expect(hsdRootKind('PlyFox_Share_joint')).toBe('scene graph');
		expect(hsdRootKind('X_figatree')).toBe('animation');
		expect(hsdRootKind('X_camera')).toBe('camera');
		expect(hsdRootKind('X_animjoint')).toBe('joint animation');
		// Unknown suffixes pass through lowercased rather than being dropped.
		expect(hsdRootKind('X_weirdthing')).toBe('weirdthing');
		expect(hsdRootKind('noSuffix')).toBe('');
	});
});


describe('isHsdHeader', () => {
	it('validates from the first 32 bytes plus a known file size', () => {
		// `isHsd` needs the whole archive, so it cannot sniff a large file from
		// its head: the declared size dwarfs the slice and it always says no.
		const bytes = buildArchive({ dataSize: 64 });
		const head = bytes.subarray(0, 0x20);
		expect(isHsd(head)).toBe(false);
		expect(isHsdHeader(head, bytes.length)).toBe(true);
	});

	it('rejects a header whose layout overruns the declared size', () => {
		const bytes = buildArchive();
		const bad = bytes.slice(0, 0x20);
		new DataView(bad.buffer).setUint32(0x08, 0xffff, false);
		expect(isHsdHeader(bad, bytes.length)).toBe(false);
	});

	it('rejects an archive claiming to be larger than the file', () => {
		const bytes = buildArchive();
		const head = bytes.slice(0, 0x20);
		expect(isHsdHeader(head, 16)).toBe(false);
	});

	it('rejects a rootless archive and plain noise', () => {
		// Nothing to expose, so treating it as a container would be misleading.
		const bytes = buildArchive({ roots: [] });
		expect(isHsdHeader(bytes.subarray(0, 0x20), bytes.length)).toBe(false);
		expect(isHsdHeader(new Uint8Array(0x20), 1024)).toBe(false);
		expect(isHsdHeader(new Uint8Array(0x20).fill(0xff), 1 << 30)).toBe(false);
	});
});


describe('hsdJoints', () => {
	/**
	 * Build an archive containing a small joint tree.
	 *
	 * `relocate` controls which pointer fields are listed in the relocation
	 * table, so a test can present a word that looks like a pointer but isn't.
	 */
	function buildTree(relocate = true): Uint8Array {
		const J = 0x40;
		// root at 0, child at 0x40, child's sibling at 0x80.
		const dataSize = J * 3;
		const relocations: number[] = relocate ? [0x08, 0x40 + 0x0c] : [];
		const base = buildArchive({
			dataSize,
			relocations,
			roots: [{ name: 'Test_joint', dataOffset: 0 }],
		});
		const v = new DataView(base.buffer);
		const at = (n: number) => HSD_HEADER_SIZE + n;
		// root: child -> 0x40, scale (1,1,1)
		v.setUint32(at(0x08), 0x40, false);
		v.setFloat32(at(0x20), 1, false);
		v.setFloat32(at(0x24), 1, false);
		v.setFloat32(at(0x28), 1, false);
		// child: next -> 0x80, position (1,2,3)
		v.setUint32(at(0x40 + 0x0c), 0x80, false);
		v.setFloat32(at(0x40 + 0x2c), 1, false);
		v.setFloat32(at(0x40 + 0x30), 2, false);
		v.setFloat32(at(0x40 + 0x34), 3, false);
		return base;
	}

	it('walks children and siblings with correct depth and parentage', () => {
		const bytes = buildTree();
		const a = parseHsdArchive(bytes)!;
		const js = hsdJoints(bytes, a, 0);
		expect(js).toHaveLength(3);
		expect(js[0].depth).toBe(0);
		expect(js[0].parent).toBe(-1);
		// The child is one level deeper; its sibling shares its depth and parent.
		expect(js[1].depth).toBe(1);
		expect(js[1].parent).toBe(0);
		expect(js[2].depth).toBe(1);
		expect(js[2].parent).toBe(0);
	});

	it('reads the transform block at the on-disc offsets', () => {
		// The runtime HSD_JObj puts a quaternion here instead; using that layout
		// silently yields plausible nonsense.
		const bytes = buildTree();
		const a = parseHsdArchive(bytes)!;
		const js = hsdJoints(bytes, a, 0);
		expect(js[0].scale).toEqual([1, 1, 1]);
		expect(js[1].position).toEqual([1, 2, 3]);
	});

	it('follows only pointers the relocation table marks', () => {
		// Same bytes, but nothing declared as a pointer: the child and sibling
		// words are then just data that happens to look like offsets.
		const bytes = buildTree(false);
		const a = parseHsdArchive(bytes)!;
		expect(hsdJoints(bytes, a, 0)).toHaveLength(1);
	});

	it('terminates on a cycle instead of hanging', () => {
		const bytes = buildTree();
		const a = parseHsdArchive(bytes)!;
		// Point the child's sibling back at the root.
		new DataView(bytes.buffer).setUint32(HSD_HEADER_SIZE + 0x40 + 0x0c, 0, false);
		new DataView(bytes.buffer).setUint32(HSD_HEADER_SIZE + 0x08, 0x40, false);
		new DataView(bytes.buffer).setUint32(HSD_HEADER_SIZE + 0x40 + 0x08, 0, false);
		expect(() => hsdJoints(bytes, a, 0)).not.toThrow();
		expect(hsdJoints(bytes, a, 0).length).toBeLessThanOrEqual(3);
	});

	it('honours the node cap', () => {
		const bytes = buildTree();
		const a = parseHsdArchive(bytes)!;
		expect(hsdJoints(bytes, a, 0, 2)).toHaveLength(2);
	});
});


describe('hsdMesh', () => {
	/**
	 * Build an archive with one joint carrying a single triangle.
	 *
	 * Layout: joint at 0, DObjDesc at 0x40, PObjDesc at 0x50, VtxDescList at
	 * 0x70, positions at 0xB0, display list at 0xD0.
	 */
	function buildGeometry(
		primitive = 0x90,
		verts = 3,
		material: 'none' | 'rgb565' | 'paletted' = 'none',
		extraRelocations: number[] = [],
	): Uint8Array {
		const DATA = 0x200;
		// Material chain: MObjDesc at 0x100, TObjDesc at 0x120, ImageDesc at
		// 0x180, pixels at 0x1A0.
		const MOBJ = 0x100;
		const TOBJ = 0x120;
		const IMAGE = 0x180;
		const PIXELS = 0x1a0;
		const relocations = [
			0x10, // joint.dobjdesc
			0x40 + 0x0c, // dobj.pobjdesc
			0x50 + 0x08, // pobj.verts
			0x50 + 0x10, // pobj.display
			0x70 + 0x14, // vtxdesc[0].vertex
		];
		relocations.push(...extraRelocations);
		if (material !== 'none') {
			relocations.push(
				0x40 + 0x08, // dobj.mobjdesc
				MOBJ + 0x08, // mobj.texdesc
				TOBJ + 0x4c, // tobj.imagedesc
				IMAGE + 0x00, // imagedesc.image_ptr
			);
		}
		const base = buildArchive({
			dataSize: DATA,
			relocations,
			roots: [{ name: 'Test_joint', dataOffset: 0 }],
		});
		const v = new DataView(base.buffer);
		const at = (n: number) => HSD_HEADER_SIZE + n;
		// Unit scale, as real joints carry: a zero-filled joint would scale its
		// geometry to nothing once the transform is applied.
		v.setFloat32(at(0x20), 1, false);
		v.setFloat32(at(0x24), 1, false);
		v.setFloat32(at(0x28), 1, false);
		v.setUint32(at(0x10), 0x40, false); // joint -> dobj
		v.setUint32(at(0x40 + 0x0c), 0x50, false); // dobj -> pobj
		v.setUint32(at(0x50 + 0x08), 0x70, false); // pobj -> verts
		v.setUint16(at(0x50 + 0x0e), 1, false); // n_display (32-byte units)
		v.setUint32(at(0x50 + 0x10), 0xd0, false); // pobj -> display

		// One POS attribute: INDEX16, XYZ, s16, frac 0, stride 6.
		v.setUint32(at(0x70 + 0x00), 9, false); // GX_VA_POS
		v.setUint32(at(0x70 + 0x04), 3, false); // INDEX16
		v.setUint32(at(0x70 + 0x08), 1, false); // XYZ
		v.setUint32(at(0x70 + 0x0c), 3, false); // s16
		base[at(0x70 + 0x10)] = 0; // frac
		v.setUint16(at(0x70 + 0x12), 6, false); // stride
		v.setUint32(at(0x70 + 0x14), 0xb0, false); // vertex array
		v.setUint32(at(0x70 + HSD_VTXDESC_SIZE), 0xff, false); // terminator

		// Four positions, so a quad/strip has something to index.
		const pos: [number, number, number][] = [
			[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
		];
		pos.forEach((pv, i) => {
			v.setInt16(at(0xb0 + i * 6 + 0), pv[0], false);
			v.setInt16(at(0xb0 + i * 6 + 2), pv[1], false);
			v.setInt16(at(0xb0 + i * 6 + 4), pv[2], false);
		});

		if (material !== 'none') {
			v.setUint32(at(0x40 + 0x08), MOBJ, false); // dobj -> mobj
			v.setUint32(at(MOBJ + 0x08), TOBJ, false); // mobj -> texdesc
			v.setUint32(at(TOBJ + 0x4c), IMAGE, false); // tobj -> imagedesc
			v.setUint32(at(IMAGE + 0x00), PIXELS, false); // imagedesc -> pixels
			v.setUint16(at(IMAGE + 0x04), 4, false); // width
			v.setUint16(at(IMAGE + 0x06), 4, false); // height
			// RGB565 (4) needs no palette; C8 (9) does, and none is provided.
			v.setUint32(at(IMAGE + 0x08), material === 'rgb565' ? 4 : 9, false);
			for (let i = 0; i < 32; i++) base[at(PIXELS + i)] = 0x20 + i;
		}

		// Display list: one primitive over `verts` indices.
		base[at(0xd0)] = primitive;
		v.setUint16(at(0xd1), verts, false);
		for (let i = 0; i < verts; i++) v.setUint16(at(0xd3 + i * 2), i, false);
		return base;
	}

	it('extracts a triangle through joint -> dobj -> pobj -> display list', () => {
		const bytes = buildGeometry();
		const a = parseHsdArchive(bytes)!;
		const joints = hsdJoints(bytes, a, 0);
		const m = hsdMesh(bytes, a, joints)!;
		expect(m).not.toBeNull();
		expect(m.numVertices).toBe(3);
		expect([...m.indices]).toEqual([0, 1, 2]);
		expect([...m.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
	});

	it('places rigid geometry using the joint transform', () => {
		const bytes = buildGeometry();
		const v = new DataView(bytes.buffer);
		// Offset the joint; its vertices must move with it.
		v.setFloat32(HSD_HEADER_SIZE + 0x2c, 10, false);
		v.setFloat32(HSD_HEADER_SIZE + 0x30, -4, false);
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		expect([...m.positions]).toEqual([
			10, -4, 0, 11, -4, 0, 10, -3, 0,
		]);
	});

	it('places single-bone envelope geometry with the bone it names', () => {
		// Envelope layout: pointer array at 0x1C0 -> pair list at 0x1D0, whose
		// one pair names the bone joint at 0xE0 with full weight.
		const bytes = buildGeometry(0x90, 3, 'none', [
			0x08, // root.child -> bone
			0x50 + 0x14, // pobj.union -> envelope pointer array
			0x1c0, // pointer array entry 0 -> pair list
			0x1d0, // pair 0 joint -> bone
		])
		const v = new DataView(bytes.buffer)
		const at = (n: number) => HSD_HEADER_SIZE + n
		// The bone-local reading only applies under a skeleton root.
		v.setUint32(at(0x04), 1 << 1, false) // JOBJ_SKELETON_ROOT
		v.setUint16(at(0x50 + 0x0c), 0x2000, false) // pobj is an envelope
		v.setUint32(at(0x08), 0xe0, false) // root -> bone
		v.setFloat32(at(0xe0 + 0x20), 1, false) // bone unit scale
		v.setFloat32(at(0xe0 + 0x24), 1, false)
		v.setFloat32(at(0xe0 + 0x28), 1, false)
		v.setFloat32(at(0xe0 + 0x2c), 7, false) // bone x = 7
		v.setUint32(at(0x50 + 0x14), 0x1c0, false) // union -> pointer array
		v.setUint32(at(0x1c0), 0x1d0, false) // entry 0 -> pair list
		v.setUint32(at(0x1c4), 0, false) // pointer array terminator
		v.setUint32(at(0x1d0), 0xe0, false) // pair 0 joint = bone
		v.setFloat32(at(0x1d4), 1, false) // pair 0 weight = 1
		v.setUint32(at(0x1d8), 0, false) // pair list terminator

		const a = parseHsdArchive(bytes)!
		const joints = hsdJoints(bytes, a, 0)
		expect(joints).toHaveLength(2)
		const m = hsdMesh(bytes, a, joints)!
		// The bone's transform, not the owning joint's.
		expect([...m.positions]).toEqual([7, 0, 0, 8, 0, 0, 7, 1, 0])
	})

	it('refuses the envelope conventions it does not implement', () => {
		const bytes = buildGeometry(0x90, 3, 'none', [0x50 + 0x14])
		const v = new DataView(bytes.buffer)
		const at = (n: number) => HSD_HEADER_SIZE + n
		v.setUint16(at(0x50 + 0x0c), 0x2000, false) // envelope
		v.setUint32(at(0x50 + 0x14), 0x1c0, false) // with a union
		v.setFloat32(at(0x2c), 3, false) // owner x = 3
		// No JOBJ_SKELETON_ROOT: the bone-local reading does not apply, so this
		// falls back to the owner rather than inventing a transform.
		const a = parseHsdArchive(bytes)!
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!
		expect([...m.positions]).toEqual([3, 0, 0, 4, 0, 0, 3, 1, 0])
	})

	it('accumulates a child joint transform through its parent', () => {
		// The child pointers need their own relocation entries; reusing the
		// existing ones would break the display-object chain.
		const bytes = buildGeometry(0x90, 3, 'none', [0x08, 0xe0 + 0x10]);
		const v = new DataView(bytes.buffer);
		const at = (n: number) => HSD_HEADER_SIZE + n;
		// Reparent: root joint at 0 gains a child at 0xE0 that owns the geometry.
		v.setFloat32(at(0x2c), 10, false); // root x = 10
		v.setUint32(at(0x10), 0, false); // root has no geometry of its own
		v.setUint32(at(0x08), 0xe0, false); // root -> child
		v.setFloat32(at(0xe0 + 0x20), 1, false); // child unit scale
		v.setFloat32(at(0xe0 + 0x24), 1, false);
		v.setFloat32(at(0xe0 + 0x28), 1, false);
		v.setFloat32(at(0xe0 + 0x2c), 5, false); // child x = 5
		v.setUint32(at(0xe0 + 0x10), 0x40, false); // child -> dobj
		const a = parseHsdArchive(bytes)!;
		const joints = hsdJoints(bytes, a, 0);
		expect(joints).toHaveLength(2);
		const m = hsdMesh(bytes, a, joints)!;
		// 10 from the parent plus 5 from the child.
		expect(m.positions[0]).toBeCloseTo(15, 5);
	});

	it('bounds each display object with a section that tiles the indices', () => {
		const bytes = buildGeometry();
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		expect(m.sections).toHaveLength(1);
		expect(m.sections[0].indexOffset).toBe(0);
		expect(m.sections[0].indexCount).toBe(m.indices.length);
		// No material chain, so the section stays untextured rather than
		// pointing at a slot that doesn't exist.
		expect(m.sections[0].materialIndex).toBe(-1);
		expect(m.materials).toHaveLength(0);
	});

	it('resolves a texture through dobj -> mobj -> tobj -> imagedesc', () => {
		const bytes = buildGeometry(0x90, 3, 'rgb565');
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		expect(m.materials).toHaveLength(1);
		expect(m.sections[0].materialIndex).toBe(0);
		const mat = m.materials[0];
		expect(mat.width).toBe(4);
		expect(mat.height).toBe(4);
		expect(mat.format).toBe(4);
		// The resolved descriptor must actually decode.
		const img = decodeHsdImage(bytes, mat)!;
		expect(img).not.toBeNull();
		expect(img.pixels.length).toBe(4 * 4 * 4);
	});

	it('rejects a paletted image with no lookup table', () => {
		const bytes = buildGeometry(0x90, 3, 'paletted');
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		// A guessed palette would render as confident nonsense, so the slot is
		// dropped and the section renders untextured instead.
		expect(m.materials).toHaveLength(0);
		expect(m.sections[0].materialIndex).toBe(-1);
	});

	it('ignores a material pointer the relocation table does not mark', () => {
		const bytes = buildGeometry(0x90, 3, 'rgb565');
		const a = parseHsdArchive(bytes)!;
		// Strip the dobj.mobjdesc relocation; the field keeps its value.
		const relocAt = HSD_HEADER_SIZE + 0x200;
		const v = new DataView(bytes.buffer);
		for (let i = 0; i < a.relocationCount; i++) {
			if (v.getUint32(relocAt + i * 4, false) === 0x40 + 0x08) {
				v.setUint32(relocAt + i * 4, 0, false);
				break;
			}
		}
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		expect(m.materials).toHaveLength(0);
		expect(m.sections[0].materialIndex).toBe(-1);
	});

	it('alternates strip winding so faces are not inside-out', () => {
		const bytes = buildGeometry(0x98, 4); // triangle strip
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		// Second triangle swaps its first two indices.
		expect([...m.indices]).toEqual([0, 1, 2, 2, 1, 3]);
	});

	it('fans from the first vertex', () => {
		const bytes = buildGeometry(0xa0, 4);
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		// A fan over 0,1,2,3 is (0,1,2) then (0,2,3) — every triangle anchored
		// on the first vertex.
		expect([...m.indices]).toEqual([0, 1, 2, 0, 2, 3]);
	});

	it('applies the fixed-point fraction to integer components', () => {
		// frac 1 halves every coordinate; ignoring it is how models come out
		// orders of magnitude too large.
		const bytes = buildGeometry();
		bytes[HSD_HEADER_SIZE + 0x70 + 0x10] = 1;
		const a = parseHsdArchive(bytes)!;
		const m = hsdMesh(bytes, a, hsdJoints(bytes, a, 0))!;
		expect([...m.positions]).toEqual([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]);
	});

	it('returns null when a joint tree has no geometry', () => {
		const bytes = buildArchive({
			dataSize: 0x80,
			roots: [{ name: 'Empty_joint', dataOffset: 0 }],
		});
		const a = parseHsdArchive(bytes)!;
		expect(hsdMesh(bytes, a, hsdJoints(bytes, a, 0))).toBeNull();
	});
});

describe('hsdImages palette recovery', () => {
	/**
	 * An archive with one paletted image whose `TlutDesc` is reachable only by
	 * name. Nothing points at the `ImageDesc`, so the adjacent-word route — the
	 * one that resolves 94% of palettes — has nothing to read here.
	 */
	function buildPaletted(opts: { descName?: string | null } = {}): Uint8Array {
		const dataSize = 0x100
		const data = new Uint8Array(dataSize)
		const dv = new DataView(data.buffer)
		// ImageDesc at 0x00 -> pixels at 0x80, 8x8, format 8 (C4).
		dv.setUint32(0x00, 0x80, false)
		dv.setUint16(0x04, 8, false)
		dv.setUint16(0x06, 8, false)
		dv.setUint32(0x08, 8, false)
		// TlutDesc at 0x20 -> palette at 0xC0, format 0, 16 entries.
		dv.setUint32(0x20, 0xc0, false)
		dv.setUint32(0x24, 0, false)
		dv.setUint16(0x2c, 16, false)

		const roots: RootSpec[] = [{ name: 'Foo_C4_image', dataOffset: 0x80 }]
		if (opts.descName !== null) {
			roots.push({ name: opts.descName ?? 'Foo_tlut_desc', dataOffset: 0x20 })
		}
		const archive = buildArchive({ dataSize, relocations: [0x00], roots })
		archive.set(data, HSD_HEADER_SIZE)
		return archive
	}

	it('finds a palette named after the image without its format token', () => {
		const bytes = buildPaletted()
		const file = parseHsdFile(bytes)!
		const images = hsdImages(bytes, file.archives[0])
		expect(images).toHaveLength(1)
		expect(images[0].palette).toEqual({ offset: HSD_HEADER_SIZE + 0xc0, format: 0, count: 16 })
	})

	it('leaves the image unpaletted when no such root exists', () => {
		// Better than attaching the wrong palette: a paletted image decoded with
		// someone else's colours renders as confident nonsense rather than
		// visibly failing.
		const bytes = buildPaletted({ descName: null })
		const file = parseHsdFile(bytes)!
		const images = hsdImages(bytes, file.archives[0])
		expect(images[0].palette).toBeUndefined()
	})

	it('does not match a palette root that keeps the format token', () => {
		// The convention is that the image root spells out its format and the
		// palette root does not; looking for the token-preserving spelling is
		// what made these look unrecoverable.
		const bytes = buildPaletted({ descName: 'Foo_C4_tlut_desc' })
		const file = parseHsdFile(bytes)!
		expect(hsdImages(bytes, file.archives[0])[0].palette).toBeUndefined()
	})
})
