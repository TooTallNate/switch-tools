/**
 * RIFF chunk walker for FMOD Studio bank files.
 *
 * Banks have form-type `"FEV "` at offset 8. Top-level chunks
 * include:
 *   - "FMT " (8 bytes) — format magic, version
 *   - "LIST" — project metadata, contains form-type at +0
 *   - "SNDH" (12 bytes) — flags + (u32 offset, u32 size) pointing
 *     into the SND chunk for the encrypted FSB5 region
 *   - "STDT", "STBL", "HASH", "DEL ", "MUTE", "REFI", "PLAT" — misc
 *     metadata, often empty (size=0)
 *   - "SND " — the embedded FSB5 (with optional XOR encryption)
 *
 * Inside LIST chunks the contained chunks have IDs like `BSSL`
 * (Bus list), `GBSS`, `RBSS`, `MBSS`, `BEFX`, `PEFX`, `SEFX`,
 * `SCFX`, `VCAS`, `EVTS`, `TLNS`, `PMLS`, `PRMS`, `CTRS`, `CRVS`,
 * `MPGS`, `MUIS`, `SPIS`, `PRIS`, `EVIS`, `WAIS`, `EFIS`, `CMDS`,
 * `SLNS`, `LWVS`, `WAVS`, `SNAS`, `MODS`. Most are short (often
 * just 4 bytes — only the form-type ID, no content). We surface
 * the full LIST tree as nested `BankChunk`s for UIs that want to
 * display the bank's structure.
 */

export const BANK_RIFF_MAGIC = 'RIFF';
export const BANK_FORM_TYPE = 'FEV ';

/** A single chunk within a Bank. LIST chunks recurse via `children`. */
export interface BankChunk {
	/** 4-char chunk ID. */
	id: string;
	/** Absolute byte offset of the chunk header (id + size pair) in the source `Blob`. */
	offset: number;
	/** Size of the chunk's payload (does not include the 8-byte header). */
	size: number;
	/** For LIST chunks: the 4-char form-type at the start of the payload. */
	listFormType?: string;
	/** For LIST chunks: nested chunks. Empty for non-LIST chunks. */
	children: BankChunk[];
	/** Lazy `Blob` slice covering the payload (full payload, including the LIST form-type). */
	data: Blob;
}

export interface ParsedFmodBank {
	/** Total size as declared by the RIFF size field (often slightly off due to padding — accept anyway). */
	declaredSize: number;
	/** Form-type at offset 8 (always `"FEV "` for bank files). */
	formType: string;
	/** Top-level chunks. */
	chunks: BankChunk[];
	/** Convenience: the SND chunk if present (may be null for Master/strings banks). */
	sndChunk: BankChunk | null;
	/** Convenience: parsed SNDH metadata if present. */
	sndh: SndhInfo | null;
}

export interface SndhInfo {
	/** First u32 of SNDH payload (flags / version). */
	flags: number;
	/** Offset of FSB5 within the SND chunk's payload (or absolute file offset, depending on bank). */
	fsbOffset: number;
	/** Declared size of the FSB5 region. */
	fsbSize: number;
}

/** Cheap (12-byte) magic check. */
export async function isFmodBank(blob: Blob): Promise<boolean> {
	if (blob.size < 12) return false;
	const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	const riff =
		head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
	const fev =
		head[8] === 0x46 && head[9] === 0x45 && head[10] === 0x56 && head[11] === 0x20;
	return riff && fev;
}

/**
 * Parse an FMOD Bank RIFF tree. Recursively walks LIST chunks so
 * the full project-metadata structure is visible. Each chunk's
 * payload is exposed as a lazy `Blob` slice; nothing past the
 * chunk-header tables is materialised eagerly.
 */
export async function parseFmodBank(blob: Blob): Promise<ParsedFmodBank> {
	if (blob.size < 12) {
		throw new Error(`Blob too small to be an FMOD Bank (${blob.size} bytes)`);
	}
	const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	if (head[0] !== 0x52 || head[1] !== 0x49 || head[2] !== 0x46 || head[3] !== 0x46) {
		throw new Error('Bad RIFF magic — not an FMOD Bank');
	}
	const formType = String.fromCharCode(head[8], head[9], head[10], head[11]);
	if (formType !== BANK_FORM_TYPE) {
		throw new Error(`Bad FMOD Bank form-type "${formType}" (expected "${BANK_FORM_TYPE}")`);
	}
	const declaredSize = new DataView(head.buffer, head.byteOffset).getUint32(4, true);

	const chunks = await walkChunks(blob, 12, blob.size);
	// SND is always top-level (just before EOF). SNDH may be nested inside
	// LIST(PROJ) — search recursively.
	const sndChunk = chunks.find((c) => c.id === 'SND ') ?? null;
	const sndhChunk = findChunk(chunks, 'SNDH');

	let sndh: SndhInfo | null = null;
	if (sndhChunk && sndhChunk.size >= 12) {
		const sndhBytes = new Uint8Array(await sndhChunk.data.slice(0, 12).arrayBuffer());
		const dv = new DataView(sndhBytes.buffer, sndhBytes.byteOffset, sndhBytes.byteLength);
		sndh = {
			flags: dv.getUint32(0, true),
			fsbOffset: dv.getUint32(4, true),
			fsbSize: dv.getUint32(8, true),
		};
	}

	return { declaredSize, formType, chunks, sndChunk, sndh };
}

/** DFS for the first chunk with the given ID (anywhere in the tree). */
function findChunk(chunks: BankChunk[], id: string): BankChunk | null {
	for (const c of chunks) {
		if (c.id === id) return c;
		if (c.children.length > 0) {
			const inner = findChunk(c.children, id);
			if (inner) return inner;
		}
	}
	return null;
}

/** Walk RIFF chunks in `[start, end)`. Used both for top-level + LIST recursion. */
async function walkChunks(blob: Blob, start: number, end: number): Promise<BankChunk[]> {
	const chunks: BankChunk[] = [];
	let off = start;
	while (off + 8 <= end) {
		const hdr = new Uint8Array(await blob.slice(off, off + 8).arrayBuffer());
		const id = String.fromCharCode(hdr[0], hdr[1], hdr[2], hdr[3]);
		// Sanity: chunk IDs must be ASCII printable.
		let ok = true;
		for (let i = 0; i < 4; i++) if (hdr[i] < 0x20 || hdr[i] > 0x7e) ok = false;
		if (!ok) break;
		const size = new DataView(hdr.buffer, hdr.byteOffset).getUint32(4, true);
		const payloadStart = off + 8;
		const payloadEnd = Math.min(end, payloadStart + size);
		const data = blob.slice(payloadStart, payloadEnd);

		const chunk: BankChunk = {
			id,
			offset: off,
			size,
			children: [],
			data,
		};

		if (id === 'LIST' && size >= 4) {
			const formBytes = new Uint8Array(await blob.slice(payloadStart, payloadStart + 4).arrayBuffer());
			chunk.listFormType = String.fromCharCode(...formBytes);
			// Recurse into LIST contents.
			if (size > 4) {
				chunk.children = await walkChunks(blob, payloadStart + 4, payloadEnd);
			}
		}

		chunks.push(chunk);
		off = payloadStart + size;
		// Bank chunks are byte-aligned (no even-padding like real RIFF).
		if (off > end) break;
	}
	return chunks;
}
