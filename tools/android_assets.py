#!/usr/bin/env python3
"""Make the Android app icons and splash screens from the website icons.

Usage:  python3 tools/android_assets.py        (needs Pillow: pip install pillow)

Run it again whenever icon-512.png / icon-maskable-512.png change.
  - Launcher icon (older phones):  icon-512.png
  - Round launcher icon:           icon-maskable-512.png in a circle
  - Adaptive icon (Android 8+):    icon-maskable-512.png on the app's navy, sized so the logo
                                   stays inside the part every phone shape shows
  - Splash screens:                the icon in the middle of the app's background colour
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(HERE, "android", "app", "src", "main", "res")
NAVY = (34, 53, 110, 255)          # theme colour #22356E (also the maskable icon's background)
BACKGROUND = (243, 245, 248, 255)  # app background #F3F5F8
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

icon = Image.open(os.path.join(HERE, "icon-512.png")).convert("RGBA")
maskable = Image.open(os.path.join(HERE, "icon-maskable-512.png")).convert("RGBA")


def save(img, folder, name):
    os.makedirs(os.path.join(RES, folder), exist_ok=True)
    img.save(os.path.join(RES, folder, name), optimize=True)


def circle(img):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


for d, k in DENSITIES.items():
    legacy = round(48 * k)
    save(icon.resize((legacy, legacy), Image.LANCZOS), "mipmap-" + d, "ic_launcher.png")
    save(circle(maskable.resize((legacy, legacy), Image.LANCZOS)), "mipmap-" + d, "ic_launcher_round.png")
    # Adaptive foreground: 108dp canvas, of which a 72dp circle is always visible. The maskable icon
    # keeps its logo inside its middle 80%, so scale it until that 80% equals the 72dp circle.
    canvas = round(108 * k)
    inner = round(canvas * 72 / 108 / 0.8)
    fg = Image.new("RGBA", (canvas, canvas), NAVY)
    off = (canvas - inner) // 2
    fg.paste(maskable.resize((inner, inner), Image.LANCZOS), (off, off))
    save(fg, "mipmap-" + d, "ic_launcher_foreground.png")

# Splash screens: keep each existing image's size, paint the background, put the icon in the middle.
for folder in sorted(os.listdir(RES)):
    path = os.path.join(RES, folder, "splash.png")
    if not folder.startswith("drawable") or not os.path.exists(path):
        continue
    w, h = Image.open(path).size
    splash = Image.new("RGBA", (w, h), BACKGROUND)
    size = max(48, round(min(w, h) * 0.28))
    splash.paste(icon.resize((size, size), Image.LANCZOS), ((w - size) // 2, (h - size) // 2), icon.resize((size, size), Image.LANCZOS))
    splash.convert("RGB").save(path, optimize=True)

with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#22356E</color>\n</resources>\n')

for stale in ("drawable-v24/ic_launcher_foreground.xml", "drawable/ic_launcher_background.xml"):
    p = os.path.join(RES, stale)
    if os.path.exists(p):
        os.remove(p)
print("Android icons and splash screens updated in", RES)
