/**
 * Zelda 64 (Ocarina of Time / Majora's Mask) music: the audio tables in
 * `code`, soundfonts in `Audiobank` and samples in `Audiotable`
 * (zeldaret oot `include/audio.h`, `src/audio/internal/load.c`).
 *
 *   AudioTable        s16 numEntries, s16 unk, u32 romAddr, 8 pad, then
 *                     16-byte entries { u32 romAddr, u32 size, s8 medium,
 *                     s8 cachePolicy, s16 shortData1, 2, 3 }
 *   sequence table    romAddr into Audioseq (size 0: alias of entry romAddr)
 *   soundfont table   romAddr into Audiobank; shortData1 = sample banks
 *                     (id1 << 8 | id2), shortData2 = instruments << 8 | drums
 *   sample bank table romAddr into Audiotable
 *   sequence font table  u16 offset per sequence → u8 count, font ids
 *                        (the last is the default font)
 *
 * A soundfont: u32 → drum pointers, u32 → sound effects, u32 instrument
 * pointers[], all offsets from the font's start. Instruments and drums
 * match SM64's, but samples are `{ u32 codec:4 | medium:2 | … | size:24,
 * u32 sample offset (in its sample bank), u32 loop, u32 book }` and the
 * release byte is a decay-table index (MM's sample word starts with a
 * flag bit, then a 3-bit codec). ADPCM (codec 0) and small 2-bit ADPCM
 * (codec 3) are decoded.
 */

import { decodeVadpcm, parseVadpcmBook } from '@tootallnate/vadpcm';
import type { SeqBank, SeqDrum, SeqEnvelopePoint, SeqInstrument, SeqSample, SeqSound } from './bank.js';

const u8 = (b: Uint8Array, o: number) => b[o] ?? 0;
const u16 = (b: Uint8Array, o: number) => (u8(b, o) << 8) | u8(b, o + 1);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((u16(b, o) << 16) | u16(b, o + 2)) >>> 0;
const s32 = (b: Uint8Array, o: number) => u32(b, o) | 0;
const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getFloat32(o);

export interface Z64AudioEntry {
	romAddr: number;
	size: number;
	short1: number;
	short2: number;
	short3: number;
}

export interface Z64AudioTables {
	sequences: Z64AudioEntry[];
	fonts: Z64AudioEntry[];
	sampleBanks: Z64AudioEntry[];
	/** Font ids per sequence (serialized order; the last is the default). */
	sequenceFonts: number[][];
}

function readTable(code: Uint8Array, o: number): Z64AudioEntry[] | null {
	const n = s16(code, o);
	if (n < 1 || n > 1024 || o + 16 + n * 16 > code.length) return null;
	for (let k = 8; k < 16; k++) if (code[o + k] !== 0) return null;
	const out: Z64AudioEntry[] = [];
	for (let i = 0; i < n; i++) {
		const e = o + 16 + i * 16;
		out.push({ romAddr: u32(code, e), size: u32(code, e + 4), short1: s16(code, e + 10), short2: s16(code, e + 12), short3: s16(code, e + 14) });
	}
	return out;
}

/**
 * Find the audio tables in `code` given the sizes of the three audio
 * files (each table's entries must fit the file they index).
 */
export function findZ64AudioTables(code: Uint8Array, sizes: { audioseq: number; audiobank: number; audiotable: number }): Z64AudioTables | null {
	let sequences: Z64AudioEntry[] | null = null, fonts: Z64AudioEntry[] | null = null, sampleBanks: Z64AudioEntry[] | null = null;
	const fits = (t: Z64AudioEntry[], limit: number) => t.every((e) => e.size === 0 || (e.romAddr + e.size <= limit && e.size < limit));
	for (let o = 0; o + 32 <= code.length; o += 16) {
		const t = readTable(code, o);
		if (!t) continue;
		const real = t.filter((e) => e.size > 0).length;
		if (!sequences && t.length >= 64 && t[0]!.romAddr === 0 && real > 32 && fits(t, sizes.audioseq)) sequences = t;
		else if (!fonts && t.length >= 8 && t.length <= 128 && t[0]!.romAddr === 0 && real === t.length && fits(t, sizes.audiobank) && t.every((e) => ((e.short2 >> 8) & 0xff) <= 128)) fonts = t;
		else if (!sampleBanks && t.length >= 1 && t.length <= 16 && t[0]!.romAddr === 0 && fits(t, sizes.audiotable) && t[0]!.size > 0x10000) sampleBanks = t;
		if (sequences && fonts && sampleBanks) break;
	}
	if (!sequences || !fonts || !sampleBanks) return null;
	// Sequence font table: u16 offsets (the first is count × 2), then (count, ids…).
	const n = sequences.length;
	for (let o = 0; o + n * 2 <= code.length; o += 2) {
		if (u16(code, o) !== n * 2) continue;
		const sets: number[][] = [];
		let ok = true;
		for (let i = 0; i < n && ok; i++) {
			const at = o + u16(code, o + i * 2);
			const c = u8(code, at);
			if (c > 4 || at >= code.length) ok = false;
			const ids = Array.from({ length: c }, (_, k) => u8(code, at + 1 + k));
			if (ids.some((id) => id >= fonts!.length)) ok = false;
			sets.push(ids);
		}
		if (ok && sets.filter((x) => x.length > 0).length > n / 2) return { sequences, fonts, sampleBanks, sequenceFonts: sets };
	}
	return null;
}

/** Parse soundfont `font` of `Audiobank`, with its sample banks' bytes. */
export function parseZ64Font(audiobank: Uint8Array, font: Z64AudioEntry, banks: (Uint8Array | null)[]): SeqBank {
	const d = audiobank.subarray(font.romAddr, font.romAddr + font.size);
	const numInst = (font.short2 >> 8) & 0xff, numDrums = font.short2 & 0xff;
	const bank1 = banks[(font.short1 >> 8) & 0xff] ?? null;
	const inFont = (p: number, size: number) => p > 0 && p + size <= d.length;
	const samples = new Map<number, SeqSample | null>();
	const envelopes = new Map<number, SeqEnvelopePoint[]>();
	const envelope = (p: number): SeqEnvelopePoint[] => {
		let e = envelopes.get(p);
		if (!e) {
			e = [];
			for (let o = p; inFont(o, 4) && e.length < 64; o += 4) {
				const delay = u16(d, o), arg = u16(d, o + 2);
				e.push({ delay, arg });
				if (delay === 0 || delay >= 0xfffd) break;
			}
			envelopes.set(p, e);
		}
		return e;
	};
	const sample = (p: number): SeqSample | null => {
		if (samples.has(p)) return samples.get(p)!;
		let s: SeqSample | null = null;
		if (inFont(p, 16) && bank1) {
			// OoT: codec:4; MM: a flag bit then codec:3. ADPCM is 0 either way.
			const w = u32(d, p), codec = (w >>> 28) & 7, size = w & 0xffffff;
			const addr = u32(d, p + 4), loopAt = u32(d, p + 8), bookAt = u32(d, p + 12);
			// 0: ADPCM, 3: "small" (2-bit) ADPCM.
			const book = (codec === 0 || codec === 3) && inFont(bookAt, 8) ? parseVadpcmBook(d, bookAt) : null;
			if (book && addr + size <= bank1.length) {
				let pcm: Int16Array | null = null;
				const loop = inFont(loopAt, 16) ? { start: u32(d, loopAt), end: u32(d, loopAt + 4), count: s32(d, loopAt + 8) } : { start: 0, end: 0, count: 0 };
				s = {
					get pcm() {
						pcm ??= decodeVadpcm(bank1.subarray(addr, addr + size), book, { bits: codec === 3 ? 2 : 4 }).samples;
						return pcm;
					},
					loopStart: loop.start,
					loopEnd: loop.end,
					loopCount: loop.count,
				};
			}
		}
		samples.set(p, s);
		return s;
	};
	const sound = (o: number): SeqSound | null => {
		const p = u32(d, o);
		if (!p) return null;
		const s = sample(p);
		return s ? { sample: s, tuning: f32(d, o + 4) || 1 } : null;
	};
	const instruments: (SeqInstrument | null)[] = [];
	for (let i = 0; i < numInst; i++) {
		const p = u32(d, 8 + i * 4);
		if (!inFont(p, 32)) {
			instruments.push(null);
			continue;
		}
		instruments.push({
			normalRangeLo: u8(d, p + 1),
			normalRangeHi: u8(d, p + 2),
			releaseRate: u8(d, p + 3),
			envelope: envelope(u32(d, p + 4)),
			low: sound(p + 8),
			normal: sound(p + 16),
			high: sound(p + 24),
		});
	}
	const drums: (SeqDrum | null)[] = [];
	const list = u32(d, 0);
	for (let i = 0; i < numDrums && inFont(list, (i + 1) * 4); i++) {
		const p = u32(d, list + i * 4);
		if (!inFont(p, 16)) {
			drums.push(null);
			continue;
		}
		drums.push({ releaseRate: u8(d, p), pan: u8(d, p + 1), sound: sound(p + 4), envelope: envelope(u32(d, p + 12)) });
	}
	return { instruments, drums };
}

/**
 * Sample bank bytes by id. Entries of size 0 alias another bank (their
 * `romAddr` is that bank's id), as in the sequence table.
 */
export function z64SampleBanks(tables: Z64AudioTables, audiotable: Uint8Array): (Uint8Array | null)[] {
	return tables.sampleBanks.map((_, i) => {
		let e = tables.sampleBanks[i]!;
		for (let g = 0; e.size === 0 && g < 4; g++) e = tables.sampleBanks[e.romAddr] ?? e;
		return e.size ? audiotable.subarray(e.romAddr, e.romAddr + e.size) : null;
	});
}

/** A sequence's bytes (following size-0 aliases). */
export function z64Sequence(tables: Z64AudioTables, audioseq: Uint8Array, index: number): Uint8Array | null {
	let e = tables.sequences[index];
	for (let g = 0; e && e.size === 0 && g < 4; g++) e = tables.sequences[e.romAddr];
	return e && e.size ? audioseq.subarray(e.romAddr, e.romAddr + e.size) : null;
}

/** Sequence names by id (zeldaret oot / mm `include/tables/sequence_table.h`). */
export const OOT_SEQUENCE_NAMES: readonly string[] = ["general_sfx", "nature_ambience", "field_logic", "field_init", "field_default_1", "field_default_2", "field_default_3", "field_default_4", "field_default_5", "field_default_6", "field_default_7", "field_default_8", "field_default_9", "field_default_a", "field_default_b", "field_enemy_init", "field_enemy_1", "field_enemy_2", "field_enemy_3", "field_enemy_4", "field_still_1", "field_still_2", "field_still_3", "field_still_4", "dungeon", "kakariko_adult", "enemy", "boss", "inside_deku_tree", "market", "title", "link_house", "game_over", "boss_clear", "item_get", "opening_ganon", "heart_get", "oca_light", "jabu_jabu", "kakariko_kid", "great_fairy", "zelda_theme", "fire_temple", "open_tre_box", "forest_temple", "courtyard", "ganon_tower", "lonlon", "goron_city", "field_morning", "spiritual_stone", "oca_bolero", "oca_minuet", "oca_serenade", "oca_requiem", "oca_nocturne", "mini_boss", "small_item_get", "temple_of_time", "event_clear", "kokiri", "oca_fairy_get", "saria_theme", "spirit_temple", "horse", "horse_goal", "ingo", "medallion_get", "oca_saria", "oca_epona", "oca_zelda", "oca_suns", "oca_time", "oca_storm", "navi_opening", "deku_tree_cs", "windmill", "hyrule_cs", "mini_game", "sheik", "zora_domain", "appear", "adult_link", "master_sword", "intro_ganon", "shop", "chamber_of_sages", "file_select", "ice_cavern", "door_of_time", "owl", "shadow_temple", "water_temple", "bridge_to_ganons", "seal_of_sages", "gerudo_valley", "potion_shop", "kotake_koume", "escape", "underground", "ganondorf_boss", "ganon_boss", "ocarina_of_time", "staff_1", "staff_2", "staff_3", "staff_4", "fire_boss", "timed_mini_game", "cutscene_effects"];
export const MM_SEQUENCE_NAMES: readonly string[] = ["general_sfx", "ambience", "termina_field", "chase", "majoras_theme", "clock_tower", "stone_tower_temple", "inv_stone_tower_temple", "failure_0", "failure_1", "happy_mask_salesman", "song_of_healing", "swamp_region", "alien_invasion", "swamp_cruise", "sharps_curse", "great_bay_region", "ikana_region", "deku_palace", "mountain_region", "pirates_fortress", "clock_town_day_1", "clock_town_day_2", "clock_town_day_3", "file_select", "clear_event", "enemy", "boss", "woodfall_temple", "clock_town_main_sequence", "opening", "inside_a_house", "game_over", "clear_boss", "get_item", "clock_town_day_2_ptr", "get_heart", "timed_mini_game", "goron_race", "music_box_house", "fairy_fountain", "zeldas_lullaby", "rosa_sisters", "open_chest", "marine_research_lab", "giants_theme", "song_of_storms", "romani_ranch", "goron_village", "mayors_office", "ocarina_epona", "ocarina_suns", "ocarina_time", "ocarina_storm", "zora_hall", "get_new_mask", "mini_boss", "get_small_item", "astral_observatory", "cavern", "milk_bar", "zelda_appear", "sarias_song", "goron_goal", "horse", "horse_goal", "ingo", "kotake_potion_shop", "shop", "owl", "shooting_gallery", "ocarina_soaring", "ocarina_healing", "inverted_song_of_time", "song_of_double_time", "sonata_of_awakening", "goron_lullaby", "new_wave_bossa_nova", "elegy_of_emptiness", "oath_to_order", "sword_training_hall", "ocarina_lullaby_intro", "learned_new_song", "bremen_march", "ballad_of_the_wind_fish", "song_of_soaring", "milk_bar_duplicate", "final_hours", "mikau_riff", "mikau_finale", "frog_song", "ocarina_sonata", "ocarina_lullaby", "ocarina_new_wave", "ocarina_elegy", "ocarina_oath", "majoras_lair", "ocarina_lullaby_intro_ptr", "ocarina_guitar_bass_session", "piano_session", "indigo_go_session", "snowhead_temple", "great_bay_temple", "new_wave_saxophone", "new_wave_vocal", "majoras_wrath", "majoras_incarnation", "majoras_mask", "bass_play", "drums_play", "piano_play", "ikana_castle", "gathering_giants", "kamaro_dance", "cremia_carriage", "keaton_quiz", "end_credits", "opening_loop", "title_theme", "dungeon_appear", "woodfall_clear", "snowhead_clear", "seq_122", "into_the_moon", "goodbye_giant", "tatl_and_tael", "moons_destruction", "end_credits_second_half"];
