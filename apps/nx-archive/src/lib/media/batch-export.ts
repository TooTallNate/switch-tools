/**
 * Export many library models at once: load each headlessly in its rest
 * / idle pose, run the same STL / 3MF pipeline as the viewer's Export
 * dialog, and bundle the results into one ZIP. Every model shares the
 * opened file's print scale, so characters stay proportional.
 */

import { zipSync } from 'fflate';

import { loadSettings } from '~/components/mesh-export-bar';

import type { Node } from '../archive';
import { sanitizeStem } from '../mesh-export';
import { runModelExport, type ExportFormat } from '../model-export';
import { defaultPrintScale, loadPrintScale, savePrintScale } from '../print-scale';
import { findNodeById } from '../unity-external';
import { canLoadModelHeadless, loadModelAsset, modelAssetToExportMeshes } from './model-assets';
import type { MediaItem, ScanProblem } from './types';

export interface BatchExportResult {
	zip: Uint8Array;
	exported: number;
	failed: ScanProblem[];
}

function maxDimension(positions: Float32Array): number {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < positions.length; i += 3) {
		for (let k = 0; k < 3; k++) {
			const v = positions[i + k]!;
			if (v < min[k]!) min[k] = v;
			if (v > max[k]!) max[k] = v;
		}
	}
	return Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}

export function exportableModels(items: MediaItem[]): MediaItem[] {
	return items.filter((i) => i.kind === 'model' && !i.partOf && canLoadModelHeadless(i.previewKind));
}

export async function exportModelsZip(
	items: MediaItem[],
	root: Node,
	opts: {
		format: ExportFormat;
		/** Print-scale scope (the opened file). */
		scopeKey: string;
		onProgress?: (done: number, total: number, current: string) => void;
		signal?: AbortSignal;
	},
): Promise<BatchExportResult> {
	const settings = { ...loadSettings(), subdivision: 0, format: opts.format };
	const files: Record<string, Uint8Array> = {};
	const failed: ScanProblem[] = [];
	let mmPerUnit = loadPrintScale(opts.scopeKey);
	const used = new Set<string>();
	let done = 0;
	for (const item of items) {
		if (opts.signal?.aborted) break;
		opts.onProgress?.(done, items.length, item.title);
		await new Promise((r) => setTimeout(r, 0));
		try {
			const node = await findNodeById(root, item.id);
			if (!node) throw new Error('File not found in the tree');
			const asset = await loadModelAsset(node, item.previewKind, root);
			const meshes = modelAssetToExportMeshes(asset);
			if (!meshes.length) throw new Error('No geometry');
			if (mmPerUnit === null) {
				// First model sets the shared scale for the whole file.
				mmPerUnit = defaultPrintScale([maxDimension(meshes[0]!.positions)]);
				savePrintScale(opts.scopeKey, mmPerUnit);
			}
			const r = runModelExport({
				meshes,
				settings,
				mmPerUnit,
				sourceAxis: 'y-up',
				stem: sanitizeStem(item.title) || 'model',
				pose: asset.pose ? `_${sanitizeStem(asset.pose)}` : '',
			});
			let name = r.fileName;
			for (let n = 2; used.has(name); n++) name = r.fileName.replace(/(\.[^.]+)$/, `_${n}$1`);
			used.add(name);
			files[name] = r.bytes;
		} catch (err) {
			failed.push({ path: item.path, message: err instanceof Error ? err.message : String(err) });
		}
		done++;
	}
	opts.onProgress?.(done, items.length, '');
	// STL compresses well; 3MF is already a ZIP.
	const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: k.endsWith('.stl') ? 6 : 0 }]])));
	return { zip, exported: Object.keys(files).length, failed };
}
