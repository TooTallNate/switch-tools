import { describe, expect, it } from 'vitest';

import {
	WsysWaveFormat,
	wsysWaveAfcBlockSize,
	decodeWsysPcm16,
	baaWalkIsComplete,
	decodeWsysPcm8,
	WSYS_AW_NAME_SIZE,
	aafWaveGroups,
	findWaveGroupForAw,
	parseAaf,
	parseBarc,
	aafSequenceIndex,
	BARC_NAME_SIZE,
	BARC_HEADER_SIZE,
	BARC_ENTRY_SIZE,
	parseWsys,
	wsysWaveDecodableSamples,
	wsysWaveDuration,
} from '../src/index.js';

/**
 * Byte-assembly helper. Everything is big-endian, and the WSYS sub-tables use
 * offsets relative to the WSYS block rather than the file, so the builder places
 * the block at a non-zero offset to keep that honest.
 */
class Writer {
	bytes: number[] = [];
	get length(): number {
		return this.bytes.length;
	}
	u8(v: number): this {
		this.bytes.push(v & 0xff);
		return this;
	}
	u16(v: number): this {
		this.bytes.push((v >>> 8) & 0xff, v & 0xff);
		return this;
	}
	u32(v: number): this {
		this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
		return this;
	}
	f32(v: number): this {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setFloat32(0, v, false);
		this.bytes.push(...b);
		return this;
	}
	ascii(s: string): this {
		for (const c of s) this.bytes.push(c.charCodeAt(0) & 0xff);
		return this;
	}
	/** NUL-padded fixed-width string. */
	name(s: string, width: number): this {
		this.ascii(s.slice(0, width));
		for (let i = s.length; i < width; i++) this.bytes.push(0);
		return this;
	}
	pad(n: number, fill = 0): this {
		for (let i = 0; i < n; i++) this.bytes.push(fill);
		return this;
	}
	patchU32(at: number, v: number): void {
		this.bytes[at] = (v >>> 24) & 0xff;
		this.bytes[at + 1] = (v >>> 16) & 0xff;
		this.bytes[at + 2] = (v >>> 8) & 0xff;
		this.bytes[at + 3] = v & 0xff;
	}
	out(): Uint8Array {
		return new Uint8Array(this.bytes);
	}
}

interface WaveSpec {
	id: number;
	format?: number;
	baseKey?: number;
	sampleRate?: number;
	start: number;
	size: number;
	looped?: boolean;
	sampleCount: number;
}

interface GroupSpec {
	awFileName: string;
	waves: WaveSpec[];
	/** Omit the C-DF table, so wave ids are unavailable. */
	noCdf?: boolean;
}

/** Build a standalone WSYS block. Returns bytes plus the block's own offset. */
function buildWsys(groups: GroupSpec[], id = 7, leading = 0x40): Uint8Array {
	const w = new Writer();
	w.pad(leading, 0xcc); // junk before the block, so offsets can't be absolute
	const base = w.length;

	w.ascii('WSYS');
	const sizeAt = w.length;
	w.u32(0);
	w.u32(id);
	w.u32(0);
	const winfPtrAt = w.length;
	w.u32(0);
	const wbctPtrAt = w.length;
	w.u32(0);

	// --- WINF: magic then count immediately (no padding word) ---
	w.patchU32(winfPtrAt, w.length - base);
	w.ascii('WINF').u32(groups.length);
	const groupPtrAt: number[] = [];
	for (let i = 0; i < groups.length; i++) {
		groupPtrAt.push(w.length);
		w.u32(0);
	}

	// --- WBCT: magic, a padding word, THEN count ---
	w.patchU32(wbctPtrAt, w.length - base);
	w.ascii('WBCT').u32(0).u32(groups.length);
	const scnePtrAt: number[] = [];
	for (let i = 0; i < groups.length; i++) {
		scnePtrAt.push(w.length);
		w.u32(0);
	}

	// --- groups ---
	groups.forEach((g, gi) => {
		w.patchU32(groupPtrAt[gi], w.length - base);
		w.name(g.awFileName, WSYS_AW_NAME_SIZE);
		w.u32(g.waves.length);
		const infoPtrAt: number[] = [];
		for (let i = 0; i < g.waves.length; i++) {
			infoPtrAt.push(w.length);
			w.u32(0);
		}
		g.waves.forEach((wave, wi) => {
			w.patchU32(infoPtrAt[wi], w.length - base);
			w.u8(0);
			w.u8(wave.format ?? 0);
			w.u8(wave.baseKey ?? 60);
			w.u8(0);
			w.f32(wave.sampleRate ?? 32000);
			w.u32(wave.start);
			w.u32(wave.size);
			w.u32(wave.looped ? 0xffffffff : 0);
			w.u32(0);
			w.u32(0);
			w.u32(wave.sampleCount);
		});
	});

	// --- SCNE + C-DF per group ---
	groups.forEach((g, gi) => {
		w.patchU32(scnePtrAt[gi], w.length - base);
		w.ascii('SCNE').u32(0).u32(0);
		const cdfPtrAt = w.length;
		w.u32(0);
		if (g.noCdf) return;
		w.patchU32(cdfPtrAt, w.length - base);
		w.ascii('C-DF').u32(g.waves.length);
		const entryPtrAt: number[] = [];
		for (let i = 0; i < g.waves.length; i++) {
			entryPtrAt.push(w.length);
			w.u32(0);
		}
		g.waves.forEach((wave, wi) => {
			w.patchU32(entryPtrAt[wi], w.length - base);
			w.u16(gi).u16(wave.id);
		});
	});

	w.patchU32(sizeAt, w.length - base);
	return w.out();
}

const SIMPLE: GroupSpec[] = [
	{
		awFileName: 'bank_0.aw',
		waves: [
			{ id: 10, start: 0, size: 9 * 4, sampleCount: 64, sampleRate: 32000 },
			{ id: 11, start: 36, size: 9 * 2, sampleCount: 32, looped: true, baseKey: 48 },
		],
	},
	{
		awFileName: 'other_0.aw',
		waves: [{ id: 20, start: 0, size: 9, sampleCount: 16, sampleRate: 22050 }],
	},
];

describe('parseWsys', () => {
	it('parses groups, waves and ids with block-relative offsets', () => {
		const bytes = buildWsys(SIMPLE);
		const wsys = parseWsys(bytes, 0x40)!;
		expect(wsys).not.toBeNull();
		expect(wsys.id).toBe(7);
		expect(wsys.groups).toHaveLength(2);

		const [a, b] = wsys.groups;
		expect(a.awFileName).toBe('bank_0.aw');
		expect(b.awFileName).toBe('other_0.aw');
		expect(a.waves).toHaveLength(2);
		expect(a.waves[0].id).toBe(10);
		expect(a.waves[0].sampleRate).toBeCloseTo(32000, 1);
		expect(a.waves[0].start).toBe(0);
		expect(a.waves[0].looped).toBe(false);
		expect(a.waves[1].id).toBe(11);
		expect(a.waves[1].looped).toBe(true);
		expect(a.waves[1].baseKey).toBe(48);
		expect(b.waves[0].sampleRate).toBeCloseTo(22050, 1);
	});

	it('handles the WINF/WBCT count asymmetry', () => {
		// WINF stores its count directly after the magic; WBCT has a padding
		// word first. Reading both the same way finds the wrong count for one of
		// them, so a successful parse of two groups here exercises both layouts.
		const wsys = parseWsys(buildWsys(SIMPLE), 0x40)!;
		expect(wsys.groups.map((g) => g.waves.length)).toEqual([2, 1]);
	});

	it('reads the aw filename as a fixed-width NUL-padded field', () => {
		const long = 'a_rather_long_bank_name_0.aw';
		const wsys = parseWsys(buildWsys([{ awFileName: long, waves: SIMPLE[0].waves }]), 0x40)!;
		expect(wsys.groups[0].awFileName).toBe(long);
		// The wave list must still be found, which only works if the name field
		// was skipped at its full declared width.
		expect(wsys.groups[0].waves).toHaveLength(2);
	});

	it('reports id -1 when the C-DF table is missing', () => {
		const wsys = parseWsys(
			buildWsys([{ awFileName: 'x_0.aw', waves: SIMPLE[0].waves, noCdf: true }]),
			0x40,
		)!;
		expect(wsys.groups[0].waves.map((w) => w.id)).toEqual([-1, -1]);
		// Everything else about the waves is still known.
		expect(wsys.groups[0].waves[0].size).toBe(36);
	});

	it('rejects a bad magic or corrupt sub-tables', () => {
		expect(parseWsys(new Uint8Array(64), 0)).toBeNull();
		const bytes = buildWsys(SIMPLE);
		// Break WINF's magic.
		const wsys = parseWsys(bytes, 0x40)!;
		const winfAt = 0x40 + 0x18;
		const broken = bytes.slice();
		broken[winfAt] = 0x00;
		expect(parseWsys(broken, 0x40)).toBeNull();
		expect(wsys).not.toBeNull(); // sanity: the unbroken copy did parse
		expect(parseWsys(bytes, -1)).toBeNull();
		expect(parseWsys(bytes, bytes.length - 4)).toBeNull();
	});
});

describe('parseAaf', () => {
	/** Wrap WSYS blocks in an AAF using the repeating record shape. */
	function buildAaf(blocks: Uint8Array[], blockOffset: number): Uint8Array {
		const w = new Writer();
		// Section type 2 uses (offset, size, id) triples until a zero offset.
		w.u32(2);
		const ptrAt: number[] = [];
		for (let i = 0; i < blocks.length; i++) {
			ptrAt.push(w.length);
			w.u32(0).u32(0).u32(i);
		}
		w.u32(0); // end of the repeating list
		w.u32(0); // end of sections
		while (w.length < blockOffset) w.pad(1, 0);
		blocks.forEach((b, i) => {
			// Each block already carries `blockOffset`-style junk in front; place
			// the WSYS itself and record its true offset.
			const at = w.length + 0x40;
			w.bytes.push(...b);
			w.patchU32(ptrAt[i], at);
			w.patchU32(ptrAt[i] + 4, b.length);
		});
		return w.out();
	}

	it('finds WSYS blocks and parses them', () => {
		const aaf = parseAaf(buildAaf([buildWsys(SIMPLE)], 0x40))!;
		expect(aaf).not.toBeNull();
		expect(aaf.wsys).toHaveLength(1);
		expect(aafWaveGroups(aaf)).toHaveLength(2);
		// Sections are identified by the magic at their target, not by the tag.
		expect(aaf.sections.some((s) => s.magic === 'WSYS')).toBe(true);
	});

	it('returns null when there are no sections at all', () => {
		expect(parseAaf(new Uint8Array(4))).toBeNull();
		expect(parseAaf(new Uint8Array(64))).toBeNull();
	});

	it('terminates on a malformed section list rather than spinning', () => {
		const junk = new Uint8Array(512).fill(0xff);
		// Should return quickly with either null or nonsense sections — the point
		// is that it returns.
		expect(() => parseAaf(junk)).not.toThrow();
	});

	it('reads fixed-width tags without swallowing the next tag', () => {
		// Only tags 2 and 3 repeat. Reading a fixed tag as a repeating one
		// consumes the *following* tag word as an offset, inventing a section
		// at a nonsense address like 5 or 7. That forgery is quiet, because a
		// small integer offset never carries a recognised magic, so the derived
		// bank and wave lists still look correct.
		const w = new Writer();
		w.u32(4).u32(0x100).u32(0x20).u32(0); // sequence archive index
		w.u32(5).u32(0x200).u32(0x30).u32(0); // stream list
		w.u32(7).u32(0x300).u32(0x40).u32(0); // fx scene
		w.u32(0); // end
		while (w.length < 0x400) w.pad(1, 0);
		const aaf = parseAaf(w.out())!;
		expect(aaf).not.toBeNull();
		expect(aaf.sections.map((s) => s.type)).toEqual([4, 5, 7]);
		expect(aaf.sections.map((s) => s.offset)).toEqual([0x100, 0x200, 0x300]);
		expect(aaf.sections.map((s) => s.size)).toEqual([0x20, 0x30, 0x40]);
	});
});

describe('parseBarc', () => {
	/** A BARC with the given (name, offset, size) entries. */
	function buildBarc(
		archiveName: string,
		entries: readonly (readonly [string, number, number])[],
	): Uint8Array {
		const w = new Writer();
		w.ascii('BARC').ascii('----').u32(0).u32(entries.length);
		w.name(archiveName, 16);
		for (const [name, offset, size] of entries) {
			w.name(name, BARC_NAME_SIZE);
			w.u16(0xffff).u32(0).u32(0x40cf6d).u32(offset).u32(size);
		}
		return w.out();
	}

	it('reads the header and every entry', () => {
		const barc = parseBarc(
			buildBarc('sequence.arc', [
				['se.scom', 0, 0xe600],
				['k_dolpic.com', 0xe600, 0x7220],
			]),
		)!;
		expect(barc).not.toBeNull();
		expect(barc.tag).toBe('----');
		expect(barc.archiveName).toBe('sequence.arc');
		expect(barc.entries).toHaveLength(2);
		expect(barc.entries[1]).toMatchObject({
			index: 1,
			name: 'k_dolpic.com',
			offset: 0xe600,
			size: 0x7220,
		});
	});

	it('sizes itself as header plus fixed-width entries', () => {
		// 0x20 + n * 0x20 is what lets the AAF section size confirm the count.
		const bytes = buildBarc('sequence.arc', [['a', 0, 4]]);
		expect(bytes.length).toBe(BARC_HEADER_SIZE + BARC_ENTRY_SIZE);
	});

	it('keeps a name that fills the field without a terminator', () => {
		// The builders truncated rather than extended, so a 14-character name
		// has no NUL and must not be read into the next field.
		const name = 'abcdefghijklmn';
		const barc = parseBarc(buildBarc('sequence.arc', [[name, 0, 4]]))!;
		expect(barc.entries[0].name).toBe(name);
		expect(barc.entries[0].offset).toBe(0);
	});

	it('rejects a wrong magic', () => {
		const bytes = buildBarc('sequence.arc', [['a', 0, 4]]);
		bytes[0] = 0x42 ^ 0xff;
		expect(parseBarc(bytes)).toBeNull();
	});

	it('rejects a count that runs past the buffer', () => {
		// Trusting it would silently drop entries off the end.
		const bytes = buildBarc('sequence.arc', [['a', 0, 4]]);
		new DataView(bytes.buffer, bytes.byteOffset).setUint32(0x0c, 99, false);
		expect(parseBarc(bytes)).toBeNull();
	});

	it('finds the index inside an AAF', () => {
		const barcBytes = buildBarc('sequence.arc', [['se.scom', 0, 0xe600]]);
		const w = new Writer();
		w.u32(4).u32(0x40).u32(barcBytes.length).u32(0);
		w.u32(0);
		while (w.length < 0x40) w.pad(1, 0);
		w.bytes.push(...barcBytes);
		const bytes = w.out();
		const aaf = parseAaf(bytes)!;
		const found = aafSequenceIndex(aaf, bytes)!;
		expect(found).not.toBeNull();
		expect(found.archiveName).toBe('sequence.arc');
		expect(found.entries).toHaveLength(1);
	});
});

describe('findWaveGroupForAw', () => {
	it('matches case-insensitively', () => {
		const aaf = parseAaf(
			(() => {
				const w = new Writer();
				w.u32(2);
				const at = w.length;
				w.u32(0).u32(0).u32(0);
				w.u32(0).u32(0);
				const block = buildWsys(SIMPLE);
				const blockAt = w.length + 0x40;
				w.bytes.push(...block);
				w.patchU32(at, blockAt);
				w.patchU32(at + 4, block.length);
				return w.out();
			})(),
		)!;
		expect(findWaveGroupForAw(aaf, 'bank_0.aw')?.awFileName).toBe('bank_0.aw');
		expect(findWaveGroupForAw(aaf, 'BANK_0.AW')?.awFileName).toBe('bank_0.aw');
		expect(findWaveGroupForAw(aaf, 'missing_0.aw')).toBeNull();
	});
});

describe('wsysWaveDecodableSamples', () => {
	const wave = (size: number, sampleCount: number) => ({
		index: 0,
		id: 0,
		awId: 0,
		format: 0,
		baseKey: 60,
		sampleRate: 32000,
		start: 0,
		size,
		looped: false,
		loopStart: 0,
		loopEnd: 0,
		sampleCount,
	});

	it('uses the declared count when the bytes can supply it', () => {
		// 4 AFC blocks = 36 bytes = 64 samples.
		expect(wsysWaveDecodableSamples(wave(36, 64))).toBe(64);
		expect(wsysWaveDecodableSamples(wave(36, 50))).toBe(50);
	});

	it('clamps to what the bytes actually hold', () => {
		// This is the real-world case: a minority of waves declare more samples
		// than their byte range covers, and trusting the declaration would read
		// into the neighbouring wave.
		expect(wsysWaveDecodableSamples(wave(36, 999))).toBe(64);
		expect(wsysWaveDecodableSamples(wave(9, 100))).toBe(16);
	});

	it('ignores a partial trailing block and handles degenerate input', () => {
		expect(wsysWaveDecodableSamples(wave(17, 64))).toBe(16);
		expect(wsysWaveDecodableSamples(wave(0, 64))).toBe(0);
		expect(wsysWaveDecodableSamples(wave(36, 0))).toBe(64);
	});

	it('derives duration from the decodable portion', () => {
		expect(wsysWaveDuration(wave(36, 64))).toBeCloseTo(64 / 32000, 6);
		expect(wsysWaveDuration({ ...wave(36, 64), sampleRate: 0 })).toBe(0);
	});
});


describe('wave formats', () => {
	const wave = (format: number, size: number, sampleCount: number) => ({
		index: 0, id: 0, awId: 0, format, baseKey: 60, sampleRate: 32000,
		start: 0, size, looped: false, loopStart: 0, loopEnd: 0, sampleCount,
	});

	it('sizes AFC by block and PCM8 by byte', () => {
		// The format byte is not decorative: a bank can mix the two, and reading
		// PCM8 as AFC produced 39% clipped samples on retail data.
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.AFC_4BIT, 36, 64))).toBe(64);
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.PCM8, 100, 100))).toBe(100);
		// PCM8 is one byte per sample, so the AFC block maths must not apply.
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.PCM8, 100, 999))).toBe(100);
	});

	it('decodes signed PCM8 into the 16-bit range', () => {
		const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
		const out = decodeWsysPcm8(bytes, wave(WsysWaveFormat.PCM8, 4, 4), 0)!;
		expect(out).not.toBeNull();
		// 127 -> 32512 and -128 -> -32768: both extremes stay inside int16.
		expect([...out]).toEqual([0, 32512, -32768, -256]);
	});

	it('refuses to PCM8-decode a wave of another format', () => {
		expect(decodeWsysPcm8(new Uint8Array(64), wave(WsysWaveFormat.AFC_4BIT, 36, 64), 0)).toBeNull();
	});

	it('rejects a PCM8 wave whose range escapes the buffer', () => {
		expect(decodeWsysPcm8(new Uint8Array(4), wave(WsysWaveFormat.PCM8, 100, 100), 0)).toBeNull();
	});

	it('maps each format to its AFC block size', () => {
		// These two sizes are what distinguishes the AFC variants; everything
		// else is a linear PCM format with no blocks at all.
		expect(wsysWaveAfcBlockSize(WsysWaveFormat.AFC_4BIT)).toBe(9);
		expect(wsysWaveAfcBlockSize(WsysWaveFormat.AFC_2BIT)).toBe(5);
		expect(wsysWaveAfcBlockSize(WsysWaveFormat.PCM8)).toBe(0);
		expect(wsysWaveAfcBlockSize(WsysWaveFormat.PCM16)).toBe(0);
	});

	it('sizes 2-bit AFC by its 5-byte block and PCM16 by two bytes', () => {
		// 2-bit AFC fits the same 16 samples into 5 bytes instead of 9. Sizing
		// it with the 4-bit block would under-report by nearly half.
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.AFC_2BIT, 20, 64))).toBe(64);
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.AFC_2BIT, 20, 999))).toBe(64);
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.PCM16, 200, 100))).toBe(100);
		// A partial trailing block is not decodable, so it rounds down.
		expect(wsysWaveDecodableSamples(wave(WsysWaveFormat.AFC_2BIT, 24, 999))).toBe(64);
	});

	it('decodes big-endian PCM16 including both extremes', () => {
		const bytes = new Uint8Array([0x00, 0x00, 0x7f, 0xff, 0x80, 0x00, 0xff, 0xff]);
		const out = decodeWsysPcm16(bytes, wave(WsysWaveFormat.PCM16, 8, 4), 0)!;
		expect(out).not.toBeNull();
		// Big-endian, and 0x8000 must sign-extend to -32768 rather than 32768.
		expect([...out]).toEqual([0, 32767, -32768, -1]);
	});

	it('refuses to PCM16-decode a wave of another format', () => {
		expect(decodeWsysPcm16(new Uint8Array(64), wave(WsysWaveFormat.AFC_4BIT, 36, 64), 0)).toBeNull();
	});

	it('rejects a PCM16 wave whose range escapes the buffer', () => {
		// Two bytes per sample, so 100 samples need 200 bytes, not 100.
		expect(decodeWsysPcm16(new Uint8Array(100), wave(WsysWaveFormat.PCM16, 200, 100), 0)).toBeNull();
	});
});

describe('tagged BAA dialect', () => {
	/** Build a tagged archive with the given (tag, extraWords) sections. */
	function buildBaa(sections: [string, number[]][]): Uint8Array {
		const words: number[] = [];
		const tags: string[] = [];
		const push = (tag: string, extra: number[]) => { tags.push(tag); words.push(extra.length); };
		void push;
		const parts: number[] = [];
		const writeTag = (t: string) => { for (const c of t) parts.push(c.charCodeAt(0)); };
		writeTag('AA_<');
		for (const [tag, extra] of sections) {
			writeTag(tag);
			for (const w of extra) parts.push((w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff);
		}
		writeTag('>_AA');
		return new Uint8Array(parts);
	}

	it('walks to the terminator with the documented strides', () => {
		// Reaching `>_AA` is the cheap proof that every stride is right; a wrong
		// one desynchronises and the walk stops on garbage instead.
		const baa = buildBaa([
			['bst ', [1, 2]],
			['bstn', [3, 4]],
			['ws  ', [0, 0, 0]],
			['bnk ', [1, 0]],
			['bsft', [5]],
			['bsc ', [6, 7]],
			['bms ', [8, 9, 10]],
		]);
		expect(baaWalkIsComplete(baa)).toBe(true);
	});

	it('reports an incomplete walk for an unknown tag', () => {
		const baa = buildBaa([['zzzz', [1, 2]]]);
		expect(baaWalkIsComplete(baa)).toBe(false);
	});

	it('is not confused with the numeric dialect', () => {
		expect(baaWalkIsComplete(new Uint8Array(64))).toBe(false);
	});
});
