import { describe, expect, it } from 'vitest';
import {
	UtfStorage,
	UtfType,
	parseUtf,
} from '../src/utf.js';
import {
	CueWaveformSource,
	cueNamesForAwb,
	parseAcb,
	type ParsedAcb,
} from '../src/index.js';
import { buildUtfForTesting } from './fixture.js';

/**
 * Build a synthetic ACB byte buffer with the minimum schema needed
 * to exercise {@link parseAcb}:
 *
 *   - Top-level row with `Name` + 3 nested-table cells
 *     (CueTable, CueNameTable, WaveformTable) plus optional
 *     `StreamAwbHash`.
 *   - Inner CueTable rows: ReferenceType=1 + ReferenceIndex.
 *   - Inner CueNameTable rows: CueIndex + CueName.
 *   - Inner WaveformTable rows: Streaming, MemoryAwbId, StreamAwbId, StreamAwbPortNo.
 */
function buildAcb(cues: Array<{
	name: string;
	awbTrackId: number;
	source: 'memory' | 'stream';
	streamAwbPortNo?: number;
}>): Uint8Array {
	const cueTable = buildUtfForTesting(
		'CueTable',
		[
			{ name: 'ReferenceType', type: UtfType.U8, storage: UtfStorage.PerRow },
			{ name: 'ReferenceIndex', type: UtfType.U16, storage: UtfStorage.PerRow },
		],
		cues.map((_, i) => ({ ReferenceType: 1, ReferenceIndex: i })),
	);
	const cueNameTable = buildUtfForTesting(
		'CueNameTable',
		[
			{ name: 'CueName', type: UtfType.String, storage: UtfStorage.PerRow },
			{ name: 'CueIndex', type: UtfType.U16, storage: UtfStorage.PerRow },
		],
		cues.map((c, i) => ({ CueName: c.name, CueIndex: i })),
	);
	const waveformTable = buildUtfForTesting(
		'WaveformTable',
		[
			{ name: 'Streaming', type: UtfType.U8, storage: UtfStorage.PerRow },
			{ name: 'MemoryAwbId', type: UtfType.U16, storage: UtfStorage.PerRow },
			{ name: 'StreamAwbId', type: UtfType.U16, storage: UtfStorage.PerRow },
			{ name: 'StreamAwbPortNo', type: UtfType.U16, storage: UtfStorage.PerRow },
		],
		cues.map((c) => ({
			Streaming: c.source === 'memory' ? 0 : 1,
			MemoryAwbId: c.source === 'memory' ? c.awbTrackId : 0,
			StreamAwbId: c.source === 'stream' ? c.awbTrackId : 0,
			StreamAwbPortNo: c.streamAwbPortNo ?? 0,
		})),
	);
	return buildUtfForTesting(
		'Header',
		[
			{ name: 'Name', type: UtfType.String, storage: UtfStorage.PerRow },
			{ name: 'CueTable', type: UtfType.Bytes, storage: UtfStorage.PerRow },
			{ name: 'CueNameTable', type: UtfType.Bytes, storage: UtfStorage.PerRow },
			{ name: 'WaveformTable', type: UtfType.Bytes, storage: UtfStorage.PerRow },
		],
		[
			{
				Name: 'BGM',
				CueTable: cueTable,
				CueNameTable: cueNameTable,
				WaveformTable: waveformTable,
			},
		],
	);
}

describe('parseAcb', () => {
	it('resolves memory cues to their AWB track ids', () => {
		const bytes = buildAcb([
			{ name: 'Boss_Theme', awbTrackId: 7, source: 'memory' },
			{ name: 'Menu_Confirm', awbTrackId: 12, source: 'memory' },
		]);
		const acb = parseAcb(bytes);
		expect(acb.name).toBe('BGM');
		expect(acb.cues).toHaveLength(2);
		expect(acb.cues[0]).toMatchObject({
			cueIndex: 0,
			name: 'Boss_Theme',
			source: CueWaveformSource.Memory,
			awbTrackId: 7,
			streamAwbPortNo: null,
		});
		expect(acb.cues[1]).toMatchObject({
			cueIndex: 1,
			name: 'Menu_Confirm',
			source: CueWaveformSource.Memory,
			awbTrackId: 12,
		});
	});

	it('resolves stream cues with their port number', () => {
		const bytes = buildAcb([
			{ name: 'Stream_Foo', awbTrackId: 3, source: 'stream', streamAwbPortNo: 0 },
			{ name: 'Stream_Bar', awbTrackId: 4, source: 'stream', streamAwbPortNo: 1 },
		]);
		const acb = parseAcb(bytes);
		expect(acb.cues[0]).toMatchObject({
			name: 'Stream_Foo',
			source: CueWaveformSource.Stream,
			awbTrackId: 3,
			streamAwbPortNo: 0,
		});
		expect(acb.cues[1]).toMatchObject({
			name: 'Stream_Bar',
			source: CueWaveformSource.Stream,
			awbTrackId: 4,
			streamAwbPortNo: 1,
		});
	});

	it('cueNamesForAwb maps memory track ids to names', () => {
		const bytes = buildAcb([
			{ name: 'A', awbTrackId: 0, source: 'memory' },
			{ name: 'B', awbTrackId: 1, source: 'memory' },
			{ name: 'C', awbTrackId: 2, source: 'memory' },
		]);
		const acb = parseAcb(bytes);
		const map = cueNamesForAwb(acb, CueWaveformSource.Memory);
		expect(map.get(0)).toBe('A');
		expect(map.get(1)).toBe('B');
		expect(map.get(2)).toBe('C');
		expect(map.size).toBe(3);
	});

	it('cueNamesForAwb filters by streamAwbPortNo for stream cues', () => {
		const bytes = buildAcb([
			{ name: 'PortA_0', awbTrackId: 0, source: 'stream', streamAwbPortNo: 0 },
			{ name: 'PortA_1', awbTrackId: 1, source: 'stream', streamAwbPortNo: 0 },
			{ name: 'PortB_0', awbTrackId: 0, source: 'stream', streamAwbPortNo: 1 },
		]);
		const acb = parseAcb(bytes);
		const port0 = cueNamesForAwb(acb, CueWaveformSource.Stream, 0);
		expect(port0.get(0)).toBe('PortA_0');
		expect(port0.get(1)).toBe('PortA_1');
		expect(port0.size).toBe(2);
		const port1 = cueNamesForAwb(acb, CueWaveformSource.Stream, 1);
		expect(port1.get(0)).toBe('PortB_0');
		expect(port1.size).toBe(1);
		// Memory-side: nothing matches.
		expect(cueNamesForAwb(acb, CueWaveformSource.Memory).size).toBe(0);
	});

	it('preserves the raw top-level row for additional fields', () => {
		const bytes = buildAcb([{ name: 'X', awbTrackId: 0, source: 'memory' }]);
		const acb = parseAcb(bytes);
		expect(typeof acb.root['Name']).toBe('string');
		expect(acb.root['Name']).toBe('BGM');
	});

	it('handles ACBs without cue/waveform tables (returns empty cues)', () => {
		// Bare table with just `Name`.
		const bytes = buildUtfForTesting(
			'Header',
			[{ name: 'Name', type: UtfType.String, storage: UtfStorage.PerRow }],
			[{ Name: 'Empty' }],
		);
		const acb = parseAcb(bytes);
		expect(acb.name).toBe('Empty');
		expect(acb.cues).toHaveLength(0);
		expect(acb.streamAwbs).toHaveLength(0);
		expect(acb.embeddedAwb).toBeNull();
	});
});
