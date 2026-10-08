---
"nx-archive": patch
---

Textures for Super Mario Party (`.nxonnx32.bea`) models. In this earlier Bezel Engine build each `.ftxb` is a standalone single-texture BNTX, not the path stub later titles use. Such `.ftxb` entries now open in the BNTX texture preview, and the BFRES viewer loads them as texture banks from the enclosing BEA. Materials compiled against the older `forward_plus_char` shader (no `texture_srt_enable*` options) are now recognised as Bezel materials, so their UV routing and texture SRTs (e.g. the 8-frame eye atlas) apply.
