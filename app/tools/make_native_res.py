#!/usr/bin/env python3
"""Android resources for AverChat from brand/: icon-1024.png (rounded), icon-1024-square.png (full bleed),
mark-1024.png (white bubble + violet A on transparent). Static images only (the launch logo is not animated)."""
import os
import numpy as np
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.environ.get('AVM_BRAND', os.path.join(os.path.dirname(HERE), 'brand'))
RES = os.path.join(HERE, 'android', 'app', 'src', 'main', 'res')
D = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
BG = (12, 7, 24, 255)
rounded = Image.open(os.path.join(BRAND, 'icon-1024.png')).convert('RGBA')
square = Image.open(os.path.join(BRAND, 'icon-1024-square.png')).convert('RGBA')
mark = Image.open(os.path.join(BRAND, 'mark-1024.png')).convert('RGBA')
a = np.array(mark).astype(float)
white = (a[..., 0] > 200) & (a[..., 1] > 200) & (a[..., 2] > 200)
mono = np.zeros_like(a); mono[..., :3] = 255; mono[..., 3] = np.where(white, a[..., 3], 0)
MONO = Image.fromarray(mono.astype('uint8'))
bbox = mark.getbbox(); FG = mark.crop(bbox); MONO = MONO.crop(bbox)
def save(im, *p):
    f = os.path.join(RES, *p); os.makedirs(os.path.dirname(f), exist_ok=True); im.save(f, optimize=True)
def circle(im):
    m = Image.new('L', im.size, 0); ImageDraw.Draw(m).ellipse([0, 0, im.size[0] - 1, im.size[1] - 1], fill=255); o = im.copy(); o.putalpha(m); return o
def centred(src, n, frac):
    c = Image.new('RGBA', (n, n), (0, 0, 0, 0)); w, h = src.size; s = n * frac * 2 / max(w, h)
    r = src.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS); c.alpha_composite(r, ((n - r.size[0]) // 2, (n - r.size[1]) // 2)); return c
def splash(w, h):
    c = Image.new('RGBA', (w, h), BG); n = round(min(w, h) * 0.36); c.alpha_composite(rounded.resize((n, n), Image.LANCZOS), ((w - n) // 2, (h - n) // 2)); return c
for k, s in D.items():
    n = round(48 * s); save(rounded.resize((n, n), Image.LANCZOS), f'mipmap-{k}', 'ic_launcher.png'); save(circle(square.resize((n, n), Image.LANCZOS)), f'mipmap-{k}', 'ic_launcher_round.png')
    n = round(108 * s); save(centred(FG, n, 30 / 108), f'mipmap-{k}', 'ic_launcher_foreground.png'); save(centred(MONO, n, 28 / 108), f'mipmap-{k}', 'ic_launcher_monochrome.png')
    n = round(24 * s); save(centred(MONO, n, 10.5 / 24), f'drawable-{k}', 'ic_stat_avermessage.png')
    pw, ph = round(320 * s), round(533 * s); save(splash(pw, ph), f'drawable-port-{k}', 'splash.png'); save(splash(ph, pw), f'drawable-land-{k}', 'splash.png')
save(splash(480, 320), 'drawable', 'splash.png')
c = Image.new('RGBA', (1152, 1152), (0, 0, 0, 0)); n = 560; c.alpha_composite(rounded.resize((n, n), Image.LANCZOS), ((1152 - n) // 2, (1152 - n) // 2)); save(c, 'drawable-xxxhdpi', 'splash_icon.png')
open(os.path.join(RES, 'drawable', 'ic_launcher_background.xml'), 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<!-- adaptive icon background: AverChat violet gradient -->\n<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n    <gradient android:angle="315" android:startColor="#4C1D95" android:centerColor="#7C3AED" android:endColor="#D946EF" android:type="linear" />\n</shape>\n')
www = os.path.join(HERE, 'www'); rounded.resize((192, 192), Image.LANCZOS).save(os.path.join(www, 'icon.png'))
print('resources written to', RES)
