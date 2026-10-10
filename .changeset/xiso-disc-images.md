---
"@tootallnate/xiso": minor
---

New package: a parser for Xbox / Xbox 360 XDVDFS disc images. `parseXiso` lists every file with its absolute offset and size. It handles both extract-xiso images (partition at 0) and full redump images, where `findXdvdfsPartition` locates the game partition after the video partition.
