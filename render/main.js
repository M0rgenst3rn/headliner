"use strict";
// MS Render – Photoshop UXP panel.
// Source layer (live text / shape / pixels) goes into a group "MS Render · <name>" together with the
// rendered layer (named after the effect). Depending on the effect the render replaces the look
// (source hidden), sits behind the source (shadow, glow, fire …) or on top of it (drips, snow …).
// Settings live in the rendered layer's XMP, so selecting the group later restores them.
// The WebView shows the live preview (GPU for Chrome Extrude, CPU engine for the rest) and renders
// the gallery thumbnails.

const { app, core, action, imaging, constants } = require("photoshop");
const { batchPlay } = action;
const FX = require("./effects.js");
const lfs = require("uxp").storage.localFileSystem;

const $ = (id) => document.getElementById(id);
const STORE_KEY = "msrender.state.v2";
const GROUP_PREFIX = "MS Render · ";
const HIST = "MS Render";
const XMP_NS = "http://ms-render/1.0/";
const RENDER_NAMES = new Set(FX.EFFECTS.map((e) => e.name));
const PALETTE = ["#ff3fa4", "#ffb000", "#ffe14a", "#4dff5c", "#00e5ff", "#3d7bff", "#b45cff", "#ffffff", "#1a0a2e", "#000000"];
const THUMB = { tw: 200, th: 124 };

let state = loadState();
let busy = false;
let loadingFromLayer = false;
const ctl = {};

function loadState() {
  const d = { effect: "chromeExtrude", fx: {}, expandCanvas: true };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    const o = Object.assign(d, s);
    if (!FX.BY_ID[o.effect]) o.effect = "chromeExtrude";
    return o;
  } catch (e) { return d; }
}
function saveState() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
const fxDef = () => FX.BY_ID[state.effect];
function curValues() { return FX.values(state.effect, state.fx[state.effect]); }
function setValues(upd) { state.fx[state.effect] = Object.assign(curValues(), upd); }
function renderParams() { return { effect: state.effect, values: curValues(), expandCanvas: !!state.expandCanvas }; }
const paramsKey = (p) => JSON.stringify({ effect: p.effect, values: FX.values(p.effect, p.values) });

// ---------------------------------------------------------------- helpers
function setStatus(msg, isErr) { const el = $("status"); el.textContent = msg || ""; el.className = isErr ? "status err" : "status"; }
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const TARGET = [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
async function selectLayer(id) { await batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false }], {}); }
function to8bit(data, cs) {
  if (cs === 8) return data;
  const out = new Uint8Array(data.length), f = cs === 16 ? 255 / 32768 : 255;
  for (let i = 0; i < data.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(data[i] * f)));
  return out;
}
function fromBuf8(buf, doc) {
  const depth = String(doc.bitsPerChannel || "");
  if (depth.indexOf("16") >= 0) { const o = new Uint16Array(buf.length); for (let i = 0; i < buf.length; i++) o[i] = Math.round(buf[i] * 32768 / 255); return o; }
  if (depth.indexOf("32") >= 0) { const o = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) o[i] = buf[i] / 255; return o; }
  return buf;
}
function boundsOf(layer) {
  const b = layer.boundsNoEffects || layer.bounds;
  return { left: Math.floor(b.left), top: Math.floor(b.top), right: Math.ceil(b.right), bottom: Math.ceil(b.bottom) };
}
function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); }
const isGroup = (l) => !!(l && l.layers);
const isRenderGroup = (l) => isGroup(l) && String(l.name).startsWith(GROUP_PREFIX);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- log
const logLines = [];
let logTimer = null;
function log(msg, data) {
  logLines.push(new Date().toISOString() + " " + msg + (data !== undefined ? " " + JSON.stringify(data) : ""));
  if (logLines.length > 800) logLines.splice(0, logLines.length - 800);
  clearTimeout(logTimer);
  logTimer = setTimeout(async () => {
    try { const f = await (await lfs.getDataFolder()).createFile("render-log.txt", { overwrite: true }); await f.write(logLines.join("\n") + "\n"); } catch (e) { /* ignore */ }
  }, 300);
}

// ---------------------------------------------------------------- target resolution
// Returns { group, source, renderLayer } for the current selection.
function resolveTarget(doc) {
  const l = doc && doc.activeLayers[0];
  if (!l) return null;
  let group = null;
  if (isRenderGroup(l)) group = l;
  else if (l.parent && isRenderGroup(l.parent)) group = l.parent;
  if (group) {
    const kids = group.layers;
    const renderLayer = kids.find((k) => RENDER_NAMES.has(k.name)) || null;
    const source = kids.find((k) => !RENDER_NAMES.has(k.name)) || null;
    return { group, source, renderLayer };
  }
  if (isGroup(l)) return { group: null, source: null, renderLayer: null, error: "Select a text or shape layer (not a group)." };
  if (l.isBackgroundLayer) return { group: null, source: null, renderLayer: null, error: "The background layer can't be used. Convert it to a normal layer first." };
  return { group: null, source: l, renderLayer: null };
}
function sourceSignature(layer) {
  let text = "";
  try { text = layer.textItem ? layer.textItem.contents : ""; } catch (e) { /* not text */ }
  return JSON.stringify([layer.id, text, boundsOf(layer)]);
}

// ---------------------------------------------------------------- XMP params
function xmpFor(p) {
  const json = JSON.stringify({ effect: p.effect, values: p.values }).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:msr="${XMP_NS}"><msr:params>${json}</msr:params></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
async function writeLayerParams(layerId, p) {
  await batchPlay([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }], to: { _obj: "layer", XMPMetadataAsUTF8: xmpFor(p) } }], {});
}
async function readLayerParams(layerId) {
  try {
    const r = await batchPlay([{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }] }], {});
    const x = r && r[0] && r[0].XMPMetadataAsUTF8;
    const m = x && /<msr:params>([\s\S]*?)<\/msr:params>/.exec(x);
    if (!m) return null;
    const o = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
    // v0.1 stored the Chrome Extrude values flat
    if (!o.effect || !o.values) return { effect: "chromeExtrude", values: FX.values("chromeExtrude", o) };
    if (!FX.BY_ID[o.effect]) return null;
    return { effect: o.effect, values: FX.values(o.effect, o.values) };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- reading the source
// Reads the source layer's alpha + colours (full res or scaled). Temporarily shows a hidden source.
async function readSource(doc, layer, targetSize) {
  const b = boundsOf(layer);
  const bw = b.right - b.left, bh = b.bottom - b.top;
  if (bw <= 0 || bh <= 0) throw new Error("The layer is empty.");
  const wasHidden = !layer.visible;
  if (wasHidden) layer.visible = true;
  try {
    const opts = { documentID: doc.id, layerID: layer.id, sourceBounds: b, colorSpace: "RGB", componentSize: 8 };
    if (targetSize) opts.targetSize = targetSize;
    const res = await imaging.getPixels(opts);
    const id = res.imageData;
    const raw = to8bit(await id.getData({ chunky: true }), id.componentSize || 8);
    const w = id.width, h = id.height, n = w * h, c = id.components;
    id.dispose();
    const alpha = new Uint8Array(n), rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      alpha[i] = c >= 4 || c === 2 ? raw[i * c + c - 1] : 255;
      if (c >= 3) { rgb[i * 3] = raw[i * c]; rgb[i * 3 + 1] = raw[i * c + 1]; rgb[i * 3 + 2] = raw[i * c + 2]; }
      else rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = raw[i * c];
    }
    const sb = res.sourceBounds || b;
    return { alpha, rgb, w, h, bounds: sb, scale: w / (sb.right - sb.left) };
  } finally {
    if (wasHidden) layer.visible = false;
  }
}

// ---------------------------------------------------------------- preview (WebView)
let wv = null, wvReady = false, previewSrc = null, thumbSig = null, thumbsReceived = 0;
const wvWaiters = [];
function onWv(e) {
  let m = e.message !== undefined ? e.message : e.data;
  for (let k = 0; k < 3 && typeof m === "string"; k++) { try { m = JSON.parse(m); } catch (err) { break; } }
  if (!m) return;
  if (m.type === "ready" || m.type === "pong") wvReady = true;
  else if (m.type === "error") log("PREVIEW ERROR", m.error);
  else if (m.type === "thumb") onThumb(m);
  else if (m.type === "drag") onDrag(m);
  for (let i = wvWaiters.length - 1; i >= 0; i--) if (wvWaiters[i].match(m)) { wvWaiters[i].resolve(m); wvWaiters.splice(i, 1); }
}
function wvPost(o) { if (!wv) return; try { wv.postMessage(JSON.stringify(o)); } catch (e) { log("wvPost failed", String(e)); } }
async function initPreview() {
  wv = document.createElement("webview");
  wv.addEventListener("message", onWv);
  wv.src = "plugin:/preview/index.html";
  $("previewBox").appendChild(wv);
  for (let i = 0; i < 25 && !wvReady; i++) { wvPost({ cmd: "ping" }); await new Promise((r) => setTimeout(r, 200)); }
  log("PREVIEW", { ready: wvReady });
}

// Reads the selected layer at preview size and sends it to the WebView.
async function refreshPreviewSource() {
  if (busy) return;
  const doc = app.activeDocument;
  const clear = (text) => {
    previewSrc = null; $("sourceName").textContent = "–"; wvPost({ cmd: "clear", text });
    if (thumbSig !== "sample") { thumbSig = "sample"; requestThumbs("all"); }
  };
  if (!doc) return clear("Open a document…");
  const t = resolveTarget(doc);
  if (!t || !t.source) return clear((t && t.error) || "Select a text or shape layer…");
  $("sourceName").textContent = t.group ? t.group.name.slice(GROUP_PREFIX.length) : t.source.name;
  // Selecting an existing MS Render group restores its settings (incl. the effect)
  if (t.renderLayer && !loadingFromLayer) {
    const saved = await readLayerParams(t.renderLayer.id);
    if (saved && paramsKey(saved) !== paramsKey(renderParams())) {
      loadingFromLayer = true;
      const effChanged = saved.effect !== state.effect;
      state.effect = saved.effect;
      state.fx[saved.effect] = saved.values;
      if (effChanged) { buildControls(); markActiveEffect(); requestThumbs("presets"); }
      syncUI(); saveState();
      loadingFromLayer = false;
      setStatus(`Settings loaded from the selected group (${fxDef().name}).`);
    }
  }
  const b = boundsOf(t.source);
  const bw = b.right - b.left, bh = b.bottom - b.top;
  if (bw <= 0 || bh <= 0) return;
  const sig = sourceSignature(t.source);
  if (previewSrc && previewSrc.sig === sig) { sendPreviewParams(); return; }
  const f = Math.min(1, 380 / bw, 200 / bh);
  try {
    let a = null;
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " preview" });
      try { a = await readSource(doc, t.source, { width: Math.max(1, Math.round(bw * f)), height: Math.max(1, Math.round(bh * f)) }); }
      finally { await ctx.hostControl.resumeHistory(hid, false); }
    }, { commandName: HIST + " preview" });
    ignoreEventsUntil = Date.now() + 700;
    previewSrc = { sig };
    wvPost({ cmd: "source", w: a.w, h: a.h, alpha: b64(a.alpha), rgb: b64(a.rgb) });
    sendPreviewParams();
    // thumbnails show the user's own text (re-render only when the text/shape changed)
    const tsig = sig.replace(/^\[\d+,/, "[");
    if (thumbSig !== tsig) { thumbSig = tsig; requestThumbs("all"); }
  } catch (e) {
    wvPost({ cmd: "clear", text: "Preview not possible: " + (e.message || e) });
  }
}
function sendPreviewParams() {
  wvPost({ cmd: "params", effect: state.effect, values: curValues(), bg: Number($("bg").value) });
}

// ---------------------------------------------------------------- gallery
function requestThumbs(which) {
  const items = [];
  if (which === "all") for (const e of FX.EFFECTS) items.push({ key: "fx:" + e.id, effect: e.id, values: {} });
  for (const n of Object.keys(fxDef().presets || {})) items.push({ key: "pr:" + state.effect + ":" + n, effect: state.effect, values: fxDef().presets[n] });
  wvPost(Object.assign({ cmd: "thumbs", items }, THUMB));
}
function onThumb(m) {
  thumbsReceived++;
  const img = document.querySelector(`img[data-key="${m.key.replace(/"/g, '\\"')}"]`);
  if (img) img.src = m.url;
}
function buildGallery() {
  const grid = $("fxGrid");
  grid.innerHTML = "";
  for (const e of FX.EFFECTS) {
    const tile = document.createElement("div");
    tile.className = "fx-tile";
    tile.dataset.effect = e.id;
    tile.title = `${e.name} – click to apply`;
    tile.innerHTML = `<img data-key="fx:${e.id}" alt=""><div class="lbl">${esc(e.name)}</div>`;
    tile.addEventListener("click", () => selectEffect(e.id, true));
    grid.appendChild(tile);
  }
  markActiveEffect();
}
function buildLooks() {
  const grid = $("lookGrid");
  grid.innerHTML = "";
  const pr = fxDef().presets || {};
  $("lookTitle").textContent = `${fxDef().name} looks`;
  for (const n of Object.keys(pr)) {
    const tile = document.createElement("div");
    tile.className = "fx-tile look";
    tile.title = `${n} – click to apply`;
    tile.innerHTML = `<img data-key="${esc("pr:" + state.effect + ":" + n)}" alt=""><div class="lbl">${esc(n)}</div>`;
    tile.addEventListener("click", () => applyPreset(n));
    grid.appendChild(tile);
  }
}
function markActiveEffect() {
  for (const t of document.querySelectorAll("#fxGrid .fx-tile")) t.className = "fx-tile" + (t.dataset.effect === state.effect ? " active" : "");
  $("effectName").textContent = fxDef().name;
  $("effectMode").textContent = { replace: "replaces the look", behind: "behind the layer", above: "on top of the layer" }[fxDef().mode];
}
function hasTarget() { const doc = app.activeDocument; const t = doc && resolveTarget(doc); return !!(t && t.source); }
function selectEffect(id, apply) {
  if (!FX.BY_ID[id]) return;
  const changedEffect = id !== state.effect;
  state.effect = id;
  if (changedEffect) { buildControls(); buildLooks(); requestThumbs("presets"); }
  markActiveEffect();
  syncUI(); saveState(); sendPreviewParams();
  if (apply) {
    if (hasTarget()) applyRender("manual");
    else setStatus(`${fxDef().name} selected – select a text or shape layer, then click again or press Render.`);
  }
}
function applyPreset(n) {
  const pr = (fxDef().presets || {})[n];
  if (!pr) return;
  state.fx[state.effect] = FX.values(state.effect, pr);
  syncUI(); saveState(); sendPreviewParams();
  if (hasTarget()) applyRender("manual");
  else setStatus(`Look “${n}” loaded – select a text or shape layer to apply it.`);
}

// drag in the preview (vanishing point / direction)
const debouncedPreviewSync = debounce(() => sendPreviewParams(), 250);
function onDrag(m) {
  if (m.effect !== state.effect) return;
  setValues(m.values);
  syncUI(); saveState();
  if (m.final) debouncedPreviewSync();
  if (!loadingFromLayer && $("live").checked) debouncedLive();
}

// ---------------------------------------------------------------- final render
// Computes the rendered pixels for a source in document coordinates (cropped to the canvas).
async function computeRender(doc, source, p) {
  const a = await readSource(doc, source, null);
  const r = FX.render(a, p.effect, p.values);
  if (!r) throw new Error("The layer is empty.");
  let left = a.bounds.left - r.offsetX, top = a.bounds.top - r.offsetY;
  const dw = Math.round(Number(doc.width)), dh = Math.round(Number(doc.height));
  const x0 = Math.max(0, -left), y0 = Math.max(0, -top);
  const x1 = Math.min(r.w, dw - left), y1 = Math.min(r.h, dh - top);
  const cw = Math.max(0, x1 - x0), ch = Math.max(0, y1 - y0);
  const buf = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) buf.set(r.rgba.subarray(((y + y0) * r.w + x0) * 4, ((y + y0) * r.w + x0 + cw) * 4), y * cw * 4);
  return { buf, left: left + x0, top: top + y0, w: cw, h: ch, cropped: cw < r.w || ch < r.h };
}

// How much the canvas must grow on each side for the effect (0 if it fits)
async function canvasNeed(doc, source, p) {
  const a = await readSource(doc, source, null);
  const lay = FX.layoutFor(a.alpha, a.w, a.h, p.effect, FX.values(p.effect, p.values));
  if (!lay) return null;
  const dw = Math.round(Number(doc.width)), dh = Math.round(Number(doc.height));
  return {
    left: Math.max(0, lay.need.left - a.bounds.left), top: Math.max(0, lay.need.top - a.bounds.top),
    right: Math.max(0, a.bounds.right + lay.need.right - dw), bottom: Math.max(0, a.bounds.bottom + lay.need.bottom - dh),
  };
}

async function renderInto(ctx, doc, t, p) {
  let { group, source, renderLayer } = t;
  if (!source) throw new Error("No source layer.");
  const fx = FX.BY_ID[p.effect];
  // 1) make room on the canvas
  if (p.expandCanvas) {
    const need = await canvasNeed(doc, source, p);
    if (need && (need.right || need.bottom)) {
      await doc.resizeCanvas(Math.round(Number(doc.width)) + need.right, Math.round(Number(doc.height)) + need.bottom, constants.AnchorPosition.TOPLEFT);
    }
    if (need && (need.left || need.top)) {
      await doc.resizeCanvas(Math.round(Number(doc.width)) + need.left, Math.round(Number(doc.height)) + need.top, constants.AnchorPosition.BOTTOMRIGHT);
    }
    if (need) log("  canvas", need);
  }
  // 2) render
  const r = await computeRender(doc, source, p);
  // 3) group: source goes into "MS Render · <name>"
  if (!group) {
    await selectLayer(source.id);
    await batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" } }], {});
    await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", name: GROUP_PREFIX + source.name } }], {});
    group = doc.activeLayers[0];
  }
  if (renderLayer) await renderLayer.delete();
  await selectLayer(source.id);
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: fx.name } }], {});
  const rl = doc.activeLayers[0];
  if (r.w > 0 && r.h > 0) {
    const id = await imaging.createImageDataFromBuffer(fromBuf8(r.buf, doc), { width: r.w, height: r.h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
    try { await imaging.putPixels({ documentID: doc.id, layerID: rl.id, imageData: id, targetBounds: { left: r.left, top: r.top } }); }
    finally { id.dispose(); }
  }
  // behind-effects go below the source inside the group
  if (fx.mode === "behind") await rl.move(source, constants.ElementPlacement.PLACEAFTER);
  await writeLayerParams(rl.id, p);
  source.visible = fx.mode !== "replace";
  if (group) await selectLayer(group.id);
  rendered.set(group ? group.id : 0, sourceSignature(source));
  log("  rendered", { effect: p.effect, group: group && group.name, w: r.w, h: r.h, cropped: r.cropped });
  return { group, renderLayer: rl, r };
}

const rendered = new Map(); // groupId -> source signature at last render
let liveLast = null, livePending = false;
function historyStateId(doc) { try { return doc.activeHistoryState ? doc.activeHistoryState.id : null; } catch (e) { return null; } }

async function applyRender(mode) {
  // mode: "manual" | "live" | "auto"
  const live = mode === "live";
  if (busy) { if (live) livePending = true; return; }
  const doc = app.activeDocument;
  if (!doc) return setStatus("Open a document first.", true);
  const t = resolveTarget(doc);
  if (!t || !t.source) return setStatus((t && t.error) || "Select a text or shape layer.", true);
  busy = true;
  setStatus(live ? "Live update…" : `Rendering ${fxDef().name}…`);
  const t0 = Date.now();
  let err = null;
  const key = t.group ? t.group.id : t.source.id;
  const replaceLast = live && liveLast && liveLast.docId === doc.id && liveLast.key === key && liveLast.stateId === historyStateId(doc);
  const p = renderParams();
  log(mode.toUpperCase(), { source: t.source.name, replaceLast: !!replaceLast, effect: p.effect, values: p.values });
  let res = null;
  try {
    await core.executeAsModal(async (ctx) => {
      if (replaceLast) await batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }], {});
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: live ? HIST + " Live" : mode === "auto" ? HIST + " Update" : HIST + " " + FX.BY_ID[p.effect].name });
      try {
        const tt = replaceLast ? resolveTarget(doc) || t : t;
        res = await renderInto(ctx, doc, tt, p);
      } finally { await ctx.hostControl.resumeHistory(hid); }
    }, { commandName: HIST + " render" });
  } catch (e) { err = e.message || String(e); }
  liveLast = live && !err ? { docId: doc.id, key: res && res.group ? res.group.id : key, stateId: historyStateId(doc) } : null;
  ignoreEventsUntil = Date.now() + 800;
  busy = false;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log("  result", { err, ms: Date.now() - t0 });
  if (err) setStatus("Error: " + err, true);
  else setStatus(`${mode === "auto" ? "Updated" : FX.BY_ID[p.effect].name + " rendered"} in ${secs}s${res && res.r.cropped ? " – cropped at the canvas edge (enable “Expand canvas”)" : ""}.`);
  if (livePending && $("live").checked) { livePending = false; applyRender("live"); }
}
const debouncedLive = debounce(() => applyRender("live"), 300);

async function removeRender() {
  if (busy) return;
  const doc = app.activeDocument;
  const t = doc && resolveTarget(doc);
  if (!t || !t.group) return setStatus("Select an MS Render group to remove.", true);
  busy = true;
  try {
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " remove" });
      try {
        if (t.renderLayer) await t.renderLayer.delete();
        if (t.source) t.source.visible = true;
        await selectLayer(t.group.id);
        await batchPlay([{ _obj: "ungroupLayersEvent", _target: TARGET }], {});
        if (t.source) await selectLayer(t.source.id);
      } finally { await ctx.hostControl.resumeHistory(hid); }
    }, { commandName: HIST + " remove" });
    rendered.delete(t.group.id);
    setStatus("Removed – the original layer is back.");
    log("REMOVE", { source: t.source && t.source.name });
  } catch (e) { setStatus("Error: " + (e.message || e), true); }
  ignoreEventsUntil = Date.now() + 800;
  busy = false;
}

// ---------------------------------------------------------------- auto-update on text changes
async function checkAutoUpdate() {
  if (busy || !$("autoUpdate").checked) return;
  const doc = app.activeDocument;
  const t = doc && resolveTarget(doc);
  if (!t || !t.group || !t.source || !t.renderLayer) return;
  const last = rendered.get(t.group.id);
  const sig = sourceSignature(t.source);
  if (last === undefined) { rendered.set(t.group.id, sig); return; }
  if (sig !== last) {
    log("AUTO", { reason: "source changed" });
    const saved = await readLayerParams(t.renderLayer.id);
    if (saved && saved.effect !== state.effect) { state.effect = saved.effect; state.fx[saved.effect] = saved.values; buildControls(); buildLooks(); markActiveEffect(); syncUI(); }
    await applyRender("auto");
  }
}

// ---------------------------------------------------------------- UI
function sliderRow(parent, c) {
  const row = document.createElement("div");
  row.className = "ctl";
  row.innerHTML = `<span class="ctl-label">${esc(c.label)}</span><sp-slider class="ctl-range" min="${c.min}" max="${c.max}" step="${c.step}"></sp-slider><input class="ctl-num" type="text"><span class="ctl-unit">${c.unit || ""}</span>`;
  parent.appendChild(row);
  const range = row.querySelector(".ctl-range"), num = row.querySelector(".ctl-num");
  const onRange = () => { setValues({ [c.key]: Number(range.value) }); num.value = String(curValues()[c.key]); changed(); };
  range.addEventListener("input", onRange);
  range.addEventListener("change", onRange);
  num.addEventListener("change", () => {
    let v = parseFloat(String(num.value).replace(",", "."));
    if (isNaN(v)) v = curValues()[c.key];
    setValues({ [c.key]: Math.max(c.min, Math.min(c.max, v)) });
    syncUI(); changed();
  });
  ctl[c.key] = { type: "slider", set: (v) => { range.value = String(v); num.value = String(v); } };
}
function selectRow(parent, c) {
  const row = document.createElement("div");
  row.className = "ctl";
  row.innerHTML = `<span class="ctl-label">${esc(c.label)}</span><select class="grow">${c.options.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</select>`;
  parent.appendChild(row);
  const sel = row.querySelector("select");
  sel.addEventListener("change", () => { setValues({ [c.key]: sel.value }); changed(); });
  ctl[c.key] = { type: "select", set: (v) => { sel.value = v; } };
}
function colorRow(parent, c, allowEmpty) {
  const row = document.createElement("div");
  row.className = "ctl color-ctl";
  row.innerHTML = `<span class="ctl-label">${esc(c.label.replace(/\s*\(.*\)$/, ""))}</span><div class="swatch cur"></div><input class="hex" type="text"><div class="pal"></div>`;
  parent.appendChild(row);
  const cur = row.querySelector(".cur"), hex = row.querySelector(".hex"), pal = row.querySelector(".pal");
  const colors = allowEmpty ? [""].concat(PALETTE) : PALETTE;
  for (const col of colors) {
    const s = document.createElement("div");
    s.className = "swatch mini" + (col ? "" : " text");
    if (col) s.style.backgroundColor = col; else s.textContent = "T";
    s.title = col || "Use the layer's own colour";
    s.addEventListener("click", () => { setValues({ [c.key]: col }); syncUI(); changed(); });
    pal.appendChild(s);
  }
  hex.addEventListener("change", () => {
    let v = String(hex.value).trim();
    if (v && !v.startsWith("#")) v = "#" + v;
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) v = curValues()[c.key];
    if (!v && !allowEmpty) v = curValues()[c.key];
    setValues({ [c.key]: v.toLowerCase() });
    syncUI(); changed();
  });
  ctl[c.key] = { type: "color", set: (v) => { hex.value = v || ""; cur.style.backgroundColor = v || "transparent"; cur.textContent = v ? "" : "T"; } };
}
function buildControls() {
  const box = $("controls");
  box.innerHTML = "";
  for (const k of Object.keys(ctl)) delete ctl[k];
  const fx = fxDef();
  for (const c of fx.controls) {
    if (c.type === "slider") sliderRow(box, c);
    else if (c.type === "select") selectRow(box, c);
    else if (c.type === "color") colorRow(box, c, fx.defaults[c.key] === "");
  }
  const hints = {
    chromeExtrude: "Drag in the preview to move the vanishing point. Values in % of the text height/box.",
    shadow: "Drag in the preview to set angle and length.",
    motionTrail: "Drag in the preview to set direction and length.",
  };
  $("controlsHint").textContent = hints[fx.id] || "Sizes in % of the text height, so a look scales with your text.";
}
function buildUI() {
  buildGallery();
  buildLooks();
  buildControls();
  $("expandCanvas").addEventListener("change", (e) => { state.expandCanvas = e.target.checked; saveState(); });
  $("bg").addEventListener("change", () => sendPreviewParams());
  $("render").addEventListener("click", () => applyRender("manual"));
  $("remove").addEventListener("click", removeRender);
  $("live").addEventListener("change", (e) => { liveLast = null; if (e.target.checked) applyRender("live"); });
  $("autoUpdate").addEventListener("change", (e) => { try { localStorage.setItem("msrender.auto", e.target.checked ? "1" : "0"); } catch (err) { /* ignore */ } });
  $("resetAll").addEventListener("click", () => { delete state.fx[state.effect]; syncUI(); changed(); setStatus(`${fxDef().name} reset to defaults.`); });
  $("selfTest").addEventListener("click", runSelfTest);
  let auto = "1";
  try { auto = localStorage.getItem("msrender.auto") || "1"; } catch (e) { /* ignore */ }
  $("autoUpdate").checked = auto === "1";
  $("bg").value = "0";
}
function syncUI() {
  const v = curValues();
  for (const k of Object.keys(ctl)) ctl[k].set(v[k]);
  $("expandCanvas").checked = !!state.expandCanvas;
}
function changed() {
  saveState();
  sendPreviewParams();
  if (!loadingFromLayer && $("live").checked) debouncedLive();
}

// ---------------------------------------------------------------- self-test
async function runSelfTest() {
  if (busy || selfTestRunning) return;
  selfTestRunning = true;
  const savedState = JSON.parse(JSON.stringify(state));
  const wasLive = $("live").checked;
  $("live").checked = false;
  const results = [];
  const t0 = Date.now();
  log("SELFTEST START");
  setStatus("Self-test running… (a few minutes, please don't click)");
  let doc = null;
  const check = async (name, fn) => {
    try { const r = await fn(); results.push({ test: name, ok: !!r.ok, details: r }); }
    catch (e) { results.push({ test: name, ok: false, details: String(e && e.stack || e) }); }
    setStatus(`Self-test: ${results.length} – ${name}`);
  };
  const use = (effect, values) => { state.effect = effect; state.fx[effect] = FX.values(effect, values || {}); buildControls(); markActiveEffect(); syncUI(); };
  // Verify the current render of the selected group against a fresh CPU render
  const verify = async (expectP) => {
    const r = {};
    const fx = FX.BY_ID[expectP.effect];
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " verify" });
      try {
        const t = resolveTarget(doc);
        r.group = !!t.group; r.renderLayer = !!t.renderLayer;
        r.children = t.group ? t.group.layers.map((l) => l.name) : [];
        r.sourceVisOk = t.source ? (fx.mode === "replace" ? !t.source.visible : t.source.visible) : false;
        r.nameOk = !!t.renderLayer && t.renderLayer.name === fx.name;
        const ri = r.children.indexOf(fx.name), si = t.source ? r.children.indexOf(t.source.name) : -1;
        r.orderOk = fx.mode === "behind" ? ri > si : ri < si;   // index 0 = top
        if (t.renderLayer) {
          const saved2 = await readLayerParams(t.renderLayer.id);
          r.xmpOk = !!saved2 && paramsKey(saved2) === paramsKey(expectP);
          const exp = await computeRender(doc, t.source, expectP);
          const got = await imaging.getPixels({ documentID: doc.id, layerID: t.renderLayer.id, sourceBounds: { left: exp.left, top: exp.top, right: exp.left + exp.w, bottom: exp.top + exp.h }, colorSpace: "RGB", componentSize: 8 });
          const gd = to8bit(await got.imageData.getData({ chunky: true }), got.imageData.componentSize || 8);
          const gb = got.sourceBounds, gw = got.imageData.width, gh = got.imageData.height, gc = got.imageData.components;
          got.imageData.dispose();
          let diff = 0, n = 0;
          for (let y = 0; y < exp.h; y++) for (let x = 0; x < exp.w; x++) {
            const ea = exp.buf[(y * exp.w + x) * 4 + 3];
            const gx = exp.left + x - gb.left, gy = exp.top + y - gb.top;
            const ga = gx >= 0 && gy >= 0 && gx < gw && gy < gh ? (gc >= 4 ? gd[(gy * gw + gx) * gc + 3] : 255) : 0;
            if (ea > 8 || ga > 8) { n++; if (Math.abs(ea - ga) > 64) diff++; }
          }
          r.pixels = n;
          r.pixelDiffPct = n ? Math.round(diff / n * 1000) / 10 : 100;
          r.renderW = exp.w;
        }
      } finally { await ctx.hostControl.resumeHistory(hid, false); }
    }, { commandName: HIST + " verify" });
    r.ok = r.group && r.renderLayer && r.nameOk && r.orderOk && r.sourceVisOk && r.xmpOk && r.pixels > 0 && r.pixelDiffPct <= 1 && r.children.length === 2;
    return r;
  };
  const renderAndVerify = async (effect, values) => { use(effect, values); await applyRender("manual"); return verify(renderParams()); };
  try {
    await core.executeAsModal(async () => {
      doc = await app.documents.add({ width: 1400, height: 700, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MS Render Self-test" });
      await batchPlay([{ _obj: "make", _target: [{ _ref: "textLayer" }], using: { _obj: "textLayer", textKey: "RETRO",
        textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: 22 }, vertical: { _unit: "percentUnit", _value: 55 } },
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: 5, textStyle: { _obj: "textStyle", size: { _unit: "pointsUnit", _value: 170 }, color: { _obj: "RGBColor", red: 230, grain: 40, blue: 120 } } }] } }], {});
    }, { commandName: HIST + " self-test setup" });

    // every effect with its defaults (also switches the effect of the same group each time)
    for (const e of FX.EFFECTS) await check(`Effect ${e.name} (default)`, () => renderAndVerify(e.id, {}));
    // every preset of every effect
    for (const e of FX.EFFECTS) for (const n of Object.keys(e.presets || {})) {
      if (!Object.keys(e.presets[n]).length) continue; // same as default
      await check(`Look ${e.name} › ${n}`, () => renderAndVerify(e.id, e.presets[n]));
    }
    await check("Gallery thumbnails arrived", async () => {
      const before = thumbsReceived;
      thumbSig = null; requestThumbs("all");
      const want = FX.EFFECTS.length + Object.keys(fxDef().presets || {}).length;
      for (let i = 0; i < 60 && thumbsReceived - before < want; i++) await new Promise((r) => setTimeout(r, 250));
      const imgs = Array.from(document.querySelectorAll("#fxGrid img")).filter((i) => String(i.src || "").startsWith("data:image/png")).length;
      return { ok: thumbsReceived - before >= want && imgs === FX.EFFECTS.length, received: thumbsReceived - before, want, imgs };
    });
    await check("Gallery click applies the effect", async () => {
      use("chromeExtrude", {});
      await applyRender("manual");
      selectEffect("glow", true);
      for (let i = 0; i < 40 && (busy || state.effect !== "glow"); i++) await new Promise((r) => setTimeout(r, 100));
      while (busy) await new Promise((r) => setTimeout(r, 100));
      return verify(renderParams());
    });
    await check("Preview drag updates the values", async () => {
      use("shadow", {});
      onDrag({ type: "drag", effect: "shadow", values: { angle: 120, distance: 70 }, final: true });
      onDrag({ type: "drag", effect: "glow", values: { size: 99 } }); // stale effect – must be ignored
      const v = curValues();
      return { ok: v.angle === 120 && v.distance === 70 && v.size === undefined, angle: v.angle, distance: v.distance };
    });
    use("chromeExtrude", {});
    await check("Text change → auto-update", async () => {
      await applyRender("manual");
      const before = (await verify(renderParams())).renderW;
      await core.executeAsModal(async () => {
        const t = resolveTarget(doc);
        await batchPlay([{ _obj: "set", _target: [{ _ref: "textLayer", _id: t.source.id }], to: { _obj: "textLayer", textKey: "RETRO RAD" } }], {});
      }, { commandName: HIST + " test text" });
      const wasAuto = $("autoUpdate").checked;
      $("autoUpdate").checked = true;
      await checkAutoUpdate();
      $("autoUpdate").checked = wasAuto;
      const v = await verify(renderParams());
      v.before = before; v.ok = v.ok && v.renderW > before + 50;
      return v;
    });
    await check("Re-selecting the group restores effect + settings", async () => {
      use("glow", { color: "#ff2bd6", size: 30 });
      await applyRender("manual");
      use("chromeExtrude", {});
      previewSrc = null;
      await refreshPreviewSource();
      const v = curValues();
      return { ok: state.effect === "glow" && v.color === "#ff2bd6" && v.size === 30, effect: state.effect, color: v.color, size: v.size };
    });
    await check("Canvas expands when the effect doesn't fit", async () => {
      const w0 = Number(doc.width), h0 = Number(doc.height);
      state.expandCanvas = true;
      use("chromeExtrude", { depth: 50, vpX: 400, vpY: 100 });
      await applyRender("manual");
      const v = await verify(renderParams());
      v.w0 = w0; v.w1 = Number(doc.width); v.ok = v.ok && v.w1 > w0;
      use("fire", { height: 200 });
      await applyRender("manual");
      const v2 = await verify(renderParams());
      v.fireOk = v2.ok; v.h0 = h0; v.h1 = Number(doc.height);
      v.ok = v.ok && v2.ok && v.h1 > h0;
      return v;
    });
    await check("Live: several updates = one history step", async () => {
      use("chromeExtrude", {});
      liveLast = null;
      const s0 = historyStateId(doc);
      await applyRender("live");
      setValues({ material: "silver" });
      await applyRender("live");
      setValues({ material: "gold" });
      await applyRender("live");
      const states = doc.historyStates;
      const ai = states.findIndex((st) => st.id === historyStateId(doc));
      const before = ai > 0 ? states[ai - 1].id : null;
      const v = await verify(renderParams());
      return { ok: before === s0 && states[ai].name === HIST + " Live" && v.ok, s0, before, verify: v };
    });
    await check("Remove restores the original layer", async () => {
      use("shadow", {});
      await applyRender("manual");
      await removeRender();
      const groups = doc.layers.filter((l) => isRenderGroup(l)).length;
      const src = doc.layers.find((l) => l.name.startsWith("RETRO"));
      const renders = doc.layers.filter((l) => RENDER_NAMES.has(l.name)).length;
      return { ok: groups === 0 && !!src && src.visible && renders === 0, groups, renders, sourceVisible: src && src.visible };
    });
  } catch (e) {
    results.push({ test: "Aborted", ok: false, details: String(e && e.stack || e) });
  }
  state = savedState;
  $("live").checked = wasLive;
  buildControls(); buildLooks(); markActiveEffect(); syncUI(); saveState();
  const failed = results.filter((r) => !r.ok);
  log("SELFTEST RESULT", { passed: results.length - failed.length, total: results.length, seconds: Math.round((Date.now() - t0) / 1000) });
  for (const r of results) log((r.ok ? "  ✓ " : "  ✗ ") + r.test, r.ok ? undefined : r.details);
  setStatus(`Self-test: ${results.length - failed.length}/${results.length} passed` + (failed.length ? ` – failed: ${failed.map((r) => r.test).join(", ")}` : " ✓"), failed.length > 0);
  selfTestRunning = false;
  previewSrc = null;
  refreshPreviewSource();
}

// ---------------------------------------------------------------- start
let ignoreEventsUntil = 0;
let selfTestRunning = false;
const onPsEvent = debounce(async () => {
  if (busy || selfTestRunning || Date.now() < ignoreEventsUntil) return;
  await checkAutoUpdate();
  refreshPreviewSource();
}, 400);

async function init() {
  log("START", { ps: app.version, effects: FX.EFFECTS.length });
  buildUI();
  syncUI();
  await initPreview();
  try { action.addNotificationListener(["select", "make", "delete", "set", "open", "close", "move", "transform", "editTextLayer"], onPsEvent); }
  catch (e) { log("listener failed", String(e)); }
  // fallback: user text edits may not always notify – poll gently
  setInterval(() => { if (!busy && !selfTestRunning && Date.now() > ignoreEventsUntil) checkAutoUpdate(); }, 1500);
  await refreshPreviewSource();
  if (!thumbSig) { thumbSig = "sample"; requestThumbs("all"); }
}
init();
