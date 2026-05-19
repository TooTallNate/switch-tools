/**
 * FFVIII `chara.one` outer-container parser.
 *
 * `chara.one` is a small file that ships in every FFVIII field
 * map and lists the field-character models the map uses. Each
 * entry is either:
 *
 *   - **embedded** (the most common case): a self-contained
 *     block holding a list of TIM textures + an MCH model body
 *     + a 12-byte trailer (name, light colour, extension-loader
 *     id). This is how unique NPCs are shipped per-map.
 *
 *   - **shared-texture**: the entry has no TIM list of its own,
 *     and instead reuses the textures from another entry in the
 *     same `chara.one`. The 'sibling' entry index is encoded in
 *     the model ID (`(modelID >> 20) & 0xFF`). The model body
 *     is still inline.
 *
 *   - **external**: a reference to a separate `d###.mch` file
 *     (the party members + named recurring characters). The
 *     entry contains override animations only — no mesh, no
 *     textures. The number `###` is `modelID & 0xFFFF`.
 *
 * The variant is selected by the top nibble of the per-entry
 * "flag" dword: `0xD` = external, `0xA` = shared-texture,
 * anything else = embedded. (Equivalently, `(modelID >> 24) &
 * 0xF0`.)
 *
 * PC (Steam / Switch Remastered) layout:
 *
 *   offset  type  field
 *     0x00  u32   modelCount
 *     0x04  …     variable-size entry-header records
 *                 (packed into the first 0x800 bytes)
 *     0x800 …    payloads        (referenced by entry offset)
 *
 * Each entry record has a 12- or 16-byte fixed prefix:
 *     +0x00  u32  dataOffset     (RELATIVE to start of `chara.one`)
 *     +0x04  u32  dataSize
 *     +0x08  u32  modelID/flag
 *  on PSX, or when `modelID == dataSize` ("size twice" rule):
 *     +0x0C  u32  modelID        (overwriting the previous u32)
 *
 * …then a variable section depending on the variant:
 *   - external (0xD…):       u32 animationOffset
 *   - shared-texture (0xA…): u32 0xFFFFFFFF + u32 modelOffset
 *   - embedded (else):       `modelID` itself is the first TIM
 *                            offset (low 24 bits) plus a count
 *                            in the upper 4 bits; subsequent
 *                            entries are u32 TIM offsets until
 *                            a negative dword is read; then
 *                            u32 modelOffset
 *
 * …followed by an optional 12-byte trailer (`u8[4] name +
 * u8[3] rgb + u8 pad + u32 extLoaderId`). The trailer is
 * present whenever the *next* entry's `dataOffset` is non-zero
 * AND not equal to `dataOffset + dataSize`; testno-style files
 * with back-to-back payloads omit it.
 *
 * The **+4 fudge**: on PC, the entry's payload actually starts
 * at `dataOffset + 4`. The first dword of every payload is
 * reserved / padding and we skip it.
 *
 * For external entries the `name` is overridden with
 * `"d" + (modelID & 0xFFFF).toString().padStart(3,"0")`.
 *
 * Dummy-file detection: maps that ship no characters store a
 * 33-byte sentinel ("This is dummy file. Kazuo Suzuki\n") or
 * an empty file. We treat anything smaller than 0x100 bytes as
 * a dummy.
 *
 * Reference: deling (Source/files/CharaOneFile.cpp) and
 * OpenVIII-monogame (`Field/CharaOne.cs`).
 *
 * NOTE ON REAL-WORLD FILES: a sample chara.one shipped with the
 * Switch Remastered port was inspected during development and
 * found to begin with a 4-byte file-size prefix that the spec
 * does not mention. The parser will optionally strip such a
 * prefix when `bytes[0..4]` equals the file length. Beyond that
 * point the on-disk layout still doesn't exactly match what the
 * deling reference parser expects (offsets appear to be in
 * 0x800-byte pages, not bytes), so the parser exposes the raw
 * fields it found and lets the caller cope. Synthetic round-
 * trip tests fully exercise the documented algorithm.
 */

export class CharaOneParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CharaOneParseError';
	}
}

export type CharaOneVariant = 'external' | 'shared-texture' | 'embedded';

export interface CharaOneEntry {
	/** Index of this entry in the file (0-based). */
	index: number;
	/**
	 * Absolute file offset of the entry's payload data — already
	 * +4-fudged (i.e. points to the first byte of useful content,
	 * not the 4-byte filler the raw header points at).
	 */
	dataOffset: number;
	/**
	 * Size of the payload as declared in the entry header. NB:
	 * this is the *unfudged* size — it includes the 4-byte filler
	 * at the start. Subtract 4 if you want the size of the
	 * fudged-offset slice.
	 */
	dataSize: number;
	/** Raw 32-bit flag/model dword as it appears on disk. */
	modelID: number;
	variant: CharaOneVariant;
	/** ASCII name ("a000", "d042", "p001", …). */
	name: string;
	/** Per-character light colour (RGB, 0-255). */
	lightColor: [number, number, number];
	/** Extension-loader ID, if present in the trailer. */
	extLoaderId?: number;
	/**
	 * Embedded only: absolute file offsets of the TIM textures
	 * for this character.
	 */
	timOffsets?: number[];
	/**
	 * Embedded / shared-texture only: absolute file offset of
	 * the MCH `ModelHeader` for this character. (Pass this to
	 * {@link parseMch} via `bodyOffset` — relative to a slice
	 * starting at `dataOffset`.)
	 */
	modelOffset?: number;
	/**
	 * External only: absolute file offset within `chara.one` of
	 * the override animation block, if any. Most entries have
	 * none and this is omitted.
	 */
	animationOffset?: number;
	/**
	 * External only: the `###` in the referenced `d###.mch`.
	 */
	externalRefId?: number;
	/**
	 * Shared-texture only: index into `entries[]` of the sibling
	 * model whose textures this entry reuses.
	 */
	sharedTextureModelIndex?: number;
}

export interface ParsedCharaOne {
	modelCount: number;
	entries: CharaOneEntry[];
	/**
	 * True if the file is a 33-byte dummy / very small filler.
	 * In that case `entries` is empty.
	 */
	isDummy: boolean;
}

/**
 * Detect FFVIII's "dummy file" placeholders. Maps with no
 * field characters either ship the 33-byte ASCII sentinel
 * `"This is dummy file. Kazuo Suzuki\n"` or, on some platforms,
 * a small filler block under 0x100 bytes.
 */
export function isDummyCharaOne(bytes: Uint8Array): boolean {
	if (bytes.length === 33) return true;
	if (bytes.length < 0x100) return true;
	return false;
}

export interface ParseCharaOneOptions {
	/**
	 * If true, automatically strip a leading 4-byte file-size
	 * prefix when `bytes[0..4]` reads back as the buffer's own
	 * length (some FFVIII Switch builds wrap chara.one this way).
	 * Default: true.
	 */
	stripFileSizePrefix?: boolean;
}

export function parseCharaOne(
	bytes: Uint8Array,
	opts: ParseCharaOneOptions = {},
): ParsedCharaOne {
	if (isDummyCharaOne(bytes)) {
		return { modelCount: 0, entries: [], isDummy: true };
	}
	if (bytes.length < 4) {
		throw new CharaOneParseError(
			`chara.one too short (${bytes.length} bytes)`,
		);
	}

	// Optionally strip a leading u32 file-size prefix.
	const stripPrefix = opts.stripFileSizePrefix !== false;
	let work = bytes;
	let workBase = 0;
	if (stripPrefix && bytes.length >= 8) {
		const v0 = new DataView(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength,
		);
		const maybeSize = v0.getUint32(0, true);
		if (maybeSize === bytes.length) {
			work = bytes.subarray(4);
			workBase = 4;
		}
	}

	const view = new DataView(
		work.buffer,
		work.byteOffset,
		work.byteLength,
	);
	const modelCount = view.getUint32(0, true);

	// Sanity bound: a real chara.one has at most ~256 entries.
	if (modelCount > 1024) {
		throw new CharaOneParseError(
			`Implausible modelCount ${modelCount} (file likely not a chara.one)`,
		);
	}
	const entries: CharaOneEntry[] = [];

	// Header table is packed into the first 0x800 bytes after
	// modelCount. Entries are VARIABLE-SIZE.
	const headerLimit = Math.min(0x800, work.length);
	let p = 4;
	for (let i = 0; i < modelCount && p < headerLimit; i++) {
		if (p + 12 > headerLimit) break;
		const rawDataOffset = view.getUint32(p, true);
		p += 4;
		if (rawDataOffset === 0) break;
		const dataSize = view.getUint32(p, true);
		p += 4;
		let modelID = view.getUint32(p, true);
		p += 4;
		if (modelID === dataSize) {
			// "size twice" rule — re-read modelID.
			if (p + 4 > headerLimit) break;
			modelID = view.getUint32(p, true);
			p += 4;
		}

		// Apply the +4 fudge to derive the actual payload offset.
		const dataOffset = rawDataOffset + 4 + workBase;

		const flagTop = (modelID & 0xf0000000) >>> 0;
		let variant: CharaOneVariant;
		if (flagTop === 0xd0000000) variant = 'external';
		else if (flagTop === 0xa0000000) variant = 'shared-texture';
		else variant = 'embedded';

		const entry: CharaOneEntry = {
			index: i,
			dataOffset,
			dataSize,
			modelID,
			variant,
			name: '',
			lightColor: [0xff, 0xff, 0xff],
		};

		if (variant === 'external') {
			// External: u32 animationOffset within payload.
			if (p + 4 > headerLimit) break;
			const animOffRel = view.getUint32(p, true);
			p += 4;
			entry.animationOffset = dataOffset + animOffRel;
			entry.externalRefId = modelID & 0xffff;
		} else if (variant === 'shared-texture') {
			// Shared-texture: u32 0xFFFFFFFF + u32 modelOffset.
			if (p + 8 > headerLimit) break;
			p += 4; // skip sentinel
			const mchRel = view.getUint32(p, true);
			p += 4;
			entry.modelOffset = dataOffset + mchRel;
			entry.sharedTextureModelIndex = (modelID >>> 20) & 0xff;
		} else {
			// Embedded: `modelID` IS the first TIM offset (low 24
			// bits = offset; upper 4 bits = packed texture count).
			const timOffsetsRel: number[] = [];
			if ((modelID | 0) >= 0) {
				timOffsetsRel.push(modelID & 0xffffff);
				while (p + 4 <= headerLimit) {
					const t = view.getUint32(p, true);
					p += 4;
					if ((t | 0) < 0) break; // sign bit set = terminator
					timOffsetsRel.push(t & 0xffffff);
				}
			}
			if (p + 4 > headerLimit) break;
			const mchRel = view.getUint32(p, true);
			p += 4;
			entry.timOffsets = timOffsetsRel.map((rel) => dataOffset + rel);
			entry.modelOffset = dataOffset + mchRel;
		}

		// Optional 12-byte trailer. Read NEXT entry's dataOffset
		// to detect testno-style back-to-back layout.
		let hasTrailer = false;
		if (p + 12 <= headerLimit) {
			const nextOff = view.getUint32(p, true);
			if (nextOff !== 0 && nextOff !== rawDataOffset + dataSize) {
				hasTrailer = true;
			}
		}
		if (hasTrailer) {
			let name = '';
			for (let k = 0; k < 4; k++) {
				const c = work[p + k] ?? 0;
				if (c === 0) break;
				name += String.fromCharCode(c);
			}
			p += 4;
			const r = work[p] ?? 0xff;
			const g = work[p + 1] ?? 0xff;
			const b = work[p + 2] ?? 0xff;
			// p + 3 is pad
			p += 4;
			const ext = view.getUint32(p, true);
			p += 4;
			entry.name = name;
			entry.lightColor = [r, g, b];
			entry.extLoaderId = ext;
		}

		// External entries always have a derived name regardless
		// of trailer presence.
		if (variant === 'external') {
			entry.name = 'd' + String(entry.externalRefId!).padStart(3, '0');
		}

		entries.push(entry);
	}

	return { modelCount, entries, isDummy: false };
}
