---
"@tootallnate/aes-xts": patch
---

Optimize AES-XTS by pre-computing all sector tweaks in parallel via `Promise.all`, and reduce minor allocations in ECB decrypt
