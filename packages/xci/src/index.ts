// Reference: https://switchbrew.org/wiki/XCI

import type { FileEntry } from '@tootallnate/hfs0';
import { parseHfs0 } from '@tootallnate/hfs0';

export type { FileEntry };

// XCI magic is "HEAD" at offset 0x100
const XCI_MAGIC = 0x48454144;
const XCI_MAGIC_OFFSET = 0x100;

// Root HFS0 partition is at offset 0xF000, or 0x10000 if a key area is prepended
const HFS0_ROOT_OFFSET = 0xf000;
const HFS0_ROOT_OFFSET_WITH_KEY_AREA = 0x10000;

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
	// Validate XCI magic at offset 0x100
	const magicBuf = await blob
		.slice(XCI_MAGIC_OFFSET, XCI_MAGIC_OFFSET + 4)
		.arrayBuffer();
	const magic = new DataView(magicBuf).getUint32(0, true);
	if (magic !== XCI_MAGIC) {
		throw new Error(
			`Not an XCI file (expected magic 0x${XCI_MAGIC.toString(16)}, got 0x${magic.toString(16)})`,
		);
	}

	// Try to find the root HFS0 partition.
	// First at the standard offset, then at the offset with key area prepended.
	let rootOffset = HFS0_ROOT_OFFSET;
	let root: Awaited<ReturnType<typeof parseHfs0>>;
	try {
		root = await parseHfs0(blob.slice(rootOffset));
	} catch {
		rootOffset = HFS0_ROOT_OFFSET_WITH_KEY_AREA;
		root = await parseHfs0(blob.slice(rootOffset));
	}

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
