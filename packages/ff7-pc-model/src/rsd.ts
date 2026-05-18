/**
 * FF7 RSD (resource description) parser.
 *
 * RSD is a tiny TEXT format that points an HRC bone at its
 * geometry assets. One RSD per bone-mesh.
 *
 * Example (Cloud's hip mesh):
 *
 *     @RSD940102
 *     PLY=AAAC.PLY
 *     MAT=AAAC.MAT
 *     GRP=AAAC.GRP
 *     NTEX=2
 *     TEX[0]=CLOUD0
 *     TEX[1]=CLOUD1
 *
 * Lines after the magic are `KEY=VALUE` pairs in any order:
 *
 *   * `PLY=<name>.PLY` — the binary mesh ("P file"). The
 *     extension in the RSD is `.PLY` but on disk inside the LGP
 *     the file's name uses `.P` (e.g. `aaac.p`). Strip the
 *     `.PLY` and append `.p` when looking up.
 *   * `MAT=<name>.MAT` — materials. We don't decode these
 *     (they're authored as overrides for the polygon-shading
 *     state burned into the P file itself).
 *   * `GRP=<name>.GRP` — group overrides. Same story.
 *   * `NTEX=<n>` — count of texture references.
 *   * `TEX[<i>]=<TEXNAME>` — texture stem; the on-disk file is
 *     `<TEXNAME>.tex` (case-insensitive). Maximum 12 textures
 *     per RSD in retail FF7.
 */

export interface ParsedRsd {
	/** Magic version, typically `@RSD940102` for retail FF7 PC. */
	version: string;
	/** Bare name of the `.p` mesh (no extension — look up as `<name>.p`). */
	ply: string;
	/** Bare name of the `.mat` material file (informational). */
	mat: string;
	/** Bare name of the `.grp` group file (informational). */
	grp: string;
	/**
	 * Texture stem names by slot index. Sparse — RSDs with
	 * `NTEX=0` have an empty array. Look up each as `<name>.tex`.
	 */
	textures: string[];
}

export class RsdParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RsdParseError';
	}
}

export function isRsd(bytes: Uint8Array): boolean {
	const head = String.fromCharCode(...bytes.subarray(0, Math.min(4, bytes.byteLength)));
	return head === '@RSD';
}

/**
 * Strip the `.PLY` / `.MAT` / etc extension from a value as
 * stored in an RSD line, returning the bare name (which is what
 * matches the on-disk LGP filename when combined with `.p` /
 * `.mat` / etc.). Case-insensitive.
 */
function stripExt(value: string): string {
	const i = value.lastIndexOf('.');
	return i >= 0 ? value.slice(0, i) : value;
}

export function parseRsd(bytes: Uint8Array): ParsedRsd {
	const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
	const lines = text.split(/\r?\n/);
	let version = '';
	let ply = '';
	let mat = '';
	let grp = '';
	let ntex = 0;
	const textures: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (line === '') continue;
		if (line.startsWith('@')) {
			version = line;
			continue;
		}
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim().toUpperCase();
		const value = line.slice(eq + 1).trim();
		if (key === 'PLY') ply = stripExt(value);
		else if (key === 'MAT') mat = stripExt(value);
		else if (key === 'GRP') grp = stripExt(value);
		else if (key === 'NTEX') {
			ntex = parseInt(value, 10) || 0;
		} else if (key.startsWith('TEX[')) {
			// `TEX[<i>]` — parse the index, store at that slot.
			const idxMatch = /^TEX\[(\d+)\]$/.exec(key);
			if (idxMatch) {
				const i = parseInt(idxMatch[1]!, 10);
				while (textures.length <= i) textures.push('');
				textures[i] = stripExt(value);
			}
		}
	}
	// Trim trailing empty slots, but keep `textures.length ===
	// ntex` when ntex is set.
	if (ntex > 0) {
		while (textures.length < ntex) textures.push('');
		textures.length = ntex;
	} else {
		while (textures.length > 0 && textures[textures.length - 1] === '') {
			textures.pop();
		}
	}
	if (!version) {
		throw new RsdParseError('Missing @RSD magic version line');
	}
	return { version, ply, mat, grp, textures };
}
