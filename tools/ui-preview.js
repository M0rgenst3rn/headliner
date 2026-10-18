// Zeigt die Panel-Oberfläche im Browser (ohne Photoshop): Photoshop/UXP werden nachgebildet.
// Aufruf über ui-preview.html; der Plugin-Ordner steht dort in data-plugin (z. B. "../glow/").
const SCRIPT_END = "</" + "script>";
const f = document.getElementById("frame");
const base = f.getAttribute("data-plugin");
(async () => {
  const get = async (p) => (await fetch(base + p)).text();
  const html = await get("index.html");
  const main = await get("main.js");
  // alle lokalen Module einsammeln, die main.js (und deren Module) per require("./x.js") laden
  const mods = {};
  const scan = async (src) => {
    for (const m of src.matchAll(/require\("\.\/([^"]+)"\)/g)) {
      if (mods[m[1]] !== undefined) continue;
      mods[m[1]] = "";
      mods[m[1]] = await get(m[1]);
      await scan(mods[m[1]]);
    }
  };
  await scan(main);
  const defs = Object.keys(mods).map((n) => `window.__defs[${JSON.stringify(n)}] = function (module, exports, require) {\n${mods[n]}\n};`).join("\n");
  const stub = "<script>" + `
  window.__defs = {}; window.__cache = {};
  ` + defs + `
  const fake = { app: { activeDocument: null, version: "test", documents: [], foregroundColor: { rgb: { red: 0, green: 0, blue: 0 } } }, core: { executeAsModal: async (fn) => fn({ hostControl: { suspendHistory: async () => 1, resumeHistory: async () => {} } }) },
    action: { batchPlay: async () => [{}], addNotificationListener: () => {} }, imaging: {}, constants: {} };
  const uxp = { storage: { localFileSystem: { getDataFolder: async () => ({ createFile: async () => ({ write: async () => {} }), getEntry: async () => { throw 1; }, getEntries: async () => [] }), getFileForSaving: async () => null }, formats: { utf8: "utf8", binary: "binary" } }, entrypoints: { setup: () => {} } };
  window.require = (n) => {
    if (n === "photoshop") return fake;
    if (n === "uxp") return uxp;
    const k = n.replace("./", "");
    if (window.__cache[k]) return window.__cache[k].exports;
    const module = { exports: {} }; window.__cache[k] = module;
    window.__defs[k](module, module.exports, window.require);
    return module.exports;
  };
  ` + SCRIPT_END;
  const doc = html
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (m, h) => `<link rel="stylesheet" href="${base}${h}">`)
    .replace("</head>", () => stub + "</head>")
    .replace('<script src="main.js"></' + 'script>', () => "<script>" + main + SCRIPT_END);
  f.srcdoc = doc;
})();
