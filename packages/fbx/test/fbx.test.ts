import { describe, expect, it } from 'vitest';
import { fbxWorldMatrices, parseFbxNodes, poseFbxMesh, readFbxScene } from '../src/index.js';

// ---- a tiny binary FBX writer (version 7300, 32-bit offsets) ----
type Prop = { t: string; v: unknown };
interface N {
	name: string;
	props: Prop[];
	children?: N[];
}
const L = (v: number | bigint): Prop => ({ t: 'L', v: BigInt(v) });
const S = (v: string): Prop => ({ t: 'S', v });
const I = (v: number): Prop => ({ t: 'I', v });
const D = (v: number): Prop => ({ t: 'D', v });
const dArr = (v: number[]): Prop => ({ t: 'd', v });
const iArr = (v: number[]): Prop => ({ t: 'i', v });
const lArr = (v: number[]): Prop => ({ t: 'l', v });
const fArr = (v: number[]): Prop => ({ t: 'f', v });

function encodeProp(p: Prop): number[] {
	const out: number[] = [p.t.charCodeAt(0)];
	const b = (n: number, bytes: number, f: (dv: DataView) => void) => {
		const a = new Uint8Array(bytes);
		f(new DataView(a.buffer));
		out.push(...a);
		void n;
	};
	switch (p.t) {
		case 'I':
			b(0, 4, (dv) => dv.setInt32(0, p.v as number, true));
			break;
		case 'D':
			b(0, 8, (dv) => dv.setFloat64(0, p.v as number, true));
			break;
		case 'L':
			b(0, 8, (dv) => dv.setBigInt64(0, p.v as bigint, true));
			break;
		case 'S': {
			const s = new TextEncoder().encode(p.v as string);
			b(0, 4, (dv) => dv.setUint32(0, s.length, true));
			out.push(...s);
			break;
		}
		default: {
			const v = p.v as number[];
			const size = p.t === 'd' || p.t === 'l' ? 8 : 4;
			b(0, 12, (dv) => {
				dv.setUint32(0, v.length, true);
				dv.setUint32(4, 0, true);
				dv.setUint32(8, v.length * size, true);
			});
			b(0, v.length * size, (dv) =>
				v.forEach((x, i) =>
					p.t === 'd' ? dv.setFloat64(i * 8, x, true) : p.t === 'l' ? dv.setBigInt64(i * 8, BigInt(x), true) : p.t === 'f' ? dv.setFloat32(i * 4, x, true) : dv.setInt32(i * 4, x, true),
				),
			);
		}
	}
	return out;
}

function encode(nodes: N[]): Uint8Array {
	const out: number[] = [...new TextEncoder().encode('Kaydara FBX Binary  \0'), 0x1a, 0x00, 0x84, 0x1c, 0, 0];
	const u32 = (at: number, v: number) => {
		out[at] = v & 255;
		out[at + 1] = (v >>> 8) & 255;
		out[at + 2] = (v >>> 16) & 255;
		out[at + 3] = (v >>> 24) & 255;
	};
	const write = (n: N) => {
		const start = out.length;
		out.push(...new Array(12).fill(0), n.name.length, ...new TextEncoder().encode(n.name));
		const propStart = out.length;
		for (const p of n.props) out.push(...encodeProp(p));
		u32(start + 4, n.props.length);
		u32(start + 8, out.length - propStart);
		if (n.children?.length) {
			for (const c of n.children) write(c);
			out.push(...new Array(13).fill(0));
		}
		u32(start, out.length);
	};
	for (const n of nodes) write(n);
	out.push(...new Array(13).fill(0));
	return Uint8Array.from(out);
}

const P = (name: string, type: string, ...vals: number[]): N => ({ name: 'P', props: [S(name), S(type), S(''), S('A'), ...vals.map(D)] });
const p70 = (...ps: N[]): N => ({ name: 'Properties70', props: [], children: ps });
const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translated = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** A triangle mesh skinned to one bone at (0, 1, 0), and a 1 s clip moving the bone to (0, 3, 0). */
function fixture(): Uint8Array {
	return encode([
		{ name: 'GlobalSettings', props: [], children: [p70({ name: 'P', props: [S('UpAxis'), S('int'), S('Integer'), S(''), I(1)] })] },
		{
			name: 'Objects',
			props: [],
			children: [
				{ name: 'Model', props: [L(10), S('Mesh\0\x01Model'), S('Mesh')], children: [p70()] },
				{ name: 'Model', props: [L(11), S('Bone\0\x01Model'), S('LimbNode')], children: [p70(P('Lcl Translation', 'Lcl Translation', 0, 1, 0))] },
				{
					name: 'Geometry',
					props: [L(20), S('Tri\0\x01Geometry'), S('Mesh')],
					children: [
						{ name: 'Vertices', props: [dArr([0, 0, 0, 1, 0, 0, 0, 1, 0])] },
						{ name: 'PolygonVertexIndex', props: [iArr([0, 1, ~2])] },
						{
							name: 'LayerElementUV',
							props: [I(0)],
							children: [
								{ name: 'MappingInformationType', props: [S('ByPolygonVertex')] },
								{ name: 'ReferenceInformationType', props: [S('IndexToDirect')] },
								{ name: 'UV', props: [dArr([0, 0, 1, 0, 0, 1])] },
								{ name: 'UVIndex', props: [iArr([0, 1, 2])] },
							],
						},
					],
				},
				{ name: 'Material', props: [L(30), S('Skin\0\x01Material'), S('')], children: [p70()] },
				{ name: 'Texture', props: [L(31), S('skin.png\0\x01Texture'), S('')], children: [{ name: 'RelativeFilename', props: [S('textures\\skin.png')] }] },
				{ name: 'Deformer', props: [L(40), S('\0\x01Deformer'), S('Skin')] },
				{
					name: 'Deformer',
					props: [L(41), S('Bone\0\x01SubDeformer'), S('Cluster')],
					children: [
						{ name: 'Indexes', props: [iArr([0, 1, 2])] },
						{ name: 'Weights', props: [dArr([1, 1, 1])] },
						{ name: 'TransformLink', props: [dArr(translated(0, 1, 0))] },
					],
				},
				{
					name: 'Pose',
					props: [L(50), S('BindPose\0\x01Pose'), S('BindPose')],
					children: [{ name: 'PoseNode', props: [], children: [{ name: 'Node', props: [L(10)] }, { name: 'Matrix', props: [dArr(ident)] }] }],
				},
				{ name: 'AnimationStack', props: [L(60), S('Lift\0\x01AnimStack'), S('')] },
				{ name: 'AnimationLayer', props: [L(61), S('Base\0\x01AnimLayer'), S('')] },
				{ name: 'AnimationCurveNode', props: [L(62), S('T\0\x01AnimCurveNode'), S('')] },
				{
					name: 'AnimationCurve',
					props: [L(63), S('\0\x01AnimCurve'), S('')],
					children: [
						{ name: 'KeyTime', props: [lArr([0, 46186158000])] },
						{ name: 'KeyValueFloat', props: [fArr([1, 3])] },
					],
				},
			],
		},
		{
			name: 'Connections',
			props: [],
			children: [
				['OO', 20, 10],
				['OO', 30, 10],
				['OP', 31, 30, 'DiffuseColor'],
				['OO', 40, 20],
				['OO', 41, 40],
				['OO', 11, 41],
				['OO', 61, 60],
				['OO', 62, 61],
				['OP', 62, 11, 'Lcl Translation'],
				['OP', 63, 62, 'd|Y'],
			].map((c) => ({ name: 'C', props: [S(c[0] as string), L(c[1] as number), L(c[2] as number), ...(c[3] ? [S(c[3] as string)] : [])] })),
		},
	]);
}

describe('FBX', () => {
	const scene = readFbxScene(parseFbxNodes(fixture()).nodes);

	it('reads models, meshes, materials, textures and clips', () => {
		expect(scene.models.map((m) => m.name)).toEqual(['Mesh', 'Bone']);
		expect(scene.meshes).toHaveLength(1);
		const mesh = scene.meshes[0]!;
		expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		expect(Array.from(mesh.uvs!)).toEqual([0, 0, 1, 0, 0, 1]);
		expect(scene.materials[0]!.diffuseTexture).toBe('skin.png');
		expect(scene.textureFiles).toEqual(['skin.png']);
		expect(scene.animations.map((a) => [a.name, a.duration])).toEqual([['Lift', 1]]);
	});

	it('skins the mesh to its bone, at bind and animated', () => {
		const mesh = scene.meshes[0]!;
		const out = new Float32Array(9);
		poseFbxMesh(scene, mesh, fbxWorldMatrices(scene), out);
		expect(Array.from(out)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		// Half way through the clip the bone is at y = 2: everything lifts by 1.
		poseFbxMesh(scene, mesh, fbxWorldMatrices(scene, scene.animations[0], 0.5), out);
		expect(Array.from(out)).toEqual([0, 1, 0, 1, 1, 0, 0, 2, 0]);
	});
});
