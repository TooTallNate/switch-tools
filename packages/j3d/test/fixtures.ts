/**
 * Synthetic J3D fixture builders.
 *
 * Every byte in this test suite is generated here, in code. No commercial game
 * data is used anywhere. The builders deliberately mirror the *wire* layout —
 * including the rule that offsets stored inside a chunk are relative to the
 * chunk's magic, 8 bytes before its payload — so a test that builds a fixture
 * and parses it is exercising the real format rather than agreeing with itself.
 *
 * The {@link Writer} starts at offset 0 == the chunk's magic, which means
 * `w.length` is *already* a chunk-relative offset at any point. That's the whole
 * trick that keeps these builders readable.
 */

import { GxAttr, GxAttrType, GxPrimitive, vtx1SlotForAttribute } from '../src/index.js';

/** Growable big-endian byte writer with after-the-fact patching. */
export class Writer {
	private buf: number[] = [];
	private readonly scratch = new DataView(new ArrayBuffer(4));

	get length(): number {
		return this.buf.length;
	}

	u8(v: number): this {
		this.buf.push(v & 0xff);
		return this;
	}

	u16(v: number): this {
		this.buf.push((v >> 8) & 0xff, v & 0xff);
		return this;
	}

	s16(v: number): this {
		return this.u16(v < 0 ? v + 0x10000 : v);
	}

	u32(v: number): this {
		this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
		return this;
	}

	f32(v: number): this {
		this.scratch.setFloat32(0, v, false);
		for (let i = 0; i < 4; i++) this.buf.push(this.scratch.getUint8(i));
		return this;
	}

	ascii(s: string): this {
		for (let i = 0; i < s.length; i++) this.buf.push(s.charCodeAt(i) & 0xff);
		return this;
	}

	/** NUL-terminated string. */
	cstr(s: string): this {
		return this.ascii(s).u8(0);
	}

	bytes(b: Uint8Array | readonly number[]): this {
		for (let i = 0; i < b.length; i++) this.buf.push(b[i] & 0xff);
		return this;
	}

	fill(count: number, value = 0): this {
		for (let i = 0; i < count; i++) this.buf.push(value & 0xff);
		return this;
	}

	align(to: number, value = 0): this {
		while (this.buf.length % to !== 0) this.buf.push(value & 0xff);
		return this;
	}

	patchU8(pos: number, v: number): this {
		this.buf[pos] = v & 0xff;
		return this;
	}

	patchU16(pos: number, v: number): this {
		this.buf[pos] = (v >> 8) & 0xff;
		this.buf[pos + 1] = v & 0xff;
		return this;
	}

	patchU32(pos: number, v: number): this {
		this.buf[pos] = (v >>> 24) & 0xff;
		this.buf[pos + 1] = (v >>> 16) & 0xff;
		this.buf[pos + 2] = (v >>> 8) & 0xff;
		this.buf[pos + 3] = v & 0xff;
		return this;
	}

	toUint8Array(): Uint8Array {
		return new Uint8Array(this.buf);
	}
}

/** Big-endian f32 as four bytes, for building raw vertex arrays. */
export function f32Bytes(...values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], false);
	return out;
}

/** Big-endian s16 as two bytes. */
export function s16Bytes(...values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < values.length; i++) view.setInt16(i * 2, values[i], false);
	return out;
}

/** Big-endian u16 as two bytes. */
export function u16Bytes(...values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i], false);
	return out;
}

/** Signed 8-bit bytes. */
export function s8Bytes(...values: number[]): Uint8Array {
	const out = new Uint8Array(values.length);
	for (let i = 0; i < values.length; i++) out[i] = values[i] & 0xff;
	return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** Pack RGB565 from 8-bit channels (truncating), as the GP stores it. */
export function rgb565(r: number, g: number, b: number): number {
	return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface ContainerOptions {
	magic?: string;
	/** Override the header's chunkCount (defaults to `chunks.length`). */
	chunkCount?: number;
	/** Override the header's fileSize. */
	fileSize?: number;
	/** Extra trailing garbage, as an extractor might leave behind. */
	trailing?: number;
}

/**
 * Assemble a J3D file from pre-built chunks.
 *
 * The 16 padding bytes get the real-world 'SVR3' tag plus 0xFF fill, because
 * that's what retail files contain and a reader that trips over it should fail
 * here rather than on someone's Wind Waker rip.
 */
export function buildContainer(
	chunks: Uint8Array[],
	opts: ContainerOptions = {},
): Uint8Array {
	const w = new Writer();
	w.ascii(opts.magic ?? 'J3D2bmd3');
	const sizePos = w.length;
	w.u32(0);
	w.u32(opts.chunkCount ?? chunks.length);
	w.ascii('SVR3');
	w.fill(12, 0xff);
	for (const c of chunks) w.bytes(c);
	if (opts.trailing) w.fill(opts.trailing, 0xcc);
	w.patchU32(sizePos, opts.fileSize ?? w.length - (opts.trailing ?? 0));
	return w.toUint8Array();
}

export interface ChunkOptions {
	/** Pad the chunk out to a multiple of 32 bytes, as retail files do. */
	pad32?: boolean;
	/** Write this instead of the true size, to test the walk's guards. */
	sizeOverride?: number;
}

/**
 * Build one chunk. `build` receives a writer already positioned just past the
 * 8-byte chunk header, so any `w.length` it records is chunk-relative — exactly
 * what the format's offset fields want.
 */
export function buildChunk(
	magic: string,
	build: (w: Writer) => void,
	opts: ChunkOptions = {},
): Uint8Array {
	const w = new Writer();
	w.ascii(magic);
	w.u32(0);
	build(w);
	if (opts.pad32) w.align(32);
	w.patchU32(4, opts.sizeOverride ?? w.length);
	return w.toUint8Array();
}

/** A chunk with a plausible magic and nothing but filler inside. */
export function buildFillerChunk(magic: string, payloadSize = 16): Uint8Array {
	return buildChunk(magic, (w) => w.fill(payloadSize, 0xaa));
}

/** A J3D string table: `u16 count, u16 0xFFFF`, hash/offset pairs, then strings. */
export function writeStringTable(w: Writer, names: readonly string[]): void {
	const start = w.length;
	w.u16(names.length);
	w.u16(0xffff);
	const entries = w.length;
	for (let i = 0; i < names.length; i++) {
		w.u16(0);
		w.u16(0);
	}
	for (let i = 0; i < names.length; i++) {
		// Nintendo's hash is the same *3 rule RARC uses; we write a real one so
		// the fixture is byte-plausible even though the reader ignores it.
		let hash = 0;
		for (let c = 0; c < names[i].length; c++) {
			hash = (hash * 3 + (names[i].charCodeAt(c) & 0xff)) & 0xffff;
		}
		w.patchU16(entries + i * 4 + 0, hash);
		w.patchU16(entries + i * 4 + 2, w.length - start);
		w.cstr(names[i]);
	}
}

// ---------------------------------------------------------------------------
// VTX1
// ---------------------------------------------------------------------------

export interface VtxArraySpec {
	attribute: number;
	componentCount: number;
	componentType: number;
	decimalPoint?: number;
	/** Raw array bytes, exactly as they'd appear in the file. */
	data: Uint8Array;
}

/**
 * Build a `VTX1` chunk.
 *
 * Arrays are written back-to-back with no padding between them, which is what
 * makes the "length = next offset - this offset" inference exact. By default the
 * chunk itself isn't padded either, so the *last* array's length is exact too;
 * pass `pad32` to reproduce the retail layout where trailing alignment inflates
 * the last array's apparent element count.
 */
export function buildVtx1(
	specs: readonly VtxArraySpec[],
	opts: ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'VTX1',
		(w) => {
			const formatPos = w.length;
			w.u32(0);
			const slotsPos = w.length;
			for (let i = 0; i < 13; i++) w.u32(0);

			w.patchU32(formatPos, w.length);
			for (const s of specs) {
				w.u32(s.attribute);
				w.u32(s.componentCount);
				w.u32(s.componentType);
				w.u8(s.decimalPoint ?? 0);
				w.fill(3, 0);
			}
			// GX_VA_NULL terminator.
			w.u32(GxAttr.NULL).u32(0).u32(0).u8(0).fill(3, 0);

			for (const s of specs) {
				const slot = vtx1SlotForAttribute(s.attribute);
				w.patchU32(slotsPos + slot * 4, w.length);
				w.bytes(s.data);
			}
		},
		opts,
	);
}

// ---------------------------------------------------------------------------
// SHP1
// ---------------------------------------------------------------------------

export interface PrimSpec {
	/** A `GxPrimitive` opcode (VAT bits are OR-ed in by the builder). */
	type: number;
	/** One row per vertex; one index per attribute, in descriptor order. */
	verts: readonly (readonly number[])[];
	/** OR this into the opcode, to prove the VAT bits are masked off. */
	vat?: number;
}

export interface ShapeSpec {
	attributes: readonly { attribute: number; attrType: number }[];
	/** Packets, each a list of primitives. */
	packets: readonly (readonly PrimSpec[])[];
	matrixType?: number;
	/** Pad each display list to a multiple of 32 bytes with GX_NOPs. */
	padPackets?: boolean;
	/** Declare each packet this many bytes shorter than it really is. */
	truncatePacketBy?: number;
	/** Overwrite the first opcode of the first packet with this byte. */
	badOpcode?: number;
}

/**
 * Bytes one attribute occupies in a display-list vertex.
 *
 * An unrecognised type writes nothing, so a fixture can deliberately contain a
 * bogus descriptor for the parser to reject.
 */
function attrWidth(attrType: number): number {
	switch (attrType) {
		case GxAttrType.DIRECT:
		case GxAttrType.INDEX8:
			return 1;
		case GxAttrType.INDEX16:
			return 2;
		default:
			return 0;
	}
}

/** Build a `SHP1` chunk from a description of its shapes' display lists. */
export function buildShp1(
	shapes: readonly ShapeSpec[],
	opts: ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'SHP1',
		(w) => {
			w.u16(shapes.length);
			w.u16(0xffff);
			const offPos = w.length;
			for (let i = 0; i < 8; i++) w.u32(0);

			// Attribute-table byte offsets and packet indices are simple running
			// totals, so they can be computed before anything is written.
			const attribOffsets: number[] = [];
			const firstPacket: number[] = [];
			let attribCursor = 0;
			let packetCursor = 0;
			for (const s of shapes) {
				attribOffsets.push(attribCursor);
				attribCursor += (s.attributes.length + 1) * 8;
				firstPacket.push(packetCursor);
				packetCursor += s.packets.length;
			}
			const totalPackets = packetCursor;

			const shapeOffset = w.length;
			for (let i = 0; i < shapes.length; i++) {
				const s = shapes[i];
				w.u8(s.matrixType ?? 0);
				w.u8(0xff);
				w.u16(s.packets.length);
				w.u16(attribOffsets[i]);
				w.u16(firstPacket[i]); // firstMatrixData
				w.u16(firstPacket[i]); // firstPacketLocation
				w.u16(0xffff);
				w.f32(1.75); // bounding sphere radius
				w.f32(-1).f32(-2).f32(-3); // bboxMin
				w.f32(1).f32(2).f32(3); // bboxMax
			}

			const remapOffset = w.length;
			for (let i = 0; i < shapes.length; i++) w.u16(i);
			w.align(4);

			const attributeOffset = w.length;
			for (const s of shapes) {
				for (const a of s.attributes) w.u32(a.attribute).u32(a.attrType);
				w.u32(GxAttr.NULL).u32(GxAttrType.NONE);
			}

			// One-entry bone set per packet, which is what a rigid shape looks like.
			const matrixTableOffset = w.length;
			for (let i = 0; i < totalPackets; i++) w.u16(i);
			w.align(4);

			const matrixDataOffset = w.length;
			for (let i = 0; i < totalPackets; i++) {
				w.u16(0xffff).u16(1).u32(i);
			}

			const packetLocationOffset = w.length;
			for (let i = 0; i < totalPackets; i++) w.u32(0).u32(0);

			const primitiveDataOffset = w.length;
			let pk = 0;
			let firstOpcodePos = -1;
			for (const s of shapes) {
				const widths = s.attributes.map((a) => attrWidth(a.attrType));
				for (const packet of s.packets) {
					const start = w.length;
					for (const prim of packet) {
						if (firstOpcodePos < 0) firstOpcodePos = w.length;
						w.u8(prim.type | (prim.vat ?? 0));
						w.u16(prim.verts.length);
						for (const vert of prim.verts) {
							for (let a = 0; a < widths.length; a++) {
								if (widths[a] === 1) w.u8(vert[a] ?? 0);
								else if (widths[a] === 2) w.u16(vert[a] ?? 0);
							}
						}
					}
					// Display lists are padded to a multiple of 32 bytes *from their
					// own start*, since that's the unit the CP's FIFO reads in.
					if (s.padPackets) {
						while ((w.length - start) % 32 !== 0) w.u8(0);
					}
					const size = w.length - start - (s.truncatePacketBy ?? 0);
					w.patchU32(packetLocationOffset + pk * 8 + 0, size);
					w.patchU32(
						packetLocationOffset + pk * 8 + 4,
						start - primitiveDataOffset,
					);
					pk++;
				}
			}
			if (
				shapes.length > 0 &&
				shapes[0].badOpcode !== undefined &&
				firstOpcodePos >= 0
			) {
				w.patchU8(firstOpcodePos, shapes[0].badOpcode);
			}

			w.patchU32(offPos + 0x00, shapeOffset);
			w.patchU32(offPos + 0x04, remapOffset);
			w.patchU32(offPos + 0x08, 0); // no name table, as in retail files
			w.patchU32(offPos + 0x0c, attributeOffset);
			w.patchU32(offPos + 0x10, matrixTableOffset);
			w.patchU32(offPos + 0x14, primitiveDataOffset);
			w.patchU32(offPos + 0x18, matrixDataOffset);
			w.patchU32(offPos + 0x1c, packetLocationOffset);
		},
		opts,
	);
}

/** A one-attribute (POS via INDEX16) shape drawing `count` strip vertices. */
export function simpleStripShape(count: number): ShapeSpec {
	const verts: number[][] = [];
	for (let i = 0; i < count; i++) verts.push([i]);
	return {
		attributes: [{ attribute: GxAttr.POS, attrType: GxAttrType.INDEX16 }],
		packets: [[{ type: GxPrimitive.TRIANGLESTRIP, verts }]],
	};
}

// ---------------------------------------------------------------------------
// INF1
// ---------------------------------------------------------------------------

export interface Inf1NodeSpec {
	type: number;
	index: number;
}

export function buildInf1(
	nodes: readonly Inf1NodeSpec[],
	opts: { vertexCount?: number; matrixGroupCount?: number } & ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'INF1',
		(w) => {
			w.u16(1); // loadFlags
			w.u16(0xffff);
			w.u32(opts.matrixGroupCount ?? 1);
			w.u32(opts.vertexCount ?? 0);
			const hierarchyPos = w.length;
			w.u32(0);
			w.patchU32(hierarchyPos, w.length);
			for (const n of nodes) w.u16(n.type).u16(n.index);
			w.u16(0).u16(0); // terminator
		},
		opts,
	);
}

// ---------------------------------------------------------------------------
// TEX1
// ---------------------------------------------------------------------------

export interface TextureSpec {
	name: string;
	format: number;
	width: number;
	height: number;
	/** Raw, already-tiled image data. */
	data: Uint8Array;
}

/**
 * Build a `TEX1` chunk.
 *
 * The 0x20-byte header is a BTI header, and its `dataOffset` is relative to the
 * header's own start — so each texture's pixel data offset is computed from the
 * header position, not from the chunk.
 */
export function buildTex1(
	textures: readonly TextureSpec[],
	opts: ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'TEX1',
		(w) => {
			w.u16(textures.length);
			w.u16(0xffff);
			const headerPos = w.length;
			w.u32(0);
			const namePos = w.length;
			w.u32(0);
			w.align(32);

			const headerOffset = w.length;
			w.patchU32(headerPos, headerOffset);
			for (let i = 0; i < textures.length; i++) w.fill(0x20, 0);

			w.patchU32(namePos, w.length);
			writeStringTable(
				w,
				textures.map((t) => t.name),
			);
			w.align(32);

			for (let i = 0; i < textures.length; i++) {
				const t = textures[i];
				const h = headerOffset + i * 0x20;
				const dataOffset = w.length;
				w.patchU32(h + 0x1c, dataOffset - h);
				w.bytes(t.data);
				w.align(32);

				// Fill in the rest of the BTI header now that we know where the
				// pixels landed.
				w.patchU16(h + 0x00, (t.format << 8) | 0x00); // format, alphaEnabled
				w.patchU16(h + 0x02, t.width);
				w.patchU16(h + 0x04, t.height);
				w.patchU16(h + 0x06, 0x0101); // wrapS = wrapT = REPEAT
				w.patchU16(h + 0x08, 0x0000); // paletteEnabled = 0, paletteFormat = 0
				w.patchU16(h + 0x0a, 0); // paletteCount
				w.patchU32(h + 0x0c, 0); // paletteOffset
				w.patchU32(h + 0x10, 0); // borderColor
				w.patchU16(h + 0x14, 0x0101); // min/mag filter = linear
				w.patchU16(h + 0x18, 0x0100); // mipmapCount = 1
			}
		},
		opts,
	);
}

// ---------------------------------------------------------------------------
// MAT3
// ---------------------------------------------------------------------------

export interface MaterialSpec {
	name: string;
	/**
	 * Per-GX-slot indices into the chunk's texture-index table, 0xFFFF for
	 * "unused". Note this is the *inner* indirection: the table entry it lands
	 * on is the actual `TEX1` index.
	 */
	textureSlots: readonly number[];
}

/**
 * Build a `MAT3` chunk holding just enough structure for the texture
 * indirection: entries, the remap table, names, and the texture-index table.
 *
 * The texture-index table is written last so its length is bounded by the end
 * of the chunk, matching how the parser infers table lengths.
 */
export function buildMat3(
	materials: readonly MaterialSpec[],
	textureIndexTable: readonly number[],
	opts: { entryCount?: number; remap?: readonly number[] } & ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'MAT3',
		(w) => {
			w.u16(materials.length);
			w.u16(0xffff);
			const offPos = w.length;
			for (let i = 0; i < 30; i++) w.u32(0);

			const remap = opts.remap ?? materials.map((_, i) => i);
			let entryCount = opts.entryCount ?? 0;
			for (const r of remap) entryCount = Math.max(entryCount, r + 1);

			const entryOffset = w.length;
			for (let e = 0; e < entryCount; e++) w.fill(0x14c, 0);
			// Fill in the texture slots of each *entry* via the remap table.
			for (let i = 0; i < materials.length; i++) {
				const base = entryOffset + remap[i] * 0x14c + 0x84;
				for (let s = 0; s < 8; s++) {
					w.patchU16(base + s * 2, materials[i].textureSlots[s] ?? 0xffff);
				}
			}

			const remapOffset = w.length;
			for (const r of remap) w.u16(r);
			w.align(4);

			const nameOffset = w.length;
			writeStringTable(
				w,
				materials.map((m) => m.name),
			);
			w.align(4);

			const textureIndexOffset = w.length;
			for (const t of textureIndexTable) w.u16(t);

			w.patchU32(offPos + 0x00, entryOffset);
			w.patchU32(offPos + 0x04, remapOffset);
			w.patchU32(offPos + 0x08, nameOffset);
			w.patchU32(offPos + 15 * 4, textureIndexOffset);
		},
		opts,
	);
}

// ---------------------------------------------------------------------------
// JNT1 / EVP1 / DRW1
// ---------------------------------------------------------------------------

export interface JointSpec {
	name: string;
	scale?: readonly [number, number, number];
	/** Raw s16 binary angles. */
	rotation?: readonly [number, number, number];
	translation?: readonly [number, number, number];
}

export function buildJnt1(
	joints: readonly JointSpec[],
	opts: ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'JNT1',
		(w) => {
			w.u16(joints.length);
			w.u16(0xffff);
			const offPos = w.length;
			w.u32(0).u32(0).u32(0);

			w.patchU32(offPos + 0x00, w.length);
			for (const j of joints) {
				w.u16(0); // matrixType
				w.u8(1); // inheritScale
				w.u8(0xff);
				const s = j.scale ?? [1, 1, 1];
				w.f32(s[0]).f32(s[1]).f32(s[2]);
				const r = j.rotation ?? [0, 0, 0];
				w.s16(r[0]).s16(r[1]).s16(r[2]);
				w.u16(0xffff);
				const t = j.translation ?? [0, 0, 0];
				w.f32(t[0]).f32(t[1]).f32(t[2]);
				w.f32(10); // bounding sphere radius
				w.f32(-1).f32(-1).f32(-1);
				w.f32(1).f32(1).f32(1);
			}

			w.patchU32(offPos + 0x04, w.length);
			for (let i = 0; i < joints.length; i++) w.u16(i);
			w.align(4);

			w.patchU32(offPos + 0x08, w.length);
			writeStringTable(
				w,
				joints.map((j) => j.name),
			);
		},
		opts,
	);
}

export interface EnvelopeSpec {
	joints: readonly number[];
	weights: readonly number[];
}

export function buildEvp1(
	envelopes: readonly EnvelopeSpec[],
	opts: ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'EVP1',
		(w) => {
			w.u16(envelopes.length);
			w.u16(0xffff);
			const offPos = w.length;
			w.u32(0).u32(0).u32(0).u32(0);

			w.patchU32(offPos + 0x00, w.length);
			for (const e of envelopes) w.u8(e.joints.length);
			w.align(4);

			w.patchU32(offPos + 0x04, w.length);
			for (const e of envelopes) for (const j of e.joints) w.u16(j);
			w.align(4);

			w.patchU32(offPos + 0x08, w.length);
			for (const e of envelopes) for (const v of e.weights) w.f32(v);

			// One 3x4 inverse bind matrix per referenced joint.
			let joints = 0;
			for (const e of envelopes) joints = Math.max(joints, ...e.joints) + 1;
			w.patchU32(offPos + 0x0c, w.length);
			for (let j = 0; j < joints; j++) {
				w.f32(1).f32(0).f32(0).f32(j);
				w.f32(0).f32(1).f32(0).f32(0);
				w.f32(0).f32(0).f32(1).f32(0);
			}
		},
		opts,
	);
}

export interface Drw1Spec {
	isWeighted: boolean;
	value: number;
}

export function buildDrw1(
	entries: readonly Drw1Spec[],
	opts: ChunkOptions = {},
): Uint8Array {
	return buildChunk(
		'DRW1',
		(w) => {
			w.u16(entries.length);
			w.u16(0xffff);
			const offPos = w.length;
			w.u32(0).u32(0);

			w.patchU32(offPos + 0x00, w.length);
			for (const e of entries) w.u8(e.isWeighted ? 1 : 0);
			w.align(4);

			w.patchU32(offPos + 0x04, w.length);
			for (const e of entries) w.u16(e.value);
		},
		opts,
	);
}
