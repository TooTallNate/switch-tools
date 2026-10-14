/**
 * BKTR patch sections (crypt type 4): the RomFS of an Update NCA.
 *
 * An update doesn't ship a whole new RomFS. Its RomFS section is a
 * *patched view* over the base game's RomFS section, described by two
 * BucketTrees whose locations live in the FS header's PatchInfo
 * (FS-header offset 0x100):
 *
 *   0x100  IndirectInfo  { offset u64, size u64, header[0x10] }
 *   0x120  AesCtrExInfo  { offset u64, size u64, header[0x10] }
 *
 * Offsets are relative to the start of the patch section. Both tables
 * are stored with the section's ordinary AES-CTR counter.
 *
 *  - **Indirect table** (0x14-byte entries: virtOffset s64,
 *    physOffset s64, storageIndex s32). It maps every byte of the
 *    patched virtual section to either storage 0, the base NCA's
 *    matching section (decrypted), or storage 1, the patch section's
 *    own data.
 *  - **AesCtrEx table** (0x10-byte entries: offset s64,
 *    encryptionValue u8, reserved[3], generation s32). It splits the
 *    patch section's physical data into runs, each encrypted with the
 *    section counter whose upper "generation" half is replaced by the
 *    entry's generation. That lets one update reuse ciphertext from an
 *    older update without re-encrypting it. `encryptionValue == 1`
 *    means the run is stored in the clear.
 *
 * The patched virtual section has the same layout as an ordinary RomFS
 * section, so the patch FS header's own IVFC header locates the RomFS
 * level inside it.
 *
 * Sources: Atmosphere `fssystem_indirect_storage`,
 * `fssystem_aes_ctr_counter_extended_storage`, and
 * `fssystem_nca_file_system_driver`; hactool `bktr.h` / `nca.c`.
 * Both tables use 16 KiB nodes.
 */
import { BucketTreeReader, parseBucketTreeHeader } from './bucket-tree.js';
import { aesCtrEncrypt, buildNcaCtr } from './crypto.js';

const NODE_SIZE = 16 * 1024;
const INDIRECT_ENTRY_SIZE = 0x14;
const AES_CTR_EX_ENTRY_SIZE = 0x10;

export interface PatchInfo {
	indirectOffset: number;
	indirectSize: number;
	indirectEntryCount: number;
	aesCtrExOffset: number;
	aesCtrExSize: number;
	aesCtrExEntryCount: number;
}

/** Parse the PatchInfo block of a BKTR section's FS header. */
export function readPatchInfo(fsHeader: Uint8Array): PatchInfo {
	const dv = new DataView(fsHeader.buffer, fsHeader.byteOffset, fsHeader.byteLength);
	const indirect = parseBucketTreeHeader(fsHeader.subarray(0x110, 0x120));
	const aesCtrEx = parseBucketTreeHeader(fsHeader.subarray(0x130, 0x140));
	return {
		indirectOffset: Number(dv.getBigUint64(0x100, true)),
		indirectSize: Number(dv.getBigUint64(0x108, true)),
		indirectEntryCount: indirect.entryCount,
		aesCtrExOffset: Number(dv.getBigUint64(0x120, true)),
		aesCtrExSize: Number(dv.getBigUint64(0x128, true)),
		aesCtrExEntryCount: aesCtrEx.entryCount,
	};
}

/** `(start, end) => bytes`, with offsets local to some storage. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

export interface PatchedSectionOptions {
	/** The raw (still-encrypted) Update NCA. */
	source: Blob;
	/** Absolute offset of the patch section in `source`. */
	sectionStart: number;
	/** Size of the patch section in `source`. */
	sectionSize: number;
	fsHeader: Uint8Array;
	sectionCtr: Uint8Array;
	sectionKey: Uint8Array;
	/** Decrypted data of the base NCA's matching section. */
	base: Blob;
	crypto?: Crypto;
}

/**
 * AES-CTR decrypt `[start, end)` (section-local) of the patch section,
 * with `sectionCtr` as the counter's upper half. `generation`, when
 * given, replaces the counter's generation field.
 */
async function ctrRange(
	o: PatchedSectionOptions,
	start: number,
	end: number,
	generation: number | null,
	crypto: Crypto,
): Promise<Uint8Array> {
	if (end <= start) return new Uint8Array(0);
	const blockStart = start - (start % 16);
	const blockEnd = end % 16 === 0 ? end : end + (16 - (end % 16));
	const absStart = o.sectionStart + blockStart;
	const enc = new Uint8Array(
		await o.source.slice(absStart, o.sectionStart + blockEnd).arrayBuffer(),
	);
	let upper = o.sectionCtr;
	if (generation !== null) {
		// sectionCtr is { generation u32 LE, secureValue u32 LE }; buildNcaCtr
		// byte-reverses it into counter[0..8], so this puts the generation
		// big-endian in counter[4..8], matching hactool.
		upper = new Uint8Array(o.sectionCtr);
		new DataView(upper.buffer).setUint32(0, generation >>> 0, true);
	}
	const ctr = buildNcaCtr(upper, absStart);
	const dec = await aesCtrEncrypt(o.sectionKey, enc, ctr, crypto);
	return dec.subarray(start - blockStart, start - blockStart + (end - start));
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
	if (parts.length === 1 && parts[0].byteLength === total) return parts[0];
	const out = new Uint8Array(total);
	let p = 0;
	for (const part of parts) {
		out.set(part, p);
		p += part.byteLength;
	}
	return out;
}

/**
 * Build the patched virtual section of a BKTR section. Returns its size
 * plus a reader over it. Nothing is read until the first call.
 */
export function createPatchedSectionReader(o: PatchedSectionOptions): {
	reader: RangeReader;
	/** The virtual section size (the indirect tree's end offset). */
	size: () => Promise<number>;
} {
	const crypto = o.crypto ?? globalThis.crypto;
	const info = readPatchInfo(o.fsHeader);

	/** The tables are stored with the plain section counter. */
	const plainBlob = (start: number, end: number): Blob =>
		rangeBlob((s, e) => ctrRange(o, start + s, start + e, null, crypto), end - start);

	const indirect = new BucketTreeReader({
		nodeStorage: plainBlob(info.indirectOffset, info.indirectOffset + NODE_SIZE),
		entryStorage: plainBlob(
			info.indirectOffset + NODE_SIZE,
			info.indirectOffset + info.indirectSize,
		),
		nodeSize: NODE_SIZE,
		entrySize: INDIRECT_ENTRY_SIZE,
		entryCount: info.indirectEntryCount,
	});
	const aesCtrEx = new BucketTreeReader({
		nodeStorage: plainBlob(info.aesCtrExOffset, info.aesCtrExOffset + NODE_SIZE),
		entryStorage: plainBlob(
			info.aesCtrExOffset + NODE_SIZE,
			info.aesCtrExOffset + info.aesCtrExSize,
		),
		nodeSize: NODE_SIZE,
		entrySize: AES_CTR_EX_ENTRY_SIZE,
		entryCount: info.aesCtrExEntryCount,
	});

	/** Read the patch section's own (physical) data, `[start, end)`. */
	const readPatch: RangeReader = async (start, end) => {
		const parts: Uint8Array[] = [];
		let pos = start;
		while (pos < end) {
			const hit = await aesCtrEx.find(BigInt(pos));
			if (!hit) {
				// Outside the AesCtrEx tree (the tables themselves, or
				// padding): ordinary section counter.
				parts.push(await ctrRange(o, pos, end, null, crypto));
				break;
			}
			const dv = new DataView(hit.entryBytes.buffer, hit.entryBytes.byteOffset);
			const notEncrypted = hit.entryBytes[8] === 1;
			const generation = dv.getUint32(12, true);
			const runEnd = Math.min(end, Number(hit.entryEnd));
			if (notEncrypted) {
				parts.push(
					new Uint8Array(
						await o.source
							.slice(o.sectionStart + pos, o.sectionStart + runEnd)
							.arrayBuffer(),
					),
				);
			} else {
				parts.push(await ctrRange(o, pos, runEnd, generation, crypto));
			}
			pos = runEnd;
		}
		return concat(parts, end - start);
	};

	const reader: RangeReader = async (start, end) => {
		const parts: Uint8Array[] = [];
		let pos = start;
		while (pos < end) {
			const hit = await indirect.find(BigInt(pos));
			if (!hit) {
				throw new Error(`BKTR: offset 0x${pos.toString(16)} is outside the indirect table`);
			}
			const dv = new DataView(hit.entryBytes.buffer, hit.entryBytes.byteOffset);
			const virt = Number(dv.getBigInt64(0, true));
			const phys = Number(dv.getBigInt64(8, true));
			const storage = dv.getInt32(16, true);
			const runEnd = Math.min(end, Number(hit.entryEnd));
			const src = phys + (pos - virt);
			const len = runEnd - pos;
			if (storage === 0) {
				parts.push(new Uint8Array(await o.base.slice(src, src + len).arrayBuffer()));
			} else if (storage === 1) {
				parts.push(await readPatch(src, src + len));
			} else {
				throw new Error(`BKTR: bad indirect storage index ${storage}`);
			}
			pos = runEnd;
		}
		return concat(parts, end - start);
	};

	return {
		reader,
		size: async () => Number((await indirect.getOffsets()).endOffset),
	};
}

/**
 * A lazy `Blob` facade over a {@link RangeReader}. `.slice()` returns
 * another facade, and reads only happen on `arrayBuffer()` and friends.
 */
export function rangeBlob(read: RangeReader, size: number, offset = 0): Blob {
	const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
	const all = () => read(offset, offset + size);
	const facade = {
		size,
		type: '',
		async arrayBuffer(): Promise<ArrayBuffer> {
			const u8 = await all();
			const ab = new ArrayBuffer(u8.byteLength);
			new Uint8Array(ab).set(u8);
			return ab;
		},
		async bytes(): Promise<Uint8Array> {
			return new Uint8Array(await all());
		},
		async text(): Promise<string> {
			return new TextDecoder().decode(await all());
		},
		slice(start?: number, end?: number): Blob {
			const s = clamp(start ?? 0, 0, size);
			const e = clamp(end ?? size, s, size);
			return rangeBlob(read, e - s, offset + s);
		},
		stream(): ReadableStream<Uint8Array> {
			const CHUNK = 256 * 1024;
			let pos = 0;
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (pos >= size) {
						controller.close();
						return;
					}
					const next = Math.min(pos + CHUNK, size);
					try {
						controller.enqueue(await read(offset + pos, offset + next));
						pos = next;
					} catch (err) {
						controller.error(err);
					}
				},
			});
		},
	};
	return facade as unknown as Blob;
}
