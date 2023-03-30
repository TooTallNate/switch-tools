// Reference: https://switchbrew.org/wiki/NACP#ApplicationJitConfiguration
// Adapted from: https://github.com/switchbrew/switch-tools/blob/master/src/nacptool.c
// More:
//   - https://switchbrew.github.io/libnx/nacp_8h_source.html
//   - https://www.retroreversing.com/SwitchFileFormats
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export enum VideoCapture {
	Disabled,
	Enabled,
	Automatic,
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

export class NACP {
	buffer: ArrayBuffer;
	dataView: DataView;

	constructor(buffer?: ArrayBuffer) {
		if (buffer) {
			this.buffer = buffer;
			this.dataView = new DataView(this.buffer);
		} else {
			this.buffer = new ArrayBuffer(0x4000);
			this.dataView = new DataView(this.buffer);

			this.dataView.setUint32(0x3024, 0x100, true);
			this.dataView.setUint32(0x302c, 0xbff, true);
			this.dataView.setUint32(0x3034, 0x10000, true);

			const unkData = new Uint8Array([
				0x0c, 0xff, 0xff, 0x0a, 0xff, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c,
				0x0d, 0x0d, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
				0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
				0xff, 0xff,
			]);
			new Uint8Array(this.buffer, 0x3040, unkData.length).set(unkData);

			this.dataView.setUint32(0x3080, 0x3e00000, true);
			this.dataView.setUint32(0x3088, 0x180000, true);
			this.dataView.setUint32(0x30f0, 0x102, true);
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

	get version(): string {
		const data = new Uint8Array(this.buffer, 0x3060, 0x10);
		return decoder.decode(data).replace(/\0*$/, '');
	}

	set version(v: string) {
		const buf = encodeWithSize(v, 0x10, 'version');
		new Uint8Array(this.buffer, 0x3060, buf.length).set(buf);
	}

	set id(v: string | bigint) {
		let val = v;
		if (typeof val === 'string') {
			if (val.length > 16) {
				throw new TypeError(
					`"id" length must be 16, got ${val.length}`
				);
			}
			val = BigInt(`0x${v}`);
		}

		// PresenceGroupId
		this.dataView.setBigUint64(0x3038, val, true);

		// SaveDataOwnerId
		this.dataView.setBigUint64(0x3078, val, true);

		// AddOnContentBaseId (dlcbase)
		this.dataView.setBigUint64(0x3070, val + 0x1000n, true);

		// LocalCommunicationId
		for (let x = 0; x < 8; x++) {
			this.dataView.setBigUint64(0x30b0 + x * 0x8, val, true);
		}
	}

	get id(): bigint {
		return this.dataView.getBigUint64(0x3038, true);
	}

	/**
	 * Whether or not to display the user account picker
	 * when booting up the application.
	 */
	set startupUserAccount(v: number) {
		this.dataView.setUint8(0x3025, v);
	}

	get startupUserAccount(): number {
		return this.dataView.getUint8(0x3025);
	}

	set screenshot(v: number) {
		this.dataView.setUint8(0x3034, v);
	}

	get screenshot(): number {
		return this.dataView.getUint8(0x3034);
	}

	set videoCapture(v: VideoCapture) {
		this.dataView.setUint8(0x3035, v);
	}

	get videoCapture(): VideoCapture {
		return this.dataView.getUint8(0x3035);
	}

	/**
	 * Text shown above logo during boot-up.
	 *   - Value of 0: "Licensed by"
	 *   - Value of 1: "Distributed by"
	 *   - Anything else: no text shown
	 */
	set logoType(v: number) {
		this.dataView.setUint8(0x30f0, v);
	}

	get logoType(): number {
		return this.dataView.getUint8(0x30f0);
	}

	set logoHandling(v: number) {
		this.dataView.setUint8(0x30f1, v);
	}

	get logoHandling(): number {
		return this.dataView.getUint8(0x30f1);
	}
}
