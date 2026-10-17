// Regression checks for the QA findings (engine level). Run: node tools/qa-check.js
const FX = require("../render/effects.js");
const w = 200, h = 80, a = new Uint8Array(w * h), rgb = new Uint8Array(w * h * 3).fill(200);
for (let y = 20; y < 60; y++) for (let x = 20; x < 180; x++) if ((x % 40) < 30) a[y * w + x] = 255;
const src = { alpha: a, rgb, w, h };
let bad = 0;
const nzOf = (r) => { let n = 0; for (let i = 3; i < r.rgba.length; i += 4) if (r.rgba[i]) n++; return n; };
const check = (name, ok, extra) => { if (!ok) bad++; console.log((ok ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : "")); };
for (const e of FX.EFFECTS) {
  try { const r = FX.render(src, e.id, {}); check("render " + e.id, nzOf(r) > 0, r.w + "x" + r.h); }
  catch (err) { check("render " + e.id, false, err.message); }
}
// Sticker fill 0: must stay a border, not a filled rectangle
{ const r = FX.render(src, "sticker", { fill: 0 }); const full = r.w * r.h; const n = nzOf(r); check("sticker fill 0 is not a full rectangle", n < full * 0.9, n + "/" + full); }
// Halftone without fade and min 0 keeps the text
{ const r = FX.render(src, "halftone", { direction: "none", min: 0 }); check("halftone none/min0 not empty", nzOf(r) > 500); }
// Extreme sizes stay bounded
for (const [id, v] of [["backlight", { size: 200, length: 100 }], ["corona", { length: 9999 }], ["lightning", { length: 9999 }]]) {
  const r = FX.render(src, id, v); check("bounded " + id, r.w * r.h < 40e6, r.w + "x" + r.h);
}
// Star finds edge pixels on thin shapes
{ const r = FX.render(src, "star", { count: 6 }); check("star draws", nzOf(r) > 20); }
// values sanitising
{ const v = FX.values("glow", { size: "abc", intensity: 9999, color: "#f0f", bogus: 1 });
  check("values: NaN falls back, clamped, #rgb expanded", typeof v.size === "number" && v.intensity <= 100 && v.color === "#ff00ff"); }
{ const v = FX.values("halftone", { direction: "sideways", shape: "line" }); check("values: bad select falls back", v.direction === "down" && v.shape === "line"); }
// normStack
{ const st = FX.normStack({ entries: [{ uid: "a", effect: "chromeExtrude", on: false }, { uid: "a", effect: "bevel", on: true }, { uid: "b", effect: "inflate", on: true }] });
  const uids = st.entries.map((e) => e.uid);
  check("normStack unique uids", new Set(uids).size === uids.length);
  check("normStack prefers enabled base", st.entries.filter((e) => ["chromeExtrude", "bevel", "inflate"].includes(e.effect) && e.on).length >= 1 && !st.entries.some((e) => e.effect === "inflate" && !e.on) && st.entries.some((e) => e.effect === "bevel" || e.effect === "inflate")); }
// Patterns are anchored to the shape: the same shape on a bigger canvas gives the same pixels
{
  let bad2 = 0;
  const P = 37, w2 = w + P * 2, h2 = h + P * 2, a2 = new Uint8Array(w2 * h2), rgb2 = new Uint8Array(w2 * h2 * 3).fill(200);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a2[(y + P) * w2 + x + P] = a[y * w + x];
  for (const id of FX.EFFECTS.map((e) => e.id)) {
    const r1 = FX.render(src, id, {}), r2 = FX.render({ alpha: a2, rgb: rgb2, w: w2, h: h2 }, id, {});
    // shape position inside each result
    const o1x = r1.box.x0, o1y = r1.box.y0, o2x = r2.box.x0, o2y = r2.box.y0;
    let diff = 0, n = 0;
    for (let y = 0; y < r1.h; y++) for (let x = 0; x < r1.w; x++) {
      const X = x - o1x + o2x, Y = y - o1y + o2y;
      if (X < 0 || Y < 0 || X >= r2.w || Y >= r2.h) continue;
      const A = r1.rgba[(y * r1.w + x) * 4 + 3], B = r2.rgba[(Y * r2.w + X) * 4 + 3];
      if (A || B) { n++; if (Math.abs(A - B) > 24) diff++; }
    }
    const pct = n ? diff / n * 100 : 0;
    check("pattern anchored to shape: " + id, pct < 1, pct.toFixed(2) + "%");
    if (pct >= 1) bad2++;
  }
}
// Your look always stays
{
  const cur = { entries: [FX.entry("chromeExtrude", { material: "silver", depth: 31 })] };
  const look = (st) => st.entries.find((e) => e.effect === "chromeExtrude");
  const same = (st) => !!look(st) && look(st).values.material === "silver" && look(st).values.depth === 31;
  const names = (st) => st.entries.map((e) => e.effect).sort().join();
  for (const n of Object.keys(FX.COMBOS)) { const r = FX.applyCombo(cur, n, "replace").stack; check("combo keeps the look: " + n, same(r) && r.entries.filter((e) => FX.zoneOf(e.effect) === "base").length === 1, names(r)); }
  const add = FX.applyCombo({ entries: cur.entries.concat([FX.entry("smoke", {})]) }, "Flame Biker", "add").stack;
  check("add-mode combo keeps look and effects", same(add) && names(add) === "chromeExtrude,fire,smoke");
  const click = FX.clickStack(FX.applyCombo(cur, "Thunder Chrome", "replace").stack, "glow", {}).stack;
  check("effect click keeps the look", same(click) && names(click) === "chromeExtrude,glow");
  const lookClick = FX.clickStack(cur, "bevel", {}).stack;
  check("clicking another look replaces the look", names(lookClick) === "bevel");
  check("no look yet: combo brings its own", look(FX.applyCombo({ entries: [] }, "Flame Biker", "replace").stack).values.material === "gold");
}
console.log(bad ? bad + " FAILED" : "all ok"); process.exit(bad ? 1 : 0);
