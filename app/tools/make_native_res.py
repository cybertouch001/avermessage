#!/usr/bin/env python3
"""Android resources for the Avermessage app, made from the brand icons:
  brand/icon-1024.png         rounded app icon (legacy launcher icon, splash, offline page)
  brand/icon-1024-square.png  full-bleed icon: indigo->violet vertical gradient + white bubble + gold A
Writes: legacy + round launcher icons, adaptive foreground (bubble + A, kept inside the 66dp safe zone),
monochrome (Android 13 themed icons), notification icon, Android 12+ splash icon, classic splash images.
The adaptive background is a gradient drawable (res/drawable/ic_launcher_background.xml), not a bitmap.
Needs: pip install pillow numpy scipy.   Run: python3 tools/make_native_res.py   (AVM_BRAND=/path/to/brand)"""
import os
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.environ.get('AVM_BRAND', os.path.join(os.path.dirname(HERE), 'brand'))
RES = os.path.join(HERE, 'android', 'app', 'src', 'main', 'res')
DARK = (15, 16, 32, 255)  # #0F1020
D = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}

rounded = Image.open(os.path.join(BRAND, 'icon-1024.png')).convert('RGBA')
square = Image.open(os.path.join(BRAND, 'icon-1024-square.png')).convert('RGBA')

# --- split the full-bleed icon into gradient background + foreground (alpha-unmixed against the gradient) ---
sq = np.array(square.convert('RGB')).astype(float)
N = sq.shape[0]
B = np.repeat(sq[:, 0, :][:, None, :], sq.shape[1], axis=1)      # the gradient only varies with y
den = np.abs(255.0 - B); den[den < 1] = 1
a = np.clip((np.abs(sq - B) / den).max(axis=2), 0, 1); a[a < 0.02] = 0
solid = a > 0.5
inner = ndimage.binary_dilation(ndimage.binary_fill_holes(solid) & ~solid, iterations=2) & ndimage.binary_fill_holes(solid)
aa = a[..., None]
fg = np.where(aa > 0, (sq - (1 - aa) * B) / np.maximum(aa, 1e-3), 0)
a[inner] = 1.0; fg[inner] = sq[inner]                                # the indigo dot inside the bubble is artwork
fg = np.clip(fg, 0, 255)
FG = Image.fromarray(np.dstack([fg, a * 255]).astype(np.uint8), 'RGBA')
# monochrome / notification silhouette: the white bubble, with the A and the dot cut out
white = np.clip((fg.min(axis=2) - 120) / 135.0, 0, 1)
MONO = Image.fromarray(np.dstack([np.full_like(a, 255)] * 3 + [a * white * 255]).astype(np.uint8), 'RGBA')

ys, xs = np.where(a > 0.3)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
rmax = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max()

def centred(src, canvas, radius_frac):
    """src art scaled so its farthest opaque pixel sits radius_frac*canvas from the centre, centred on its bbox."""
    s = radius_frac * canvas / rmax
    w = max(1, round(N * s))
    art = src.resize((w, w), Image.LANCZOS)
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    out.alpha_composite(art, (round(canvas / 2 - cx * s), round(canvas / 2 - cy * s)))
    return out

def save(im, *p):
    f = os.path.join(RES, *p); os.makedirs(os.path.dirname(f), exist_ok=True); im.save(f, optimize=True)

def circle(im):
    w = im.size[0]; m = Image.new('L', (w * 4, w * 4), 0)
    ImageDraw.Draw(m).ellipse([0, 0, w * 4 - 1, w * 4 - 1], fill=255)
    out = im.copy(); out.putalpha(Image.fromarray((np.array(im.split()[3]).astype(float) * np.array(m.resize((w, w), Image.LANCZOS)) / 255).astype(np.uint8)))
    return out

def splash(w, h):
    im = Image.new('RGBA', (w, h), DARK)
    n = round(min(w, h) * 0.34); im.alpha_composite(rounded.resize((n, n), Image.LANCZOS), ((w - n) // 2, (h - n) // 2))
    return im.convert('RGB')

for k, s in D.items():
    n = round(48 * s)
    save(rounded.resize((n, n), Image.LANCZOS), f'mipmap-{k}', 'ic_launcher.png')
    save(circle(square.resize((n, n), Image.LANCZOS)), f'mipmap-{k}', 'ic_launcher_round.png')
    n = round(108 * s)
    save(centred(FG, n, 32 / 108), f'mipmap-{k}', 'ic_launcher_foreground.png')     # 66dp safe zone = r 33dp
    save(centred(MONO, n, 30 / 108), f'mipmap-{k}', 'ic_launcher_monochrome.png')
    n = round(24 * s)
    save(centred(MONO, n, 10.5 / 24), f'drawable-{k}', 'ic_stat_avermessage.png')
    pw, ph = round(320 * s), round(533 * s)
    save(splash(pw, ph), f'drawable-port-{k}', 'splash.png')
    save(splash(ph, pw), f'drawable-land-{k}', 'splash.png')
save(splash(480, 320), 'drawable', 'splash.png')
# Android 12+ system splash icon: 288dp canvas, mark kept inside the central 192dp circle
c = Image.new('RGBA', (1152, 1152), (0, 0, 0, 0)); n = 520
c.alpha_composite(rounded.resize((n, n), Image.LANCZOS), ((1152 - n) // 2, (1152 - n) // 2))
save(c, 'drawable-xxxhdpi', 'splash_icon.png')
print('resources written to', RES)
