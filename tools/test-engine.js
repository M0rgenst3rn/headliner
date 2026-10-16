// Node check: engine renders the Test-F mask, writes a PNG and timing.
const fs = require("fs"), path = require("path");
const E = require(path.join(__dirname, "..", "render", "engine.js"));
const { encodePNG } = require("./png.js");
const [maskFile, w, h, out, json] = process.argv.slice(2);
const a = new Uint8Array(fs.readFileSync(maskFile));
const t0 = Date.now();
const r = E.renderFromAlpha(a, +w, +h, json ? JSON.parse(json) : {});
const ms = Date.now() - t0;
fs.writeFileSync(out, encodePNG(r.w, r.h, new Uint8Array(r.rgba.buffer), 4));
console.log(JSON.stringify({ w: r.w, h: r.h, offsetX: r.offsetX, offsetY: r.offsetY, ms }));
