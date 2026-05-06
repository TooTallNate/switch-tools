// Reference: https://switchbrew.org/wiki/XCI

import type { FileEntry } from '@tootallnate/hfs0';
import { parseHfs0 } from '@tootallnate/hfs0';

export type { FileEntry };

// XCI CardHeader magic is the four bytes "HEAD" (0x48 0x45 0x41 0x44).
// Reading those four bytes as a big-endian u32 gives 0x48454144.
const XCI_MAGIC = 0x48454144;

/**
 * The XCI CardHeader can live at two offsets depending on whether the
 * 0x1000-byte CardKeyArea is present:
 *
 * - "Trimmed" XCI (most distributed dumps have the key area stripped):
 *     CardHeader at offset 0x000  →  magic at 0x100
 *     Root HFS0 partition at      0x0F000
 *
 * - "Full" XCI (raw cartridge dump including CardKeyArea):
 *     CardHeader at offset 0x1000 →  magic at 0x1100
 *     Root HFS0 partition at      0x10000
 *
 * The two layouts are 0x1000 bytes apart. We detect by probing for the
 * "HEAD" magic at the trimmed location first (most common) and fall back
 * to the full-image location.
 */
interface XciLayout {
	headerOffset: number;
	hfs0RootOffset: number;
}

const XCI_LAYOUTS: XciLayout[] = [
	{ headerOffset: 0x100, hfs0RootOffset: 0x0f000 },
	{ headerOffset: 0x1100, hfs0RootOffset: 0x10000 },
];

export interface Partition {
	name: string;
	files: Map<string, FileEntry>;
}

export interface XciContents {
	partitions: Partition[];
	/** Files from the "secure" partition (the one containing NCAs). */
	files: Map<string, FileEntry>;
}

/**
 * Parses an XCI (GameCard Image) file from a `Blob`.
 *
 * Returns the parsed partition information and a convenience `files` map
 * containing the contents of the "secure" partition (where NCAs live).
 *
 * @param blob The XCI file as a `Blob`.
 */
export async function parseXci(blob: Blob): Promise<XciContents> {
	// Probe for the CardHeader magic ("HEAD") at each of the known offsets.
	let layout: XciLayout | null = null;
	let firstSeenMagic = 0;
	for (const candidate of XCI_LAYOUTS) {
		if (blob.size < candidate.headerOffset + 4) continue;
		const magicBuf = await blob
			.slice(candidate.headerOffset, candidate.headerOffset + 4)
			.arrayBuffer();
		// Read as big-endian: the on-disk bytes are "H" "E" "A" "D" in order,
		// which is the natural BE encoding of 0x48454144.
		const magic = new DataView(magicBuf).getUint32(0, false);
		if (candidate.headerOffset === 0x100) firstSeenMagic = magic;
		if (magic === XCI_MAGIC) {
			layout = candidate;
			break;
		}
	}

	if (!layout) {
		throw new Error(
			`Not an XCI file (expected magic 0x${XCI_MAGIC.toString(16)} ("HEAD") at offset 0x100 or 0x1100, got 0x${firstSeenMagic.toString(16)})`,
		);
	}

	// Parse the root HFS0 partition that points to the sub-partitions.
	const root = await parseHfs0(blob.slice(layout.hfs0RootOffset));

	// Each file in the root HFS0 is a sub-partition (update, normal, secure, logo).
	// Parse each sub-partition as its own HFS0.
	const partitions: Partition[] = [];
	let secureFiles: Map<string, FileEntry> | undefined;

	for (const [name, entry] of root.files) {
		const partitionBlob = entry.data;
		const partition = await parseHfs0(partitionBlob);
		partitions.push({ name, files: partition.files });
		if (name === 'secure') {
			secureFiles = partition.files;
		}
	}

	if (!secureFiles) {
		throw new Error('XCI does not contain a "secure" partition');
	}

	return {
		partitions,
		files: secureFiles,
	};
}
