---
"nx-archive": minor
---

The media library folds duplicate files. Identical copies (same kind, name, size and content), such as the same model on each disc of a multi-disc game or the same asset embedded in several Halo maps, appear once.

- **Where the copies are:** the card shows how many copies exist, and the detail panel lists every location, each linking to the file in the tree.
- **Speed:** files that are decoded on demand are compared by a cheap content key instead of being decoded, and the pass has a time budget, so scans stay fast.
- **Reports:** the gaps report and `media-scan` show how many copies were folded.
