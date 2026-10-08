---
"nx-archive": patch
---

Yoshi's pupils now render in Bezel Engine models.

- Super Mario Party's eye shader has no `_u2` input. The second eye's pupil is sampled at the raw UV1 (alongside the `texsrt1`-shifted UV1 for the first eye), so both eyes get a pupil.
- When a shape's UV islands overlap in the base texture (Yoshi's two eyes reuse one region of the body atlas), each island is baked into its own tile of a side-by-side copy of the base. That way each eye keeps its own pupil instead of the first-baked island hiding the other's. This also fixes Mario Party Superstars Yoshi, whose eyes previously shared one bake.
