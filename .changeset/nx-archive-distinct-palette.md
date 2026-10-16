---
"nx-archive": patch
---

Multi-colour 3MF export picks *distinct* colours instead of the largest areas. The palette now groups the surface into perceptual colour families, ignores filtering noise, and greedily adds the family farthest from every chosen colour (and from every blend of two chosen colours). A small red eye or black stripe no longer loses its filament to a third shade of white. Spare filaments still go to the farthest remaining shades. For example, Let's Go's Beedrill at 4 colours is now white, yellow, black and red (it was white, yellow and two greys).
