/**
 * @tootallnate/acl-wasm
 *
 * Decompresses transform tracks made with Nicholas Frechette's Animation
 * Compression Library (https://github.com/nfrechette/acl, MIT), as used
 * by Sonic Frontiers' `.anm.pxd` animations. `acl.wasm` is ACL 2.0.6 and
 * RTM 2.1.5 behind a small wrapper (`c/wrapper.cpp`, built with
 * `make`), with no imports.
 *
 *   const acl = await AclDecoder.create(wasmBytesOrModule);
 *   const clip = acl.decompress(compressedTracksBytes);
 *   // clip.samples × clip.tracks transforms, 12 floats each
 *
 * Each transform is rotation (x, y, z, w), translation (x, y, z, _) and
 * scale (x, y, z, _), sampled at every frame of the clip.
 */

export type AclWasmSource = WebAssembly.Module | BufferSource | Promise<WebAssembly.Module | BufferSource>;

export interface AclClip {
	duration: number;
	sampleRate: number;
	samples: number;
	tracks: number;
	/** `samples * tracks * 12` floats. */
	transforms: Float32Array;
}

interface Exports {
	memory: WebAssembly.Memory;
	acl_malloc(n: number): number;
	acl_free(p: number): void;
	acl_decompress(p: number): number;
	acl_result_size(): number;
}

export class AclDecoder {
	private constructor(private readonly x: Exports) {}

	static async create(source: AclWasmSource): Promise<AclDecoder> {
		const resolved = await source;
		const module = resolved instanceof WebAssembly.Module ? resolved : await WebAssembly.compile(resolved as BufferSource);
		const instance = await WebAssembly.instantiate(module, {});
		return new AclDecoder(instance.exports as unknown as Exports);
	}

	/** Decompress one `compressed_tracks` blob (it starts with its own u32 size). */
	decompress(bytes: Uint8Array): AclClip {
		const x = this.x;
		if (bytes.length < 16) throw new Error('ACL: buffer too small');
		const size = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
		const src = x.acl_malloc(size);
		if (!src) throw new Error('ACL: out of memory');
		try {
			new Uint8Array(x.memory.buffer, src, size).set(bytes.subarray(0, size));
			const out = x.acl_decompress(src);
			if (!out) throw new Error('ACL: not a valid ACL 2.0 transform clip');
			try {
				const n = x.acl_result_size();
				const view = new DataView(x.memory.buffer, out, 16);
				const samples = view.getUint32(8, true), tracks = view.getUint32(12, true);
				return {
					duration: view.getFloat32(0, true),
					sampleRate: view.getFloat32(4, true),
					samples,
					tracks,
					transforms: new Float32Array(x.memory.buffer.slice(out + 16, out + n)),
				};
			} finally {
				x.acl_free(out);
			}
		} finally {
			x.acl_free(src);
		}
	}
}
