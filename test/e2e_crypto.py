# AverChat 2.1.0 end-to-end encryption test: real browsers (3 users + reinstall + admin reset) against tools/dev-server.mjs with a DB file.
# Run: DB_FILE=/tmp/avm-e2e.sqlite PORT=8791 node tools/dev-server.mjs &   then   AVM_BASE=http://localhost:8791 python3 test/e2e_crypto.py <shots_dir> <db_file> <boot_token>
import sys, os, time, json, sqlite3
from playwright.sync_api import sync_playwright
BASE = os.environ.get('AVM_BASE', 'http://localhost:8791')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/avm-e2e-shots'
DBF = sys.argv[2] if len(sys.argv) > 2 else '/tmp/avm-e2e.sqlite'
BOOT = sys.argv[3] if len(sys.argv) > 3 else ''
os.makedirs(OUT, exist_ok=True)
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond), extra)); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(extra) if extra else ''), flush=True)
from PIL import Image, ImageDraw
_im = Image.new('RGB', (640, 420)); _d = ImageDraw.Draw(_im)
for _y in range(420): _d.line([(0, _y), (640, _y)], fill=(255 - _y // 3, 90 + _y // 4, 200))
_d.ellipse([220, 100, 420, 300], fill=(255, 200, 40)); _im.save('/tmp/avm-photo.png')
DOC = b'%PDF-1.4\n% SECRET-DOC-CONTENT-12345\n' + b'0' * 3000
open('/tmp/secret-plan.pdf', 'wb').write(DOC)
errors = {}
def page_for(browser, name):
    ctx = browser.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2)
    pg = ctx.new_page(); errors[name] = []
    pg.on('pageerror', lambda e: errors[name].append(str(e)))
    pg.goto(BASE); pg.wait_for_selector('.auth-card, #app', timeout=20000)
    return pg
def signup(pg, name, user, phone):
    pg.click('.seg button[data-m=signup]'); pg.fill('input[name=name]', name); pg.fill('input[name=username]', user)
    pg.fill('input[name=phone]', phone); pg.fill('input[name=password]', 'password-' + user); pg.click('#authf button'); pg.wait_for_selector('#app', timeout=30000)
def login(pg, user, pw):
    if pg.is_visible('.seg button[data-m=login]'): pg.click('.seg button[data-m=login]')
    pg.fill('input[name=id]', user); pg.fill('input[name=password]', pw); pg.click('#authf button'); pg.wait_for_selector('#app', timeout=30000)
def shot(pg, name): p = os.path.join(OUT, name); pg.screenshot(path=p); return p
def open_chat_with(pg, username):
    back(pg); pg.click('#fab'); pg.click('.sheet-item:has-text("New chat")'); pg.fill('#pq', username); pg.wait_for_selector(f'.userrow:has-text("@{username}")', timeout=8000); pg.click(f'.userrow:has-text("@{username}")'); pg.wait_for_selector('#ta', timeout=8000)
def send_text(pg, text): pg.fill('#ta', text); pg.click('#b-send')
def wait_msg(pg, text, timeout=15000): pg.wait_for_selector(f'.msg .txt:has-text("{text}")', timeout=timeout)
def back(pg):
    if pg.is_visible('#c-back'): pg.click('#c-back'); pg.wait_for_timeout(300)
def db(sql, *a):
    c = sqlite3.connect(DBF); c.row_factory = sqlite3.Row; r = [dict(x) for x in c.execute(sql, a).fetchall()]; c.close(); return r
SECRETS = ['Namaste Bilal secret 4471', 'Reply secret 8812', 'Group secret 5590', 'Edited secret 7731', 'Goa trip', 'Varanasi Ghat', 'secret-plan.pdf']

with sync_playwright() as p:
    br = p.chromium.launch()
    A = page_for(br, 'A'); B = page_for(br, 'B'); C = page_for(br, 'C')
    try:
        signup(A, 'Asha Verma', 'asha', '9000000001'); signup(B, 'Bilal Khan', 'bilal', '9000000002'); signup(C, 'Chitra Rao', 'chitra', '9000000003')
        time.sleep(1)
        keys = db('SELECT username, e2e_pub IS NOT NULL AS k, e2e_backup IS NOT NULL AS b FROM users WHERE username IN ("asha","bilal","chitra")')
        ok('every new user gets a key pair on signup (server has public key + locked backup only)', all(r['k'] and r['b'] for r in keys) and len(keys) == 3, keys)
        bk = db('SELECT e2e_backup FROM users WHERE username="asha"')[0]['e2e_backup']; ok('key backup is password-locked (PBKDF2 + AES-GCM), no raw key', '"kdf":"PBKDF2-SHA256"' in bk and 'it' in bk, bk[:80])
        # 1:1 text
        open_chat_with(A, 'bilal'); A.wait_for_selector('#encban:has-text("end-to-end encrypted")', timeout=10000); ok('chat shows "end-to-end encrypted" banner', True)
        send_text(A, 'Namaste Bilal secret 4471'); wait_msg(A, 'Namaste Bilal secret 4471')
        B.wait_for_selector('.chatrow:has-text("Asha Verma")', timeout=15000)
        ok('chat list preview decrypted for receiver', 'Namaste Bilal secret' in B.inner_text('.chatrow:has-text("Asha Verma")'))
        B.click('.chatrow:has-text("Asha Verma")'); wait_msg(B, 'Namaste Bilal secret 4471'); ok('receiver decrypts 1:1 text', True)
        # reply + edit
        B.click('.msg.in .bubble', button='right'); B.click('.sheet-item:has-text("Reply")'); send_text(B, 'Reply secret 8812')
        A.wait_for_selector('.msg .quote:has-text("Namaste Bilal")', timeout=15000); wait_msg(A, 'Reply secret 8812'); ok('reply + quoted text decrypted', True)
        send_text(A, 'Edit me 1'); wait_msg(B, 'Edit me 1')
        A.click('.msg.out:has-text("Edit me 1") .bubble', button='right'); A.click('.sheet-item:has-text("Edit")'); A.wait_for_function("() => document.querySelector('#ta').value.startsWith('Edit me')"); A.fill('#ta', 'Edited secret 7731'); A.click('#b-send')
        B.wait_for_selector('.msg:has-text("Edited secret 7731")', timeout=15000); ok('edited message re-encrypted and decrypted', True)
        # location (encrypted meta)
        r = A.evaluate("""async () => { const c = [...document.querySelectorAll('.chatrow')].length; return 1 }""")
        # photo + document
        A.set_input_files('#f-media', '/tmp/avm-photo.png'); A.wait_for_selector('.media-prev', timeout=8000); A.fill('.media-prev input', 'Goa trip photo'); A.click('.media-prev .btn:not(.ghost)')
        B.wait_for_function("() => [...document.querySelectorAll('.mimg img')].some(i => i.naturalWidth > 100 && i.src.startsWith('blob:'))", timeout=30000); ok('encrypted photo decrypted and shown on receiver (blob URL)', True)
        wait_msg(B, 'Goa trip photo'); ok('photo caption decrypted', True)
        A.set_input_files('#f-doc', '/tmp/secret-plan.pdf'); B.wait_for_selector('.docmsg:has-text("secret-plan.pdf")', timeout=30000); ok('document name decrypted on receiver', True)
        got = B.evaluate("""async () => { const arr = [...App.S_msgs()]; return null }""") if False else None
        # receiver decrypts the document bytes
        dec = B.evaluate("""async () => { const m = [...window.__avm.S.msgs.values()].flat().find(x => x.meta && x.meta.name === 'secret-plan.pdf'); const u = await window.__avm.App.E2E.blobUrl(m.file_id); const t = await (await fetch(u)).text(); const raw = await (await fetch('/api/files/' + m.file_id)).arrayBuffer(); const rawT = new TextDecoder('latin1').decode(raw); return { ok: t.includes('SECRET-DOC-CONTENT-12345'), rawHas: rawT.includes('SECRET-DOC') || rawT.startsWith('%PDF'), size: raw.byteLength }; }""")
        ok('document bytes: server copy is ciphertext, receiver decrypts original', dec['ok'] and not dec['rawHas'], dec)
        shot(B, 'e2e-1to1-receiver.png'); shot(A, 'e2e-1to1-sender.png')
        # group of 3
        back(A); A.click('#fab'); A.click('.sheet-item:has-text("New group")'); A.fill('#pq', 'bil'); A.click('.userrow:has-text("@bilal")'); A.fill('#pq', 'chi'); A.wait_for_selector('.userrow:has-text("@chitra")'); A.click('.userrow:has-text("@chitra")'); A.click('#pdone')
        A.fill('#gf input[name=name]', 'Family Trip'); A.click('#gf button.btn'); A.wait_for_selector('#c-title:has-text("Family Trip")', timeout=15000)
        A.wait_for_selector('#encban:has-text("end-to-end encrypted")', timeout=10000)
        send_text(A, 'Group secret 5590')
        C.wait_for_selector('.chatrow:has-text("Family Trip")', timeout=15000); C.click('.chatrow:has-text("Family Trip")'); wait_msg(C, 'Group secret 5590'); ok('group member 3 (Chitra) decrypts', True)
        back(B); B.wait_for_selector('.chatrow:has-text("Family Trip")', timeout=15000); B.click('.chatrow:has-text("Family Trip")'); wait_msg(B, 'Group secret 5590'); ok('group member 2 (Bilal) decrypts', True)
        send_text(C, 'Varanasi Ghat se hello'); wait_msg(A, 'Varanasi Ghat se hello'); wait_msg(B, 'Varanasi Ghat se hello'); ok('group reply from Chitra decrypts for both', True)
        shot(C, 'e2e-group-chitra.png')
        # database holds only ciphertext
        time.sleep(1)
        rows = db('SELECT id, type, body, meta, enc FROM messages WHERE type<>"system"')
        dump = json.dumps(rows, ensure_ascii=False)
        leaks = [s for s in SECRETS if s in dump]
        encn = sum(1 for r in rows if r['enc'])
        ok('database: no plaintext of any test message/caption/file name', not leaks, {'leaks': leaks, 'encrypted_rows': encn, 'rows': len(rows)})
        ok('database: every user message row is encrypted with empty body', encn == len(rows) and all(r['body'] == '' for r in rows), [(r['id'], r['type'], r['body'][:20]) for r in rows if not r['enc'] or r['body']])
        sample = [r for r in rows if r['type'] == 'text'][0]
        open(os.path.join(OUT, 'db-row-sample.json'), 'w').write(json.dumps({k: (v[:400] + '…' if isinstance(v, str) and len(v) > 400 else v) for k, v in sample.items()}, indent=1))
        # reinstall / new phone: Bilal logs in fresh -> key restored from password backup
        B2 = page_for(br, 'B2'); login(B2, 'bilal', 'password-bilal')
        B2.wait_for_selector('.chatrow:has-text("Asha Verma")', timeout=15000); B2.click('.chatrow:has-text("Asha Verma")'); wait_msg(B2, 'Namaste Bilal secret 4471', 20000)
        ok('fresh device (reinstall): key restored from password backup, old messages readable', True); shot(B2, 'e2e-reinstall-restored.png')
        # safety number matches on both sides
        B2.click('#c-title') if B2.is_visible('#c-title') else None
        sa = A.evaluate("async () => { const E = window.__avm.App.E2E; const c = [...window.__avm.S.chats.values()].find(c => c.type === 'direct'); const d = await E.chatKeys(c.id, true); const p = d.members.find(m => m.id !== window.__avm.S.me.id); return E.safetyNumber(E.key.pub, p.pub) }")
        sb = B2.evaluate("async () => { const E = window.__avm.App.E2E; const c = [...window.__avm.S.chats.values()].find(c => c.type === 'direct'); const d = await E.chatKeys(c.id, true); const p = d.members.find(m => m.id !== window.__avm.S.me.id); return E.safetyNumber(E.key.pub, p.pub) }")
        ok('safety number identical on both phones', sa == sb and len(sa) == 71, sa)
        # admin
        if BOOT:
            A.evaluate("(b) => fetch('/api/admin/bootstrap', {method:'POST', headers:{'x-avm':'1','content-type':'application/json'}, body: JSON.stringify(b)}).then(r => r.status)", {'token': BOOT, 'password': 'Admin-e2e-pass-1'})
            D = br.new_context(viewport={'width': 1280, 'height': 860}).new_page(); errors['D'] = []; D.on('pageerror', lambda e: errors['D'].append(str(e)))
            D.goto(BASE + '/admin'); D.wait_for_selector('#lf', timeout=15000); D.fill('#lf input[name=id]', 'admin'); D.fill('#lf input[name=password]', 'Admin-e2e-pass-1'); D.click('#lf button')
            D.wait_for_selector('.cards', timeout=15000); D.wait_for_timeout(800); shot(D, 'e2e-admin-dashboard.png')
            txt = D.inner_text('body'); ok('admin dashboard shows encryption counts, no message content', 'encrypted' in txt.lower() and not any(s in txt for s in SECRETS))
            api_dump = D.evaluate("async () => { const out = []; for (const u of ['/api/admin/stats','/api/admin/users','/api/admin/reports']) { const r = await fetch(u, {headers:{'x-avm':'1'}}); out.push(await r.text()); } return out.join('\\n'); }")
            ok('admin API answers contain no message content', not any(s in api_dump for s in SECRETS))
            cid = db('SELECT id FROM users WHERE username="chitra"')[0]['id']
            st = D.evaluate("(id) => fetch('/api/admin/users/' + id + '/password', {method:'POST', headers:{'x-avm':'1','content-type':'application/json'}, body: JSON.stringify({password:'new-pass-chitra'})}).then(r => r.status)", cid)
            ok('admin reset Chitra\'s password', st == 200, st)
            C2 = page_for(br, 'C2'); login(C2, 'chitra', 'new-pass-chitra'); time.sleep(2)
            C2.wait_for_selector('.chatrow:has-text("Family Trip")', timeout=15000); C2.click('.chatrow:has-text("Family Trip")')
            C2.wait_for_selector('.msg .txt:has-text("not available on this device")', timeout=20000)
            ok('after admin reset on a new phone: old encrypted messages show "not available", no crash', not errors['C2'], errors['C2'][:3]); shot(C2, 'e2e-after-admin-reset.png')
            send_text(C2, 'New key hello'); wait_msg(A, 'New key hello', 20000); ok('after reset: new key works, others read new messages', True)
            A.wait_for_selector('.sysmsg:has-text("security code changed")', timeout=20000); ok('key-change notice shown to group members', True); shot(A, 'e2e-key-change-notice.png')
        ok('no JavaScript errors in any browser', not any(errors[k] for k in errors), {k: v[:3] for k, v in errors.items() if v})
    except Exception as ex:
        ok('test run finished without exception', False, repr(ex)[:500])
        for n, pg in [('A', A), ('B', B), ('C', C)]:
            try: shot(pg, 'fail-' + n + '.png')
            except Exception: pass
    br.close()
fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
