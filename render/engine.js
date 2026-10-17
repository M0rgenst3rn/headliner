"use strict";
// MS Render – CPU engine (final renders + fallback).
// Pure JavaScript, no Photoshop dependency: runs in the UXP panel and in Node for tests.
//
// Chrome Extrude: perspective extrusion toward a vanishing point (sphere tracing on a distance
// field), bevelled front face with retro chrome/gold reflection, lit side walls, dark edge line,
// outline and hard retro shadow. Ported from Phase-0 Test F v2.

const DEFAULTS = {
  effect: "chromeExtrude",
  material: "chrome",     // chrome | gold | silver
  depth: 22,              // % of the way to the vanishing point
  vpX: 50, vpY: 240,      // vanishing point relative to the text box (%; 0..100 = inside)
  bevel: 6.5,             // bevel width, % of text height
  profile: "chamfer",     // chamfer | round
  edgeLine: 45,           // darkening between front and side, %
  stroke: 2,              // outline width, % of text height
  shadowX: 2, shadowY: 3.5, // hard shadow offset, % of text height
  horizon: 50,            // where sky meets ground in the chrome reflection, % (top → bottom)
  shine: 70,              // specular highlights, %
  sideMode: "material",   // material | solid – side walls in the material or a colour gradient
  sideColor: "#ff3fa4", sideColor2: "#3b0a5c",
  strokeColor: "#0c0a1e", stroke2: 0, stroke2Color: "#ff3fa4",   // outline + optional second outline
  shadowColor: "#140628", shadowOpacity: 85,
  skyTop: "#0a1440", skyHorizon: "#dff2ff", groundHorizon: "#a86a34", groundBottom: "#4a2c16",   // material "custom"
  expandCanvas: true,
};

const RAMPS = {
  chrome: [[0, 0x0a1440], [0.28, 0x3f7fd8], [0.46, 0xdff2ff], [0.5, 0xffffff], [0.505, 0x2c1a0c], [0.68, 0xa86a34], [0.88, 0xf2d6a6], [1, 0x4a2c16]],
  gold: [[0, 0x3a1a00], [0.3, 0xb8741a], [0.46, 0xfff1b8], [0.5, 0xffffff], [0.505, 0x5a3200], [0.7, 0xd9a03a], [0.9, 0xfff0b0], [1, 0x6a3c08]],
  silver: [[0, 0x1a1c22], [0.28, 0x8a929e], [0.46, 0xf2f4f8], [0.5, 0xffffff], [0.505, 0x2a2c30], [0.68, 0x7a7e86], [0.88, 0xd8dce2], [1, 0x30333a]],
  rosegold: [[0, 0x3a1416], [0.3, 0xc98a7d], [0.46, 0xffe4dc], [0.5, 0xffffff], [0.505, 0x4a1e1c], [0.7, 0xd49080], [0.9, 0xffd8cc], [1, 0x5a2a24]],
  blackchrome: [[0, 0x050608], [0.3, 0x2a2e36], [0.46, 0x9aa3b0], [0.5, 0xe8ecf2], [0.505, 0x050506], [0.7, 0x202228], [0.9, 0x6a707a], [1, 0x0a0a0c]],
  ice: [[0, 0x0b2a4a], [0.3, 0x5fb6e8], [0.46, 0xe6f8ff], [0.5, 0xffffff], [0.505, 0x1d4f75], [0.7, 0x7cc8ee], [0.9, 0xdff5ff], [1, 0x2a5f88]],
  synthwave: [[0, 0x1a0638], [0.28, 0x7a2bd6], [0.46, 0xff9ee6], [0.5, 0xffffff], [0.505, 0x240a3c], [0.68, 0xff3f8e], [0.88, 0xffc46b], [1, 0x3a0a40]],
  copper: [[0, 0x2a0e04], [0.3, 0xa8502a], [0.46, 0xffd0b0], [0.5, 0xffffff], [0.505, 0x3a1606], [0.7, 0xc06030], [0.9, 0xffc090], [1, 0x4a1a08]],
  holo: [[0, 0x7fd7ff], [0.2, 0xc6a6ff], [0.4, 0xffb0e0], [0.5, 0xffffff], [0.6, 0xfff2a8], [0.75, 0xa8ffd8], [0.9, 0x8fc8ff], [1, 0xd8a8ff]],
};
const hexInt = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); return m ? parseInt(m[1], 16) : 0; };
const mixInt = (a, b, t) => {
  let o = 0;
  for (let k = 16; k >= 0; k -= 8) o |= Math.round(((a >> k) & 255) + (((b >> k) & 255) - ((a >> k) & 255)) * t) << k;
  return o;
};
// The colour ramp of a material (max. 8 stops – the GPU shader uses the same table). "custom" is built from
// four colours; the horizon setting moves the sky/ground border (0.5 in the base ramps) for every material.
function rampFor(p) {
  let r;
  if (p.material === "custom") {
    const top = hexInt(p.skyTop), hor = hexInt(p.skyHorizon), gh = hexInt(p.groundHorizon), gb = hexInt(p.groundBottom);
    r = [[0, top], [0.28, mixInt(top, hor, 0.55)], [0.46, hor], [0.5, mixInt(hor, 0xffffff, 0.7)], [0.505, mixInt(gh, 0x000000, 0.65)],
      [0.68, gh], [0.88, mixInt(gh, 0xffffff, 0.45)], [1, gb]];
  } else r = RAMPS[p.material] || RAMPS.chrome;
  const hz = Math.max(0.15, Math.min(0.85, (p.horizon === undefined ? 50 : p.horizon) / 100));
  if (Math.abs(hz - 0.5) < 1e-6) return r;
  return r.map(([u, c]) => [u <= 0.5 ? u * 2 * hz : hz + (u - 0.5) * 2 * (1 - hz), c]);
}

function params(p) {
  const P = Object.assign({}, DEFAULTS, p || {});
  // percent -> fractions used by the math
  return Object.assign({}, P, {
    _depth: P.depth / 100, _vpX: P.vpX / 100, _vpY: P.vpY / 100, _bevel: P.bevel / 100,
    _edge: P.edgeLine / 100, _stroke: P.stroke / 100, _stroke2: (P.stroke2 || 0) / 100, _shX: P.shadowX / 100, _shY: P.shadowY / 100,
  });
}

// ---------------------------------------------------------------- distance fields
const INF = 1e20;
function edt(w, h, seedIsZero) {
  const N = w * h, M = Math.max(w, h);
  const f = new Float64Array(M), d = new Float64Array(M), v = new Int32Array(M), z = new Float64Array(M + 1);
  const g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = seedIsZero(i) ? 0 : INF;
  const pass = (n, base, stride) => {
    for (let q = 0; q < n; q++) f[q] = g[base + q * stride];
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    for (let q = 0; q < n; q++) g[base + q * stride] = d[q];
  };
  for (let x = 0; x < w; x++) pass(h, x, w);
  for (let y = 0; y < h; y++) pass(w, y * w, 1);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

function blur(src, w, h, r) {
  r = Math.max(1, Math.round(r));
  const N = w * h, tmp = new Float32Array(N), out = new Float32Array(src);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += out[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += out[row + Math.min(w - 1, x + r + 1)] - out[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- layout: text box, vanishing point, canvas expansion
// alpha0: Uint8Array w0*h0. Returns the box of the shape and how much room the effect needs on each side.
function layout(alpha0, w0, h0, p) {
  const P = params(p);
  let bx0 = w0, by0 = h0, bx1 = -1, by1 = -1;
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) if (alpha0[y * w0 + x] >= 128) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  if (bx1 < 0) return null;
  const textW = Math.max(1, bx1 - bx0), textH = Math.max(1, by1 - by0);
  const vpx = bx0 + P._vpX * textW, vpy = by0 + P._vpY * textH, s = P._depth;
  const margin = Math.ceil((P._stroke + P._stroke2 + Math.max(Math.abs(P._shX), Math.abs(P._shY))) * textH) + 4;
  let ex0 = bx0, ey0 = by0, ex1 = bx1, ey1 = by1;
  for (const [cx, cy] of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]]) {
    const px = cx + (vpx - cx) * s, py = cy + (vpy - cy) * s;
    ex0 = Math.min(ex0, px); ey0 = Math.min(ey0, py); ex1 = Math.max(ex1, px); ey1 = Math.max(ey1, py);
  }
  return {
    box: { x0: bx0, y0: by0, x1: bx1, y1: by1, w: textW, h: textH },
    vp: { x: vpx, y: vpy },
    // extra pixels needed outside the given area on each side
    need: {
      left: Math.max(0, Math.ceil(margin - ex0)), top: Math.max(0, Math.ceil(margin - ey0)),
      right: Math.max(0, Math.ceil(ex1 + margin - (w0 - 1))), bottom: Math.max(0, Math.ceil(ey1 + margin - (h0 - 1))),
    },
  };
}

// Pads alpha by the given amounts (pixels). Returns { alpha, w, h }.
function pad(alpha0, w0, h0, l, t, r, b) {
  const w = w0 + l + r, h = h0 + t + b, out = new Uint8Array(w * h);
  for (let y = 0; y < h0; y++) out.set(alpha0.subarray(y * w0, (y + 1) * w0), (y + t) * w + l);
  return { alpha: out, w, h };
}

// Distance fields for one source (independent of most parameters; reused by preview and render).
function fields(alpha, w, h, textH) {
  const N = w * h;
  const inside = (i) => alpha[i] >= 128;
  const dIn = edt(w, h, (i) => !inside(i));
  const dOut = edt(w, h, (i) => inside(i));
  const sdf = new Float32Array(N);
  for (let i = 0; i < N; i++) sdf[i] = dOut[i] - dIn[i];
  const scale = textH / 300;
  return { dIn, dOut, sdfS: blur(sdf, w, h, 2.5 * scale), scale };
}

function rampColor(ramp, u, out) {
  u = Math.max(0, Math.min(1, u));
  let i = 0;
  while (i < ramp.length - 2 && u > ramp[i + 1][0]) i++;
  const [u0, c0] = ramp[i], [u1, c1] = ramp[i + 1];
  const t = (u - u0) / Math.max(1e-6, u1 - u0);
  for (let ch = 0; ch < 3; ch++) {
    const a = (c0 >> (16 - ch * 8)) & 255, b = (c1 >> (16 - ch * 8)) & 255;
    out[ch] = a + (b - a) * t;
  }
}

// ---------------------------------------------------------------- Chrome Extrude
// alpha (already padded so the effect fits), w, h. box/vp from layout() in the SAME coordinates.
// Returns straight-alpha RGBA (Uint8ClampedArray).
function renderChromeExtrude(alpha, w, h, box, vp, p, F) {
  const P = params(p);
  const N = w * h;
  F = F || fields(alpha, w, h, box.h);
  const { dIn, dOut, sdfS } = F;
  const textH = box.h, top = box.y0, scale = textH / 300;
  const B = Math.max(2, P._bevel * textH);
  const height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = dIn[i] / B;
    height[i] = d >= 1 ? 1 : P.profile === "round" ? Math.sqrt(1 - (1 - d) * (1 - d)) : d;
  }
  const heightS = blur(height, w, h, Math.max(1, B * (P.profile === "round" ? 0.18 : 0.08)));
  const ramp = rampFor(P);
  const solidSide = P.sideMode === "solid", sc1 = hexInt(P.sideColor), sc2 = hexInt(P.sideColor2);
  const specK = (P.shine === undefined ? 70 : P.shine) / 100 * 2;

  const bil = (f, x, y) => {
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * w + xi;
    const a = f[i] + (f[i + 1] - f[i]) * fx, b = f[i + w] + (f[i + w + 1] - f[i + w]) * fx;
    return a + (b - a) * fy;
  };
  const near = (f, x, y) => f[Math.max(0, Math.min(h - 1, Math.round(y))) * w + Math.max(0, Math.min(w - 1, Math.round(x)))];

  // side walls: march toward the vanishing point
  const vpx = vp.x, vpy = vp.y, s = P._depth;
  const sideT = new Float32Array(N).fill(-1), sideX = new Float32Array(N), sideY = new Float32Array(N);
  const capHit = new Uint8Array(N);
  if (s > 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let t = 0.0005;
        for (;;) {
          const tt = Math.min(t, 1), k = 1 - tt * s;
          const px = (x - vpx * tt * s) / k, py = (y - vpy * tt * s) / k;
          const cx = Math.max(0, Math.min(w - 1, px)), cy = Math.max(0, Math.min(h - 1, py));
          const off = Math.hypot(px - cx, py - cy);
          const d = Math.max(off, near(dOut, cx, cy) - off);
          if (d < 0.75 && off === 0) {
            sideT[i] = tt; sideX[i] = px; sideY[i] = py;
            if (t >= 1) capHit[i] = 1;
            break;
          }
          if (t >= 1) break;
          const speed = s * Math.hypot(vpx - px, vpy - py) / k;
          t += Math.max(0.0015, (d * 0.9) / Math.max(speed, 1e-3));
        }
      }
    }
  }

  const L = [-0.45, -0.75, 0.48];
  const ln = Math.hypot(L[0], L[1], L[2]); L[0] /= ln; L[1] /= ln; L[2] /= ln;
  const col = [0, 0, 0], col2 = [0, 0, 0];
  const oR = new Float32Array(N), oG = new Float32Array(N), oB = new Float32Array(N), cov = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = alpha[i] / 255;
      let r = 0, g = 0, b = 0, c = 0;
      if (sideT[i] >= 0) {
        const t = sideT[i], px = sideX[i], py = sideY[i];
        let nx = bil(sdfS, px + 1, py) - bil(sdfS, px - 1, py);
        let ny = bil(sdfS, px, py + 1) - bil(sdfS, px, py - 1);
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        if (capHit[i]) { nx = 0; ny = 0; }
        const lam = Math.max(0, nx * L[0] + ny * L[1]);
        if (solidSide) { const c = mixInt(sc1, sc2, t); col[0] = (c >> 16) & 255; col[1] = (c >> 8) & 255; col[2] = c & 255; }
        else rampColor(ramp, 0.5 + 0.32 * ny + 0.22 * t, col);
        const shade = capHit[i] ? 0.35 : (0.45 + 0.75 * lam) * (1 - 0.45 * t);
        r = col[0] * shade; g = col[1] * shade; b = col[2] * shade; c = 1;
      }
      if (a > 0) {
        let nx = -(bil(heightS, x + 1, y) - bil(heightS, x - 1, y)) * B * 0.5;
        let ny = -(bil(heightS, x, y + 1) - bil(heightS, x, y - 1)) * B * 0.5;
        let nz = 1;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        rampColor(ramp, (y - top) / textH + ny * 0.55, col2);
        const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
        const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 60) * specK;
        const edge = 1 - P._edge * (1 - Math.min(1, Math.max(0, (dIn[i] - 0.5) / (1.5 * Math.max(1, scale)))));
        const fr = Math.min(255, (col2[0] + 255 * spec) * edge), fg = Math.min(255, (col2[1] + 255 * spec) * edge), fb = Math.min(255, (col2[2] + 255 * spec) * edge);
        r = r * (1 - a) + fr * a; g = g * (1 - a) + fg * a; b = b * (1 - a) + fb * a;
        c = Math.max(c, a);
      }
      oR[i] = r; oG[i] = g; oB[i] = b; cov[i] = c;
    }
  }

  // outline + hard shadow around the whole silhouette
  const uOut = edt(w, h, (i) => cov[i] >= 0.5);
  const sw = Math.max(1.5, P._stroke * textH);
  const sw2 = P._stroke2 > 0 ? Math.max(1, P._stroke2 * textH) : 0, swAll = (P.stroke > 0 ? sw : 0) + sw2;
  const toRgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const cStroke = toRgb(hexInt(P.strokeColor)), cStroke2 = toRgb(hexInt(P.stroke2Color)), cShadow = toRgb(hexInt(P.shadowColor));
  const shOp = (P.shadowOpacity === undefined ? 85 : P.shadowOpacity) / 100;
  const sx = Math.round(P._shX * textH), sy = Math.round(P._shY * textH);
  const out = new Uint8ClampedArray(N * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let shadowA = 0;
      const sxp = x - sx, syp = y - sy;
      if (P.stroke > 0 || P.shadowX || P.shadowY) {
        if (sxp >= 0 && syp >= 0 && sxp < w && syp < h && (sx || sy)) shadowA = Math.max(0, Math.min(1, Math.max(sw, swAll) + 1 - uOut[syp * w + sxp]));
      }
      const stroke2A = sw2 > 0 ? Math.max(0, Math.min(1, swAll + 0.5 - uOut[i])) : 0;
      const strokeA = P.stroke > 0 ? Math.max(0, Math.min(1, sw + 0.5 - uOut[i])) : 0;
      let r = 0, g = 0, b = 0, A = 0;
      const over = (cr, cg, cb, ca) => { r = r * (1 - ca) + cr * ca; g = g * (1 - ca) + cg * ca; b = b * (1 - ca) + cb * ca; A = A + ca * (1 - A); };
      if (shadowA > 0) over(cShadow[0], cShadow[1], cShadow[2], shadowA * shOp);
      if (stroke2A > 0) over(cStroke2[0], cStroke2[1], cStroke2[2], stroke2A);
      if (strokeA > 0) over(cStroke[0], cStroke[1], cStroke[2], strokeA);
      if (cov[i] > 0) over(oR[i], oG[i], oB[i], cov[i]);
      out[i * 4] = A > 0 ? r / A : 0;
      out[i * 4 + 1] = A > 0 ? g / A : 0;
      out[i * 4 + 2] = A > 0 ? b / A : 0;
      out[i * 4 + 3] = A * 255;
    }
  }
  return out;
}

// One-stop helper: alpha of the source area in, everything needed for placing the result out.
// Returns { rgba, w, h, offsetX, offsetY } where offset = how far the result extends left/top of the input area.
function renderFromAlpha(alpha0, w0, h0, p) {
  const lay = layout(alpha0, w0, h0, p);
  if (!lay) return null;
  const n = lay.need;
  const padded = pad(alpha0, w0, h0, n.left, n.top, n.right, n.bottom);
  const box = Object.assign({}, lay.box, { x0: lay.box.x0 + n.left, y0: lay.box.y0 + n.top, x1: lay.box.x1 + n.left, y1: lay.box.y1 + n.top });
  const vp = { x: lay.vp.x + n.left, y: lay.vp.y + n.top };
  const rgba = renderChromeExtrude(padded.alpha, padded.w, padded.h, box, vp, p);
  return { rgba, w: padded.w, h: padded.h, offsetX: n.left, offsetY: n.top, box, vp };
}

const EFFECTS = [{ id: "chromeExtrude", name: "Chrome Extrude" }];
const MATERIALS = [{ id: "chrome", name: "Chrome" }, { id: "gold", name: "Gold" }, { id: "silver", name: "Silver" }, { id: "rosegold", name: "Rose Gold" },
  { id: "copper", name: "Copper" }, { id: "blackchrome", name: "Black Chrome" }, { id: "ice", name: "Ice" }, { id: "synthwave", name: "Synthwave" },
  { id: "holo", name: "Holographic" }, { id: "custom", name: "Custom colours" }];
const PROFILES = [{ id: "chamfer", name: "Chamfer" }, { id: "round", name: "Round" }];

module.exports = { DEFAULTS, RAMPS, EFFECTS, MATERIALS, PROFILES, params, layout, pad, fields, renderChromeExtrude, renderFromAlpha, edt, blur, rampColor, rampFor, hexInt };
