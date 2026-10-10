/**
 * Mario Kart 64 kart sprites.
 *
 * MK64 draws racers as pre-rendered 2D sprites rather than 3D
 * models. Each character has 321 frames in the `kart_textures`
 * segment (ROM 0x145470–0x63E278 on the USA release): every frame
 * is its own MIO0 block that inflates to a 64×64 CI8 image. The
 * 256-entry RGBA5551 palette is the character's main palette
 * (indices 0x00–0xBF) plus a per-frame "wheel" palette (0xC0–0xFF);
 * the 32 tumble frames (289–320) have no wheel palette.
 *
 * Offsets come from the n64decomp/mk64 project (`mk64.ld`,
 * `assets/karts/*_kart.json`, `src/buffers.h`). They are USA-only,
 * so detection validates every frame before surfacing anything.
 */
import { decompressMio0Bytes } from '@tootallnate/mio0';
import type { Node } from './archive';
import { encodePng } from './png';

const FRAME_COUNT = 321;
/** Frames 0..288 have wheel palettes; 289..320 are the tumble set. */
const WHEEL_FRAMES = 289;
const SIZE = 64;

interface KartCharacter {
	name: string;
	frame0: number;
	wheelStart: number;
	mainPalette: number;
}

/** ROM order (not character-ID order), USA release. */
const CHARACTERS: KartCharacter[] = [
	{ name: 'Luigi', frame0: 0x145470, wheelStart: 0x1bbe6c, mainPalette: 0x1e006c },
	{ name: 'Mario', frame0: 0x1e01f0, wheelStart: 0x24e6a0, mainPalette: 0x2728a0 },
	{ name: 'Yoshi', frame0: 0x272a20, wheelStart: 0x2e5bc8, mainPalette: 0x309dc8 },
	{ name: 'Peach', frame0: 0x309f50, wheelStart: 0x379d38, mainPalette: 0x39df38 },
	{ name: 'Wario', frame0: 0x39e0c0, wheelStart: 0x41705c, mainPalette: 0x43b25c },
	{ name: 'Toad', frame0: 0x43b3e0, wheelStart: 0x4a7ac8, mainPalette: 0x4cbcc8 },
	{ name: 'Donkey Kong', frame0: 0x4cbe50, wheelStart: 0x559ae4, mainPalette: 0x57dce4 },
	{ name: 'Bowser', frame0: 0x57de70, wheelStart: 0x619ef8, mainPalette: 0x63e0f8 },
];

function isMio0Frame(rom: Uint8Array, o: number): boolean {
	return (
		rom[o] === 0x4d && rom[o + 1] === 0x49 && rom[o + 2] === 0x4f && rom[o + 3] === 0x30 &&
		// decompressed size, big-endian: 0x00001000
		rom[o + 4] === 0 && rom[o + 5] === 0 && rom[o + 6] === 0x10 && rom[o + 7] === 0
	);
}

/** Offsets of a character's 321 frames, or null when the layout doesn't match. */
function frameOffsets(rom: Uint8Array, c: KartCharacter): number[] | null {
	if (!isMio0Frame(rom, c.frame0)) return null;
	const out: number[] = [];
	for (let o = c.frame0; o < c.wheelStart && out.length <= FRAME_COUNT; o += 4) {
		if (isMio0Frame(rom, o)) out.push(o);
	}
	return out.length === FRAME_COUNT ? out : null;
}

/** True for a (big-endian, normalised) Mario Kart 64 USA ROM. */
export function isMk64Rom(rom: Uint8Array): boolean {
	if (rom.length < 0x63e278) return false;
	const name = String.fromCharCode(...rom.subarray(0x20, 0x2b));
	if (name !== 'MARIOKART64') return false;
	return CHARACTERS.every((c) => isMio0Frame(rom, c.frame0));
}

function rgba5551(rom: Uint8Array, o: number, out: Uint8Array, d: number): void {
	const v = (rom[o] << 8) | rom[o + 1];
	out[d] = (((v >> 11) & 31) * 255) / 31;
	out[d + 1] = (((v >> 6) & 31) * 255) / 31;
	out[d + 2] = (((v >> 1) & 31) * 255) / 31;
	out[d + 3] = v & 1 ? 255 : 0;
}

/** Decode one frame to RGBA8 (64×64). */
function decodeFrame(rom: Uint8Array, c: KartCharacter, index: number, offset: number): Uint8Array {
	const pixels = decompressMio0Bytes(rom, offset);
	const palette = new Uint8Array(256 * 4);
	for (let i = 0; i < 0xc0; i++) rgba5551(rom, c.mainPalette + i * 2, palette, i * 4);
	if (index < WHEEL_FRAMES) {
		const wheel = c.wheelStart + index * 0x200; // wheel palette 0 of 4
		for (let i = 0; i < 0x40; i++) rgba5551(rom, wheel + i * 2, palette, (0xc0 + i) * 4);
	}
	const out = new Uint8Array(SIZE * SIZE * 4);
	for (let i = 0; i < SIZE * SIZE; i++) {
		const p = pixels[i] * 4;
		out[i * 4] = palette[p];
		out[i * 4 + 1] = palette[p + 1];
		out[i * 4 + 2] = palette[p + 2];
		out[i * 4 + 3] = palette[p + 3];
	}
	return out;
}

/**
 * Sheet layout (21 columns): rows 0–8 are the nine 21-frame driving
 * groups (frames 0–188), rows 9–13 the five 20-frame sets (189–288),
 * rows 14–15 the 32 tumble frames.
 */
function sheetPositions(): [number, number][] {
	const pos: [number, number][] = [];
	for (let f = 0; f < 189; f++) pos.push([f % 21, Math.floor(f / 21)]);
	for (let f = 189; f < 289; f++) pos.push([(f - 189) % 20, 9 + Math.floor((f - 189) / 20)]);
	for (let f = 289; f < FRAME_COUNT; f++) pos.push([(f - 289) % 21, 14 + Math.floor((f - 289) / 21)]);
	return pos;
}

const COLS = 21;
const ROWS = 16;

async function renderSheet(rom: Uint8Array, c: KartCharacter, offsets: number[]): Promise<Blob> {
	const w = COLS * SIZE;
	const h = ROWS * SIZE;
	const sheet = new Uint8Array(w * h * 4);
	const pos = sheetPositions();
	offsets.forEach((offset, f) => {
		const frame = decodeFrame(rom, c, f, offset);
		const [cx, cy] = pos[f];
		for (let y = 0; y < SIZE; y++) {
			sheet.set(frame.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), ((cy * SIZE + y) * w + cx * SIZE) * 4);
		}
	});
	return new Blob([(await encodePng(w, h, sheet)) as BlobPart], { type: 'image/png' });
}

/** Directory of per-character kart sprite sheets. */
export function makeMk64KartSpritesNode(id: string, romOnce: () => Promise<Uint8Array>, rom: Uint8Array): Node | null {
	const sheets = CHARACTERS.map((c) => ({ c, offsets: frameOffsets(rom, c) }));
	if (sheets.some((s) => !s.offsets)) return null;
	return {
		id,
		name: 'kart sprites',
		kind: 'directory',
		isContainer: true,
		format: 'directory',
		getChildren: async () =>
			sheets.map(({ c, offsets }): Node => {
				const name = `${c.name.toLowerCase().replace(/ /g, '_')}_kart.png`;
				return {
					id: `${id}/${name}`,
					name,
					kind: 'file',
					isContainer: false,
					size: COLS * SIZE * ROWS * SIZE * 4,
					format: `CI8 sprite sheet · ${FRAME_COUNT} frames`,
					blob: async () => renderSheet(await romOnce(), c, offsets!),
				};
			}),
	};
}
