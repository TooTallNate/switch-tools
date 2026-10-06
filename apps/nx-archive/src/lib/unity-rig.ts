/**
 * Skinning + Mecanim animation playback for Unity `SkinnedMeshRenderer`s.
 *
 * A skinned mesh's vertices are authored in the renderer's local space
 * in the bind pose (typically a T-pose). To pose it we need:
 *
 *   - the bone hierarchy: the renderer's `m_Bones` are `Transform`s
 *     whose `m_Father` links form a tree under the prefab root, each
 *     with a local position / rotation / scale;
 *   - the mesh's inverse bind matrices (`m_BindPose[i]` for bone i);
 *   - an `AnimationClip`, whose tracks override bones' local
 *     properties. A track names its bone by the CRC32 of the bone's
 *     path relative to the animated root.
 *
 * Each vertex is then `Σ wₖ · inv(rendererWorld) · boneWorldₖ ·
 * bindPoseₖ · v`, computed on the CPU every frame. A few thousand
 * vertices per character makes that cheap, and writing the posed
 * positions into the geometry means STL / 3MF export captures the pose.
 *
 * Everything here is right-handed: inputs from Unity's left-handed
 * space are mirrored across X (positions `x → −x`, quaternions
 * `(x, y, z, w) → (x, −y, −z, w)`), matching `toRightHanded` on the
 * mesh itself.
 */
import * as THREE from 'three';
import {
	decodeUnityAnimationClip,
	unityPathHash,
	type UnityAnimationClip,
	type UnityMeshGeometry,
} from '@tootallnate/unity-asset';

import { readPPtr, type UnityFileContext, type UnityObjectRef } from './unity-mesh';

const CLASS_GAMEOBJECT = 1;
const CLASS_TRANSFORM = 4;
const CLASS_ANIMATION_CLIP = 74;

interface RigNode {
	name: string;
	parent: number;
	position: THREE.Vector3;
	rotation: THREE.Quaternion;
	scale: THREE.Vector3;
}

export interface UnityRig {
	nodes: RigNode[];
	/** Nodes in parent-before-child order. */
	order: number[];
	/** Node index of each skin bone (`-1` if unresolved). */
	bones: number[];
	/** Node index of the renderer's own Transform. */
	rendererNode: number;
	/** CRC32 path hash (relative to the animated root) → node index. */
	pathToNode: Map<number, number>;
	/** Inverse bind matrices (right-handed). */
	bindPoses: THREE.Matrix4[];
}

const vec = (v: unknown) => {
	const o = (v ?? {}) as Record<string, number>;
	return [Number(o.x ?? 0), Number(o.y ?? 0), Number(o.z ?? 0), Number(o.w ?? 0)] as const;
};

/** Unity left-handed local position → right-handed. */
function rhPosition(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
	return out.set(-x, y, z);
}

/** Unity left-handed rotation quaternion → right-handed (mirrored across X). */
function rhQuaternion(x: number, y: number, z: number, w: number, out = new THREE.Quaternion()) {
	return out.set(x, -y, -z, w).normalize();
}

/** Unity Euler degrees (applied Z, then X, then Y) → right-handed quaternion. */
function rhEuler(x: number, y: number, z: number, out = new THREE.Quaternion()) {
	const d = Math.PI / 180;
	// Build in Unity's (left-handed) frame: q = qY · qX · qZ.
	const e = new THREE.Euler(x * d, y * d, z * d, 'YXZ');
	const q = new THREE.Quaternion().setFromEuler(e);
	return rhQuaternion(q.x, q.y, q.z, q.w, out);
}

/**
 * Build the bone hierarchy for a skinned mesh from its renderer.
 * Returns `null` when the renderer has no resolvable bones.
 */
export async function buildUnityRig(
	file: UnityFileContext,
	renderer: Record<string, unknown>,
	geometry: UnityMeshGeometry,
): Promise<UnityRig | null> {
	const byId = new Map(file.objects.map((o) => [o.pathId, o]));
	const transforms = new Map<bigint, Record<string, unknown>>();
	for (const o of file.objects) {
		if (o.classId !== CLASS_TRANSFORM) continue;
		const v = await o.value();
		if (v) transforms.set(o.pathId, v);
	}
	if (transforms.size === 0) return null;

	const nameCache = new Map<bigint, string>();
	const nameOf = async (t: Record<string, unknown>): Promise<string> => {
		const go = readPPtr(t.m_GameObject);
		if (!go || go.fileId !== 0) return '';
		if (!nameCache.has(go.pathId)) {
			const obj: UnityObjectRef | undefined = byId.get(go.pathId);
			const v = obj?.classId === CLASS_GAMEOBJECT ? await obj.value() : null;
			nameCache.set(go.pathId, String(v?.m_Name ?? ''));
		}
		return nameCache.get(go.pathId)!;
	};

	// Index every Transform in the file as a node.
	const ids = [...transforms.keys()];
	const indexOf = new Map(ids.map((id, i) => [id, i]));
	const nodes: RigNode[] = [];
	for (const id of ids) {
		const t = transforms.get(id)!;
		const father = readPPtr(t.m_Father);
		const p = vec(t.m_LocalPosition);
		const r = vec(t.m_LocalRotation);
		const s = vec(t.m_LocalScale);
		nodes.push({
			name: await nameOf(t),
			parent: father && father.fileId === 0 ? (indexOf.get(father.pathId) ?? -1) : -1,
			position: rhPosition(p[0], p[1], p[2]),
			rotation: rhQuaternion(r[0], r[1], r[2], r[3]),
			scale: new THREE.Vector3(s[0], s[1], s[2]),
		});
	}

	const bones = ((renderer.m_Bones as unknown[]) ?? []).map((b) => {
		const p = readPPtr(b);
		return p && p.fileId === 0 ? (indexOf.get(p.pathId) ?? -1) : -1;
	});
	if (!bones.some((b) => b >= 0)) return null;

	// The renderer's own Transform lives on its GameObject.
	const go = readPPtr(renderer.m_GameObject);
	let rendererNode = -1;
	for (const [id, t] of transforms) {
		const g = readPPtr(t.m_GameObject);
		if (g && go && g.pathId === go.pathId) rendererNode = indexOf.get(id)!;
	}

	// Parent-before-child ordering.
	const order: number[] = [];
	const visited = new Uint8Array(nodes.length);
	const visit = (i: number) => {
		if (visited[i]) return;
		visited[i] = 1;
		if (nodes[i]!.parent >= 0) visit(nodes[i]!.parent);
		order.push(i);
	};
	for (let i = 0; i < nodes.length; i++) visit(i);

	// Animated root: the top of the root bone's hierarchy. Paths are
	// relative to it (its own path is "").
	const rootBone = readPPtr(renderer.m_RootBone);
	let top = rootBone && rootBone.fileId === 0 ? (indexOf.get(rootBone.pathId) ?? -1) : -1;
	if (top < 0) top = bones.find((b) => b >= 0)!;
	while (nodes[top]!.parent >= 0) top = nodes[top]!.parent;
	const pathToNode = new Map<number, number>();
	const pathOf = (i: number): string | null => {
		const parts: string[] = [];
		let cur = i;
		while (cur !== top) {
			if (cur < 0) return null;
			parts.unshift(nodes[cur]!.name);
			cur = nodes[cur]!.parent;
		}
		return parts.join('/');
	};
	for (let i = 0; i < nodes.length; i++) {
		const path = pathOf(i);
		if (path !== null) pathToNode.set(unityPathHash(path), i);
	}

	const bindPoses = geometry.bindPoses.map((m) => new THREE.Matrix4().fromArray(m));
	return { nodes, order, bones, rendererNode, pathToNode, bindPoses };
}

/** An animation clip that targets a rig. */
export interface RigClip {
	clip: UnityAnimationClip;
	/** Tracks that hit a rig node: `[nodeIndex, trackIndex]`. */
	bound: [number, number][];
}

/**
 * Decode every `AnimationClip` in the file that animates at least one
 * of the rig's bones.
 */
export async function findRigClips(file: UnityFileContext, rig: UnityRig): Promise<RigClip[]> {
	const out: RigClip[] = [];
	for (const o of file.objects) {
		if (o.classId !== CLASS_ANIMATION_CLIP) continue;
		const v = await o.value();
		if (!v) continue;
		let clip: UnityAnimationClip;
		try {
			clip = decodeUnityAnimationClip(v);
		} catch {
			continue;
		}
		const bound: [number, number][] = [];
		clip.tracks.forEach((t, ti) => {
			const node = rig.pathToNode.get(t.pathHash);
			if (node !== undefined) bound.push([node, ti]);
		});
		if (bound.length > 0) out.push({ clip, bound });
	}
	return out;
}

/**
 * Poses a skinned mesh. Layers are applied in order (e.g. a full-body
 * clip, then a face overlay), each overriding only the properties it
 * animates, and the result is written into the target position /
 * normal arrays.
 */
export class UnityPosePlayer {
	private readonly basePositions: Float32Array;
	private readonly baseNormals: Float32Array | null;
	private readonly locals: { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[];
	private readonly world: THREE.Matrix4[];
	private readonly skin: THREE.Matrix4[];
	private readonly layers: ({ clip: RigClip; time: number } | null)[] = [];
	private samples = new Map<RigClip, Float32Array>();

	constructor(
		private readonly rig: UnityRig,
		private readonly geometry: UnityMeshGeometry,
	) {
		this.basePositions = new Float32Array(geometry.positions);
		this.baseNormals = geometry.normals ? new Float32Array(geometry.normals) : null;
		this.locals = rig.nodes.map(() => ({
			p: new THREE.Vector3(),
			q: new THREE.Quaternion(),
			s: new THREE.Vector3(),
		}));
		this.world = rig.nodes.map(() => new THREE.Matrix4());
		this.skin = rig.bones.map(() => new THREE.Matrix4());
	}

	/** Set (or clear) the clip on a layer, at `time` seconds. */
	setLayer(layer: number, clip: RigClip | null, time: number): void {
		this.layers[layer] = clip ? { clip, time } : null;
	}

	/** Compute the pose and write skinned positions / normals into the outputs. */
	apply(positions: Float32Array, normals: Float32Array | null): void {
		const { rig } = this;
		rig.nodes.forEach((n, i) => {
			const l = this.locals[i]!;
			l.p.copy(n.position);
			l.q.copy(n.rotation);
			l.s.copy(n.scale);
		});
		const tmpQ = new THREE.Quaternion();
		for (const layer of this.layers) {
			if (!layer) continue;
			const { clip } = layer.clip;
			let buf = this.samples.get(layer.clip);
			if (!buf) this.samples.set(layer.clip, (buf = new Float32Array(clip.curveCount)));
			const v = clip.sample(layer.time, buf);
			for (const [node, ti] of layer.clip.bound) {
				const t = clip.tracks[ti]!;
				const c = t.curves;
				const l = this.locals[node]!;
				switch (t.property) {
					case 'position':
						rhPosition(v[c[0]!]!, v[c[1]!]!, v[c[2]!]!, l.p);
						break;
					case 'rotation':
						rhQuaternion(v[c[0]!]!, v[c[1]!]!, v[c[2]!]!, v[c[3]!]!, tmpQ);
						if (Number.isFinite(tmpQ.w)) l.q.copy(tmpQ);
						break;
					case 'euler':
						rhEuler(v[c[0]!]!, v[c[1]!]!, v[c[2]!]!, l.q);
						break;
					case 'scale':
						l.s.set(v[c[0]!]!, v[c[1]!]!, v[c[2]!]!);
						break;
				}
			}
		}
		for (const i of rig.order) {
			const l = this.locals[i]!;
			const w = this.world[i]!.compose(l.p, l.q, l.s);
			const parent = rig.nodes[i]!.parent;
			if (parent >= 0) w.premultiply(this.world[parent]!);
		}
		const toRenderer =
			rig.rendererNode >= 0 ? this.world[rig.rendererNode]!.clone().invert() : new THREE.Matrix4();
		rig.bones.forEach((node, b) => {
			const m = this.skin[b]!;
			if (node < 0 || !rig.bindPoses[b]) {
				m.identity();
				return;
			}
			m.multiplyMatrices(toRenderer, this.world[node]!).multiply(rig.bindPoses[b]!);
		});
		this.skinVertices(positions, normals);
	}

	private skinVertices(positions: Float32Array, normals: Float32Array | null): void {
		const skin = this.geometry.skin;
		if (!skin) return;
		const { weights, indices } = skin;
		const P = this.basePositions;
		const N = this.baseNormals;
		const mats = this.skin.map((m) => m.elements);
		const n = this.geometry.vertexCount;
		for (let v = 0; v < n; v++) {
			const px = P[v * 3]!, py = P[v * 3 + 1]!, pz = P[v * 3 + 2]!;
			let ox = 0, oy = 0, oz = 0, nx = 0, ny = 0, nz = 0;
			const hasN = N && normals;
			const qx = hasN ? N![v * 3]! : 0, qy = hasN ? N![v * 3 + 1]! : 0, qz = hasN ? N![v * 3 + 2]! : 0;
			let total = 0;
			for (let k = 0; k < 4; k++) {
				const w = weights[v * 4 + k]!;
				if (w === 0) continue;
				const e = mats[indices[v * 4 + k]!];
				if (!e) continue;
				total += w;
				ox += w * (e[0]! * px + e[4]! * py + e[8]! * pz + e[12]!);
				oy += w * (e[1]! * px + e[5]! * py + e[9]! * pz + e[13]!);
				oz += w * (e[2]! * px + e[6]! * py + e[10]! * pz + e[14]!);
				if (hasN) {
					nx += w * (e[0]! * qx + e[4]! * qy + e[8]! * qz);
					ny += w * (e[1]! * qx + e[5]! * qy + e[9]! * qz);
					nz += w * (e[2]! * qx + e[6]! * qy + e[10]! * qz);
				}
			}
			if (total === 0) {
				ox = px; oy = py; oz = pz; nx = qx; ny = qy; nz = qz;
			}
			positions[v * 3] = ox;
			positions[v * 3 + 1] = oy;
			positions[v * 3 + 2] = oz;
			if (hasN) {
				const len = Math.hypot(nx, ny, nz) || 1;
				normals![v * 3] = nx / len;
				normals![v * 3 + 1] = ny / len;
				normals![v * 3 + 2] = nz / len;
			}
		}
	}
}
