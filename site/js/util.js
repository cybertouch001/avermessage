// AverChat — shared helpers, state, API client, i18n, UI primitives.
import { HI } from './i18n-hi.js';
export const App = {};                     // modules register their functions here (avoids import cycles)
export const S = {
  me: null, ice: [], config: {}, chats: new Map(), users: new Map(), msgs: new Map(), more: new Map(), receipts: new Map(), typing: new Map(),
  c: 0, s: 0, open: null, tab: 'chats', unlocked: false, seen: new Set(), pending: new Map(), presence: null, calls: [],
};
export const LS = { get: (k, d) => { try { const v = localStorage.getItem('avm.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('avm.' + k, JSON.stringify(v)); } catch {} } };
export const isApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const plug = (n) => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[n]) || null;

// ---------- i18n ----------
export const lang = () => (S.me && S.me.settings && S.me.settings.lang) || LS.get('lang', (navigator.language || '').startsWith('hi') ? 'hi' : 'en');
export function t(s, vars) { let o = lang() === 'hi' && HI[s] ? HI[s] : s; if (vars) for (const k in vars) o = o.split('{' + k + '}').join(vars[k]); return o; }

// ---------- DOM ----------
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
export const fileUrl = (id, dl) => id ? `/api/files/${encodeURIComponent(id)}${dl ? '?download=1' : ''}` : '';

// ---------- API ----------
export class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
export async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: { 'x-avm': '1' }, credentials: 'same-origin' };
  if (opts.timeout) { const ac = new AbortController(); o.signal = ac.signal; setTimeout(() => ac.abort(), opts.timeout); }
  if (opts.body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  let r;
  try { r = await fetch(path, o); } catch (e) { throw new ApiError(t('No internet connection'), 0, 'network'); }
  let data = null; try { data = await r.json(); } catch {}
  if (r.status === 401 && path !== '/api/auth/login') { App.loggedOut && App.loggedOut(); }
  if (!r.ok) throw new ApiError(t((data && data.error) || 'Something went wrong'), r.status, data && data.code);
  return data;
}
export function upload(file, scope, name, onProgress) {
  return new Promise((resolve, reject) => {
    if (file.size > (S.config.max_file || 52428800)) return reject(new ApiError(t('File too large (max 50 MB)'), 413));
    const x = new XMLHttpRequest();
    x.open('POST', `/api/upload?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name || file.name || 'file')}`);
    x.setRequestHeader('x-avm', '1'); x.setRequestHeader('content-type', file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {} if (x.status < 300 && d) resolve(d.file); else reject(new ApiError(t((d && d.error) || 'Upload failed'), x.status)); };
    x.onerror = () => reject(new ApiError(t('Upload failed — check your connection'), 0, 'network'));
    x.send(file);
  });
}

// ---------- formatting ----------
export const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ts) { const d = new Date(ts); let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; }
export function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
export function fmtDay(ts) {
  const d = new Date(ts), n = new Date(); const y = new Date(); y.setDate(n.getDate() - 1);
  if (dayKey(ts) === dayKey(n)) return t('Today'); if (dayKey(ts) === dayKey(y)) return t('Yesterday');
  const diff = (n - d) / 86400000; if (diff < 6) return d.toLocaleDateString(lang() === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'long' });
  return d.toLocaleDateString(lang() === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtListTime(ts) { if (!ts) return ''; return dayKey(ts) === dayKey(Date.now()) ? fmtTime(ts) : fmtDay(ts); }
export function fmtLastSeen(u) {
  if (!u) return ''; if (u.online) return t('online'); if (!u.last_seen) return '';
  const d = u.last_seen; if (dayKey(d) === dayKey(Date.now())) return t('last seen today at {t}', { t: fmtTime(d) });
  return t('last seen {d} at {t}', { d: fmtDay(d), t: fmtTime(d) });
}
export function fmtSize(b) { if (!b && b !== 0) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
export function fmtDur(s) { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60); }
export function linkify(text) {
  let s = esc(text);
  s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s>])\*([^*\n]+)\*(?=[\s<.,!?]|$)/g, '$1<b>$2</b>').replace(/(^|[\s>])_([^_\n]+)_(?=[\s<.,!?]|$)/g, '$1<i>$2</i>').replace(/(^|[\s>])~([^~\n]+)~(?=[\s<.,!?]|$)/g, '$1<s>$2</s>').replace(/```([^`]+)```/g, '<code>$1</code>');
  return s.replace(/\n/g, '<br>');
}
export const emojiOnly = (s) => { const x = String(s || '').trim(); return x.length > 0 && x.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(x) && !/^[\d#*\s]+$/.test(x); };
const COLORS = ['#5b4bdb', '#c2410c', '#0e7490', '#b45309', '#be185d', '#4d7c0f', '#7c3aed', '#0369a1', '#a21caf', '#15803d', '#b91c1c', '#4338ca'];
export const colorFor = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
export const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export function avatar(o, size = 46, extra = '') {
  const isGroup = o && o.type === 'group';
  const photo = o && o.photo; const name = (o && o.name) || '';
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`;
  if (photo) return `<span class="av ${extra}" style="${st}"><img src="${fileUrl(photo)}" alt="" loading="lazy"></span>`;
  if (isGroup) return `<span class="av grp ${extra}" style="${st};background:${colorFor(o.id)}">${ICON.group}</span>`;
  return `<span class="av ${extra}" style="${st};background:${colorFor(o && o.id)}">${esc(initials(name))}</span>`;
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- icons (original line icons) ----------
const sv = (p, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const ICON = {
  back: sv('<path d="M15 5l-7 7 7 7"/>'), send: sv('<path d="M4 12l16-8-6 16-3-7z" fill="currentColor" stroke="none"/>'), mic: sv('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>'),
  attach: sv('<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4L14.5 7"/>'), emoji: sv('<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>'),
  phone: sv('<path d="M5 4h3l2 5-2.5 1.5a11 11 0 006 6L15 14l5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>'), video: sv('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>'),
  more: sv('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'), search: sv('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  plus: sv('<path d="M12 5v14M5 12h14"/>'), close: sv('<path d="M6 6l12 12M18 6L6 18"/>'), check: sv('<path d="M4 12l5 5L20 6"/>'),
  tick1: `<svg viewBox="0 0 16 11" class="tk"><path d="M1.5 6l3.5 3.5L14 1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  tick2: `<svg viewBox="0 0 20 11" class="tk"><path d="M1 6l3.5 3.5L13 1M7.5 9.5L16.5 1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  clock: sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), star: sv('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  pin: sv('<path d="M9 4h6l-1 5 4 4H6l4-4zM12 13v8"/>'), mute: sv('<path d="M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6"/>'), lock: sv('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
  archive: sv('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>'), group: sv('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6"/>'),
  camera: sv('<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="4"/>'), image: sv('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>'),
  doc: sv('<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'), poll: sv('<path d="M5 20V10M12 20V4M19 20v-7"/>'), trash: sv('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  reply: sv('<path d="M10 7L4 12l6 5M4 12h11a5 5 0 015 5v1"/>'), fwd: sv('<path d="M14 7l6 5-6 5M20 12H9a5 5 0 00-5 5v1"/>'), copy: sv('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),
  edit: sv('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), info: sv('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'), download: sv('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  play: `<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>`, pause: `<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>`,
  end: `<svg viewBox="0 0 24 24"><path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3.5-1.5v-3a10 10 0 00-6 0v3L5.5 17.5z" fill="currentColor"/></svg>`,
  micOff: sv('<path d="M9 9v2a3 3 0 005 2.2M15 11V6a3 3 0 00-5.7-1.3M5 11a7 7 0 0011 5.7M19 11a7 7 0 01-.4 2.3M12 18v3M3 3l18 18"/>'), camOff: sv('<path d="M2 6h10l4 4V8l6-3v14l-6-3v-1M2 6v12h12M3 3l18 18"/>'),
  flip: sv('<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><path d="M9 13a3 3 0 015-2M15 13a3 3 0 01-5 2M14 9v2h-2M10 17v-2h2"/>'), speaker: sv('<path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/>'),
  status: sv('<circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/><circle cx="12" cy="12" r="4"/>'), chats: sv('<path d="M4 5h16v11H9l-5 4z"/>'), calls: sv('<path d="M5 4h3l2 5-2.5 1.5a11 11 0 006 6L15 14l5 2v3a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>'),
  settings: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  callIn: sv('<path d="M17 7L7 17M7 9v8h8"/>'), callOut: sv('<path d="M7 17L17 7M9 7h8v8"/>'), shield: sv('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'), user: sv('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>'),
  timer: sv('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>'), bell: sv('<path d="M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4"/>'), globe: sv('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>'),
  moon: sv('<path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z"/>'), key: sv('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'), wall: sv('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/>'),
  logout: sv('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'), block: sv('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'), flag: sv('<path d="M5 21V4h11l-2 4 2 4H5"/>'), sched: sv('<circle cx="12" cy="13" r="8"/><path d="M12 9v4h3M5 3L2 6M19 3l3 3"/>'),
};

// ---------- toast / modal / sheet ----------
export function toast(msg, ms = 2600) { const t0 = el(`<div class="toast">${esc(msg)}</div>`); document.body.appendChild(t0); requestAnimationFrame(() => t0.classList.add('in')); setTimeout(() => { t0.classList.remove('in'); setTimeout(() => t0.remove(), 300); }, ms); }
export const nav = { ignore: 0 };
export function goBack() { nav.ignore++; history.back(); }
export const modalStack = [];
export function openModal(html, { cls = '', onClose } = {}) {
  const w = el(`<div class="modal-wrap ${cls}"><div class="modal-bg"></div><div class="modal">${html}</div></div>`);
  document.body.appendChild(w); requestAnimationFrame(() => w.classList.add('in'));
  const close = (fromPop) => { const i = modalStack.indexOf(entry); if (i < 0) return; modalStack.splice(i, 1); w.classList.remove('in'); setTimeout(() => w.remove(), 200); onClose && onClose(); if (!fromPop) goBack(); };
  const entry = { w, close };
  modalStack.push(entry); history.pushState({ ...(history.state || {}), modal: modalStack.length }, '');
  w.querySelector('.modal-bg').onclick = () => close();
  w.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  return { el: w.querySelector('.modal'), close, wrap: w };
}
export function popModal() { const m = modalStack[modalStack.length - 1]; if (m) m.close(); }
export function closeTopModal() { const m = modalStack[modalStack.length - 1]; if (m) { m.close(true); return true; } return false; }
export function sheet(title, items) {
  // items: [{icon, label, danger, run}] ; returns promise resolved after choice
  return new Promise((res) => {
    const html = `${title ? `<div class="sheet-title">${title}</div>` : ''}<div class="sheet-list">${items.filter(Boolean).map((it, i) => `<button class="sheet-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? `<span class="ic">${it.icon}</span>` : ''}<span>${esc(it.label)}</span></button>`).join('')}</div>`;
    const list = items.filter(Boolean);
    const m = openModal(html, { cls: 'sheet', onClose: () => res(null) });
    m.el.querySelectorAll('.sheet-item').forEach((b) => (b.onclick = () => { const it = list[+b.dataset.i]; m.close(); setTimeout(() => { res(it); it.run && it.run(); }, 10); }));
  });
}
export function confirmBox(msg, okLabel = t('OK'), danger = false) {
  return new Promise((res) => {
    let done = false;
    const m = openModal(`<div class="dlg"><p>${esc(msg)}</p><div class="dlg-btns"><button class="btn ghost" data-c>${t('Cancel')}</button><button class="btn ${danger ? 'danger' : ''}" data-ok>${esc(okLabel)}</button></div></div>`, { onClose: () => { if (!done) res(false); } });
    m.el.querySelector('[data-c]').onclick = () => m.close();
    m.el.querySelector('[data-ok]').onclick = () => { done = true; res(true); m.close(); };
  });
}
export function prompt2(title, { value = '', placeholder = '', type = 'text', max = 200, multiline = false, okLabel } = {}) {
  return new Promise((res) => {
    let done = false;
    const input = multiline ? `<textarea class="inp" rows="3" maxlength="${max}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input class="inp" type="${type}" maxlength="${max}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${type === 'password' ? 'autocomplete="current-password"' : ''}>`;
    const m = openModal(`<form class="dlg"><h3>${esc(title)}</h3>${input}<div class="dlg-btns"><button type="button" class="btn ghost" data-c>${t('Cancel')}</button><button class="btn">${esc(okLabel || t('OK'))}</button></div></form>`, { onClose: () => { if (!done) res(null); } });
    const f = m.el.querySelector('form'); const i = f.querySelector('.inp'); setTimeout(() => i.focus(), 50);
    f.querySelector('[data-c]').onclick = () => m.close();
    f.onsubmit = (e) => { e.preventDefault(); done = true; res(i.value); m.close(); };
  });
}
export function longPress(node, fn) {
  let tm = null, sx = 0, sy = 0;
  node.addEventListener('touchstart', (e) => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; tm = setTimeout(() => { tm = null; navigator.vibrate && navigator.vibrate(20); fn(e); }, 480); }, { passive: true });
  node.addEventListener('touchmove', (e) => { const p = e.touches[0]; if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) { clearTimeout(tm); tm = null; } }, { passive: true });
  node.addEventListener('touchend', (e) => { if (tm) { clearTimeout(tm); tm = null; } else if (tm === null && e.cancelable) { /* long-press fired */ } }, { passive: true });
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(e); });
}
export function chatTitle(c) { if (!c) return ''; if (c.type === 'group') return c.name || t('Group'); const u = S.users.get(c.peer_id); return u ? u.name : t('Unknown'); }
export function chatAvatarObj(c) { if (c.type === 'group') return { id: c.id, type: 'group', photo: c.photo, name: c.name }; const u = S.users.get(c.peer_id) || {}; return { id: c.peer_id, photo: u.photo, name: u.name }; }
export const nameOf = (id) => (S.me && id === S.me.id ? t('You') : (S.users.get(id) || {}).name || t('Someone'));
export function previewText(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 ' + (m.sender_id === S.me.id ? t('You deleted this message') : t('This message was deleted'));
  switch (m.type) {
    case 'image': return '📷 ' + (m.body || t('Photo')); case 'video': return '🎥 ' + (m.body || t('Video'));
    case 'voice': return '🎤 ' + t('Voice message') + (m.meta.duration ? ' (' + fmtDur(m.meta.duration) + ')' : ''); case 'audio': return '🎵 ' + (m.meta.name || t('Audio'));
    case 'file': return '📄 ' + (m.meta.name || t('Document')); case 'poll': return '📊 ' + (m.meta.question || t('Poll'));
    case 'call': return (m.meta.kind === 'video' ? '🎥 ' : '📞 ') + callLabel(m);
    case 'location': return '📍 ' + (m.meta.label || t('Location')); case 'contact': return '👤 ' + (m.meta.name || t('Contact'));
    case 'system': return sysText(m);
    default: return m.body;
  }
}
export function callLabel(m) {
  const mine = m.sender_id === S.me.id; const k = m.meta.kind === 'video' ? t('Video call') : t('Voice call');
  if (m.meta.status === 'missed') return mine ? t('{k}, no answer', { k }) : t('Missed {k}', { k: k.toLowerCase() });
  if (m.meta.status === 'declined') return mine ? t('{k}, declined', { k }) : t('{k}, you declined', { k });
  if (m.meta.status === 'cancelled') return mine ? t('{k}, cancelled', { k }) : t('Missed {k}', { k: k.toLowerCase() });
  return k + (m.meta.duration ? ' · ' + fmtDur(m.meta.duration) : '');
}
export function sysText(m) {
  const x = m.meta || {}; const a = m.sender_id === S.me.id ? t('You') : x.actor || t('Someone'); const tg = (x.targets || []).join(', ');
  switch (x.ev) {
    case 'created': return t('{a} created group “{n}”', { a, n: x.name }); case 'added': return t('{a} added {b}', { a, b: tg }); case 'removed': return t('{a} removed {b}', { a, b: tg });
    case 'left': return t('{a} left', { a }); case 'name': return t('{a} changed the group name to “{n}”', { a, n: x.name }); case 'photo': return t('{a} changed the group photo', { a });
    case 'admin': return t('{a} made {b} an admin', { a, b: tg }); case 'unadmin': return t('{a} dismissed {b} as admin', { a, b: tg });
    case 'only_admins': return x.on ? t('{a} changed settings: only admins can send messages', { a }) : t('{a} changed settings: all members can send messages', { a });
    case 'disappearing': return x.seconds ? t('{a} turned on disappearing messages ({d})', { a, d: dLabel(x.seconds) }) : t('{a} turned off disappearing messages', { a });
    case 'pinned': return t('{a} pinned a message', { a });
    case 'created_channel': return t('{a} created channel “{n}”', { a, n: x.name }); case 'joined_link': return t('{a} joined using the invite link', { a }); case 'joined_channel': return t('{a} joined', { a });
    default: return '';
  }
}
export const dLabel = (s) => ({ 86400: t('24 hours'), 604800: t('7 days'), 7776000: t('90 days') }[s] || t('Off'));
export const WALLPAPERS = ['default', 'violet', 'dawn', 'mint', 'ocean', 'night', 'sand', 'rose', 'plain'];
