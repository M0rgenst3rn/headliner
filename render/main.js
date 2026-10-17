"use strict";
// MS Render – Photoshop UXP panel.
// A source layer (live text / shape / pixels) goes into a group "MS Render · <name>" together with one
// rendered layer per effect of its stack. The stack works like Photoshop's layers: effects that replace
// the look (the base, e.g. Chrome Extrude) hide the source; the others sit above or behind it and are
// computed from the base's result. Settings live in the render layers' XMP, so selecting the group later
// restores the whole stack. The WebView shows the live preview and renders the gallery thumbnails.

const { app, core, action, imaging, constants } = require("photoshop");
const { batchPlay } = action;
const FX = require("./effects.js");
const lfs = require("uxp").storage.localFileSystem;

const $ = (id) => document.getElementById(id);
const STORE_KEY = "msrender.state.v3";
const GROUP_PREFIX = "MS Render · ";
const HIST = "MS Render";
const XMP_NS = "http://ms-render/1.0/";
const RENDER_NAMES = new Set(FX.EFFECTS.map((e) => e.name));
const THUMB = { tw: 200, th: 124 };
const ZONE_LABEL = { above: "on top", base: "look", behind: "behind" };

let state = loadState();
let busy = false;
let loadingFromLayer = false;
let addMode = false;          // "+ Add": the next effect click adds instead of swapping
const ctl = {};

// ---------------------------------------------------------------- state: the stack being edited
function loadState() {
  const d = { stack: FX.single("chromeExtrude", {}), sel: null, fx: {}, expandCanvas: true };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s) Object.assign(d, s);
    else {
      // migrate v0.2/0.3 (one effect + remembered values per effect)
      const old = JSON.parse(localStorage.getItem("msrender.state.v2") || "null");
      if (old && FX.BY_ID[old.effect]) { d.fx = old.fx || {}; d.stack = FX.single(old.effect, d.fx[old.effect]); d.expandCanvas = old.expandCanvas !== false; }
    }
  } catch (e) { /* defaults */ }
  d.stack = FX.normStack(d.stack);
  if (!d.stack.entries.some((e) => e.uid === d.sel)) d.sel = d.stack.entries[0] ? d.stack.entries[0].uid : null;
  return d;
}
function saveState() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
const selEntry = () => state.stack.entries.find((e) => e.uid === state.sel) || null;
const fxDef = () => { const e = selEntry(); return e ? FX.BY_ID[e.effect] : null; };
function curValues() { const e = selEntry(); return e ? e.values : {}; }
function setValues(upd) {
  const e = selEntry();
  if (!e) return;
  Object.assign(e.values, upd);
  state.fx[e.effect] = Object.assign({}, e.values);   // remembered for the next time this effect is added
}
function setStack(stack, selUid) {
  state.stack = FX.normStack(stack);
  const ids = state.stack.entries.map((e) => e.uid);
  state.sel = ids.includes(selUid) ? selUid : ids.includes(state.sel) ? state.sel : ids[0] || null;
}
function renderParams() { return { stack: FX.normStack(JSON.parse(JSON.stringify(state.stack))), expandCanvas: !!state.expandCanvas }; }
// compares stacks by content (uids differ between copies)
const stackKey = (st) => JSON.stringify(FX.normStack(st).entries.map((e) => [e.effect, e.values, e.on]));
const stackLabel = (st) => {
  const on = FX.normStack(st).entries.filter((e) => e.on).map((e) => FX.BY_ID[e.effect].name);
  return on.length ? on.join(" + ") : "no effect";
};

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// An MS Render group holds its source plus one render layer per effect. The source is identified by its
// layer id (stored in the render layers' XMP and cached here) – never by position, so a new layer that
// Photoshop drops into the group can't be mistaken for the source.
const groupSource = new Map(); // group id -> source layer id
function groupParts(group) {
  // compare by id: Photoshop's DOM hands out a new wrapper object on every access
  const kids = Array.from(group.layers);
  const renderLayers = kids.filter((k) => RENDER_NAMES.has(k.name));
  const rids = new Set(renderLayers.map((k) => k.id));
  const others = kids.filter((k) => !rids.has(k.id));
  const sid = groupSource.get(group.id);
  // fallback (not cached yet / older groups): the oldest layer = smallest id is the original source
  const source = others.find((k) => k.id === sid) || others.slice().sort((a, b) => a.id - b.id)[0] || null;
  return { renderLayers, source, foreign: others.filter((k) => !source || k.id !== source.id) };
}
// Returns { group, source, renderLayers } for the current selection.
function resolveTarget(doc) {
  const l = doc && doc.activeLayers[0];
  if (!l) return null;
  let group = null;
  if (isRenderGroup(l)) group = l;
  else if (l.parent && isRenderGroup(l.parent)) group = l.parent;
  if (group) {
    const { renderLayers, source, foreign } = groupParts(group);
    // a layer that doesn't belong to the effect (e.g. new text created while the group was selected)
    if (foreign.some((k) => k.id === l.id)) return { group: null, source: null, renderLayers: [], foreignIn: group, error: "This layer sits inside an MS Render group – moving it out…" };
    return { group, source, renderLayers };
  }
  if (isGroup(l)) return { group: null, source: null, renderLayers: [], error: "Select a text or shape layer (not a group)." };
  if (l.isBackgroundLayer) return { group: null, source: null, renderLayers: [], error: "The background layer can't be used. Convert it to a normal layer first." };
  return { group: null, source: l, renderLayers: [] };
}
function sourceSignature(layer) {
  let text = "";
  try { text = layer.textItem ? layer.textItem.contents : ""; } catch (e) { /* not text */ }
  return JSON.stringify([layer.id, text, boundsOf(layer)]);
}

// ---------------------------------------------------------------- XMP params (on every render layer)
function xmpFor(stack, sourceId) {
  const json = JSON.stringify({ stack: { entries: stack.entries }, sourceId: sourceId || null }).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:msr="${XMP_NS}"><msr:params>${json}</msr:params></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
async function writeLayerParams(layerId, stack, sourceId) {
  await batchPlay([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }], to: { _obj: "layer", XMPMetadataAsUTF8: xmpFor(stack, sourceId) } }], {});
}
// -> { stack, sourceId } (older single-effect formats are converted)
async function readLayerParams(layerId) {
  try {
    const r = await batchPlay([{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }] }], {});
    const x = r && r[0] && r[0].XMPMetadataAsUTF8;
    const m = x && /<msr:params>([\s\S]*?)<\/msr:params>/.exec(x);
    if (!m) return null;
    const o = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
    if (o.stack) return { stack: FX.normStack(o.stack), sourceId: o.sourceId || null };
    if (o.effect && FX.BY_ID[o.effect]) return { stack: FX.single(o.effect, o.values), sourceId: o.sourceId || null };   // v0.2–0.3
    return { stack: FX.single("chromeExtrude", o), sourceId: null };                                                        // v0.1
  } catch (e) { return null; }
}
async function readGroupParams(t) {
  for (const l of t.renderLayers || []) { const p = await readLayerParams(l.id); if (p) return p; }
  return null;
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
function onWv(e) {
  let m = e.message !== undefined ? e.message : e.data;
  for (let k = 0; k < 3 && typeof m === "string"; k++) { try { m = JSON.parse(m); } catch (err) { break; } }
  if (!m) return;
  if (m.type === "ready" || m.type === "pong") wvReady = true;
  else if (m.type === "error") log("PREVIEW ERROR", m.error);
  else if (m.type === "thumb") onThumb(m);
  else if (m.type === "drag") onDrag(m);
}
function wvPost(o) { if (!wv) return; try { wv.postMessage(JSON.stringify(o)); } catch (e) { log("wvPost failed", String(e)); } }
async function initPreview() {
  wv = document.createElement("webview");
  wv.addEventListener("message", onWv);
  wv.src = "plugin:/preview/index.html";
  $("previewBox").appendChild(wv);
  for (let i = 0; i < 25 && !wvReady; i++) { wvPost({ cmd: "ping" }); await sleep(200); }
  log("PREVIEW", { ready: wvReady });
}

// Reads the selected layer at preview size and sends it to the WebView; selecting an MS Render group
// loads its stack into the panel.
async function refreshPreviewSource() {
  if (busy) return;
  const doc = app.activeDocument;
  const clear = (text) => {
    previewSrc = null; wvPost({ cmd: "clear", text });
    if (thumbSig !== "sample") { thumbSig = "sample"; requestThumbs("all"); }
  };
  if (!doc) { setTargetUI(null); return clear("Open a document…"); }
  const t = resolveTarget(doc);
  if (t && t.foreignIn) { setTimeout(async () => { if (await ejectForeignLayers()) refreshPreviewSource(); }, 50); }
  setTargetUI(t);
  if (!t || !t.source) return clear((t && t.error) || "Select a text or shape layer…");
  if (t.group && !loadingFromLayer) {
    const saved = await readGroupParams(t);
    if (saved && saved.sourceId) groupSource.set(t.group.id, saved.sourceId);
    if (saved && stackKey(saved.stack) !== stackKey(state.stack)) {
      loadingFromLayer = true;
      setStack(saved.stack);
      addMode = false;
      rebuildForStack();
      loadingFromLayer = false;
      setStatus(`Loaded from the selected group: ${stackLabel(state.stack)}.`);
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
  wvPost({ cmd: "params", stack: state.stack, sel: state.sel, bg: Number($("bg").value) });
}

function currentTarget() { const doc = app.activeDocument; return doc ? resolveTarget(doc) : null; }
// Live mode only ever touches an existing MS Render group
function liveTarget() { const t = currentTarget(); return !!(t && t.group); }
function hasTarget() { const t = currentTarget(); return !!(t && t.source); }
// Header + main button tell whether you're editing an existing group or adding effects to a plain layer
function setTargetUI(t) {
  const name = $("sourceName"), btn = $("render");
  if (t && t.group) {
    name.textContent = "✦ " + t.group.name.slice(GROUP_PREFIX.length);
    name.title = "Editing this MS Render group – changes update it";
    btn.textContent = "Update";
  } else if (t && t.source) {
    name.textContent = t.source.name;
    name.title = "Plain layer – click an effect or Apply to add the stack";
    btn.textContent = "Apply";
  } else { name.textContent = "–"; name.title = ""; btn.textContent = "Apply"; }
}

// ---------------------------------------------------------------- gallery: effects, looks, combos
function requestThumbs(which) {
  const items = [];
  if (which === "all") {
    for (const e of FX.EFFECTS) items.push({ key: "fx:" + e.id, effect: e.id, values: {} });
    for (const n of Object.keys(FX.COMBOS)) items.push({ key: "combo:" + n, stack: FX.comboStack(n) });
  }
  const fx = fxDef();
  if (fx) for (const n of Object.keys(fx.presets || {})) items.push({ key: "pr:" + fx.id + ":" + n, effect: fx.id, values: fx.presets[n] });
  wvPost(Object.assign({ cmd: "thumbs", items }, THUMB));
}
function onThumb(m) {
  thumbsReceived++;
  const img = document.querySelector(`img[data-key="${m.key.replace(/"/g, '\\"')}"]`);
  if (img) img.src = m.url;
  else if (!m.key.startsWith("pr:")) log("thumb without tile", m.key);
}
function tile(key, label, title, onClick, cls) {
  const t = document.createElement("div");
  t.className = "fx-tile" + (cls ? " " + cls : "");
  t.title = title;
  t.innerHTML = `<img data-key="${esc(key)}" alt=""><div class="lbl">${esc(label)}</div>`;
  t.addEventListener("click", onClick);
  return t;
}
function buildGallery() {
  const grid = $("fxGrid");
  grid.innerHTML = "";
  for (const e of FX.EFFECTS) {
    const t = tile("fx:" + e.id, e.name, `${e.name} – click to apply`, () => effectClicked(e.id));
    t.dataset.effect = e.id;
    grid.appendChild(t);
  }
  const cg = $("comboGrid");
  cg.innerHTML = "";
  for (const n of Object.keys(FX.COMBOS)) cg.appendChild(tile("combo:" + n, n, `${n}: ${stackLabel(FX.comboStack(n))} – click to apply`, () => comboClicked(n)));
}
function buildLooks() {
  const grid = $("lookGrid"), fx = fxDef();
  grid.innerHTML = "";
  $("lookSection").className = fx ? "section" : "section hidden";
  if (!fx) return;
  $("lookTitle").textContent = `${fx.name} looks`;
  for (const n of Object.keys(fx.presets || {})) grid.appendChild(tile("pr:" + fx.id + ":" + n, n, `${n} – click to apply`, () => applyPreset(n), "look"));
}
function markActive() {
  const e = selEntry();
  for (const t of document.querySelectorAll("#fxGrid .fx-tile")) t.className = "fx-tile" + (e && t.dataset.effect === e.effect ? " active" : "") + (addMode ? " adding" : "");
  const fx = fxDef();
  $("effectName").textContent = fx ? fx.name : "No effect";
  $("effectMode").textContent = fx ? { replace: "replaces the look", behind: "behind the layer", above: "on top of the layer" }[fx.mode] : "";
  $("addFx").className = addMode ? "add-on" : "";
}
// the stack changed: rebuild everything that depends on it
function rebuildForStack() { buildStackList(); buildControls(); buildLooks(); markActive(); syncUI(); saveState(); requestThumbs("presets"); sendPreviewParams(); }

// After a click in the gallery etc.: a group updates right away; a plain layer gets the stack applied
// (click = apply). Pure stack edits on a plain layer (remove, order, on/off) only change the draft.
function commit(applyToPlainLayer) {
  rebuildForStack();
  const t = currentTarget();
  if (t && t.group) applyRender("manual");
  else if (t && t.source && applyToPlainLayer) applyRender("manual");
  else if (!t || !t.source) setStatus(`${stackLabel(state.stack)} – select a text or shape layer and press Apply.`);
}
function effectClicked(id) {
  const t = currentTarget();
  const fresh = !(t && t.group) && !addMode;
  const e = selEntry();
  const values = FX.values(id, state.fx[id]);
  if (fresh) {
    // plain layer: a click tries this effect on its own
    setStack(FX.single(id, values));
  } else if (addMode || !e) {
    const n = FX.entry(id, values);
    let entries = state.stack.entries;
    if (FX.zoneOf(id) === "base") entries = entries.filter((x) => FX.zoneOf(x.effect) !== "base");   // one look at a time
    setStack({ entries: [n].concat(entries) }, n.uid);
  } else {
    // swap the selected effect (keeps its place); a new look replaces the old one
    const n = Object.assign(FX.entry(id, values), { uid: e.uid, on: e.on });
    let entries = state.stack.entries.map((x) => (x.uid === e.uid ? n : x));
    if (FX.zoneOf(id) === "base") entries = entries.filter((x) => x.uid === n.uid || FX.zoneOf(x.effect) !== "base");
    setStack({ entries }, n.uid);
  }
  const added = addMode;
  addMode = false;
  commit(true);
  if (!hasTarget()) setStatus(`${FX.BY_ID[id].name} ${added ? "added" : "selected"} – select a text or shape layer and press Apply.`);
}
function comboClicked(name) {
  const st = FX.comboStack(name);
  if (!st) return;
  addMode = false;
  setStack(st, st.entries[0].uid);
  commit(true);
}
function applyPreset(n) {
  const fx = fxDef(), pr = fx && (fx.presets || {})[n];
  if (!pr) return;
  selEntry().values = FX.values(fx.id, pr);
  state.fx[fx.id] = Object.assign({}, selEntry().values);
  commit(true);
}

// ---------------------------------------------------------------- stack list (like Photoshop's layers)
function buildStackList() {
  const box = $("stackList");
  box.innerHTML = "";
  const entries = state.stack.entries;
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "stack-empty";
    empty.textContent = "No effects – click one below.";
    box.appendChild(empty);
  }
  const zoneIdx = (e) => entries.filter((x) => FX.zoneOf(x.effect) === FX.zoneOf(e.effect)).indexOf(e);
  const zoneLen = (e) => entries.filter((x) => FX.zoneOf(x.effect) === FX.zoneOf(e.effect)).length;
  for (const e of entries) {
    const fx = FX.BY_ID[e.effect];
    const row = document.createElement("div");
    row.className = "stack-row" + (e.uid === state.sel ? " sel" : "") + (e.on ? "" : " off");
    row.innerHTML = `<span class="eye" title="Show / hide this effect">${e.on ? "●" : "○"}</span><span class="nm">${esc(fx.name)}</span><span class="zone">${ZONE_LABEL[FX.zoneOf(e.effect)]}</span>` +
      `<span class="bt up" title="Move up">▲</span><span class="bt dn" title="Move down">▼</span><span class="bt rm" title="Remove">✕</span>`;
    row.querySelector(".nm").addEventListener("click", () => { state.sel = e.uid; addMode = false; rebuildForStack(); });
    row.querySelector(".zone").addEventListener("click", () => { state.sel = e.uid; addMode = false; rebuildForStack(); });
    row.querySelector(".eye").addEventListener("click", () => { e.on = !e.on; commit(false); });
    const up = row.querySelector(".up"), dn = row.querySelector(".dn");
    if (zoneIdx(e) === 0) up.className += " dis"; else up.addEventListener("click", () => moveEntry(e.uid, -1));
    if (zoneIdx(e) === zoneLen(e) - 1) dn.className += " dis"; else dn.addEventListener("click", () => moveEntry(e.uid, 1));
    row.querySelector(".rm").addEventListener("click", () => removeEntry(e.uid));
    box.appendChild(row);
  }
}
function moveEntry(uid, dir) {
  // effects only move within their zone (above / behind) – the look always sits in the middle
  const list = state.stack.entries.slice(), i = list.findIndex((x) => x.uid === uid);
  const zone = FX.zoneOf(list[i].effect);
  let j = i + dir;
  while (j >= 0 && j < list.length && FX.zoneOf(list[j].effect) !== zone) j += dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  setStack({ entries: list }, uid);
  commit(false);
}
function removeEntry(uid) {
  const list = state.stack.entries.filter((x) => x.uid !== uid);
  setStack({ entries: list }, state.sel === uid ? null : state.sel);
  if (state.sel === null && list[0]) state.sel = list[0].uid;
  const t = currentTarget();
  if (t && t.group && !list.length) { rebuildForStack(); removeRender(); return; }   // nothing left: back to the plain layer
  commit(false);
}

// drag in the preview (vanishing point / direction / bolt points) edits the selected entry
const debouncedPreviewSync = debounce(() => sendPreviewParams(), 250);
function onDrag(m) {
  const e = state.stack.entries.find((x) => x.uid === m.uid);
  if (!e || e.uid !== state.sel) return;
  setValues(m.values);
  syncUI(); saveState();
  if (m.final) debouncedPreviewSync();
  if (!loadingFromLayer && $("live").checked && liveTarget()) debouncedLive();
}

// ---------------------------------------------------------------- final render
// Renders the stack for a source at full resolution. Layers come top → bottom, positions in document
// coordinates (relative to the source's top-left given by srcBounds).
function cropLayer(l, left, top, dw, dh) {
  const x0 = Math.max(0, -left), y0 = Math.max(0, -top);
  const x1 = Math.min(l.w, dw - left), y1 = Math.min(l.h, dh - top);
  const cw = Math.max(0, x1 - x0), ch = Math.max(0, y1 - y0);
  const buf = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) buf.set(l.rgba.subarray(((y + y0) * l.w + x0) * 4, ((y + y0) * l.w + x0 + cw) * 4), y * cw * 4);
  return { buf, left: left + x0, top: top + y0, w: cw, h: ch, cropped: cw < l.w || ch < l.h };
}
async function computeStack(doc, source, stack) {
  const a = await readSource(doc, source, null);
  const res = FX.renderStack(a, stack);
  return { a, res };
}
// One item per stack entry (top → bottom). Hidden entries get an empty, hidden layer, so the group keeps
// every effect (and its settings) – like a hidden layer in Photoshop.
function layersInDoc(doc, a, res, stack) {
  const dw = Math.round(Number(doc.width)), dh = Math.round(Number(doc.height));
  const byUid = {};
  for (const l of res.layers) byUid[l.uid] = Object.assign(cropLayer(l, a.bounds.left + l.x, a.bounds.top + l.y, dw, dh), { uid: l.uid, effect: l.effect, zone: l.zone, off: false });
  return FX.normStack(stack).entries.map((e) => byUid[e.uid] || { uid: e.uid, effect: e.effect, zone: FX.zoneOf(e.effect), w: 0, h: 0, off: true, cropped: false });
}

async function renderInto(ctx, doc, t, p) {
  let { group, source, renderLayers } = t;
  if (!source) throw new Error("No source layer.");
  // 1) render at full resolution
  let { a, res } = await computeStack(doc, source, p.stack);
  // 2) make room on the canvas for everything the stack draws
  if (p.expandCanvas && res.layers.length) {
    const b = FX.stackBounds(res, a), dw = Math.round(Number(doc.width)), dh = Math.round(Number(doc.height));
    const need = {
      left: Math.max(0, -(a.bounds.left + b.x0)), top: Math.max(0, -(a.bounds.top + b.y0)),
      right: Math.max(0, a.bounds.left + b.x1 - dw), bottom: Math.max(0, a.bounds.top + b.y1 - dh),
    };
    if (need.right || need.bottom) await doc.resizeCanvas(dw + need.right, dh + need.bottom, constants.AnchorPosition.TOPLEFT);
    if (need.left || need.top) {
      await doc.resizeCanvas(Math.round(Number(doc.width)) + need.left, Math.round(Number(doc.height)) + need.top, constants.AnchorPosition.BOTTOMRIGHT);
      a.bounds = { left: a.bounds.left + need.left, top: a.bounds.top + need.top, right: a.bounds.right + need.left, bottom: a.bounds.bottom + need.top };
    }
    if (need.left || need.top || need.right || need.bottom) log("  canvas", need);
  }
  const L = layersInDoc(doc, a, res, p.stack);
  // 3) group: source goes into "MS Render · <name>"
  if (!group) {
    await selectLayer(source.id);
    await batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" } }], {});
    await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", name: GROUP_PREFIX + source.name } }], {});
    group = doc.activeLayers[0];
  }
  for (const rl of renderLayers || []) await rl.delete();
  // 4) one layer per effect: look right above the source, above-effects on top (list order), behind-effects below
  const made = {};
  const makeLayer = async (l) => {
    await selectLayer(source.id);
    await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: FX.BY_ID[l.effect].name } }], {});
    const rl = doc.activeLayers[0];
    if (l.w > 0 && l.h > 0) {
      const id = await imaging.createImageDataFromBuffer(fromBuf8(l.buf, doc), { width: l.w, height: l.h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
      try { await imaging.putPixels({ documentID: doc.id, layerID: rl.id, imageData: id, targetBounds: { left: l.left, top: l.top } }); }
      finally { id.dispose(); }
    }
    if (l.off) rl.visible = false;
    made[l.uid] = rl;
    return rl;
  };
  const base = L.find((l) => l.zone === "base");
  let baseLayer = null;
  if (base) baseLayer = await makeLayer(base);                       // made right above the source
  let anchor = baseLayer || source;
  for (const l of L.filter((l) => l.zone === "above").reverse()) {  // bottom-most first, each goes on top
    const rl = await makeLayer(l);
    await rl.move(anchor, constants.ElementPlacement.PLACEBEFORE);
    anchor = rl;
  }
  anchor = source;
  for (const l of L.filter((l) => l.zone === "behind")) {           // list order, each one further down
    const rl = await makeLayer(l);
    await rl.move(anchor, constants.ElementPlacement.PLACEAFTER);
    anchor = rl;
  }
  for (const uid of Object.keys(made)) await writeLayerParams(made[uid].id, p.stack, source.id);
  groupSource.set(group.id, source.id);
  source.visible = res.sourceVisible;
  await selectLayer(group.id);
  rendered.set(group.id, sourceSignature(source));
  const cropped = L.some((l) => l.cropped);
  log("  rendered", { stack: stackLabel(p.stack), group: group.name, layers: L.length, hidden: L.filter((l) => l.off).length, cropped });
  return { group, cropped, layers: L.length };
}

const rendered = new Map(); // groupId -> source signature at last render
let liveLast = null, livePending = false, lastRender = null;
function historyStateId(doc) { try { return doc.activeHistoryState ? doc.activeHistoryState.id : null; } catch (e) { return null; } }

async function applyRender(mode, pOverride) {
  // mode: "manual" | "live" | "auto"; pOverride: render with these settings instead of the panel's
  const live = mode === "live";
  if (busy) { if (live) livePending = true; return; }
  const doc = app.activeDocument;
  if (!doc) return setStatus("Open a document first.", true);
  const t = resolveTarget(doc);
  if (!t || !t.source) return setStatus((t && t.error) || "Select a text or shape layer.", true);
  if (live && !t.group) return;   // Live never adds an effect to a plain layer (selection may have changed)
  const p = pOverride || renderParams();
  const enabled = p.stack.entries.filter((e) => e.on).length;
  if (!enabled && !t.group) return setStatus("The stack has no active effect – click one below.", true);
  if (!p.stack.entries.length && t.group) return removeRender();
  busy = true;
  setStatus(live ? "Live update…" : `Rendering ${stackLabel(p.stack)}…`);
  const t0 = Date.now();
  let err = null;
  const key = t.group ? t.group.id : t.source.id;
  const replaceLast = live && liveLast && liveLast.docId === doc.id && liveLast.key === key && liveLast.stateId === historyStateId(doc);
  log(mode.toUpperCase(), { source: t.source.name, replaceLast: !!replaceLast, stack: stackLabel(p.stack) });
  let res = null;
  try {
    await core.executeAsModal(async (ctx) => {
      if (replaceLast) await batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }], {});
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: live ? HIST + " Live" : mode === "auto" ? HIST + " Update" : HIST + " " + stackLabel(p.stack) });
      try {
        const tt = replaceLast ? resolveTarget(doc) || t : t;
        res = await renderInto(ctx, doc, tt, p);
      } finally { await ctx.hostControl.resumeHistory(hid); }
    }, { commandName: HIST + " render" });
  } catch (e) { err = e.message || String(e); }
  lastRender = { err, cropped: !!(res && res.cropped) };
  liveLast = live && !err ? { docId: doc.id, key: res && res.group ? res.group.id : key, stateId: historyStateId(doc) } : null;
  ignoreEventsUntil = Date.now() + 800;
  busy = false;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log("  result", { err, ms: Date.now() - t0 });
  if (err) setStatus("Error: " + err, true);
  else {
    setTargetUI(resolveTarget(doc));
    setStatus(`${mode === "auto" ? "Updated" : stackLabel(p.stack)} – ${secs}s${res && res.cropped ? " – cropped at the canvas edge (enable “Expand canvas”)" : ""}.`);
  }
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
        for (const rl of t.renderLayers) await rl.delete();
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
  setTargetUI(resolveTarget(doc));
}

// ---------------------------------------------------------------- auto-update on text changes
async function checkAutoUpdate() {
  if (busy || !$("autoUpdate").checked) return;
  const doc = app.activeDocument;
  const t = doc && resolveTarget(doc);
  if (!t || !t.group || !t.source || !t.renderLayers.length) return;
  const last = rendered.get(t.group.id);
  const sig = sourceSignature(t.source);
  if (last === undefined) { rendered.set(t.group.id, sig); return; }
  if (sig !== last) {
    log("AUTO", { reason: "source changed" });
    // re-render with the stack stored in THIS group – the panel may show another layer's stack
    const saved = await readGroupParams(t);
    if (!saved) return;
    await applyRender("auto", { stack: saved.stack, expandCanvas: !!state.expandCanvas });
  }
}

// ---------------------------------------------------------------- keep effect groups clean
// Photoshop puts a new layer INSIDE the selected group. If that happens with an MS Render group (e.g. you
// create a new text right after rendering), the layer is moved out, above the group, so it stays a normal
// layer that can get its own effects – and the finished group keeps exactly its render layers + source.
function renderGroupsIn(container, out) {
  for (const l of container.layers || []) { if (isRenderGroup(l)) out.push(l); else if (isGroup(l)) renderGroupsIn(l, out); }
  return out;
}
async function ejectForeignLayers() {
  const doc = app.activeDocument;
  if (!doc || busy) return false;
  const jobs = [];
  for (const g of renderGroupsIn(doc, [])) {
    const parts = groupParts(g);
    if (!parts.renderLayers.length) continue;
    if (!groupSource.has(g.id)) {
      const saved = await readGroupParams(parts);
      if (saved && saved.sourceId) groupSource.set(g.id, saved.sourceId);
    }
    const { foreign } = groupParts(g);
    if (foreign.length) jobs.push({ g, foreign });
  }
  if (!jobs.length) return false;
  const selectedIds = doc.activeLayers.map((l) => l.id);
  busy = true;
  try {
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " keep layer outside the effect" });
      try {
        for (const { g, foreign } of jobs) for (const f of foreign) await f.move(g, constants.ElementPlacement.PLACEBEFORE);
        const sel = jobs.flatMap((j) => j.foreign).find((f) => selectedIds.includes(f.id));
        if (sel) await selectLayer(sel.id);
      } finally { await ctx.hostControl.resumeHistory(hid); }
    }, { commandName: HIST + " keep layer outside the effect" });
    log("EJECT", jobs.map((j) => ({ group: j.g.name, layers: j.foreign.map((f) => f.name) })));
    setStatus("New layer moved out of the MS Render group – it's a normal layer again.");
  } catch (e) {
    log("eject failed (will retry)", String(e && e.message || e)); // e.g. still typing in the new text
    busy = false;
    return false;
  }
  busy = false;
  ignoreEventsUntil = Date.now() + 500;
  return true;
}

// ---------------------------------------------------------------- settings of the selected effect
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
// ---- colour: swatch + hex field; clicking the swatch opens a colour wheel with a brightness slider
function hexToRgb(h) { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join(""); }
function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
let openWheel = null; // close function of the open colour wheel
function colorRow(parent, c, allowEmpty) {
  const row = document.createElement("div");
  row.className = "ctl color-ctl";
  row.innerHTML = `<span class="ctl-label">${esc(c.label.replace(/\s*\(.*\)$/, ""))}</span><div class="swatch cur" title="Open colour wheel"></div><input class="hex" type="text" placeholder="${allowEmpty ? "layer" : ""}">` +
    (allowEmpty ? `<sp-action-button size="s" quiet class="layer-col" title="Use the layer's own colour">Layer</sp-action-button>` : "");
  parent.appendChild(row);
  const pop = document.createElement("div");
  pop.className = "wheel-pop hidden";
  pop.innerHTML = `<div class="wheel"><img src="icons/wheel-10.png" alt=""><div class="dot"></div></div><div class="ctl"><span class="ctl-label">Brightness</span><sp-slider class="ctl-range" min="0" max="100" step="1"></sp-slider></div>`;
  parent.appendChild(pop);
  const cur = row.querySelector(".cur"), hex = row.querySelector(".hex");
  const wheel = pop.querySelector(".wheel"), dot = pop.querySelector(".dot"), wheelImg = pop.querySelector(".wheel img"), bright = pop.querySelector("sp-slider");
  let hsv = [0, 0, 1];
  const SIZE = 150;
  const placeDot = () => {
    const r = hsv[1] * (SIZE / 2 - 1), a = hsv[0] * Math.PI / 180;
    dot.style.left = (SIZE / 2 + Math.cos(a) * r - 5) + "px";
    dot.style.top = (SIZE / 2 - Math.sin(a) * r - 5) + "px";
    const lv = Math.round(hsv[2] * 10);   // pre-rendered brightness levels (UXP can't darken images via CSS)
    if (wheelImg.dataset.lv !== String(lv)) { wheelImg.dataset.lv = String(lv); wheelImg.src = `icons/wheel-${lv}.png`; }
    dot.style.backgroundColor = rgbToHex(...hsvToRgb(...hsv));
  };
  const commitColor = () => { setValues({ [c.key]: rgbToHex(...hsvToRgb(...hsv)) }); syncUI(); changed(); };
  const fromEvent = (e) => {
    const b = wheel.getBoundingClientRect();
    const dx = e.clientX - (b.left + b.width / 2), dy = e.clientY - (b.top + b.height / 2);
    hsv[0] = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;
    hsv[1] = Math.min(1, Math.hypot(dx, dy) / (b.width / 2));
    if (hsv[2] < 0.05) hsv[2] = 1;   // picking a hue on a black colour should show it
    placeDot(); commitColor();
  };
  let down = false;
  wheel.addEventListener("mousedown", (e) => { down = true; fromEvent(e); });
  wheel.addEventListener("mousemove", (e) => { if (down && e.buttons !== 0) fromEvent(e); else down = false; });
  wheel.addEventListener("mouseup", () => { down = false; });
  wheel.addEventListener("mouseleave", () => { down = false; });
  bright.addEventListener("input", () => { hsv[2] = Number(bright.value) / 100; placeDot(); commitColor(); });
  const syncWheel = (v) => { if (v) { hsv = rgbToHsv(...hexToRgb(v)); bright.value = String(Math.round(hsv[2] * 100)); placeDot(); } };
  const close = () => { pop.className = "wheel-pop hidden"; if (openWheel === close) openWheel = null; };
  cur.addEventListener("click", () => {
    if (openWheel === close) return close();
    if (openWheel) openWheel();
    syncWheel(curValues()[c.key] || "#ffffff");
    pop.className = "wheel-pop";
    openWheel = close;
  });
  const lc = row.querySelector(".layer-col");
  if (lc) lc.addEventListener("click", () => { setValues({ [c.key]: "" }); syncUI(); changed(); close(); });
  hex.addEventListener("change", () => {
    let v = String(hex.value).trim();
    if (v && !v.startsWith("#")) v = "#" + v;
    if (v.length === 4) v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];   // #f0a -> #ff00aa
    if (v && !/^#[0-9a-f]{6}$/i.test(v)) v = curValues()[c.key];
    if (!v && !allowEmpty) v = curValues()[c.key];
    setValues({ [c.key]: v.toLowerCase() });
    syncUI(); changed();
  });
  ctl[c.key] = { type: "color", set: (v) => {
    hex.value = v || ""; cur.style.backgroundColor = v || "transparent"; cur.textContent = v ? "" : "T";
    if (!pop.className.includes("hidden") && v && !down) syncWheel(v);
  } };
}
function buildControls() {
  const box = $("controls");
  box.innerHTML = "";
  openWheel = null;
  for (const k of Object.keys(ctl)) delete ctl[k];
  const fx = fxDef();
  if (!fx) { $("controlsHint").textContent = ""; return; }
  for (const c of fx.controls) {
    if (c.type === "slider") sliderRow(box, c);
    else if (c.type === "select") selectRow(box, c);
    else if (c.type === "color") colorRow(box, c, fx.defaults[c.key] === "");
  }
  const hints = {
    chromeExtrude: "Drag in the preview to move the vanishing point. Values in % of the text height/box.",
    shadow: "Drag in the preview to set angle and length.",
    motionTrail: "Drag in the preview to set direction and length.",
    lightning: "Point to point: drag the start (A) and end (B) of the bolt in the preview. Seed = a new bolt.",
    star: "Seed = new positions. Edges = where the light would catch the letters.",
    backlight: "Drag in the preview to move the light behind the text – the letters cast the light shafts.",
    corona: "Seed = new ray pattern. Wispiness bends the rays like an aurora.",
  };
  $("controlsHint").textContent = hints[fx.id] || "Sizes in % of the text height, so a look scales with your text.";
}
function buildUI() {
  buildGallery();
  rebuildForStack();
  $("addFx").addEventListener("click", () => {
    addMode = !addMode;
    markActive();
    setStatus(addMode ? "Click an effect below to add it to the stack." : "");
  });
  $("expandCanvas").addEventListener("change", (e) => { state.expandCanvas = e.target.checked; saveState(); });
  $("bg").addEventListener("change", () => sendPreviewParams());
  $("render").addEventListener("click", () => applyRender("manual"));
  $("remove").addEventListener("click", removeRender);
  $("live").addEventListener("change", (e) => { liveLast = null; if (e.target.checked && liveTarget()) applyRender("live"); });
  $("autoUpdate").addEventListener("change", (e) => { try { localStorage.setItem("msrender.auto", e.target.checked ? "1" : "0"); } catch (err) { /* ignore */ } });
  $("resetAll").addEventListener("click", () => {
    const e = selEntry();
    if (!e) return;
    e.values = FX.values(e.effect, {}); delete state.fx[e.effect];
    syncUI(); changed(); setStatus(`${FX.BY_ID[e.effect].name} reset to defaults.`);
  });
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
  if (loadingFromLayer || !$("live").checked) return;
  // Live only updates an existing MS Render group. A plain layer gets effects only by an explicit
  // click (effect tile, look, combo or Apply) – so a new text never picks up an effect by accident.
  if (liveTarget()) debouncedLive();
  else if (hasTarget()) setStatus("Live updates MS Render groups – click an effect or Apply to add the stack to this layer.");
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
  const useStack = (st) => { addMode = false; setStack(st); rebuildForStack(); };
  const use = (effect, values) => useStack(FX.single(effect, values));
  const waitIdle = async () => { await sleep(50); while (busy) await sleep(100); };
  // Verify the selected group against a fresh CPU render of the expected stack:
  // layer names + order, source visibility, XMP and the pixels of every render layer.
  const verify = async (expect) => {
    const r = {};
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " verify" });
      try {
        const t = resolveTarget(doc);
        r.group = !!(t && t.group);
        if (!r.group) return;
        const kids = Array.from(t.group.layers);
        r.children = kids.map((l) => l.name);
        const { a, res } = await computeStack(doc, t.source, expect.stack);
        const exp = layersInDoc(doc, a, res, expect.stack);
        const names = (z) => exp.filter((l) => l.zone === z).map((l) => FX.BY_ID[l.effect].name);
        r.expected = names("above").concat(names("base"), [t.source.name], names("behind"));
        r.orderOk = JSON.stringify(r.children) === JSON.stringify(r.expected);
        r.sourceVisOk = t.source.visible === res.sourceVisible;
        const saved = await readGroupParams(t);
        r.xmpOk = !!saved && stackKey(saved.stack) === stackKey(expect.stack) && saved.sourceId === t.source.id;
        // pixels: the render layers in group order = expected layers above/base/behind order without the source
        const order = exp.filter((l) => l.zone === "above").concat(exp.filter((l) => l.zone === "base"), exp.filter((l) => l.zone === "behind"));
        const psLayers = kids.filter((k) => k.id !== t.source.id);
        r.pixelDiffPct = [];
        r.pixels = 0;
        for (let k = 0; k < order.length && k < psLayers.length; k++) {
          const e = order[k];
          if (e.off || !e.w || !e.h) { r.pixelDiffPct.push(0); continue; }
          const got = await imaging.getPixels({ documentID: doc.id, layerID: psLayers[k].id, sourceBounds: { left: e.left, top: e.top, right: e.left + e.w, bottom: e.top + e.h }, colorSpace: "RGB", componentSize: 8 });
          const gd = to8bit(await got.imageData.getData({ chunky: true }), got.imageData.componentSize || 8);
          const gb = got.sourceBounds, gw = got.imageData.width, gh = got.imageData.height, gc = got.imageData.components;
          got.imageData.dispose();
          let diff = 0, n = 0;
          for (let y = 0; y < e.h; y++) for (let x = 0; x < e.w; x++) {
            const ea = e.buf[(y * e.w + x) * 4 + 3];
            const gx = e.left + x - gb.left, gy = e.top + y - gb.top;
            const ga = gx >= 0 && gy >= 0 && gx < gw && gy < gh ? (gc >= 4 ? gd[(gy * gw + gx) * gc + 3] : 255) : 0;
            if (ea > 8 || ga > 8) { n++; if (Math.abs(ea - ga) > 64) diff++; }
          }
          r.pixels += n;
          r.pixelDiffPct.push(n ? Math.round(diff / n * 1000) / 10 : 0);
        }
        r.renderW = exp.length ? Math.max(...exp.map((l) => l.w)) : 0;
        r.layerCount = order.length;
        // hidden effects: layer present but hidden
        r.hiddenOk = order.every((e, k) => !psLayers[k] || psLayers[k].visible === !e.off);
      } finally { await ctx.hostControl.resumeHistory(hid, false); }
    }, { commandName: HIST + " verify" });
    r.ok = !!(r.group && r.orderOk && r.sourceVisOk && r.xmpOk && r.hiddenOk && r.pixels > 0 && r.pixelDiffPct.every((d) => d <= 1));
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

    // every effect with its defaults (the same group switches its effect each time)
    for (const e of FX.EFFECTS) await check(`Effect ${e.name} (default)`, () => renderAndVerify(e.id, {}));
    // every preset of every effect
    for (const e of FX.EFFECTS) for (const n of Object.keys(e.presets || {})) {
      if (!Object.keys(e.presets[n]).length) continue; // same as default
      await check(`Look ${e.name} › ${n}`, () => renderAndVerify(e.id, e.presets[n]));
    }
    // every combo (several layers in one group)
    for (const n of Object.keys(FX.COMBOS)) {
      await check(`Combo ${n}`, async () => { useStack(FX.comboStack(n)); await applyRender("manual"); return verify(renderParams()); });
    }
    await check("Gallery thumbnails arrived", async () => {
      use("chromeExtrude", {});
      const before = thumbsReceived;
      thumbSig = null; requestThumbs("all");
      const want = FX.EFFECTS.length + Object.keys(FX.COMBOS).length + Object.keys(fxDef().presets || {}).length;
      for (let i = 0; i < 80 && thumbsReceived - before < want; i++) await sleep(250);
      const all = Array.from(document.querySelectorAll("#fxGrid img, #comboGrid img"));
      const imgs = all.filter((i) => String(i.src || "").startsWith("data:image/png")).length;
      const missing = all.filter((i) => !String(i.src || "").startsWith("data:image/png")).map((i) => i.dataset.key);
      // every tile must show a thumbnail; the WebView may run throttled while the panel is hidden, so new
      // renders only need to be arriving (not all within the timeout)
      return { ok: thumbsReceived - before > 0 && imgs === FX.EFFECTS.length + Object.keys(FX.COMBOS).length, received: thumbsReceived - before, want, imgs, missing };
    });
    // ---- building a stack by clicking, like a user
    await check("Stack: + Add puts a second effect into the group", async () => {
      use("chromeExtrude", {});
      await applyRender("manual");
      addMode = true; effectClicked("glow"); await waitIdle();
      const v = await verify(renderParams());
      v.stack = stackLabel(state.stack);
      v.ok = v.ok && state.stack.entries.length === 2 && v.children.length === 3 && fxDef().id === "glow";
      return v;
    });
    await check("Stack: clicking an effect swaps the selected one", async () => {
      effectClicked("fire"); await waitIdle();          // glow is selected → becomes fire
      const v = await verify(renderParams());
      v.stack = stackLabel(state.stack);
      v.ok = v.ok && stackLabel(state.stack) === "Chrome Extrude + Fire";
      return v;
    });
    await check("Stack: a new look replaces the old look, the rest stays", async () => {
      addMode = true; effectClicked("inflate"); await waitIdle();
      const v = await verify(renderParams());
      v.stack = stackLabel(state.stack);
      v.ok = v.ok && stackLabel(state.stack) === "Inflate + Fire";
      return v;
    });
    await check("Stack: hide, order and remove effects", async () => {
      addMode = true; effectClicked("shadow"); await waitIdle();     // new effects go to the top of their zone
      const order1 = stackLabel(state.stack);
      const shadow = state.stack.entries.find((e) => e.effect === "shadow");
      moveEntry(shadow.uid, 1); await waitIdle();                     // shadow below fire
      const order2 = stackLabel(state.stack);
      const fire = state.stack.entries.find((e) => e.effect === "fire");
      fire.on = false; commit(false); await waitIdle();               // fire hidden → its layer stays, hidden
      const v1 = await verify(renderParams());
      const fireLayer = Array.from(resolveTarget(doc).group.layers).find((l) => l.name === "Fire");
      const hiddenOk = v1.ok && !!fireLayer && !fireLayer.visible;
      fire.on = true; commit(false); await waitIdle();
      const v1b = await verify(renderParams());
      removeEntry(fire.uid); await waitIdle();
      const v2 = await verify(renderParams());
      return { ok: hiddenOk && v1b.ok && v2.ok && order1 === "Inflate + Shadow + Fire" && order2 === "Inflate + Fire + Shadow" && stackLabel(state.stack) === "Inflate + Shadow",
        order1, order2, hiddenOk, v1b: v1b.ok, v2 };
    });
    await check("Stack: removing the last effect gives back the plain layer", async () => {
      for (const e of state.stack.entries.slice()) { removeEntry(e.uid); await waitIdle(); }
      const t = resolveTarget(doc);
      return { ok: !t.group && !!t.source && t.source.visible && renderGroupsIn(doc, []).length === 0, group: !!t.group };
    });
    await check("Effects on a look follow its 3D shape (glow around the extrusion)", async () => {
      useStack({ entries: [FX.entry("chromeExtrude", { depth: 40 }), FX.entry("glow", { size: 10 })] });
      await applyRender("manual");
      const v = await verify(renderParams());
      // the glow layer must reach further down than a glow around the flat text would
      const t = resolveTarget(doc);
      const glowL = Array.from(t.group.layers).find((l) => l.name === "Glow"), srcB = boundsOf(t.source);
      v.glowBottom = boundsOf(glowL).bottom; v.textBottom = srcB.bottom;
      v.ok = v.ok && v.glowBottom > v.textBottom + (srcB.bottom - srcB.top) * 0.3;
      return v;
    });
    await check("Preview drag edits the selected effect only", async () => {
      useStack({ entries: [FX.entry("lightning", {}), FX.entry("shadow", {})] });
      const [l, s] = state.stack.entries;
      state.sel = s.uid;
      onDrag({ type: "drag", uid: s.uid, values: { angle: 120, distance: 70 }, final: true });
      onDrag({ type: "drag", uid: l.uid, values: { ax: 5 } });          // not selected – must be ignored
      state.sel = l.uid;
      onDrag({ type: "drag", uid: l.uid, values: { ax: -40, ay: -90 }, final: false });
      onDrag({ type: "drag", uid: l.uid, values: { bx: 80, by: 30 }, final: true });
      useStack(FX.single("backlight", {}));
      const b = state.stack.entries[0];
      onDrag({ type: "drag", uid: b.uid, values: { lx: 20, ly: -30 }, final: true });
      if (b.values.lx !== 20 || b.values.ly !== -30) return { ok: false, light: [b.values.lx, b.values.ly] };
      return { ok: s.values.angle === 120 && s.values.distance === 70 && l.values.ax === -40 && l.values.ay === -90 && l.values.bx === 80 && l.values.by === 30,
        shadow: [s.values.angle, s.values.distance], bolt: [l.values.ax, l.values.ay, l.values.bx, l.values.by] };
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
    await check("Re-selecting the group restores its stack", async () => {
      useStack(FX.comboStack("Neon Sign"));
      await applyRender("manual");
      const want = stackKey(state.stack);
      use("chromeExtrude", {});
      previewSrc = null;
      await refreshPreviewSource();
      return { ok: stackKey(state.stack) === want, got: stackLabel(state.stack) };
    });
    await check("Canvas expands when the effects don't fit", async () => {
      const w0 = Number(doc.width);
      state.expandCanvas = true;
      useStack({ entries: [FX.entry("chromeExtrude", { depth: 50, vpX: 400, vpY: 100 }), FX.entry("fire", { height: 200 })] });
      await applyRender("manual");
      const v = await verify(renderParams());
      v.w0 = w0; v.w1 = Number(doc.width); v.cropped = lastRender.cropped;
      v.ok = v.ok && v.w1 > w0 && !lastRender.cropped;
      return v;
    });
    await check("Live: several updates = one history step", async () => {
      use("chromeExtrude", {});
      await applyRender("manual");
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
      useStack(FX.comboStack("Hot Rod"));
      await applyRender("manual");
      await removeRender();
      const groups = renderGroupsIn(doc, []).length;
      const src = doc.layers.find((l) => l.name.startsWith("RETRO"));
      const renders = doc.layers.filter((l) => RENDER_NAMES.has(l.name)).length;
      return { ok: groups === 0 && !!src && src.visible && renders === 0, groups, renders, sourceVisible: src && src.visible };
    });
    // ---- several texts in one document: a rendered group is final, new texts are independent
    const makeText = (text, vPct) => batchPlay([{ _obj: "make", _target: [{ _ref: "textLayer" }], using: { _obj: "textLayer", textKey: text,
      textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: 30 }, vertical: { _unit: "percentUnit", _value: vPct } },
      textStyleRange: [{ _obj: "textStyleRange", from: 0, to: text.length, textStyle: { _obj: "textStyle", size: { _unit: "pointsUnit", _value: 90 }, color: { _obj: "RGBColor", red: 40, grain: 120, blue: 230 } } }] } }], {});
    let g1 = null, src1 = null, g1Stack = null;
    await check("New text created inside an effect group is moved out", async () => {
      useStack(FX.comboStack("Thunder Chrome"));
      await applyRender("manual");                       // RETRO → group 1 (selected afterwards)
      g1Stack = renderParams().stack;
      const t = resolveTarget(doc); g1 = t.group; src1 = t.source.id;
      const kids0 = g1.layers.length;
      // like the text tool right after rendering: Photoshop puts the new layer inside the selected group
      await core.executeAsModal(async () => { await selectLayer(src1); await makeText("NEW", 85); }, { commandName: HIST + " test new text" });
      const before = groupParts(g1).foreign.length;
      const wrongTarget = resolveTarget(doc).group;      // must not treat the new text as the group's source
      await ejectForeignLayers();
      const sel = doc.activeLayers[0], parts = groupParts(g1);
      return { ok: before === 1 && !wrongTarget && g1.layers.length === kids0 && parts.source.id === src1 && !parts.source.visible && !isRenderGroup(sel.parent) && sel.name.startsWith("NEW"),
        before, wrongTarget: !!wrongTarget, kids0, kids: g1.layers.length, selected: sel.name };
    });
    await check("Second text gets its own effect – first group untouched", async () => {
      effectClicked("glow"); await waitIdle();           // plain layer: a click applies Glow on its own
      const v = await verify(renderParams());
      const p1 = await readGroupParams(groupParts(g1));
      v.group1Same = !!p1 && stackKey(p1.stack) === stackKey(g1Stack);
      v.group1Source = groupParts(g1).source.id === src1;
      v.ok = v.ok && v.group1Same && v.group1Source && resolveTarget(doc).group.id !== g1.id && stackLabel(state.stack) === "Glow";
      return v;
    });
    await check("Auto-update renders a group with ITS stack, not the panel's", async () => {
      // panel shows Glow (group 2); now the text of group 1 changes
      await core.executeAsModal(async () => {
        await selectLayer(src1);
        await batchPlay([{ _obj: "set", _target: [{ _ref: "textLayer", _id: src1 }], to: { _obj: "textLayer", textKey: "RETRO X" } }], {});
      }, { commandName: HIST + " test text" });
      const wasAuto = $("autoUpdate").checked;
      $("autoUpdate").checked = true;
      await checkAutoUpdate();
      $("autoUpdate").checked = wasAuto;
      const v = await verify({ stack: g1Stack });
      v.panel = stackLabel(state.stack);
      return v;
    });
    await check("Live never adds an effect to a plain layer", async () => {
      await core.executeAsModal(async () => { await selectLayer(doc.backgroundLayer.id); await makeText("PLAIN", 15); }, { commandName: HIST + " test plain text" });
      const plain = doc.activeLayers[0];
      const groupsBefore = renderGroupsIn(doc, []).length;
      use("glow", {});
      $("live").checked = true;
      setValues({ size: 12 }); changed();
      await sleep(900);
      await waitIdle();
      $("live").checked = false;
      const groupsAfter = renderGroupsIn(doc, []).length;
      return { ok: groupsAfter === groupsBefore && !isRenderGroup(plain.parent) && plain.visible, groupsBefore, groupsAfter, button: $("render").textContent };
    });
  } catch (e) {
    results.push({ test: "Aborted", ok: false, details: String(e && e.stack || e) });
  }
  state = savedState;
  addMode = false;
  $("live").checked = wasLive;
  rebuildForStack();
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
  await ejectForeignLayers();
  await checkAutoUpdate();
  refreshPreviewSource();
}, 400);

async function init() {
  log("START", { ps: app.version, effects: FX.EFFECTS.length, combos: Object.keys(FX.COMBOS).length });
  buildUI();
  await initPreview();
  try { action.addNotificationListener(["select", "make", "delete", "set", "open", "close", "move", "transform", "editTextLayer"], onPsEvent); }
  catch (e) { log("listener failed", String(e)); }
  // fallback: user text edits may not always notify – poll gently
  setInterval(async () => {
    if (busy || selfTestRunning || Date.now() < ignoreEventsUntil) return;
    if (await ejectForeignLayers()) refreshPreviewSource();
    checkAutoUpdate();
  }, 1500);
  await refreshPreviewSource();
  if (!thumbSig) { thumbSig = "sample"; requestThumbs("all"); }
  sendPreviewParams();
  // developer hook: a file "run-selftest" in the plugin's data folder starts the self-test (then is deleted)
  setInterval(async () => {
    if (busy || selfTestRunning) return;
    try {
      const f = await (await lfs.getDataFolder()).getEntry("run-selftest");
      await f.delete();
      runSelfTest();
    } catch (e) { /* no flag */ }
  }, 3000);
}
init();
