/**
 * Where Pokémon Stadium 2 keeps its model archives, and what each
 * record is.
 *
 * The US ROM (MD5 1561c75d11cedf356a8ddb1a4a5f9d5d) has:
 *
 *   0x1638000  arena ("Stadium model") table, 30 records
 *   0x27ED000  Pokémon model table, 282 records: record N is species N
 *              (record 0 is unused), 252 the Substitute doll, 253 the
 *              Egg, 254–278 Unown B–Z (record 201 is Unown A)
 *   0x2D7D000  Pokémon pose (animation) table, 282 records
 *
 * Boundaries come from pret/pokestadium's `oldnotes/stadiumgs/main.s`;
 * record identities were audited by gen1recomp-mod-stadium2-importer
 * (`DECOMP_NOTES.md`). {@link findStadiumTables} validates each table's
 * shape rather than trusting the offsets, so another revision simply
 * reports no tables instead of mis-decoding.
 */

import { parseStadiumArchive, type StadiumArchive } from './archive.js';

export const STADIUM2_US = {
	arenaTable: 0x1638000,
	arenaRecords: 30,
	modelTable: 0x27ed000,
	modelRecords: 282,
	poseTable: 0x2d7d000,
} as const;

export interface StadiumTables {
	models: StadiumArchive | null;
	arenas: StadiumArchive | null;
}

/** The header's internal name, trimmed (`POKEMON STADIUM 2`). */
export function n64InternalName(rom: Uint8Array): string {
	let s = '';
	for (let i = 0x20; i < 0x34 && i < rom.length; i++) s += String.fromCharCode(rom[i]!);
	return s.replace(/\0/g, '').trim();
}

/** True for a (big-endian) Pokémon Stadium 2 ROM. */
export function isPokemonStadium2(rom: Uint8Array): boolean {
	return /^POKEMON STADIUM 2$/i.test(n64InternalName(rom)) || /^POKEMON STADIUM G&S$/i.test(n64InternalName(rom));
}

/** The model and arena archives, when the ROM has them where the US release does. */
export function findStadiumTables(rom: Uint8Array): StadiumTables {
	const at = (offset: number, count: number) => {
		const a = parseStadiumArchive(rom, offset);
		return a && a.records.length === count ? a : null;
	};
	return {
		models: at(STADIUM2_US.modelTable, STADIUM2_US.modelRecords),
		arenas: at(STADIUM2_US.arenaTable, STADIUM2_US.arenaRecords),
	};
}

/** National Dex names 1–251, index = species. */
export const STADIUM2_SPECIES: readonly string[] = [
	'',
	'Bulbasaur', 'Ivysaur', 'Venusaur', 'Charmander', 'Charmeleon', 'Charizard', 'Squirtle', 'Wartortle', 'Blastoise', 'Caterpie',
	'Metapod', 'Butterfree', 'Weedle', 'Kakuna', 'Beedrill', 'Pidgey', 'Pidgeotto', 'Pidgeot', 'Rattata', 'Raticate',
	'Spearow', 'Fearow', 'Ekans', 'Arbok', 'Pikachu', 'Raichu', 'Sandshrew', 'Sandslash', 'Nidoran♀', 'Nidorina',
	'Nidoqueen', 'Nidoran♂', 'Nidorino', 'Nidoking', 'Clefairy', 'Clefable', 'Vulpix', 'Ninetales', 'Jigglypuff', 'Wigglytuff',
	'Zubat', 'Golbat', 'Oddish', 'Gloom', 'Vileplume', 'Paras', 'Parasect', 'Venonat', 'Venomoth', 'Diglett',
	'Dugtrio', 'Meowth', 'Persian', 'Psyduck', 'Golduck', 'Mankey', 'Primeape', 'Growlithe', 'Arcanine', 'Poliwag',
	'Poliwhirl', 'Poliwrath', 'Abra', 'Kadabra', 'Alakazam', 'Machop', 'Machoke', 'Machamp', 'Bellsprout', 'Weepinbell',
	'Victreebel', 'Tentacool', 'Tentacruel', 'Geodude', 'Graveler', 'Golem', 'Ponyta', 'Rapidash', 'Slowpoke', 'Slowbro',
	'Magnemite', 'Magneton', "Farfetch'd", 'Doduo', 'Dodrio', 'Seel', 'Dewgong', 'Grimer', 'Muk', 'Shellder',
	'Cloyster', 'Gastly', 'Haunter', 'Gengar', 'Onix', 'Drowzee', 'Hypno', 'Krabby', 'Kingler', 'Voltorb',
	'Electrode', 'Exeggcute', 'Exeggutor', 'Cubone', 'Marowak', 'Hitmonlee', 'Hitmonchan', 'Lickitung', 'Koffing', 'Weezing',
	'Rhyhorn', 'Rhydon', 'Chansey', 'Tangela', 'Kangaskhan', 'Horsea', 'Seadra', 'Goldeen', 'Seaking', 'Staryu',
	'Starmie', 'Mr. Mime', 'Scyther', 'Jynx', 'Electabuzz', 'Magmar', 'Pinsir', 'Tauros', 'Magikarp', 'Gyarados',
	'Lapras', 'Ditto', 'Eevee', 'Vaporeon', 'Jolteon', 'Flareon', 'Porygon', 'Omanyte', 'Omastar', 'Kabuto',
	'Kabutops', 'Aerodactyl', 'Snorlax', 'Articuno', 'Zapdos', 'Moltres', 'Dratini', 'Dragonair', 'Dragonite', 'Mewtwo',
	'Mew', 'Chikorita', 'Bayleef', 'Meganium', 'Cyndaquil', 'Quilava', 'Typhlosion', 'Totodile', 'Croconaw', 'Feraligatr',
	'Sentret', 'Furret', 'Hoothoot', 'Noctowl', 'Ledyba', 'Ledian', 'Spinarak', 'Ariados', 'Crobat', 'Chinchou',
	'Lanturn', 'Pichu', 'Cleffa', 'Igglybuff', 'Togepi', 'Togetic', 'Natu', 'Xatu', 'Mareep', 'Flaaffy',
	'Ampharos', 'Bellossom', 'Marill', 'Azumarill', 'Sudowoodo', 'Politoed', 'Hoppip', 'Skiploom', 'Jumpluff', 'Aipom',
	'Sunkern', 'Sunflora', 'Yanma', 'Wooper', 'Quagsire', 'Espeon', 'Umbreon', 'Murkrow', 'Slowking', 'Misdreavus',
	'Unown', 'Wobbuffet', 'Girafarig', 'Pineco', 'Forretress', 'Dunsparce', 'Gligar', 'Steelix', 'Snubbull', 'Granbull',
	'Qwilfish', 'Scizor', 'Shuckle', 'Heracross', 'Sneasel', 'Teddiursa', 'Ursaring', 'Slugma', 'Magcargo', 'Swinub',
	'Piloswine', 'Corsola', 'Remoraid', 'Octillery', 'Delibird', 'Mantine', 'Skarmory', 'Houndour', 'Houndoom', 'Kingdra',
	'Phanpy', 'Donphan', 'Porygon2', 'Stantler', 'Smeargle', 'Tyrogue', 'Hitmontop', 'Smoochum', 'Elekid', 'Magby',
	'Miltank', 'Blissey', 'Raikou', 'Entei', 'Suicune', 'Larvitar', 'Pupitar', 'Tyranitar', 'Lugia', 'Ho-Oh',
	'Celebi',
];

/** Display name of model-table record `index`, or null for unused records. */
export function stadium2ModelName(index: number): string | null {
	if (index >= 1 && index <= 251) {
		const name = STADIUM2_SPECIES[index]!;
		return index === 201 ? `${name} A` : name;
	}
	if (index === 252) return 'Substitute';
	if (index === 253) return 'Egg';
	if (index >= 254 && index <= 278) return `Unown ${String.fromCharCode(0x42 + index - 254)}`;
	return null;
}
