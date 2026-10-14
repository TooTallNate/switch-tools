/**
 * Pokémon Scarlet / Violet's `arc/data.trpfs` + `arc/data.trpfd`
 * (Game Freak's Trinity file system) as browsable folders.
 *
 * Files are known only by path hashes, so names are recovered from the
 * game's own data (`@tootallnate/trpfs`):
 *
 * - The Pokémon catalog lists every species / form's model, material and
 *   animation paths. Each model folder becomes a directory.
 * - Listing a model folder reads its `.trmdl` and names what it
 *   references (meshes, skeleton, materials), then each `.trmsh`'s
 *   buffer and each `.trmtr`'s textures, by hashing candidate paths
 *   against the descriptor. Named files are gathered from whichever pack
 *   holds them, so the existing Trinity model viewer finds its siblings.
 * - Everything else is listed per pack, files named by hash.
 *
 * Packs are read from the `.trpfs` on demand into a small byte-budget
 * LRU; Oodle-compressed files decode through the user's `oodle.wasm`.
 */
import {
	folderOf,
	gfFnv64,
	packRange,
	parsePokemonCatalog,
	parseTrpak,
	parseTrpfd,
	parseTrpfsIndex,
	POKEMON_CATALOG_PATH,
	TrinityNames,
	trpfsIndexOffset,
	type PokemonCatalogEntry,
	type TrpakFile,
	type Trpfd,
	type TrpfsIndex,
} from '@tootallnate/trpfs';
import { sniffGflx } from '@tootallnate/gfbmdl';
import { parseTrmdl, parseTrmsh, parseTrmtr, sniffTrinity } from '@tootallnate/trinity';

export type OodleFn = (compressed: Uint8Array, size: number) => Promise<Uint8Array>;

export interface TrinityFs {
	fd: Trpfd;
	index: TrpfsIndex;
	names: TrinityNames;
	/** File hash → descriptor index. */
	fileIndex: Map<bigint, number>;
	catalog: PokemonCatalogEntry[];
	/** Raw pack entries (cached). */
	pack(packIndex: number): Promise<TrpakFile[]>;
	/** One file's bytes, decompressed. */
	read(hash: bigint): Promise<Uint8Array | null>;
	/** Pack index of a file hash, or −1. */
	packOf(hash: bigint): number;
}

const PACK_BUDGET = 256 * 1024 * 1024;

export async function openTrinityFs(blob: Blob, trpfd: Blob, oodle: () => OodleFn): Promise<TrinityFs> {
	const fd = parseTrpfd(new Uint8Array(await trpfd.arrayBuffer()));
	const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
	const indexOffset = trpfsIndexOffset(head);
	const index = parseTrpfsIndex(new Uint8Array(await blob.slice(indexOffset).arrayBuffer()), indexOffset);
	const fileIndex = new Map<bigint, number>();
	fd.fileHashes.forEach((h, i) => fileIndex.set(h, i));
	const names = new TrinityNames(new Set(fd.fileHashes));

	const cache = new Map<number, Promise<TrpakFile[]>>();
	const sizes = new Map<number, number>();
	let total = 0;
	const pack = (p: number): Promise<TrpakFile[]> => {
		const hit = cache.get(p);
		if (hit) {
			cache.delete(p);
			cache.set(p, hit);
			return hit;
		}
		const name = fd.packNames[p];
		const range = name ? packRange(index, name) : null;
		const size = range ? range.end - range.start : 0;
		const promise = range
			? blob
					.slice(range.start, range.end)
					.arrayBuffer()
					.then((b) => parseTrpak(new Uint8Array(b)))
			: Promise.resolve([] as TrpakFile[]);
		cache.set(p, promise);
		sizes.set(p, size);
		total += size;
		for (const [k] of cache) {
			if (total <= PACK_BUDGET || cache.size <= 1) break;
			if (k === p) continue;
			cache.delete(k);
			total -= sizes.get(k) ?? 0;
		}
		return promise;
	};
	const packOf = (hash: bigint) => {
		const i = fileIndex.get(hash);
		return i === undefined ? -1 : fd.filePack[i]!;
	};
	const read = async (hash: bigint): Promise<Uint8Array | null> => {
		const p = packOf(hash);
		if (p < 0) return null;
		const f = (await pack(p)).find((x) => x.hash === hash);
		if (!f) return null;
		if (f.encryption === -1) return f.data;
		return oodle()(f.data, f.size);
	};

	let catalog: PokemonCatalogEntry[] = [];
	try {
		const bytes = await read(gfFnv64(POKEMON_CATALOG_PATH));
		if (bytes) catalog = parsePokemonCatalog(bytes);
	} catch {
		// No catalog (or no Oodle): packs still list, by hash.
	}
	for (const e of catalog) {
		for (const p of [e.modelPath, e.materialPath, e.configPath, ...e.paths]) {
			if (p) names.propose(p);
		}
	}
	return { fd, index, names, fileIndex, catalog, pack, read, packOf };
}

/**
 * Name a model folder's files from its `.trmdl` references; returns the
 * folder's files (named ones, then the rest of the model's pack).
 */
export async function nameModelFolder(fs: TrinityFs, modelPath: string): Promise<FolderFile[]> {
	const folder = folderOf(modelPath);
	const tryRead = async (path: string) => {
		const h = gfFnv64(path);
		return fs.names.propose(path) ? fs.read(h).catch(() => null) : null;
	};
	const rel = (name: string) => (name.includes('/') ? name.replace(/^\/+/, '') : folder + name);
	const mdlBytes = await tryRead(modelPath);
	if (mdlBytes) {
		try {
			const mdl = parseTrmdl(mdlBytes);
			for (const m of mdl.meshes) {
				const b = await tryRead(rel(m));
				if (b) {
					try {
						const buf = parseTrmsh(b).bufferFile;
						if (buf) fs.names.propose(rel(buf));
					} catch {
						// keep going
					}
				}
			}
			if (mdl.skeleton) fs.names.propose(rel(mdl.skeleton));
			const mats = new Set<string>();
			for (const m of mdl.materials) {
				mats.add(m);
				mats.add(m.replace(/\.trmtr$/i, '_rare.trmtr'));
			}
			for (const m of mats) {
				const b = await tryRead(rel(m));
				if (!b) continue;
				try {
					for (const mat of parseTrmtr(b).materials) {
						for (const t of mat.textures) {
							if (!t.file) continue;
							if (!fs.names.propose(rel(t.file))) fs.names.propose(t.file);
						}
					}
				} catch {
					// keep going
				}
			}
		} catch {
			// not a model we can read
		}
	}
	const out: FolderFile[] = [];
	const seen = new Set<bigint>();
	for (const [h, p] of fs.names.known) {
		if (p.startsWith(folder) && !p.slice(folder.length).includes('/')) {
			out.push({ hash: h, name: p.slice(folder.length) });
			seen.add(h);
		}
	}
	// The model pack's other (unnamed) files: animations get a `.tranm`
	// name so the viewer picks them up as clips (`<model>_<hash>.tranm`).
	const base = modelPath.slice(folder.length).replace(/\.trmdl$/i, '');
	const p = fs.packOf(gfFnv64(modelPath));
	if (p >= 0) {
		for (const f of await fs.pack(p)) {
			if (seen.has(f.hash)) continue;
			const hex = f.hash.toString(16).padStart(16, '0');
			let ext = 'bin';
			try {
				const bytes = await fs.read(f.hash);
				if (bytes) ext = sniffGflx(bytes) === 'gfbanm' ? 'tranm' : (sniffTrinity(bytes) ?? 'bin');
			} catch {
				// unreadable: keep .bin
			}
			out.push({ hash: f.hash, name: ext === 'tranm' ? `${base}_${hex}.tranm` : `${hex}.${ext}` });
		}
	}
	return out;
}

export interface FolderFile {
	hash: bigint;
	name: string;
}

/** Model folders from the catalog, deduplicated, sorted. */
export function catalogFolders(fs: TrinityFs): { folder: string; modelPath: string }[] {
	const seen = new Map<string, string>();
	for (const e of fs.catalog) {
		if (!e.modelPath) continue;
		const f = folderOf(e.modelPath);
		if (!seen.has(f)) seen.set(f, e.modelPath);
	}
	return [...seen].map(([folder, modelPath]) => ({ folder, modelPath })).sort((a, b) => a.folder.localeCompare(b.folder));
}
