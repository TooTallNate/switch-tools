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
 * Material PPtrs for each sub-mesh of the mesh `meshPathId`, taken
 * from the first renderer in this file that draws it. An empty array
 * means no renderer here references the mesh.
 */
export async function findMeshRenderer(
	objects: readonly UnityObjectRef[],
	meshPathId: bigint,
): Promise<(UnityPPtr | null)[]> {
	const materialsOf = (renderer: Record<string, unknown>) =>
		((renderer.m_Materials as unknown[]) ?? []).map((m) => readPPtr(m));

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

/** The `SkinnedMeshRenderer` in this file that draws `meshPathId`, if any. */
export async function findSkinnedMeshRenderer(
	objects: readonly UnityObjectRef[],
	meshPathId: bigint,
): Promise<Record<string, unknown> | null> {
	for (const o of objects) {
		if (o.classId !== CLASS_SKINNED_MESH_RENDERER) continue;
		const v = await o.value();
		if (v && localTarget(readPPtr(v.m_Mesh)) === meshPathId) return v;
	}
	return null;
}

/**
 * Same-file material pathIds per sub-mesh (`null` for empty slots
 * or slots pointing into another bundle).
 */
export async function findMeshMaterialIds(
	objects: readonly UnityObjectRef[],
	meshPathId: bigint,
): Promise<(bigint | null)[]> {
	return (await findMeshRenderer(objects, meshPathId)).map(localTarget);
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
	/(^|[_\-. ])(n|nm|nml|nrm|norm|normal|bump|emm|emi|emis|emission|emissive|mask|msk|frmask|cam|matcap|mass|metallic|rough|rgh|spec|specular|smooth|ao|occ|occlusion|height|hgt|disp|ramp|lut|noise|flow|dissolve|detail|sss|rim|shadow|vlc)(\d+)?$/i;

export interface AlbedoCandidate {
	/** Shader property name in `m_TexEnvs`. */
	property: string;
	texturePathId: bigint;
	/** Decoded Texture2D, if it lives in this file. */
	texture: Record<string, unknown> | null;
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
 * One SerializedFile participating in a lookup. `resolveExternal`
 * maps a PPtr `m_FileID` (1-based into the file's externals) to that
 * file's context, or `null` when it can't be found.
 */
export interface UnityFileContext {
	/** Stable identity (e.g. the CAB's tree-node id). */
	key: string;
	objects: readonly UnityObjectRef[];
	resolveExternal: (fileId: number) => Promise<UnityFileContext | null>;
}

/** A Texture2D value plus the file it lives in (needed to find its `.resS`). */
export interface ResolvedTexture {
	texture: Record<string, unknown>;
	file: UnityFileContext;
}

const byIdCache = new WeakMap<UnityFileContext, Map<bigint, UnityObjectRef>>();
function objectIn(file: UnityFileContext, pathId: bigint): UnityObjectRef | undefined {
	let m = byIdCache.get(file);
	if (!m) byIdCache.set(file, (m = new Map(file.objects.map((o) => [o.pathId, o]))));
	return m.get(pathId);
}

/** Follow a PPtr from `file` to the object it names, across files if needed. */
async function deref(
	file: UnityFileContext,
	p: UnityPPtr | null,
	classId: number,
): Promise<{ value: Record<string, unknown>; file: UnityFileContext } | null> {
	if (!p || p.pathId === 0n) return null;
	const target = p.fileId === 0 ? file : await file.resolveExternal(p.fileId);
	if (!target) return null;
	const obj = objectIn(target, p.pathId);
	if (!obj || obj.classId !== classId) return null;
	const value = await obj.value();
	return value ? { value, file: target } : null;
}

/** Albedo texture of one material (looked up relative to the material's own file). */
async function materialAlbedo(
	material: Record<string, unknown>,
	file: UnityFileContext,
): Promise<ResolvedTexture | null> {
	const props = material.m_SavedProperties as Record<string, unknown> | undefined;
	const envs = (props?.m_TexEnvs as unknown[]) ?? [];
	const candidates: (AlbedoCandidate & { file: UnityFileContext | null })[] = [];
	for (const e of envs) {
		const pair = e as { first?: unknown; second?: Record<string, unknown> };
		const ref = readPPtr(pair.second?.m_Texture);
		if (!ref || ref.pathId === 0n) continue;
		const hit = await deref(file, ref, CLASS_TEXTURE2D);
		candidates.push({
			property: String(pair.first ?? ''),
			texturePathId: ref.pathId,
			texture: hit?.value ?? null,
			file: hit?.file ?? null,
		});
	}
	const pick = pickAlbedoTexture(candidates) as (typeof candidates)[number] | null;
	return pick?.texture && pick.file ? { texture: pick.texture, file: pick.file } : null;
}

const nameOf = (v: Record<string, unknown>) => String(v.m_Name ?? '');

/**
 * Fallback albedo for a material whose texture slots are all empty.
 *
 * Unity's FBX importer gives every mesh a default material
 * (`<model>_<material>`, usually URP Lit with no textures). Games often
 * keep that on the prefab's renderer and swap the real material in at
 * runtime. Super Mario RPG does this: renderers reference
 * `p0001_mdl_mario_new_p0001_base` while the textured Shader Graph
 * material `p0001_base` sits in the same file. So we look for a
 * textured material in the same file with the same name, or whose name
 * ends the empty material's name, preferring the longest match.
 *
 * Deliberately not done: guessing a texture from name tokens. Mario's
 * empty `…_p0001_eye` material would match the body atlas `p0001`, but
 * the real eye material is assigned by script from another bundle, so
 * the guess paints the wrong part of the atlas onto the eyes.
 */
async function fallbackAlbedo(
	material: Record<string, unknown>,
	file: UnityFileContext,
): Promise<ResolvedTexture | null> {
	const name = nameOf(material).toLowerCase();
	if (!name) return null;
	const siblings: { name: string; obj: UnityObjectRef }[] = [];
	for (const o of file.objects) {
		if (o.classId !== CLASS_MATERIAL) continue;
		const v = await o.value();
		const n = v ? nameOf(v).toLowerCase() : '';
		if (n) siblings.push({ name: n, obj: o });
	}
	const matches = siblings
		.filter((m) => m.name === name || name.endsWith(`_${m.name}`))
		.sort((a, b) => b.name.length - a.name.length);
	for (const m of matches) {
		const v = await m.obj.value();
		if (!v || v === material) continue;
		const hit = await materialAlbedo(v, file);
		if (hit) return hit;
	}
	return null;
}

/**
 * Resolve the albedo Texture2D for every material slot of a mesh,
 * following references into other bundles via `file.resolveExternal`.
 */
export async function resolveMeshAlbedoTextures(
	file: UnityFileContext,
	meshPathId: bigint,
): Promise<{
	textures: (ResolvedTexture | null)[];
	materialNames: string[];
	/** Base colour per slot (sRGB 0–1), for slots rendered without a texture. */
	baseColors: ([number, number, number] | null)[];
}> {
	const renderer = await findMeshRenderer(file.objects, meshPathId);
	const textures: (ResolvedTexture | null)[] = [];
	const materialNames: string[] = [];
	const baseColors: ([number, number, number] | null)[] = [];
	for (const ref of renderer) {
		const mat = await deref(file, ref, CLASS_MATERIAL);
		materialNames.push(mat ? nameOf(mat.value) : '');
		baseColors.push(mat ? materialBaseColor(mat.value) : null);
		if (!mat) {
			textures.push(null);
			continue;
		}
		textures.push(
			(await materialAlbedo(mat.value, mat.file)) ?? (await fallbackAlbedo(mat.value, mat.file)),
		);
	}
	return { textures, materialNames, baseColors };
}

/** Conventional base-colour properties, in priority order. */
const BASE_COLOR_PROPERTY_NAMES = ['_BaseColor', '_Color', '_MainColor', '_TintColor'];

/**
 * A material's base colour from `m_SavedProperties.m_Colors`, if it uses
 * a conventional property name. Unity serialises material colours in
 * gamma (sRGB) space.
 */
export function materialBaseColor(
	material: Record<string, unknown>,
): [number, number, number] | null {
	const props = material.m_SavedProperties as Record<string, unknown> | undefined;
	const colors = (props?.m_Colors as unknown[]) ?? [];
	for (const want of BASE_COLOR_PROPERTY_NAMES) {
		for (const e of colors) {
			const pair = e as { first?: unknown; second?: Record<string, unknown> };
			if (pair.first !== want || !pair.second) continue;
			const c = pair.second;
			const rgb = [c.r, c.g, c.b].map((x) => Math.min(Math.max(Number(x ?? 1), 0), 1));
			if (rgb.some((x) => !Number.isFinite(x))) continue;
			return rgb as [number, number, number];
		}
	}
	return null;
}

/**
 * Vertex colours for display (RGB, linear — Unity authors them in gamma
 * space) plus the slot base colours to use alongside them. Meshes whose
 * vertex colours vary are coloured by them wherever a slot has no
 * texture: placeholder FBX materials (`lambert1`, often with a black
 * `_Color`) would otherwise paint the whole model one flat colour.
 */
export function unityMeshDisplayColors(
	colors: Float32Array | null,
	vertexCount: number,
	baseColors: readonly ([number, number, number] | null)[] | undefined,
): { colors: Float32Array | undefined; baseColors: ([number, number, number] | null)[] | undefined } {
	if (!colors || colors.length < vertexCount * 4) return { colors: undefined, baseColors: baseColors?.slice() };
	// Uniform colours (all white, say) carry no painting — keep the
	// material colours then.
	let varies = false;
	for (let v = 1; v < vertexCount && !varies; v++) {
		for (let c = 0; c < 3; c++) {
			if (Math.abs(colors[v * 4 + c]! - colors[c]!) > 0.02) {
				varies = true;
				break;
			}
		}
	}
	if (!varies) return { colors: undefined, baseColors: baseColors?.slice() };
	const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const rgb = new Float32Array(vertexCount * 3);
	for (let v = 0; v < vertexCount; v++) {
		rgb[v * 3] = toLinear(colors[v * 4]!);
		rgb[v * 3 + 1] = toLinear(colors[v * 4 + 1]!);
		rgb[v * 3 + 2] = toLinear(colors[v * 4 + 2]!);
	}
	return { colors: rgb, baseColors: baseColors?.map(() => null) };
}
