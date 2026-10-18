/**
 * BFEVFL: Nintendo's event flowchart format (BotW `.bfevfl` event flows and
 * `.bfevtm` timelines). It's how cutscenes and NPC conversations are
 * scripted: actors expose actions and queries, and events chain them
 * together (action → switch on a query → fork / join → sub-flow).
 *
 * Layout (little-endian, unrelocated: every pointer is a u64 file
 * offset), after leoetlino's `evfl` library and the ZeldaMods wiki:
 *
 *   0x00 "BFEVFL\0\0", u8 version[4], u16 BOM, u8 alignment, u8
 *   0x10 u32 file name, u16 relocated, u16 first block, u32 relocation
 *        table, u32 file size
 *   0x20 u16 flowchart count, u16 timeline count, u32
 *   0x28 u64 → flowchart pointer array, u64 → flowchart name DIC,
 *        u64 → timeline pointer array, u64 → timeline name DIC
 *
 *   EVFL flowchart: magic, u32 string pool, u32, u32,
 *     0x10 u16 actors, actions, queries, events, entry points, …
 *     0x20 u64 name, u64 actors, u64 events, u64 entry-point DIC, u64 entry points
 *   actor (0x38): u64 name, u64 secondary name, u64 argument name,
 *     u64 actions, u64 queries, u64 params, u16 action count,
 *     u16 query count, u16 entry point, u8 cut, u8
 *   event (0x28): u64 name, u8 type (0 action, 1 switch, 2 fork,
 *     3 join, 4 sub-flow), u8, then per type: action and switch store
 *     u16 next / case count, u16 actor, u16 action or query; a sub-flow
 *     stores its flowchart and entry point names at +0x18 / +0x20
 *   DIC: "DIC ", u32 count, then (count + 1) 0x10 entries
 *     { u32 bit, u16 left, u16 right, u64 name }; entry 0 is the root
 *   string: u16 length, then the bytes
 *   TLIN timeline: magic, u32 string pool, u32, u32, f32 duration (frames),
 *     u16 actors, actions, clips, one-shots, sub-timelines, cuts,
 *     u64 name, u64 actors (same 0x38 layout as flowchart actors), …
 */

export const EVENT_TYPES = ['action', 'switch', 'fork', 'join', 'subflow'] as const;
export type EvflEventType = (typeof EVENT_TYPES)[number] | 'unknown';

export interface EvflActor {
	name: string;
	secondaryName: string;
	actions: string[];
	queries: string[];
}

export interface EvflEvent {
	name: string;
	type: EvflEventType;
	/** `Actor.Action` for actions, `Actor.Query` for switches. */
	call?: string;
	/** Sub-flow target: `Flowchart<EntryPoint>`, flowchart blank when local. */
	subflow?: { flowchart: string; entryPoint: string };
}

export interface EvflFlowchart {
	name: string;
	actors: EvflActor[];
	events: EvflEvent[];
	entryPoints: string[];
}

export interface EvflTimeline {
	name: string;
	/** Length in frames. */
	duration: number;
	actors: EvflActor[];
	clips: number;
	oneshots: number;
	subtimelines: number;
	cuts: number;
}

export interface ParsedEvfl {
	fileName: string;
	flowcharts: EvflFlowchart[];
	timelines: EvflTimeline[];
}

export function isEvfl(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 6)) === 'BFEVFL';
}

export function parseEvfl(bytes: Uint8Array): ParsedEvfl {
	if (!isEvfl(bytes)) throw new Error('Not a BFEVFL file (bad magic)');
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint16(0x0c, true) !== 0xfeff) throw new Error('Big-endian BFEVFL is not supported');
	const inRange = (o: number, n: number) => o >= 0 && o + n <= bytes.length;
	const u16 = (o: number) => {
		if (!inRange(o, 2)) throw new Error(`BFEVFL offset 0x${o.toString(16)} out of range`);
		return v.getUint16(o, true);
	};
	const ptr = (o: number) => {
		if (!inRange(o, 8)) throw new Error(`BFEVFL offset 0x${o.toString(16)} out of range`);
		const n = Number(v.getBigUint64(o, true));
		if (n > bytes.length) throw new Error(`BFEVFL pointer 0x${n.toString(16)} out of range`);
		return n;
	};
	const decoder = new TextDecoder();
	// Strings: pointer to { u16 length, bytes }.
	const str = (p: number): string => {
		if (!p || !inRange(p, 2)) return '';
		const len = v.getUint16(p, true);
		return inRange(p + 2, len) ? decoder.decode(bytes.subarray(p + 2, p + 2 + len)) : '';
	};
	const strAt = (o: number) => str(ptr(o));
	const dicNames = (p: number): string[] => {
		if (!p || !inRange(p, 8) || String.fromCharCode(...bytes.subarray(p, p + 4)) !== 'DIC ') return [];
		const count = v.getUint32(p + 4, true);
		const out: string[] = [];
		for (let i = 1; i <= count && inRange(p + 8 + i * 16, 16); i++) out.push(strAt(p + 8 + i * 16 + 8));
		return out;
	};
	const strArray = (p: number, n: number) => (p ? Array.from({ length: n }, (_, i) => strAt(p + i * 8)) : []);

	const readActors = (p: number, n: number): EvflActor[] =>
		Array.from({ length: n }, (_, i) => {
			const a = p + i * 0x38;
			return {
				name: strAt(a),
				secondaryName: strAt(a + 8),
				actions: strArray(ptr(a + 0x18), u16(a + 0x30)),
				queries: strArray(ptr(a + 0x20), u16(a + 0x32)),
			};
		});

	const flowchartCount = u16(0x20);
	const flowchartArray = ptr(0x28);
	const flowcharts: EvflFlowchart[] = [];
	for (let f = 0; f < flowchartCount; f++) {
		const fc = ptr(flowchartArray + f * 8);
		if (String.fromCharCode(...bytes.subarray(fc, fc + 4)) !== 'EVFL') throw new Error('Bad EVFL flowchart magic');
		const numActors = u16(fc + 0x10);
		const numEvents = u16(fc + 0x16);
		const actorsPtr = ptr(fc + 0x28);
		const eventsPtr = ptr(fc + 0x30);
		const actors = readActors(actorsPtr, numActors);
		const events: EvflEvent[] = [];
		for (let i = 0; i < numEvents; i++) {
			const e = eventsPtr + i * 0x28;
			const t = bytes[e + 8]!;
			const type: EvflEventType = EVENT_TYPES[t] ?? 'unknown';
			const ev: EvflEvent = { name: strAt(e), type };
			if (type === 'action' || type === 'switch') {
				const actor = actors[u16(e + 0x0c)];
				const list = type === 'action' ? actor?.actions : actor?.queries;
				const call = list?.[u16(e + 0x0e)];
				if (actor && call !== undefined) ev.call = `${actor.name}${actor.secondaryName ? `[${actor.secondaryName}]` : ''}.${call}`;
			} else if (type === 'subflow') {
				ev.subflow = { flowchart: strAt(e + 0x18), entryPoint: strAt(e + 0x20) };
			}
			events.push(ev);
		}
		flowcharts.push({ name: strAt(fc + 0x20), actors, events, entryPoints: dicNames(ptr(fc + 0x38)) });
	}
	// The file name field points at the characters, past the length prefix.
	const nameAt = v.getUint32(0x10, true);
	let nameEnd = nameAt;
	while (nameEnd < bytes.length && bytes[nameEnd] !== 0) nameEnd++;
	const fileName = nameAt && nameAt < bytes.length ? decoder.decode(bytes.subarray(nameAt, nameEnd)) : '';
	const timelines: EvflTimeline[] = [];
	const timelineCount = u16(0x22);
	const timelineArray = timelineCount ? ptr(0x38) : 0;
	for (let t = 0; t < timelineCount; t++) {
		const tl = ptr(timelineArray + t * 8);
		if (String.fromCharCode(...bytes.subarray(tl, tl + 4)) !== 'TLIN') throw new Error('Bad TLIN timeline magic');
		timelines.push({
			name: strAt(tl + 0x20),
			duration: v.getFloat32(tl + 0x10, true),
			actors: readActors(ptr(tl + 0x28), u16(tl + 0x14)),
			clips: u16(tl + 0x18),
			oneshots: u16(tl + 0x1a),
			subtimelines: u16(tl + 0x1c),
			cuts: u16(tl + 0x1e),
		});
	}
	return { fileName, flowcharts, timelines };
}

/** YAML-like summary: entry points, actors with their actions, events. */
export function evflToText(p: ParsedEvfl): string {
	const out: string[] = [];
	for (const fc of p.flowcharts) {
		out.push(`flowchart: ${fc.name}`, '  entry_points:', ...fc.entryPoints.map((e) => `    - ${e}`), '  actors:');
		for (const a of fc.actors) {
			out.push(`    ${a.name}${a.secondaryName ? `[${a.secondaryName}]` : ''}:`);
			if (a.actions.length) out.push(`      actions: [${a.actions.join(', ')}]`);
			if (a.queries.length) out.push(`      queries: [${a.queries.join(', ')}]`);
		}
		out.push('  events:');
		for (const e of fc.events) {
			const detail = e.call ?? (e.subflow ? `${e.subflow.flowchart}<${e.subflow.entryPoint}>` : '');
			out.push(`    - ${e.name}: ${e.type}${detail ? ` ${detail}` : ''}`);
		}
	}
	for (const t of p.timelines) {
		out.push(
			`timeline: ${t.name}`,
			`  duration: ${t.duration}`,
			`  clips: ${t.clips}`,
			`  oneshots: ${t.oneshots}`,
			`  subtimelines: ${t.subtimelines}`,
			`  cuts: ${t.cuts}`,
			'  actors:',
		);
		for (const a of t.actors) {
			out.push(`    ${a.name}${a.secondaryName ? `[${a.secondaryName}]` : ''}:`);
			if (a.actions.length) out.push(`      actions: [${a.actions.join(', ')}]`);
		}
	}
	return out.join('\n');
}
