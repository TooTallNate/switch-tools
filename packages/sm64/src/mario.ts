/**
 * Mario's looks. `mario_geo` (n64decomp/sm64 `actors/mario/geo.inc.c`)
 * holds every version of him behind switch nodes the game sets each
 * frame from his body state (`src/game/mario_misc.c`):
 *
 *  - `geo_switch_mario_cap_effect`: normal / vanish / metal / metal vanish
 *    bodies, four cases that each contain the rest.
 *  - `geo_switch_mario_cap_on_off`: head with cap / without, two cases that
 *    are each the eye switch. It also turns the wing cap's wings (the
 *    translate-rotate nodes next to it) on only for the wing cap.
 *  - `geo_switch_mario_hand`: fists / open / peace sign / holding a cap.
 *
 * The functions differ per version, so {@link sm64MarioPoseOptions}
 * recognises the switches by shape instead.
 */

import type { Sm64GeoNode, Sm64PoseOptions } from './geo.js';

export type Sm64MarioVariant = 'normal' | 'cap-off' | 'wing-cap' | 'metal' | 'metal-wing-cap';

export const SM64_MARIO_VARIANTS: readonly { variant: Sm64MarioVariant; label: string }[] = [
	{ variant: 'normal', label: 'Mario' },
	{ variant: 'cap-off', label: 'Mario (no cap)' },
	{ variant: 'wing-cap', label: 'Mario (wing cap)' },
	{ variant: 'metal', label: 'Metal Mario' },
	{ variant: 'metal-wing-cap', label: 'Metal Mario (wing cap)' },
];

const isSwitch = (n: Sm64GeoNode) => n.cmd === 0x0e;
/** Two cases (eye switches, or plain heads on Metal Mario) next to the wings' translate-rotate nodes. */
const isCapOnOff = (n: Sm64GeoNode, parent: Sm64GeoNode | undefined) => isSwitch(n) && n.children.length === 2 && !!parent?.children.some((c) => c.cmd === 0x10);
/** Four whole bodies. */
const isCapEffect = (n: Sm64GeoNode) => isSwitch(n) && n.children.length === 4 && n.children.every((c) => c.cmd === 0x13);
const isHand = (n: Sm64GeoNode) => isSwitch(n) && n.children.length >= 5 && n.children.every((c) => c.cmd === 0x13);

export function sm64MarioPoseOptions(variant: Sm64MarioVariant = 'normal', hands: 'fists' | 'open' = 'fists'): Pick<Sm64PoseOptions, 'selectCase' | 'hide'> {
	const metal = variant === 'metal' || variant === 'metal-wing-cap';
	const wings = variant === 'wing-cap' || variant === 'metal-wing-cap';
	return {
		selectCase: (n, parents) => {
			if (isCapEffect(n)) return metal ? 2 : 0;
			if (isCapOnOff(n, parents[parents.length - 1])) return variant === 'cap-off' ? 1 : 0;
			if (isHand(n)) return hands === 'open' ? 1 : 0;
			return 0;
		},
		hide: (n, parents) => {
			const parent = parents[parents.length - 1];
			return !wings && n.cmd === 0x10 && !!parent && parent.children.some((c) => isCapOnOff(c, parent));
		},
	};
}
