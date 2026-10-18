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
  sideColor: "#2f74f0", sideColor2: "#0b1a4a",
  strokeColor: "#0c0a1e", stroke2: 0, stroke2Color: "#2fa8ff",   // outline + optional second outline
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
// Felzenszwalb & Huttenlocher squared distance transform, run over columns, then rows. f holds the start
// values (0 = seed, INF = not a seed). With ids, it also carries the index of the nearest seed along.
function edtCore(w, h, g, ids) {
  const M = Math.max(w, h);
  const f = new Float64Array(M), d = new Float64Array(M), v = new Int32Array(M), z = new Float64Array(M + 1);
  const fid = ids ? new Int32Array(M) : null, did = ids ? new Int32Array(M) : null;
  const pass = (n, base, stride) => {
    for (let q = 0; q < n; q++) { f[q] = g[base + q * stride]; if (ids) fid[q] = ids[base + q * stride]; }
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; if (ids) did[q] = fid[v[k]]; }
    for (let q = 0; q < n; q++) { g[base + q * stride] = d[q]; if (ids) ids[base + q * stride] = did[q]; }
  };
  for (let x = 0; x < w; x++) pass(h, x, w);
  for (let y = 0; y < h; y++) pass(w, y * w, 1);
}
// Distance from every pixel to the nearest pixel for which seedIsZero(i) is true (whole pixels).
function edt(w, h, seedIsZero) {
  const N = w * h, g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = seedIsZero(i) ? 0 : INF;
  edtCore(w, h, g, null);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

// Distance from a pixel centre to the edge of an anti-aliased shape, from the pixel's coverage a (0..1) and
// the direction (gx, gy) towards the outside. Positive when the centre lies outside the edge.
function edgeDist(gx, gy, a) {
  if (gx === 0 || gy === 0) return 0.5 - a;
  const gl = Math.sqrt(gx * gx + gy * gy);
  gx = Math.abs(gx / gl); gy = Math.abs(gy / gl);
  if (gx < gy) { const t = gx; gx = gy; gy = t; }
  const a1 = 0.5 * gy / gx;
  if (a < a1) return 0.5 * (gx + gy) - Math.sqrt(2 * gx * gy * a);
  if (a < 1 - a1) return (0.5 - a) * gx;
  return -0.5 * (gx + gy) + Math.sqrt(2 * gx * gy * (1 - a));
}
// Signed distance to the edge of a shape (negative inside), with sub-pixel precision: the soft edge pixels
// of the coverage say where the edge runs inside them. cov: Uint8Array (0..255, k = 1/255) or Float32Array
// (0..1, k = 1). One distance transform over the pixels along the edge, then each pixel measures to the
// edge inside its nearest edge pixel.
function signedDist(cov, w, h, k) {
  const N = w * h, A = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = cov[i] * k; A[i] = a < 0.002 ? 0 : a > 0.998 ? 1 : a; }
  const g = new Float64Array(N), ids = new Int32Array(N);
  let seeds = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = A[i];
    let edge = a > 0 && a < 1;
    if (!edge) {
      // a whole pixel right at a hard edge (a soft edge pixel next to it is the better seed)
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const b = A[yy * w + xx];
        if (a === 1 ? b === 0 : b === 1) { edge = true; break; }
      }
    }
    g[i] = edge ? 0 : INF; ids[i] = edge ? i : -1;
    if (edge) seeds++;
  }
  const S = new Float32Array(N);
  if (!seeds) { const v = A[0] === 1 ? -1e6 : 1e6; S.fill(v); return S; }
  edtCore(w, h, g, ids);
  // each edge pixel: outward direction (coverage gradient) and the point where the edge crosses it
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : A[y * w + x]);
  const enx = new Float32Array(N), eny = new Float32Array(N), edf = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (g[i] !== 0) continue;
    const gx = (at(x - 1, y - 1) + 1.41421356 * at(x - 1, y) + at(x - 1, y + 1)) - (at(x + 1, y - 1) + 1.41421356 * at(x + 1, y) + at(x + 1, y + 1));
    const gy = (at(x - 1, y - 1) + 1.41421356 * at(x, y - 1) + at(x + 1, y - 1)) - (at(x - 1, y + 1) + 1.41421356 * at(x, y + 1) + at(x + 1, y + 1));
    const gl = Math.sqrt(gx * gx + gy * gy), df = edgeDist(gx, gy, A[i]);
    edf[i] = df;
    if (gl > 1e-6) { enx[i] = gx / gl; eny[i] = gy / gl; }
  }
  // distance to a short piece of the edge (half length TAU along the edge) at the nearest edge pixel:
  // exact for straight edges, round around corners, and the direction turns smoothly along curves
  const TAU = 0.6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, q = ids[i], a = A[i];
    let d;
    if (q === i) d = edf[i];
    else {
      const qx = q % w, qy = (q - qx) / w, dx = x - qx, dy = y - qy;
      let dist;
      if (enx[q] !== 0 || eny[q] !== 0) {
        // offset from the edge point (q's centre moved by its edge distance against the outward direction)
        const rx = dx + enx[q] * edf[q], ry = dy + eny[q] * edf[q];
        const l = rx * enx[q] + ry * eny[q], t = Math.max(0, Math.abs(ry * enx[q] - rx * eny[q]) - TAU);
        dist = Math.sqrt(l * l + t * t);
      } else {
        // no direction (a lone pixel): the edge lies (0.5 - a) beyond its centre
        const di = Math.sqrt(dx * dx + dy * dy);
        dist = a === 1 ? di + edgeDist(dx, dy, 1 - A[q]) : di + edgeDist(dx, dy, A[q]);
      }
      d = a === 1 ? -dist : dist;
    }
    S[i] = d;
  }
  return S;
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
// s: signed distance to the edge (negative inside), sub-pixel accurate. dIn / dOut keep their meaning
// (distance to the nearest pixel on the other side, so 1 for a pixel right at a hard edge), but they now
// change smoothly with the soft edge pixels instead of jumping in whole pixels.
function fields(alpha, w, h, textH) {
  const N = w * h;
  const s = signedDist(alpha, w, h, 1 / 255);
  const dIn = new Float32Array(N), dOut = new Float32Array(N), sdf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = s[i];
    dIn[i] = v < 0.5 ? 0.5 - v : 0; dOut[i] = v > -0.5 ? 0.5 + v : 0;
    sdf[i] = dOut[i] - dIn[i];
  }
  const scale = textH / 300;
  return { dIn, dOut, s, sdfS: blur(sdf, w, h, 2.5 * scale), scale };
}

// Distance outside a soft coverage mask (0 inside, 1 for a pixel right at a hard edge) – for outlines and
// shadows. Sub-pixel accurate, so outlines follow the anti-aliased silhouette instead of its pixel steps.
function outsideDist(cov, w, h) {
  const sd = signedDist(cov, w, h, 1), N = w * h, u = new Float32Array(N);
  for (let i = 0; i < N; i++) u[i] = sd[i] > -0.5 ? sd[i] + 0.5 : 0;
  return u;
}
// Bounds of all pixels with any alpha, grown by m and kept 1 px inside the canvas: { x0, y0, x1, y1 }
function alphaBounds(alpha, w, h, m) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { x0: 1, y0: 1, x1: 0, y1: 0 };
  return { x0: Math.max(1, x0 - m), y0: Math.max(1, y0 - m), x1: Math.min(w - 2, x1 + m), y1: Math.min(h - 2, y1 + m) };
}
// Bilinear sample of a w*h field (clamped at the borders)
function sample(f, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * w + xi;
  const a = f[i] + (f[i + 1] - f[i]) * fx, b = f[i + w] + (f[i + w + 1] - f[i + w]) * fx;
  return a + (b - a) * fy;
}

// Height of the bevelled front face (0 at the edge, 1 on the flat top), lightly smoothed.
function frontHeight(dIn, w, h, B, profile) {
  const N = w * h, height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = dIn[i] / B;
    height[i] = d >= 1 ? 1 : profile === "round" ? Math.sqrt(1 - (1 - d) * (1 - d)) : d;
  }
  return blur(height, w, h, Math.max(1, B * (profile === "round" ? 0.18 : 0.08)));
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

// Anti-aliased ramp lookup: the colour averaged over [u - fw/2, u + fw/2], where fw is how much u changes
// across one pixel. The crisp horizon (the jump in the ramp) stays a jump, but spread over one pixel
// instead of snapping per pixel into a stair-stepped line. Returns fn(u, fw, out).
function rampSampler(ramp) {
  const n = ramp.length, U = new Float64Array(n), C = new Float64Array(n * 3), I = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    U[i] = ramp[i][0];
    for (let ch = 0; ch < 3; ch++) C[i * 3 + ch] = (ramp[i][1] >> (16 - ch * 8)) & 255;
  }
  // I = integral of the ramp from U[0] to each stop
  for (let i = 1; i < n; i++) for (let ch = 0; ch < 3; ch++) I[i * 3 + ch] = I[(i - 1) * 3 + ch] + (U[i] - U[i - 1]) * (C[(i - 1) * 3 + ch] + C[i * 3 + ch]) * 0.5;
  const tmp = [0, 0, 0];
  // integral from U[0] to u (the ramp is held constant outside its ends)
  const integ = (u, o) => {
    if (u <= U[0]) { for (let ch = 0; ch < 3; ch++) o[ch] = (u - U[0]) * C[ch]; return; }
    if (u >= U[n - 1]) { for (let ch = 0; ch < 3; ch++) o[ch] = I[(n - 1) * 3 + ch] + (u - U[n - 1]) * C[(n - 1) * 3 + ch]; return; }
    let i = 0;
    while (i < n - 2 && u > U[i + 1]) i++;
    const L = u - U[i], t = L / Math.max(1e-9, U[i + 1] - U[i]);
    for (let ch = 0; ch < 3; ch++) {
      const c0 = C[i * 3 + ch], ce = c0 + (C[(i + 1) * 3 + ch] - c0) * t;
      o[ch] = I[i * 3 + ch] + L * (c0 + ce) * 0.5;
    }
  };
  return (u, fw, out) => {
    if (!(fw > 1e-5)) { rampColor(ramp, u, out); return; }
    integ(u + fw * 0.5, out); integ(u - fw * 0.5, tmp);
    for (let ch = 0; ch < 3; ch++) out[ch] = (out[ch] - tmp[ch]) / fw;
  };
}
// How far u changes across one pixel, from the neighbours (the smaller one-sided step on each axis, so a
// crease next to the pixel does not count as change inside it). Capped so a crease never smears the ramp.
function footprint(uL, uR, uU, uD, u) {
  const fx = Math.min(Math.abs(uR - u), Math.abs(u - uL)), fy = Math.min(Math.abs(uD - u), Math.abs(u - uU));
  return Math.min(0.08, fx + fy);
}
// Specular highlight pow(nh, p) filtered over the pixel: where the normal turns a lot within one pixel the
// highlight gets a little wider and dimmer instead of sparkling (spread = variance of the normal in the
// pixel). Returns the filtered value.
function specAA(nh, p, spread) {
  if (!(spread > 1e-6)) return Math.pow(nh, p);
  const q = p / (1 + p * spread);
  return Math.pow(nh, q) * (q + 2) / (p + 2);
}
// Normal variance inside a pixel from the normals of its 4 neighbours (unit vectors)
function normalSpread(n, i, w) {
  let s = 0;
  for (let c = 0; c < 3; c++) {
    const dx = (n[(i + 1) * 3 + c] - n[(i - 1) * 3 + c]) * 0.5, dy = (n[(i + w) * 3 + c] - n[(i - w) * 3 + c]) * 0.5;
    s += dx * dx + dy * dy;
  }
  return s / 12;
}

// ---------------------------------------------------------------- Chrome Extrude
// Sub-pixel positions for the extra samples on edge pixels (8 samples, each row and column used once)
const SS8 = [[1, -3], [-1, 3], [5, 1], [-3, -5], [-5, 5], [-7, -1], [3, 7], [7, -7]].map(([x, y]) => [x / 16, y / 16]);

// alpha (already padded so the effect fits), w, h. box/vp from layout() in the SAME coordinates.
// Returns straight-alpha RGBA (Uint8ClampedArray).
function renderChromeExtrude(alpha, w, h, box, vp, p, F) {
  const P = params(p);
  const N = w * h;
  F = F || fields(alpha, w, h, box.h);
  const { dIn, sdfS } = F, S = F.s;
  const textH = box.h, top = box.y0, scale = textH / 300;
  const B = Math.max(2, P._bevel * textH);
  const heightS = frontHeight(dIn, w, h, B, P.profile);
  const ramp = rampFor(P), rampAA = rampSampler(ramp);
  const solidSide = P.sideMode === "solid", sc1 = hexInt(P.sideColor), sc2 = hexInt(P.sideColor2);
  const specK = (P.shine === undefined ? 70 : P.shine) / 100 * 2;

  const bil = (f, x, y) => {
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * w + xi;
    const a = f[i] + (f[i + 1] - f[i]) * fx, b = f[i + w] + (f[i + w + 1] - f[i + w]) * fx;
    return a + (b - a) * fy;
  };

  // ---- side walls: march from a screen point toward the vanishing point until the ray enters the shape.
  // The shape is sampled smoothly (bilinear signed distance), so a hit is found within a fraction of a pixel.
  const L = [-0.45, -0.75, 0.48];
  const ln = Math.hypot(L[0], L[1], L[2]); L[0] /= ln; L[1] /= ln; L[2] /= ln;
  const vpx = vp.x, vpy = vp.y, s = P._depth;
  const col = [0, 0, 0], wc = [0, 0, 0];
  // wall colour at a screen point -> wc (RGB), returns 0 = nothing, 1 = wall, 2 = back cap
  const wallAt = (x, y) => {
    if (s <= 0) return 0;
    let t = 0.0005;
    for (;;) {
      const tt = t < 1 ? t : 1, k = 1 - tt * s;
      const px = (x - vpx * tt * s) / k, py = (y - vpy * tt * s) / k;
      let d;
      if (px >= 0 && py >= 0 && px <= w - 1.001 && py <= h - 1.001) {
        d = bil(S, px, py);
        if (d < 0) {
          const cap = t >= 1;
          let nx = 0, ny = 0;
          if (!cap) {
            nx = bil(sdfS, px + 1, py) - bil(sdfS, px - 1, py);
            ny = bil(sdfS, px, py + 1) - bil(sdfS, px, py - 1);
            const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
          }
          const lam = Math.max(0, nx * L[0] + ny * L[1]);
          if (solidSide) { const c = mixInt(sc1, sc2, tt); col[0] = (c >> 16) & 255; col[1] = (c >> 8) & 255; col[2] = c & 255; }
          else rampColor(ramp, 0.5 + 0.32 * ny + 0.22 * tt, col);
          const shade = cap ? 0.35 : (0.45 + 0.75 * lam) * (1 - 0.45 * tt);
          wc[0] = col[0] * shade; wc[1] = col[1] * shade; wc[2] = col[2] * shade;
          return cap ? 2 : 1;
        }
      } else {
        const cx = Math.max(0, Math.min(w - 1, px)), cy = Math.max(0, Math.min(h - 1, py));
        const off = Math.hypot(px - cx, py - cy);
        d = Math.max(off, S[Math.round(cy) * w + Math.round(cx)] - off);
      }
      if (t >= 1) return 0;
      const speed = s * Math.hypot(vpx - px, vpy - py) / k;
      t += Math.max(0.0015, (d * 0.9 + 0.02) / Math.max(speed, 1e-3));
    }
  };

  // pass 1: one ray through each pixel centre that is not fully covered by the front face.
  // kind: 0 = nothing, 1 = wall, 2 = cap, 3 = centre lies under the front's soft edge, 4 = front covers it
  const kind = new Uint8Array(N), wR = new Float32Array(N), wG = new Float32Array(N), wB = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (alpha[i] === 255) { kind[i] = 4; continue; }
    if (S[i] < 0) { kind[i] = 3; continue; }
    const k = wallAt(x, y);
    kind[i] = k;
    if (k) { wR[i] = wc[0]; wG[i] = wc[1]; wB[i] = wc[2]; }
  }
  // pass 2: pixels where the walls change abruptly (silhouettes, wall over wall, sharp corners) and pixels
  // under the front's soft edge get 8 rays; their wall coverage becomes a fraction.
  const cw = new Float32Array(N), edge = new Uint8Array(N);
  const diff = (i, j) => {
    const ki = kind[i], kj = kind[j];
    if (kj >= 3) return false;
    if (ki !== kj) return true;
    return ki !== 0 && Math.max(Math.abs(wR[i] - wR[j]), Math.abs(wG[i] - wG[j]), Math.abs(wB[i] - wB[j])) > 20;
  };
  // find the edge pixels first (on the pass-1 colours), then resample them
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, ki = kind[i];
    if (ki === 4) continue;
    edge[i] = ki === 3 || (x > 0 && diff(i, i - 1)) || (x < w - 1 && diff(i, i + 1)) || (y > 0 && diff(i, i - w)) || (y < h - 1 && diff(i, i + w)) ? 1 : 0;
    if (!edge[i]) cw[i] = ki ? 1 : 0;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!edge[i]) continue;
    let r = 0, g = 0, b = 0, hit = 0, n = 0;
    for (const [ox, oy] of SS8) {
      const sx = x + ox, sy = y + oy;
      if (bil(S, sx, sy) < 0) continue;          // this part of the pixel belongs to the front face
      n++;
      if (wallAt(sx, sy)) { r += wc[0]; g += wc[1]; b += wc[2]; hit++; }
    }
    // straight colour + coverage of the walls in the part of the pixel the front leaves open
    if (hit) { wR[i] = r / hit; wG[i] = g / hit; wB[i] = b / hit; }
    cw[i] = n ? hit / n : 0;
  }

  // ---- front face: bevel normals from the smoothed height, ramp reflection, highlight, dark edge line
  // normals of the front (and one pixel around it) first, so each pixel can see how fast they change
  const nrm = new Float32Array(N * 3), U = new Float32Array(N);
  const { x0, y0, x1, y1 } = alphaBounds(alpha, w, h, 2);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    let nx = -(heightS[i + 1] - heightS[i - 1]) * B * 0.5;
    let ny = -(heightS[i + w] - heightS[i - w]) * B * 0.5;
    const nl = Math.hypot(nx, ny, 1);
    nrm[i * 3] = nx / nl; nrm[i * 3 + 1] = ny / nl; nrm[i * 3 + 2] = 1 / nl;
    U[i] = (y - top) / textH + (ny / nl) * 0.55;
  }
  const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
  const oR = new Float32Array(N), oG = new Float32Array(N), oB = new Float32Array(N), cov = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = alpha[i] / 255;
      // walls (premultiplied by their coverage)
      let c = cw[i], r = wR[i] * c, g = wG[i] * c, b = wB[i] * c;
      if (a > 0) {
        const inBox = x >= x0 + 1 && x <= x1 - 1 && y >= y0 + 1 && y <= y1 - 1;
        const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
        const u = U[i];
        rampAA(u, inBox ? footprint(U[i - 1], U[i + 1], U[i - w], U[i + w], u) : 0, col);
        const nh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl);
        const spec = specAA(nh, 60, inBox ? normalSpread(nrm, i, w) : 0) * specK;
        const edge = 1 - P._edge * (1 - Math.min(1, Math.max(0, (dIn[i] - 0.5) / (1.5 * Math.max(1, scale)))));
        const fr = Math.min(255, (col[0] + 255 * spec) * edge), fg = Math.min(255, (col[1] + 255 * spec) * edge), fb = Math.min(255, (col[2] + 255 * spec) * edge);
        r = r * (1 - a) + fr * a; g = g * (1 - a) + fg * a; b = b * (1 - a) + fb * a;
        c = c * (1 - a) + a;
      }
      // back to straight colour
      if (c > 0) { oR[i] = r / c; oG[i] = g / c; oB[i] = b / c; }
      cov[i] = c;
    }
  }

  // outline + hard shadow around the whole silhouette (sub-pixel distance to the soft silhouette)
  const uOut = outsideDist(cov, w, h);
  const sw = Math.max(1.5, P._stroke * textH);
  const sw2 = P._stroke2 > 0 ? Math.max(1, P._stroke2 * textH) : 0, swAll = (P.stroke > 0 ? sw : 0) + sw2;
  const toRgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const cStroke = toRgb(hexInt(P.strokeColor)), cStroke2 = toRgb(hexInt(P.stroke2Color)), cShadow = toRgb(hexInt(P.shadowColor));
  const shOp = (P.shadowOpacity === undefined ? 85 : P.shadowOpacity) / 100;
  const sx = P._shX * textH, sy = P._shY * textH;
  const out = new Uint8ClampedArray(N * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let shadowA = 0;
      const sxp = x - sx, syp = y - sy;
      if (P.stroke > 0 || P.shadowX || P.shadowY) {
        if (sxp > -1 && syp > -1 && sxp < w && syp < h && (sx || sy)) shadowA = Math.max(0, Math.min(1, Math.max(sw, swAll) + 1 - bil(uOut, sxp, syp)));
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

module.exports = { DEFAULTS, RAMPS, EFFECTS, MATERIALS, PROFILES, params, layout, pad, fields, frontHeight, renderChromeExtrude, renderFromAlpha, edt, signedDist, outsideDist, sample, alphaBounds, blur,
  rampColor, rampFor, rampSampler, footprint, specAA, normalSpread, hexInt };
