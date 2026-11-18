/**
 * FBX models (`@tootallnate/fbx`) for the viewer: every mesh posed into
 * one buffer, skinned on the CPU per animation frame, with textures
 * found next to the file by name (PNG / TGA).
 *
 * Game rips exported with AssetStudio, such as the PokeMiners
 * `pogo_assets` Pokémon GO models, need some help:
 *
 *  - Material → texture links are often wrong: every material points at
 *    the first texture while the right ones sit unconnected in the file.
 *    A material named `BodyB` gets `pm0025_00_BodyB1.png` when such a
 *    texture is listed.
 *  - Eyes are a second texture (`…_Face1.png`, `…_Eye1.png`) drawn over
 *    the body through the second UV set, with alpha. Most triangles keep
 *    UV1 in 0..1 for something else; face parts sit at V ≥ 1, one unit
 *    band each, reading at the fraction. Band 1 is the eyes (bands 2 and
 *    up are other face parts with textures of their own, Pikachu's
 *    cheeks among them), drawn as a decal where it lands on painted texels.
 *  - Alternative parts carry another form number in the mesh name:
 *    `pm0025_00_SippoSkin` is Pikachu's tail and `pm0025_01_SippoSkin`
 *    the female one. Each set is a variant; the default hides the
 *    alternatives.
 */

import { decodePng, isPng } from '@tootallnate/bitmap-font';
import {
	fbxWorldMatrices,
	parseFbxNodes,
	poseFbxMesh,
	readFbxScene,
	type FbxAnimation,
	type FbxMesh,
	type FbxScene,
} from '@tootallnate/fbx';
import { decodeTga } from '@tootallnate/tga';
import type { Node } from './archive';
import type { RenderableMesh } from '~/components/mesh-viewer';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';

/** Clips sample at this rate (FBX keys are in seconds). */
export const FBX_FPS = 30;

export interface FbxVariant {
	label: string;
	/** Mesh indices drawn. */
	meshes: number[];
}

export interface FbxModelView {
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	triangles: number;
	vertices: number;
	animations: { name: string; frames: number; animation: FbxAnimation }[];
	defaultAnimation: number;
	variants: FbxVariant[];
	variant: number;
	texturesWanted: number;
	texturesFound: number;
	/** Re-pose for a clip frame (-1 = bind pose), rewriting `positions` / `normals`. */
	pose(animation: number, frame: number, positions: Float32Array, normals?: Float32Array): void;
}

const parentIdOf = (id: string) => id.slice(0, id.lastIndexOf('/'));

/** Image files in the FBX's folder, by lowercase name. */
async function siblingImages(node: Node, root: Node | null): Promise<Map<string, Node>> {
	const out = new Map<string, Node>();
	const dir = root ? await findNodeById(root, parentIdOf(node.id)) : null;
	const kids = dir?.getChildren ? (dir._children ?? (dir._children = await dir.getChildren())) : [];
	for (const k of kids) if (!k.isContainer && /\.(png|tga)$/i.test(k.name)) out.set(k.name.toLowerCase(), k);
	return out;
}

async function decodeTexture(node: Node): Promise<DecodedTexture | null> {
	try {
		const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
		let img: { width: number; height: number; pixels: Uint8Array } | null = null;
		if (isPng(bytes)) {
			const p = decodePng(bytes);
			img = { width: p.width, height: p.height, pixels: p.data };
		} else if (/\.tga$/i.test(node.name)) img = decodeTga(bytes);
		if (!img) return null;
		return {
			packagePath: node.name,
			width: img.width,
			height: img.height,
			pixels: img.pixels,
			pixelFormat: 'RGBA8',
			normalReconstructed: false,
			// FBX UVs put V=0 at the bottom.
			flipY: true,
		};
	} catch {
		return null;
	}
}

const PART = /^pm\d+_(\d+)_(.+)$/i;

/** Variant sets from mesh names (see the module comment). */
export function fbxVariants(scene: Pick<FbxScene, 'meshes'>, fileName: string): FbxVariant[] {
	const all = scene.meshes.map((_, i) => i);
	const base = PART.exec(fileName.replace(/\.fbx$/i, ''))?.[1];
	const parts = scene.meshes.map((m) => PART.exec(m.name));
	if (!base || !parts.some(Boolean)) return [{ label: 'Default', meshes: all }];
	const alternatives = new Map<string, Set<number>>(); // form code → meshes replacing a base part
	const replaced = new Map<string, Set<number>>(); // form code → base meshes they replace
	scene.meshes.forEach((_, i) => {
		const p = parts[i];
		if (!p || p[1] === base) return;
		const twin = parts.findIndex((q) => q && q[1] === base && q[2] === p[2]);
		(alternatives.get(p[1]!) ?? alternatives.set(p[1]!, new Set()).get(p[1]!)!).add(i);
		if (twin >= 0) (replaced.get(p[1]!) ?? replaced.set(p[1]!, new Set()).get(p[1]!)!).add(twin);
	});
	const hiddenByDefault = new Set([...alternatives.values()].flatMap((s) => [...s]));
	const variants: FbxVariant[] = [{ label: 'Default', meshes: all.filter((i) => !hiddenByDefault.has(i)) }];
	for (const [code, alt] of alternatives) {
		const swap = replaced.get(code) ?? new Set();
		variants.push({
			// Pokémon GO's second form number on a part is the female one.
			label: code === '01' ? 'Female' : `Form ${code}`,
			meshes: all.filter((i) => (alt.has(i) || !hiddenByDefault.has(i)) && !swap.has(i)),
		});
	}
	return variants;
}

/** The texture file a material should use (see the module comment). */
function materialTexture(scene: FbxScene, material: number, images: Map<string, Node>): string | null {
	const mat = scene.materials[material];
	if (!mat) return null;
	const stem = (f: string) => f.replace(/\.[^.]+$/, '').replace(/^pm\d+_\d+_/i, '').replace(/\d+$/, '').toLowerCase();
	const named = scene.textureFiles.find((f) => !isOverlay(f) && stem(f) && mat.name.toLowerCase().startsWith(stem(f)) && images.has(f.toLowerCase()));
	return named ?? mat.diffuseTexture;
}

const isOverlay = (f: string) => /(?:^|_)(?:face|eye)\d*\.(?:png|tga)$/i.test(f);

export async function loadFbxModelView(node: Node, root: Node | null, variantIndex = 0): Promise<FbxModelView> {
	const bytes = new Uint8Array(await (await node.blob!()).arrayBuffer());
	const scene = readFbxScene(parseFbxNodes(bytes).nodes);
	if (!scene.meshes.length) throw new Error('This FBX has no meshes');
	const images = await siblingImages(node, root);
	const decoded = new Map<string, Promise<DecodedTexture | null>>();
	const texture = (file: string | null) => {
		if (!file) return Promise.resolve(null);
		const key = file.toLowerCase();
		let p = decoded.get(key);
		if (!p) {
			const n = images.get(key);
			p = n ? decodeTexture(n) : Promise.resolve(null);
			decoded.set(key, p);
		}
		return p;
	};

	const variants = fbxVariants(scene, node.name);
	const variant = Math.max(0, Math.min(variants.length - 1, variantIndex));
	const meshIndices = variants[variant]!.meshes;

	// Bind-pose positions per mesh, reused to lay out the output buffer.
	const bindWorlds = fbxWorldMatrices(scene);
	const posed = (mesh: FbxMesh, worlds: ReturnType<typeof fbxWorldMatrices>) => {
		const p = new Float32Array(mesh.positions.length);
		const n = mesh.normals ? new Float32Array(mesh.normals.length) : null;
		poseFbxMesh(scene, mesh, worlds, p, n);
		return { p, n };
	};

	// Output vertices are corners of source meshes: (mesh, corner).
	const srcMesh: number[] = [], srcCorner: number[] = [];
	const uv: number[] = [];
	const indices: number[] = [];
	const sections: { materialIndex: number; firstIndex: number; numTriangles: number }[] = [];
	const slotTextures: Promise<DecodedTexture | null>[] = [];
	const slotOverlay: boolean[] = [];
	const slotKey = new Map<string, number>();
	let wanted = 0;
	const slotFor = (key: string, file: string | null, overlay: boolean) => {
		let s = slotKey.get(key);
		if (s === undefined) {
			s = slotTextures.length;
			slotKey.set(key, s);
			slotTextures.push(texture(file));
			slotOverlay.push(overlay);
			if (file) wanted++;
		}
		return s;
	};
	const overlayFile = scene.textureFiles.find((f) => isOverlay(f) && images.has(f.toLowerCase())) ?? null;
	const overlayTex = overlayFile ? await texture(overlayFile) : null;

	for (const mi of meshIndices) {
		const mesh = scene.meshes[mi]!;
		const corners = mesh.positions.length / 3;
		const base = srcMesh.length;
		for (let c = 0; c < corners; c++) {
			srcMesh.push(mi);
			srcCorner.push(c);
			uv.push(mesh.uvs ? mesh.uvs[c * 2]! : 0, mesh.uvs ? mesh.uvs[c * 2 + 1]! : 0);
		}
		const bySlot = new Map<number, number[]>();
		for (let t = 0; t < mesh.triangleMaterials.length; t++) {
			const s = mesh.triangleMaterials[t]!;
			(bySlot.get(s) ?? bySlot.set(s, []).get(s)!).push(t);
		}
		for (const [s, tris] of bySlot) {
			const material = mesh.materials[s] ?? -1;
			const file = materialTexture(scene, material, images);
			const slot = slotFor(`m${material}`, file, false);
			sections.push({ materialIndex: slot, firstIndex: indices.length, numTriangles: tris.length });
			for (const t of tris) indices.push(base + t * 3, base + t * 3 + 1, base + t * 3 + 2);
		}
		// Eyes: a decal copy of the triangles whose UV1 lands on painted texels.
		if (overlayTex && mesh.uvs1) {
			const alphaAt = (u: number, v: number) => {
				const x = Math.min(overlayTex.width - 1, Math.max(0, Math.floor(u * overlayTex.width)));
				const y = Math.min(overlayTex.height - 1, Math.max(0, Math.floor((1 - v) * overlayTex.height)));
				return overlayTex.pixels[(y * overlayTex.width + x) * 4 + 3]!;
			};
			const tris: number[] = [];
			for (let t = 0; t < corners / 3; t++) {
				const u = (k: number) => mesh.uvs1![(t * 3 + k) * 2]!;
				const band = Math.floor(Math.min(mesh.uvs1![t * 6 + 1]!, mesh.uvs1![t * 6 + 3]!, mesh.uvs1![t * 6 + 5]!));
				if (band !== 1) continue;
				const v = (k: number) => mesh.uvs1![(t * 3 + k) * 2 + 1]! - band;
				if (![0, 1, 2].every((k) => u(k) >= 0 && u(k) <= 1 && v(k) >= 0 && v(k) <= 1.0001)) continue;
				const cu = (u(0) + u(1) + u(2)) / 3, cv = (v(0) + v(1) + v(2)) / 3;
				if (alphaAt(cu, cv) || alphaAt(u(0), v(0)) || alphaAt(u(1), v(1)) || alphaAt(u(2), v(2))) tris.push(t);
			}
			if (tris.length) {
				const slot = slotFor('overlay', overlayFile, true);
				const first = indices.length;
				for (const t of tris) {
					const band = Math.floor(Math.min(mesh.uvs1[t * 6 + 1]!, mesh.uvs1[t * 6 + 3]!, mesh.uvs1[t * 6 + 5]!));
					for (let k = 0; k < 3; k++) {
						const c = t * 3 + k;
						indices.push(srcMesh.length);
						srcMesh.push(mi);
						srcCorner.push(c);
						uv.push(mesh.uvs1[c * 2]!, mesh.uvs1[c * 2 + 1]! - band);
					}
				}
				sections.push({ materialIndex: slot, firstIndex: first, numTriangles: tris.length });
			}
		}
	}

	const textures = (await Promise.all(slotTextures)).map((t, i) => (t && slotOverlay[i] ? { ...t, decal: true, wrapS: 'clamp' as const, wrapT: 'clamp' as const } : t));
	const count = srcMesh.length;
	const positions = new Float32Array(count * 3);
	const normals = new Float32Array(count * 3);
	const fill = (worlds: ReturnType<typeof fbxWorldMatrices>, pos: Float32Array, nrm?: Float32Array) => {
		const cache = new Map<number, { p: Float32Array; n: Float32Array | null }>();
		for (let i = 0; i < count; i++) {
			const mi = srcMesh[i]!, c = srcCorner[i]!;
			let r = cache.get(mi);
			if (!r) cache.set(mi, (r = posed(scene.meshes[mi]!, worlds)));
			pos[i * 3] = r.p[c * 3]!;
			pos[i * 3 + 1] = r.p[c * 3 + 1]!;
			pos[i * 3 + 2] = r.p[c * 3 + 2]!;
			if (nrm && r.n) {
				nrm[i * 3] = r.n[c * 3]!;
				nrm[i * 3 + 1] = r.n[c * 3 + 1]!;
				nrm[i * 3 + 2] = r.n[c * 3 + 2]!;
			}
		}
	};

	const animations = scene.animations.map((a) => ({ name: a.name, frames: Math.max(1, Math.round(a.duration * FBX_FPS) + 1), animation: a }));
	const idle = animations.findIndex((a) => /wait|idle/i.test(a.name));
	const defaultAnimation = animations.length ? Math.max(0, idle) : -1;
	const pose = (index: number, frame: number, pos: Float32Array, nrm?: Float32Array) => {
		const a = index >= 0 ? animations[index]?.animation ?? null : null;
		fill(fbxWorldMatrices(scene, a, frame / FBX_FPS), pos, nrm);
	};
	if (defaultAnimation >= 0) pose(defaultAnimation, 0, positions, normals);
	else fill(bindWorlds, positions, normals);

	const hasNormals = scene.meshes.every((m) => m.normals);
	return {
		mesh: {
			lods: [
				{
					numVertices: count,
					positions,
					normals: hasNormals ? normals : undefined,
					uv: Float32Array.from(uv),
					indices: Uint32Array.from(indices),
					sections,
				},
			],
			upAxis: scene.upAxis === 2 ? 'z-up' : 'y-up',
		},
		textures,
		triangles: indices.length / 3,
		vertices: count,
		animations,
		defaultAnimation,
		variants,
		variant,
		texturesWanted: wanted,
		texturesFound: textures.filter(Boolean).length,
		pose,
	};
}
