import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AclDecoder } from '../src/index.js';

const wasm = readFileSync(new URL('../src/acl.wasm', import.meta.url));

describe('acl-wasm', () => {
	it('instantiates with no imports and rejects buffers that are not ACL clips', async () => {
		const acl = await AclDecoder.create(wasm);
		const junk = new Uint8Array(64);
		new DataView(junk.buffer).setUint32(0, 64, true);
		expect(() => acl.decompress(junk)).toThrow(/not a valid ACL/);
		// The decoder stays usable after a failure.
		expect(() => acl.decompress(junk)).toThrow(/not a valid ACL/);
	});
});
