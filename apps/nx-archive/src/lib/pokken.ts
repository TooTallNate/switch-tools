/**
 * Bandai Namco NU3-engine glue (Pokkén Tournament DX): DRP archives,
 * NUT texture packs, NUD models and NUS3BANK sound banks.
 *
 * - **DRP** (`@tootallnate/drp`): each file is decrypted once, through
 *   a bounded LRU, and each entry part becomes a child named from its
 *   magic (`.nut`, `.nud`, `.vbn`, `.omo`, …). Parts are inflated on
 *   read, and listing only peeks at their first bytes.
 * - **NUT** (`@tootallnate/nu3`): a container of PNG leaves, decoded
 *   on demand.
 * - **NUD**: a model leaf. Textures resolve by GIDX hash against every
 *   NUT in the same DRP; characters and stages pair one in the same
 *   entry. Meshes bound rigidly (`_NSC`) take their bone from a VBN in
 *   the same DRP when there is one. Facial-expression alternatives
 *   (`_O_OBJ_*`) show only the neutral face.
 * - **NUS3BANK** (`@tootallnate/nus3`): one `.wav` leaf per tone,
 *   decoded from IDSP on demand.
 */
import { decryptDrp, isDrp, parseDrp, peekDrpPart, readDrpPart, type DrpArchive, type DrpEntry, type DrpPart } from '@tootallnate/drp';
import {
	decodeNutTexture,
	isNut,
	isVbn,
	nutFormatName,
	parseNud,
	parseNut,
	parseVbn,
	vbnWorldMatrices,
	type NudModel,
	type NutFile,
	type NutTexture,
} from '@tootallnate/nu3';
import { decodeIdsp, isNus3Bank, parseNus3Bank, readIdspInfo } from '@tootallnate/nus3';
import { encodeWav } from '@tootallnate/dsp-adpcm';

import type { RenderableMesh } from '~/components/mesh-viewer';
import type { Node } from './archive';
import { encodePng } from './png';
import type { DecodedTexture as ViewTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

// ----- Byte LRU -----

const LRU_BUDGET = 256 * 1024 * 1024;
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

/** Cheap content fingerprint for `contentKey`s (FNV-1a over a window). */
function fnv(bytes: Uint8Array, start = 0, end = Math.min(bytes.byteLength, start + 256)): string {
	let h = 0x811c9dc5;
	for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
	return (h >>> 0).toString(16).padStart(8, '0');
}

const u8Blob = (u8: Uint8Array, type = '') => new Blob([u8 as BlobPart], { type });

// ----- DRP -----

export interface DrpListing {
	id: string;
	archive: DrpArchive;
	/** Bytes of one part (inflated), through the LRU. */
	part(entryIndex: number, partIndex: number): Promise<Uint8Array>;
}

const drpListings = new Map<string, DrpListing>();

function drpBytes(id: string, blob: Blob): Promise<Uint8Array> {
	return cached(`drp:${id}`, blob.size, async () => decryptDrp(new Uint8Array(await blob.arrayBuffer())));
}

export async function listDrp(id: string, blob: Blob): Promise<DrpListing> {
	const known = drpListings.get(id);
	if (known) return known;
	const decrypted = await drpBytes(id, blob);
	if (!isDrp(decrypted)) throw new Error('Not a DRP archive (or an unsupported header version)');
	const archive = parseDrp(decrypted);
	const listing: DrpListing = {
		id,
		archive,
		part(ei, pi) {
			const e = archive.entries[ei]!;
			const p = e.parts[pi]!;
			return cached(`drp:${id}#${ei}.${pi}`, p.size, async () => readDrpPart(await drpBytes(id, blob), e, p));
		},
	};
	if (drpListings.size > 4096) drpListings.delete(drpListings.keys().next().value!);
	drpListings.set(id, listing);
	return listing;
}

/** A DRP listing by node id: the registry, else expand the node found from the root. */
async function drpById(id: string, root: Node | null): Promise<DrpListing | null> {
	const known = drpListings.get(id);
	if (known) return known;
	const node = root ? await findNodeById(root, id).catch(() => null) : null;
	if (!node?.getChildren) return null;
	await node.getChildren();
	return drpListings.get(id) ?? null;
}

function extForMagic(head: Uint8Array): string {
	const m = String.fromCharCode(...head.subarray(0, 4));
	if (m === 'NTWD' || m === 'NTP3') return 'nut';
	if (m === 'NDWD' || m === 'NDP3') return 'nud';
	if (m === 'VBN ' || m === ' NBV') return 'vbn';
	if (m === 'OMO ') return 'omo';
	if (m === 'NTXL') return 'ntxl';
	if (m === '\x1bLua') return 'luac';
	if (m === '\x89PNG') return 'png';
	if (m === 'NUS3') return 'nus3bank';
	return 'bin';
}

export interface DrpChildHooks {
	/** Route a leaf through the generic dispatch (images, audio, …). */
	childFor: (id: string, name: string, blob: Blob) => Promise<Node>;
}

/** NUD leaves' model references. */
export interface Nu3ModelRef {
	drpId: string;
	entry: number;
	part: number;
}

/** Children of a `.drp` node. */
export async function drpChildren(id: string, blob: Blob, hooks: DrpChildHooks): Promise<Node[]> {
	const listing = await listDrp(id, blob);
	const decrypted = await drpBytes(id, blob);
	const used = new Set<string>();
	const unique = (name: string) => {
		let n = name;
		for (let i = 1; used.has(n.toLowerCase()); i++) n = name.replace(/(\.[^.]+)?$/, `_${i}$1`);
		used.add(n.toLowerCase());
		return n;
	};
	const out: Promise<Node>[] = [];
	listing.archive.entries.forEach((e, ei) => {
		e.parts.forEach((p, pi) => {
			const head = peekDrpPart(decrypted, e, p, 16);
			const ext = extForMagic(head);
			const stem = e.name.replace(/\.(nut|nud|vbn|omo)$/i, '') || `entry_${ei}`;
			const name = unique(`${stem}.${ext}`);
			const childId = `${id}/${name}`;
			const read = () => listing.part(ei, pi);
			const size = p.size;
			const key = `drp:${e.name}:${pi}:${size}:${fnv(decrypted, p.offset, Math.min(p.offset + p.length, p.offset + 64))}`;
			if (ext === 'nut') out.push(Promise.resolve(makeNutNode(childId, name, read, size, key)));
			else if (ext === 'nud') {
				out.push(
					Promise.resolve<Node>({
						id: childId,
						name,
						kind: 'file',
						isContainer: false,
						size,
						format: 'NUD (NDWD)',
						meta: { nu3Model: { drpId: id, entry: ei, part: pi } satisfies Nu3ModelRef, contentKey: key },
						blob: async () => u8Blob(await read()),
					}),
				);
			} else if (ext === 'png' || ext === 'nus3bank') {
				out.push(read().then((b) => hooks.childFor(childId, name, u8Blob(b))));
			} else {
				out.push(
					Promise.resolve<Node>({
						id: childId,
						name,
						kind: 'file',
						isContainer: false,
						size,
						format: ext === 'bin' ? `DRP entry (type ${e.typeA}/${e.typeB})` : ext.toUpperCase(),
						meta: { contentKey: key },
						blob: async () => u8Blob(await read()),
					}),
				);
			}
		});
	});
	return Promise.all(out);
}

/** `.drp` container node. */
export function makeDrpNode(id: string, name: string, blob: Blob, hooks: DrpChildHooks): Node {
	return {
		id,
		name,
		kind: 'drp',
		isContainer: true,
		size: blob.size,
		format: 'DRP',
		blob: async () => blob,
		getChildren: () => drpChildren(id, blob, hooks),
	};
}

// ----- NUT -----

/** PNG leaves of a NUT texture pack. */
function nutLeaves(id: string, name: string, bytes: Uint8Array, nut: NutFile): Node[] {
	const base = name.replace(/\.[^.]+$/, '');
	const single = nut.textures.length === 1;
	return nut.textures
		.filter((t) => t.width > 0 && t.height > 0)
		.map((t, i) => {
			const leaf = single ? `${base}.png` : `${base}_${String(i).padStart(2, '0')}_${t.hashId.toString(16).padStart(8, '0')}.png`;
			const s = t.surfaces[0]!;
			return {
				id: `${id}/${leaf}`,
				name: leaf,
				kind: 'file' as const,
				isContainer: false,
				size: t.width * t.height * 4,
				format: `${nutFormatName(t.format)} ${t.width}×${t.height}${t.cubemap ? ' cubemap' : ''}`,
				meta: { decoded: true, contentKey: `nut:${t.hashId.toString(16)}:${t.width}x${t.height}:${t.format}:${fnv(bytes, s.offset)}` },
				blob: async () => {
					const img = decodeNutTexture(bytes, t);
					return u8Blob(await encodePng(img.width, img.height, img.pixels), 'image/png');
				},
			};
		});
}

/** NUT texture pack container. `read` yields the NUT's bytes. */
export function makeNutNode(id: string, name: string, read: () => Promise<Uint8Array>, size: number, contentKey?: string): Node {
	return {
		id,
		name,
		kind: 'nut',
		isContainer: true,
		size,
		format: 'NUT',
		meta: contentKey ? { contentKey } : undefined,
		blob: async () => u8Blob(await read()),
		getChildren: async () => {
			const bytes = await read();
			if (!isNut(bytes)) throw new Error('Not an NTWD / NTP3 texture pack');
			return nutLeaves(id, name, bytes, parseNut(bytes));
		},
	};
}

// ----- NUD models -----

export interface Nu3ModelView {
	nud: NudModel;
	mesh: RenderableMesh;
	textures: (ViewTexture | null)[];
	texturesFound: number;
	texturesWanted: number;
	/** Meshes hidden as alternative facial expressions. */
	hidden: number;
}

/** GIDX hash → texture across a DRP's NUTs, built once per DRP. */
const drpTextureIndex = new Map<string, Promise<Map<number, { bytes: Uint8Array; tex: NutTexture }>>>();

function textureIndex(listing: DrpListing, prefer: number | null): Promise<Map<number, { bytes: Uint8Array; tex: NutTexture }>> {
	let p = drpTextureIndex.get(listing.id);
	if (!p) {
		p = (async () => {
			const map = new Map<number, { bytes: Uint8Array; tex: NutTexture }>();
			const order = listing.archive.entries.map((_, i) => i);
			// The model's own entry wins hash collisions.
			if (prefer !== null) order.sort((a, b) => Number(b === prefer) - Number(a === prefer));
			for (const ei of order) {
				const e = listing.archive.entries[ei]!;
				for (let pi = 0; pi < e.parts.length; pi++) {
					const bytes = await listing.part(ei, pi).catch(() => null);
					if (!bytes || !isNut(bytes)) continue;
					try {
						for (const tex of parseNut(bytes).textures) if (!map.has(tex.hashId)) map.set(tex.hashId, { bytes, tex });
					} catch {
						// A malformed pack shouldn't hide the rest.
					}
				}
			}
			return map;
		})();
		if (drpTextureIndex.size > 64) drpTextureIndex.delete(drpTextureIndex.keys().next().value!);
		drpTextureIndex.set(listing.id, p);
		p.catch(() => drpTextureIndex.delete(listing.id));
	}
	return p;
}

/** Bind-pose world matrices from a VBN in the same DRP, if any. */
async function drpSkeleton(listing: DrpListing): Promise<Float32Array[] | null> {
	for (const [ei, e] of listing.archive.entries.entries()) {
		if (e.parts.length !== 1 || !/bindpose/i.test(e.name)) continue;
		const bytes = await listing.part(ei, 0).catch(() => null);
		if (bytes && isVbn(bytes)) return vbnWorldMatrices(parseVbn(bytes));
	}
	return null;
}

const EXPRESSION = /^_O_OBJ_/i;

export async function loadNu3ModelView(node: Node, root: Node | null): Promise<Nu3ModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const nud = parseNud(bytes);
	const ref = node.meta?.nu3Model as Nu3ModelRef | undefined;
	const listing = ref ? await drpById(ref.drpId, root) : null;
	const index = listing ? await textureIndex(listing, ref!.entry) : new Map<number, { bytes: Uint8Array; tex: NutTexture }>();
	const bones = listing ? await drpSkeleton(listing) : null;

	// Facial expressions: keep `_O_OBJ_normal` (else the first) of the alternatives.
	const expressions = nud.meshes.filter((m) => EXPRESSION.test(m.name));
	const face = expressions.find((m) => /^_O_OBJ_normal$/i.test(m.name)) ?? expressions[0];
	const meshes = nud.meshes.filter((m) => !EXPRESSION.test(m.name) || m === face);

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	const sections: RenderableMesh['lods'][number]['sections'] = [];
	const textures: (ViewTexture | null)[] = [];
	const decoded = new Map<number, ViewTexture | null>();
	let texturesWanted = 0;
	let texturesFound = 0;
	for (const m of meshes) {
		const bone = /_NSC/i.test(m.name) && m.singleBind >= 0 ? bones?.[m.singleBind] : undefined;
		for (const p of m.polygons) {
			if (p.indices.length === 0) continue;
			const base = positions.length / 3;
			for (let v = 0; v < p.vertexCount; v++) {
				let x = p.positions[v * 3]!, y = p.positions[v * 3 + 1]!, z = p.positions[v * 3 + 2]!;
				let nx = p.normals?.[v * 3] ?? 0, ny = p.normals?.[v * 3 + 1] ?? 0, nz = p.normals?.[v * 3 + 2] ?? 1;
				if (bone) {
					const b = bone;
					[x, y, z] = [b[0]! * x + b[4]! * y + b[8]! * z + b[12]!, b[1]! * x + b[5]! * y + b[9]! * z + b[13]!, b[2]! * x + b[6]! * y + b[10]! * z + b[14]!];
					[nx, ny, nz] = [b[0]! * nx + b[4]! * ny + b[8]! * nz, b[1]! * nx + b[5]! * ny + b[9]! * nz, b[2]! * nx + b[6]! * ny + b[10]! * nz];
				}
				positions.push(x, y, z);
				const len = Math.hypot(nx, ny, nz) || 1;
				normals.push(nx / len, ny / len, nz / len);
				uvs.push(p.uvs?.[v * 2] ?? 0, p.uvs?.[v * 2 + 1] ?? 0);
				colors.push(Math.min(1, p.colors?.[v * 4] ?? 1), Math.min(1, p.colors?.[v * 4 + 1] ?? 1), Math.min(1, p.colors?.[v * 4 + 2] ?? 1));
			}
			const first = indices.length;
			for (const i of p.indices) indices.push(base + i);
			sections.push({ materialIndex: textures.length, firstIndex: first, numTriangles: p.indices.length / 3 });
			const hash = p.materials[0]?.textures[0]?.hash;
			let tex: ViewTexture | null = null;
			if (hash !== undefined) {
				texturesWanted++;
				if (!decoded.has(hash)) {
					const hit = index.get(hash);
					let v: ViewTexture | null = null;
					if (hit) {
						try {
							const img = decodeNutTexture(hit.bytes, hit.tex);
							v = {
								packagePath: `${hash.toString(16)}`,
								width: img.width,
								height: img.height,
								pixels: img.pixels,
								pixelFormat: nutFormatName(hit.tex.format),
								normalReconstructed: false,
								// NUT pixels are top-down and NUD UVs put V=0 at the top.
								flipY: false,
							};
						} catch {
							v = null;
						}
					}
					decoded.set(hash, v);
				}
				tex = decoded.get(hash) ?? null;
				if (tex) texturesFound++;
			}
			textures.push(tex);
		}
	}
	if (indices.length === 0) throw new Error('Model has no geometry');
	const nv = positions.length / 3;
	const tris = indices.length / 3;
	const mesh: RenderableMesh = {
		lods: [
			{
				numVertices: nv,
				positions: Float32Array.from(positions),
				normals: Float32Array.from(normals),
				uv: Float32Array.from(uvs),
				colors: Float32Array.from(colors),
				indices: nv > 0xffff ? Uint32Array.from(indices) : Uint16Array.from(indices),
				sections,
				label: `${nv.toLocaleString()} verts, ${tris.toLocaleString()} tris`,
			},
		],
		upAxis: 'y-up',
	};
	return { nud, mesh, textures, texturesFound, texturesWanted, hidden: nud.meshes.length - meshes.length };
}

// ----- NUS3BANK -----

/** `.nus3bank` container: one `.wav` per playable tone. */
export function makeNus3BankNode(id: string, name: string, blob: Blob): Node {
	return {
		id,
		name,
		kind: 'nus3bank',
		isContainer: true,
		size: blob.size,
		format: 'NUS3BANK',
		blob: async () => blob,
		getChildren: async () => {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			if (!isNus3Bank(bytes)) throw new Error('Not a NUS3BANK');
			const bank = parseNus3Bank(bytes);
			const used = new Set<string>();
			const nodes: Node[] = [];
			for (const t of bank.tones) {
				const stem = (t.name || `tone_${t.index}`).replace(/[^\w.-]/g, '_');
				let leaf = `${stem}.wav`;
				for (let i = 1; used.has(leaf.toLowerCase()); i++) leaf = `${stem}_${i}.wav`;
				used.add(leaf.toLowerCase());
				const stream = bytes.subarray(t.offset, t.offset + t.size);
				if (t.codec !== 'IDSP') {
					nodes.push({
						id: `${id}/${stem}.${t.codec.trim().toLowerCase() || 'bin'}`,
						name: `${stem}.${t.codec.trim().toLowerCase() || 'bin'}`,
						kind: 'file',
						isContainer: false,
						size: t.size,
						format: `NUS3 ${t.codec || 'stream'}`,
						blob: async () => blob.slice(t.offset, t.offset + t.size),
					});
					continue;
				}
				let info: ReturnType<typeof readIdspInfo> | null = null;
				try {
					info = readIdspInfo(stream);
				} catch {
					info = null;
				}
				nodes.push({
					id: `${id}/${leaf}`,
					name: leaf,
					kind: 'file',
					isContainer: false,
					size: info ? 44 + info.numSamples * info.channels * 2 : t.size * 4,
					format: info ? `IDSP ${info.channels}ch ${info.sampleRate} Hz` : 'IDSP',
					meta: { contentKey: `nus3:${t.name}:${t.size}:${fnv(stream, 0x40, 0x60)}` },
					blob: async () => {
						const raw = new Uint8Array(await blob.slice(t.offset, t.offset + t.size).arrayBuffer());
						const d = decodeIdsp(raw);
						return u8Blob(encodeWav(d.samples, d.sampleRate, d.channels), 'audio/wav');
					},
				});
			}
			return nodes;
		},
	};
}
