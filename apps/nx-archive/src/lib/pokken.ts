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
import { decryptDrp, findLiteralTable, isDrp, parseDrp, peekDrpPart, readDrpPart, type DrpArchive } from '@tootallnate/drp';
import {
	decodeNutTexture,
	isNut,
	isVbn,
	nutFormatName,
	isNuf,
	parseNud,
	parseNuf,
	parseNut,
	isOmo,
	parseOmo,
	parseVbn,
	renderNufText,
	sampleOmo,
	skinMatrices,
	vbnPoseMatrices,
	vbnWorldMatrices,
	type Mat4,
	type NudModel,
	type Omo,
	type VbnBone,
	type NufFont,
	type NutFile,
	type NutImage,
	type NutTexture,
} from '@tootallnate/nu3';
import { decodeIdsp, isNus3Bank, parseNus3Bank, readIdspInfo } from '@tootallnate/nus3';
import { encodeWav } from '@tootallnate/dsp-adpcm';

import type { RenderableMesh } from '~/components/mesh-viewer';
import type { Node } from './archive';
import { encodePng } from './png';
import type { DecodedTexture as ViewTexture } from './uasset-material-chain';
import { exefsMainFor, nsoImage } from './title-exefs';
import { findNodeById } from './unity-external';

// ----- Version 5 literal table (from the title's `main`) -----

const literalTables = new Map<() => Promise<Blob | null>, Promise<Uint8Array | null>>();

/** The version 5 DRP literal table of the title `nodeId` belongs to. */
function literalTableFor(nodeId: string): Promise<Uint8Array | null> {
	const getMain = exefsMainFor(nodeId);
	if (!getMain) return Promise.resolve(null);
	let p = literalTables.get(getMain);
	if (!p) {
		p = (async () => {
			const main = await getMain();
			return main ? findLiteralTable(await nsoImage(main)) : null;
		})().catch(() => null);
		literalTables.set(getMain, p);
	}
	return p;
}

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
	/** Version 5 only: the title's literal table (null if not found). */
	literalTable: Uint8Array | null;
	/** Bytes of one part (inflated), through the LRU. */
	part(entryIndex: number, partIndex: number): Promise<Uint8Array>;
	/** The first `n` bytes of a part, without inflating all of it. */
	peek(entryIndex: number, partIndex: number, n: number): Promise<Uint8Array>;
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
	const literalTable = archive.version === 5 || archive.version === 6 ? await literalTableFor(id) : null;
	const listing: DrpListing = {
		id,
		archive,
		literalTable,
		part(ei, pi) {
			const e = archive.entries[ei]!;
			const p = e.parts[pi]!;
			return cached(`drp:${id}#${ei}.${pi}`, p.size, async () => readDrpPart(await drpBytes(id, blob), e, p, { literalTable }));
		},
		async peek(ei, pi, n) {
			const e = archive.entries[ei]!;
			return peekDrpPart(await drpBytes(id, blob), e, e.parts[pi]!, n, { literalTable });
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
	if (m === 'NUF\0') return 'nuf';
	return 'bin';
}

export interface DrpChildHooks {
	/** Route a leaf through the generic dispatch (images, audio, …). */
	childFor: (id: string, name: string, blob: Blob) => Promise<Node>;
}

/** NUF leaves' font references: the metrics part and its atlas (a NUT part). */
export interface Nu3FontRef {
	drpId: string;
	entry: number;
	nuf: number;
	nut: number;
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
			const head = peekDrpPart(decrypted, e, p, 16, { literalTable: listing.literalTable });
			const ext = extForMagic(head);
			const stem = e.name.replace(/\.(nut|nud|vbn|omo)$/i, '') || `entry_${ei}`;
			const name = unique(`${stem}.${ext}`);
			const childId = `${id}/${name}`;
			const read = () => listing.part(ei, pi);
			const size = p.size;
			const key = `drp:${e.name}:${pi}:${size}:${fnv(decrypted, p.offset, Math.min(p.offset + p.length, p.offset + 64))}`;
			if (ext === 'nuf') {
				const nut = e.parts.findIndex((q, qi) => qi !== pi && extForMagic(peekDrpPart(decrypted, e, q, 4, { literalTable: listing.literalTable })) === 'nut');
				out.push(
					Promise.resolve<Node>({
						id: childId,
						name,
						kind: 'file',
						isContainer: false,
						size,
						format: 'NUF bitmap font',
						meta: {
							contentKey: key,
							...(nut >= 0 ? { nu3Font: { drpId: id, entry: ei, nuf: pi, nut } satisfies Nu3FontRef } : {}),
						},
						blob: async () => u8Blob(await read()),
					}),
				);
			} else if (ext === 'nut') out.push(Promise.resolve(makeNutNode(childId, name, read, size, key)));
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
	/** Skeleton, skinning data and clips, when a VBN was found for the model. */
	skin: Nu3Skin | null;
}

export interface Nu3Skin {
	skeleton: Nu3Skeleton;
	/** Bind-pose positions and normals (what the mesh starts with). */
	positions: Float32Array;
	normals: Float32Array;
	/** 4 bone indices per vertex (0xFFFF = none) and their weights. */
	joints: Uint16Array;
	weights: Float32Array;
	/** Clip to open on (an idle when there is one), else -1. */
	defaultClip: number;
}

/** Linear-blend skin `skin`'s bind pose with `matrices` into `outPos` / `outNrm`. */
export function skinNu3(skin: Nu3Skin, matrices: Mat4[], outPos: Float32Array, outNrm: Float32Array | null): void {
	const { positions: P, normals: N, joints: J, weights: W } = skin;
	const n = P.length / 3;
	for (let v = 0; v < n; v++) {
		const px = P[v * 3]!, py = P[v * 3 + 1]!, pz = P[v * 3 + 2]!;
		const nx = N[v * 3]!, ny = N[v * 3 + 1]!, nz = N[v * 3 + 2]!;
		let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, total = 0;
		for (let k = 0; k < 4; k++) {
			const j = J[v * 4 + k]!;
			const w = W[v * 4 + k]!;
			if (j === 0xffff || !w) continue;
			const m = matrices[j];
			if (!m) continue;
			x += w * (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!);
			y += w * (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!);
			z += w * (m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!);
			a += w * (m[0]! * nx + m[4]! * ny + m[8]! * nz);
			b += w * (m[1]! * nx + m[5]! * ny + m[9]! * nz);
			c += w * (m[2]! * nx + m[6]! * ny + m[10]! * nz);
			total += w;
		}
		if (total < 1e-6) {
			x = px;
			y = py;
			z = pz;
			a = nx;
			b = ny;
			c = nz;
		} else if (Math.abs(total - 1) > 1e-3) {
			x /= total;
			y /= total;
			z /= total;
		}
		outPos[v * 3] = x;
		outPos[v * 3 + 1] = y;
		outPos[v * 3 + 2] = z;
		if (outNrm) {
			const l = Math.hypot(a, b, c) || 1;
			outNrm[v * 3] = a / l;
			outNrm[v * 3 + 1] = b / l;
			outNrm[v * 3 + 2] = c / l;
		}
	}
}

/**
 * Pose matrices for `clip` at `frame` (or the bind pose for no clip).
 * Clips play in place: root bones keep their bind X / Z, so an attack's
 * root motion doesn't carry the model out of view (jumps still rise).
 */
export function nu3PoseMatrices(skeleton: Nu3Skeleton, omo: Omo | null, frame: number): Mat4[] {
	const sample = omo ? sampleOmo(omo, frame) : null;
	if (sample) {
		for (const b of skeleton.bones) {
			if (b.parent >= 0) continue;
			const s = sample.get(b.id);
			if (s?.t) s.t = [b.position[0], s.t[1], b.position[2]];
		}
	}
	return skinMatrices(skeleton.bind, vbnPoseMatrices(skeleton.bones, sample));
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

export interface Nu3Clip {
	name: string;
	frameCount: number;
	load(): Promise<Omo>;
}

export interface Nu3Skeleton {
	bones: VbnBone[];
	bind: Mat4[];
	clips: Nu3Clip[];
}

/**
 * The skeleton and animations for a model. Stage elements keep theirs in
 * the same DRP (VBN / OMO entries named after the model); a character's
 * body (`chrdep/…/dep<id>.drp`) takes them from `chrind/…/ind<id>.drp`
 * (`bindpose_…` plus its OMO clips), costumes `_x01` sharing `_x00`'s.
 */
async function skeletonFor(ref: Nu3ModelRef, listing: DrpListing, modelStem: string, root: Node | null): Promise<Nu3Skeleton | null> {
	const candidates: { listing: DrpListing; prefix: string | null }[] = [];
	const stem = modelStem.toLowerCase();
	candidates.push({ listing, prefix: stem });
	const m = /^(.*)\/chrdep\/(.*)\/dep([^/]+)\.drp$/.exec(ref.drpId);
	if (m) {
		const code = m[3]!;
		for (const c of new Set([code, code.replace(/\d$/, '0')])) {
			const other = await drpById(`${m[1]}/chrind/${m[2]}/ind${c}.drp`, root).catch(() => null);
			if (other) candidates.push({ listing: other, prefix: null });
		}
	}
	for (const { listing: l, prefix } of candidates) {
		const entries = l.archive.entries;
		const matches = (name: string) => prefix === null || name.toLowerCase().startsWith(prefix);
		let vbnIndex = entries.findIndex((e) => /^bindpose/i.test(e.name) && matches(e.name));
		if (vbnIndex < 0 && prefix !== null) {
			for (let i = 0; i < entries.length && vbnIndex < 0; i++) {
				if (entries[i]!.parts.length !== 1 || !matches(entries[i]!.name)) continue;
				const head = await l.peek(i, 0, 4);
				if (isVbn(new Uint8Array([...head, ...new Uint8Array(0x18)]))) vbnIndex = i;
			}
		}
		if (vbnIndex < 0) continue;
		const vbnBytes = await l.part(vbnIndex, 0).catch(() => null);
		if (!vbnBytes || !isVbn(vbnBytes)) continue;
		const bones = parseVbn(vbnBytes);
		const clips: Nu3Clip[] = [];
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i]!;
			if (e.parts.length !== 1 || !matches(e.name)) continue;
			const head = await l.peek(i, 0, 0x14);
			if (head.byteLength < 0x14 || !isOmo(new Uint8Array([...head, ...new Uint8Array(0x0c)]))) continue;
			const frameCount = (head[0x10]! << 8) | head[0x11]!;
			if (frameCount < 1) continue;
			let parsed: Promise<Omo> | null = null;
			clips.push({ name: e.name, frameCount, load: () => (parsed ??= l.part(i, 0).then(parseOmo)) });
		}
		return { bones, bind: vbnWorldMatrices(bones), clips };
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
	const modelStem = node.name.replace(/\.[^.]+$/, '');
	const skeleton = listing && ref ? await skeletonFor(ref, listing, modelStem, root).catch(() => null) : null;
	const bones = skeleton?.bind ?? null;
	const jointList: number[] = [];
	const weightList: number[] = [];

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
				if (p.boneIds && p.boneWeights) {
					for (let k = 0; k < 4; k++) {
						const w = p.boneWeights[v * 4 + k]!;
						jointList.push(w > 0 ? p.boneIds[v * 4 + k]! : 0xffff);
						weightList.push(w);
					}
				} else {
					// Rigid: the mesh's single-bind bone, else static.
					jointList.push(m.singleBind >= 0 ? m.singleBind : 0xffff, 0xffff, 0xffff, 0xffff);
					weightList.push(m.singleBind >= 0 ? 1 : 0, 0, 0, 0);
				}
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
	let skin: Nu3Skin | null = null;
	const boneCount = skeleton?.bones.length ?? 0;
	if (skeleton && jointList.every((j) => j === 0xffff || j < boneCount)) {
		// Fighters have `demo_idle` clips; support Pokémon a "kamae" (stance) loop.
		const prefer = [/demo_idle/i, /(^|_)(idle|wait)/i, /kamaeloop/i, /_co_kamae$/i, /_kamae$/i];
		let idle = -1;
		for (const re of prefer) if (idle < 0) idle = skeleton.clips.findIndex((c) => re.test(c.name));
		skin = {
			skeleton,
			// Copies: the viewer skins into the mesh's own arrays.
			positions: Float32Array.from(mesh.lods[0]!.positions),
			normals: Float32Array.from(mesh.lods[0]!.normals!),
			joints: Uint16Array.from(jointList),
			weights: Float32Array.from(weightList),
			defaultClip: idle >= 0 ? idle : -1,
		};
	}
	return { nud, mesh, textures, texturesFound, texturesWanted, hidden: nud.meshes.length - meshes.length, skin };
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

// ----- NUF bitmap fonts -----

export interface Nu3FontView {
	font: NufFont;
	atlas: NutImage;
	/** Icon fonts (RGBA atlas, e.g. button glyphs) draw in colour. */
	color: boolean;
	atlasFormat: string;
	/** Sample text, RGBA on transparent. */
	sample: NutImage;
}

const SAMPLE_LINES = [
	'The quick brown fox jumps over the lazy dog.',
	'ABCDEFGHIJKLM NOPQRSTUVWXYZ 0123456789 !?&%',
	'ポッ拳 あいうえお アイウエオ 対戦開始',
];

/** Sample lines a font can draw: the pangrams, or its whole glyph set in rows. */
export function nu3FontSampleLines(font: NufFont, color: boolean): string[] {
	const has = (line: string) => [...line].filter((c) => c !== ' ').every((c) => font.glyphs.has(c.codePointAt(0)!));
	const lines = color ? [] : SAMPLE_LINES.filter(has);
	if (lines.length > 0) return lines;
	const chars = [...font.glyphs.keys()].filter((c) => c > 0x20).map((c) => String.fromCharCode(c));
	const rows: string[] = [];
	for (let i = 0; i < Math.min(chars.length, 96); i += 16) rows.push(chars.slice(i, i + 16).join(''));
	return rows;
}

/** Composite a transparent RGBA image onto a dark background. */
export function onDark(img: NutImage, shade = 32): NutImage {
	const out = new Uint8Array(img.pixels.length);
	for (let i = 0; i < out.length; i += 4) {
		const a = img.pixels[i + 3]! / 255;
		for (let c = 0; c < 3; c++) out[i + c] = Math.round(img.pixels[i + c]! * a + shade * (1 - a));
		out[i + 3] = 255;
	}
	return { width: img.width, height: img.height, pixels: out };
}

export async function loadNu3FontView(node: Node, root: Node | null): Promise<Nu3FontView> {
	const ref = node.meta?.nu3Font as Nu3FontRef | undefined;
	if (!ref) throw new Error('This NUF has no glyph atlas beside it');
	const listing = await drpById(ref.drpId, root);
	if (!listing) throw new Error('Containing DRP not found');
	const nufBytes = await listing.part(ref.entry, ref.nuf);
	const nutBytes = await listing.part(ref.entry, ref.nut);
	if (!isNuf(nufBytes) || !isNut(nutBytes)) throw new Error('Not a NUF font with a NUT atlas');
	const font = parseNuf(nufBytes);
	const tex = parseNut(nutBytes).textures[0];
	if (!tex) throw new Error('The glyph atlas has no texture');
	const atlas = decodeNutTexture(nutBytes, tex);
	const color = tex.surfaces[0]!.size === tex.width * tex.height * 4;
	const sample = renderNufText(font, atlas, nu3FontSampleLines(font, color), { mode: color ? 'color' : 'coverage', maxWidth: 1600 });
	return { font, atlas, color, atlasFormat: `${color ? 'RGBA8' : nutFormatName(tex.format)} ${tex.width}×${tex.height}`, sample };
}
