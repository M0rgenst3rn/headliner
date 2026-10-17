<p align="center">
  <img src="docs/images/hero.png" alt="MS Render" width="100%">
</p>

<p align="center">
  <b>Retro- und moderne 3D-Texteffekte für Photoshop: Chrome, Gold, Feuer, Blitze, Glow und vieles mehr.<br>
  Direkt aus deinem Live-Text gerendert, der Text bleibt bearbeitbar.</b><br>
  <sub>Photoshop 2023 (24.2) oder neuer · UXP-Panel · aus der Familie von
  <a href="https://github.com/M0rgenst3rn/ms-distress">MS Distress</a> und
  <a href="https://github.com/M0rgenst3rn/ms-printer">MS Printer</a></sub>
</p>

---

## Was ist MS Render?

MS Render ist ein Panel-Plugin für Adobe Photoshop, gemacht für T-Shirt-Designs, Logos und Titel. Du wählst
eine Text- oder Formebene, klickst einen Effekt an und bekommst einen fertigen Look, etwa 80er-Chrome mit
Perspektive, Feuer, Neon-Glow oder Blitze. Effekte lassen sich wie Ebenen **stapeln**. **15 Combos** liefern
fertige Kombinationen.

Alles wird prozedural berechnet, ohne Bilddateien, und ist in jeder Auflösung scharf. Das Ergebnis landet als
echte Ebenen in einer Gruppe. Deine Original-Ebene bleibt darin erhalten und bleibt bearbeitbar: Änderst du den
Text, rechnet MS Render den Effekt automatisch neu.

### Highlights

- **25 Effekte**: 11 Looks, 9 Effekte hinter dem Text, 5 Effekte über dem Text
- **Chrome Extrude** in 10 Materialien mit verschiebbarem Fluchtpunkt, Horizont, Outlines und harten Schatten
- **Stapeln wie Ebenen**: Chrome + Feuer + Glow + Sterne. Jeder Effekt wird eine eigene Ebene
- **15 Combos** als fertige Stapel. **Dein Look bleibt dabei immer genau so, wie du ihn eingestellt hast**
- **Galerie mit deinem eigenen Text**: Alle Vorschaubilder zeigen deine ausgewählte Schrift
- **Live-Vorschau** im Panel, Chrome Extrude auf der GPU in wenigen Millisekunden
- **Live-Text bleibt live**: Text ändern, und der Effekt passt sich an
- **Export für den Druck**: transparentes PNG, 300 dpi, Breite in cm, harte Kanten für **DTF**
- **Selbsttest**: 142 Prüfungen gegen das echte Photoshop-Ergebnis

## 25 Effekte

<p align="center"><img src="docs/images/effects.png" alt="Alle 25 Effekte"></p>

| Look (ersetzt die Füllung) | Hinter dem Text | Über dem Text |
|---|---|---|
| Chrome Extrude, Inflate, Bevel, Glass, Halftone, Brushed Metal, Diamond Plate, Rust, Wood, Marble, Stone | Shadow, Glow, Corona, Backlight, Fire, Smoke, Motion Trail, Retro Stack, Sticker | Lightning, Electrify, Star, Snow, Water Drops |

Jeder Effekt hat eigene **Looks** (Presets). Alle Größen sind in % der Texthöhe angegeben, ein Look passt also
zu jeder Schriftgröße.

## Chrome Extrude

Der klassische 80er-Look, in 10 Materialien und mit eigenen Farben für Himmel und Boden der Spiegelung:

<p align="center"><img src="docs/images/chrome-materials.png" alt="Chrome Extrude in 10 Materialien"></p>

Weitere Einstellungen:
- **Fluchtpunkt und Tiefe**: in der Vorschau ziehen
- **Horizont und Glanz**: wo die Spiegelung liegt und wie stark sie ist
- **Kanten und Seitenwände**: Fase eckig oder rund; Seitenwände im Material oder mit Farbverlauf (Synthwave)
- **Outline und Schatten**: zweite Outline und harter Schatten, jeweils in eigener Farbe

## Effekte stapeln

Ein Stapel funktioniert wie Ebenen in Photoshop. Es gibt einen **Look** (die Füllung), dazu kommen Effekte
**dahinter** und **darüber**. Effekte hinter einem Look folgen seiner 3D-Form: Ein Glow legt sich um die
extrudierten Buchstaben, nicht nur um den flachen Text.

<p align="center"><img src="docs/images/stack-steps.png" alt="Einen Stapel aufbauen"></p>

So baust du einen Stapel:
1. **Look wählen**, z. B. Chrome Extrude, und im Bereich *Settings* das Material auf *Silver* stellen
2. **+ Add effect** klicken, dann **Fire**
3. **+ Add effect** klicken, dann **Glow**
4. Im Stapel mit **▲▼** die Reihenfolge ändern, mit **●** ausblenden, mit **✕** entfernen. Ein Klick auf einen
   Eintrag zeigt dessen Einstellungen

### Was passiert bei welchem Klick?

| Aktion | Ergebnis |
|---|---|
| **Effekt anklicken** | Ersetzt die Effekte um deinen Look. **Der Look bleibt** |
| **Anderen Look anklicken** (Chrome, Inflate, Bevel …) | Wechselt den Look |
| **+ Add effect**, dann Effekt oder Combo | Kommt zusätzlich in den Stapel |
| **⌥-Klick** auf einen Effekt | Tauscht nur den ausgewählten Eintrag aus |
| **Combo anklicken** | Ersetzt die Effekte um deinen Look. **Der Look bleibt** |
| **✕** an einem Eintrag | Entfernt nur diesen Eintrag |
| **Remove all** | Entfernt alle Effekte, die Original-Ebene steht wieder allein da |
| **⌘Z** | Macht jeden Schritt rückgängig, wie gewohnt |

## 15 Combos

Fertige Stapel zum Ausprobieren. Die Vorschaubilder im Panel zeigen jede Combo **mit deinem Text und deinem
Look**, also genau das, was ein Klick ergibt.

<p align="center"><img src="docs/images/combos.png" alt="Alle 15 Combos"></p>

### Dein Look bleibt

Hast du einen Look eingestellt, etwa silbernes Chrome mit eigener Tiefe, behält jede Combo ihn bei. Die Combo
tauscht nur die Effekte darum herum aus. Ihren eigenen Look bringt sie nur mit, wenn du noch keinen gewählt hast.

<p align="center"><img src="docs/images/look-stays.png" alt="Combos behalten deinen Look"></p>

## Kombinationsideen

Diese Stapel baust du mit **+ Add effect** selbst nach:

<p align="center"><img src="docs/images/ideas.png" alt="Kombinationsideen"></p>

| Idee | Look | Dahinter | Darüber | Tipp |
|---|---|---|---|---|
| Cyber | Bevel, Farbe Cyan, Profil rund | Glow cyan | Electrify hellblau | Dunkles Shirt, Glow-Größe 20 % |
| Winter | Glass, hellblau | Backlight | Snow | Backlight hinter den Text ziehen |
| Gold | Chrome Extrude, Gold | Corona | Star | Wenige, große Sterne wirken edler |
| Speed | Chrome Extrude, Black Chrome | Motion Trail + Shadow | – | Richtung in der Vorschau ziehen |
| Holz | Wood | Sticker + Shadow (Drop) | – | Klassischer Aufnäher-Look |
| Retro | Inflate, gelb | Retro Stack | – | Palette im Retro Stack wechseln |

## Export für den Druck

Unter **Export for print** speicherst du die ausgewählte Gruppe oder alle sichtbaren Ebenen als PNG:
- **Format**: transparent und auf das Design zugeschnitten
- **Größe**: 300 dpi, die Druckbreite gibst du in cm an
- **Hard edges (DTF)**: Entfernt alle halbtransparenten Pixel. DTF-Drucker machen daraus sonst Raster-Ränder
- **Sicherheit**: Der Export läuft auf einer Kopie, dein Dokument bleibt unverändert

## Installation

### macOS (empfohlen)

1. Repository herunterladen (**Code → Download ZIP**) und entpacken
2. Im Terminal im entpackten Ordner ausführen:
   ```bash
   bash install-mac.sh
   ```
3. Photoshop (neu) starten → **Zusatzmodule (Plugins) › MS Render**

Das Skript braucht [Node.js](https://nodejs.org) für den Bundle-Schritt der Vorschau.

### Alternative: UXP Developer Tool (macOS & Windows)

1. „UXP Developer Tools“ über die Creative-Cloud-App installieren
2. In Photoshop unter *Einstellungen › Zusatzmodule* den **Entwicklermodus** aktivieren
3. Einmal `node tools/bundle.js` ausführen
4. Im UXP Developer Tool **Add Plugin** wählen, dann `render/manifest.json` → **Load**

## So benutzt du es

1. **Ebene wählen**: eine Text- oder Formebene auswählen. Die Galerie zeigt sofort alle Effekte mit deinem Text
2. **Effekt, Look oder Combo anklicken**: Der Effekt wird direkt angewendet. Es entsteht eine Gruppe
   *„MS Render · …“* mit deiner Ebene und einer Ebene pro Effekt
3. **Anpassen**: Feinschliff unter *Settings* oder durch Ziehen in der Vorschau, dann **Update**
   - **Live** überträgt Änderungen sofort
   - **Auto-update** rechnet neu, sobald du den Text änderst
4. **Weitere Texte**: Jeder Text bekommt seine eigene Gruppe. Ein fertig gerenderter Text bleibt, wie er ist
5. **Später wieder bearbeiten**: Gruppe auswählen, das Panel lädt ihren Stapel mit allen Einstellungen
6. **Exportieren**: unter *Export for print*

**Tipp:** Passt ein Effekt nicht auf die Arbeitsfläche, vergrößert **Expand canvas** sie automatisch.

## Projektstruktur

```
render/              Das Plugin (wird so in Photoshop geladen)
  manifest.json      Plugin-Beschreibung
  index.html         Panel-Oberfläche
  main.js            Photoshop-Anbindung (Gruppe, XMP, Live-Text, Export, Selbsttest)
  engine.js          Kern: Distanzfelder, Chrome-Extrude-Renderer
  effects.js         Alle 25 Effekte, Looks, Stapel und Combos
  preview/           Live-Vorschau und Galerie (WebView; fx.js erzeugt tools/bundle.js)
install-mac.sh       Bündelt, packt (.ccx) und installiert das Plugin
tools/               Bundle-Schritt, Prüfskript, Showcase-Renderer, Vorschau-Testseite
docs/images/         Bilder dieser README
```

```bash
node tools/qa-check.js              # Engine-Prüfungen ohne Photoshop (alle Effekte, Combos, Grenzfälle)
python3 tools/showcase-server.py    # dann die angezeigte Adresse öffnen: erzeugt die README-Bilder neu
```

Im Panel prüft **Self-test** (unter *Tools*) 142 Fälle automatisch gegen das echte Photoshop-Ergebnis.
Er legt dafür ein eigenes Testdokument an.

## Fehler gefunden? Ideen?

Melde dich gern! Am einfachsten über **[Issues](https://github.com/M0rgenst3rn/ms-render/issues)** hier auf GitHub:
**New issue** klicken und kurz beschreiben, was passiert ist. Hilfreich sind Photoshop-Version, Betriebssystem
und gern ein Screenshot. Dafür brauchst du nur ein kostenloses GitHub-Konto. Verbesserungsvorschläge und
Wünsche für neue Funktionen sind genauso willkommen.

## Lizenz

[MIT](LICENSE): Du darfst den Code frei ansehen, verändern, weitergeben und auch kommerziell nutzen.
Einzige Bedingung: Der Lizenzhinweis bleibt in Kopien enthalten.

Adobe und Photoshop sind Marken von Adobe Inc. Dieses Projekt ist unabhängig und steht in keiner
Verbindung zu Adobe.

---

<p align="center"><sub>MS Render<br>
Entwickelt von Linus Leinberger</sub></p>
