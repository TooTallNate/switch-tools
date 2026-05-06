/**
 * Cross-API folder traversal.
 *
 * Browsers expose three different ways to read a user-selected
 * directory:
 *
 *   1. `showDirectoryPicker()` (File System Access API — Chromium-only)
 *      → returns a `FileSystemDirectoryHandle` you walk recursively.
 *
 *   2. `<input type="file" webkitdirectory>` (legacy, broadly supported)
 *      → returns a `FileList` where each entry has `webkitRelativePath`.
 *
 *   3. Drag-and-drop of a folder
 *      → `DataTransferItem.webkitGetAsEntry()` returns a (recursive)
 *      `FileSystemEntry` you walk via callbacks.
 *
 * This module flattens all three into a single synchronous-iteration-
 * friendly shape: `WalkedFolder { name, files: { relativePath, file }[] }`.
 *
 * Empty-directory entries are dropped — only files reach the consumer.
 *
 * Files are kept as real `File`s so consumers can use the standard
 * `Blob.slice()` interface for lazy reads (a 7 GB XCI never gets loaded
 * into memory).
 */

export interface WalkedFile {
	/** Path relative to the chosen root, using forward slashes. */
	relativePath: string;
	file: File;
}

export interface WalkedFolder {
	/** Display name of the chosen root folder. */
	name: string;
	files: WalkedFile[];
}

// ---------- File System Access API (Chromium) ----------

/** Returns true when {@link showDirectoryPicker} is available. */
export function isDirectoryPickerSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof (
			window as Window &
				typeof globalThis & {
					showDirectoryPicker?: () => unknown;
				}
		).showDirectoryPicker === 'function'
	);
}

interface DirectoryPickerWindow {
	showDirectoryPicker?: (options?: {
		mode?: 'read' | 'readwrite';
	}) => Promise<FileSystemDirectoryHandle>;
}

/**
 * Prompt the user for a directory using the File System Access API.
 * Throws if the user cancels or the API isn't available.
 */
export async function pickDirectoryViaHandle(): Promise<WalkedFolder> {
	const w = window as DirectoryPickerWindow;
	if (!w.showDirectoryPicker) {
		throw new Error('Directory picker is not supported in this browser.');
	}
	const handle = await w.showDirectoryPicker({ mode: 'read' });
	return walkDirectoryHandle(handle);
}

async function walkDirectoryHandle(
	root: FileSystemDirectoryHandle,
): Promise<WalkedFolder> {
	const files: WalkedFile[] = [];
	await walkDirHandleInto(root, '', files);
	return { name: root.name, files };
}

async function walkDirHandleInto(
	dir: FileSystemDirectoryHandle,
	prefix: string,
	out: WalkedFile[],
): Promise<void> {
	// `entries()` is async-iterable on FileSystemDirectoryHandle. The
	// types lib unfortunately doesn't expose it everywhere; cast to a
	// minimal shape we know works.
	const dirAny = dir as unknown as {
		entries(): AsyncIterableIterator<
			[string, FileSystemDirectoryHandle | FileSystemFileHandle]
		>;
	};
	for await (const [name, entry] of dirAny.entries()) {
		const rel = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file') {
			const file = await (entry as FileSystemFileHandle).getFile();
			out.push({ relativePath: rel, file });
		} else if (entry.kind === 'directory') {
			await walkDirHandleInto(
				entry as FileSystemDirectoryHandle,
				rel,
				out,
			);
		}
	}
}

// ---------- `<input type="file" webkitdirectory>` ----------

/**
 * Convert a `FileList` produced by an `<input webkitdirectory>` into
 * a `WalkedFolder`. The list's `webkitRelativePath` strings start with
 * the chosen folder's name; we strip that to use as `name`.
 */
export function walkedFolderFromFileList(list: FileList): WalkedFolder {
	const files: WalkedFile[] = [];
	let rootName = '';
	for (let i = 0; i < list.length; i++) {
		const f = list.item(i);
		if (!f) continue;
		// Cast to the augmented type — `webkitRelativePath` isn't in DOM lib.
		const rel = (f as File & { webkitRelativePath?: string })
			.webkitRelativePath;
		if (!rel) {
			files.push({ relativePath: f.name, file: f });
			continue;
		}
		// "MyFolder/sub/file.txt" → root = "MyFolder", rest = "sub/file.txt"
		const slash = rel.indexOf('/');
		if (slash < 0) {
			files.push({ relativePath: rel, file: f });
			continue;
		}
		if (!rootName) rootName = rel.slice(0, slash);
		files.push({ relativePath: rel.slice(slash + 1), file: f });
	}
	return { name: rootName || 'folder', files };
}

// ---------- Drag-and-drop (DataTransfer with directory entries) ----------

/**
 * Returns true if any of the given `DataTransferItem`s looks like a
 * directory entry. Used to choose between single-file and folder
 * handling on drop.
 */
export function dataTransferContainsDirectory(
	items: DataTransferItemList,
): boolean {
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.kind !== 'file') continue;
		const entry = (
			item as DataTransferItem & {
				webkitGetAsEntry?: () => FileSystemEntry | null;
			}
		).webkitGetAsEntry?.();
		if (entry?.isDirectory) return true;
	}
	return false;
}

/**
 * Walk every directory among the dropped items into a single
 * `WalkedFolder`. If multiple folders were dropped, they're merged
 * under their original names; loose files dropped alongside go into
 * the top level.
 */
export async function walkedFolderFromDataTransfer(
	items: DataTransferItemList,
): Promise<WalkedFolder> {
	const out: WalkedFile[] = [];
	const roots: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.kind !== 'file') continue;
		const entry = (
			item as DataTransferItem & {
				webkitGetAsEntry?: () => FileSystemEntry | null;
			}
		).webkitGetAsEntry?.();
		if (!entry) continue;
		if (entry.isDirectory) {
			roots.push(entry.name);
			await walkEntryInto(entry as FileSystemDirectoryEntry, '', out);
		} else if (entry.isFile) {
			const file = await fileFromEntry(entry as FileSystemFileEntry);
			out.push({ relativePath: file.name, file });
		}
	}
	const name = roots.length === 1 ? roots[0] : 'dropped folder';
	return { name, files: out };
}

async function walkEntryInto(
	dir: FileSystemDirectoryEntry,
	prefix: string,
	out: WalkedFile[],
): Promise<void> {
	const reader = dir.createReader();
	// `readEntries` returns batches; loop until empty.
	for (;;) {
		const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
		if (!batch.length) break;
		for (const entry of batch) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory) {
				await walkEntryInto(entry as FileSystemDirectoryEntry, rel, out);
			} else if (entry.isFile) {
				const file = await fileFromEntry(entry as FileSystemFileEntry);
				out.push({ relativePath: rel, file });
			}
		}
	}
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}
