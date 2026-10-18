---
"@tootallnate/bfstm": patch
---

Read the whole block table: streams with a REGN block have four entries, and the DATA entry past 0x40 was being missed ("missing INFO or DATA block").
