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
console.log(bad ? bad + " FAILED" : "all ok"); process.exit(bad ? 1 : 0);
