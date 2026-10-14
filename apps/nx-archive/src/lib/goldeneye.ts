/**
 * GoldenEye 007 glue: the ROM's named file table as a tree
 * (characters, guns, props, levels, …), models for the viewer /
 * thumbnails / exports, and its libaudio sound banks. Format logic
 * lives in `@tootallnate/goldeneye` and `@tootallnate/rare-1172`.
 *
 * Model leaves carry `meta.goldeneyeModel`; their `blob()` is the
 * decompressed file. Textures come from the global image bank (decoded
 * per texture number, cached per ROM); a `textures/` folder lists the
 * whole bank as PNGs. Leaves find their ROM's context through
 * {@link contexts} (node meta can't carry closures).
 */

import {
	buildGoldeneyeLevel,
	buildGoldeneyeModel,
	isGoldeneyeLevel,
	type GoldeneyePrimitive,
	findGoldeneyeFileTable,
	findGoldeneyeTextureBank,
	findGoldeneyeTextureOffsets,
	readGoldeneyeTexture,
	type GoldeneyeTexture,
	type GoldeneyeTextureBank,
	goldeneyeFileKind,
	isGoldeneyeModel,
	type GoldeneyeFile,
	type GoldeneyeFileKind,
	type GoldeneyeModel,
} from '@tootallnate/goldeneye';
import { decompressRare1172 } from '@tootallnate/rare-1172';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';
import { encodePngSync } from './png';
import type { DecodedTexture } from './uasset-material-chain';

interface RomContext {
	rom: Uint8Array;
	bank: GoldeneyeTextureBank | null;
	textures: Map<number, GoldeneyeTexture | null>;
}

/** Per-ROM context by tree id prefix (the ROM node's id). */
const contexts = new Map<string, RomContext>();

function contextFor(nodeId: string): RomContext | null {
	for (const [prefix, ctx] of contexts) if (nodeId.startsWith(`${prefix}/`)) return ctx;
	return null;
}

function texture(ctx: RomContext, n: number): GoldeneyeTexture | null {
	if (!ctx.textures.has(n)) {
		ctx.textures.set(n, ctx.bank ? readGoldeneyeTexture(ctx.rom, ctx.bank, n) : null);
		// Keep the cache bounded; textures are small but there are thousands.
		if (ctx.textures.size > 600) ctx.textures.delete(ctx.textures.keys().next().value!);
	}
	return ctx.textures.get(n) ?? null;
}

/** True for GoldenEye's internal ROM name. */
export function isGoldeneyeRom(rom: Uint8Array): boolean {
	let s = '';
	for (let i = 0x20; i < 0x34; i++) s += String.fromCharCode(rom[i]!);
	return /^GOLDENEYE/i.test(s.trim());
}

/**
 * The file table, from the first Rare-1172 container that holds it
 * (the main code segment, `0x21990` in the US release).
 */
export interface GoldeneyeRomInfo {
	files: GoldeneyeFile[];
	bank: GoldeneyeTextureBank | null;
}

export async function findGoldeneyeFiles(rom: Uint8Array): Promise<GoldeneyeRomInfo | null> {
	let tried = 0;
	for (let o = 0x1000; o + 2 <= rom.length && tried < 8; o += 2) {
		if (rom[o] !== 0x11 || rom[o + 1] !== 0x72) continue;
		tried++;
		try {
			const code = await decompressRare1172(rom, o, { end: Math.min(rom.length, o + (2 << 20)) });
			if (code.length < 0x10000) continue;
			const files = findGoldeneyeFileTable(code, rom.length);
			if (files && files.length > 0) {
				// The image bank follows the last file in the ROM.
				const offsets = findGoldeneyeTextureOffsets(code);
				const last = Math.max(...files.map((f) => f.romOffset));
				const bank = offsets ? findGoldeneyeTextureBank(rom, offsets, last) : null;
				return { files, bank };
			}
		} catch {
			// not this one
		}
	}
	return null;
}

const DIR_NAMES: Record<GoldeneyeFileKind, string> = {
	character: 'characters',
	gun: 'guns',
	prop: 'props',
	level: 'levels',
	setup: 'setups',
	clipping: 'clipping',
	text: 'text',
	other: 'other',
};

const MODEL_KINDS = new Set<GoldeneyeFileKind>(['character', 'gun', 'prop']);

function fileBytes(rom: Uint8Array, f: GoldeneyeFile): () => Promise<Uint8Array> {
	let p: Promise<Uint8Array> | null = null;
	return () =>
		(p ??= f.compressed
			? decompressRare1172(rom, f.romOffset, { end: f.romOffset + f.romSize })
			: Promise.resolve(rom.subarray(f.romOffset, f.romOffset + f.romSize)));
}

/** Folders per asset category; model categories get model leaves. */
export function makeGoldeneyeDirs(id: string, rom: Uint8Array, info: GoldeneyeRomInfo): Node[] {
	const { files, bank } = info;
	contexts.set(id, { rom, bank, textures: new Map() });
	const byKind = new Map<GoldeneyeFileKind, GoldeneyeFile[]>();
	for (const f of files) {
		if (f.romSize === 0) continue;
		const k = goldeneyeFileKind(f.name);
		(byKind.get(k) ?? byKind.set(k, []).get(k)!).push(f);
	}
	const order: GoldeneyeFileKind[] = ['character', 'gun', 'prop', 'level', 'setup', 'clipping', 'text', 'other'];
	const dirs = order
		.filter((k) => byKind.has(k))
		.map((k): Node => {
			const dirId = `${id}/${DIR_NAMES[k]}`;
			return {
				id: dirId,
				name: DIR_NAMES[k],
				kind: 'directory',
				isContainer: true,
				format: 'directory',
				getChildren: async () =>
					byKind
						.get(k)!
						.slice()
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((f): Node => {
							const leaf = f.name.split('/').pop()!;
							const bytes = fileBytes(rom, f);
							const model = MODEL_KINDS.has(k);
							const name = model ? `${leaf}.gemdl` : leaf;
							return {
								id: `${dirId}/${name}`,
								name,
								kind: 'file',
								isContainer: false,
								size: f.romSize,
								format: f.compressed ? 'Rare-1172' : 'BIN',
								meta: {
									...(model && { goldeneyeModel: { name: f.name } }),
									...(k === 'level' && { goldeneyeLevel: { name: f.name } }),
									contentKey: `ge:${f.romOffset}:${f.romSize}`,
									...(!model && k !== 'level' && { tileData: 'n64-rgba16' }),
								},
								blob: async () => new Blob([(await bytes()) as BlobPart]),
							};
						}),
			};
		});
	if (bank) dirs.push(makeTextureDir(`${id}/textures`, rom, bank));
	return dirs;
}

/** The image bank as PNG leaves (decoded on demand). */
function makeTextureDir(id: string, rom: Uint8Array, bank: GoldeneyeTextureBank): Node {
	return {
		id,
		name: 'textures',
		kind: 'directory',
		isContainer: true,
		format: 'directory',
		getChildren: async () => {
			const out: Node[] = [];
			for (let n = 0; n + 1 < bank.offsets.length; n++) {
				const name = `tex_${String(n).padStart(4, '0')}.png`;
				out.push({
					id: `${id}/${name}`,
					name,
					kind: 'file',
					isContainer: false,
					size: bank.offsets[n + 1]! - bank.offsets[n]!,
					format: 'GE image',
					meta: { decoded: true, contentKey: `ge-tex:${bank.romStart}:${n}` },
					blob: async () => {
						const t = readGoldeneyeTexture(rom, bank, n);
						if (!t) throw new Error(`Texture ${n} did not decode`);
						return new Blob([encodePngSync(t.width, t.height, t.rgba) as BlobPart], { type: 'image/png' });
					},
				});
			}
			return out;
		},
	};
}

export interface GoldeneyeModelView {
	model: { textureIds: number[] };
	mesh: RenderableMesh;
	/** One per material slot (primitive); null when untextured. */
	textures: (DecodedTexture | null)[];
	texturedSlots: number;
	triangles: number;
	vertices: number;
	rooms?: number;
}

/** Decode a `meta.goldeneyeModel` leaf. */
export async function loadGoldeneyeModelView(node: Node): Promise<GoldeneyeModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	if (!isGoldeneyeModel(bytes)) throw new Error('This file has no model node graph');
	const model = buildGoldeneyeModel(bytes);
	return { ...primitivesView(model.primitives, contextFor(node.id)), model };
}

/** Decode a `meta.goldeneyeLevel` leaf (every room of a level). */
export async function loadGoldeneyeLevelView(node: Node): Promise<GoldeneyeModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	if (!isGoldeneyeLevel(bytes)) throw new Error('This level file is empty (cut from the game)');
	const level = await buildGoldeneyeLevel(bytes, (b, o) => decompressRare1172(b, o));
	return { ...primitivesView(level.primitives, contextFor(node.id)), model: { textureIds: level.textureIds }, rooms: level.rooms };
}

function primitivesView(prims: GoldeneyePrimitive[], ctx: RomContext | null): Omit<GoldeneyeModelView, 'model'> {
	let nv = 0, ni = 0;
	for (const p of prims) {
		nv += p.positions.length / 3;
		ni += p.indices.length;
	}
	const positions = new Float32Array(nv * 3);
	const colors = new Float32Array(nv * 3);
	const uv = new Float32Array(nv * 2);
	const indices = new Uint32Array(ni);
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	const textures: (DecodedTexture | null)[] = [];
	const decodedById = new Map<number, DecodedTexture | null>();
	let vo = 0, io = 0;
	prims.forEach((p, slot) => {
		const n = p.positions.length / 3;
		positions.set(p.positions, vo * 3);
		const t = ctx && p.textureId >= 0 ? texture(ctx, p.textureId) : null;
		if (t) {
			if (!decodedById.has(p.textureId)) {
				decodedById.set(p.textureId, {
					packagePath: `tex_${String(p.textureId).padStart(4, '0')}`,
					width: t.width,
					height: t.height,
					pixels: t.rgba,
					pixelFormat: 'RGBA8',
					normalReconstructed: false,
					flipY: false,
				});
			}
			const base = decodedById.get(p.textureId)!;
			// Wrap modes differ per draw; share pixels, not the sampler.
			textures.push(base && { ...base, wrapS: p.wrapS, wrapT: p.wrapT });
			for (let i = 0; i < n; i++) {
				uv[(vo + i) * 2] = p.texels[i * 2]! / t.width;
				uv[(vo + i) * 2 + 1] = p.texels[i * 2 + 1]! / t.height;
			}
		} else textures.push(null);
		for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) colors[(vo + i) * 3 + k] = p.colors ? p.colors[i * 4 + k]! / 255 : 0.8;
		for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + vo;
		sections.push({ materialIndex: slot, firstIndex: io, numTriangles: p.indices.length / 3 });
		vo += n;
		io += p.indices.length;
	});
	if (nv === 0) throw new Error('This model draws no triangles');
	return {
		// Flat normals from faces (the viewer derives them when absent).
		mesh: { lods: [{ numVertices: nv, positions, colors, uv, indices, sections }], upAxis: 'y-up' },
		textures,
		texturedSlots: textures.filter(Boolean).length,
		triangles: ni / 3,
		vertices: nv,
	};
}
