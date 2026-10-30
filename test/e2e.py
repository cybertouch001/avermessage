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

with sync_playwright() as p:
    br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    A = page_for(br, 'A'); B = page_for(br, 'B'); C = page_for(br, 'C')
    try:
        signup(A, 'Asha Verma', 'asha', '+919000000001'); signup(B, 'Bilal Khan', 'bilal'); signup(C, 'Chitra Rao', 'chitra')
        ok('signup 3 users', A.is_visible('#app') and B.is_visible('#app') and C.is_visible('#app'))
        # 1:1 chat
        open_chat_with(A, 'bilal'); send_text(A, 'Namaste Bilal 👋 kaise ho?')
        wait_msg(A, 'Namaste Bilal'); 
        B.wait_for_selector('.chatrow:has-text("Asha Verma") .badge', timeout=10000); ok('B sees new chat with unread badge', True)
        A.wait_for_selector('.msg.out .ticks:not(.pend)', timeout=8000)
        B.click('.chatrow:has-text("Asha Verma")'); wait_msg(B, 'Namaste Bilal')
        A.wait_for_selector('.msg.out .ticks.read', timeout=10000); ok('read ticks reach sender', True)
        B.fill('#ta', 'Badhiya! Tum batao'); B.wait_for_selector('#c-sub .typing', timeout=1) if False else None
        A.wait_for_selector('#c-sub .typing', timeout=10000); ok('typing indicator shows', True)
        B.click('#b-send'); wait_msg(A, 'Badhiya')
        # reply via menu + reaction
        A.click('.msg.in .bubble', button='right'); A.click('.sheet-item:has-text("Reply")'); send_text(A, 'Sab theek, ye dekho file')
        B.wait_for_selector('.msg .quote', timeout=10000); ok('reply quote delivered', B.is_visible('.msg .quote'))
        B.click('.msg.in:has-text("Sab theek") .bubble', button='right'); B.click('.qreact button[data-e="❤️"]')
        A.wait_for_selector('.reacts:has-text("❤️")', timeout=10000); ok('reaction delivered', True)
        # edit
        A.click('.msg.out:has-text("Sab theek") .bubble', button='right'); A.click('.sheet-item:has-text("Edit")'); A.wait_for_selector('#c-compose .ctxbar'); A.wait_for_function("() => document.querySelector('#ta').value.startsWith('Sab theek')"); A.fill('#ta', 'Sab theek hai, ye dekho file'); A.click('#b-send')
        B.wait_for_selector('.msg:has-text("Sab theek hai") .meta:has-text("edited")', timeout=10000); ok('edit delivered with label', True)
        # document
        A.set_input_files('#f-doc', '/tmp/avm-report.pdf'); B.wait_for_selector('.docmsg:has-text("avm-report.pdf")', timeout=15000)
        href = B.get_attribute('.docmsg a.dl', 'href'); st = B.evaluate('(h) => fetch(h).then(r => r.status)', href); ok('document received + downloadable', st == 200, st)
        st2 = C.evaluate('(h) => fetch(h).then(r => r.status)', href); ok('non-member cannot fetch the file', st2 == 404, st2)
        # photo
        A.set_input_files('#f-media', '/tmp/avm-photo.png'); A.wait_for_selector('.media-prev', timeout=5000); A.fill('.media-prev input', 'Holi colours 🎨'); A.click('.media-prev .btn:not(.ghost)')
        B.wait_for_selector('.mimg img', timeout=15000); B.wait_for_function("() => [...document.querySelectorAll('.mimg img')].some(i => i.naturalWidth > 0)", timeout=10000); ok('photo received and displayed', True)
        # voice note
        A.click('#b-send'); A.wait_for_selector('.recbar', timeout=5000); time.sleep(2.5); A.click('#r-send')
        B.wait_for_selector('.msg.in .voice', timeout=20000); dur = B.inner_text('.msg.in .voice .vtime'); ok('voice note received', dur != '0:00', dur)
        B.click('.msg.in .voice .vplay'); time.sleep(1.5); playing = B.evaluate("() => { const a = document.querySelector('.msg.in .voice audio'); return a ? a.currentTime : -1 }"); ok('voice note plays', playing > 0.2, playing)
        shot(A, 'avm-chat.png')
        # delete for everyone
        send_text(A, 'galti se bheja'); wait_msg(B, 'galti se bheja')
        A.click('.msg.out:has-text("galti se bheja") .bubble', button='right'); A.click('.sheet-item:has-text("Delete")'); A.click('.sheet-item:has-text("Delete for everyone")')
        B.wait_for_selector('.msg .txt.del', timeout=10000); ok('delete for everyone', True)
        # group
        A.click('#c-back') if A.is_visible('#c-back') else None
        A.click('#b-menu'); A.click('.sheet-item:has-text("New group")'); A.fill('#pq', 'bil'); A.click('.userrow:has-text("@bilal")'); A.fill('#pq', 'chi'); A.wait_for_selector('.userrow:has-text("@chitra")'); A.click('.userrow:has-text("@chitra")'); A.click('#pdone')
        A.fill('#gf input[name=name]', 'Family Trip 🚗'); A.click('#gf .btn'); A.wait_for_selector('#c-title:has-text("Family Trip")', timeout=10000)
        C.wait_for_selector('.chatrow:has-text("Family Trip")', timeout=10000); ok('group appears for members', True)
        C.click('.chatrow:has-text("Family Trip")'); send_text(C, 'Goa chalein? 🌴'); wait_msg(A, 'Goa chalein'); wait_msg(B.goto(BASE) or B, 'Goa', 1) if False else None
        A.click('#b-attach'); A.click('.sheet-item:has-text("Poll")'); A.fill('.poll-new input[name=q]', 'Kab chalein?'); opts = A.query_selector_all('.poll-new .opt'); opts[0].fill('December'); opts[1].fill('January'); A.click('.poll-new .btn:not(.ghost)')
        C.wait_for_selector('.poll', timeout=10000); C.click('.popt:has-text("December")'); A.wait_for_selector('.popt:has-text("December") .pn:has-text("1")', timeout=10000); ok('poll vote counted', True)
        ok('group sender names shown', A.is_visible('.msg.in .sender'))
        shot(A, 'avm-group.png')
        # status
        A.click('#tabs button[data-t=status]'); A.click('#st-text'); A.fill('.st-compose textarea', 'Aaj ka din shubh ho ☀️'); A.click('.st-compose .sendbtn'); A.wait_for_selector('#my-main:has-text("update")', timeout=10000)
        B.click('#c-back') if B.is_visible('#c-back') else None
        B.click('#tabs button[data-t=status]'); B.wait_for_selector('.row[data-u]', timeout=10000); ok('contact sees status', True)
        B.click('.row[data-u]'); B.wait_for_selector('.st-text', timeout=5000); time.sleep(0.6); shot(B, 'avm-status.png'); B.keyboard.press('Escape'); B.go_back(); B.wait_for_timeout(500)
        B.click('#tabs button[data-t=chats]')
        # video call A -> B
        A.click('#tabs button[data-t=chats]'); A.click('.chatrow:has-text("Bilal Khan")'); A.click('#c-video')
        B.wait_for_selector('#callui #cb-acc', timeout=15000); ok('incoming call rings on B', True); shot(B, 'avm-call-incoming.png')
        B.click('#cb-acc')
        A.wait_for_function("() => { const v = document.querySelector('#call-remote'); return v && v.videoWidth > 0 }", timeout=30000)
        B.wait_for_function("() => { const v = document.querySelector('#call-remote'); return v && v.videoWidth > 0 }", timeout=30000)
        st = A.evaluate('() => window.__avmDebug ? 1 : 0'); ok('video call connected, remote video on both sides', True)
        time.sleep(2.5); shot(A, 'avm-video-call.png')
        A.click('#cb-mute'); B.wait_for_selector('#call-rs:has-text("muted")', timeout=8000); ok('mute state reaches peer', True)
        A.click('#cb-end'); B.wait_for_selector('#callui', state='detached', timeout=10000); ok('call ended on both sides', True)
        A.wait_for_selector('.callmsg:has-text("Video call")', timeout=10000); ok('call log message in chat', True)
        # voice call B -> A, A declines? accept & check audio
        B.click('.chatrow:has-text("Asha Verma")'); B.click('#c-voice'); A.wait_for_selector('#cb-acc', timeout=15000); A.click('#cb-acc')
        B.wait_for_function("() => document.querySelector('#call-st') && /\\d:\\d\\d/.test(document.querySelector('#call-st').textContent)", timeout=30000); ok('voice call connected (timer running)', True)
        time.sleep(1.5); shot(B, 'avm-call.png'); B.click('#cb-end'); A.wait_for_selector('#callui', state='detached', timeout=10000)
        # calls tab
        A.click('#tabs button[data-t=calls]'); A.wait_for_selector('.callrow', timeout=8000); ok('call history lists calls', len(A.query_selector_all('.callrow')) >= 2)
        A.click('#tabs button[data-t=chats]'); shot(A, 'avm-chat-list.png')
        # settings + dark mode + hindi
        A.click('#b-menu'); A.click('.sheet-item:has-text("Settings")'); A.wait_for_selector('#s-prof'); A.wait_for_timeout(900); shot(A, 'avm-settings.png')
        A.click('#s-chats'); A.click('#cs-theme'); A.click('.sheet-item:has-text("Dark")'); A.wait_for_function("() => document.documentElement.dataset.theme === 'dark'", timeout=5000); ok('dark theme applies', True)
        A.go_back(); A.wait_for_timeout(300); A.go_back(); A.wait_for_timeout(300); A.click('.chatrow:has-text("Bilal Khan")'); A.wait_for_timeout(800); shot(A, 'avm-dark.png')
        # scheduled message
        A.fill('#ta', 'Happy birthday in advance! 🎂'); A.click('#b-attach'); A.click('.sheet-item:has-text("Schedule")'); A.wait_for_selector('input[type=datetime-local]'); A.click('.dlg .btn:not(.ghost)'); A.wait_for_selector('.schedbar', timeout=8000); ok('scheduled message saved (not yet delivered)', not B.is_visible('.txt:has-text("Happy birthday")'))
        # block
        B.click('#c-menu'); B.click('.sheet-item:has-text("Block")'); B.click('.dlg .btn.danger'); B.wait_for_selector('.composer-note:has-text("blocked")', timeout=8000)
        A.fill('#ta', 'are you there?'); A.click('#b-send'); A.wait_for_selector('.msg.pending', timeout=8000); time.sleep(1.5); ok('blocked contact cannot message', A.is_visible('.msg.pending'))
        B.click('#unb'); 
        # mobile layout (C on a phone-sized screen)
        M = page_for(br, 'M', mobile=True); M.click('.seg button[data-m=login]') if M.is_visible('.seg') else None
        M.fill('input[name=id]', 'chitra'); M.fill('input[name=password]', 'password-chitra'); M.click('#authf button'); M.wait_for_selector('#app', timeout=10000); M.wait_for_timeout(1200)
        shot(M, 'avm-mobile-list.png'); M.click('.chatrow:has-text("Family Trip")'); M.wait_for_timeout(1500); shot(M, 'avm-mobile-chat.png')
        ok('mobile: chat opens full screen', M.evaluate("() => document.body.classList.contains('in-chat')"))
        # Hindi UI
        M.go_back(); M.wait_for_timeout(300); M.click('#b-menu'); M.click('.sheet-item:has-text("Settings")'); M.click('#s-lang'); M.click('.sheet-item:has-text("हिन्दी")'); M.wait_for_selector('#tabs', timeout=10000); M.wait_for_timeout(1200)
        ok('Hindi UI loads', 'चैट' in M.inner_text('#tabs')); shot(M, 'avm-hindi.png')
        # admin
        if BOOT:
            r = A.evaluate("(b) => fetch('/api/admin/bootstrap', {method:'POST', headers:{'x-avm':'1','content-type':'application/json'}, body: JSON.stringify(b)}).then(r => r.status)", {'token': BOOT, 'password': 'Admin-e2e-pass-1'})
            D = page_for(br, 'D'); D.fill('input[name=id]', 'admin'); D.fill('input[name=password]', 'Admin-e2e-pass-1'); D.click('#authf button'); D.wait_for_selector('#app', timeout=10000)
            D.click('#b-menu'); D.click('.sheet-item:has-text("Admin panel")'); D.wait_for_selector('.stats .stat', timeout=10000); D.wait_for_timeout(500); shot(D, 'avm-admin.png')
            ok('admin panel shows stats', int(D.inner_text('.stats .stat b')) >= 3)
            D.click('.seg button[data-k=users]'); D.wait_for_selector('[data-ban]', timeout=8000); ok('admin can list users', len(D.query_selector_all('.tbl tr')) >= 4)
            ok('customer cannot register "admin"', A.evaluate("() => fetch('/api/auth/signup', {method:'POST', headers:{'x-avm':'1','content-type':'application/json'}, body: JSON.stringify({name:'x', username:'Adm1n', password:'xxxxxxxx1'})}).then(r => r.status)") == 400)
    except Exception as ex:
        ok('EXCEPTION', False, str(ex)[:400])
        for nm, pg in (('A', A), ('B', B), ('C', C)):
            try: pg.screenshot(path=f'/tmp/fail-{nm}.png')
            except Exception: pass
    for k, v in errors.items():
        ok(f'no JS errors on page {k}', not v, v[:3])
    br.close()
fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
json.dump([{'name': n, 'ok': o, 'extra': str(e)} for n, o, e in results], open(os.path.join(OUT, 'e2e-results.json'), 'w'), indent=1)
sys.exit(1 if fails else 0)
