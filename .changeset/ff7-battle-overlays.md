---
"nx-archive": patch
---

Fixed how faces are drawn on FF7 PSX battle models. A face texture (eyes, brows, mouth) is cut-out art layered on top of an untextured copy of the skin, and is now treated as a decal over it:

- **Viewer:** the face no longer flickers against the skin beneath it.
- **Print exports:** the face's visible parts are painted onto the skin. Previously the exports either lost the face or cut holes where its transparent parts were.
