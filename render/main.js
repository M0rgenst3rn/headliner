"use strict";
// MS Render – Photoshop UXP panel.
// Source layer (live text / shape / pixels) goes into a group "MS Render · <name>" together with the
// rendered layer "Chrome Extrude". The source stays editable (hidden); settings live in the rendered
// layer's XMP so selecting the group later restores them. GPU live preview runs in a WebView.

const { app, core, action, imaging, constants } = require("photoshop");
const { batchPlay } = action;
const E = require("./engine.js");
const lfs = require("uxp").storage.localFileSystem;

const $ = (id) => document.getElementById(id);
const STORE_KEY = "msrender.state.v1";
const GROUP_PREFIX = "MS Render · ";
const RENDER_NAME = "Chrome Extrude";
const HIST = "MS Render";
const XMP_NS = "http://ms-render/1.0/";

const PRESETS = {
  "80s Chrome": {},
  "Gold Bars": { material: "gold", vpY: -160, depth: 20 },
  "Deep Perspective": { depth: 35, vpX: 130, vpY: 200 },
  "Hero Title": { depth: 28, vpY: 320, bevel: 8, stroke: 2.5, shadowY: 4.5 },
  "Y2K Bubble": { material: "silver", profile: "round", bevel: 12, depth: 15 },
  "Flat Chrome": { depth: 0, shadowX: 3, shadowY: 3 },
};

const SLIDERS = [
  { key: "bevel", label: "Bevel", min: 0, max: 25, step: 0.5, unit: "%", parent: "secMaterial" },
  { key: "edgeLine", label: "Edge line", min: 0, max: 100, step: 1, unit: "%", parent: "secMaterial" },
  { key: "depth", label: "Depth", min: 0, max: 60, step: 1, unit: "%", parent: "secExtrude" },
  { key: "vpX", label: "Vanish X", min: -300, max: 400, step: 5, unit: "%", parent: "secExtrude" },
  { key: "vpY", label: "Vanish Y", min: -400, max: 500, step: 5, unit: "%", parent: "secExtrude" },
  { key: "stroke", label: "Outline", min: 0, max: 8, step: 0.25, unit: "%", parent: "secOutline" },
  { key: "shadowX", label: "Shadow X", min: -10, max: 10, step: 0.25, unit: "%", parent: "secOutline" },
  { key: "shadowY", label: "Shadow Y", min: -10, max: 10, step: 0.25, unit: "%", parent: "secOutline" },
];

let params = loadParams();
let busy = false;
let loadingFromLayer = false;
const ctl = {};

function loadParams() {
  try { return Object.assign({}, E.DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); }
  catch (e) { return Object.assign({}, E.DEFAULTS); }
}
function saveParams() { try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch (e) { /* ignore */ } }
function effParams(p) { const o = {}; for (const k of Object.keys(E.DEFAULTS)) o[k] = p[k]; return o; }

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

// ---------------------------------------------------------------- log
const logLines = [];
let logTimer = null;
function log(msg, data) {
  logLines.push(new Date().toISOString() + " " + msg + (data !== undefined ? " " + JSON.stringify(data) : ""));
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
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
    const renderLayer = kids.find((k) => k.name === RENDER_NAME) || null;
    const source = kids.find((k) => k.name !== RENDER_NAME) || null;
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
  const json = JSON.stringify(effParams(p)).replace(/&/g, "&amp;").replace(/</g, "&lt;");
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
    return JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- reading the source alpha
// Reads the source layer's alpha (full res or scaled). Temporarily shows a hidden source.
async function readSourceAlpha(doc, layer, targetSize) {
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
    const n = id.width * id.height, c = id.components;
    const alpha = new Uint8Array(n);
    if (c >= 4 || c === 2) for (let i = 0; i < n; i++) alpha[i] = raw[i * c + c - 1]; else alpha.fill(255);
    const sb = res.sourceBounds || b;
    const out = { alpha, w: id.width, h: id.height, bounds: sb, scale: id.width / (sb.right - sb.left) };
    id.dispose();
    return out;
  } finally {
    if (wasHidden) layer.visible = false;
  }
}

// ---------------------------------------------------------------- GPU preview (WebView)
let wv = null, wvReady = false, previewSrc = null;
const wvWaiters = [];
function onWv(e) {
  let m = e.message !== undefined ? e.message : e.data;
  for (let k = 0; k < 3 && typeof m === "string"; k++) { try { m = JSON.parse(m); } catch (err) { break; } }
  if (!m) return;
  if (m.type === "ready" || m.type === "pong") wvReady = true;
  if (m.type === "error") log("PREVIEW ERROR", m.error);
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

// Build preview source: scaled alpha, padded so the effect fits, plus distance fields.
async function refreshPreviewSource() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) { previewSrc = null; $("sourceName").textContent = "–"; wvPost({ cmd: "clear", text: "Open a document…" }); return; }
  const t = resolveTarget(doc);
  if (!t || !t.source) { previewSrc = null; $("sourceName").textContent = "–"; wvPost({ cmd: "clear", text: (t && t.error) || "Select a text or shape layer…" }); return; }
  $("sourceName").textContent = t.group ? t.group.name.slice(GROUP_PREFIX.length) : t.source.name;
  // Selecting an existing MS Render group restores its settings
  if (t.renderLayer && !loadingFromLayer) {
    const saved = await readLayerParams(t.renderLayer.id);
    if (saved && JSON.stringify(effParams(saved)) !== JSON.stringify(effParams(params))) {
      loadingFromLayer = true;
      params = Object.assign({}, E.DEFAULTS, saved);
      syncUI(); saveParams();
      loadingFromLayer = false;
      setStatus("Settings loaded from the selected MS Render group.");
    }
  }
  const b = boundsOf(t.source);
  const bw = b.right - b.left, bh = b.bottom - b.top;
  if (bw <= 0 || bh <= 0) return;
  const f = Math.min(1, 380 / bw, 200 / bh);
  try {
    let a = null;
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " preview" });
      try { a = await readSourceAlpha(doc, t.source, { width: Math.max(1, Math.round(bw * f)), height: Math.max(1, Math.round(bh * f)) }); }
      finally { await ctx.hostControl.resumeHistory(hid, false); }
    }, { commandName: HIST + " preview" });
    ignoreEventsUntil = Date.now() + 700;
    previewSrc = { alpha: a.alpha, w: a.w, h: a.h, sig: sourceSignature(t.source), padUsed: null };
    sendPreviewSource();
  } catch (e) {
    wvPost({ cmd: "clear", text: "Preview not possible: " + (e.message || e) });
  }
}
function sendPreviewSource() {
  if (!previewSrc) return;
  const s = previewSrc;
  const lay = E.layout(s.alpha, s.w, s.h, params);
  if (!lay) return;
  const extra = Math.ceil(lay.box.h * 0.35);
  const n = lay.need;
  const pad = { l: n.left + extra, t: n.top + extra, r: n.right + extra, b: n.bottom + extra };
  const P = E.pad(s.alpha, s.w, s.h, pad.l, pad.t, pad.r, pad.b);
  const box = { x0: lay.box.x0 + pad.l, y0: lay.box.y0 + pad.t, w: lay.box.w, h: lay.box.h };
  const F = E.fields(P.alpha, P.w, P.h, box.h);
  s.padUsed = pad;
  wvPost({ cmd: "source", w: P.w, h: P.h, box, alpha: b64(P.alpha),
    dIn: b64(new Uint8Array(F.dIn.buffer)), dOut: b64(new Uint8Array(F.dOut.buffer)), sdfS: b64(new Uint8Array(F.sdfS.buffer)) });
  sendPreviewParams();
}
function sendPreviewParams() {
  if (!previewSrc) return;
  // re-send the source when the effect would no longer fit into the padded preview
  const lay = E.layout(previewSrc.alpha, previewSrc.w, previewSrc.h, params);
  const u = previewSrc.padUsed;
  if (lay && u && (lay.need.left > u.l || lay.need.top > u.t || lay.need.right > u.r || lay.need.bottom > u.b)) return sendPreviewSource();
  wvPost({ cmd: "params", params: effParams(params), bg: Number($("bg").value) });
}

// ---------------------------------------------------------------- final render
// Computes the rendered pixels for a source in document coordinates (cropped to the canvas).
async function computeRender(doc, source, p) {
  const a = await readSourceAlpha(doc, source, null);
  const r = E.renderFromAlpha(a.alpha, a.w, a.h, p);
  if (!r) throw new Error("The layer is empty.");
  let left = a.bounds.left - r.offsetX, top = a.bounds.top - r.offsetY;
  const dw = Math.round(Number(doc.width)), dh = Math.round(Number(doc.height));
  // crop to the canvas
  const x0 = Math.max(0, -left), y0 = Math.max(0, -top);
  const x1 = Math.min(r.w, dw - left), y1 = Math.min(r.h, dh - top);
  const cw = Math.max(0, x1 - x0), ch = Math.max(0, y1 - y0);
  const buf = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) buf.set(r.rgba.subarray(((y + y0) * r.w + x0) * 4, ((y + y0) * r.w + x0 + cw) * 4), y * cw * 4);
  return { buf, left: left + x0, top: top + y0, w: cw, h: ch, cropped: cw < r.w || ch < r.h };
}

// How much the canvas must grow on each side for the effect (0 if it fits)
async function canvasNeed(doc, source, p) {
  const a = await readSourceAlpha(doc, source, null);
  const lay = E.layout(a.alpha, a.w, a.h, p);
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
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: RENDER_NAME } }], {});
  const rl = doc.activeLayers[0];
  if (r.w > 0 && r.h > 0) {
    const id = await imaging.createImageDataFromBuffer(fromBuf8(r.buf, doc), { width: r.w, height: r.h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
    try { await imaging.putPixels({ documentID: doc.id, layerID: rl.id, imageData: id, targetBounds: { left: r.left, top: r.top } }); }
    finally { id.dispose(); }
  }
  await writeLayerParams(rl.id, p);
  source.visible = false;
  if (group) await selectLayer(group.id);
  rendered.set(group ? group.id : 0, sourceSignature(source));
  log("  rendered", { group: group && group.name, w: r.w, h: r.h, cropped: r.cropped });
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
  setStatus(live ? "Live update…" : "Rendering…");
  const t0 = Date.now();
  let err = null;
  const key = t.group ? t.group.id : t.source.id;
  const replaceLast = live && liveLast && liveLast.docId === doc.id && liveLast.key === key && liveLast.stateId === historyStateId(doc);
  log(mode.toUpperCase(), { source: t.source.name, replaceLast: !!replaceLast, params: effParams(params) });
  let res = null;
  try {
    await core.executeAsModal(async (ctx) => {
      if (replaceLast) await batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }], {});
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: live ? HIST + " Live" : mode === "auto" ? HIST + " Update" : HIST });
      try {
        // after stepping back in history, re-resolve layers
        const tt = replaceLast ? resolveTarget(doc) || t : t;
        res = await renderInto(ctx, doc, tt, Object.assign({}, params));
      } finally { await ctx.hostControl.resumeHistory(hid); }
    }, { commandName: HIST + " render" });
  } catch (e) { err = e.message || String(e); }
  liveLast = live && !err ? { docId: doc.id, key: res && res.group ? res.group.id : key, stateId: historyStateId(doc) } : null;
  ignoreEventsUntil = Date.now() + 800;
  busy = false;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log("  result", { err, ms: Date.now() - t0 });
  if (err) setStatus("Error: " + err, true);
  else setStatus(`${mode === "auto" ? "Updated" : "Rendered"} in ${secs}s${res && res.r.cropped ? " – cropped at the canvas edge (enable “Expand canvas”)" : ""}.`);
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
  if (!t || !t.group || !t.source) return;
  const last = rendered.get(t.group.id);
  const sig = sourceSignature(t.source);
  if (last === undefined) { rendered.set(t.group.id, sig); return; }
  if (sig !== last) {
    log("AUTO", { reason: "source changed" });
    await applyRender("auto");
  }
}

// ---------------------------------------------------------------- UI
function buildUI() {
  for (const s of SLIDERS) {
    const row = document.createElement("div");
    row.className = "ctl";
    row.innerHTML = `<span class="ctl-label">${s.label}</span><sp-slider class="ctl-range" min="${s.min}" max="${s.max}" step="${s.step}"></sp-slider><input class="ctl-num" type="text"><span class="ctl-unit">${s.unit}</span>`;
    $(s.parent).appendChild(row);
    const range = row.querySelector(".ctl-range"), num = row.querySelector(".ctl-num");
    ctl[s.key] = { range, num };
    const onRange = () => { params[s.key] = Number(range.value); num.value = String(params[s.key]); changed(); };
    range.addEventListener("input", onRange);
    range.addEventListener("change", onRange);
    num.addEventListener("change", () => {
      let v = parseFloat(String(num.value).replace(",", "."));
      if (isNaN(v)) v = params[s.key];
      params[s.key] = Math.max(s.min, Math.min(s.max, v));
      syncUI(); changed();
    });
  }
  $("material").innerHTML = E.MATERIALS.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
  $("profile").innerHTML = E.PROFILES.map((m) => `<option value="${m.id}">${m.name}</option>`).join("");
  $("preset").innerHTML = `<option value="">– choose a preset –</option>` + Object.keys(PRESETS).map((n) => `<option value="${n}">${n}</option>`).join("");
  $("material").addEventListener("change", (e) => { params.material = e.target.value; changed(); });
  $("profile").addEventListener("change", (e) => { params.profile = e.target.value; changed(); });
  $("expandCanvas").addEventListener("change", (e) => { params.expandCanvas = e.target.checked; saveParams(); });
  $("preset").addEventListener("change", (e) => {
    const n = e.target.value;
    if (!n) return;
    params = Object.assign({}, E.DEFAULTS, { expandCanvas: params.expandCanvas }, PRESETS[n]);
    syncUI(); changed();
    setStatus(`Preset “${n}” loaded.`);
    e.target.value = "";
  });
  $("bg").addEventListener("change", () => sendPreviewParams());
  $("render").addEventListener("click", () => applyRender("manual"));
  $("remove").addEventListener("click", removeRender);
  $("live").addEventListener("change", (e) => { liveLast = null; if (e.target.checked) applyRender("live"); });
  $("autoUpdate").addEventListener("change", (e) => { try { localStorage.setItem("msrender.auto", e.target.checked ? "1" : "0"); } catch (err) { /* ignore */ } });
  $("resetAll").addEventListener("click", () => { params = Object.assign({}, E.DEFAULTS); syncUI(); changed(); });
  $("selfTest").addEventListener("click", runSelfTest);
  let auto = "1";
  try { auto = localStorage.getItem("msrender.auto") || "1"; } catch (e) { /* ignore */ }
  $("autoUpdate").checked = auto === "1";
  $("bg").value = "0";
  $("preset").value = "";
}
function syncUI() {
  for (const k of Object.keys(ctl)) { ctl[k].range.value = String(params[k]); ctl[k].num.value = String(params[k]); }
  $("preset").value = "";
  $("material").value = params.material;
  $("profile").value = params.profile;
  $("expandCanvas").checked = !!params.expandCanvas;
}
function changed() {
  saveParams();
  sendPreviewParams();
  if (!loadingFromLayer && $("live").checked) debouncedLive();
}

// ---------------------------------------------------------------- self-test
async function runSelfTest() {
  if (busy || selfTestRunning) return;
  selfTestRunning = true;
  const saved = Object.assign({}, params);
  const wasLive = $("live").checked;
  $("live").checked = false;
  const results = [];
  const t0 = Date.now();
  log("SELFTEST START");
  setStatus("Self-test running… (about a minute, please don't click)");
  let doc = null;
  const check = async (name, fn) => {
    try { const r = await fn(); results.push({ test: name, ok: !!r.ok, details: r }); }
    catch (e) { results.push({ test: name, ok: false, details: String(e && e.stack || e) }); }
    setStatus(`Self-test: ${results.length} – ${name}`);
  };
  // Verify the current render of the selected group against a fresh CPU render
  const verify = async (expectP) => {
    const r = {};
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " verify" });
      try {
        const t = resolveTarget(doc);
        r.group = !!t.group; r.renderLayer = !!t.renderLayer; r.sourceHidden = t.source ? !t.source.visible : null;
        r.children = t.group ? t.group.layers.map((l) => l.name) : [];
        if (t.renderLayer) {
          const saved2 = await readLayerParams(t.renderLayer.id);
          r.xmpOk = !!saved2 && JSON.stringify(effParams(saved2)) === JSON.stringify(effParams(expectP));
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
          r.pixelDiffPct = n ? Math.round(diff / n * 1000) / 10 : 100;
          r.renderW = exp.w;
        }
      } finally { await ctx.hostControl.resumeHistory(hid, false); }
    }, { commandName: HIST + " verify" });
    r.ok = r.group && r.renderLayer && r.sourceHidden && r.xmpOk && r.pixelDiffPct <= 1 && r.children.length === 2;
    return r;
  };
  try {
    await core.executeAsModal(async () => {
      doc = await app.documents.add({ width: 1400, height: 700, resolution: 72, mode: "RGBColorMode", fill: "white", name: "MS Render Self-test" });
      await batchPlay([{ _obj: "make", _target: [{ _ref: "textLayer" }], using: { _obj: "textLayer", textKey: "RETRO",
        textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: 22 }, vertical: { _unit: "percentUnit", _value: 50 } },
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: 5, textStyle: { _obj: "textStyle", size: { _unit: "pointsUnit", _value: 170 }, color: { _obj: "RGBColor", red: 20, grain: 20, blue: 20 } } }] } }], {});
    }, { commandName: HIST + " self-test setup" });
    const D = Object.assign({}, E.DEFAULTS);

    params = Object.assign({}, D);
    await check("Render default (group, hidden source, XMP, pixels)", async () => { await applyRender("manual"); return verify(params); });
    for (const n of Object.keys(PRESETS)) {
      params = Object.assign({}, D, PRESETS[n]);
      await check("Preset " + n, async () => { await applyRender("manual"); return verify(params); });
    }
    for (const m of E.MATERIALS) {
      params = Object.assign({}, D, { material: m.id });
      await check("Material " + m.id, async () => { await applyRender("manual"); return verify(params); });
    }
    params = Object.assign({}, D);
    await check("Text change → auto-update", async () => {
      await applyRender("manual");
      const before = (await verify(params)).renderW;
      await core.executeAsModal(async () => {
        const t = resolveTarget(doc);
        await batchPlay([{ _obj: "set", _target: [{ _ref: "textLayer", _id: t.source.id }], to: { _obj: "textLayer", textKey: "RETRO RAD" } }], {});
      }, { commandName: HIST + " test text" });
      const wasAuto = $("autoUpdate").checked;
      $("autoUpdate").checked = true;
      await checkAutoUpdate();
      $("autoUpdate").checked = wasAuto;
      const v = await verify(params);
      v.before = before; v.ok = v.ok && v.renderW > before + 50;
      return v;
    });
    await check("Re-selecting the group restores settings", async () => {
      params = Object.assign({}, D, { material: "gold", depth: 30 });
      await applyRender("manual");
      params = Object.assign({}, D);
      await refreshPreviewSource();
      return { ok: params.material === "gold" && params.depth === 30, material: params.material, depth: params.depth };
    });
    await check("Canvas expands when the effect doesn't fit", async () => {
      const w0 = Number(doc.width);
      params = Object.assign({}, D, { depth: 50, vpX: 400, vpY: 100, expandCanvas: true });
      await applyRender("manual");
      const v = await verify(params);
      v.w0 = w0; v.w1 = Number(doc.width); v.ok = v.ok && v.w1 > w0;
      return v;
    });
    await check("Live: several updates = one history step", async () => {
      params = Object.assign({}, D);
      liveLast = null;
      const s0 = historyStateId(doc);
      await applyRender("live");
      params = Object.assign({}, D, { material: "silver" });
      await applyRender("live");
      params = Object.assign({}, D, { material: "gold" });
      await applyRender("live");
      const states = doc.historyStates;
      const ai = states.findIndex((st) => st.id === historyStateId(doc));
      const before = ai > 0 ? states[ai - 1].id : null;
      const v = await verify(params);
      return { ok: before === s0 && states[ai].name === HIST + " Live" && v.ok, s0, before, verify: v };
    });
    await check("Remove restores the original layer", async () => {
      await removeRender();
      const groups = doc.layers.filter((l) => isRenderGroup(l)).length;
      const src = doc.layers.find((l) => l.name.startsWith("RETRO"));
      const renders = doc.layers.filter((l) => l.name === RENDER_NAME).length;
      return { ok: groups === 0 && !!src && src.visible && renders === 0, groups, renders, sourceVisible: src && src.visible };
    });
  } catch (e) {
    results.push({ test: "Aborted", ok: false, details: String(e && e.stack || e) });
  }
  params = saved;
  $("live").checked = wasLive;
  syncUI();
  const failed = results.filter((r) => !r.ok);
  log("SELFTEST RESULT", { passed: results.length - failed.length, total: results.length, seconds: Math.round((Date.now() - t0) / 1000) });
  for (const r of results) log((r.ok ? "  ✓ " : "  ✗ ") + r.test, r.ok ? undefined : r.details);
  setStatus(`Self-test: ${results.length - failed.length}/${results.length} passed` + (failed.length ? ` – failed: ${failed.map((r) => r.test).join(", ")}` : " ✓"), failed.length > 0);
  selfTestRunning = false;
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
  log("START", { ps: app.version });
  buildUI();
  syncUI();
  await initPreview();
  try { action.addNotificationListener(["select", "make", "delete", "set", "open", "close", "move", "transform", "editTextLayer"], onPsEvent); }
  catch (e) { log("listener failed", String(e)); }
  // fallback: user text edits may not always notify – poll gently
  setInterval(() => { if (!busy && !selfTestRunning && Date.now() > ignoreEventsUntil) checkAutoUpdate(); }, 1500);
  refreshPreviewSource();
}
init();
