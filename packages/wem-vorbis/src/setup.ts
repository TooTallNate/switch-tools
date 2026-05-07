/**
 * Setup-packet rebuilder for Wwise V62 Vorbis (Switch-era + most
 * 2018+ Wwise titles). The setup packet is the third Vorbis header
 * — it defines codebooks, floor/residue/mapping configurations, and
 * the mode list.
 *
 * In Wwise V62 the setup is heavily compacted:
 *   - The 8-bit "vorbis" magic prefix and 6-byte string are removed
 *     (we re-insert them).
 *   - The codebook count is followed by N × 10-bit codebook ids,
 *     each pointing into the external library; we look those up
 *     and rebuild full codebooks.
 *   - The 6-bit time-domain transform count is dropped (Vorbis
 *     spec requires it, but Vorbis ignores its value); we emit
 *     a placeholder `(time_count_less1=0, value=0)`.
 *   - Floor / residue / mapping / mode parsing is identical to the
 *     spec form, but with all values bit-for-bit identical to what
 *     gets read from the WEM. We pipe each field through, validating
 *     against codebook count etc. as a sanity check.
 *
 * The mode list is special: as we decode it, we collect each mode's
 * `block_flag` bit into `mode_blockflag[]`. When we later re-emit
 * audio packets, we use this array to look up window types for the
 * `_mod_packets` rebuild path.
 */

import { BitReader, BitWriter, ilog } from './bit-stream.js';
import { CodebookLibrary, copyInlineCodebook } from './codebook.js';

const VORBIS_STR = 'vorbis';
const VORBIS_STR_BYTES = new Uint8Array([0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // "vorbis"

/** Result of rebuilding the three Vorbis header packets. */
export interface RebuiltHeaders {
	/** The three header packets, ready to be muxed into Ogg pages. */
	identification: Uint8Array;
	comment: Uint8Array;
	setup: Uint8Array;
	/** Per-mode block flag, indexed by mode number. Used during audio rebuild. */
	modeBlockflag: boolean[];
	/** ilog(modeCount-1) — number of bits used to encode a mode index in audio packet headers. */
	modeBits: number;
}

/** Configuration extracted from the WEM that the rebuild needs. */
export interface VorbisRebuildConfig {
	channels: number;
	sampleRate: number;
	avgBytesPerSec: number;
	blocksize0Pow: number;
	blocksize1Pow: number;
	loopCount: number;
	loopStart: number;
	loopEnd: number;
	/** The compacted setup packet payload (no Wwise framing, just bits). */
	setupPacket: Uint8Array;
	/** External codebook library. */
	codebooks: CodebookLibrary;
	/** Whether the WEM uses the inline-codebooks variant (rare; Switch path is always external). */
	inlineCodebooks: boolean;
}

/** Build a Vorbis Identification packet. RFC §4.2.2. */
export function buildIdentificationPacket(cfg: VorbisRebuildConfig): Uint8Array {
	const bw = new BitWriter(64);
	// packet type = 1, then "vorbis"
	bw.writeUint(1, 8);
	for (const c of VORBIS_STR_BYTES) bw.writeUint(c, 8);
	bw.writeUint(0, 32); // version
	bw.writeUint(cfg.channels, 8);
	bw.writeUint(cfg.sampleRate, 32);
	bw.writeUint(0, 32); // bitrate_max
	bw.writeUint(cfg.avgBytesPerSec * 8, 32); // bitrate_nominal
	bw.writeUint(0, 32); // bitrate_min
	bw.writeUint(cfg.blocksize0Pow, 4);
	bw.writeUint(cfg.blocksize1Pow, 4);
	bw.writeBit(1); // framing
	bw.flushByte();
	return bw.toUint8Array().slice();
}

/** Build a Vorbis Comment packet. RFC §5. */
export function buildCommentPacket(cfg: VorbisRebuildConfig): Uint8Array {
	const bw = new BitWriter(128);
	bw.writeUint(3, 8); // packet type
	for (const c of VORBIS_STR_BYTES) bw.writeUint(c, 8);
	const vendor = '@tootallnate/wem-vorbis (port of ww2ogg)';
	const vendorBytes = new TextEncoder().encode(vendor);
	bw.writeUint(vendorBytes.length, 32);
	for (const b of vendorBytes) bw.writeUint(b, 8);
	if (cfg.loopCount === 0) {
		bw.writeUint(0, 32); // user_comment_count
	} else {
		bw.writeUint(2, 32);
		const ls = `LoopStart=${cfg.loopStart}`;
		const le = `LoopEnd=${cfg.loopEnd}`;
		const lsB = new TextEncoder().encode(ls);
		const leB = new TextEncoder().encode(le);
		bw.writeUint(lsB.length, 32);
		for (const b of lsB) bw.writeUint(b, 8);
		bw.writeUint(leB.length, 32);
		for (const b of leB) bw.writeUint(b, 8);
	}
	bw.writeBit(1); // framing
	bw.flushByte();
	return bw.toUint8Array().slice();
}

/**
 * Rebuild the Vorbis Setup packet from a Wwise V62 compact setup,
 * piping bits through. Returns the rebuilt setup payload plus the
 * `mode_blockflag` array that the audio rebuild needs.
 *
 * This is a direct port of `Wwise_RIFF_Vorbis::generate_ogg_header`
 * (the `_full_setup == false`, `_inline_codebooks == false` branch
 * is the Switch path, but we keep the inline branch for parity).
 */
export function rebuildSetupPacket(cfg: VorbisRebuildConfig): {
	setup: Uint8Array;
	modeBlockflag: boolean[];
	modeBits: number;
} {
	const br = new BitReader(cfg.setupPacket);
	const bw = new BitWriter(8192);

	// "vorbis" packet header (type 5)
	bw.writeUint(5, 8);
	for (const c of VORBIS_STR_BYTES) bw.writeUint(c, 8);

	// Codebook count (8 bits, "less 1").
	const codebookCountLess1 = br.readUint(8);
	const codebookCount = codebookCountLess1 + 1;
	bw.writeUint(codebookCountLess1, 8);

	// Rebuild codebooks.
	if (cfg.inlineCodebooks) {
		// Each codebook is laid out as a compact codebook with no
		// per-codebook size (we let the rebuilder consume bits).
		for (let i = 0; i < codebookCount; i++) {
			// `--full-setup` mode would call `copyInlineCodebook` here;
			// we don't ship that path. Inline-non-full is rare.
			copyInlineCodebook(br, bw);
		}
	} else {
		for (let i = 0; i < codebookCount; i++) {
			const codebookId = br.readUint(10);
			cfg.codebooks.rebuild(codebookId, bw);
		}
	}

	// Time domain transforms (placeholder).
	bw.writeUint(0, 6); // time_count_less1 = 0
	bw.writeUint(0, 16); // dummy time value

	// Floor count (6 bits, "less 1").
	const floorCountLess1 = br.readUint(6);
	const floorCount = floorCountLess1 + 1;
	bw.writeUint(floorCountLess1, 6);

	for (let i = 0; i < floorCount; i++) {
		// floor type (always 1).
		bw.writeUint(1, 16);
		const floor1Partitions = br.readUint(5);
		bw.writeUint(floor1Partitions, 5);
		const partitionClassList = new Array<number>(floor1Partitions);
		let maxClass = 0;
		for (let j = 0; j < floor1Partitions; j++) {
			const cls = br.readUint(4);
			bw.writeUint(cls, 4);
			partitionClassList[j] = cls;
			if (cls > maxClass) maxClass = cls;
		}
		const classDimensionsList = new Array<number>(maxClass + 1);
		for (let j = 0; j <= maxClass; j++) {
			const classDimensionsLess1 = br.readUint(3);
			bw.writeUint(classDimensionsLess1, 3);
			classDimensionsList[j] = classDimensionsLess1 + 1;
			const classSubclasses = br.readUint(2);
			bw.writeUint(classSubclasses, 2);
			if (classSubclasses !== 0) {
				const masterbook = br.readUint(8);
				bw.writeUint(masterbook, 8);
				if (masterbook >= codebookCount) throw new Error('invalid floor1 masterbook');
			}
			for (let k = 0; k < 1 << classSubclasses; k++) {
				const subclassBookPlus1 = br.readUint(8);
				bw.writeUint(subclassBookPlus1, 8);
				const subclassBook = subclassBookPlus1 - 1;
				if (subclassBook >= 0 && subclassBook >= codebookCount) {
					throw new Error('invalid floor1 subclass book');
				}
			}
		}
		const floor1MultiplierLess1 = br.readUint(2);
		bw.writeUint(floor1MultiplierLess1, 2);
		const rangebits = br.readUint(4);
		bw.writeUint(rangebits, 4);
		for (let j = 0; j < floor1Partitions; j++) {
			const cls = partitionClassList[j];
			for (let k = 0; k < classDimensionsList[cls]; k++) {
				const x = br.readUint(rangebits);
				bw.writeUint(x, rangebits);
			}
		}
	}

	// Residue count.
	const residueCountLess1 = br.readUint(6);
	const residueCount = residueCountLess1 + 1;
	bw.writeUint(residueCountLess1, 6);

	for (let i = 0; i < residueCount; i++) {
		const residueType = br.readUint(2);
		bw.writeUint(residueType, 16);
		if (residueType > 2) throw new Error('invalid residue type');
		const residueBegin = br.readUint(24);
		const residueEnd = br.readUint(24);
		const residuePartitionSizeLess1 = br.readUint(24);
		const residueClassificationsLess1 = br.readUint(6);
		const residueClassbook = br.readUint(8);
		const residueClassifications = residueClassificationsLess1 + 1;
		bw.writeUint(residueBegin, 24);
		bw.writeUint(residueEnd, 24);
		bw.writeUint(residuePartitionSizeLess1, 24);
		bw.writeUint(residueClassificationsLess1, 6);
		bw.writeUint(residueClassbook, 8);
		if (residueClassbook >= codebookCount) throw new Error('invalid residue classbook');

		const residueCascade = new Array<number>(residueClassifications);
		for (let j = 0; j < residueClassifications; j++) {
			let highBits = 0;
			const lowBits = br.readUint(3);
			bw.writeUint(lowBits, 3);
			const bitflag = br.readBit();
			bw.writeBit(bitflag);
			if (bitflag) {
				highBits = br.readUint(5);
				bw.writeUint(highBits, 5);
			}
			residueCascade[j] = highBits * 8 + lowBits;
		}
		for (let j = 0; j < residueClassifications; j++) {
			for (let k = 0; k < 8; k++) {
				if (residueCascade[j] & (1 << k)) {
					const residueBook = br.readUint(8);
					bw.writeUint(residueBook, 8);
					if (residueBook >= codebookCount) throw new Error('invalid residue book');
				}
			}
		}
	}

	// Mapping count.
	const mappingCountLess1 = br.readUint(6);
	const mappingCount = mappingCountLess1 + 1;
	bw.writeUint(mappingCountLess1, 6);
	for (let i = 0; i < mappingCount; i++) {
		// Always mapping type 0.
		bw.writeUint(0, 16);
		const submapsFlag = br.readBit();
		bw.writeBit(submapsFlag);
		let submaps = 1;
		if (submapsFlag) {
			const submapsLess1 = br.readUint(4);
			submaps = submapsLess1 + 1;
			bw.writeUint(submapsLess1, 4);
		}
		const squarePolarFlag = br.readBit();
		bw.writeBit(squarePolarFlag);
		if (squarePolarFlag) {
			const couplingStepsLess1 = br.readUint(8);
			const couplingSteps = couplingStepsLess1 + 1;
			bw.writeUint(couplingStepsLess1, 8);
			for (let j = 0; j < couplingSteps; j++) {
				const w = ilog(cfg.channels - 1);
				const magnitude = br.readUint(w);
				const angle = br.readUint(w);
				bw.writeUint(magnitude, w);
				bw.writeUint(angle, w);
				if (angle === magnitude || magnitude >= cfg.channels || angle >= cfg.channels) {
					throw new Error('invalid coupling');
				}
			}
		}
		// Reserved 2 bits.
		const mappingReserved = br.readUint(2);
		bw.writeUint(mappingReserved, 2);
		if (mappingReserved !== 0) throw new Error('mapping reserved nonzero');

		if (submaps > 1) {
			for (let j = 0; j < cfg.channels; j++) {
				const mappingMux = br.readUint(4);
				bw.writeUint(mappingMux, 4);
				if (mappingMux >= submaps) throw new Error('mapping_mux >= submaps');
			}
		}
		for (let j = 0; j < submaps; j++) {
			const timeConfig = br.readUint(8);
			bw.writeUint(timeConfig, 8);
			const floorNumber = br.readUint(8);
			bw.writeUint(floorNumber, 8);
			if (floorNumber >= floorCount) throw new Error('invalid floor mapping');
			const residueNumber = br.readUint(8);
			bw.writeUint(residueNumber, 8);
			if (residueNumber >= residueCount) throw new Error('invalid residue mapping');
		}
	}

	// Mode count.
	const modeCountLess1 = br.readUint(6);
	const modeCount = modeCountLess1 + 1;
	bw.writeUint(modeCountLess1, 6);
	const modeBlockflag = new Array<boolean>(modeCount);
	const modeBits = ilog(modeCount - 1);
	for (let i = 0; i < modeCount; i++) {
		const blockFlag = br.readBit();
		bw.writeBit(blockFlag);
		modeBlockflag[i] = blockFlag !== 0;
		// windowtype, transformtype: only 0 valid.
		bw.writeUint(0, 16);
		bw.writeUint(0, 16);
		const mapping = br.readUint(8);
		bw.writeUint(mapping, 8);
		if (mapping >= mappingCount) throw new Error('invalid mode mapping');
	}

	// Framing bit.
	bw.writeBit(1);
	bw.flushByte();
	const setup = bw.toUint8Array().slice();

	// Sanity: setup packet should be fully consumed, modulo trailing
	// padding to a byte boundary. ww2ogg checks `(bits_read+7)/8 == size`.
	const bitsRead = br.totalBitsRead;
	const expected = cfg.setupPacket.length;
	const actual = (bitsRead + 7) >>> 3;
	if (actual !== expected) {
		throw new Error(
			`setup packet not exactly consumed (${actual}/${expected} bytes)`,
		);
	}

	return { setup, modeBlockflag, modeBits };
}

/** Build all three Vorbis headers in one shot. */
export function buildAllHeaders(cfg: VorbisRebuildConfig): RebuiltHeaders {
	const identification = buildIdentificationPacket(cfg);
	const comment = buildCommentPacket(cfg);
	const { setup, modeBlockflag, modeBits } = rebuildSetupPacket(cfg);
	return { identification, comment, setup, modeBlockflag, modeBits };
}

void VORBIS_STR; // exported for documentation; mark used
