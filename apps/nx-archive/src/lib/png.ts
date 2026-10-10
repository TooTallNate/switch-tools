/**
 * Minimal RGBA8 → PNG encoder. Uses `CompressionStream('deflate')`
 * (zlib framing, which is what IDAT wants), so it works in browsers,
 * workers, and Bun without a canvas.
 */

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start: number, end: number): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(
	width: number,
	height: number,
	rgba: Uint8Array,
): Promise<Uint8Array> {
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		// Filter type 0 (none) per scanline.
		raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const idat = await deflate(raw);
	const chunks: [string, Uint8Array][] = [
		['IHDR', ihdr(width, height)],
		['IDAT', idat],
		['IEND', new Uint8Array(0)],
	];
	const total = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	let o = 8;
	for (const [type, data] of chunks) {
		dv.setUint32(o, data.length);
		for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
		out.set(data, o + 8);
		dv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
		o += 12 + data.length;
	}
	return out;
}

function ihdr(width: number, height: number): Uint8Array {
	const b = new Uint8Array(13);
	const dv = new DataView(b.buffer);
	dv.setUint32(0, width);
	dv.setUint32(4, height);
	b[8] = 8; // bit depth
	b[9] = 6; // RGBA
	return b;
}
