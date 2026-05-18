/**
 * FF7 HRC (skeleton hierarchy) parser.
 *
 * HRC is a tiny TEXT format describing one model's bone tree.
 * Each bone records its parent, length, and references to RSD
 * files (which in turn point to a `.p` mesh + a `.tex` texture).
 *
 * Example (Cloud Strife, n_cloud_sk):
 *
 *     :HEADER_BLOCK 2
 *     :SKELETON n_cloud_sk
 *     :BONES 21
 *
 *     hip
 *     root
 *     1.7457236
 *     1 AAAB
 *
 *     chest
 *     hip
 *     5.181539
 *     1 AAAD
 *     …
 *
 * For each bone:
 *
 *   1. Line 1: bone name (case-insensitive identifier).
 *   2. Line 2: parent bone name, or literal `root` for the
 *      hip / pelvis.
 *   3. Line 3: bone length (a float — distance from this bone
 *      to its parent's pivot).
 *   4. Line 4: `<rsdCount> <RSD_NAME> …`. The bone may carry
 *      zero or more meshes; each name resolves to an
 *      `<name>.rsd` file in the same archive.
 *
 * Blank lines separate bones.
 */

export interface HrcBone {
	/** Bone identifier (the `.hrc` writes this verbatim, including case). */
	name: string;
	/** Parent bone name, or `'root'` for the hip / top-level bone. */
	parent: string;
	/** Distance from this bone's pivot to its parent's pivot. */
	length: number;
	/** Names of RSD resources attached to this bone (uppercase per file). */
	rsds: string[];
}

export interface ParsedHrc {
	/** Block-format version (always 2 in retail FF7). */
	headerBlock: number;
	/** Skeleton name, e.g. `n_cloud_sk` for Cloud Strife. */
	skeletonName: string;
	/** Declared bone count (should equal `bones.length`). */
	boneCount: number;
	bones: HrcBone[];
}

export class HrcParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HrcParseError';
	}
}

/**
 * Sniff whether a byte buffer looks like an HRC file. Cheap
 * enough to call on every unknown text file from char.lgp /
 * battle.lgp / magic.lgp.
 */
export function isHrc(bytes: Uint8Array): boolean {
	// Read up to the first 32 bytes; HRC always starts with the
	// `:HEADER_BLOCK` directive.
	const head = String.fromCharCode(...bytes.subarray(0, Math.min(32, bytes.byteLength)));
	return head.startsWith(':HEADER_BLOCK');
}

/**
 * Parse the textual HRC byte buffer into a {@link ParsedHrc}.
 * Tolerates CR/LF line endings and any amount of leading or
 * trailing whitespace within a bone block.
 */
export function parseHrc(bytes: Uint8Array): ParsedHrc {
	const text = new TextDecoder('ascii', { fatal: false }).decode(bytes);
	// Normalise line endings and strip carriage returns.
	const lines = text.split(/\r?\n/);
	let i = 0;
	let headerBlock = 0;
	let skeletonName = '';
	let boneCount = 0;
	// Header directives — order is conventional (HEADER_BLOCK,
	// SKELETON, BONES) but the parser doesn't insist on it.
	while (i < lines.length) {
		const ln = lines[i]!.trim();
		i++;
		if (ln === '') continue;
		if (!ln.startsWith(':')) {
			// First non-directive line — back up so the bone loop
			// sees this name.
			i--;
			break;
		}
		const m = /^:(\w+)\s*(.*)$/.exec(ln);
		if (!m) continue;
		const directive = m[1]!.toUpperCase();
		const arg = m[2]!.trim();
		if (directive === 'HEADER_BLOCK') headerBlock = parseInt(arg, 10) || 0;
		else if (directive === 'SKELETON') skeletonName = arg;
		else if (directive === 'BONES') boneCount = parseInt(arg, 10) || 0;
	}

	// Walk bones. Each bone is up to 4 lines: name, parent, length,
	// `<count> <rsd1> <rsd2> …` (the last line may be absent if the
	// bone has no attached geometry — some files just omit it,
	// others write `0` explicitly).
	const bones: HrcBone[] = [];
	while (i < lines.length) {
		// Skip blank lines between bones.
		while (i < lines.length && lines[i]!.trim() === '') i++;
		if (i >= lines.length) break;
		const name = lines[i++]!.trim();
		if (!name) break;
		const parent = (lines[i++] ?? '').trim();
		const lengthStr = (lines[i++] ?? '').trim();
		const length = parseFloat(lengthStr);
		if (!Number.isFinite(length)) {
			throw new HrcParseError(
				`Bone "${name}": expected float length, got ${JSON.stringify(lengthStr)}`,
			);
		}
		// RSD line: `<count> <name1> <name2> …`. May be missing
		// at the very end of the file.
		const rsdLine = (lines[i] ?? '').trim();
		const rsds: string[] = [];
		if (rsdLine !== '' && !/^[A-Za-z_]/.test(rsdLine.split(/\s+/)[0]!)) {
			// Starts with a digit — consume as rsd line.
			i++;
			const parts = rsdLine.split(/\s+/);
			const n = parseInt(parts[0]!, 10);
			if (Number.isFinite(n)) {
				for (let k = 0; k < n; k++) {
					const rsdName = parts[1 + k];
					if (rsdName) rsds.push(rsdName);
				}
			}
		}
		bones.push({ name, parent, length, rsds });
	}
	return { headerBlock, skeletonName, boneCount, bones };
}
