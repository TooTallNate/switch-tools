import { NACP } from '@tootallnate/nacp';
export declare function isNRO(blob: Blob): Promise<boolean>;
export declare function extractAsset(blob: Blob, offset: number): Promise<Blob>;
export declare function extractIcon(blob: Blob): Promise<Blob>;
export declare function extractNACP(blob: Blob): Promise<NACP>;
export declare function extractRomFs(blob: Blob): Promise<Blob>;
