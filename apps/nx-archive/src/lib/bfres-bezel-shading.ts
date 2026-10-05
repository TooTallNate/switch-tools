/**
 * Albedo reconstruction for Bezel Engine (`.bea`) materials.
 *
 * Bezel's `forward_plus_*_custom` shaders don't sample albedo the
 * "classic BFRES" way (`_a0` texture on the mesh's `_u0` UVs):
 *
 *   - The material's **attribute assign** routes each shader UV input
 *     to an arbitrary mesh UV set. Eye materials feed shader UV0 from
 *     the mesh's `_u2`, for example.
 *   - Each shader UV `n` is transformed by the `texsrt<n>` shader
 *     param when the `texture_srt_enable<n>` option is on. Eyes use
 *     this to pick the "eyes open" cell of an 8-frame eyelid atlas.
 *   - The shader's `_a1` sampler is a second albedo **layer** drawn
 *     over the base. It is sampled at both shader UV1 and UV2. For eyes,
 *     UV1 (shifted by `texsrt1`) lands the pupil on one eye and UV2 on
 *     the other. Where the base texture carries alpha (the eyelid atlas),
 *     that alpha masks the layer: the pupil only shows through the
 *     transparent eyeball window. Eyebrows and decals over opaque skin
 *     just alpha-blend.
 *
 * The renderer only has one texture per shape, so the layers are
 * baked on the CPU into a copy of the base texture, in the base's UV
 * space. That keeps the material a plain textured `MeshBasicMaterial`
 * and means STL/3MF export picks up the composited colours for free.
 */
import type { BfresGeometry, BfresMaterial, BfresTexSrt } from '@tootallnate/bfres';

/** RGBA8 pixels, row 0 = V 0 (matches the viewer's `flipY = false`). */
export interface RgbaImage {
	pixels: Uint8ClampedArray | Uint8Array;
	width: number;
	height: number;
}

export interface BezelAlbedoLayer {
	textureName: string;
	/** Per-vertex UVs (already SRT-transformed), `vertexCount * 2`. */
	uvs: Float32Array;
}

export interface BezelAlbedoPlan {
	/** Texture for the shader's `_a0` sampler. */
	baseTexture: string;
	/** Per-vertex UVs for the base texture (SRT applied), or `null`. */
	baseUvs: Float32Array | null;
	/** Overlays to bake on top of the base; empty for single-layer materials. */
	layers: BezelAlbedoLayer[];
	/**
	 * sRGB 0–255 colour showing through the base's transparent window
	 * (the white of the eye), from the `utilityColor0` param.
	 */
	windowColor: [number, number, number];
}

/**
 * True for materials compiled against a Bezel-style shader. We key
 * on the `texture_srt_enable0` option rather than the archive name so
 * that renamed shader archives are still handled.
 */
export function isBezelMaterial(mat: BfresMaterial | undefined): boolean {
	return !!mat?.shaderAssign && 'texture_srt_enable0' in mat.shaderAssign.options;
}

/**
 * Constant albedo for Bezel materials with `use_base_color_value`
 * on: the linear RGB `baseColor` param. The shader multiplies it into
 * the `_a0` texture when there is one, and uses it alone when there
 * isn't (e.g. a Bob-omb's untextured navy body). `null` when the
 * option is off.
 */
export function bezelBaseColor(
	mat: BfresMaterial | undefined,
): [number, number, number] | null {
	if (!mat || !isBezelMaterial(mat)) return null;
	if (mat.shaderAssign!.options.use_base_color_value !== '1') return null;
	const c = mat.shaderParams?.baseColor?.values;
	if (!c || c.length < 3) return null;
	return [c[0]!, c[1]!, c[2]!];
}

/**
 * Apply a texture SRT to a UV array.
 *
 * Maya-mode semantics (mode 0, the only one Bezel uses), expressed in
 * BFRES's top-left UV convention: rotate about the centre, then
 * `u' = sx * (u - tx)`, `v' = sy * (v - ty)`. Checked against Bezel
 * eye materials: `scale 0.125` selects one cell of an 8-frame atlas, and
 * `translate 2` moves the second eye's pupil island (U ∈ [2, 3]) back
 * onto the texture. Other modes use the same formula, a best-effort
 * approximation for previewing.
 */
export function applyTexSrt(uvs: Float32Array, srt: BfresTexSrt): Float32Array {
	const out = new Float32Array(uvs.length);
	const cos = Math.cos(srt.rotation);
	const sin = Math.sin(srt.rotation);
	for (let i = 0; i < uvs.length; i += 2) {
		let u = uvs[i]!;
		let v = uvs[i + 1]!;
		if (srt.rotation !== 0) {
			const du = u - 0.5;
			const dv = v - 0.5;
			u = cos * du - sin * dv + 0.5;
			v = sin * du + cos * dv + 0.5;
		}
		out[i] = srt.scaleX * (u - srt.translateX);
		out[i + 1] = srt.scaleY * (v - srt.translateY);
	}
	return out;
}

/**
 * UVs feeding shader UV input `index` for `geom`: the mesh attribute
 * named by the attribute assign, transformed by `texsrt<index>` when
 * that SRT is enabled. `null` if the mesh lacks the attribute.
 */
export function shaderUvs(
	geom: BfresGeometry,
	mat: BfresMaterial,
	index: number,
): Float32Array | null {
	const key = `_u${index}`;
	const meshAttr = mat.shaderAssign?.attribAssign[key] ?? key;
	const raw = geom.uvSets?.[meshAttr] ?? (meshAttr === '_u0' ? geom.uvs : null);
	if (!raw) return null;
	const enabled = mat.shaderAssign?.options[`texture_srt_enable${index}`] === '1';
	const srt = mat.shaderParams?.[`texsrt${index}`]?.texSrt;
	return enabled && srt ? applyTexSrt(raw, srt) : raw;
}

/** Texture bound to shader sampler `shaderSampler`, via the sampler assign. */
export function shaderSamplerTexture(
	mat: BfresMaterial,
	shaderSampler: string,
): string | null {
	const matSampler = mat.shaderAssign?.samplerAssign[shaderSampler];
	if (!matSampler) return null;
	return mat.bindings.find((b) => b.samplerName === matSampler)?.textureName ?? null;
}

/**
 * Work out how to reconstruct a Bezel material's albedo, or `null`
 * for non-Bezel materials (the caller keeps its generic path).
 */
export function planBezelAlbedo(
	geom: BfresGeometry,
	mat: BfresMaterial | undefined,
): BezelAlbedoPlan | null {
	if (!mat || !isBezelMaterial(mat)) return null;
	const baseTexture = shaderSamplerTexture(mat, '_a0');
	if (!baseTexture) return null;
	const layers: BezelAlbedoLayer[] = [];
	const layerTexture = shaderSamplerTexture(mat, '_a1');
	if (layerTexture && layerTexture !== baseTexture) {
		const seen = new Set<string>();
		for (const index of [1, 2]) {
			// UV1 and UV2 often come from the same mesh attribute with
			// different SRTs (one per eye). Two identical inputs would
			// just draw the layer twice.
			const meshAttr = mat.shaderAssign!.attribAssign[`_u${index}`] ?? `_u${index}`;
			const srt = mat.shaderParams?.[`texsrt${index}`]?.texSrt;
			const enabled = mat.shaderAssign!.options[`texture_srt_enable${index}`] === '1';
			const key = `${meshAttr}|${enabled && srt ? JSON.stringify(srt) : 'identity'}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const uvs = shaderUvs(geom, mat, index);
			if (uvs) layers.push({ textureName: layerTexture, uvs });
		}
	}
	return {
		baseTexture,
		baseUvs: shaderUvs(geom, mat, 0),
		layers,
		windowColor: windowColorOf(mat),
	};
}

/**
 * The eyeball colour under the eyelid atlas's transparent window.
 * Bezel eye materials store an off-white `utilityColor0`, for example
 * (0.81, 0.78, 0.78) for Mario and 0.6 grey for Peach. It is linear;
 * baking happens on sRGB bytes, so convert. Defaults to white.
 */
function windowColorOf(mat: BfresMaterial): [number, number, number] {
	const c = mat.shaderParams?.utilityColor0?.values;
	if (!c || c.length < 3) return [255, 255, 255];
	const toSrgb = (x: number) => {
		const l = Math.min(Math.max(x, 0), 1);
		const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
		return Math.round(s * 255);
	};
	return [toSrgb(c[0]!), toSrgb(c[1]!), toSrgb(c[2]!)];
}

/** True if any pixel is meaningfully transparent. */
export function hasAlpha(img: RgbaImage): boolean {
	const px = img.pixels;
	for (let i = 3; i < px.length; i += 4) if (px[i]! < 250) return true;
	return false;
}

/** Bilinear sample with clamp-to-edge addressing; returns RGBA 0..255. */
function sampleClamp(img: RgbaImage, u: number, v: number, out: Float32Array): void {
	const { width: w, height: h, pixels: px } = img;
	const x = Math.min(Math.max(u * w - 0.5, 0), w - 1);
	const y = Math.min(Math.max(v * h - 0.5, 0), h - 1);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, w - 1);
	const y1 = Math.min(y0 + 1, h - 1);
	const fx = x - x0;
	const fy = y - y0;
	for (let c = 0; c < 4; c++) {
		const a = px[(y0 * w + x0) * 4 + c]!;
		const b = px[(y0 * w + x1) * 4 + c]!;
		const d = px[(y1 * w + x0) * 4 + c]!;
		const e = px[(y1 * w + x1) * 4 + c]!;
		out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
	}
}

/**
 * Bake `layers` into a copy of `base`. Every base texel covered by a
 * triangle (in base-UV space, with repeat wrapping) gets each layer
 * sampled at the barycentrically-interpolated layer UV and blended on
 * top. When `windowColor` is given, the base's alpha is treated as
 * the eyelid mask: transparent base texels become `windowColor` (the
 * eyeball), and layers only show there, scaled by `1 - base.alpha`.
 * Without it, layers simply alpha-blend over the base. The result is
 * fully opaque.
 */
export function bakeAlbedoLayers(
	base: RgbaImage,
	baseUvs: Float32Array,
	indices: ArrayLike<number>,
	layers: { image: RgbaImage; uvs: Float32Array }[],
	windowColor: [number, number, number] | null,
): Uint8ClampedArray {
	const { width: W, height: H } = base;
	const out = new Uint8ClampedArray(base.pixels);
	const sample = new Float32Array(4);
	// Texels on shared edges are covered by two triangles; composite
	// each texel once so layers aren't blended twice.
	const done = new Uint8Array(W * H);
	for (let t = 0; t + 2 < indices.length; t += 3) {
		const i0 = indices[t]!;
		const i1 = indices[t + 1]!;
		const i2 = indices[t + 2]!;
		// Triangle in base-texel space (texel centres at +0.5).
		const ax = baseUvs[i0 * 2]! * W, ay = baseUvs[i0 * 2 + 1]! * H;
		const bx = baseUvs[i1 * 2]! * W, by = baseUvs[i1 * 2 + 1]! * H;
		const cx = baseUvs[i2 * 2]! * W, cy = baseUvs[i2 * 2 + 1]! * H;
		const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		if (!Number.isFinite(area) || Math.abs(area) < 1e-9) continue;
		const minX = Math.floor(Math.min(ax, bx, cx));
		const maxX = Math.ceil(Math.max(ax, bx, cx));
		const minY = Math.floor(Math.min(ay, by, cy));
		const maxY = Math.ceil(Math.max(ay, by, cy));
		// Guard against degenerate, atlas-spanning triangles.
		if (maxX - minX > W * 2 || maxY - minY > H * 2) continue;
		for (let py = minY; py <= maxY; py++) {
			for (let px = minX; px <= maxX; px++) {
				const sx = px + 0.5;
				const sy = py + 0.5;
				const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) / area;
				const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) / area;
				const w2 = 1 - w0 - w1;
				if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
				const tx = ((px % W) + W) % W;
				const ty = ((py % H) + H) % H;
				if (done[ty * W + tx]) continue;
				done[ty * W + tx] = 1;
				const o = (ty * W + tx) * 4;
				let r = out[o]!, g = out[o + 1]!, b = out[o + 2]!;
				let mask = 1;
				if (windowColor) {
					// Fill the eyeball window, keeping the lid's own colour
					// where it's opaque.
					mask = 1 - base.pixels[o + 3]! / 255;
					r += (windowColor[0] - r) * mask;
					g += (windowColor[1] - g) * mask;
					b += (windowColor[2] - b) * mask;
				}
				for (const layer of layers) {
					const lu = w0 * layer.uvs[i0 * 2]! + w1 * layer.uvs[i1 * 2]! + w2 * layer.uvs[i2 * 2]!;
					const lv =
						w0 * layer.uvs[i0 * 2 + 1]! + w1 * layer.uvs[i1 * 2 + 1]! + w2 * layer.uvs[i2 * 2 + 1]!;
					// Outside [0, 1] the clamp-addressed layer is transparent
					// in practice (pupil textures have empty borders), but
					// skip explicitly so a non-empty edge texel can't smear.
					if (lu < 0 || lu > 1 || lv < 0 || lv > 1) continue;
					sampleClamp(layer.image, lu, lv, sample);
					const a = (sample[3]! / 255) * mask;
					r += (sample[0]! - r) * a;
					g += (sample[1]! - g) * a;
					b += (sample[2]! - b) * a;
				}
				out[o] = r;
				out[o + 1] = g;
				out[o + 2] = b;
			}
		}
	}
	for (let i = 3; i < out.length; i += 4) out[i] = 255;
	return out;
}
