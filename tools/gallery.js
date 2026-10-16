// Node check: renders every effect (default values) on a mask and tiles them into one PNG.
// usage: node tools/gallery.js <mask.raw> <w> <h> <out.png>
const fs = require("fs"), path = require("path");
const FX = require(path.join(__dirname, "..", "render", "effects.js"));
const { encodePNG } = require("./png.js");
const [maskFile, w0, h0, out] = process.argv.slice(2);
const W = +w0, H = +h0, alpha = new Uint8Array(fs.readFileSync(maskFile));
const rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) { rgb[i * 3] = 255; rgb[i * 3 + 1] = 70; rgb[i * 3 + 2] = 150; }

const TW = W, TH = H, cols = 4, list = FX.EFFECTS, rows = Math.ceil(list.length / cols);
const img = new Uint8Array(TW * cols * TH * rows * 4);
const IW = TW * cols;
const times = {};
list.forEach((e, n) => {
  const t0 = Date.now();
  const r = FX.render({ alpha, w: W, h: H, rgb }, e.id, {});
  times[e.id] = Date.now() - t0;
  const ox = (n % cols) * TW, oy = Math.floor(n / cols) * TH;
  // tile background
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const k = ((oy + y) * IW + ox + x) * 4, c = ((x >> 4) + (y >> 4)) & 1 ? 46 : 38;
    img[k] = c; img[k + 1] = c; img[k + 2] = c + 8; img[k + 3] = 255;
  }
  // place source (centered) + effect according to mode
  const cx = ox + ((TW - W) >> 1), cy = oy + ((TH - H) >> 1);
  const put = (rgba, pw, ph, px, py) => {
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const X = px + x, Y = py + y;
      if (X < ox || Y < oy || X >= ox + TW || Y >= oy + TH) continue;
      const s = (y * pw + x) * 4, a = rgba[s + 3] / 255, k = (Y * IW + X) * 4;
      if (!a) continue;
      for (let c = 0; c < 3; c++) img[k + c] = img[k + c] * (1 - a) + rgba[s + c] * a;
    }
  };
  const srcRGBA = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { srcRGBA[i * 4] = 255; srcRGBA[i * 4 + 1] = 70; srcRGBA[i * 4 + 2] = 150; srcRGBA[i * 4 + 3] = alpha[i]; }
  if (e.mode !== "replace" && e.mode !== "behind") put(srcRGBA, W, H, cx, cy);
  if (r) put(r.rgba, r.w, r.h, cx - r.offsetX, cy - r.offsetY);
  if (e.mode === "behind") put(srcRGBA, W, H, cx, cy);
});
fs.writeFileSync(out, encodePNG(IW, TH * rows, img, 4));
console.log(JSON.stringify(times));
