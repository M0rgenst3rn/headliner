// Morgenstern-Bedienelemente – gemeinsam für alle MS-Werkzeuge.
// Bewusst keine Photoshop-Bausteine (sp-slider, native Checkboxen/Selects, Photoshop-Farbwähler als Standard):
// eigene Regler, Schalter, Segmente, Farb-Popover, aufklappbare Bereiche und Preset-Liste.
// Die Klassen passen zu ms-ui.css.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Regler: Name und Wert oben, darunter eine schmale Spur mit leuchtender Füllung.
// Ziehen, Klick auf die Spur, Pfeiltasten (Umschalt = ×10), Doppelklick = Standardwert, Wert direkt eintippen.
// def: { label, min, max, step, unit, tip, sub, def }  io: { get(), set(v), done() }
function slider(parent, def, io) {
  const row = document.createElement("div");
  row.className = "sl";
  if (def.tip) row.title = def.tip;
  row.innerHTML = `<div class="sl-head"><span class="sl-label">${esc(def.label)}</span><span class="sl-val"><input class="sl-num" type="text"><span class="sl-unit">${esc(def.unit || "")}</span></span></div>` +
    `<div class="sl-track" tabindex="0"><div class="sl-rail"></div><div class="sl-fill"></div><div class="sl-thumb"></div></div>`;
  parent.appendChild(row);
  const track = row.querySelector(".sl-track"), fill = row.querySelector(".sl-fill"), thumb = row.querySelector(".sl-thumb"), num = row.querySelector(".sl-num");
  const step = def.step || 1, span = def.max - def.min, zero = Math.max(def.min, Math.min(def.max, 0));
  const snap = (v) => { v = Math.round((v - def.min) / step) * step + def.min; return Math.max(def.min, Math.min(def.max, +v.toFixed(4))); };
  const show = (v) => {
    const t = (v - def.min) / span, z = (zero - def.min) / span;
    fill.style.left = (Math.min(t, z) * 100) + "%";
    fill.style.width = (Math.abs(t - z) * 100) + "%";
    thumb.style.left = (t * 100) + "%";
    if (document.activeElement !== num) num.value = String(v);
  };
  const commit = (v) => { v = snap(v); if (io.get() === v) return; io.set(v); show(v); };
  const done = () => { if (io.done) io.done(); };
  const fromX = (x) => { const r = track.getBoundingClientRect(); return def.min + Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width))) * span; };
  let drag = false;
  const down = (e) => { drag = true; row.className += " dragging"; commit(fromX(e.clientX)); };
  const move = (e) => { if (drag) commit(fromX(e.clientX)); };
  const up = () => { if (!drag) return; drag = false; row.className = row.className.replace(" dragging", ""); done(); };
  track.addEventListener("mousedown", down);
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  track.addEventListener("dblclick", () => { commit(def.def !== undefined ? def.def : def.min); done(); });
  track.addEventListener("keydown", (e) => {
    const k = e.key, st = step * (e.shiftKey ? 10 : 1);
    if (k === "ArrowRight" || k === "ArrowUp") { commit(io.get() + st); done(); e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "ArrowDown") { commit(io.get() - st); done(); e.preventDefault(); }
  });
  num.addEventListener("change", () => {
    let v = parseFloat(String(num.value).replace(",", "."));
    if (isNaN(v)) v = io.get();
    commit(v); num.value = String(io.get()); done();
  });
  show(io.get());
  return { row, def, set: show };
}

// Schalter, der ein verstecktes Kontrollkästchen steuert – so bleibt „.checked“ für die Logik erhalten.
// Markup: <div class="switch" data-for="id"><span class="knob"></span><span class="sw-label">…</span></div><input type="checkbox" id="id" class="hidden">
const switchHandlers = {};
function bindSwitch(id, onChange) {
  const input = document.getElementById(id), sw = document.querySelector(`.switch[data-for="${id}"]`);
  switchHandlers[id] = onChange;
  sw.addEventListener("click", () => { input.checked = !input.checked; syncSwitches(); if (onChange) onChange(input.checked); });
}
function setSwitch(id, on) { document.getElementById(id).checked = !!on; syncSwitches(); }
function syncSwitches() {
  document.querySelectorAll(".switch").forEach((sw) => {
    const input = document.getElementById(sw.getAttribute("data-for"));
    const rest = String(sw.className).split(/\s+/).filter((c) => c && c !== "on").join(" ");
    sw.className = rest + (input && input.checked ? " on" : "");
  });
}

// Segment-Schalter (ersetzt Ausklapplisten). options: [{ id, name, tip }]
function seg(el, options, onPick) {
  el.innerHTML = options.map((o) => `<div class="seg-btn" data-v="${esc(o.id)}"${o.tip ? ` title="${esc(o.tip)}"` : ""}>${esc(o.name)}</div>`).join("");
  el.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => onPick(b.getAttribute("data-v"))));
}
function syncSeg(el, value) {
  el.querySelectorAll(".seg-btn").forEach((b) => { b.className = b.getAttribute("data-v") === String(value) ? "seg-btn active" : "seg-btn"; });
}

// Farb-Popover: abgestimmte Palette, Hex-Eingabe, Photoshops Farbwähler nur auf Wunsch („Exakt wählen…“).
const PALETTE = ["#ffffff", "#ffe9c7", "#ffcf9a", "#ffb060", "#ff8a3d", "#ff5a2a", "#ff3f6e", "#ff3fa4",
  "#d24dff", "#9a5cff", "#6a5cff", "#3d6bff", "#2a8cff", "#3fd4ff", "#2fe0c8", "#2fb8b0",
  "#39ff7a", "#a6ff4d", "#ffe14d", "#9cc4ff", "#c8d8ff", "#7a86a3", "#3a4058", "#000000"];
let popKey = null;
// Das Popover erscheint unter der ganzen Zeile (.field / .row) des Farbfelds
function rowOf(el) { while (el && !/\b(field|row)\b/.test(el.className || "")) el = el.parentNode; return el; }
// opts: { pop (Element), key, anchor (Element in der Zeile), get(), set(hex), exact() , palette }
function openColorPop(opts) {
  const pop = opts.pop;
  if (popKey === opts.key && pop.className.indexOf("hidden") < 0) return closeColorPop(pop);
  popKey = opts.key;
  const cur = String(opts.get()).toLowerCase(), pal = opts.palette || PALETTE;
  pop.innerHTML = `<div class="pal">${pal.map((c) => `<div class="pal-c${c === cur ? " on" : ""}" data-c="${c}" style="background-color:${c}"></div>`).join("")}</div>` +
    `<div class="pop-row"><input type="text" class="hex pop-hex" maxlength="7" value="${esc(cur)}">` +
    (opts.exact ? `<div class="btn small ghost pop-exact">Exakt wählen…</div>` : "") +
    `<div class="btn small pop-done">Fertig</div></div>`;
  const row = rowOf(opts.anchor) || opts.anchor;
  row.parentNode.insertBefore(pop, row.nextSibling);
  pop.className = "color-pop";
  const hex = pop.querySelector(".pop-hex");
  const mark = (c) => { pop.querySelectorAll(".pal-c").forEach((el) => { el.className = el.getAttribute("data-c") === c ? "pal-c on" : "pal-c"; }); hex.value = c; };
  const set = (c) => { opts.set(c); mark(c); };
  pop.querySelectorAll(".pal-c").forEach((el) => el.addEventListener("click", () => set(el.getAttribute("data-c"))));
  hex.addEventListener("change", () => { let v = String(hex.value).trim(); if (v[0] !== "#") v = "#" + v; if (/^#[0-9a-f]{6}$/i.test(v)) set(v.toLowerCase()); else hex.value = String(opts.get()); });
  if (opts.exact) pop.querySelector(".pop-exact").addEventListener("click", async () => { await opts.exact(); mark(String(opts.get()).toLowerCase()); });
  pop.querySelector(".pop-done").addEventListener("click", () => closeColorPop(pop));
}
function closeColorPop(pop) { popKey = null; if (pop) pop.className = "color-pop hidden"; }

// Aufklappbare Bereiche (.sec[data-sec] > .sec-head + .sec-body); das Panel merkt sich, was offen war
function sections(storeKey, defaults) {
  let open = {};
  try { open = Object.assign({}, defaults, JSON.parse(localStorage.getItem(storeKey) || "{}")); } catch (e) { open = Object.assign({}, defaults); }
  document.querySelectorAll(".sec").forEach((sec) => {
    const name = sec.getAttribute("data-sec"), head = sec.querySelector(".sec-head");
    const apply = () => { sec.className = open[name] ? "sec open" : "sec"; };
    head.addEventListener("click", () => { open[name] = !open[name]; apply(); try { localStorage.setItem(storeKey, JSON.stringify(open)); } catch (e) { /* egal */ } });
    apply();
  });
}
// Kopf eines Bereichs mit Titel, Zusatz rechts daneben und +/– (für Markup, das per JS entsteht)
function secHead(title, metaId, meta) {
  return `<div class="sec-head"><span class="sec-title">${esc(title)}</span><span${metaId ? ` id="${metaId}"` : ""} class="sec-meta">${esc(meta || "")}</span><span class="chev c-open">–</span><span class="chev c-closed">+</span></div>`;
}

// Eigene Presets als Liste: Klick lädt, × löscht
function presetList(box, names, onLoad, onDelete) {
  box.innerHTML = names.length
    ? names.map((n) => `<div class="preset" data-n="${esc(n)}"><span class="preset-name">${esc(n)}</span><span class="preset-del" title="Löschen">×</span></div>`).join("")
    : `<div class="empty">Noch keine eigenen Presets – stell einen Look ein und speichere ihn.</div>`;
  box.querySelectorAll(".preset").forEach((el) => {
    const n = el.getAttribute("data-n");
    el.querySelector(".preset-name").addEventListener("click", () => onLoad(n));
    el.querySelector(".preset-del").addEventListener("click", () => onDelete(n));
  });
}

module.exports = { esc, slider, bindSwitch, setSwitch, syncSwitches, seg, syncSeg, PALETTE, openColorPop, closeColorPop, sections, secHead, presetList };
