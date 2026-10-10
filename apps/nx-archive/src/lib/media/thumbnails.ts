/**
 * Library thumbnails. One shared offscreen WebGL renderer draws every
 * model (browsers cap live WebGL contexts at ~16, so a grid of live
 * viewers is not an option); images are decoded and downscaled; audio
 * gets a waveform plus its duration; fonts a type sample; native video
 * a frame. Results — and the facts learned making them (durations,
 * triangle counts, missing textures) — are cached in IndexedDB so a
 * reopened file shows them instantly.
 */

import * as THREE from 'three';

import type { Node } from '../archive';
import {
	parseBntxForView,
	parseBtiForView,
	parseFf7TexForView,
	parseFontForView,
	parsePhyreForView,
} from '../preview';
import { parseDds } from '@tootallnate/dds';
import { findNodeById } from '../unity-external';
import { decodeAudioBlob } from './audio';
import { loadThumb, saveThumb, type ThumbRecord } from './cache';
import { canLoadModelHeadless, loadModelAsset, modelAssetToExportMeshes, type ModelAsset } from './model-assets';
import type { ExportMaterial } from '../mesh-export';
import type { MediaInfo, MediaItem, MediaKind, MediaStatus } from './types';

/** Bump to regenerate cached thumbnails. */
export const THUMB_VERSION = 5;
const SIZE = 256;

export interface ThumbResult {
	url?: string;
	info?: MediaInfo;
	error?: string;
}

/** Facts reported back to the index after a thumbnail is made. */
export interface ItemPatch {
	/** The item turned out not to be media (e.g. a texture-only BFRES): remove it. */
	drop?: boolean;
	info?: MediaInfo;
	status?: MediaStatus;
	note?: string;
	kind?: MediaKind;
}

interface Rgba {
	width: number;
	height: number;
	pixels: Uint8Array | Uint8ClampedArray;
	flipY?: boolean;
}

function canvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

const toPng = (c: HTMLCanvasElement) =>
	new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));

/** Downscale RGBA pixels into a ≤256 px PNG. */
async function rgbaThumb(img: Rgba): Promise<Blob> {
	const src = canvas(img.width, img.height);
	const ctx = src.getContext('2d')!;
	const data = ctx.createImageData(img.width, img.height);
	data.data.set(img.pixels.subarray(0, img.width * img.height * 4));
	ctx.putImageData(data, 0, 0);
	const scale = Math.min(1, SIZE / Math.max(img.width, img.height));
	const out = canvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
	const octx = out.getContext('2d')!;
	octx.imageSmoothingQuality = 'high';
	if (img.flipY) {
		octx.translate(0, out.height);
		octx.scale(1, -1);
	}
	octx.drawImage(src, 0, 0, out.width, out.height);
	return toPng(out);
}

async function bitmapThumb(blob: Blob): Promise<{ png: Blob; width: number; height: number }> {
	const bmp = await createImageBitmap(blob);
	const scale = Math.min(1, SIZE / Math.max(bmp.width, bmp.height));
	const out = canvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
	out.getContext('2d')!.drawImage(bmp, 0, 0, out.width, out.height);
	const res = { png: await toPng(out), width: bmp.width, height: bmp.height };
	bmp.close();
	return res;
}

/** Decode an image node to RGBA. Null when the format has no cheap decoder. */
async function decodeImage(node: Node, previewKind: string): Promise<(Rgba & { count?: number }) | null> {
	const blob = await node.blob!();
	switch (previewKind) {
		case 'bntx-image': {
			const v = await parseBntxForView(blob);
			return { width: v.texture.width, height: v.texture.height, pixels: v.pixels, count: v.parsed.textures.length };
		}
		case 'dds-image': {
			const d = parseDds(new Uint8Array(await blob.arrayBuffer()));
			return { width: d.width, height: d.height, pixels: d.pixels };
		}
		case 'bti-image': {
			const v = await parseBtiForView(blob);
			return { width: v.width, height: v.height, pixels: v.pixels };
		}
		case 'phyre-image': {
			const v = await parsePhyreForView(blob);
			return { width: v.texture.width, height: v.texture.height, pixels: v.pixels };
		}
		case 'ff7-tex': {
			const v = await parseFf7TexForView(blob);
			return { width: v.width, height: v.height, pixels: v.pixels };
		}
		default:
			return null;
	}
}

// ---- models ----

let sharedRenderer: THREE.WebGLRenderer | null = null;

function renderer(): THREE.WebGLRenderer {
	if (!sharedRenderer) {
		const c = canvas(SIZE, SIZE);
		sharedRenderer = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
		sharedRenderer.setPixelRatio(1);
		sharedRenderer.setSize(SIZE, SIZE, false);
		sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
	}
	return sharedRenderer;
}

function wrap(w: string | undefined): THREE.Wrapping {
	if (w === 'clamp') return THREE.ClampToEdgeWrapping;
	if (w === 'mirror') return THREE.MirroredRepeatWrapping;
	return THREE.RepeatWrapping;
}

/** Group consecutive equal `triangleMaterials` into geometry groups. */
function addMaterialGroups(geom: THREE.BufferGeometry, tris: ArrayLike<number> | null | undefined, count: number): void {
	if (!tris || tris.length === 0) {
		geom.addGroup(0, count * 3, 0);
		return;
	}
	let start = 0;
	for (let t = 1; t <= count; t++) {
		if (t === count || tris[t] !== tris[start]) {
			geom.addGroup(start * 3, (t - start) * 3, tris[start] ?? 0);
			start = t;
		}
	}
}

function materialFor(m: ExportMaterial | undefined, hasColors: boolean, owned: THREE.Texture[]): THREE.Material {
	const t = m?.texture;
	if (t) {
		const tex = new THREE.DataTexture(
			t.pixels instanceof Uint8Array || t.pixels instanceof Uint8ClampedArray ? t.pixels : Uint8Array.from(t.pixels),
			t.width,
			t.height,
			THREE.RGBAFormat,
			THREE.UnsignedByteType,
		);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.wrapS = wrap(t.wrapS);
		tex.wrapT = wrap(t.wrapT);
		tex.flipY = t.flipY ?? false;
		tex.needsUpdate = true;
		owned.push(tex);
		return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, alphaTest: 0.5 });
	}
	if (m?.baseColor) {
		const [r, g, b] = m.baseColor;
		return new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), side: THREE.DoubleSide });
	}
	if (m?.useVertexColors && hasColors) return new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
	return new THREE.MeshLambertMaterial({ color: 0xbdbdbd, side: THREE.DoubleSide });
}

/**
 * Render a posed asset from a front three-quarter view. Draws the same
 * world-space meshes (and colour sources) the exporters receive, so
 * thumbnails and exports always agree.
 */
export async function renderModelThumb(asset: ModelAsset): Promise<Blob> {
	const scene = new THREE.Scene();
	const geoms: THREE.BufferGeometry[] = [];
	const owned: THREE.Texture[] = [];
	const materials: THREE.Material[] = [];
	for (const em of modelAssetToExportMeshes(asset)) {
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.BufferAttribute(em.positions, 3));
		if (em.uvs) geom.setAttribute('uv', new THREE.BufferAttribute(em.uvs, 2));
		const hasColors = !!em.colors;
		if (em.colors) geom.setAttribute('color', new THREE.BufferAttribute(em.colors, em.colorStride ?? 3));
		geom.setIndex(new THREE.BufferAttribute(em.indices, 1));
		addMaterialGroups(geom, em.triangleMaterials, em.indices.length / 3);
		geom.computeVertexNormals();
		geoms.push(geom);
		const mats = (em.materials?.length ? em.materials : [undefined]).map((m) => materialFor(m, hasColors, owned));
		materials.push(...mats);
		scene.add(new THREE.Mesh(geom, mats));
	}
	scene.add(new THREE.AmbientLight(0xffffff, 1.6));
	const dir = new THREE.DirectionalLight(0xffffff, 1.4);
	dir.position.set(2, 4, 3);
	scene.add(dir);
	scene.updateMatrixWorld(true);

	const box = new THREE.Box3();
	for (const g of geoms) {
		g.computeBoundingBox();
		box.union(g.boundingBox!);
	}
	const center = box.getCenter(new THREE.Vector3());
	const sizeV = box.getSize(new THREE.Vector3());
	const radius = Math.max(sizeV.length() / 2, 1e-3);
	const camera = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100);
	const dist = radius / Math.sin(THREE.MathUtils.degToRad(35 / 2));
	camera.position.copy(center).add(new THREE.Vector3(0.55, 0.35, 1).normalize().multiplyScalar(dist * 0.95));
	camera.lookAt(center);

	const r = renderer();
	r.setClearColor(0x000000, 0);
	r.render(scene, camera);
	const png = await toPng(r.domElement);
	for (const g of geoms) g.dispose();
	for (const m of materials) m.dispose();
	for (const t of owned) t.dispose();
	return png;
}

// ---- audio ----

async function audioThumb(blob: Blob): Promise<{ png: Blob; durationSec: number }> {
	const ab = await blob.arrayBuffer();
	const ctx = new OfflineAudioContext(1, 1, 44100);
	const buf = await ctx.decodeAudioData(ab);
	const W = SIZE, H = 96, bins = 96;
	const peaks = new Float32Array(bins);
	for (let c = 0; c < buf.numberOfChannels; c++) {
		const d = buf.getChannelData(c);
		const step = Math.max(1, Math.floor(d.length / bins));
		for (let b = 0; b < bins; b++) {
			let m = 0;
			const end = Math.min(d.length, (b + 1) * step);
			for (let i = b * step; i < end; i += 4) {
				const v = Math.abs(d[i]!);
				if (v > m) m = v;
			}
			if (m > peaks[b]!) peaks[b] = m;
		}
	}
	const max = Math.max(1e-3, ...peaks);
	const c = canvas(W, H);
	const g = c.getContext('2d')!;
	g.fillStyle = '#8b5cf6';
	const bw = W / bins;
	for (let b = 0; b < bins; b++) {
		const h = Math.max(2, (peaks[b]! / max) * (H - 8));
		g.fillRect(b * bw + 0.5, (H - h) / 2, Math.max(1, bw - 1.5), h);
	}
	return { png: await toPng(c), durationSec: buf.duration };
}

// ---- fonts ----

let fontSeq = 0;

async function fontThumb(node: Node): Promise<{ png: Blob; family?: string }> {
	const v = await parseFontForView(await node.blob!());
	const family = `nxlib-font-${++fontSeq}`;
	const face = new FontFace(family, await v.font.arrayBuffer());
	await face.load();
	document.fonts.add(face);
	try {
		const c = canvas(SIZE, 128);
		const g = c.getContext('2d')!;
		g.fillStyle = '#e5e7eb';
		g.textBaseline = 'middle';
		g.font = `64px "${family}"`;
		g.fillText('Aa', 12, 48);
		g.font = `22px "${family}"`;
		g.fillText('Bb Cc 123 あア', 12, 104);
		return { png: await toPng(c), family: v.names.family };
	} finally {
		document.fonts.delete(face);
	}
}

// ---- video ----

async function videoThumb(blob: Blob): Promise<{ png: Blob; durationSec: number; width: number; height: number }> {
	const url = URL.createObjectURL(blob);
	try {
		const video = document.createElement('video');
		video.muted = true;
		video.preload = 'auto';
		video.src = url;
		await new Promise<void>((resolve, reject) => {
			video.onloadedmetadata = () => resolve();
			video.onerror = () => reject(new Error('Video could not be decoded by the browser'));
		});
		video.currentTime = Math.min(1, video.duration / 3 || 0);
		await new Promise<void>((resolve) => {
			video.onseeked = () => resolve();
		});
		const scale = Math.min(1, SIZE / Math.max(video.videoWidth, video.videoHeight));
		const c = canvas(Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale));
		c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
		return { png: await toPng(c), durationSec: video.duration, width: video.videoWidth, height: video.videoHeight };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Long clips are music regardless of where they live. */
const MUSIC_MIN_SECONDS = 45;

/**
 * Queued, cached thumbnail generation for one opened file.
 */
export class ThumbnailService {
	private readonly mem = new Map<string, Promise<ThumbResult>>();
	private readonly urls: string[] = [];
	/** Pending jobs, newest last; run newest-first so what's on screen wins. */
	private queue: { id: string; run: () => Promise<void>; cancel: () => void }[] = [];
	private running = 0;
	private disposed = false;

	constructor(
		private readonly fileKey: string | null,
		private readonly root: Node,
		private readonly onPatch: (itemId: string, patch: ItemPatch) => void,
		private readonly concurrency = 2,
	) {}

	dispose(): void {
		this.disposed = true;
		this.queue = [];
		for (const u of this.urls) URL.revokeObjectURL(u);
	}

	/**
	 * The caller no longer needs `itemId`'s thumbnail (its card scrolled
	 * away or was filtered out): drop it from the queue if it hasn't
	 * started, so on-screen cards aren't stuck behind stale work.
	 */
	release(itemId: string): void {
		const i = this.queue.findIndex((j) => j.id === itemId);
		if (i < 0) return;
		const [job] = this.queue.splice(i, 1);
		this.mem.delete(itemId);
		job!.cancel();
	}

	/** Thumbnail for `item` (memory → IndexedDB → generated). */
	get(item: MediaItem): Promise<ThumbResult> {
		let p = this.mem.get(item.id);
		if (!p) {
			p = this.load(item);
			this.mem.set(item.id, p);
		}
		return p;
	}

	private url(blob: Blob): string {
		const u = URL.createObjectURL(blob);
		this.urls.push(u);
		return u;
	}

	private async load(item: MediaItem): Promise<ThumbResult> {
		if (this.fileKey) {
			const cached = await loadThumb(this.fileKey, item.id);
			if (cached && cached.v === THUMB_VERSION) return this.toResult(cached);
		}
		const rec = await this.enqueue(item.id, () => this.generate(item));
		if (this.fileKey && !this.disposed) void saveThumb(this.fileKey, item.id, rec);
		return this.toResult(rec);
	}

	private toResult(rec: ThumbRecord): ThumbResult {
		return { url: rec.blob ? this.url(rec.blob) : undefined, info: rec.info, error: rec.error };
	}

	private enqueue<T>(id: string, job: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				id,
				run: async () => {
					try {
						resolve(await job());
					} catch (err) {
						reject(err);
					}
				},
				cancel: () => reject(new Error('cancelled')),
			});
			this.pump();
		});
	}

	private pump(): void {
		while (this.running < this.concurrency && this.queue.length && !this.disposed) {
			const job = this.queue.pop()!;
			this.running++;
			// Let the UI breathe between jobs.
			void new Promise((r) => setTimeout(r, 0))
				.then(job.run)
				.finally(() => {
					this.running--;
					this.pump();
				});
		}
	}

	private async generate(item: MediaItem): Promise<ThumbRecord> {
		const node = await findNodeById(this.root, item.id);
		if (!node?.blob) return { v: THUMB_VERSION, error: 'File not found in the tree' };
		try {
			const r = await this.make(item, node);
			const patch: ItemPatch = { info: r.info };
			if (r.partial) {
				patch.status = 'partial';
				patch.note = r.partial;
			}
			if (r.info?.durationSec !== undefined && (item.kind === 'sound' || item.kind === 'music')) {
				if (r.info.durationSec >= MUSIC_MIN_SECONDS && item.kind === 'sound') patch.kind = 'music';
			}
			this.onPatch(item.id, patch);
			return { v: THUMB_VERSION, blob: r.png, info: r.info, error: r.partial };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Texture / animation-only BFRES files look like models by name.
			if (/no extractable geometry/i.test(message)) {
				this.onPatch(item.id, { drop: true });
				return { v: THUMB_VERSION, error: message };
			}
			this.onPatch(item.id, { status: 'error', note: message });
			return { v: THUMB_VERSION, error: message };
		}
	}

	private async make(item: MediaItem, node: Node): Promise<{ png?: Blob; info?: MediaInfo; partial?: string }> {
		switch (item.kind) {
			case 'model': {
				if (!canLoadModelHeadless(item.previewKind)) return {};
				const asset = await loadModelAsset(node, item.previewKind, this.root);
				const info: MediaInfo = {
					triangles: asset.triangles,
					vertices: asset.vertices,
					textures: asset.texturesFound,
					animations: asset.animations,
				};
				const missing = asset.texturesFound && asset.texturesFound[0] < asset.texturesFound[1];
				return {
					png: await renderModelThumb(asset),
					info,
					partial: missing ? `${asset.texturesFound![1] - asset.texturesFound![0]} of ${asset.texturesFound![1]} textures not found` : undefined,
				};
			}
			case 'image': {
				if (item.previewKind === 'image') {
					const r = await bitmapThumb(await node.blob!());
					return { png: r.png, info: { width: r.width, height: r.height } };
				}
				const img = await decodeImage(node, item.previewKind);
				if (!img) return {};
				return { png: await rgbaThumb(img), info: { width: img.width, height: img.height, count: img.count } };
			}
			case 'music':
			case 'sound': {
				const blob = await decodeAudioBlob(node, item.previewKind);
				if (!blob) return {};
				const r = await audioThumb(blob);
				return { png: r.png, info: { durationSec: r.durationSec } };
			}
			case 'font': {
				if (item.previewKind !== 'bfttf-info' && item.previewKind !== 'font-info') return {};
				const r = await fontThumb(node);
				return { png: r.png };
			}
			case 'video': {
				if (item.previewKind !== 'video') return {};
				const r = await videoThumb(await node.blob!());
				return { png: r.png, info: { durationSec: r.durationSec, width: r.width, height: r.height } };
			}
		}
		return {};
	}
}
