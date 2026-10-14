/**
 * GoldenEye 007 glue: the ROM's named file table as a tree
 * (characters, guns, props, levels, …), models for the viewer /
 * thumbnails / exports, and its libaudio sound banks. Format logic
 * lives in `@tootallnate/goldeneye` and `@tootallnate/rare-1172`.
 *
 * Model leaves carry `meta.goldeneyeModel`; their `blob()` is the
 * decompressed file. Textures aren't decoded yet (Rare's image codec),
 * so models render with vertex colours / lighting.
 */

import {
	buildGoldeneyeModel,
	findGoldeneyeFileTable,
	goldeneyeFileKind,
	isGoldeneyeModel,
	type GoldeneyeFile,
	type GoldeneyeFileKind,
	type GoldeneyeModel,
} from '@tootallnate/goldeneye';
import { decompressRare1172 } from '@tootallnate/rare-1172';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';

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
export async function findGoldeneyeFiles(rom: Uint8Array): Promise<GoldeneyeFile[] | null> {
	let tried = 0;
	for (let o = 0x1000; o + 2 <= rom.length && tried < 8; o += 2) {
		if (rom[o] !== 0x11 || rom[o + 1] !== 0x72) continue;
		tried++;
		try {
			const code = await decompressRare1172(rom, o, { end: Math.min(rom.length, o + (2 << 20)) });
			if (code.length < 0x10000) continue;
			const files = findGoldeneyeFileTable(code, rom.length);
			if (files && files.length > 0) return files;
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
export function makeGoldeneyeDirs(id: string, rom: Uint8Array, files: GoldeneyeFile[]): Node[] {
	const byKind = new Map<GoldeneyeFileKind, GoldeneyeFile[]>();
	for (const f of files) {
		if (f.romSize === 0) continue;
		const k = goldeneyeFileKind(f.name);
		(byKind.get(k) ?? byKind.set(k, []).get(k)!).push(f);
	}
	const order: GoldeneyeFileKind[] = ['character', 'gun', 'prop', 'level', 'setup', 'clipping', 'text', 'other'];
	return order
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
									contentKey: `ge:${f.romOffset}:${f.romSize}`,
									...(!model && { tileData: 'n64-rgba16' }),
								},
								blob: async () => new Blob([(await bytes()) as BlobPart]),
							};
						}),
			};
		});
}

export interface GoldeneyeModelView {
	model: GoldeneyeModel;
	mesh: RenderableMesh;
	triangles: number;
	vertices: number;
}

/** Decode a `meta.goldeneyeModel` leaf. */
export async function loadGoldeneyeModelView(node: Node): Promise<GoldeneyeModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	if (!isGoldeneyeModel(bytes)) throw new Error('This file has no model node graph');
	const model = buildGoldeneyeModel(bytes);
	let nv = 0, ni = 0;
	for (const p of model.primitives) {
		nv += p.positions.length / 3;
		ni += p.indices.length;
	}
	const positions = new Float32Array(nv * 3);
	const colors = new Float32Array(nv * 3);
	const indices = new Uint32Array(ni);
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	let vo = 0, io = 0;
	model.primitives.forEach((p, slot) => {
		const n = p.positions.length / 3;
		positions.set(p.positions, vo * 3);
		for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) colors[(vo + i) * 3 + k] = p.colors ? p.colors[i * 4 + k]! / 255 : 0.8;
		for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + vo;
		sections.push({ materialIndex: slot, firstIndex: io, numTriangles: p.indices.length / 3 });
		vo += n;
		io += p.indices.length;
	});
	if (nv === 0) throw new Error('This model draws no triangles');
	return {
		model,
		// Flat normals from faces (the viewer derives them when absent).
		mesh: { lods: [{ numVertices: nv, positions, colors, indices, sections }], upAxis: 'y-up' },
		triangles: ni / 3,
		vertices: nv,
	};
}
