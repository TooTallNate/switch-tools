---
"nx-archive": minor
---

Added a textured GLB export to the model Export dialog and the library's batch export, and removed the Snapmaker "Full Spectrum" 3MF. Slicers' own colour matching does that job better.

- **Format:** the GLB is a single binary glTF file for Blender and other 3D apps, and OrcaSlicer nightly builds can import it.
- **Pipeline:** the same scale, supports, repair and smoothing as STL and 3MF.
- **Colour:**
  - Original textures are kept at full resolution.
  - Vertex colours, flat colours and painted-on details (eyes) are baked into an extra texture, so slicers that only read textures see them too.
- **Units:** one unit is one millimetre, as in STL and 3MF.

Fixed support struts aiming at bone joints that weren't scaled to print size. At most scales this sent a strut far outside the model.
