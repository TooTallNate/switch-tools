/**
 * PlatinumGames glue (Bayonetta 3; the formats are shared with Astral
 * Chain and NieR:Automata): PKZ packages and DAT / DTT archives become
 * containers, `.wta` / `.wtb` texture banks list their textures as PNG
 * leaves, and `.wmb` models open in the mesh viewer, textured from the
 * paired `.dtt` and animated by the `.mot` clips in their own `.dat`.
 *
 * Decompressed PKZ entries are big (DATs run to tens of MB, DTTs to
 * hundreds), so they live in a small byte-budget LRU rather than on
 * the nodes; every DAT / leaf read goes back through it.
 *
 * The parsers live in `@tootallnate/platinum`.
 */
import {
	buildWmbMesh,
	decodeWtaTexture,
	parseDat,
	parseMot,
	parsePkz,
	parseWmb,
	parseWta,
	pkzEntryStored,
	pkzHeaderSize,
	xt1FormatName,
	xt1Supported,
	WmbPose,
	type DatEntry,
	type Mot,
	type Pkz,
	type PkzEntry,
	type Wmb,
	type WmbMeshData,
	type Wta,
	type WtaTexture,
} from '@tootallnate/platinum';
import type { DecodedTexture } from '@tootallnate/bntx';

import type { RenderableMesh } from '~/components/mesh-viewer';
import type { Node } from './archive';
import { getAstcBlockDecoder } from './astc';
import { encodePng } from './png';
import type { DecodedTexture as ViewTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

// ----- Byte LRU -----

const LRU_BUDGET = 512 * 1024 * 1024;
const lru = new Map<string, { size: number; bytes: Promise<Uint8Array> }>();
let lruTotal = 0;

function cached(key: string, size: number, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
	const hit = lru.get(key);
	if (hit) {
		lru.delete(key);
		lru.set(key, hit);
		return hit.bytes;
	}
	const bytes = load();
	const entry = { size, bytes };
	lru.set(key, entry);
	lruTotal += size;
	bytes.catch(() => {
		if (lru.get(key) === entry) {
			lru.delete(key);
			lruTotal -= size;
		}
	});
	for (const [k, v] of lru) {
		if (lruTotal <= LRU_BUDGET || lru.size <= 1) break;
		if (k === key) continue;
		lru.delete(k);
		lruTotal -= v.size;
	}
	return bytes;
}

// ----- PKZ -----

export type PkzDecompress = (compressed: Uint8Array, size: number, compression: string) => Promise<Uint8Array>;

export async function readPkz(blob: Blob): Promise<Pkz> {
	const head = new Uint8Array(await blob.slice(0, 0x20).arrayBuffer());
	const n = pkzHeaderSize(head);
	return parsePkz(new Uint8Array(await blob.slice(0, n).arrayBuffer()));
}

/** Decompressed bytes of one PKZ entry, through the LRU. */
export function pkzEntryBytes(pkzId: string, blob: Blob, pkz: Pkz, e: PkzEntry, decompress: PkzDecompress): Promise<Uint8Array> {
	return cached(`${pkzId}#${e.index}`, e.size, async () => {
		const raw = new Uint8Array(await blob.slice(e.offset, e.offset + e.compressedSize).arrayBuffer());
		if (pkzEntryStored(e)) return raw;
		const out = await decompress(raw, e.size, pkz.compression);
		return out.length > e.size ? out.subarray(0, e.size) : out;
	});
}

// ----- DAT -----

export interface DatListing {
	id: string;
	entries: DatEntry[];
	/** One entry's bytes. */
	read(name: string): Promise<Uint8Array | null>;
}

/** DAT node id → listing, registered when a DAT is expanded. */
const datListings = new Map<string, DatListing>();

/** Whole-DAT bytes: through the LRU for facades, a straight read for files. */
async function datBytes(id: string, blob: Blob): Promise<Uint8Array> {
	return cached(`dat:${id}`, blob.size, async () => new Uint8Array(await blob.arrayBuffer()));
}

export async function listDat(id: string, blob: Blob): Promise<DatListing> {
	const known = datListings.get(id);
	if (known) return known;
	const bytes = await datBytes(id, blob);
	const entries = parseDat(bytes);
	const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
	const listing: DatListing = {
		id,
		entries,
		async read(name) {
			const e = byName.get(name.toLowerCase());
			if (!e) return null;
			const all = await datBytes(id, blob);
			return all.subarray(e.offset, e.offset + e.size);
		},
	};
	datListings.set(id, listing);
	return listing;
}

/** Bytes of a DAT entry, for leaf blobs (re-reads through the LRU, never pinned). */
export async function datEntryBytes(id: string, blob: Blob, e: DatEntry): Promise<Uint8Array> {
	const all = await datBytes(id, blob);
	return all.subarray(e.offset, e.offset + e.size);
}

/** PKZ children by id, so a DAT can find its paired DTT without a root walk. */
const pkzChildren = new Map<string, Node>();
export function registerPkzChild(node: Node): Node {
	pkzChildren.set(node.id, node);
	return node;
}

/** Find (and register) a DAT by node id: the registry, the PKZ's children, else a walk from the root. */
async function datById(id: string, root: Node | null): Promise<DatListing | null> {
	const known = datListings.get(id);
	if (known) return known;
	const node = pkzChildren.get(id) ?? (root ? await findNodeById(root, id).catch(() => null) : null);
	if (!node?.getChildren) return null;
	await node.getChildren();
	return datListings.get(id) ?? null;
}

// ----- Textures -----

let astcPromise: ReturnType<typeof getAstcBlockDecoder> | null = null;
const astc = () => (astcPromise ??= getAstcBlockDecoder());

export async function decodeTexture(data: Uint8Array, tex: WtaTexture): Promise<DecodedTexture> {
	return decodeWtaTexture(data, tex, { astcDecoder: await astc() });
}

/**
 * Where a texture bank's pixels live: a `.wtb` holds them itself; a
 * `.wta` in `x.dat` pairs with `x.wtp` (or the only `.wtp`) in `x.dtt`.
 */
async function wtpFor(wtaNodeId: string, root: Node | null): Promise<Uint8Array | null> {
	const parts = wtaNodeId.split('/');
	const leaf = parts.pop()!;
	const datId = parts.join('/');
	const base = leaf.replace(/\.wta$/i, '');
	const dtt = await datById(datId.replace(/\.dat$/i, '.dtt'), root);
	if (!dtt) return null;
	const wtp = dtt.entries.find((e) => e.name.toLowerCase() === `${base.toLowerCase()}.wtp`) ?? dtt.entries.find((e) => /\.wtp$/i.test(e.name));
	return wtp ? dtt.read(wtp.name) : null;
}

/** Root node for texture lookups, set by the app (the PKZ / DAT nodes don't know it). */
let rootRef: Node | null = null;
export function setPlatinumRoot(root: Node | null): void {
	rootRef = root;
}

/**
 * The PNG leaves of a `.wta` / `.wtb`. `pixels` resolves the bytes the
 * offsets index into.
 */
export function textureLeaves(bankId: string, bankName: string, wta: Wta, pixels: () => Promise<Uint8Array | null>): Node[] {
	const base = bankName.replace(/\.[^.]+$/, '');
	return wta.textures
		.filter((t) => t.xt1 && t.xt1.width > 0 && t.xt1.height > 0)
		.map((t) => {
			const x = t.xt1!;
			const name = `${base}_${String(t.index).padStart(2, '0')}_${t.id.toString(16).padStart(8, '0')}.png`;
			return {
				id: `${bankId}/${name}`,
				name,
				kind: 'file' as const,
				isContainer: false,
				size: x.width * x.height * 4,
				format: `${xt1FormatName(x.format)} ${x.width}×${x.height}`,
				meta: {
					decoded: true,
					contentKey: `pg-tex:${t.id.toString(16)}:${x.width}x${x.height}:${x.format}:${t.size}`,
					...(xt1Supported(x.format) ? {} : { unsupportedTexture: xt1FormatName(x.format) }),
				},
				blob: async () => {
					const data = await pixels();
					if (!data) throw new Error('Texture data (.wtp in the paired .dtt) not found');
					const img = await decodeTexture(data, t);
					return new Blob([(await encodePng(img.width, img.height, img.pixels)) as BlobPart], { type: 'image/png' });
				},
			};
		});
}

/** Children of a `.wta` (pixels from the paired `.dtt`) or `.wtb` (self-contained) node. */
export async function textureBankChildren(node: Node, blob: Blob): Promise<Node[]> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const wta = parseWta(bytes);
	const selfContained = !/\.wta$/i.test(node.name);
	return textureLeaves(node.id, node.name, wta, selfContained ? async () => bytes : () => wtpFor(node.id, rootRef));
}

// ----- Models -----

export interface PlatinumClip {
	name: string;
	frameCount: number;
	load: () => Promise<Mot>;
}

export interface PlatinumModelView {
	wmb: Wmb;
	data: WmbMeshData;
	mesh: RenderableMesh;
	textures: (ViewTexture | null)[];
	texturesFound: number;
	texturesWanted: number;
	clips: PlatinumClip[];
	pose: WmbPose;
	/** Materials hidden because they are shadow / FX passes. */
	hidden: number;
}

/** Sampler names that carry the base colour, best first. */
const ALBEDO = [/^g_AlbedoMap1?$/i, /^g_AlbedoMap/i, /albedo|diffuse|basecolor|colormap/i];

/** Materials that aren't surface colour: shadow casters, outlines, FX helpers. */
const HIDDEN_MATERIAL = /shadow|_sdw|outline|^fx_j_tear$|_ao\d*$/i;

export async function loadPlatinumModelView(node: Node, root: Node | null): Promise<PlatinumModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const wmb = parseWmb(bytes);
	const data = buildWmbMesh(bytes, wmb);
	if (data.indices.length === 0) throw new Error(data.skipped ? 'This model’s geometry is in an external .wme stream' : 'Model has no geometry');

	const parts = node.id.split('/');
	const leaf = parts.pop()!;
	const datId = parts.join('/');
	const base = leaf.replace(/\.wmb$/i, '');
	const dat = await datById(datId, root ?? rootRef);

	// Textures: the WTA beside the model, pixels from the paired DTT.
	const textures: (ViewTexture | null)[] = wmb.materials.map(() => null);
	let texturesWanted = 0;
	let texturesFound = 0;
	if (dat) {
		const wtaEntry = dat.entries.find((e) => e.name.toLowerCase() === `${base.toLowerCase()}.wta`) ?? dat.entries.find((e) => /\.wta$/i.test(e.name));
		const wtaBytes = wtaEntry ? await dat.read(wtaEntry.name) : null;
		const wta = wtaBytes ? parseWta(wtaBytes) : null;
		const byId = new Map((wta?.textures ?? []).map((t) => [t.id, t]));
		const pixels = wtaEntry ? await wtpFor(`${datId}/${wtaEntry.name}`, root ?? rootRef) : null;
		const decodedById = new Map<number, Promise<DecodedTexture | null>>();
		await Promise.all(
			wmb.materials.map(async (m, i) => {
				let ref: { name: string; id: number } | undefined;
				for (const re of ALBEDO) {
					ref = m.textures.find((t) => re.test(t.name) && byId.has(t.id)) ?? m.textures.find((t) => re.test(t.name));
					if (ref) break;
				}
				if (!ref) return;
				texturesWanted++;
				const tex = byId.get(ref.id);
				if (!tex || !pixels) return;
				let p = decodedById.get(tex.id);
				if (!p) {
					p = decodeTexture(pixels, tex).catch(() => null);
					decodedById.set(tex.id, p);
				}
				const img = await p;
				if (img) {
					textures[i] = {
						packagePath: `${base}/${ref.name}/${tex.id.toString(16)}`,
						width: img.width,
						height: img.height,
						pixels: img.pixels,
						pixelFormat: xt1FormatName(tex.xt1?.format ?? 0),
						normalReconstructed: false,
						// Pixels are top-down and WMB UVs have V=0 at the top.
						flipY: false,
					};
					texturesFound++;
				}
			}),
		);
	}

	// Hide shadow / FX materials by dropping their sections.
	let hidden = 0;
	const visible = data.sections.filter((s) => {
		const m = wmb.materials[s.material];
		const hide = !!m && HIDDEN_MATERIAL.test(m.name);
		if (hide) hidden++;
		return !hide;
	});
	const sections = visible.length > 0 ? visible : data.sections;

	// Clips: the MOTs in the same DAT (frame counts read from their headers).
	const clips: PlatinumClip[] = [];
	if (dat) {
		for (const e of dat.entries) {
			if (!/\.mot$/i.test(e.name) || e.size < 0x2c) continue;
			const head = await dat.read(e.name);
			if (!head) continue;
			const frameCount = head[0x0a]! | (head[0x0b]! << 8);
			if (frameCount < 1) continue;
			let parsed: Promise<Mot> | null = null;
			clips.push({
				name: e.name.replace(/\.mot$/i, ''),
				frameCount,
				load: () => (parsed ??= dat.read(e.name).then((b) => parseMot(b!))),
			});
		}
	}

	const nv = data.positions.length / 3;
	const mesh: RenderableMesh = {
		lods: [
			{
				numVertices: nv,
				positions: Float32Array.from(data.positions),
				normals: Float32Array.from(data.normals),
				uv: data.uvs,
				indices: data.indices,
				sections: sections.map((s) => ({ materialIndex: s.material, firstIndex: s.firstIndex, numTriangles: s.numTriangles })),
				label: `${nv.toLocaleString()} verts, ${(sections.reduce((n, s) => n + s.numTriangles, 0)).toLocaleString()} tris`,
			},
		],
		upAxis: 'y-up',
	};
	return { wmb, data, mesh, textures, texturesFound, texturesWanted, clips, pose: new WmbPose(wmb), hidden };
}
