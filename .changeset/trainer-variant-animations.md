---
"nx-archive": patch
---

Fixed Let's Go trainer models that showed only their bind pose because their pak has no animations of their own.

- **Trainer variants** (for example `tr0029_01`, `tr0031_02`, `tr0032_02`) now play their base trainer's animations, which live in the base variant's pak.
- **Reskins** that reuse another trainer's rig (for example `tr0087_00`) now play that trainer's animations, found through their texture names.

Clips are still only applied when their bone names match the model. Library thumbnails and the cached library index regenerate.
