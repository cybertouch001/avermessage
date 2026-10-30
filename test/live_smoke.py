# Avermessage headless end-to-end test: 3 users in separate browser contexts against tools/dev-server.mjs.
# Run: PORT=8790 node tools/dev-server.mjs &  then  python3 test/e2e.py <shots_dir> [boot_token]
import sys, os, time, json, struct, zlib
from playwright.sync_api import sync_playwright
BASE = os.environ.get('AVM_BASE', 'http://localhost:8790')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/avm-shots'
BOOT = sys.argv[2] if len(sys.argv) > 2 else ''
os.makedirs(OUT, exist_ok=True)
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond), extra)); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra) if extra else ''), flush=True)
from PIL import Image, ImageDraw
_im = Image.new('RGB', (640, 420)); _d = ImageDraw.Draw(_im)
for _y in range(420): _d.line([(0, _y), (640, _y)], fill=(255 - _y // 3, 90 + _y // 4, 200))
_d.ellipse([220, 100, 420, 300], fill=(255, 200, 40)); _im.save('/tmp/avm-photo.png')
def _unused(w=320, h=200):
    raw = b''.join(b'\x00' + bytes([(x * 255 // w), (y * 255 // h), 180] * 1)[0:0] + bytes(sum(([x * 255 // w, y * 255 // h, 200] for x in range(w)), [])) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open('/tmp/avm-report.pdf', 'wb').write(b'%PDF-1.4\n% Avermessage test document\n' + b'0' * 5000)
errors = {}
def page_for(browser, name, mobile=False):
    vp = {'width': 412, 'height': 860} if mobile else {'width': 1280, 'height': 800}
    ctx = browser.new_context(viewport=vp, permissions=['microphone', 'camera', 'notifications'], is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    pg = ctx.new_page(); errors[name] = []
    pg.on('pageerror', lambda e: errors[name].append(str(e)))
    pg.on('console', lambda m: errors[name].append(m.text) if m.type == 'error' and '401' not in m.text and not (name == 'C' and '404' in m.text) and not (name == 'A' and ('403' in m.text or '400' in m.text)) else None)
    pg.goto(BASE); pg.wait_for_selector('.auth-card, #app', timeout=15000)
    return pg
def signup(pg, name, user, phone=''):
    pg.click('.seg button[data-m=signup]'); pg.fill('input[name=name]', name); pg.fill('input[name=username]', user)
    if phone: pg.fill('input[name=phone]', phone)
    pg.fill('input[name=password]', 'password-' + user); pg.click('#authf button'); pg.wait_for_selector('#app', timeout=15000)
def shot(pg, name): p = os.path.join(OUT, name); pg.screenshot(path=p); return p
def open_chat_with(pg, username):
    pg.click('#fab'); pg.fill('#pq', username); pg.wait_for_selector(f'.userrow:has-text("@{username}")', timeout=8000); pg.click(f'.userrow:has-text("@{username}")'); pg.wait_for_selector('#ta', timeout=8000)
def send_text(pg, text): pg.fill('#ta', text); pg.click('#b-send')
def wait_msg(pg, text, timeout=10000): pg.wait_for_selector(f'.msg .txt:has-text("{text}")', timeout=timeout)


import random
sfx = '%04d' % random.randint(0, 9999)
ua, ub = 'qa_a' + sfx, 'qa_b' + sfx
with sync_playwright() as p:
    br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    A = page_for(br, 'A'); B = page_for(br, 'B')
    try:
        signup(A, 'QA Tester A', ua); signup(B, 'QA Tester B', ub); ok('live signup 2 users', True)
        open_chat_with(A, ub); send_text(A, 'live test hello'); wait_msg(A, 'live test hello')
        B.wait_for_selector('.chatrow:has-text("QA Tester A")', timeout=15000); B.click('.chatrow:has-text("QA Tester A")'); wait_msg(B, 'live test hello')
        A.wait_for_selector('.msg.out .ticks.read', timeout=15000); ok('live message + read ticks', True)
        open('/tmp/avm-big.pdf', 'wb').write(b'%PDF-1.4\n' + os.urandom(6 * 1024 * 1024))
        A.set_input_files('#f-doc', '/tmp/avm-big.pdf'); B.wait_for_selector('.docmsg:has-text("avm-big.pdf")', timeout=60000)
        href = B.get_attribute('.docmsg a.dl', 'href'); n = B.evaluate('(h) => fetch(h).then(r => r.arrayBuffer()).then(b => b.byteLength)', href); ok('live 6 MB document upload + download', n == os.path.getsize('/tmp/avm-big.pdf'), n)
        A.set_input_files('#f-media', '/tmp/avm-photo.png'); A.wait_for_selector('.media-prev', timeout=5000); A.click('.media-prev .btn:not(.ghost)')
        B.wait_for_function("() => [...document.querySelectorAll('.mimg img')].some(i => i.naturalWidth > 0)", timeout=30000); ok('live photo', True)
        A.click('#b-send'); A.wait_for_selector('.recbar', timeout=5000); time.sleep(2.5); A.click('#r-send')
        B.wait_for_selector('.msg.in .voice', timeout=30000); ok('live voice note', True)
        A.click('#c-video'); B.wait_for_selector('#callui #cb-acc', timeout=20000); B.click('#cb-acc')
        A.wait_for_function("() => { const v = document.querySelector('#call-remote'); return v && v.videoWidth > 0 }", timeout=40000)
        B.wait_for_function("() => { const v = document.querySelector('#call-remote'); return v && v.videoWidth > 0 }", timeout=40000); ok('live video call connects (remote video both sides)', True)
        time.sleep(1); A.click('#cb-end'); B.wait_for_selector('#callui', state='detached', timeout=15000); ok('live call ended both sides', True)
    except Exception as ex:
        ok('EXCEPTION', False, str(ex)[:400])
    finally:
        for pg, u in ((A, ua), (B, ub)):
            try:
                st = pg.evaluate("(pw) => fetch('/api/me', {method:'DELETE', headers:{'x-avm':'1','content-type':'application/json'}, body: JSON.stringify({password: pw})}).then(r => r.status)", 'password-' + u); print('cleanup', u, st)
            except Exception as e: print('cleanup failed', u, e)
    for k, v in errors.items(): ok('no JS errors on live page ' + k, not v, v[:3])
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
