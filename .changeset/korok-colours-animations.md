---
"nx-archive": patch
---

BotW Koroks render in colour and all share their animations:
- Body and nose masks are recoloured with the shader's two-tint gradient.
- The skin colour palette (`UMii_Korogu_Body_ColorChange_fcl`) is a "Colour" selector in the viewer. It defaults to the skin the game's Korok actors use for that mask, read from their bumii files.
- Models of a family pick up each other's shared animation archives (`UMii_Korogu_Body_M_Animation`), keeping only clips that drive their skeleton.
- 3MF palettes no longer drop large colour areas as blends of two other colours.
