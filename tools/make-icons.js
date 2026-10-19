// Plugin icons: a chrome-extruded "R" rendered with the engine, downscaled.
const fs = require("fs"), path = require("path");
const E = require(path.join(__dirname, "..", "render", "engine.js"));
const { encodePNG } = require("./png.js");
const TMP = process.env.ICON_TMP || require("os").tmpdir(); // folder with the letter masks hl-icon-<size>.raw/.dim
const out = path.join(__dirname, "..", "render", "icons");
for (const [size, file] of [[23, "icon@1x.png"], [46, "icon@2x.png"], [48, "plugin@1x.png"], [96, "plugin@2x.png"]]) {
  const [w, h] = fs.readFileSync(path.join(TMP, `hl-icon-${size}.dim`), "utf8").trim().split(/\s+/).map(Number);
  const a = new Uint8Array(fs.readFileSync(path.join(TMP, `hl-icon-${size}.raw`)));
  const r = E.renderFromAlpha(a, w, h, { depth: 25, vpY: 260, stroke: 4, shadowX: 0, shadowY: 0 });
  // crop to content and box-downscale to the icon size
  let x0 = r.w, y0 = r.h, x1 = 0, y1 = 0;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.rgba[(y * r.w + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const side = Math.max(x1 - x0, y1 - y0) + 1, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const icon = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0], n = 0;
    const sx0 = cx - side / 2 + x * side / size, sy0 = cy - side / 2 + y * side / size, st = side / size;
    for (let yy = 0; yy < st; yy++) for (let xx = 0; xx < st; xx++) {
      const px = Math.floor(sx0 + xx), py = Math.floor(sy0 + yy);
      if (px < 0 || py < 0 || px >= r.w || py >= r.h) { n++; continue; }
      const i = (py * r.w + px) * 4, al = r.rgba[i + 3] / 255;
      acc[0] += r.rgba[i] * al; acc[1] += r.rgba[i + 1] * al; acc[2] += r.rgba[i + 2] * al; acc[3] += al; n++;
    }
    const o = (y * size + x) * 4;
    icon[o + 3] = Math.round(acc[3] / n * 255);
    if (acc[3] > 0) { icon[o] = acc[0] / acc[3]; icon[o + 1] = acc[1] / acc[3]; icon[o + 2] = acc[2] / acc[3]; }
  }
  fs.writeFileSync(path.join(out, file), encodePNG(size, size, icon, 4));
}
console.log("icons:", fs.readdirSync(out).join(", "));
