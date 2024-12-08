// Reference: https://switchbrew.org/wiki/NACP
// Adapted from: https://github.com/switchbrew/switch-tools/blob/master/src/nacptool.c
// More:
//   - https://switchbrew.github.io/libnx/nacp_8h_source.html
//   - https://www.retroreversing.com/SwitchFileFormats
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export enum VideoCapture {
	Disabled = 0,
	Enabled = 1,
	Automatic = 2,
}

function encodeWithSize(v: string, size: number, name: string) {
	const buf = encoder.encode(v);
	if (buf.length >= size) {
		throw new TypeError(
			`"${name}" length must be <= ${size - 1} bytes, got ${buf.length}`
		);
	}
	const bufWithZeros = new Uint8Array(size);
	bufWithZeros.set(buf);
	return bufWithZeros;
}

function parseU64(v: string | bigint): bigint {
	let id = v;
	if (typeof id === 'string') {
		if (id.length > 16) {
			throw new TypeError(`"id" length must be 16, got ${id.length}`);
		}
		id = BigInt(`0x${v}`);
	}
	return id;
}

export class NACP {
	buffer: ArrayBuffer;
	#dataView: DataView;

	constructor(buffer?: ArrayBuffer) {
		if (buffer) {
			this.buffer = buffer;
			this.#dataView = new DataView(this.buffer);
		} else {
			this.buffer = new ArrayBuffer(0x4000);
			this.#dataView = new DataView(this.buffer);

			this.#dataView.setUint32(0x3024, 0x100, true);
			this.#dataView.setUint32(0x302c, 0xbff, true);
			this.#dataView.setUint32(0x3034, 0x10000, true);

			const unkData = new Uint8Array([
				0x0c, 0xff, 0xff, 0x0a, 0xff, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c,
				0x0d, 0x0d, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
				0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
				0xff, 0xff,
			]);
			new Uint8Array(this.buffer, 0x3040, unkData.length).set(unkData);

			this.#dataView.setUint32(0x3080, 0x3e00000, true);
			this.#dataView.setUint32(0x3088, 0x180000, true);
			this.#dataView.setUint32(0x30f0, 0x102, true);
		}
	}

	get title(): string {
		const data = new Uint8Array(this.buffer, 0, 0x200);
		return decoder.decode(data).replace(/\0*$/, '');
	}

	set title(v: string) {
		const buf = encodeWithSize(v, 0x200, 'title');
		for (let i = 0; i < 12; i++) {
			new Uint8Array(this.buffer, i * 0x300, buf.length).set(buf);
		}
	}

	get author(): string {
		const data = new Uint8Array(this.buffer, 0x200, 0x100);
		return decoder.decode(data).replace(/\0*$/, '');
	}

	set author(v: string) {
		const buf = encodeWithSize(v, 0x100, 'author');
		for (let i = 0; i < 12; i++) {
			new Uint8Array(this.buffer, i * 0x300 + 0x200, buf.length).set(buf);
		}
	}

	set id(v: string | bigint) {
		const val = parseU64(v);

		// PresenceGroupId
		this.#dataView.setBigUint64(0x3038, val, true);

		// SaveDataOwnerId
		this.#dataView.setBigUint64(0x3078, val, true);

		// AddOnContentBaseId (dlcbase)
		this.#dataView.setBigUint64(0x3070, val + 0x1000n, true);

		// LocalCommunicationId
		for (let x = 0; x < 8; x++) {
			this.#dataView.setBigUint64(0x30b0 + x * 0x8, val, true);
		}
	}

	get id(): bigint {
		return this.#dataView.getBigUint64(0x3038, true);
	}

	/**
	 * Whether or not to display the user account picker
	 * when booting up the application.
	 */
	set startupUserAccount(v: number) {
		this.#dataView.setUint8(0x3025, v);
	}
	get startupUserAccount(): number {
		return this.#dataView.getUint8(0x3025);
	}

	set userAccountSwitchLock(v: number) {
		this.#dataView.setUint8(0x3026, v);
	}
	get userAccountSwitchLock(): number {
		return this.#dataView.getUint8(0x3026);
	}

	set addOnContentRegistrationType(v: number) {
		this.#dataView.setUint8(0x3027, v);
	}
	get addOnContentRegistrationType(): number {
		return this.#dataView.getUint8(0x3027);
	}

	set attributeFlag(v: number) {
		this.#dataView.setUint32(0x3028, v, true);
	}
	get attributeFlag(): number {
		return this.#dataView.getUint32(0x3028, true);
	}

	set supportedLanguageFlag(v: number) {
		this.#dataView.setUint32(0x302c, v, true);
	}
	get supportedLanguageFlag(): number {
		return this.#dataView.getUint32(0x302c, true);
	}

	set parentalControlFlag(v: number) {
		this.#dataView.setUint32(0x3030, v, true);
	}
	get parentalControlFlag(): number {
		return this.#dataView.getUint32(0x3030, true);
	}

	/**
	 * Whether or not pressing the screenshot button will capture a screenshot.
	 *   - Value of `0`: Enabled
	 *   - Value of `1`: Disabled
	 */
	set screenshot(v: number) {
		this.#dataView.setUint8(0x3034, v);
	}
	get screenshot(): number {
		return this.#dataView.getUint8(0x3034);
	}

	/**
	 * Whether or not holding the screenshot button will capture a video.
	 *   - Value of `0`: Disabled
	 *   - Value of `1`: Only enabled if app invokes `appletInitializeGamePlayRecording()`
	 *   - Value of `2`: Always enabled
	 */
	set videoCapture(v: VideoCapture) {
		this.#dataView.setUint8(0x3035, v);
	}
	get videoCapture(): VideoCapture {
		return this.#dataView.getUint8(0x3035);
	}

	set dataLossConfirmation(v: number) {
		this.#dataView.setUint8(0x3036, v);
	}
	get dataLossConfirmation(): number {
		return this.#dataView.getUint8(0x3036);
	}

	set playLogPolicy(v: number) {
		this.#dataView.setUint8(0x3037, v);
	}
	get playLogPolicy(): number {
		return this.#dataView.getUint8(0x3037);
	}

	set presenceGroupId(v: string | bigint) {
		this.#dataView.setBigUint64(0x3038, parseU64(v), true);
	}
	get presenceGroupId(): bigint {
		return this.#dataView.getBigUint64(0x3038, true);
	}

	get version(): string {
		const data = new Uint8Array(this.buffer, 0x3060, 0x10);
		return decoder.decode(data).replace(/\0*$/, '');
	}
	set version(v: string) {
		const buf = encodeWithSize(v, 0x10, 'version');
		new Uint8Array(this.buffer, 0x3060, buf.length).set(buf);
	}

	set addOnContentBaseId(v: string | bigint) {
		this.#dataView.setBigUint64(0x3070, parseU64(v), true);
	}
	get addOnContentBaseId(): bigint {
		return this.#dataView.getBigUint64(0x3070, true);
	}

	set saveDataOwnerId(v: string | bigint) {
		this.#dataView.setBigUint64(0x3078, parseU64(v), true);
	}
	get saveDataOwnerId(): bigint {
		return this.#dataView.getBigUint64(0x3078, true);
	}

	set userAccountSaveDataSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3080, parseU64(v), true);
	}
	get userAccountSaveDataSize(): bigint {
		return this.#dataView.getBigUint64(0x3080, true);
	}

	set userAccountSaveDataJournalSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3088, parseU64(v), true);
	}
	get userAccountSaveDataJournalSize(): bigint {
		return this.#dataView.getBigUint64(0x3088, true);
	}

	set deviceSaveDataSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3090, parseU64(v), true);
	}
	get deviceSaveDataSize(): bigint {
		return this.#dataView.getBigUint64(0x3090, true);
	}

	set deviceSaveDataJournalSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3098, parseU64(v), true);
	}
	get deviceSaveDataJournalSize(): bigint {
		return this.#dataView.getBigUint64(0x3098, true);
	}

	set bcatDeliveryCacheStorageSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x30a0, parseU64(v), true);
	}
	get bcatDeliveryCacheStorageSize(): bigint {
		return this.#dataView.getBigUint64(0x30a0, true);
	}

	set applicationErrorCodeCategory(v: string | bigint) {
		this.#dataView.setBigUint64(0x30a8, parseU64(v), true);
	}
	get applicationErrorCodeCategory(): bigint {
		return this.#dataView.getBigUint64(0x30a8, true);
	}

	/**
	 * Text shown above logo during boot-up.
	 *   - Value of 0: "Licensed by"
	 *   - Value of 1: "Distributed by"
	 *   - Anything else: no text shown
	 */
	set logoType(v: number) {
		this.#dataView.setUint8(0x30f0, v);
	}
	get logoType(): number {
		return this.#dataView.getUint8(0x30f0);
	}

	set logoHandling(v: number) {
		this.#dataView.setUint8(0x30f1, v);
	}
	get logoHandling(): number {
		return this.#dataView.getUint8(0x30f1);
	}

	set runtimeAddOnContentInstall(v: number) {
		this.#dataView.setUint8(0x30f2, v);
	}
	get runtimeAddOnContentInstall(): number {
		return this.#dataView.getUint8(0x30f2);
	}

	set runtimeParameterDelivery(v: number) {
		this.#dataView.setUint8(0x30f3, v);
	}
	get runtimeParameterDelivery(): number {
		return this.#dataView.getUint8(0x30f3);
	}

	set crashReport(v: number) {
		this.#dataView.setUint8(0x30f6, v);
	}
	get crashReport(): number {
		return this.#dataView.getUint8(0x30f6);
	}

	set hdcp(v: number) {
		this.#dataView.setUint8(0x30f7, v);
	}
	get hdcp(): number {
		return this.#dataView.getUint8(0x30f7);
	}

	set pseudoDeviceIdSeed(v: string | bigint) {
		this.#dataView.setBigUint64(0x30a8, parseU64(v), true);
	}
	get pseudoDeviceIdSeed(): bigint {
		return this.#dataView.getBigUint64(0x30a8, true);
	}

	set startupUserAccountOption(v: number) {
		this.#dataView.setUint8(0x3141, v);
	}
	get startupUserAccountOption(): number {
		return this.#dataView.getUint8(0x3141);
	}

	set userAccountSaveDataSizeMax(v: string | bigint) {
		this.#dataView.setBigUint64(0x3148, parseU64(v), true);
	}
	get userAccountSaveDataSizeMax(): bigint {
		return this.#dataView.getBigUint64(0x3148, true);
	}

	set userAccountSaveDataJournalSizeMax(v: string | bigint) {
		this.#dataView.setBigUint64(0x3150, parseU64(v), true);
	}
	get userAccountSaveDataJournalSizeMax(): bigint {
		return this.#dataView.getBigUint64(0x3150, true);
	}

	set deviceSaveDataSizeMax(v: string | bigint) {
		this.#dataView.setBigUint64(0x3158, parseU64(v), true);
	}
	get deviceSaveDataSizeMax(): bigint {
		return this.#dataView.getBigUint64(0x3158, true);
	}

	set deviceSaveDataJournalSizeMax(v: string | bigint) {
		this.#dataView.setBigUint64(0x3160, parseU64(v), true);
	}
	get deviceSaveDataJournalSizeMax(): bigint {
		return this.#dataView.getBigUint64(0x3160, true);
	}

	set temporaryStorageSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3168, parseU64(v), true);
	}
	get temporaryStorageSize(): bigint {
		return this.#dataView.getBigUint64(0x3168, true);
	}

	set cacheStorageSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3170, parseU64(v), true);
	}
	get cacheStorageSize(): bigint {
		return this.#dataView.getBigUint64(0x3170, true);
	}

	set cacheStorageJournalSize(v: string | bigint) {
		this.#dataView.setBigUint64(0x3178, parseU64(v), true);
	}
	get cacheStorageJournalSize(): bigint {
		return this.#dataView.getBigUint64(0x3178, true);
	}

	set cacheStorageDataAndJournalSizeMax(v: string | bigint) {
		this.#dataView.setBigUint64(0x3180, parseU64(v), true);
	}
	get cacheStorageDataAndJournalSizeMax(): bigint {
		return this.#dataView.getBigUint64(0x3180, true);
	}

	set cacheStorageIndexMax(v: number) {
		this.#dataView.setUint16(0x3188, v, true);
	}
	get cacheStorageIndexMax(): number {
		return this.#dataView.getUint16(0x3188, true);
	}

	set playLogQueryCapability(v: number) {
		this.#dataView.setUint8(0x3210, v);
	}
	get playLogQueryCapability(): number {
		return this.#dataView.getUint8(0x3210);
	}

	set repairFlag(v: number) {
		this.#dataView.setUint8(0x3211, v);
	}
	get repairFlag(): number {
		return this.#dataView.getUint8(0x3211);
	}

	set programIndex(v: number) {
		this.#dataView.setUint8(0x3212, v);
	}
	get programIndex(): number {
		return this.#dataView.getUint8(0x3212);
	}

	set requiredNetworkServiceLicenseOnLaunch(v: number) {
		this.#dataView.setUint8(0x3213, v);
	}
	get requiredNetworkServiceLicenseOnLaunch(): number {
		return this.#dataView.getUint8(0x3213);
	}
}
