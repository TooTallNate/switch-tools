---
"nx-archive": minor
---

3D-print exports paint the pupils that Let's Go eyes show through their eye-white lids. The game draws an eye as a bowl with the pupil at the bottom, under a lid whose front faces inward and which the game culls; a solid print would cover the pupil. The exporter now finds such lids and paints each with what's visible behind it, viewed along the eye's axis, so Paras and Venomoth print with their pupils (and highlights). A lid is a back-face-culled patch (24+ triangles) whose back side sees the outside and whose front closes a small cavity facing back at it. Wings, fins and models without such eyes are unaffected.
