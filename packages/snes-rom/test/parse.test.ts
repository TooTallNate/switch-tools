import { describe, it, expect } from 'vitest';
import {
	parseSnesRom,
	parseSnes,
	isSnes,
	scanBrrSamples,
} from '../src/index.js';

/**
 * Write a synthetic internal header at `base`. The checksum fields
 * are left as sentinels (complement 0x0000, checksum 0xFFFF) so that
 * `fixChecksum` can patch them without changing the total byte sum:
 * any final pair with checksum + complement === 0xFFFF contributes
 * the same 0x1FE to the sum as the sentinels do.
 */
function writeHeader(
	rom: Uint8Array,
	base: number,
	opts: {
		title?: string;
		mapMode: number;
		cartridgeType?: number;
		romSizeCode: number;
		ramSizeCode?: number;
		region?: number;
		developerId?: number;
		version?: number;
	},
): void {
	const title = (opts.title ?? 'TEST ROM').padEnd(21, ' ').slice(0, 21);
	for (let i = 0; i < 21; i++) {
		rom[base + i] = title.charCodeAt(i);
	}
	rom[base + 0x15] = opts.mapMode;
	rom[base + 0x16] = opts.cartridgeType ?? 0x00;
	rom[base + 0x17] = opts.romSizeCode;
	rom[base + 0x18] = opts.ramSizeCode ?? 0x00;
	rom[base + 0x19] = opts.region ?? 0x01;
	rom[base + 0x1a] = opts.developerId ?? 0x01;
	rom[base + 0x1b] = opts.version ?? 0x00;
	// Sentinels: complement = 0x0000, checksum = 0xFFFF.
	rom[base + 0x1c] = 0x00;
	rom[base + 0x1d] = 0x00;
	rom[base + 0x1e] = 0xff;
	rom[base + 0x1f] = 0xff;
}

/**
 * Compute the ROM sum and patch checksum/complement at `base`.
 * Must be called LAST, after all other bytes are written.
 */
function fixChecksum(rom: Uint8Array, base: number): number {
	let sum = 0;
	for (let i = 0; i < rom.length; i++) sum = (sum + rom[i]) & 0xffff;
	const complement = sum ^ 0xffff;
	rom[base + 0x1c] = complement & 0xff;
	rom[base + 0x1d] = complement >> 8;
	rom[base + 0x1e] = sum & 0xff;
	rom[base + 0x1f] = sum >> 8;
	return sum;
}

/** Build a 512 KB LoROM image with a valid header at 0x7FC0. */
function makeLoRom(): { rom: Uint8Array; checksum: number } {
	const rom = new Uint8Array(512 * 1024);
	writeHeader(rom, 0x7fc0, {
		title: 'LOROM TEST',
		mapMode: 0x20, // LoROM, slow
		cartridgeType: 0x02, // ROM+RAM+Battery
		romSizeCode: 0x09, // 512 KB
		ramSizeCode: 0x03, // 8 KB
		region: 0x01, // North America
		developerId: 0x33, // expanded header present
		version: 0x01,
	});
	// Expanded header (developer ID 0x33).
	const enc = new TextEncoder();
	rom.set(enc.encode('01'), 0x7fc0 - 0x10); // maker code
	rom.set(enc.encode('ATST'), 0x7fc0 - 0x0e); // game code
	const checksum = fixChecksum(rom, 0x7fc0);
	return { rom, checksum };
}

/**
 * Build a 1 MB HiROM image with a valid header at 0xFFC0 and a
 * plausible-looking (but checksum-invalid) decoy header at 0x7FC0.
 */
function makeHiRom(): Uint8Array {
	const rom = new Uint8Array(1024 * 1024);
	// Decoy at the LoROM offset: printable title, LoROM map mode,
	// valid size code — but no valid checksum/complement.
	writeHeader(rom, 0x7fc0, {
		title: 'DECOY',
		mapMode: 0x20,
		romSizeCode: 0x0a,
	});
	rom[0x7fc0 + 0x1c] = 0x12; // clobber decoy sentinels so its
	rom[0x7fc0 + 0x1d] = 0x34; // complement check fails too
	writeHeader(rom, 0xffc0, {
		title: 'HIROM TEST',
		mapMode: 0x31, // HiROM, FastROM
		cartridgeType: 0x35, // ROM+Coprocessor+RAM+Battery, SA-1
		romSizeCode: 0x0a, // 1 MB
		region: 0x00, // Japan
	});
	fixChecksum(rom, 0xffc0);
	return rom;
}

describe('parseSnesRom', () => {
	it('parses a synthetic LoROM image', () => {
		const { rom, checksum } = makeLoRom();
		const info = parseSnesRom(rom);
		expect(info).not.toBeNull();
		expect(info!.mapping).toBe('lorom');
		expect(info!.mapMode).toBe(0x20);
		expect(info!.fastRom).toBe(false);
		expect(info!.headerOffset).toBe(0x7fc0);
		expect(info!.copierHeader).toBe(false);
		expect(info!.title).toBe('LOROM TEST');
		expect(info!.cartridgeType).toBe(0x02);
		expect(info!.cartridgeTypeName).toBe('ROM+RAM+Battery');
		expect(info!.coprocessor).toBeUndefined();
		expect(info!.romSizeKb).toBe(512);
		expect(info!.ramSizeKb).toBe(8);
		expect(info!.region).toBe(0x01);
		expect(info!.regionName).toBe('North America');
		expect(info!.developerId).toBe(0x33);
		expect(info!.makerCode).toBe('01');
		expect(info!.gameCode).toBe('ATST');
		expect(info!.version).toBe(1);
		expect(info!.checksum).toBe(checksum);
		expect(info!.checksumValid).toBe(true);
		expect(info!.complementValid).toBe(true);
		// 8 (complement) + 4 (checksum) + 3 (map mode) + 2 (title) + 1 (size)
		expect(info!.score).toBe(18);
	});

	it('parses a synthetic HiROM image and prefers it over a decoy', () => {
		const rom = makeHiRom();
		const info = parseSnesRom(rom);
		expect(info).not.toBeNull();
		expect(info!.mapping).toBe('hirom');
		expect(info!.fastRom).toBe(true);
		expect(info!.headerOffset).toBe(0xffc0);
		expect(info!.title).toBe('HIROM TEST');
		expect(info!.cartridgeTypeName).toBe('ROM+Coprocessor+RAM+Battery');
		expect(info!.coprocessor).toBe('SA-1');
		expect(info!.romSizeKb).toBe(1024);
		expect(info!.regionName).toBe('Japan');
		expect(info!.checksumValid).toBe(true);
		expect(info!.complementValid).toBe(true);
	});

	it('detects and strips a 512-byte copier header', () => {
		const { rom } = makeLoRom();
		const withCopier = new Uint8Array(512 + rom.length);
		withCopier.fill(0xaa, 0, 512);
		withCopier.set(rom, 512);
		const info = parseSnesRom(withCopier);
		expect(info).not.toBeNull();
		expect(info!.copierHeader).toBe(true);
		expect(info!.headerOffset).toBe(512 + 0x7fc0);
		expect(info!.title).toBe('LOROM TEST');
		expect(info!.checksumValid).toBe(true);
	});

	it('checksums non-power-of-two ROMs via remainder mirroring', () => {
		// 1.5 MB = 1 MB power-of-two prefix P + 0.5 MB remainder R.
		// Mirror rule: sum = sum(P) + k * sum(R), k = (2 MB - 1 MB) / 0.5 MB = 2.
		const rom = new Uint8Array(1536 * 1024);
		// Non-trivial remainder contents so the k factor matters.
		for (let i = 1024 * 1024; i < rom.length; i++) {
			rom[i] = (i * 7 + 13) & 0xff;
		}
		writeHeader(rom, 0x7fc0, {
			title: 'MIRROR TEST',
			mapMode: 0x20,
			romSizeCode: 0x0b, // 2 MB (rounded up)
		});
		const p = 1024 * 1024;
		let sum = 0;
		for (let i = 0; i < p; i++) sum = (sum + rom[i]) & 0xffff;
		let rSum = 0;
		for (let i = p; i < rom.length; i++) rSum = (rSum + rom[i]) & 0xffff;
		sum = (sum + 2 * rSum) & 0xffff;
		const complement = sum ^ 0xffff;
		rom[0x7fc0 + 0x1c] = complement & 0xff;
		rom[0x7fc0 + 0x1d] = complement >> 8;
		rom[0x7fc0 + 0x1e] = sum & 0xff;
		rom[0x7fc0 + 0x1f] = sum >> 8;

		const info = parseSnesRom(rom);
		expect(info).not.toBeNull();
		expect(info!.checksum).toBe(sum);
		expect(info!.checksumValid).toBe(true);
		expect(info!.complementValid).toBe(true);
	});

	it('returns null for garbage', () => {
		expect(parseSnesRom(new Uint8Array(128 * 1024).fill(0xff))).toBeNull();
		// Too small to hold any candidate header at all.
		expect(parseSnesRom(new Uint8Array(0x1000))).toBeNull();
	});
});

describe('parseSnes / isSnes (Blob APIs)', () => {
	it('parses from a Blob', async () => {
		const { rom } = makeLoRom();
		const info = await parseSnes(new Blob([rom]));
		expect(info).not.toBeNull();
		expect(info!.title).toBe('LOROM TEST');
	});

	it('isSnes distinguishes ROMs from garbage', async () => {
		const { rom } = makeLoRom();
		expect(await isSnes(new Blob([rom]))).toBe(true);
		expect(
			await isSnes(new Blob([new Uint8Array(128 * 1024).fill(0xff)])),
		).toBe(false);
	});
});

const END = 0x01;
const LOOP = 0x02;

/** Build a BRR block header byte. */
function brrHeader(shift: number, filter: number, flags = 0): number {
	return ((shift & 0x0f) << 4) | ((filter & 3) << 2) | (flags & 3);
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Build a valid BRR sample: `blocks` 9-byte blocks, filter 0 on the
 * first block, END flag on the last.
 */
function makeBrrSample(
	blocks: number,
	rng: () => number,
	loop = false,
): Uint8Array {
	const out = new Uint8Array(blocks * 9);
	for (let b = 0; b < blocks; b++) {
		// Filter 0 with moderate shifts produces bounded output
		// (max |sample| = (8 << 10) >> 1 = 4096) — like real audio,
		// it passes the scanner's decode validation (no clamping,
		// audible amplitude). Random filters/shifts would explode
		// through the IIR feedback exactly like the garbage the
		// validator is designed to reject.
		const filter = 0;
		const shift = 6 + Math.floor(rng() * 5); // 6-10
		let flags = 0;
		if (b === blocks - 1) flags |= END;
		if (loop && b === 1) flags |= LOOP;
		out[b * 9] = brrHeader(shift, filter, flags);
		for (let i = 1; i < 9; i++) {
			out[b * 9 + i] = Math.floor(rng() * 256);
		}
	}
	return out;
}

describe('scanBrrSamples', () => {
	it('finds a planted 20-block sample in pseudo-random noise', () => {
		const rng = mulberry32(0xc0ffee);
		const buf = new Uint8Array(16 * 1024);
		for (let i = 0; i < buf.length; i++) {
			buf[i] = Math.floor(rng() * 256);
		}
		const sample = makeBrrSample(20, rng, true);
		const plantOffset = 0x1234;
		buf.set(sample, plantOffset);

		const refs = scanBrrSamples(buf);
		const hit = refs.find((r) => r.offset === plantOffset);
		expect(hit).toBeDefined();
		expect(hit!.blocks).toBe(20);
		expect(hit!.byteLength).toBe(180);
		expect(hit!.loop).toBe(true);
	});

	it('does not fire on noise without long END-terminated chains', () => {
		// Every byte looks like a valid header with the END flag set,
		// so every candidate chain terminates after a single block —
		// below minBlocks — and nothing is accepted.
		const rng = mulberry32(0xdead);
		const buf = new Uint8Array(8 * 1024);
		for (let i = 0; i < buf.length; i++) {
			buf[i] = brrHeader(Math.floor(rng() * 13), 0, END);
		}
		expect(scanBrrSamples(buf)).toEqual([]);
	});

	it('rejects chains whose first block is not filter 0', () => {
		const rng = mulberry32(1);
		const sample = makeBrrSample(20, rng);
		sample[0] = brrHeader(0, 1); // first block filter 1 → invalid
		const buf = new Uint8Array(4 * 1024).fill(0xdd); // range 13 everywhere
		buf.set(sample, 0x100);
		// Scanning must not report a sample starting at 0x100. (Offsets
		// inside the sample data bytes may still coincidentally match.)
		const refs = scanBrrSamples(buf, { minBlocks: 4 });
		expect(refs.find((r) => r.offset === 0x100)).toBeUndefined();
	});

	it('respects minBlocks', () => {
		const rng = mulberry32(2);
		const sample = makeBrrSample(20, rng);
		const buf = new Uint8Array(4 * 1024).fill(0xdd);
		buf.set(sample, 0x200);
		expect(
			scanBrrSamples(buf, { minBlocks: 32 }).find(
				(r) => r.offset === 0x200,
			),
		).toBeUndefined();
		const refs = scanBrrSamples(buf, { minBlocks: 16 });
		expect(refs.find((r) => r.offset === 0x200)).toBeDefined();
	});

	it('reports non-looping samples with loop: false', () => {
		const rng = mulberry32(3);
		const sample = makeBrrSample(16, rng, false);
		const buf = new Uint8Array(2 * 1024).fill(0xdd);
		buf.set(sample, 0x40);
		const refs = scanBrrSamples(buf);
		const hit = refs.find((r) => r.offset === 0x40);
		expect(hit).toBeDefined();
		expect(hit!.loop).toBe(false);
	});

	it('rejects structurally-valid chains that decode to clipping garbage', () => {
		// Filter 3 + max shift with full-scale nibbles explodes
		// through the IIR feedback and rides the clamps — the decode
		// validator must reject it even though every header byte is
		// structurally valid.
		const blocks = 20;
		const garbage = new Uint8Array(blocks * 9);
		for (let b = 0; b < blocks; b++) {
			const filter = b === 0 ? 0 : 3;
			const flags = b === blocks - 1 ? END : 0;
			garbage[b * 9] = brrHeader(12, filter, flags);
			for (let i = 1; i < 9; i++) garbage[b * 9 + i] = 0x77;
		}
		const buf = new Uint8Array(4 * 1024).fill(0xdd);
		buf.set(garbage, 0x200);
		expect(
			scanBrrSamples(buf).find((r) => r.offset === 0x200),
		).toBeUndefined();
		// With validation disabled the structural match comes back.
		expect(
			scanBrrSamples(buf, { validate: false }).find(
				(r) => r.offset === 0x200,
			),
		).toBeDefined();
	});

	it('rejects chains that decode to inaudible noise floor', () => {
		// Shift 0 with tiny nibbles → peak amplitude of a few
		// counts out of 32767 — a sparse data table, not audio.
		const blocks = 20;
		const quiet = new Uint8Array(blocks * 9);
		for (let b = 0; b < blocks; b++) {
			const flags = b === blocks - 1 ? END : 0;
			quiet[b * 9] = brrHeader(0, 0, flags);
			// Nibble 2 at shift 0 decodes to (2 << 0) >> 1 = 1 — a
			// peak of 1 count out of 32767. (Nibble 1 would decode
			// to literally 0.)
			for (let i = 1; i < 9; i++) quiet[b * 9 + i] = 0x22;
		}
		const buf = new Uint8Array(4 * 1024).fill(0xdd);
		buf.set(quiet, 0x200);
		expect(
			scanBrrSamples(buf).find((r) => r.offset === 0x200),
		).toBeUndefined();
		expect(
			scanBrrSamples(buf, { minAmplitude: 1 }).find(
				(r) => r.offset === 0x200,
			),
		).toBeDefined();
	});

	it('is not fooled by zero-filled padding regions', () => {
		// Zero-filled ROMs are full of structurally-valid "silent"
		// filter-0 blocks. A stray non-zero byte followed by a long
		// zero run must NOT chain into a later real sample's END
		// flag — the zero-run guard kills such chains, and the real
		// sample is still found at its own offset.
		const rng = mulberry32(4);
		const sample = makeBrrSample(20, rng);
		const buf = new Uint8Array(64 * 1024); // all zeros
		// A lone plausible-looking byte way before the sample (like
		// SNES header title text sitting in front of padding).
		buf[0x100] = 0x20; // shift 2, filter 0 — valid first header
		buf[0x101] = 0x11; // non-zero data so the first block passes
		buf.set(sample, 0x8000);
		const refs = scanBrrSamples(buf);
		expect(refs).toHaveLength(1);
		expect(refs[0].offset).toBe(0x8000);
		expect(refs[0].blocks).toBe(20);
	});
});
