// Generates render/icons/wheel-0..10.png: HSV colour wheel (hue = angle, saturation = radius) at 11 brightness
// levels – UXP can't darken an image with CSS, so the panel swaps the file.
// The panel maps clicks with the same formula (fromEvent in colorRow, main.js).
const fs = require("fs"), path = require("path");
const { encodePNG } = require("./png.js");
const S = 300, R = S / 2 - 1;
function hsv(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
for (let lv = 0; lv <= 10; lv++) {
const img = new Uint8Array(S * S * 4);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const dx = x + 0.5 - S / 2, dy = y + 0.5 - S / 2, r = Math.hypot(dx, dy);
  const a = Math.max(0, Math.min(1, R - r + 0.5));
  if (!a) continue;
  const h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, s = Math.min(1, r / R);
  const [cr, cg, cb] = hsv(h, s, lv / 10), i = (y * S + x) * 4;
  img[i] = cr * 255; img[i + 1] = cg * 255; img[i + 2] = cb * 255; img[i + 3] = a * 255;
}
fs.writeFileSync(path.join(__dirname, "..", "render", "icons", `wheel-${lv}.png`), encodePNG(S, S, img, 4));
}
console.log("wheel-0..10.png written");
