// Quality bench for the 3D looks: renders text masks at several sizes, saves each result in full and as a
// 4x crop (nearest neighbour), and measures the time per case.
//
//   python3 tools/make-masks.py quality-out/masks             # once: anti-aliased text masks
//   node tools/quality-bench.js --out quality-out/before      # e.g. on the old code
//   node tools/quality-bench.js --out quality-out/after --baseline quality-out/before
//
// With --baseline it also writes before|after crops to <out>/compare and reports the mean colour difference
// on smooth surfaces and on all opaque pixels, plus a speckle count (isolated bright/dark pixels per 10 000).
// Options: --masks <dir> (default quality-out/masks), --only <regex>, --reps <n> (timing runs, best is used).
const fs = require("fs"), path = require("path");
const FX = require("../render/effects.js");
const { encodePNG } = require("./png.js");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "quality-out/now"), MASKS = arg("--masks", "quality-out/masks"), BASE = arg("--baseline", null);
const ONLY = new RegExp(arg("--only", ".")), REPS = +arg("--reps", 3);
const BG = [60, 60, 60];

const C = (id, mask, effect, values) => ({ id, mask, effect, values: values || {} });
const CASES = [];
for (const s of [40, 120, 400, 1200]) CASES.push(C(`chrome-heavy-${s}`, `heavy-${s}`, "chromeExtrude"));
for (const s of [120, 400]) CASES.push(C(`chrome-serif-${s}`, `serif-${s}`, "chromeExtrude"), C(`chrome-italic-${s}`, `italic-${s}`, "chromeExtrude"));
for (const s of [120, 400]) {
  CASES.push(C(`gold-heavy-${s}`, `heavy-${s}`, "chromeExtrude", { material: "gold", vpY: -160, depth: 20 }));
  CASES.push(C(`blackchrome-heavy-${s}`, `heavy-${s}`, "chromeExtrude", { material: "blackchrome", stroke: 1.5, strokeColor: "#ffffff", stroke2: 2.5, stroke2Color: "#111111", shadowX: 0, shadowY: 0 }));
  CASES.push(C(`chrome-round-heavy-${s}`, `heavy-${s}`, "chromeExtrude", { material: "silver", profile: "round", bevel: 12, depth: 15 }));
}
for (const m of ["chrome", "gold", "silver", "rosegold", "copper", "blackchrome", "ice", "synthwave", "holo", "custom"]) CASES.push(C(`mat-${m}-heavy-120`, "heavy-120", "chromeExtrude", { material: m }));
for (const fx of ["inflate", "bevel", "glass", "stone", "brushedMetal", "diamondPlate", "rust", "wood", "marble"]) {
  for (const s of fx === "inflate" || fx === "bevel" || fx === "glass" || fx === "stone" ? [40, 120, 400, 1200] : [120]) CASES.push(C(`${fx}-heavy-${s}`, `heavy-${s}`, fx));
  CASES.push(C(`${fx}-serif-120`, "serif-120", fx));
}
CASES.push(C("bevel-gold-heavy-400", "heavy-400", "bevel", { material: "gold", width: 7 }));

const masks = JSON.parse(fs.readFileSync(path.join(MASKS, "masks.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });
if (BASE) fs.mkdirSync(path.join(OUT, "compare"), { recursive: true });

// straight-alpha RGBA over the grey background -> RGB
function flatten(rgba, w, h) {
  const o = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) o[i * 3 + c] = Math.round(BG[c] + (rgba[i * 4 + c] - BG[c]) * a);
  }
  return o;
}
function crop(rgb, w, h, x0, y0, cw, ch, k) {
  const o = new Uint8Array(cw * k * ch * k * 3);
  for (let y = 0; y < ch * k; y++) for (let x = 0; x < cw * k; x++) {
    const sx = Math.min(w - 1, Math.max(0, x0 + ((x / k) | 0))), sy = Math.min(h - 1, Math.max(0, y0 + ((y / k) | 0)));
    const s = (sy * w + sx) * 3, d = (y * cw * k + x) * 3;
    o[d] = rgb[s]; o[d + 1] = rgb[s + 1]; o[d + 2] = rgb[s + 2];
  }
  return o;
}
// crop window: lower middle of the text box – front face, horizon, bevel, wall/front border and counters
function cropRect(r) {
  const b = r.box, size = Math.max(40, Math.min(160, Math.round(b.h * 0.7)));
  const cx = Math.round(b.x0 + b.w * 0.4), cy = Math.round(b.y0 + b.h * 0.75);
  return { x0: Math.max(0, Math.min(r.w - size, cx - (size >> 1))), y0: Math.max(0, Math.min(r.h - size, cy - (size >> 1))), w: Math.min(size, r.w), h: Math.min(size, r.h) };
}
// Look check. "opaque": pixels whose 7x7 neighbourhood is fully opaque in both images (away from the
// silhouette). "smooth": of those, the ones where the old render had no edge, streak or stair step nearby
// (every channel within 6 of its 4 neighbours in a 5x5 window) – flat surfaces, which must not change.
function flatDiff(a, b, w, h) {
  const op = new Uint8Array(w * h), rough = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) op[i] = a[i * 4 + 3] === 255 && b[i * 4 + 3] === 255 ? 1 : 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    for (const j of [i - 1, i + 1, i - w, i + w]) for (let c = 0; c < 3; c++) if (Math.abs(a[i * 4 + c] - a[j * 4 + c]) > 6) rough[i] = 1;
  }
  let sum = 0, n = 0, sumS = 0, nS = 0, big = 0;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    let ok = 1, smooth = 1;
    for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3; dx++) {
      const j = (y + dy) * w + x + dx;
      if (!op[j]) { ok = 0; break; }
      if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && rough[j]) smooth = 0;
    }
    if (!ok) continue;
    const i = (y * w + x) * 4;
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    sum += d; n++;
    if (smooth) { sumS += d; nS++; if (d > 8) big++; }
  }
  return { meanDiff: nS ? +(sumS / nS).toFixed(2) : 0, smoothOver8Pct: nS ? +(big / nS * 100).toFixed(2) : 0, smoothPixels: nS,
    opaqueDiff: n ? +(sum / n).toFixed(2) : 0 };
}
// isolated pixels: brightness far from the mean of the 8 neighbours (opaque area only), per 10 000 px
function speckles(rgba, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11;
  let n = 0, s = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (rgba[i * 4 + 3] < 255) continue;
    let m = 0, lo = 1e9, hi = -1e9, ok = 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = i + dy * w + dx;
      if (rgba[j * 4 + 3] < 255) ok = 0;
      m += L[j]; lo = Math.min(lo, L[j]); hi = Math.max(hi, L[j]);
    }
    if (!ok) continue;
    n++;
    // brighter or darker than every neighbour by a clear margin
    if (L[i] > hi + 28 || L[i] < lo - 28) s++;
  }
  return n ? +(s / n * 10000).toFixed(1) : 0;
}

const results = [];
for (const c of CASES) {
  if (!ONLY.test(c.id)) continue;
  const m = masks[c.mask];
  const alpha = new Uint8Array(fs.readFileSync(path.join(MASKS, c.mask + ".raw")));
  const src = { alpha, rgb: new Uint8Array(m.w * m.h * 3).fill(200), w: m.w, h: m.h };
  let r = null, best = 1e9;
  const reps = m.size >= 1200 ? 1 : REPS;
  for (let k = 0; k < reps; k++) {
    const t0 = process.hrtime.bigint();
    r = FX.render(src, c.effect, c.values);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const rgb = flatten(r.rgba, r.w, r.h), cr = cropRect(r);
  fs.writeFileSync(path.join(OUT, c.id + ".png"), encodePNG(r.w, r.h, rgb, 3));
  const c4 = crop(rgb, r.w, r.h, cr.x0, cr.y0, cr.w, cr.h, 4);
  fs.writeFileSync(path.join(OUT, c.id + "-crop4x.png"), encodePNG(cr.w * 4, cr.h * 4, c4, 3));
  fs.writeFileSync(path.join(OUT, c.id + ".rgba"), Buffer.from(r.rgba.buffer, r.rgba.byteOffset, r.rgba.length));
  const res = { id: c.id, w: r.w, h: r.h, offsetX: r.offsetX, offsetY: r.offsetY, ms: +best.toFixed(1), speckles: speckles(r.rgba, r.w, r.h), crop: cr };
  if (BASE && fs.existsSync(path.join(BASE, c.id + ".rgba"))) {
    const prev = JSON.parse(fs.readFileSync(path.join(BASE, "results.json"), "utf8")).find((x) => x.id === c.id);
    const a = new Uint8Array(fs.readFileSync(path.join(BASE, c.id + ".rgba")));
    res.baseMs = prev.ms; res.baseSpeckles = prev.speckles;
    res.sameSize = prev.w === r.w && prev.h === r.h && prev.offsetX === r.offsetX && prev.offsetY === r.offsetY;
    if (res.sameSize) {
      Object.assign(res, flatDiff(a, r.rgba, r.w, r.h));
      // before | after, 4x crops side by side with a 8 px gap
      const b4 = crop(flatten(a, r.w, r.h), r.w, r.h, cr.x0, cr.y0, cr.w, cr.h, 4), W = cr.w * 4, H = cr.h * 4, G = 8;
      const sbs = new Uint8Array((W * 2 + G) * H * 3).fill(255);
      for (let y = 0; y < H; y++) { sbs.set(b4.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 2 + G) * 3); sbs.set(c4.subarray(y * W * 3, (y + 1) * W * 3), (y * (W * 2 + G) + W + G) * 3); }
      fs.writeFileSync(path.join(OUT, "compare", c.id + ".png"), encodePNG(W * 2 + G, H, sbs, 3));
      // whole image, before | after (small and mid sizes only)
      if (r.w <= 900) {
        const fa = flatten(a, r.w, r.h), FW = r.w * 2 + G, full = new Uint8Array(FW * r.h * 3).fill(255);
        for (let y = 0; y < r.h; y++) { full.set(fa.subarray(y * r.w * 3, (y + 1) * r.w * 3), y * FW * 3); full.set(rgb.subarray(y * r.w * 3, (y + 1) * r.w * 3), (y * FW + r.w + G) * 3); }
        fs.writeFileSync(path.join(OUT, "compare", c.id + "-full.png"), encodePNG(FW, r.h, full, 3));
      }
    }
  }
  results.push(res);
  const extra = res.baseMs ? `  before ${res.baseMs} ms (x${(res.ms / res.baseMs).toFixed(2)})  smooth-surface diff ${res.meanDiff} (opaque ${res.opaqueDiff})  speckles ${res.baseSpeckles} -> ${res.speckles}${res.sameSize ? "" : "  SIZE CHANGED"}` : `  speckles ${res.speckles}`;
  console.log(`${c.id.padEnd(28)} ${String(r.w + "x" + r.h).padEnd(11)} ${String(res.ms).padStart(8)} ms${extra}`);
}
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
if (BASE) {
  const cmp = results.filter((r) => r.baseMs);
  const tot = (k) => cmp.reduce((s, r) => s + r[k], 0);
  console.log(`total ${tot("ms").toFixed(0)} ms, before ${tot("baseMs").toFixed(0)} ms (x${(tot("ms") / tot("baseMs")).toFixed(2)}); ` +
    `mean colour difference on smooth surfaces ${(cmp.reduce((s, r) => s + (r.meanDiff || 0), 0) / cmp.length).toFixed(2)} / 255, ` +
    `on all opaque pixels ${(cmp.reduce((s, r) => s + (r.opaqueDiff || 0), 0) / cmp.length).toFixed(2)} / 255; size changes: ${cmp.filter((r) => !r.sameSize).length}`);
}
