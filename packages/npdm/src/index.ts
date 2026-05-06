/**
 * NPDM (Nintendo Process Definition Metadata) parser.
 *
 * NPDM is the Switch equivalent of 3DS exheader — it lives at
 * `main.npdm` inside an ExeFS PFS0 and carries:
 *
 *   - Meta header (0x80 bytes): process name, thread settings, version
 *   - ACID section (signed access-control descriptor): program-id range,
 *     memory region, allowed FS / service / kernel capabilities
 *   - ACI0 section (runtime access-control info): program-id, FAC/SAC/KC
 *     for the running process
 *
 * Within ACID and ACI0 we recursively decode three sub-tables:
 *   - FsAccessControl (FAC): a 64-bit FS permission bitmap with named
 *     bits (e.g. ApplicationInfo, GameCard, SaveDataBackUp, …)
 *   - ServiceAccessControl (SAC): list of service names the process
 *     can connect to or register
 *   - KernelCapability (KC): tagged bit-packed descriptors covering
 *     allowed syscalls, threads, memory mappings, kernel version, …
 *
 * Reference: https://switchbrew.org/wiki/NPDM
 */

const META_MAGIC = 0x4154454d; // "META"
const ACID_MAGIC = 0x44494341; // "ACID"
const ACI0_MAGIC = 0x30494341; // "ACI0"

const META_HEADER_SIZE = 0x80;
const ACID_HEADER_SIZE = 0x240;
const ACI0_HEADER_SIZE = 0x40;

const decoder = new TextDecoder();

// =============================================================================
// Public types
// =============================================================================

export interface NpdmMeta {
	magic: 'META';
	signatureKeyGeneration: number;
	flags: number;
	is64Bit: boolean;
	addressSpace: AddressSpace;
	optimizeMemoryAllocation: boolean;
	disableDeviceAddressSpaceMerge: boolean;
	enableAliasRegionExtraSize: boolean;
	mainThreadPriority: number;
	mainThreadCoreNumber: number;
	systemResourceSize: number;
	version: number;
	mainThreadStackSize: number;
	name: string;
	productCode: string;
	aciOffset: number;
	aciSize: number;
	acidOffset: number;
	acidSize: number;
}

export type AddressSpace =
	| 'AddressSpace32Bit'
	| 'AddressSpace64BitOld'
	| 'AddressSpace32BitNoReserved'
	| 'AddressSpace64Bit'
	| 'Unknown';

export interface NpdmAcid {
	magic: 'ACID';
	size: number;
	version: number;
	flags: number;
	productionFlag: boolean;
	unqualifiedApproval: boolean;
	memoryRegion: MemoryRegion;
	loadBrowserCoreDll: boolean;
	programIdMin: bigint;
	programIdMax: bigint;
	signature: Uint8Array;
	publicKey: Uint8Array;
	fac: AcidFac;
	sac: ServiceAccessControl;
	kc: KernelCapabilities;
}

export type MemoryRegion =
	| 'Application'
	| 'Applet'
	| 'SecureSystem'
	| 'NonSecureSystem'
	| 'Unknown';

export interface NpdmAci0 {
	magic: 'ACI0';
	programId: bigint;
	fac: Aci0Fac;
	sac: ServiceAccessControl;
	kc: KernelCapabilities;
}

/**
 * FsAccessControl as it appears in an ACID. The descriptor lists what
 * an installer is *permitted* to grant the process; the runtime ACI0
 * version is the actual set the process gets.
 */
export interface AcidFac {
	version: number;
	contentOwnerIdCount: number;
	saveDataOwnerIdCount: number;
	flag: bigint;
	flagBits: FsAccessFlagBit[];
	contentOwnerIdMin: bigint;
	contentOwnerIdMax: bigint;
	saveDataOwnerIdMin: bigint;
	saveDataOwnerIdMax: bigint;
	contentOwnerIds: bigint[];
	saveDataOwnerIds: bigint[];
}

/** FsAccessControl as it appears in an ACI0. */
export interface Aci0Fac {
	version: number;
	flag: bigint;
	flagBits: FsAccessFlagBit[];
	contentOwnerInfoOffset: number;
	contentOwnerInfoSize: number;
	saveDataOwnerInfoOffset: number;
	saveDataOwnerInfoSize: number;
	contentOwnerIds: bigint[];
	saveDataOwnerIds: SaveDataOwnerEntry[];
}

export interface SaveDataOwnerEntry {
	id: bigint;
	accessibility: 'Read' | 'Write' | 'ReadWrite' | 'Unknown';
	accessibilityRaw: number;
}

/** Names of the bits set in an FsAccessFlag (per switchbrew). */
export type FsAccessFlagBit =
	| 'ApplicationInfo'
	| 'BootModeControl'
	| 'Calibration'
	| 'SystemSaveData'
	| 'GameCard'
	| 'SaveDataBackUp'
	| 'SaveDataManagement'
	| 'BisAllRaw'
	| 'GameCardRaw'
	| 'GameCardPrivate'
	| 'SetTime'
	| 'ContentManager'
	| 'ImageManager'
	| 'CreateSaveData'
	| 'SystemSaveDataManagement'
	| 'BisFileSystem'
	| 'SystemUpdate'
	| 'SaveDataMeta'
	| 'DeviceSaveData'
	| 'SettingsControl'
	| 'SystemData'
	| 'SdCard'
	| 'Host'
	| 'FillBis'
	| 'CorruptSaveData'
	| 'SaveDataForDebug'
	| 'FormatSdCard'
	| 'GetRightsId'
	| 'RegisterExternalKey'
	| 'RegisterUpdatePartition'
	| 'SaveDataTransfer'
	| 'DeviceDetection'
	| 'AccessFailureResolution'
	| 'SaveDataTransferVersion2'
	| 'RegisterProgramIndexMapInfo'
	| 'CreateOwnSaveData'
	| 'MoveCacheStorage'
	| 'DeviceTreeBlob'
	| 'NotifyErrorContextServiceReady'
	| 'CalibrationSystemData'
	| 'CalibrationLog'
	| 'StorageSecure'
	| 'StorageControl'
	| 'GameCardReport'
	| 'MarkBeforeEraseBis'
	| 'HtmlViewer'
	| 'ApplicationSaveDataBackUp'
	| 'Debug'
	| 'FullPermission'
	| `Reserved(${number})`;

/** Service Access Control: a list of services this process may use. */
export interface ServiceAccessControl {
	entries: ServiceAccessEntry[];
}

export interface ServiceAccessEntry {
	/** Service name (up to 8 chars; supports the wildcard `*`). */
	name: string;
	/** True iff the process is allowed to *register* this service. */
	isServer: boolean;
}

/** Kernel Capabilities: a tagged list of bit-packed descriptors. */
export interface KernelCapabilities {
	descriptors: KernelDescriptor[];
}

export type KernelDescriptor =
	| { kind: 'ThreadInfo'; lowestPriority: number; highestPriority: number; minCoreNumber: number; maxCoreNumber: number; raw: number }
	| { kind: 'EnableSystemCalls'; index: number; mask: number; syscalls: number[]; raw: number }
	| { kind: 'MemoryMap'; raw: number /* see also MemoryMapPaired below */ }
	| { kind: 'MemoryMapPaired'; beginAddress: number; size: number; permissionType: 'RW' | 'RO'; mappingType: 'Io' | 'Static'; raw: [number, number] }
	| { kind: 'IoMemoryMap'; beginAddress: number; raw: number }
	| { kind: 'MemoryRegionMap'; regions: Array<{ type: number; readOnly: boolean }>; raw: number }
	| { kind: 'EnableInterrupts'; interrupts: number[]; raw: number }
	| { kind: 'MiscParams'; programType: 'System' | 'Application' | 'Applet' | 'Unknown'; raw: number }
	| { kind: 'KernelVersion'; majorVersion: number; minorVersion: number; raw: number }
	| { kind: 'HandleTableSize'; handleTableSize: number; raw: number }
	| { kind: 'MiscFlags'; enableDebug: boolean; forceDebugProd: boolean; forceDebug: boolean; raw: number }
	| { kind: 'Unknown'; raw: number };

export interface ParsedNpdm {
	meta: NpdmMeta;
	acid: NpdmAcid;
	aci0: NpdmAci0;
}

// =============================================================================
// Public entry points
// =============================================================================

/** Returns `true` iff the blob's first 4 bytes are the NPDM `META` magic. */
export async function isNpdm(blob: Blob): Promise<boolean> {
	if (blob.size < 4) return false;
	const buf = await blob.slice(0, 4).arrayBuffer();
	return new DataView(buf).getUint32(0, true) === META_MAGIC;
}

/**
 * Parse an NPDM `Blob` into its full structured form.
 *
 * The entire NPDM is loaded into memory — these files are tiny (a few
 * KB at most) so there's no benefit to lazy access.
 */
export async function parseNpdm(blob: Blob): Promise<ParsedNpdm> {
	if (blob.size < META_HEADER_SIZE) {
		throw new Error(
			`Blob too small to be an NPDM (${blob.size} < ${META_HEADER_SIZE})`,
		);
	}
	const buf = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	const meta = parseMeta(buf, view);
	const acid = parseAcid(buf, view, meta);
	const aci0 = parseAci0(buf, view, meta);

	return { meta, acid, aci0 };
}

// =============================================================================
// Meta header (0x00 .. 0x80)
// =============================================================================

function parseMeta(buf: Uint8Array, view: DataView): NpdmMeta {
	const magic = view.getUint32(0x00, true);
	if (magic !== META_MAGIC) {
		throw new Error(
			`Invalid NPDM Meta magic: 0x${magic.toString(16)} (expected 0x${META_MAGIC.toString(16)} "META")`,
		);
	}
	const flags = buf[0x0c];
	const is64Bit = (flags & 0x01) !== 0;
	const addressSpaceRaw = (flags >> 1) & 0x07;
	const addressSpace: AddressSpace =
		addressSpaceRaw === 0
			? 'AddressSpace32Bit'
			: addressSpaceRaw === 1
				? 'AddressSpace64BitOld'
				: addressSpaceRaw === 2
					? 'AddressSpace32BitNoReserved'
					: addressSpaceRaw === 3
						? 'AddressSpace64Bit'
						: 'Unknown';

	return {
		magic: 'META',
		signatureKeyGeneration: view.getUint32(0x04, true),
		flags,
		is64Bit,
		addressSpace,
		optimizeMemoryAllocation: (flags & 0x10) !== 0,
		disableDeviceAddressSpaceMerge: (flags & 0x20) !== 0,
		enableAliasRegionExtraSize: (flags & 0x40) !== 0,
		mainThreadPriority: buf[0x0e],
		mainThreadCoreNumber: buf[0x0f],
		systemResourceSize: view.getUint32(0x14, true),
		version: view.getUint32(0x18, true),
		mainThreadStackSize: view.getUint32(0x1c, true),
		name: readNulString(buf, 0x20, 0x10),
		productCode: readNulString(buf, 0x30, 0x10),
		aciOffset: view.getUint32(0x70, true),
		aciSize: view.getUint32(0x74, true),
		acidOffset: view.getUint32(0x78, true),
		acidSize: view.getUint32(0x7c, true),
	};
}

// =============================================================================
// ACID section
// =============================================================================

function parseAcid(buf: Uint8Array, view: DataView, meta: NpdmMeta): NpdmAcid {
	const base = meta.acidOffset;
	if (base + ACID_HEADER_SIZE > buf.length) {
		throw new Error(
			`ACID header at 0x${base.toString(16)} extends past blob end (size ${buf.length})`,
		);
	}
	// The first 0x100 of ACID is an RSA signature; the actual descriptor
	// starts at +0x100 with the "ACID" magic. Per switchbrew the documented
	// offsets are relative to the ACID *start* though — i.e. signature is
	// at 0x0, magic at 0x200. Our `base` IS the ACID start.
	const magic = view.getUint32(base + 0x200, true);
	if (magic !== ACID_MAGIC) {
		throw new Error(
			`Invalid ACID magic at 0x${(base + 0x200).toString(16)}: 0x${magic.toString(16)} (expected 0x${ACID_MAGIC.toString(16)} "ACID")`,
		);
	}

	const flags = view.getUint32(base + 0x20c, true);
	const memoryRegionRaw = (flags >> 2) & 0x0f;

	const facOffset = base + view.getUint32(base + 0x220, true);
	const facSize = view.getUint32(base + 0x224, true);
	const sacOffset = base + view.getUint32(base + 0x228, true);
	const sacSize = view.getUint32(base + 0x22c, true);
	const kcOffset = base + view.getUint32(base + 0x230, true);
	const kcSize = view.getUint32(base + 0x234, true);

	return {
		magic: 'ACID',
		size: view.getUint32(base + 0x204, true),
		version: buf[base + 0x208],
		flags,
		productionFlag: (flags & 0x01) !== 0,
		unqualifiedApproval: (flags & 0x02) !== 0,
		memoryRegion: decodeMemoryRegion(memoryRegionRaw),
		loadBrowserCoreDll: (flags & 0x80) !== 0,
		programIdMin: view.getBigUint64(base + 0x210, true),
		programIdMax: view.getBigUint64(base + 0x218, true),
		signature: buf.slice(base + 0x000, base + 0x100),
		publicKey: buf.slice(base + 0x100, base + 0x200),
		fac: parseAcidFac(buf, view, facOffset, facSize),
		sac: parseSac(buf, sacOffset, sacSize),
		kc: parseKc(buf, view, kcOffset, kcSize),
	};
}

function decodeMemoryRegion(raw: number): MemoryRegion {
	switch (raw) {
		case 0:
			return 'Application';
		case 1:
			return 'Applet';
		case 2:
			return 'SecureSystem';
		case 3:
			return 'NonSecureSystem';
		default:
			return 'Unknown';
	}
}

// =============================================================================
// ACI0 section
// =============================================================================

function parseAci0(
	buf: Uint8Array,
	view: DataView,
	meta: NpdmMeta,
): NpdmAci0 {
	const base = meta.aciOffset;
	if (base + ACI0_HEADER_SIZE > buf.length) {
		throw new Error(
			`ACI0 header at 0x${base.toString(16)} extends past blob end (size ${buf.length})`,
		);
	}
	const magic = view.getUint32(base + 0x00, true);
	if (magic !== ACI0_MAGIC) {
		throw new Error(
			`Invalid ACI0 magic at 0x${base.toString(16)}: 0x${magic.toString(16)} (expected 0x${ACI0_MAGIC.toString(16)} "ACI0")`,
		);
	}
	const facOffset = base + view.getUint32(base + 0x20, true);
	const facSize = view.getUint32(base + 0x24, true);
	const sacOffset = base + view.getUint32(base + 0x28, true);
	const sacSize = view.getUint32(base + 0x2c, true);
	const kcOffset = base + view.getUint32(base + 0x30, true);
	const kcSize = view.getUint32(base + 0x34, true);

	return {
		magic: 'ACI0',
		programId: view.getBigUint64(base + 0x10, true),
		fac: parseAci0Fac(buf, view, facOffset, facSize),
		sac: parseSac(buf, sacOffset, sacSize),
		kc: parseKc(buf, view, kcOffset, kcSize),
	};
}

// =============================================================================
// FsAccessControl
// =============================================================================

function parseAcidFac(
	buf: Uint8Array,
	view: DataView,
	offset: number,
	size: number,
): AcidFac {
	if (size < 0x2c) {
		// Insufficient data — return a sensible empty descriptor. We
		// don't throw because some early-firmware NPDMs have a smaller FAC.
		return {
			version: size >= 1 ? buf[offset] : 0,
			contentOwnerIdCount: 0,
			saveDataOwnerIdCount: 0,
			flag: 0n,
			flagBits: [],
			contentOwnerIdMin: 0n,
			contentOwnerIdMax: 0n,
			saveDataOwnerIdMin: 0n,
			saveDataOwnerIdMax: 0n,
			contentOwnerIds: [],
			saveDataOwnerIds: [],
		};
	}
	const version = buf[offset + 0x00];
	const contentOwnerIdCount = buf[offset + 0x01];
	const saveDataOwnerIdCount = buf[offset + 0x02];
	const flag = view.getBigUint64(offset + 0x04, true);
	const contentOwnerIdMin = view.getBigUint64(offset + 0x0c, true);
	const contentOwnerIdMax = view.getBigUint64(offset + 0x14, true);
	const saveDataOwnerIdMin = view.getBigUint64(offset + 0x1c, true);
	const saveDataOwnerIdMax = view.getBigUint64(offset + 0x24, true);

	const contentOwnerIds: bigint[] = [];
	let cur = offset + 0x2c;
	for (let i = 0; i < contentOwnerIdCount; i++) {
		if (cur + 8 > offset + size) break;
		contentOwnerIds.push(view.getBigUint64(cur, true));
		cur += 8;
	}
	const saveDataOwnerIds: bigint[] = [];
	for (let i = 0; i < saveDataOwnerIdCount; i++) {
		if (cur + 8 > offset + size) break;
		saveDataOwnerIds.push(view.getBigUint64(cur, true));
		cur += 8;
	}

	return {
		version,
		contentOwnerIdCount,
		saveDataOwnerIdCount,
		flag,
		flagBits: decodeFsAccessFlag(flag),
		contentOwnerIdMin,
		contentOwnerIdMax,
		saveDataOwnerIdMin,
		saveDataOwnerIdMax,
		contentOwnerIds,
		saveDataOwnerIds,
	};
}

function parseAci0Fac(
	buf: Uint8Array,
	view: DataView,
	offset: number,
	size: number,
): Aci0Fac {
	if (size < 0x1c) {
		return {
			version: size >= 1 ? buf[offset] : 0,
			flag: 0n,
			flagBits: [],
			contentOwnerInfoOffset: 0,
			contentOwnerInfoSize: 0,
			saveDataOwnerInfoOffset: 0,
			saveDataOwnerInfoSize: 0,
			contentOwnerIds: [],
			saveDataOwnerIds: [],
		};
	}
	const version = buf[offset];
	const flag = view.getBigUint64(offset + 0x04, true);
	const contentOwnerInfoOffset = view.getUint32(offset + 0x0c, true);
	const contentOwnerInfoSize = view.getUint32(offset + 0x10, true);
	const saveDataOwnerInfoOffset = view.getUint32(offset + 0x14, true);
	const saveDataOwnerInfoSize = view.getUint32(offset + 0x18, true);

	const contentOwnerIds: bigint[] = [];
	if (contentOwnerInfoSize >= 4) {
		const cnt = view.getUint32(offset + contentOwnerInfoOffset, true);
		for (let i = 0; i < cnt; i++) {
			const o = offset + contentOwnerInfoOffset + 4 + i * 8;
			if (o + 8 > offset + size) break;
			contentOwnerIds.push(view.getBigUint64(o, true));
		}
	}

	const saveDataOwnerIds: SaveDataOwnerEntry[] = [];
	if (saveDataOwnerInfoSize >= 4) {
		const cntStart = offset + saveDataOwnerInfoOffset;
		const cnt = view.getUint32(cntStart, true);
		const accStart = cntStart + 4;
		// Accessibility bytes; the id table that follows is aligned to 4 bytes.
		const idsStart = align(accStart + cnt, 4);
		for (let i = 0; i < cnt; i++) {
			if (accStart + i >= offset + size) break;
			const acc = buf[accStart + i];
			const o = idsStart + i * 8;
			if (o + 8 > offset + size) break;
			saveDataOwnerIds.push({
				id: view.getBigUint64(o, true),
				accessibilityRaw: acc,
				accessibility:
					acc === 1
						? 'Read'
						: acc === 2
							? 'Write'
							: acc === 3
								? 'ReadWrite'
								: 'Unknown',
			});
		}
	}

	return {
		version,
		flag,
		flagBits: decodeFsAccessFlag(flag),
		contentOwnerInfoOffset,
		contentOwnerInfoSize,
		saveDataOwnerInfoOffset,
		saveDataOwnerInfoSize,
		contentOwnerIds,
		saveDataOwnerIds,
	};
}

const FS_ACCESS_FLAG_NAMES: FsAccessFlagBit[] = [
	'ApplicationInfo', // 0
	'BootModeControl',
	'Calibration',
	'SystemSaveData',
	'GameCard',
	'SaveDataBackUp',
	'SaveDataManagement',
	'BisAllRaw',
	'GameCardRaw',
	'GameCardPrivate',
	'SetTime', // 10
	'ContentManager',
	'ImageManager',
	'CreateSaveData',
	'SystemSaveDataManagement',
	'BisFileSystem',
	'SystemUpdate',
	'SaveDataMeta',
	'DeviceSaveData',
	'SettingsControl',
	'SystemData', // 20
	'SdCard',
	'Host',
	'FillBis',
	'CorruptSaveData',
	'SaveDataForDebug',
	'FormatSdCard',
	'GetRightsId',
	'RegisterExternalKey',
	'RegisterUpdatePartition',
	'SaveDataTransfer', // 30
	'DeviceDetection',
	'AccessFailureResolution',
	'SaveDataTransferVersion2',
	'RegisterProgramIndexMapInfo',
	'CreateOwnSaveData',
	'MoveCacheStorage',
	'DeviceTreeBlob',
	'NotifyErrorContextServiceReady',
	'CalibrationSystemData',
	'CalibrationLog', // 40
	'StorageSecure',
	'StorageControl',
	'GameCardReport',
	'MarkBeforeEraseBis',
	'HtmlViewer',
	'ApplicationSaveDataBackUp',
];

function decodeFsAccessFlag(flag: bigint): FsAccessFlagBit[] {
	const out: FsAccessFlagBit[] = [];
	// Bits 47..61 are reserved; bit 62 = Debug; bit 63 = FullPermission
	for (let bit = 0n; bit < 64n; bit++) {
		if ((flag & (1n << bit)) === 0n) continue;
		const idx = Number(bit);
		if (idx < FS_ACCESS_FLAG_NAMES.length) {
			out.push(FS_ACCESS_FLAG_NAMES[idx]);
		} else if (idx === 62) {
			out.push('Debug');
		} else if (idx === 63) {
			out.push('FullPermission');
		} else {
			out.push(`Reserved(${idx})`);
		}
	}
	return out;
}

// =============================================================================
// ServiceAccessControl
// =============================================================================

function parseSac(
	buf: Uint8Array,
	offset: number,
	size: number,
): ServiceAccessControl {
	const entries: ServiceAccessEntry[] = [];
	let cur = offset;
	const end = offset + size;
	while (cur < end) {
		const ctrl = buf[cur];
		const nameLen = (ctrl & 0x07) + 1; // bits 0..2: name length - 1
		const isServer = (ctrl & 0x80) !== 0;
		cur += 1;
		if (cur + nameLen > end) break;
		const name = decoder.decode(buf.subarray(cur, cur + nameLen));
		entries.push({ name, isServer });
		cur += nameLen;
	}
	return { entries };
}

// =============================================================================
// KernelCapability
// =============================================================================

function parseKc(
	buf: Uint8Array,
	view: DataView,
	offset: number,
	size: number,
): KernelCapabilities {
	const descriptors: KernelDescriptor[] = [];
	const numDescriptors = Math.floor(size / 4);
	let i = 0;
	while (i < numDescriptors) {
		const word = view.getUint32(offset + i * 4, true);
		const decoded = decodeKcDescriptor(word);
		// MemoryMap entries come in pairs: a base/permission word followed
		// by a size/mapping word. We surface the pair as a single
		// `MemoryMapPaired` descriptor whenever the next word is also a
		// MemoryMap; otherwise we leave the lone entry as `MemoryMap`.
		if (decoded.kind === 'MemoryMap' && i + 1 < numDescriptors) {
			const next = view.getUint32(offset + (i + 1) * 4, true);
			// Match the same low-bit pattern (bits 0..6 = 0b0111111, bit 6 = 0).
			if (kcKindOf(next) === 'MemoryMap') {
				const beginAddress = ((word >>> 7) & 0xffffff) << 12;
				const permissionType = ((word >>> 31) & 0x01) === 0 ? 'RW' : 'RO';
				const sizeWord = next;
				const sizePages = (sizeWord >>> 7) & 0xfffff;
				const mappingType = ((sizeWord >>> 31) & 0x01) === 0 ? 'Io' : 'Static';
				descriptors.push({
					kind: 'MemoryMapPaired',
					beginAddress,
					size: sizePages << 12,
					permissionType,
					mappingType,
					raw: [word, next],
				});
				i += 2;
				continue;
			}
		}
		descriptors.push(decoded);
		i += 1;
	}
	return { descriptors };
}

/**
 * Determine the descriptor kind from the word's low-bit run-length
 * pattern (per switchbrew). Each kind is identified by the position of
 * its lowest cleared bit.
 *
 *   ...xxxxx0111      (bit 3 = 0)  ThreadInfo
 *   ...xxxxx01111     (bit 4 = 0)  EnableSystemCalls
 *   ...xx0111111      (bit 6 = 0)  MemoryMap
 *   ...x01111111      (bit 7 = 0)  IoMemoryMap
 *   ...01111111111    (bit 10 = 0) MemoryRegionMap
 *   ...011111111111   (bit 11 = 0) EnableInterrupts
 *   ...01111111111111 (bit 13 = 0) MiscParams
 *   011111111111111   (bit 14 = 0) KernelVersion
 *   0111111111111111  (bit 15 = 0) HandleTableSize
 *   1111111111111111  (bit 16 = 0) MiscFlags
 */
function kcKindOf(word: number): KernelDescriptor['kind'] | 'Unknown' {
	if ((word & 0x0f) === 0x07) return 'ThreadInfo';
	if ((word & 0x1f) === 0x0f) return 'EnableSystemCalls';
	if ((word & 0x7f) === 0x3f) return 'MemoryMap';
	if ((word & 0xff) === 0x7f) return 'IoMemoryMap';
	if ((word & 0x7ff) === 0x3ff) return 'MemoryRegionMap';
	if ((word & 0xfff) === 0x7ff) return 'EnableInterrupts';
	if ((word & 0x3fff) === 0x1fff) return 'MiscParams';
	if ((word & 0x7fff) === 0x3fff) return 'KernelVersion';
	if ((word & 0xffff) === 0x7fff) return 'HandleTableSize';
	if ((word & 0x1ffff) === 0xffff) return 'MiscFlags';
	return 'Unknown';
}

function decodeKcDescriptor(word: number): KernelDescriptor {
	const kind = kcKindOf(word);
	switch (kind) {
		case 'ThreadInfo': {
			const lowestPriority = (word >>> 4) & 0x3f;
			const highestPriority = (word >>> 10) & 0x3f;
			const minCoreNumber = (word >>> 16) & 0xff;
			const maxCoreNumber = (word >>> 24) & 0xff;
			return {
				kind: 'ThreadInfo',
				lowestPriority,
				highestPriority,
				minCoreNumber,
				maxCoreNumber,
				raw: word,
			};
		}
		case 'EnableSystemCalls': {
			const mask = (word >>> 5) & 0xffffff; // bits 5..28 = 24 bit mask
			const index = (word >>> 29) & 0x07;
			const syscalls: number[] = [];
			for (let b = 0; b < 24; b++) {
				if (mask & (1 << b)) syscalls.push(index * 24 + b);
			}
			return { kind: 'EnableSystemCalls', index, mask, syscalls, raw: word };
		}
		case 'MemoryMap':
			// First word of a pair; we surface lone occurrences as-is.
			return { kind: 'MemoryMap', raw: word };
		case 'IoMemoryMap':
			return {
				kind: 'IoMemoryMap',
				beginAddress: ((word >>> 8) & 0xffffff) << 12,
				raw: word,
			};
		case 'MemoryRegionMap': {
			const regions = [
				{ type: (word >>> 11) & 0x3f, readOnly: ((word >>> 17) & 1) === 1 },
				{ type: (word >>> 18) & 0x3f, readOnly: ((word >>> 24) & 1) === 1 },
				{ type: (word >>> 25) & 0x3f, readOnly: ((word >>> 31) & 1) === 1 },
			];
			return { kind: 'MemoryRegionMap', regions, raw: word };
		}
		case 'EnableInterrupts': {
			const a = (word >>> 12) & 0x3ff;
			const b = (word >>> 22) & 0x3ff;
			const interrupts: number[] = [];
			if (a !== 0x3ff) interrupts.push(a);
			if (b !== 0x3ff) interrupts.push(b);
			return { kind: 'EnableInterrupts', interrupts, raw: word };
		}
		case 'MiscParams': {
			const t = (word >>> 14) & 0x07;
			const programType =
				t === 0
					? 'System'
					: t === 1
						? 'Application'
						: t === 2
							? 'Applet'
							: 'Unknown';
			return { kind: 'MiscParams', programType, raw: word };
		}
		case 'KernelVersion': {
			const minorVersion = (word >>> 15) & 0x0f;
			const majorVersion = (word >>> 19) & 0x1fff;
			return {
				kind: 'KernelVersion',
				minorVersion,
				majorVersion,
				raw: word,
			};
		}
		case 'HandleTableSize':
			return {
				kind: 'HandleTableSize',
				handleTableSize: (word >>> 16) & 0x3ff,
				raw: word,
			};
		case 'MiscFlags': {
			const enableDebug = ((word >>> 17) & 1) === 1;
			const forceDebugProd = ((word >>> 18) & 1) === 1;
			const forceDebug = ((word >>> 19) & 1) === 1;
			return {
				kind: 'MiscFlags',
				enableDebug,
				forceDebugProd,
				forceDebug,
				raw: word,
			};
		}
		default:
			return { kind: 'Unknown', raw: word };
	}
}

// =============================================================================
// Helpers
// =============================================================================

function readNulString(buf: Uint8Array, offset: number, maxLen: number): string {
	let end = offset;
	const stop = Math.min(buf.length, offset + maxLen);
	while (end < stop && buf[end] !== 0) end++;
	return decoder.decode(buf.subarray(offset, end));
}

function align(value: number, alignment: number): number {
	const mask = alignment - 1;
	return (value + mask) & ~mask;
}

/** Hex-encode a Uint8Array into the form `"00112233..."`. */
export function hex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
	return s;
}
