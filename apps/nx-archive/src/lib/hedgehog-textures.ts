/**
 * Sonic Frontiers textures: a pac's `.dds` is often an `NTSI` stub
 * whose mips live in `raw/texture_streaming/<package>.ntsp` of the same
 * RomFS (`@tootallnate/hedgehog`, `texture-streaming.ts`). This rebuilds
 * the whole DDS from the stub and the package's top mip. Each package
 * header (tens of KB) is read once.
 */

import { assembleDds, isNtsi, ntspHeaderSize, parseNtsi, parseNtsp, type NtspPackage } from '@tootallnate/hedgehog';
import { romfsFileFor } from './title-romfs';

const packages = new Map<string, Promise<{ pkg: NtspPackage; blob: Blob } | null>>();

async function texturePackage(nodeId: string, name: string): Promise<{ pkg: NtspPackage; blob: Blob } | null> {
	const at = nodeId.lastIndexOf('/raw/');
	const key = `${at >= 0 ? nodeId.slice(0, at) : nodeId}\0${name}`;
	let p = packages.get(key);
	if (!p) {
		p = (async () => {
			const n = (await romfsFileFor(nodeId, `raw/texture_streaming/${name}.ntsp`)) ?? (await romfsFileFor(nodeId, `texture_streaming/${name}.ntsp`));
			if (!n?.blob) return null;
			const blob = await n.blob();
			const size = ntspHeaderSize(new Uint8Array(await blob.slice(0, 24).arrayBuffer()));
			return { pkg: parseNtsp(new Uint8Array(await blob.slice(0, size).arrayBuffer())), blob };
		})().catch(() => null);
		packages.set(key, p);
	}
	return p;
}

/**
 * The DDS for a pac entry's bytes: unchanged, or rebuilt from its
 * `NTSI` stub (the stub's own 4x4 mip when the package can't be found).
 */
export async function resolveHedgehogDds(nodeId: string, name: string, bytes: Uint8Array): Promise<Uint8Array> {
	if (!isNtsi(bytes)) return bytes;
	const stub = parseNtsi(bytes);
	const tp = await texturePackage(nodeId, stub.packageName);
	const entry = tp?.pkg.find(name);
	if (tp && entry && entry.mips.length) {
		const top = entry.mips[0]!;
		const mip = new Uint8Array(await tp.blob.slice(top.offset, top.offset + top.size).arrayBuffer());
		return assembleDds(stub, [mip], entry.width, entry.height);
	}
	return assembleDds(stub, [stub.mip4x4], 4, 4);
}
