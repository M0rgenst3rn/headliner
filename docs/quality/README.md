# Render quality: before and after

Made with `tools/quality-bench.js` (text "Rgo", anti-aliased masks from `tools/make-masks.py`).
Each image shows the old render on the left and the new one on the right.

- `*-full.png` – the whole render at 1:1
- all others – a crop magnified 4x with nearest neighbour, so every pixel is visible
- `gpu-vs-cpu-synthwave.png` – live preview (GPU) | final render (CPU) | difference x4

The number in a file name is the text height in pixels.
