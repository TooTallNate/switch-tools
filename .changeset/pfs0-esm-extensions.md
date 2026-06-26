---
'@tootallnate/pfs0': patch
---

Fix ESM resolution under Node: the emitted `dist/index.js` imported `./types` without a `.js` extension, which Node's ESM loader rejects with `ERR_MODULE_NOT_FOUND`. The source relative imports now include the explicit `.js` extension so the published package imports cleanly in Node.
