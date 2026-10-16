# MS Render

**Retro 3D effects for live text and shapes in Photoshop** – chrome, gold and silver extrusions with
bevels, outlines and hard retro shadows, rendered from your live text so it stays editable.
Part of the MS family with [MS Distress](https://github.com/M0rgenst3rn/ms-distress) and
[MS Printer](https://github.com/M0rgenst3rn/ms-printer).

> **Status: early development (Phase 1).** The first effect, *Chrome Extrude*, works end to end.
> More effects follow – see the roadmap.

![First render in Photoshop](docs/images/first-render-photoshop.jpg)

## What works today
- **Chrome Extrude**: perspective extrusion toward a vanishing point, chamfer or round (bubble) bevel,
  chrome / gold / silver, dark edge line, outline, hard retro shadow
- **GPU live preview** (WebGL 2 in the panel) – updates in 1–5 ms while you move sliders
- **Live text stays live**: the source layer goes into a group *“MS Render · …”*, hidden but editable.
  Change the text and the render updates automatically
- **Settings are stored in the layer** (XMP) – select the group later and the panel restores them
- **Expands the canvas** when the extrusion or shadow doesn't fit
- **Live mode** (one history step), presets, self-test (15 checks)

## Install (macOS)
```bash
bash install-mac.sh
```
Restart Photoshop → **Plugins › MS Render**.

## Use
1. Select a text or shape layer
2. Pick a preset or adjust material, extrusion, outline and shadow – the preview updates instantly
3. Click **Render** (or enable **Live**)
4. **Remove** puts the original layer back

## Project layout
```
render/          the plugin
  engine.js      CPU renderer (final renders, fallback) – pure JS
  preview/       GPU live preview (WebGL 2, runs in a WebView inside the panel)
  main.js        Photoshop integration (group, XMP, live text, self-test)
tools/           Node test renderer, icon generator, browser preview harness
```

---

<p align="center"><sub>Built by Linus Leinberger</sub></p>
