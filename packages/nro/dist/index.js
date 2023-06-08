"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractRomFs = exports.extractNACP = exports.extractIcon = exports.extractAsset = exports.isNRO = void 0;
const nacp_1 = require("@tootallnate/nacp");
// Reference: https://switchbrew.org/wiki/NRO
const decoder = new TextDecoder();
async function isNRO(blob) {
    const magicSlice = blob.slice(0x10, 0x10 + 0x4);
    const magicBuf = await magicSlice.arrayBuffer();
    const magicStr = decoder.decode(magicBuf);
    return magicStr === 'NRO0';
}
exports.isNRO = isNRO;
async function getNroSize(blob) {
    const nroSizeBuf = await blob.slice(0x18, 0x18 + 0x4).arrayBuffer();
    return new DataView(nroSizeBuf).getUint32(0, true);
}
async function extractAssetHeader(blob, start) {
    const end = start + 0x38;
    const assetHeaderBuf = await blob.slice(start, end).arrayBuffer();
    const magicStr = decoder.decode(assetHeaderBuf.slice(0, 0x4));
    if (magicStr !== 'ASET') {
        throw new Error('Failed to find asset header of NRO');
    }
    return assetHeaderBuf;
}
async function extractAsset(blob, offset) {
    const nroSize = await getNroSize(blob);
    const assetHeaderBuf = await extractAssetHeader(blob, nroSize);
    const assetHeaderView = new DataView(assetHeaderBuf);
    const assetOffset = assetHeaderView.getUint32(offset, true);
    const length = assetHeaderView.getUint32(offset + 0x8, true);
    const start = nroSize + assetOffset;
    const end = start + length;
    return blob.slice(start, end);
}
exports.extractAsset = extractAsset;
function extractIcon(blob) {
    return extractAsset(blob, 0x8);
}
exports.extractIcon = extractIcon;
async function extractNACP(blob) {
    const nacp = await extractAsset(blob, 0x18);
    const buf = await nacp.arrayBuffer();
    return new nacp_1.NACP(buf);
}
exports.extractNACP = extractNACP;
function extractRomFs(blob) {
    return extractAsset(blob, 0x28);
}
exports.extractRomFs = extractRomFs;
//# sourceMappingURL=index.js.map