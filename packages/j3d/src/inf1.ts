/**
 * `INF1` — the scene graph.
 *
 * `INF1` is what ties the other chunks together. On its own, `SHP1` is a pile
 * of anonymous triangle batches: nothing in a shape says which material to draw
 * it with or which bone to hang it from. `INF1` supplies that by encoding a
 * *tree* as a flat instruction stream, and the tree is really a recording of
 * the draw calls the game will make, in order.
 *
 * Payload layout:
 *
 *   0x00 u16 loadFlags
 *   0x02 u16 padding
 *   0x04 u32 mtxGroupCount     — number of matrix groups ("packets") to allocate
 *   0x08 u32 vertexCount       — total vertices, used to size a scratch buffer
 *   0x0C u32 hierarchyOffset
 *
 * The hierarchy is a list of 4-byte nodes:
 *
 *   0x00 u16 type    — 0x00 end, 0x01 open/down, 0x02 close/up,
 *                      0x10 joint, 0x11 material, 0x12 shape
 *   0x02 u16 index   — into `JNT1`, `MAT3` or `SHP1` depending on `type`
 *
 * The important subtlety is that `0x01` (down) comes *after* the node it
 * descends into, so the stream reads like a tokenised tree:
 *
 *   joint 0 | down | material 3 | down | shape 7 | up | up | end
 *
 * meaning "shape 7, drawn with material 3, attached to joint 0". Both material
 * and joint state are inherited: a material node applies to every following
 * sibling *and* every descendant until something replaces it.
 *
 * That inheritance rule is exactly why the naive implementation of this walk is
 * subtly wrong. If you keep a single "current joint" variable, set it on every
 * joint node, and restore it on `up`, then two sibling joints end up parented to
 * each other rather than to their shared parent. What you actually need is two
 * pieces of state per level: the level's parent joint (used as the parent for
 * joints declared here) and the most recent joint declared at this level (used
 * as the parent when we descend). We push and pop both.
 *
 * `loadFlags` low nibble tells the engine how to handle matrices (1 = a single
 * matrix per shape, i.e. rigid; 2 = billboard; 3 = multi-matrix/skinned) and is
 * really a hint about which code path to take; we surface it without acting on
 * it.
 */

import { chunkOffset, validateChunk, type J3dChunk } from './container.js';
import { CHUNK_HEADER_SIZE } from './util.js';

/** Hierarchy node types. */
export const Inf1NodeType = {
	END: 0x00,
	DOWN: 0x01,
	UP: 0x02,
	JOINT: 0x10,
	MATERIAL: 0x11,
	SHAPE: 0x12,
} as const;

export const INF1_NODE_SIZE = 0x04;

/** Absurd-but-finite cap so a corrupt hierarchy can't spin forever. */
const MAX_HIERARCHY_NODES = 1 << 20;

export interface Inf1Node {
	type: number;
	index: number;
}

/** A joint in the hierarchy tree. `jointIndex` indexes `JNT1`. */
export interface Inf1JointNode {
	jointIndex: number;
	/** Parent joint index, or -1 for a root. */
	parent: number;
	children: Inf1JointNode[];
}

/** One (shape, material) pair, in the order the hierarchy draws them. */
export interface Inf1DrawCall {
	shapeIndex: number;
	/** `MAT3` material index, or -1 if no material node was in scope. */
	materialIndex: number;
	/** `JNT1` joint index the shape hangs off, or -1. */
	jointIndex: number;
}

export interface Inf1 {
	loadFlags: number;
	matrixGroupCount: number;
	vertexCount: number;
	/** The raw node stream, terminator included if present. */
	nodes: Inf1Node[];
	/** Draw calls in hierarchy order — the correct order to render in. */
	drawCalls: Inf1DrawCall[];
	/**
	 * Material index per shape index, -1 when a shape is never drawn. When a
	 * shape is drawn more than once with different materials (rare, but legal)
	 * this records the first occurrence; `drawCalls` has the full truth.
	 */
	shapeMaterials: number[];
	/** Parent joint per joint index, -1 for roots. */
	jointParents: number[];
	/** The joint tree's roots. */
	jointRoots: Inf1JointNode[];
}

interface Level {
	/** Parent joint for joints declared at this level. */
	joint: number;
	/** Material in scope at this level. */
	material: number;
	/** Most recent joint declared at this level; becomes the parent on `down`. */
	lastJoint: number;
}

/**
 * Parse an `INF1` chunk.
 *
 * Returns `null` when the header or the hierarchy offset is unusable. A
 * hierarchy that runs off the end of the chunk without a terminator is treated
 * as ending there, since everything we decoded up to that point is still valid.
 */
export function parseInf1(bytes: Uint8Array, chunk: J3dChunk): Inf1 | null {
	if (!validateChunk(bytes, chunk)) return null;
	if (chunk.size < CHUNK_HEADER_SIZE + 0x10) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payload = chunk.offset + CHUNK_HEADER_SIZE;
	const chunkEnd = chunk.offset + chunk.size;

	const loadFlags = view.getUint16(payload + 0x00, false);
	const matrixGroupCount = view.getUint32(payload + 0x04, false);
	const vertexCount = view.getUint32(payload + 0x08, false);
	const hierarchyRel = view.getUint32(payload + 0x0c, false);
	const hierarchyOffset = chunkOffset(chunk, hierarchyRel, INF1_NODE_SIZE);
	if (hierarchyOffset < 0) return null;

	const nodes: Inf1Node[] = [];
	const drawCalls: Inf1DrawCall[] = [];
	const shapeMaterials: number[] = [];
	const jointParents: number[] = [];
	const jointNodes = new Map<number, Inf1JointNode>();
	const jointRoots: Inf1JointNode[] = [];

	const stack: Level[] = [];
	let cur: Level = { joint: -1, material: -1, lastJoint: -1 };

	let p = hierarchyOffset;
	for (let i = 0; i < MAX_HIERARCHY_NODES; i++) {
		if (p + INF1_NODE_SIZE > chunkEnd) break;
		const type = view.getUint16(p + 0x00, false);
		const index = view.getUint16(p + 0x02, false);
		p += INF1_NODE_SIZE;
		nodes.push({ type, index });

		if (type === Inf1NodeType.END) break;

		switch (type) {
			case Inf1NodeType.DOWN:
				stack.push(cur);
				cur = {
					// Descend into the joint we just declared, if any; otherwise the
					// level's parent joint carries through (a `down` right after a
					// material node, for instance).
					joint: cur.lastJoint >= 0 ? cur.lastJoint : cur.joint,
					material: cur.material,
					lastJoint: -1,
				};
				break;
			case Inf1NodeType.UP: {
				const prev = stack.pop();
				if (prev) cur = prev;
				break;
			}
			case Inf1NodeType.JOINT: {
				jointParents[index] = cur.joint;
				const node: Inf1JointNode = {
					jointIndex: index,
					parent: cur.joint,
					children: [],
				};
				jointNodes.set(index, node);
				const parentNode = cur.joint >= 0 ? jointNodes.get(cur.joint) : undefined;
				if (parentNode) parentNode.children.push(node);
				else jointRoots.push(node);
				cur.lastJoint = index;
				break;
			}
			case Inf1NodeType.MATERIAL:
				cur.material = index;
				break;
			case Inf1NodeType.SHAPE:
				drawCalls.push({
					shapeIndex: index,
					materialIndex: cur.material,
					jointIndex: cur.joint,
				});
				if (shapeMaterials[index] === undefined) {
					shapeMaterials[index] = cur.material;
				}
				break;
			default:
				// Unknown node type: skip it. The stream is fixed-width, so we
				// stay in sync and lose only whatever that node meant.
				break;
		}
	}

	// `shapeMaterials` is built sparsely (indexed by shape id); normalise the
	// holes to -1 so callers can index it without an `undefined` check.
	for (let i = 0; i < shapeMaterials.length; i++) {
		if (shapeMaterials[i] === undefined) shapeMaterials[i] = -1;
	}
	for (let i = 0; i < jointParents.length; i++) {
		if (jointParents[i] === undefined) jointParents[i] = -1;
	}

	return {
		loadFlags,
		matrixGroupCount,
		vertexCount,
		nodes,
		drawCalls,
		shapeMaterials,
		jointParents,
		jointRoots,
	};
}
