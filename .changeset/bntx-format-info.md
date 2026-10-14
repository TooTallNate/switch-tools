---
"@tootallnate/bntx": patch
---

Export `formatInfo`, so other texture containers that use Tegra surfaces (PlatinumGames XT1) can build a `BntxTexture` and decode it with `decodeBntxLayer`.
