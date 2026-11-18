---
"@tootallnate/sm64": minor
---

Parse geo layouts into a scene graph (`parseSm64Geo`) and pose it the way the game does (`poseSm64Geo`): billboards face forward at scale 1, only the nearest render range draws, switches draw a chosen case, and only drawn parts read animation channels. `buildSm64Geo` carries render state between display lists and returns an animator that re-poses the mesh for any animation frame. Finds an actor's animation table (`findSm64ActorAnimations`) and all of Mario's animations, picks Mario's looks (`sm64MarioPoseOptions`: cap, no cap, wing cap, metal), and names models by actor group and level (`sm64ModelName`).
