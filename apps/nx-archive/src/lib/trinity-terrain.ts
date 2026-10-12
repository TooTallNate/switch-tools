/**
 * Legends: Arceus field terrain tiles (`.trtrr`) → mesh-viewer view.
 *
 * The tile's `TerrainMaterial` (named by the `.trtrr`) binds the
 * heightmap, the splat control textures and eight tiling ground
 * albedos; all of them sit next to the `.trtrr` in its area pak
 * (`bin/archive/field/terrain/ha_area01.gfpak`). Geometry is the
 * heightmap displaced into a grid (`buildTerrainMesh`, sampled down to
 * ≤ 257 × 257 vertices); colour is the splat blend of each ground
 * layer's average colour (`bakeTerrainColor`). See
 * `@tootallnate/trinity`'s `terrain.ts` for the format.
 */

import {
	averageColor,
	bakeTerrainColor,
	buildTerrainMesh,
	parseTrmtr,
	parseTrtrr,
	type RgbaImage,
	type TrtrrTerrain,
} from '@tootallnate/trinity';
import { decodeBntxLayer, deswizzleBntxLayer, parseBntx } from '@tootallnate/bntx';

import type { Node } from './archive';
import { getAstcBlockDecoder } from './astc';
import type { DecodedTexture } from './uasset-material-chain';
import { findNodeById } from './unity-external';
import type { RenderableMesh } from '~/components/mesh-viewer';

export interface TrinityTerrainView {
	terrain: TrtrrTerrain;
	mesh: RenderableMesh;
	textures: (DecodedTexture | null)[];
	vertices: number;
	triangles: number;
	/** Heightmap size in texels. */
	heightmap: { width: number; height: number };
	/** Ground layers whose albedo was found, of those the material binds. */
	layersFound: number;
	layersWanted: number;
}

/** Grid resolution cap per side (vertices). */
const MAX_GRID = 257;

async function childrenOf(node: Node): Promise<Node[]> {
	if (!node.getChildren) return [];
	if (node._children) return node._children;
	try {
		const kids = await node.getChildren();
		node._children = kids;
		return kids;
	} catch {
		return [];
	}
}

const bytesOf = async (n: Node) => new Uint8Array(await (await n.blob!()).arrayBuffer());

function half(h: number): number {
	const sign = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return sign * m * 2 ** -24;
	if (e === 31) return m ? NaN : sign * Infinity;
	return sign * (1 + m / 1024) * 2 ** (e - 15);
}

/** Heightmap texels as 0–1 floats: R32 / R16 float, R16 unorm, or any decodable format's red channel. */
async function readHeights(bytes: Uint8Array, tex: ReturnType<typeof parseBntx>['textures'][number]): Promise<Float32Array> {
	const n = tex.width * tex.height;
	const family = tex.formatInfo.family;
	if (family === 0x14 || family === 0x0a) {
		const raw = deswizzleBntxLayer(bytes, tex);
		const bpp = family === 0x14 ? 4 : 2;
		if (raw.byteLength >= n * bpp) {
			const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
			const out = new Float32Array(n);
			const half16 = family === 0x0a && tex.formatInfo.dataType === 0x05;
			for (let i = 0; i < n; i++) {
				out[i] = bpp === 4 ? dv.getFloat32(i * 4, true) : half16 ? half(dv.getUint16(i * 2, true)) : dv.getUint16(i * 2, true) / 65535;
			}
			return out;
		}
	}
	try {
		const astcDecoder = tex.formatInfo.isAstc ? await getAstcBlockDecoder() : undefined;
		const d = decodeBntxLayer(bytes, tex, 0, { astcDecoder });
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = d.pixels[i * 4]! / 255;
		return out;
	} catch (err) {
		throw new Error(`Unsupported heightmap format ${tex.formatInfo.name} (${tex.width}×${tex.height}): ${err instanceof Error ? err.message : err}`);
	}
}

export async function loadTrinityTerrainView(node: Node, root: Node | null): Promise<TrinityTerrainView> {
	const terrain = parseTrtrr(await bytesOf(node));
	const slash = node.id.lastIndexOf('/');
	const parent = root && slash > 0 ? await findNodeById(root, node.id.slice(0, slash)) : null;
	const sib = new Map<string, Node>();
	for (const k of parent ? await childrenOf(parent) : []) if (k.blob) sib.set(k.name.toLowerCase(), k);
	const get = (name: string | null | undefined) => (name ? sib.get(name.toLowerCase()) : undefined);

	const matNode = get(terrain.material);
	if (!matNode) throw new Error(`Terrain material ${terrain.material ?? '(none)'} not found next to the tile`);
	const mat = parseTrmtr(await bytesOf(matNode)).materials[0];
	if (!mat) throw new Error('Terrain material has no passes');
	const file = (binding: string) => mat.textures.find((t) => t.binding === binding)?.file;

	// Heightmap: R32 float, 0–1 of the tile's height.
	const hmNode = get(file('HeightMap'));
	if (!hmNode) throw new Error(`Heightmap ${file('HeightMap') ?? '(none)'} not found`);
	const hmBytes = await bytesOf(hmNode);
	const hmTex = parseBntx(hmBytes).textures[0];
	if (!hmTex) throw new Error('Heightmap BNTX has no texture');
	const heights = await readHeights(hmBytes, hmTex);
	const step = Math.max(1, Math.ceil((hmTex.width - 1) / (MAX_GRID - 1)));
	const grid = buildTerrainMesh(heights, hmTex.width, hmTex.height, terrain.size, step);

	const decode = async (name: string | undefined, layer = 0): Promise<RgbaImage | null> => {
		const n = get(name);
		if (!n) return null;
		try {
			const bytes = await bytesOf(n);
			const tex = parseBntx(bytes).textures[0];
			if (!tex || layer >= tex.arrayLength) return null;
			const astcDecoder = tex.formatInfo.isAstc ? await getAstcBlockDecoder() : undefined;
			const d = decodeBntxLayer(bytes, tex, layer, { astcDecoder });
			return { width: d.width, height: d.height, pixels: d.pixels };
		} catch {
			return null;
		}
	};

	// Splat control layers (four weights each) and ground layer colours.
	const splatName = file('SplatAlpha');
	const control: RgbaImage[] = [];
	for (let k = 0; k < 4; k++) {
		const img = await decode(splatName, k);
		if (!img) break;
		control.push(img);
	}
	const layerFiles = Array.from({ length: control.length * 4 }, (_, i) => file(`SplatColor${i}`));
	let found = 0;
	const colors = await Promise.all(
		layerFiles.map(async (f) => {
			const img = await decode(f);
			if (!img) return null;
			found++;
			return averageColor(img);
		}),
	);
	let texture: DecodedTexture | null = null;
	if (control.length) {
		const img = bakeTerrainColor(control, colors);
		texture = {
			packagePath: splatName ?? terrain.material ?? node.name,
			width: img.width,
			height: img.height,
			pixels: img.pixels,
			pixelFormat: 'RGBA8',
			normalReconstructed: false,
			// Splat rows line up with heightmap rows (V = 0 at row 0).
			flipY: false,
			wrapS: 'clamp',
			wrapT: 'clamp',
		};
	}

	return {
		terrain,
		mesh: {
			lods: [
				{
					numVertices: grid.numVertices,
					positions: grid.positions,
					normals: grid.normals,
					uv: grid.uv,
					indices: grid.indices,
					sections: [{ materialIndex: 0, firstIndex: 0, numTriangles: grid.indices.length / 3 }],
					label: `${grid.numVertices.toLocaleString()} verts (every ${step} heightmap texels)`,
				},
			],
			upAxis: 'y-up',
		},
		textures: [texture],
		vertices: grid.numVertices,
		triangles: grid.indices.length / 3,
		heightmap: { width: hmTex.width, height: hmTex.height },
		layersFound: found,
		layersWanted: layerFiles.filter(Boolean).length,
	};
}
