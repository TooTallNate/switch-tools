---
"nx-archive": minor
---

Run the library scan in a Web Worker so the UI (and 3D animation playback) stays responsive while large dumps are indexed, falling back to the main thread when workers are unavailable (`localStorage["nx-archive:scan-worker"] = "0"` forces it). Also cuts main-thread work during scans: items arrive pre-sorted, thumbnail updates are coalesced, 2D thumbnail canvases are CPU-backed, and the thumbnail renderer skips synchronous shader checks.
