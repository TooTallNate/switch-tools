/**
 * Material resolution for Unity `Mesh` previews.
 *
 * A Unity `Mesh` doesn't reference its materials. The renderer that
 * draws it does:
 *
 *   - `SkinnedMeshRenderer` (137): `m_Mesh` + `m_Materials`.
 *   - `MeshRenderer` (23) + `MeshFilter` (33): both live on the same
 *     `GameObject`. The filter holds `m_Mesh` and the renderer holds
 *     `m_Materials`.
 *
 * `m_Materials[i]` shades sub-mesh `i`. Each `Material` lists its
 * textures in `m_SavedProperties.m_TexEnvs` by shader property name.
 * Built-in and URP/HDRP shaders use conventional names (`_MainTex`,
 * `_BaseMap`, …). Shader Graph shaders, however, often keep generated
 * names like `Texture2D_2A45DA31`, which say nothing about the role. For
 * those, {@link pickAlbedoTexture} falls back to a heuristic over the
 * referenced Texture2D's own name and colour space.
 */

export interface UnityPPtr {
	fileId: number;
	pathId: bigint;
}

/** Minimal view of a decoded SerializedFile object used here. */
export interface UnityObjectRef {
	classId: number;
	pathId: bigint;
	/** Decode the object's TypeTree value (memoise in the caller if needed). */
	value: () => Promise<Record<string, unknown> | null>;
}

const CLASS_MESH_RENDERER = 23;
const CLASS_MESH_FILTER = 33;
const CLASS_SKINNED_MESH_RENDERER = 137;
const CLASS_MATERIAL = 21;
const CLASS_TEXTURE2D = 28;

export function readPPtr(v: unknown): UnityPPtr | null {
	if (!v || typeof v !== 'object') return null;
	const o = v as Record<string, unknown>;
	if (!('m_PathID' in o)) return null;
	const raw = o.m_PathID;
	let pathId: bigint;
	try {
		pathId = typeof raw === 'bigint' ? raw : BigInt(raw as number | string);
	} catch {
		return null;
	}
	return { fileId: Number(o.m_FileID ?? 0), pathId };
}

/** Same-file, non-null PPtr target. External references (`m_FileID != 0`) aren't followed. */
function localTarget(p: UnityPPtr | null): bigint | null {
	return p && p.fileId === 0 && p.pathId !== 0n ? p.pathId : null;
}

/**
 * Material pathIds for each sub-mesh of the mesh `meshPathId`,
 * taken from the first renderer that draws it. Entries are `null`
 * where the slot is empty or points into another bundle. An empty
 * array means no renderer in this file references the mesh.
 */
export async function findMeshMaterialIds(
	objects: readonly UnityObjectRef[],
	meshPathId: bigint,
): Promise<(bigint | null)[]> {
	const materialsOf = (renderer: Record<string, unknown>) =>
		((renderer.m_Materials as unknown[]) ?? []).map((m) => localTarget(readPPtr(m)));

	for (const o of objects) {
		if (o.classId !== CLASS_SKINNED_MESH_RENDERER) continue;
		const v = await o.value();
		if (v && localTarget(readPPtr(v.m_Mesh)) === meshPathId) return materialsOf(v);
	}
	// MeshFilter → GameObject → MeshRenderer on the same GameObject.
	for (const o of objects) {
		if (o.classId !== CLASS_MESH_FILTER) continue;
		const filter = await o.value();
		if (!filter || localTarget(readPPtr(filter.m_Mesh)) !== meshPathId) continue;
		const go = localTarget(readPPtr(filter.m_GameObject));
		if (go === null) continue;
		for (const r of objects) {
			if (r.classId !== CLASS_MESH_RENDERER) continue;
			const renderer = await r.value();
			if (renderer && localTarget(readPPtr(renderer.m_GameObject)) === go) {
				return materialsOf(renderer);
			}
		}
	}
	return [];
}

/** Property names that conventionally hold the albedo / base colour. */
const ALBEDO_PROPERTY_NAMES = [
	'_MainTex',
	'_BaseMap',
	'_BaseColorMap',
	'_BaseColorTexture',
	'_BaseTex',
	'_Albedo',
	'_AlbedoMap',
	'_AlbedoTex',
	'_Diffuse',
	'_DiffuseMap',
	'_DiffuseTex',
	'_ColorMap',
	'_MainTexture',
];

/**
 * Texture-name suffixes (and words) that mark non-colour maps:
 * normals, masks, emission, PBR channels, matcaps, ramps, and so on.
 */
const NON_ALBEDO_NAME =
	/(^|[_\-. ])(n|nm|nml|nrm|norm|normal|bump|emm|emi|emis|emission|emissive|mask|msk|frmask|cam|matcap|mass|mtl|metal|metallic|rough|rgh|spec|specular|smooth|ao|occ|occlusion|height|hgt|disp|ramp|lut|noise|flow|dissolve|detail|sss|rim|shadow|vlc)(\d+)?$/i;

export interface AlbedoCandidate {
	/** Shader property name in `m_TexEnvs`. */
	property: string;
	texturePathId: bigint;
	/** Decoded Texture2D, if it lives in this file. */
	texture: Record<string, unknown> | null;
}

/** Every same-file texture a material references, in `m_TexEnvs` order. */
export function materialTextureSlots(material: Record<string, unknown>): {
	property: string;
	texturePathId: bigint;
}[] {
	const props = material.m_SavedProperties as Record<string, unknown> | undefined;
	const envs = (props?.m_TexEnvs as unknown[]) ?? [];
	const out: { property: string; texturePathId: bigint }[] = [];
	for (const e of envs) {
		// TypeTree `map` entries decode as `{ first, second }` pairs.
		const pair = e as { first?: unknown; second?: Record<string, unknown> };
		const id = localTarget(readPPtr(pair.second?.m_Texture));
		if (id !== null) out.push({ property: String(pair.first ?? ''), texturePathId: id });
	}
	return out;
}

/**
 * Pick the albedo texture among a material's candidates.
 *
 *   1. A conventional property name (`_MainTex`, `_BaseMap`, …) wins.
 *   2. Otherwise the texture is scored by its Texture2D. An sRGB colour
 *      space (`m_ColorSpace == 1`) suggests colour data. A name ending
 *      in a non-colour suffix (`_nml`, `_emm`, `_mask`, …) rules it
 *      out. Property names containing "albedo"/"base"/"diffuse"/"main"
 *      /"color" get a bonus. Larger textures break ties.
 */
export function pickAlbedoTexture(candidates: readonly AlbedoCandidate[]): AlbedoCandidate | null {
	if (candidates.length === 0) return null;
	for (const want of ALBEDO_PROPERTY_NAMES) {
		const hit = candidates.find((c) => c.property === want && c.texture);
		if (hit) return hit;
	}
	let best: AlbedoCandidate | null = null;
	let bestScore = -Infinity;
	for (const c of candidates) {
		if (!c.texture) continue;
		const texName = String(c.texture.m_Name ?? '');
		let score = 0;
		if (NON_ALBEDO_NAME.test(texName) || NON_ALBEDO_NAME.test(c.property)) score -= 100;
		if (Number(c.texture.m_ColorSpace ?? 1) === 1) score += 10;
		if (/albedo|base|diffuse|main|colou?r|alb\b|col\b/i.test(c.property)) score += 5;
		const w = Number(c.texture.m_Width ?? 0);
		const h = Number(c.texture.m_Height ?? 0);
		score += Math.log2(Math.max(w * h, 1)) / 100;
		if (score > bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best && bestScore > -50 ? best : null;
}

/**
 * Resolve the albedo Texture2D for every material slot of a mesh.
 * Returns one entry per material slot (`null` where unresolved).
 */
export async function resolveMeshAlbedoTextures(
	objects: readonly UnityObjectRef[],
	meshPathId: bigint,
): Promise<{
	materialIds: (bigint | null)[];
	textures: (Record<string, unknown> | null)[];
	materialNames: string[];
}> {
	const byId = new Map(objects.map((o) => [o.pathId, o]));
	const materialIds = await findMeshMaterialIds(objects, meshPathId);
	const textures: (Record<string, unknown> | null)[] = [];
	const materialNames: string[] = [];
	for (const id of materialIds) {
		const matObj = id !== null ? byId.get(id) : undefined;
		const mat = matObj?.classId === CLASS_MATERIAL ? await matObj.value() : null;
		materialNames.push(mat ? String(mat.m_Name ?? '') : '');
		if (!mat) {
			textures.push(null);
			continue;
		}
		const candidates: AlbedoCandidate[] = [];
		for (const slot of materialTextureSlots(mat)) {
			const texObj = byId.get(slot.texturePathId);
			candidates.push({
				...slot,
				texture: texObj?.classId === CLASS_TEXTURE2D ? await texObj.value() : null,
			});
		}
		textures.push(pickAlbedoTexture(candidates)?.texture ?? null);
	}
	return { materialIds, textures, materialNames };
}
