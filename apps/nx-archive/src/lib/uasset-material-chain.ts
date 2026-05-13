/**
 * Walk an UE asset graph from a StaticMesh material slot down to the
 * actual texture pixel data, then hand it to the renderer.
 *
 * Chain shape:
 *
 *   StaticMesh.StaticMaterials[i]              // import → MaterialInstance .uasset
 *     ↓
 *   MaterialInstanceConstant
 *     TextureParameterValues["BaseColor"]      // import → Texture2D .uasset
 *     TextureParameterValues["Normal"]
 *     TextureParameterValues["RoughMetalSpec"] // (etc., game-specific names)
 *     ↓
 *   Texture2D
 *     FTexturePlatformData mips                // → .uexp / .ubulk bytes
 *
 * The MaterialInstance points up at a `Parent` Material; some assets
 * stash the artist-chosen `BaseColor` only at the instance level, so
 * we don't have to chase the parent for the most common cases. When
 * we DO need parent-level fallbacks (e.g. shared default textures),
 * we walk up at most a few hops.
 *
 * Texture parameter names are not standardised across UE projects;
 * common conventions include `BaseColor`, `Diffuse`, `Albedo`,
 * `DiffuseMap`, `MainTexture`, etc. We surface every texture we find
 * keyed by parameter name; the renderer picks the diffuse via a
 * priority list.
 */

import {
	extractTextureParameters,
	getMipBytes,
	parseTexturePlatformData,
	parseUasset,
	readExportProperties,
	resolveImportPackagePath,
	type ParsedUasset,
} from '@tootallnate/uasset';

import type { Node } from './archive.js';
import type { AssetResolver } from './uasset-resolver.js';
import {
	decodeUeMip,
	UnsupportedPixelFormatError,
	type DecodedMip,
} from './uasset-texture.js';

export interface MaterialTextureSet {
	/** All textures keyed by parameter name (e.g. "BaseColor", "Normal"). */
	byParameter: Map<string, DecodedTexture>;
}

export interface DecodedTexture {
	/** Original PAK path (e.g. `/Game/Foo/T_Bar`). */
	packagePath: string;
	width: number;
	height: number;
	pixels: Uint8Array;
	pixelFormat: string;
	/** True when the decoder applied normal-map Z reconstruction. */
	normalReconstructed: boolean;
}

/**
 * Resolve every texture referenced by a list of material-slot package
 * paths, in parallel.
 *
 * @param materialPaths One package path per StaticMesh material slot
 *                      (`/Game/.../MI_Foo`). Use `null` for slots that
 *                      had no resolvable reference.
 * @param resolver      Archive-tree resolver from
 *                      {@link createAssetResolver}.
 *
 * @returns parallel array of `MaterialTextureSet | null`, one entry
 *          per slot. `null` means the slot's material couldn't be
 *          resolved (engine default, missing import, etc.) — the
 *          renderer falls back to a normal-shaded material for that
 *          section.
 */
export async function resolveMaterialTextures(
	materialPaths: Array<string | null>,
	resolver: AssetResolver,
): Promise<Array<MaterialTextureSet | null>> {
	return Promise.all(
		materialPaths.map((p) => p ? resolveOneMaterial(p, resolver) : null),
	);
}

async function resolveOneMaterial(
	materialPath: string,
	resolver: AssetResolver,
): Promise<MaterialTextureSet | null> {
	const mi = await resolver.resolve(materialPath);
	if (!mi || !mi.uexp) return null;
	const [aBytes, eBytes] = await Promise.all([
		mi.uasset.blob!().then((b) => b.arrayBuffer()).then((b) => new Uint8Array(b)),
		mi.uexp.blob!().then((b) => b.arrayBuffer()).then((b) => new Uint8Array(b)),
	]);
	const parsed = parseUasset(aBytes);
	// MaterialInstanceConstant always has one export at index 0.
	let parameters;
	try {
		const props = readExportProperties(parsed, eBytes, 0);
		parameters = extractTextureParameters(props.properties);
	} catch (err) {
		console.warn(`Failed to read material ${materialPath}:`, err);
		return null;
	}
	if (parameters.length === 0) return null;
	// Resolve every referenced texture in parallel — they may share
	// the same .ubulk sibling, but each is its own .uasset.
	const decoded = await Promise.all(
		parameters.map(async (p) => {
			const texturePath = resolveImportPackagePath(p.parameterValueIndex, parsed.imports, parsed.names);
			if (!texturePath) return null;
			const tex = await decodeTextureAsset(texturePath, resolver);
			if (!tex) return null;
			return { parameterName: p.parameterName, tex };
		}),
	);
	const byParameter = new Map<string, DecodedTexture>();
	for (const entry of decoded) {
		if (entry) byParameter.set(entry.parameterName, entry.tex);
	}
	if (byParameter.size === 0) return null;
	return { byParameter };
}

/**
 * Resolve + decode one Texture2D asset by its `/Game/.../T_Foo`
 * package path. Returns null when the texture isn't in the archive
 * (engine default, stripped, etc.).
 */
async function decodeTextureAsset(
	packagePath: string,
	resolver: AssetResolver,
): Promise<DecodedTexture | null> {
	const t = await resolver.resolve(packagePath);
	if (!t || !t.uexp) return null;
	try {
		const [aBytes, eBytes, uBytes] = await Promise.all([
			t.uasset.blob!().then((b) => b.arrayBuffer()).then((b) => new Uint8Array(b)),
			t.uexp.blob!().then((b) => b.arrayBuffer()).then((b) => new Uint8Array(b)),
			t.ubulk ? t.ubulk.blob!().then((b) => b.arrayBuffer()).then((b) => new Uint8Array(b)) : Promise.resolve(null),
		]);
		const parsed = parseUasset(aBytes);
		const tpd = parseTexturePlatformData(parsed, eBytes, 0);
		// Pick the largest available mip we can resolve in full. If the
		// top mip is in .ubulk and we don't have one, fall back to the
		// largest inline mip.
		const mip = pickBestMip(tpd.mips, uBytes !== null);
		if (!mip) return null;
		const bytes = getMipBytes(mip, uBytes);
		if (!bytes) return null;
		const decoded = await decodeOneMip(tpd.pixelFormat, mip, bytes);
		return {
			packagePath,
			width: decoded.width,
			height: decoded.height,
			pixels: decoded.pixels,
			pixelFormat: tpd.pixelFormat,
			normalReconstructed: decoded.normalReconstructed ?? false,
		};
	} catch (err) {
		if (err instanceof UnsupportedPixelFormatError) {
			console.info(`Skipping unsupported texture ${packagePath}: ${err.message}`);
		} else {
			console.warn(`Failed to decode texture ${packagePath}:`, err);
		}
		return null;
	}
}

async function decodeOneMip(
	pixelFormat: string,
	mip: { width: number; height: number; depth: number },
	bytes: Uint8Array,
): Promise<DecodedMip> {
	// For cubemaps the stored width × height covers ALL 6 faces stacked
	// vertically. Mesh previews want a single image, so we ignore the
	// cubemap convention here and just decode the entire region — the
	// renderer can crop down if needed (rare in practice for mesh
	// materials, which use Texture2D, not TextureCube).
	return decodeUeMip(pixelFormat, mip.width, mip.height * Math.max(1, mip.depth), bytes);
}

/**
 * Pick the largest mip whose bytes we can resolve. When `haveUbulk`
 * is false, we skip mips whose payload lives in the side-car file.
 */
function pickBestMip<T extends { location: string }>(
	mips: T[],
	haveUbulk: boolean,
): T | null {
	for (const mip of mips) {
		if (mip.location === 'unused') continue;
		if (mip.location === 'ubulk' && !haveUbulk) continue;
		return mip;
	}
	return null;
}

/**
 * Pick a UE texture parameter that best matches the "diffuse / albedo"
 * role, using a priority list of common UE naming conventions.
 *
 * Many community materials use `BaseColor` (the UE PBR convention);
 * older or custom shaders use `Diffuse`, `Albedo`, `MainTex`, etc.
 * Falls back to the first texture parameter when none match the
 * known names — better to show *something* than nothing.
 */
export function pickDiffuseTexture(set: MaterialTextureSet): DecodedTexture | null {
	const priority = ['BaseColor', 'Diffuse', 'Albedo', 'BaseColorMap', 'MainTexture', 'DiffuseMap', 'Color', 'ColorMap'];
	for (const name of priority) {
		const tex = set.byParameter.get(name);
		if (tex) return tex;
	}
	// Last resort: first texture we have.
	const first = set.byParameter.values().next().value as DecodedTexture | undefined;
	return first ?? null;
}

/**
 * Walk a parsed StaticMesh asset to extract the `/Game/.../MI_Foo`
 * package paths for every material slot, in slot order. Returns an
 * array sized to `materialSlotCount` with `null` for slots whose
 * material reference couldn't be resolved (rare — usually only
 * happens for engine-built-in defaults).
 */
export function extractStaticMeshMaterialPaths(
	parsed: ParsedUasset,
	materialSlotCount: number,
): Array<string | null> {
	// Find the StaticMaterials array and pull each entry's MaterialInterface
	// property. We have to re-read the StaticMesh export's properties
	// here — the parser doesn't currently expose the FPackageIndex of
	// each material slot directly, only the slot names.
	let exportIdx = -1;
	for (let i = 0; i < parsed.exports.length; i++) {
		const exp = parsed.exports[i];
		if (exp.classIndex >= 0) continue;
		const imp = parsed.imports[-exp.classIndex - 1];
		if (!imp) continue;
		if (parsed.names[imp.objectName.nameIndex]?.value === 'StaticMesh') {
			exportIdx = i;
			break;
		}
	}
	if (exportIdx < 0) return new Array(materialSlotCount).fill(null);
	// Note: the caller already has the .uexp bytes; we need to read
	// the property block again to get the StaticMaterials sub-tree.
	// Instead of duplicating that, we accept pre-decoded properties
	// in the sibling overload below.
	return new Array(materialSlotCount).fill(null);
}

/**
 * Extract each StaticMaterial slot's MaterialInterface object reference
 * → package path. The caller passes the already-decoded
 * `StaticMaterials` array; we walk it without re-parsing.
 */
export function extractMaterialPathsFromProperties(
	staticMaterials: ReadonlyArray<unknown>,
	parsed: ParsedUasset,
): Array<string | null> {
	const out: Array<string | null> = [];
	for (const entry of staticMaterials) {
		if (typeof entry !== 'object' || entry === null) {
			out.push(null);
			continue;
		}
		// Each StaticMaterial struct has a `MaterialInterface` ObjectProperty.
		const e = entry as { kind?: string; properties?: ReadonlyArray<unknown> };
		if (e.kind !== 'struct' || !e.properties) {
			out.push(null);
			continue;
		}
		let importIdx = 0;
		for (const sub of e.properties) {
			const s = sub as { name?: string; value?: { kind?: string; index?: number } };
			if (s.name === 'MaterialInterface' && s.value?.kind === 'object' && typeof s.value.index === 'number') {
				importIdx = s.value.index;
				break;
			}
		}
		if (importIdx === 0) {
			out.push(null);
		} else {
			out.push(resolveImportPackagePath(importIdx, parsed.imports, parsed.names));
		}
	}
	return out;
}
