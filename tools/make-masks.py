#!/usr/bin/env python3
"""Anti-aliased text masks for tools/quality-bench.js.

Writes <out>/<name>.raw (8-bit alpha, row by row) and <out>/masks.json with the sizes.
The masks look like the soft-edged alpha Photoshop hands to the plugin.

Usage: python3 tools/make-masks.py <out-dir>
Needs Pillow (pip install pillow).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = {
    # heavy sans, thin serif, heavy italic – the first file found on the system is used
    "heavy": ["/usr/share/fonts/opentype/inter/Inter-Black.otf", "/Library/Fonts/Arial Black.ttf",
              "C:/Windows/Fonts/ariblk.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "serif": ["/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf", "/Library/Fonts/Times New Roman.ttf",
              "C:/Windows/Fonts/times.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"],
    "italic": ["/usr/share/fonts/opentype/inter/Inter-BlackItalic.otf", "/Library/Fonts/Arial Bold Italic.ttf",
               "C:/Windows/Fonts/arialbi.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"],
}
SIZES = [40, 120, 400, 1200]
TEXT = "Rgo"


def font_file(kind):
    for f in FONTS[kind]:
        if os.path.exists(f):
            return f
    raise SystemExit("no font found for " + kind)


def mask(kind, size):
    font = ImageFont.truetype(font_file(kind), size)
    x0, y0, x1, y1 = font.getbbox(TEXT)
    m = max(4, size // 10)
    img = Image.new("L", (x1 - x0 + 2 * m, y1 - y0 + 2 * m), 0)
    # a fractional offset so the edges do not line up with the pixel grid
    ImageDraw.Draw(img).text((m - x0 + 0.37, m - y0 + 0.21), TEXT, font=font, fill=255)
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "quality-out/masks"
    os.makedirs(out, exist_ok=True)
    info = {}
    for kind in FONTS:
        for size in SIZES:
            img = mask(kind, size)
            name = f"{kind}-{size}"
            with open(os.path.join(out, name + ".raw"), "wb") as fh:
                fh.write(img.tobytes())
            info[name] = {"w": img.width, "h": img.height, "font": os.path.basename(font_file(kind)), "size": size}
    with open(os.path.join(out, "masks.json"), "w") as fh:
        json.dump(info, fh, indent=1)
    print("masks written to", out)


if __name__ == "__main__":
    main()
