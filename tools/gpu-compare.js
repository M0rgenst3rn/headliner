// Compares the GPU preview of Chrome Extrude (render/preview/index.html, WebGL 2) with the CPU engine
// (the final render) in headless Chromium. Needs Playwright (npm i -g playwright) and the masks from
// tools/make-masks.py.
//
//   node tools/gpu-compare.js [--masks quality-out/masks] [--out quality-out/gpu] [--mask heavy-120]
//
// Writes <out>/<case>.png (GPU | CPU | difference x4) and prints the mean colour difference per case.
const fs = require("fs"), path = require("path");
const FX = require("../render/effects.js"), E = require("../render/engine.js");
const { encodePNG } = require("./png.js");
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { ({ chromium } = require(path.join(require("child_process").execSync("npm root -g").toString().trim(), "playwright"))); }

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MASKS = arg("--masks", "quality-out/masks"), OUT = arg("--out", "quality-out/gpu"), MASK = arg("--mask", "heavy-120");
const CASES = {
  chrome: {}, gold: { material: "gold", vpY: -160, depth: 20 }, blackchrome: { material: "blackchrome", stroke: 1.5, strokeColor: "#ffffff", stroke2: 2.5, stroke2Color: "#111111", shadowX: 0, shadowY: 0 },
  round: { material: "silver", profile: "round", bevel: 12, depth: 15 }, synthwave: { material: "synthwave", sideMode: "solid", sideColor: "#ff3f8e", sideColor2: "#2a0a4a", stroke2: 2, stroke2Color: "#00e5ff", depth: 26 },
  flat: { depth: 0, shadowX: 3, shadowY: 3 }, holo: { material: "holo", profile: "round", bevel: 12, depth: 12, shine: 90, strokeColor: "#ffffff", shadowColor: "#7f5cff", shadowOpacity: 60 },
};
const BG = [0.12 * 255, 0.12 * 255, 0.12 * 255];   // preview background 1

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const info = JSON.parse(fs.readFileSync(path.join(MASKS, "masks.json"), "utf8"))[MASK];
  const alpha = new Uint8Array(fs.readFileSync(path.join(MASKS, MASK + ".raw")));
  const { w, h } = info;
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.goto("file://" + path.resolve(__dirname, "../render/preview/index.html"));
  const b64 = Buffer.from(alpha).toString("base64"), rgb = Buffer.alloc(w * h * 3, 200).toString("base64");
  let worst = 0;
  for (const [name, v] of Object.entries(CASES)) {
    const vals = FX.values("chromeExtrude", v);
    const res = await page.evaluate(async ({ b64, rgb, w, h, vals }) => {
      const got = [];
      window.onPreviewMessage = (m) => got.push(m);
      window.previewHandle({ cmd: "source", w, h, alpha: b64, rgb });
      const stack = window.HL.FX.single("chromeExtrude", vals);
      window.previewHandle({ cmd: "params", stack, sel: stack.entries[0].uid, bg: 1 });
      for (let k = 0; k < 400 && !got.some((m) => m.type === "rendered" || m.type === "error"); k++) await new Promise((r) => setTimeout(r, 25));
      const err = got.find((m) => m.type === "error");
      const cv = document.getElementById("c");
      const x = document.createElement("canvas"); x.width = cv.width; x.height = cv.height;
      const c2 = x.getContext("2d"); c2.drawImage(cv, 0, 0);
      return { err: err && err.error, msgs: got, w: cv.width, h: cv.height, px: Array.from(c2.getImageData(0, 0, cv.width, cv.height).data) };
    }, { b64, rgb, w, h, vals });
    if (res.err) { console.log(name, "GPU error:", res.err); worst = 99; continue; }
    const gpu = Uint8Array.from(res.px), W = res.w, H = res.h;
    // CPU render at the preview's padding: the GPU pads by need + 35 % of the text height
    const lay = E.layout(alpha, w, h, vals), extra = Math.ceil(lay.box.h * 0.35), n = lay.need;
    const P = E.pad(alpha, w, h, n.left + extra, n.top + extra, n.right + extra, n.bottom + extra);
    const box = Object.assign({}, lay.box, { x0: lay.box.x0 + n.left + extra, y0: lay.box.y0 + n.top + extra });
    const vp = { x: box.x0 + vals.vpX / 100 * box.w, y: box.y0 + vals.vpY / 100 * box.h };
    const cpu = E.renderChromeExtrude(P.alpha, P.w, P.h, box, vp, vals);
    if (P.w !== W || P.h !== H) { console.log(name, "size mismatch", W, H, P.w, P.h); worst = 99; continue; }
    const img = new Uint8Array(W * 3 * H * 3);
    let sum = 0, cnt = 0, big = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = cpu[i * 4 + 3] / 255;
      const c = [0, 1, 2].map((k) => BG[k] + (cpu[i * 4 + k] - BG[k]) * a);
      const g = [gpu[i * 4], gpu[i * 4 + 1], gpu[i * 4 + 2]];
      const d = (Math.abs(c[0] - g[0]) + Math.abs(c[1] - g[1]) + Math.abs(c[2] - g[2])) / 3;
      if (cpu[i * 4 + 3] > 0) { sum += d; cnt++; if (d > 32) big++; }
      for (let k = 0; k < 3; k++) {
        img[(y * W * 3 + x) * 3 + k] = g[k];
        img[(y * W * 3 + W + x) * 3 + k] = c[k];
        img[(y * W * 3 + 2 * W + x) * 3 + k] = Math.min(255, d * 4);
      }
    }
    fs.writeFileSync(path.join(OUT, name + ".png"), encodePNG(W * 3, H, img, 3));
    const mean = sum / cnt;
    worst = Math.max(worst, mean);
    console.log(`${name.padEnd(12)} ${W}x${H}  mean diff ${mean.toFixed(2)} / 255, pixels off by > 32: ${(big / cnt * 100).toFixed(2)} %  (${res.msgs.filter((m) => m.type === "rendered").map((m) => m.ms + " ms" + (m.gpu ? " gpu" : " CPU!")).join()})`);
  }
  await browser.close();
  process.exit(worst > 6 ? 1 : 0);
})();
