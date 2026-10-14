---
"nx-archive": minor
---

Switch updates now open together with their base game. When an update NCA's RomFS is a BKTR patch, the app looks for the matching base NCA in the NSP / NSZ / XCI / XCZ files opened alongside it (for example, in a selected folder) and shows the merged RomFS. `media-scan.ts` also accepts a folder.
