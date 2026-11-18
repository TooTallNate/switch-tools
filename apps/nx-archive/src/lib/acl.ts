/**
 * Lazy-loaded ACL animation decompressor (`@tootallnate/acl-wasm`, ~23 KB),
 * for Sonic Frontiers' compressed `.anm.pxd` clips. Fetched on first use.
 */
import type { AclDecoder } from '@tootallnate/acl-wasm';
import aclWasmUrl from '@tootallnate/acl-wasm/acl.wasm?url';

import { compileWasmUrl } from './wasm-url';

let decoder: Promise<AclDecoder> | null = null;

export function getAclDecoder(): Promise<AclDecoder> {
	if (!decoder) {
		decoder = (async () => {
			const [{ AclDecoder }, wasm] = await Promise.all([import('@tootallnate/acl-wasm'), compileWasmUrl(aclWasmUrl)]);
			return AclDecoder.create(wasm);
		})();
		decoder.catch(() => (decoder = null));
	}
	return decoder;
}
