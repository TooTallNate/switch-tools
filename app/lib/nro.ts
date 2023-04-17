import { NACP } from './nacp';

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
		throw new Error('Failed to find asset section of NRO');
	}
	return assetHeaderBuf;
}

export async function extractIcon(blob: Blob) {
	const nroSize = await getNroSize(blob);
	const assetHeaderBuf = await extractAssetHeader(blob, nroSize);
	const assetHeaderView = new DataView(assetHeaderBuf);
	const iconOffset = assetHeaderView.getUint32(0x8, true);
	const iconLength = assetHeaderView.getUint32(0x10, true);
	const iconStart = nroSize + iconOffset;
	const iconEnd = iconStart + iconLength;
	return blob.slice(iconStart, iconEnd).arrayBuffer();
}

export async function extractNACP(blob: Blob): Promise<NACP> {
	const nroSize = await getNroSize(blob);
	const assetHeaderBuf = await extractAssetHeader(blob, nroSize);
	const assetHeaderView = new DataView(assetHeaderBuf);
	const nacpOffset = assetHeaderView.getUint32(0x18, true);
	const nacpLength = assetHeaderView.getUint32(0x20, true);
	const nacpStart = nroSize + nacpOffset;
	const nacpEnd = nacpStart + nacpLength;
	const nacpBuf = await blob.slice(nacpStart, nacpEnd).arrayBuffer();
	return new NACP(nacpBuf);
}
