/**
 * Heuristic display-list finder.
 *
 * N64 games have no asset index for geometry — a display list is
 * just bytes somewhere in a ROM segment or a decompressed blob, and
 * only the game's own code knows where. To find them statically we
 * attempt interpretation at every 8-byte-aligned offset and keep
 * the ones that behave like real display lists.
 *
 * What makes this reliable rather than a guessing game is that the
 * command stream is heavily self-validating:
 *
 *   • Every command's top byte must be a valid opcode for the
 *     microcode. Random data fails this within a few commands, so
 *     `unknownCommands / commandCount` separates signal from noise
 *     almost perfectly.
 *   • The list must terminate with `G_ENDDL` rather than running
 *     off the end of the buffer.
 *   • It must actually load vertices through resolvable pointers
 *     and draw triangles from them.
 *   • Decoded vertex positions must be in a plausible coordinate
 *     range (s16 model space, so anything is *possible*, but real
 *     models cluster near the origin).
 *
 * A reported offset can land slightly *before* the "real" start of
 * a list: bytes immediately preceding it sometimes decode as
 * harmless commands (a NOP, a sync, a state setter) that simply
 * flow into it. The decoded geometry is unaffected — there is no
 * way to recover a canonical entry point from the data alone, since
 * only the game's code knows which address it jumps to.
 */

import {
	interpretDisplayList,
	type F3dexMesh,
	type InterpretOptions,
	type SegmentResolver,
} from './interpret.js';
import { isValidOpcode, type Microcode } from './microcode.js';

/** A display list accepted by the scanner. */
export interface DisplayListRef {
	/** Buffer offset where the display list starts. */
	offset: number;
	microcode: Microcode;
	triangleCount: number;
	vertexCount: number;
	materialCount: number;
	/** Bounding box of the decoded geometry, model space. */
	min: [number, number, number];
	max: [number, number, number];
}

export interface ScanOptions {
	/** Microcodes to try, in order (default: all three). */
	microcodes?: Microcode[];
	resolveSegment?: SegmentResolver;
	/** Minimum triangles for a display list to be reported (default 8). */
	minTriangles?: number;
	/**
	 * Maximum tolerated ratio of unrecognised opcodes (default 0).
	 * Real lists contain none; allow a little slack only if you are
	 * deliberately hunting unusual ucode variants.
	 */
	maxUnknownRatio?: number;
	/**
	 * Reject geometry whose coordinates exceed this magnitude
	 * (default 32768 — the full s16 range).
	 */
	maxCoordinate?: number;
	/** Stop after finding this many display lists (default 4096). */
	limit?: number;
	/** Scan alignment in bytes (default 8 — display lists are 8-aligned). */
	alignment?: number;
}

/** Compute the bounding box of a mesh's positions. */
function bounds(
	mesh: F3dexMesh,
): { min: [number, number, number]; max: [number, number, number] } {
	const min: [number, number, number] = [Infinity, Infinity, Infinity];
	const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
	const p = mesh.positions;
	for (let i = 0; i < p.length; i += 3) {
		for (let k = 0; k < 3; k++) {
			if (p[i + k] < min[k]) min[k] = p[i + k];
			if (p[i + k] > max[k]) max[k] = p[i + k];
		}
	}
	if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
	return { min, max };
}

/**
 * Does this mesh look like real geometry rather than a coincidence?
 */
function isPlausible(
	mesh: F3dexMesh,
	minTriangles: number,
	maxUnknownRatio: number,
	maxCoordinate: number,
): boolean {
	if (mesh.truncated) return false;
	if (mesh.verticesLoaded === 0) return false;
	// Any malformed triangle command means this isn't a display list
	// for this microcode (see F3dexMesh.invalidTriangles).
	if (mesh.invalidTriangles > 0) return false;
	// A partially-present model (vertices in a runtime-bound segment)
	// would render with spikes radiating from the origin, so don't
	// report it as a model.
	if (mesh.foreignVertexLoads > 0) return false;
	const triangles = mesh.indices.length / 3;
	if (triangles < minTriangles) return false;
	if (mesh.commandCount === 0) return false;
	if (mesh.unknownCommands / mesh.commandCount > maxUnknownRatio) return false;
	const { min, max } = bounds(mesh);
	for (let k = 0; k < 3; k++) {
		if (!Number.isFinite(min[k]) || !Number.isFinite(max[k])) return false;
		if (Math.abs(min[k]) > maxCoordinate) return false;
		if (Math.abs(max[k]) > maxCoordinate) return false;
	}
	// Degenerate: all vertices at one point.
	if (min[0] === max[0] && min[1] === max[1] && min[2] === max[2]) return false;
	return true;
}

/**
 * Scan a buffer for display lists.
 *
 * Accepted lists are non-overlapping: after a hit, scanning resumes
 * past the geometry it consumed, so a model made of many nested
 * lists is reported once at its entry point rather than once per
 * internal branch target.
 */
export function scanDisplayLists(
	data: Uint8Array,
	options: ScanOptions = {},
): DisplayListRef[] {
	const microcodes =
		options.microcodes ?? ['f3dex2', 'f3d', 'f3dex', 'rare'];
	const minTriangles = options.minTriangles ?? 8;
	const maxUnknownRatio = options.maxUnknownRatio ?? 0;
	const maxCoordinate = options.maxCoordinate ?? 32768;
	const limit = options.limit ?? 4096;
	const alignment = options.alignment ?? 8;

	const out: DisplayListRef[] = [];
	const interpretOpts: InterpretOptions = {
		resolveSegment: options.resolveSegment,
		// Keep per-candidate work bounded; a real model never needs
		// anywhere near these.
		maxCommands: 20_000,
		maxTriangles: 20_000,
		maxDepth: 16,
		// Reject non-display-list offsets after one command instead
		// of running them to the end of the buffer.
		bailOnUnknown: true,
		// And give up on runs of valid-but-inert state commands that
		// never draw anything — the dominant cost on texture-heavy
		// buffers.
		maxIdleCommands: 512,
	};

	for (let offset = 0; offset + 8 <= data.length; offset += alignment) {
		// Cheap gate before doing any real work: the first byte must
		// be a valid opcode for at least one candidate microcode.
		// Spinning up an interpreter allocates vertex-cache and
		// output buffers, so rejecting on a single byte comparison
		// is worth roughly an order of magnitude on a full scan.
		const firstOpcode = data[offset];
		let best: { mesh: F3dexMesh; microcode: Microcode } | null = null;
		for (const microcode of microcodes) {
			if (!isValidOpcode(microcode, firstOpcode)) continue;
			const mesh = interpretDisplayList(data, offset, {
				...interpretOpts,
				microcode,
			});
			if (
				!isPlausible(mesh, minTriangles, maxUnknownRatio, maxCoordinate)
			) {
				continue;
			}
			// Prefer the interpretation that draws more geometry —
			// a mismatched microcode typically yields far fewer
			// triangles before hitting an invalid opcode.
			if (!best || mesh.indices.length > best.mesh.indices.length) {
				best = { mesh, microcode };
			}
		}
		if (!best) continue;

		const { min, max } = bounds(best.mesh);
		out.push({
			offset,
			microcode: best.microcode,
			triangleCount: best.mesh.indices.length / 3,
			vertexCount: best.mesh.positions.length / 3,
			materialCount: best.mesh.materials.length,
			min,
			max,
		});
		if (out.length >= limit) break;
		// Skip past the commands this list consumed so nested
		// branch targets aren't reported as separate models.
		offset += Math.max(0, best.mesh.commandCount * 8 - alignment);
	}
	return out;
}
