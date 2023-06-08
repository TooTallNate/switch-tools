import { NACP } from '@tootallnate/nacp';

// Reference: https://switchbrew.org/wiki/NRO
const decoder = new TextDecoder();

export async function isNRO(blob: Blob): Promise<boolean> {
	const magicSlice = blob.slice(0x10, 0x10 + 0x4);
	const magicBuf = await magicSlice.arrayBuffer();
	const magicStr = decoder.decode(magicBuf);
	return magicStr === 'NRO0';
}

async function getNroSize(blob: Blob) {
	const nroSizeBuf = await blob.slice(0x18, 0x18 + 0x4).arrayBuffer();
	return new DataView(nroSizeBuf).getUint32(0, true);
}

async function extractAssetHeader(blob: Blob, start: number) {
	const end = start + 0x38;
	const assetHeaderBuf = await blob.slice(start, end).arrayBuffer();
	const magicStr = decoder.decode(assetHeaderBuf.slice(0, 0x4));
	if (magicStr !== 'ASET') {
		throw new Error('Failed to find asset header of NRO');
	}
	return assetHeaderBuf;
}

export async function extractAsset(blob: Blob, offset: number) {
	const nroSize = await getNroSize(blob);
	const assetHeaderBuf = await extractAssetHeader(blob, nroSize);
	const assetHeaderView = new DataView(assetHeaderBuf);
	const assetOffset = assetHeaderView.getUint32(offset, true);
	const length = assetHeaderView.getUint32(offset + 0x8, true);
	const start = nroSize + assetOffset;
	const end = start + length;
	return blob.slice(start, end);
}

export function extractIcon(blob: Blob) {
	return extractAsset(blob, 0x8);
}

export async function extractNACP(blob: Blob): Promise<NACP> {
	const nacp = await extractAsset(blob, 0x18);
	const buf = await nacp.arrayBuffer();
	return new NACP(buf);
}

export function extractRomFs(blob: Blob) {
	return extractAsset(blob, 0x28);
}
