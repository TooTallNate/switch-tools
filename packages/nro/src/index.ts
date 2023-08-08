// Reference: https://switchbrew.org/wiki/NRO
import { NACP } from '@tootallnate/nacp';

const decoder = new TextDecoder();

export type AssetSection = {
	offset: number;
	size: number;
};

export type AssetHeader = {
	magic: string; // Should be "ASET"
	version: number; // Should be `0`
	iconSection: AssetSection;
	nacpSection: AssetSection;
	romfsSection: AssetSection;
};

export type NRO = {
	data: Blob;
	icon: Blob | null;
	nacp: Blob | null;
	romfs: Blob | null;
};

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
	if (length === 0) return null;
	const start = nroSize + assetOffset;
	const end = start + length;
	return blob.slice(start, end);
}

export function extractIcon(blob: Blob) {
	return extractAsset(blob, 0x8);
}

export async function extractNACP(blob: Blob): Promise<NACP> {
	const nacp = await extractAsset(blob, 0x18);
	if (!nacp) throw new Error('NACP asset section has size 0');
	const buf = await nacp.arrayBuffer();
	return new NACP(buf);
}

export function extractRomFs(blob: Blob) {
	return extractAsset(blob, 0x28);
}

export async function decode(blob: Blob): Promise<NRO> {
	const nroSize = await getNroSize(blob);

	const assetHeader = await extractAssetHeader(blob, nroSize);
	const assetHeaderView = new DataView(assetHeader);
	const magic = decoder.decode(new Uint8Array(assetHeader, 0, 4));
	if (magic !== 'ASET') {
		throw new Error('Failed to find asset header of NRO');
	}
	const assetHeaderVersion = assetHeaderView.getUint32(0x4, true);
	if (assetHeaderVersion !== 0) {
		throw new Error(
			`Expected asset header version to be 0 (got ${assetHeaderVersion})`
		);
	}

	const iconSectionOffset = assetHeaderView.getUint32(0x8, true);
	const iconSectionSize = assetHeaderView.getUint32(0x10, true);
	const nacpSectionOffset = assetHeaderView.getUint32(0x18, true);
	const nacpSectionSize = assetHeaderView.getUint32(0x20, true);
	const romfsSectionOffset = assetHeaderView.getUint32(0x28, true);
	const romfsSectionSize = assetHeaderView.getUint32(0x30, true);
	//console.log({
	//	iconSectionOffset,
	//	iconSectionSize,
	//	nacpSectionOffset,
	//	nacpSectionSize,
	//	romfsSectionOffset,
	//	romfsSectionSize,
	//});

	let icon: Blob | null = null;
	if (iconSectionSize) {
		const start = nroSize + iconSectionOffset;
		const end = start + iconSectionSize;
		icon = blob.slice(start, end);
	}

	let nacp: Blob | null = null;
	if (nacpSectionSize) {
		const start = nroSize + nacpSectionOffset;
		const end = start + nacpSectionSize;
		nacp = blob.slice(start, end);
	}

	let romfs: Blob | null = null;
	if (romfsSectionSize) {
		const start = nroSize + romfsSectionOffset;
		const end = start + romfsSectionSize;
		romfs = blob.slice(start, end);
	}

	return {
		data: blob.slice(0, nroSize),
		icon,
		nacp,
		romfs,
	};
}

export async function encode(nro: NRO): Promise<Blob> {
	const parts: BlobPart[] = [nro.data];

	// Build the AssetHeader buffer
	const assetHeader = new ArrayBuffer(0x38);
	parts.push(assetHeader);
	const assetHeaderView = new DataView(assetHeader);

	// Magic "ASET"
	assetHeaderView.setUint8(0, 'A'.charCodeAt(0));
	assetHeaderView.setUint8(1, 'S'.charCodeAt(0));
	assetHeaderView.setUint8(2, 'E'.charCodeAt(0));
	assetHeaderView.setUint8(3, 'T'.charCodeAt(0));

	// Format version
	assetHeaderView.setUint32(4, 0, true);

	let offset = assetHeader.byteLength;

	// AssetSection icon
	if (nro.icon) {
		parts.push(nro.icon);
		assetHeaderView.setUint32(0x8, offset, true);
		offset += nro.icon.size;
		assetHeaderView.setUint32(0x10, nro.icon.size, true);
	} else {
		assetHeaderView.setUint32(0x8, 0, true);
		assetHeaderView.setUint32(0x10, 0, true);
	}

	// AssetSection NACP
	if (nro.nacp) {
		parts.push(nro.nacp);
		assetHeaderView.setUint32(0x18, offset, true);
		offset += nro.nacp.size;
		assetHeaderView.setUint32(0x20, nro.nacp.size, true);
	} else {
		assetHeaderView.setUint32(0x18, 0, true);
		assetHeaderView.setUint32(0x20, 0, true);
	}

	// AssetSection RomFS
	if (nro.romfs) {
		parts.push(nro.romfs);
		assetHeaderView.setUint32(0x28, offset, true);
		assetHeaderView.setUint32(0x28 + 0x8, nro.romfs.size || 0, true);
	} else {
		assetHeaderView.setUint32(0x28, 0, true);
		assetHeaderView.setUint32(0x30, 0, true);
	}

	return new Blob(parts);
}
