// End-to-end encryption for AverChat 1:1 and group chats (v2.1.0).
// Standard WebCrypto only: ECDH P-256 (identity key per user), HKDF-SHA256, AES-256-GCM; key backup: PBKDF2-SHA256 (310,000 rounds) + AES-GCM.
// Each message gets a fresh random content key; the content key is sealed separately for every member (and the sender) with a key derived
// from ECDH(sender, member). The server only ever stores ciphertext, public keys, and the password-locked backup it cannot open.
// Channels and status updates are NOT end-to-end encrypted (they are broadcasts).
import { App, S, LS, t, api, hooks, plug, toast, openModal, esc } from './util.js';

const sub = crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
const B64 = { enc: (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }, dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const ZERO_IV = new Uint8Array(12); // safe: every wrap key is unique (fresh random HKDF salt)
const ITER = 310000;
const INFO = (from, to) => te.encode('AverChat-E2E-v1|' + from + '|' + to);
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export const E2E = { key: null, ready: false, fileKeys: new Map(), blobUrls: new Map() };
App.E2E = E2E;
const plainCache = new Map(); // message id + version -> decrypted payload
const sharedCache = new Map(); // peer public key -> ECDH secret bits
const keysCache = new Map(); // chat id -> { at, data }
const upStash = new Map(); // uploaded (encrypted) file id -> [keyB64, ivB64, mime, name]

async function kidOf(pubB64) { return hex(await sub.digest('SHA-256', B64.dec(pubB64))).slice(0, 32); }
async function importPriv(pkcs8B64) { return sub.importKey('pkcs8', B64.dec(pkcs8B64), ECDH, true, ['deriveBits']); }
async function importPub(pubB64) { return sub.importKey('raw', B64.dec(pubB64), ECDH, true, []); }
async function pubFromPriv(priv) { const j = await sub.exportKey('jwk', priv); const x = B64.dec(j.x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (j.x.length % 4)) % 4)); const y = B64.dec(j.y.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (j.y.length % 4)) % 4)); const raw = new Uint8Array(65); raw[0] = 4; raw.set(x, 1); raw.set(y, 33); return B64.enc(raw); }
const localKey = (uid) => 'avm.e2e.' + uid;

async function useKey(uid, pkcs8, pub) {
  const priv = await importPriv(pkcs8);
  E2E.key = { uid, priv, pub, pkcs8, kid: await kidOf(pub) }; E2E.ready = true; sharedCache.clear(); plainCache.clear();
  try { localStorage.setItem(localKey(uid), JSON.stringify({ pkcs8, pub })); } catch {}
  try { const N = plug('AvmNotify'); if (N && N.setE2EKey) await N.setE2EKey({ uid, pkcs8, pub }); } catch {}
}
async function generate() {
  const kp = await sub.generateKey(ECDH, true, ['deriveBits']);
  const pkcs8 = B64.enc(await sub.exportKey('pkcs8', kp.privateKey)); const pub = B64.enc(await sub.exportKey('raw', kp.publicKey));
  return { pkcs8, pub };
}
async function pwKey(password, salt, iter) {
  const base = await sub.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return sub.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function lockBackup(pkcs8, password) {
  const salt = rnd(16), iv = rnd(12); const k = await pwKey(password, salt, ITER);
  const ct = await sub.encrypt({ name: 'AES-GCM', iv }, k, B64.dec(pkcs8));
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', it: ITER, s: B64.enc(salt), iv: B64.enc(iv), ct: B64.enc(ct) });
}
async function unlockBackup(blob, password) {
  const o = JSON.parse(blob); const k = await pwKey(password, B64.dec(o.s), o.it || ITER);
  return B64.enc(await sub.decrypt({ name: 'AES-GCM', iv: B64.dec(o.iv) }, k, B64.dec(o.ct)));
}
E2E.lockBackup = async (password) => (E2E.key ? lockBackup(E2E.key.pkcs8, password) : null);

/** The user just typed their password (login, signup, unlock prompt): make sure this device has the right key and the backup uses this password. */
E2E.afterPassword = async (password, me = S.me) => {
  if (!me || !password) return;
  const srv = await api('/api/me/e2e');
  let local = null; try { local = JSON.parse(localStorage.getItem(localKey(me.id)) || 'null'); } catch {}
  if (local && srv.pub && local.pub === srv.pub) { await useKey(me.id, local.pkcs8, local.pub); await api('/api/me/e2e', { method: 'PUT', body: { pub: local.pub, kid: await kidOf(local.pub), backup: await lockBackup(local.pkcs8, password) } }); return 'ok'; }
  if (srv.pub && srv.backup) {
    try {
      const pkcs8 = await unlockBackup(srv.backup, password);
      const pub = await pubFromPriv(await importPriv(pkcs8));
      if (pub === srv.pub) { await useKey(me.id, pkcs8, pub); return 'restored'; }
    } catch {}
    // backup can't be opened with this password (admin reset it): fresh key; older encrypted messages stay unreadable on this device
    if (local) { await useKey(me.id, local.pkcs8, local.pub); await api('/api/me/e2e', { method: 'PUT', body: { pub: local.pub, kid: await kidOf(local.pub), backup: await lockBackup(local.pkcs8, password) } }); return 'kept-local'; }
  } else if (local) { await useKey(me.id, local.pkcs8, local.pub); await api('/api/me/e2e', { method: 'PUT', body: { pub: local.pub, kid: await kidOf(local.pub), backup: await lockBackup(local.pkcs8, password) } }); return 'uploaded'; }
  const g = await generate();
  await api('/api/me/e2e', { method: 'PUT', body: { pub: g.pub, kid: await kidOf(g.pub), backup: await lockBackup(g.pkcs8, password) } });
  await useKey(me.id, g.pkcs8, g.pub);
  if (S.me) { S.me.e2e_pub = g.pub; S.me.e2e_kid = await kidOf(g.pub); }
  return srv.pub ? 'new-after-reset' : 'new';
};

/** App start with a saved login (no password typed): use the key on this device, or ask for the password once. */
E2E.init = async () => {
  const me = S.me; if (!me) return;
  let local = null; try { local = JSON.parse(localStorage.getItem(localKey(me.id)) || 'null'); } catch {}
  if (local && (!me.e2e_pub || local.pub === me.e2e_pub)) {
    try { await useKey(me.id, local.pkcs8, local.pub); if (!me.e2e_pub) askPassword('setup'); return; } catch {}
  }
  askPassword(me.e2e_pub ? 'unlock' : 'setup');
};

let asking = false;
function askPassword(mode) {
  if (asking || LS.get('e2e-later-' + (S.me && S.me.id), 0) > Date.now()) return; asking = true;
  const title = mode === 'unlock' ? t('Unlock your encrypted chats') : t('Turn on end-to-end encryption');
  const text = mode === 'unlock' ? t('Enter your AverChat password once on this device to open your end-to-end encrypted messages.') : t('Your chats will be end-to-end encrypted: only you and the people you chat with can read them, not even the AverChat admin. Enter your password once to protect your key.');
  const mm = openModal(`<div class="dlg"><h3>🔒 ${esc(title)}</h3><p class="fine">${esc(text)}</p><form id="e2ef"><input type="password" id="e2ep" autocomplete="current-password" placeholder="${esc(t('Password'))}" style="width:100%"><div class="fine" id="e2ee" style="color:#e57373;min-height:1.2em"></div><div class="dlg-btns"><button type="button" class="btn ghost" id="e2el">${esc(t('Later'))}</button><button class="btn" id="e2eok">${esc(t('Continue'))}</button></div></form></div>`, { onClose: () => { asking = false; } });
  const done = () => { asking = false; try { mm.close(); } catch {} };
  mm.el.querySelector('#e2el').onclick = () => { LS.set('e2e-later-' + S.me.id, Date.now() + 6 * 3600000); done(); };
  mm.el.querySelector('#e2ef').onsubmit = async (e) => {
    e.preventDefault(); const pw = mm.el.querySelector('#e2ep').value; const er = mm.el.querySelector('#e2ee'); const ok = mm.el.querySelector('#e2eok');
    if (!pw) return; ok.disabled = true; er.textContent = t('Please wait…');
    try {
      await api('/api/me/e2e/verify', { body: { password: pw } });
      const r = await E2E.afterPassword(pw);
      done(); toast(r === 'new-after-reset' ? t('Encryption is on. Older encrypted messages can’t be opened on this device (the password was reset).') : t('🔒 End-to-end encryption is on'));
      App.reloadAfterE2E && App.reloadAfterE2E();
    } catch (x) { ok.disabled = false; er.textContent = x.message || t('Something went wrong'); }
  };
}
E2E.ask = () => askPassword(S.me && S.me.e2e_pub ? 'unlock' : 'setup');

E2E.forget = async () => {
  try { if (S.me) localStorage.removeItem(localKey(S.me.id)); } catch {}
  E2E.key = null; E2E.ready = false; plainCache.clear(); sharedCache.clear();
};

// ---------- sealing / opening ----------
async function shared(pubB64) {
  let s = sharedCache.get(pubB64); if (s) return s;
  s = new Uint8Array(await sub.deriveBits({ name: 'ECDH', public: await importPub(pubB64) }, E2E.key.priv, 256)); sharedCache.set(pubB64, s); return s;
}
async function wrapKeyFor(pubB64, salt, from, to) {
  const ikm = await sub.importKey('raw', await shared(pubB64), 'HKDF', false, ['deriveKey']);
  return sub.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO(from, to) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Members' public keys for a chat; ready = every current member (incl. me) has a key and it's not a channel. */
E2E.chatKeys = async (chatId, fresh) => {
  const c = keysCache.get(chatId); if (c && !fresh && Date.now() - c.at < 20000) return c.data;
  const d = await api(`/api/chats/${chatId}/keys`); keysCache.set(chatId, { at: Date.now(), data: d }); return d;
};
E2E.readyFor = async (chatId) => {
  if (!E2E.ready) return false;
  try { const d = await E2E.chatKeys(chatId); return !d.channel && d.members.length > 0 && d.members.every((m) => m.pub) && d.members.some((m) => m.id === E2E.key.uid && m.pub === E2E.key.pub); } catch { return false; }
};
E2E.missing = async (chatId) => { try { const d = await E2E.chatKeys(chatId); return d.channel ? null : d.members.filter((m) => !m.pub).map((m) => m.name); } catch { return null; } };

async function seal(chatId, payload) {
  const d = await E2E.chatKeys(chatId); const me = E2E.key.uid;
  const ck = rnd(32), iv = rnd(12);
  const ckKey = await sub.importKey('raw', ck, 'AES-GCM', false, ['encrypt']);
  const ct = await sub.encrypt({ name: 'AES-GCM', iv }, ckKey, te.encode(JSON.stringify(payload)));
  const k = {};
  for (const m of d.members) { if (!m.pub) continue; const salt = rnd(16); const wk = await wrapKeyFor(m.pub, salt, me, m.id); k[m.id] = [B64.enc(salt), B64.enc(await sub.encrypt({ name: 'AES-GCM', iv: ZERO_IV }, wk, ck))]; }
  if (!k[me]) { const salt = rnd(16); const wk = await wrapKeyFor(E2E.key.pub, salt, me, me); k[me] = [B64.enc(salt), B64.enc(await sub.encrypt({ name: 'AES-GCM', iv: ZERO_IV }, wk, ck))]; }
  return JSON.stringify({ v: 1, iv: B64.enc(iv), ct: B64.enc(ct), sk: E2E.key.pub, k });
}
async function openEnc(encStr, senderId) {
  const e = JSON.parse(encStr); const me = E2E.key.uid; const mine = e.k && e.k[me]; if (!mine) throw new Error('not-for-me');
  const wk = await wrapKeyFor(e.sk, B64.dec(mine[0]), senderId, me);
  const ck = await sub.decrypt({ name: 'AES-GCM', iv: ZERO_IV }, wk, B64.dec(mine[1]));
  const ckKey = await sub.importKey('raw', ck, 'AES-GCM', false, ['decrypt']);
  return JSON.parse(td.decode(await sub.decrypt({ name: 'AES-GCM', iv: B64.dec(e.iv) }, ckKey, B64.dec(e.ct))));
}

function applyPayload(m, p) {
  m.body = p.t || ''; m.meta = { ...(m.meta || {}), ...(p.m || {}) };
  if (p.f && p.f.main && m.file_id) { E2E.fileKeys.set(m.file_id, p.f.main); if (p.f.main[3]) m.meta.name = p.f.main[3]; if (p.f.main[2]) m.meta.mime = p.f.main[2]; }
  if (p.f && p.f.thumb && m.meta.thumb) E2E.fileKeys.set(m.meta.thumb, p.f.thumb);
  m._e2e = true; m._p = p;
}
async function openMsg(m) {
  if (!m || typeof m.enc !== 'string' || m._e2e) return;
  const ck = m.id + ':' + (m.edited_at || 0) + ':' + m.enc.length;
  try {
    let p = plainCache.get(ck);
    if (!p) { if (!E2E.ready) throw new Error('no-key'); p = await openEnc(m.enc, m.sender_id); plainCache.set(ck, p); }
    applyPayload(m, p);
  } catch (x) {
    m._e2e_fail = true; m._e2e = true; m._origType = m.type;
    if (m.type !== 'poll') { m.type = 'text'; m.file_id = null; }
    m.body = '🔒 ' + (E2E.ready ? t('Encrypted message — not available on this device') : t('Encrypted message — unlock encryption to read it'));
  }
  if (m.reply && typeof m.reply.enc === 'string') {
    try { const p = await openEnc(m.reply.enc, m.reply.sender_id); m.reply.body = p.t || ''; m.reply.meta = { ...(m.reply.meta || {}), ...(p.m || {}) }; if (p.f && p.f.main && p.f.main[3]) m.reply.meta.name = p.f.main[3]; } catch { m.reply.body = '🔒 ' + t('Encrypted message'); }
  }
}
function collect(x, out, depth = 0) {
  if (!x || typeof x !== 'object' || depth > 4) return;
  if (Array.isArray(x)) { for (const y of x) collect(y, out, depth + 1); return; }
  if (typeof x.enc === 'string' && x.sender_id && x.id !== undefined) out.push(x);
  for (const k of ['message', 'messages', 'last', 'chat', 'chats', 'pinned_msgs_full']) if (x[k] && typeof x[k] === 'object') collect(x[k], out, depth + 1);
}
hooks.inbound = async (data) => { const list = []; collect(data, list); for (const m of list) await openMsg(m); };
E2E.inbound = hooks.inbound;

// ---------- outgoing: messages, edits, forwards, password change ----------
const SENSITIVE = { location: ['lat', 'lng', 'acc', 'label'], contact: ['user_id', 'username', 'name'], poll: ['question', 'options'] };
async function buildPayload(chatId, b) {
  const p = { t: b.body || '' }; const meta = { ...(b.meta || {}) };
  const sens = SENSITIVE[b.type] || []; if (sens.length) { p.m = {}; for (const k of sens) if (meta[k] !== undefined) { p.m[k] = meta[k]; } }
  let srvMeta = meta;
  if (b.type === 'location' || b.type === 'contact') srvMeta = {};
  if (b.type === 'poll') srvMeta = { question: '🔒', options: (meta.options || []).map(() => '•'), multi: !!meta.multi };
  if (b.file_id) { const s = upStash.get(b.file_id); if (s) { p.f = { main: s }; } }
  if (meta.thumb) { const s = upStash.get(meta.thumb); if (s) (p.f ||= {}).thumb = s; }
  return { p, srvMeta };
}
const reMsg = /^\/api\/chats\/([\w-]+)\/messages$/, reEdit = /^\/api\/messages\/(\d+)$/, reFwd = /^\/api\/messages\/(\d+)\/forward$/;
function findMsg(id) { for (const arr of S.msgs.values()) { const m = arr.find((x) => String(x.id) === String(id)); if (m) return m; } return null; }
hooks.outbound = async (path, opts) => {
  const b = opts.body; if (!b || typeof b !== 'object') return null;
  let mt;
  if ((mt = path.match(reMsg)) && (opts.method || 'POST') === 'POST') {
    const chatId = mt[1]; const usesEncFile = (b.file_id && upStash.has(b.file_id));
    if (!(await E2E.readyFor(chatId)) && !usesEncFile) return null;
    if (!E2E.ready) return null;
    const { p, srvMeta } = await buildPayload(chatId, b);
    return { ...opts, body: { ...b, body: '', meta: srvMeta, enc: await seal(chatId, p) } };
  }
  if ((mt = path.match(reEdit)) && opts.method === 'PATCH' && typeof b.body === 'string') {
    const m = findMsg(mt[1]); if (!m) return null;
    if (!m.enc && !(await E2E.readyFor(m.chat_id))) return null;
    if (!E2E.ready) return null;
    return { ...opts, body: { enc: await seal(m.chat_id, { ...(m._p || {}), t: b.body }) } };
  }
  if ((mt = path.match(reFwd)) && Array.isArray(b.chat_ids)) {
    const m = findMsg(mt[1]); if (!m || !E2E.ready) return null;
    const encs = {};
    for (const cid of b.chat_ids) { if (await E2E.readyFor(cid)) encs[cid] = await seal(cid, m._p ? m._p : { t: m.body || '', m: pickSens(m) }); }
    return Object.keys(encs).length ? { ...opts, body: { ...b, encs } } : null;
  }
  if (path === '/api/me/password' && b.next && E2E.ready) return { ...opts, body: { ...b, e2e_backup: await lockBackup(E2E.key.pkcs8, b.next) } };
  return null;
};
function pickSens(m) { const o = {}; for (const k of SENSITIVE[m.type] || []) if (m.meta && m.meta[k] !== undefined) o[k] = m.meta[k]; if (m.meta && m.meta.name) o.name = m.meta.name; return o; }

// ---------- files: encrypt before upload, decrypt for display ----------
hooks.upload = async (file, scope, name, onProg, raw) => {
  const mt = /^chat:([\w-]+)$/.exec(scope || '');
  if (!mt || !(await E2E.readyFor(mt[1]))) return raw(file, scope, name, onProg);
  const k = rnd(32), iv = rnd(12);
  const key = await sub.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
  const ct = await sub.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
  const f = await raw(new Blob([ct], { type: 'application/octet-stream' }), scope, 'encrypted.bin', onProg);
  upStash.set(f.id, [B64.enc(k), B64.enc(iv), file.type || 'application/octet-stream', name || file.name || 'file']);
  E2E.fileKeys.set(f.id, upStash.get(f.id));
  return f;
};
const PH = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7#avmenc=';
const inflight = new Map();
E2E.blobUrl = async (id) => {
  if (E2E.blobUrls.has(id)) return E2E.blobUrls.get(id);
  if (inflight.has(id)) return inflight.get(id);
  const pr = (async () => {
    const fk = E2E.fileKeys.get(id); const r = await fetch('/api/files/' + encodeURIComponent(id), { credentials: 'same-origin' }); if (!r.ok) throw new Error('file');
    const key = await sub.importKey('raw', B64.dec(fk[0]), 'AES-GCM', false, ['decrypt']);
    const pt = await sub.decrypt({ name: 'AES-GCM', iv: B64.dec(fk[1]) }, key, await r.arrayBuffer());
    const u = URL.createObjectURL(new Blob([pt], { type: fk[2] || 'application/octet-stream' })); E2E.blobUrls.set(id, u); return u;
  })();
  inflight.set(id, pr); try { return await pr; } finally { inflight.delete(id); }
};
function hydrate(id) {
  E2E.blobUrl(id).then((u) => {
    for (const a of ['src', 'href', 'poster']) document.querySelectorAll(`[${a}$="#avmenc=${CSS.escape(id)}"]`).forEach((n) => { n.setAttribute(a, u); if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO' || n.tagName === 'SOURCE') { try { (n.tagName === 'SOURCE' ? n.parentElement : n).load(); } catch {} } });
  }).catch(() => {});
}
hooks.fileUrl = (id, dl) => {
  if (!id || !E2E.fileKeys.has(id)) return null;
  if (E2E.blobUrls.has(id)) return E2E.blobUrls.get(id);
  setTimeout(() => hydrate(id), 0);
  return PH + id;
};
E2E.isEncFile = (id) => !!id && E2E.fileKeys.has(id);
/** Save / open a file from a message (decrypting it first when it's end-to-end encrypted). */
App.downloadFile = async (m) => {
  const id = m.file_id; const name = (m.meta && m.meta.name) || 'file';
  if (!E2E.isEncFile(id)) { const a = document.createElement('a'); a.href = `/api/files/${encodeURIComponent(id)}?download=1`; a.download = name; document.body.appendChild(a); a.click(); a.remove(); return; }
  try {
    const u = await E2E.blobUrl(id); const N = plug('AvmNotify');
    if (N && N.saveFile) { const buf = await (await fetch(u)).arrayBuffer(); const r = await N.saveFile({ name, mime: (E2E.fileKeys.get(id) || [])[2] || 'application/octet-stream', data: B64.enc(buf) }); toast(r && r.where ? t('Saved to {w}', { w: r.where }) : t('Saved')); return; }
    const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  } catch { toast(t('Couldn’t open this encrypted file')); }
};

// ---------- safety number ----------
E2E.safetyNumber = async (pubA, pubB) => {
  const [x, y] = [pubA, pubB].sort(); const a = B64.dec(x), b = B64.dec(y); const all = new Uint8Array(a.length + b.length); all.set(a); all.set(b, a.length);
  const h = new Uint8Array(await sub.digest('SHA-256', all)); let out = [];
  for (let i = 0; i < 12; i++) { const n = ((h[i * 2] << 8) | h[i * 2 + 1]) % 100000; out.push(String(n).padStart(5, '0')); }
  return out.join(' ');
};
