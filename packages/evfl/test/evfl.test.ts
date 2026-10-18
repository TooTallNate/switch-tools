import { describe, expect, it } from 'vitest';
import { evflToText, isEvfl, parseEvfl } from '../src/index.js';

/** A builder for the pointer-heavy layout: append blocks, patch u64 pointers. */
class Writer {
	buf = new Uint8Array(0x1000);
	v = new DataView(this.buf.buffer);
	end = 0;
	alloc(n: number, align = 8) {
		this.end = Math.ceil(this.end / align) * align;
		const at = this.end;
		this.end += n;
		return at;
	}
	ptr(at: number, to: number) {
		this.v.setBigUint64(at, BigInt(to), true);
	}
	str(s: string) {
		const bytes = new TextEncoder().encode(s);
		const at = this.alloc(2 + bytes.length + 1, 2);
		this.v.setUint16(at, bytes.length, true);
		this.buf.set(bytes, at + 2);
		return at;
	}
	dic(names: string[]) {
		const at = this.alloc(8 + (names.length + 1) * 16);
		this.buf.set(new TextEncoder().encode('DIC '), at);
		this.v.setUint32(at + 4, names.length, true);
		names.forEach((n, i) => this.ptr(at + 8 + (i + 1) * 16 + 8, this.str(n)));
		return at;
	}
}

function build(): Uint8Array {
	const w = new Writer();
	const h = w.alloc(0x48);
	w.buf.set(new TextEncoder().encode('BFEVFL'), h);
	w.v.setUint16(h + 0x0c, 0xfeff, true);
	w.v.setUint16(h + 0x20, 1, true);
	const fcArray = w.alloc(8);
	w.ptr(h + 0x28, fcArray);
	const fc = w.alloc(0x48);
	w.ptr(fcArray, fc);
	w.buf.set(new TextEncoder().encode('EVFL'), fc);
	w.v.setUint16(fc + 0x10, 1, true); // actors
	w.v.setUint16(fc + 0x16, 2, true); // events
	w.ptr(fc + 0x20, w.str('Talk'));
	const actor = w.alloc(0x38);
	w.ptr(fc + 0x28, actor);
	w.ptr(actor, w.str('Npc'));
	const actions = w.alloc(8);
	w.ptr(actions, w.str('Demo_Talk'));
	w.ptr(actor + 0x18, actions);
	w.v.setUint16(actor + 0x30, 1, true);
	const events = w.alloc(0x28 * 2);
	w.ptr(fc + 0x30, events);
	w.ptr(events, w.str('Event0'));
	w.buf[events + 8] = 0; // action: actor 0, action 0
	w.ptr(events + 0x28, w.str('Event1'));
	w.buf[events + 0x28 + 8] = 4; // sub-flow
	w.ptr(events + 0x28 + 0x18, w.str('Common'));
	w.ptr(events + 0x28 + 0x20, w.str('Start'));
	w.ptr(fc + 0x38, w.dic(['Begin', 'End']));
	const name = w.str('Talk');
	w.v.setUint32(h + 0x10, name + 2, true);
	return w.buf.slice(0, w.end + 8);
}

describe('evfl', () => {
	it('checks the magic', () => {
		expect(isEvfl(build())).toBe(true);
		expect(isEvfl(new Uint8Array(8))).toBe(false);
	});

	it('reads flowcharts: entry points, actors and events', () => {
		const p = parseEvfl(build());
		expect(p.fileName).toBe('Talk');
		expect(p.timelines).toEqual([]);
		const fc = p.flowcharts[0]!;
		expect(fc.name).toBe('Talk');
		expect(fc.entryPoints).toEqual(['Begin', 'End']);
		expect(fc.actors).toEqual([{ name: 'Npc', secondaryName: '', actions: ['Demo_Talk'], queries: [] }]);
		expect(fc.events).toEqual([
			{ name: 'Event0', type: 'action', call: 'Npc.Demo_Talk' },
			{ name: 'Event1', type: 'subflow', subflow: { flowchart: 'Common', entryPoint: 'Start' } },
		]);
		expect(evflToText(p)).toContain('- Event1: subflow Common<Start>');
	});
});
