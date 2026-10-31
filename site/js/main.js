// AverChat — boot, auth, shell, sync loop, chat list.
import { nav, goBack, App, S, LS, t, $, $$, esc, el, api, toast, avatar, ICON, fmtListTime, previewText, chatTitle, chatAvatarObj, nameOf, openModal, closeTopModal, modalStack, sheet, confirmBox, prompt2, longPress, isApp, plug, lang, fileUrl, uid } from './util.js';
import './e2e.js'; import './brand.js'; import './chat.js'; import './media.js'; import './call.js'; import './status.js'; import './settings.js'; import './extras.js';

const drawers = [];
// ---------- theme ----------
export function applyTheme() {
  const st = (S.me && S.me.settings) || {}; const b = App.brand ? App.brand() : {};
  const th = b.theme && b.theme !== 'user' ? b.theme : st.theme || LS.get('theme', b.theme === 'user' ? 'system' : 'dark');
  const dark = th === 'dark' || (th === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.font = st.font || 'normal';
  document.documentElement.lang = lang();
  const bar = App.applyBrand ? App.applyBrand(dark) : (dark ? '#151527' : '#4b38dc');
  const meta = $('meta[name=theme-color]'); if (meta) meta.content = bar;
  const sb = plug('StatusBar'); if (sb) { try { sb.setBackgroundColor({ color: bar }); sb.setStyle({ style: 'DARK' }); } catch {} }
}
App.applyTheme = applyTheme;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- auth ----------
function renderAuth(mode = 'login') {
  applyTheme();
  document.body.className = 'auth';
  const b = App.brand();
  $('#root').innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <img src="${App.logoUrl(b)}" class="auth-logo brand-logo" alt="">
    <h1 class="brand-name">${esc(b.app_name)}</h1><p class="muted brand-tag">${esc(b.tagline || '')}</p>
    <div class="seg"><button class="${mode === 'login' ? 'on' : ''}" data-m="login">${t('Log in')}</button><button class="${mode === 'signup' ? 'on' : ''}" data-m="signup">${t('Create account')}</button></div>
    <form id="authf" autocomplete="on">
      ${mode === 'signup' ? `<label>${t('Your name')}<input name="name" required maxlength="50" autocomplete="name"></label>
      <label>${t('Username')}<input name="username" required pattern="[A-Za-z0-9_.]{3,20}" maxlength="20" autocomplete="username" placeholder="e.g. rahul_k"></label>
      <label>${t('Phone number')} <span class="req">*</span><input name="phone" type="tel" required maxlength="16" autocomplete="tel" placeholder="+91 98xxxxxxxx"></label>
      <label>${t('Email (optional)')}<input name="email" type="email" maxlength="200" autocomplete="email" placeholder="you@example.com"></label>
      <label>${t('Password')}<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>`
      : `<label>${t('Phone number or username')}<input name="id" required autocomplete="username" placeholder="+91… / username"></label>
      <label>${t('Password')}<input name="password" type="password" required autocomplete="current-password"></label>`}
      <div class="err" id="autherr"></div>
      <button class="btn wide">${mode === 'signup' ? t('Create account') : t('Log in')}</button>
    </form>
    ${mode === 'signup' ? `<p class="fine">${t('No SMS code is needed: your account is your phone/username + password. Keep your password safe.')}</p>` : `<p class="fine">${t('Old account without a phone number? Just log in with your username.')}</p>`}
    <div class="auth-foot"><button class="linkbtn" id="langbtn">${lang() === 'hi' ? 'English' : 'हिन्दी'}</button>${isApp() ? '' : ` · <a href="/download">${t('Android app')}</a>`}</div>
  </div></div>`;
  $$('.seg button').forEach((x) => (x.onclick = () => renderAuth(x.dataset.m)));
  $('#langbtn').onclick = () => { LS.set('lang', lang() === 'hi' ? 'en' : 'hi'); renderAuth(mode); };
  $('#authf').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target); const body = Object.fromEntries(f.entries()); const btn = e.target.querySelector('button'); btn.disabled = true; $('#autherr').textContent = '';
    try { const r = await api(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { body }); S.me = r.user; if (mode === 'signup') { S.me.settings = { ...(S.me.settings || {}), lang: lang() }; api('/api/me', { method: 'PATCH', body: { settings: S.me.settings } }).catch(() => {}); } try { btn.textContent = '🔒 …'; await App.E2E.afterPassword(body.password, S.me); } catch {} await start(); }
    catch (er) { $('#autherr').textContent = er.message; btn.disabled = false; }
  };
}
App.loggedOut = () => { if (!S.me) return; S.me = null; stopSync(); location.reload(); };
export async function logout() { try { await api('/api/auth/logout', { body: {} }); } catch {} try { await App.E2E.forget(); } catch {} try { const N = plug('AvmNotify'); if (N) await N.loggedOut(); } catch {} S.me = null; stopSync(); location.href = '/'; }
App.logout = logout;
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__avm = { App, S }; // local test runs only
// encryption was just unlocked / turned on: reload chats so encrypted messages open
App.reloadAfterE2E = async () => { try { S.msgs.clear(); await loadChats(); renderList && renderList(); if (S.open) { const id = S.open; App.openChat(id); } } catch {} };

// ---------- boot ----------
async function boot() {
  applyTheme();
  // config (brand) and the session load while the intro video plays
  const cfgP = App.loadConfig();
  const meP = api('/api/me').then((r) => ({ r }), (e) => ({ e }));
  await cfgP; applyTheme();
  await App.playIntro();
  const { r, e } = await meP;
  if (r) { S.me = r.user; S.ice = r.ice; try { await start(r); } catch (er) { bootError(er); } }
  else if (e.status === 401 || e.status === 403) renderAuth(); else bootError(e);
}
function bootError(e) { const b = App.brand(); $('#root').innerHTML = `<div class="auth-wrap"><div class="auth-card"><img src="${App.logoUrl(b)}" class="auth-logo" alt=""><h1>${esc(b.app_name)}</h1><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">${t('Try again')}</button></div></div>`; }
async function start(meResp) {
  if (!meResp) { const r = await api('/api/me'); S.me = r.user; S.ice = r.ice; }
  await App.loadConfig();
  if (!App.E2E.ready) { try { await App.E2E.init(); } catch {} }
  applyTheme(); renderShell(); await loadChats(); startSync(); App.initNotifications && App.initNotifications();
  window.avmOpenChat = async (id) => { try { if (!S.chats.has(id)) await loadChats(); if (S.chats.has(id)) App.openChat(id); } catch {} };
  App.nativeInit && App.nativeInit();
  const h = location.hash.match(/^#chat=([\w-]+)/); if (h && S.chats.has(h[1])) App.openChat(h[1]);
  App.handleJoinPath && App.handleJoinPath();
  if ('serviceWorker' in navigator && !isApp()) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------- shell ----------
function renderShell() {
  document.body.className = 'main';
  const b = App.brand();
  $('#root').innerHTML = `<div id="app">
    <aside id="side">
      <header class="bar side-bar"><div class="brand"><img class="brand-logo" src="${App.logoUrl(b)}" alt=""><span class="brand-name">${esc(b.app_name)}</span></div>
        <div class="bar-btns"><button class="ib" id="b-search" title="${t('Search')}">${ICON.search}</button><button class="ib" id="b-menu" title="${t('Menu')}">${ICON.more}</button></div></header>
      <div class="searchrow hidden" id="listsearch"><input id="listq" placeholder="${t('Search chats')}" autocomplete="off"><button class="ib" id="listq-x">${ICON.close}</button></div>
      <div id="announce"></div>
      <div id="tabbody"></div>
      <nav class="bnav" id="tabs">
        <button data-t="chats">${ICON.chats}<span>${t('Chats')}</span><i class="tb" id="tb-chats"></i></button>
        <button data-t="calls">${ICON.calls}<span>${t('Calls')}</span><i class="tb" id="tb-calls"></i></button>
        <button class="bplus" id="fab" title="${t('New')}">${ICON.plus}</button>
        <button data-t="groups">${ICON.group}<span>${t('Groups')}</span><i class="tb" id="tb-groups"></i></button>
        <button data-t="me">${ICON.user}<span>${t('Me')}</span><i class="tb dot" id="tb-status"></i></button>
      </nav>
    </aside>
    <main id="main"><div class="empty-main"><img class="brand-logo" src="${App.logoUrl(b)}" alt=""><h2 class="brand-name">${esc(b.app_name)}</h2><p>${t('Pick a chat to start messaging.')}</p><p class="fine">${ICON.shield} ${t('1:1 and group chats are end-to-end encrypted: only the people in a chat can read its messages and files. Channels and status updates are not.')}</p></div></main>
  </div>`;
  $$('#tabs button[data-t]').forEach((x) => (x.onclick = () => setTab(x.dataset.t)));
  $('#b-menu').onclick = mainMenu;
  $('#b-search').onclick = () => { if (S.tab !== 'chats') setTab('chats'); $('#listsearch').classList.toggle('hidden'); $('#listq').focus(); };
  $('#listq').oninput = () => renderList();
  $('#listq-x').onclick = () => { $('#listq').value = ''; $('#listsearch').classList.add('hidden'); renderList(); };
  $('#fab').onclick = plusMenu;
  renderAnnounce(); setTab(S.tab === 'status' ? 'chats' : S.tab);
}
App.renderShell = renderShell;
function plusMenu() {
  sheet(t('Create'), [
    { icon: ICON.chats, label: t('New chat'), run: () => newChat() },
    { icon: ICON.group, label: t('New group'), run: () => newGroup() },
    { icon: ICON.globe, label: t('New channel'), run: () => App.newChannel() },
    { icon: ICON.camera, label: t('Add status'), run: () => App.newStatus() },
    { icon: ICON.phone, label: t('New call'), run: () => App.newCallPicker() },
  ]);
}
function renderAnnounce() { const a = S.config.announcement; const box = $('#announce'); if (!box) return; box.innerHTML = a && LS.get('ann-dismissed') !== a ? `<div class="announce"><span>📣 ${esc(a)}</span><button class="ib sm">${ICON.close}</button></div>` : ''; const x = box.querySelector('button'); if (x) x.onclick = () => { LS.set('ann-dismissed', a); renderAnnounce(); }; }
App.renderAnnounce = renderAnnounce;
function setTab(tab) {
  S.tab = tab; $$('#tabs button[data-t]').forEach((x) => x.classList.toggle('on', x.dataset.t === tab || (tab === 'status' && x.dataset.t === 'chats')));
  if (tab === 'chats') renderList(); else if (tab === 'status') App.renderStatusTab(); else if (tab === 'calls') App.renderCallsTab(); else if (tab === 'groups') App.renderGroupsTab(); else if (tab === 'me') App.renderMeTab();
}
App.setTab = setTab;
function mainMenu() {
  sheet('', [
    { icon: ICON.group, label: t('New group'), run: () => newGroup() },
    { icon: ICON.globe, label: t('New channel'), run: () => App.newChannel() },
    { icon: ICON.search, label: t('Discover channels'), run: () => App.discoverChannels() },
    { icon: ICON.star, label: t('Starred messages'), run: () => App.starred() },
    { icon: ICON.archive, label: t('Archived chats'), run: () => openFolder('archived') },
    { icon: ICON.settings, label: t('Settings'), run: () => App.settings() },
    S.me.role === 'admin' ? { icon: ICON.shield, label: t('Admin panel'), run: () => App.openAdmin() } : null,
    { icon: ICON.logout, label: t('Log out'), danger: true, run: async () => { if (await confirmBox(t('Log out of {a} on this device?', { a: App.brand().app_name }), t('Log out'), true)) logout(); } },
  ]);
}

// ---------- drawers (full-height panels over the list) ----------
export function openDrawer(title, html, { onClose, wide, actions = '' } = {}) {
  const d = el(`<section class="drawer ${wide ? 'wide' : ''}"><header class="bar"><button class="ib back">${ICON.back}</button><h2>${esc(title)}</h2><div class="bar-btns">${actions}</div></header><div class="drawer-body">${html}</div></section>`);
  (wide ? document.body : $('#side')).appendChild(d); requestAnimationFrame(() => d.classList.add('in'));
  const entry = { d, onClose, close: (fromPop) => { const i = drawers.indexOf(entry); if (i < 0) return; drawers.splice(i, 1); d.classList.remove('in'); setTimeout(() => d.remove(), 220); onClose && onClose(); if (!fromPop) goBack(); } };
  drawers.push(entry); history.pushState({ drawer: drawers.length }, '');
  d.querySelector('.back').onclick = () => entry.close();
  return { el: d, body: d.querySelector('.drawer-body'), close: () => entry.close(), setTitle: (x) => (d.querySelector('h2').textContent = x) };
}
App.openDrawer = openDrawer;
App.closeAllDrawers = () => { while (drawers.length) { const e = drawers.pop(); e.d.remove(); e.onClose && e.onClose(); } };

// back handling (browser back, Android back)
window.addEventListener('popstate', () => {
  if (nav.ignore > 0) { nav.ignore--; return; }
  if (modalStack.length) { closeTopModal(); return; }
  if (App.callActive && App.callActive()) { history.pushState({ call: 1 }, ''); return; }
  if (drawers.length) { drawers[drawers.length - 1].close(true); return; }
  if (S.open) { App.closeChat(true); return; }
});
function androidBack() {
  if (modalStack.length || drawers.length || S.open) { history.back(); return; }
  if (S.tab !== 'chats') { setTab('chats'); return; }
  const A = plug('App'); A && A.minimizeApp && A.minimizeApp();
}
if (plug('App')) try { plug('App').addListener('backButton', androidBack); plug('App').addListener('resume', () => { kick(); }); } catch {}

// ---------- chats ----------
export async function loadChats() {
  const r = await api('/api/chats');
  for (const u of Object.values(r.users)) S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u });
  const ids = new Set(r.chats.map((c) => c.id));
  for (const c of r.chats) S.chats.set(c.id, c);
  for (const id of [...S.chats.keys()]) if (!ids.has(id) && id !== S.open) S.chats.delete(id);
  if (S.tab === 'chats') renderList(); updateBadges();
  if (S.open && S.chats.has(S.open)) App.refreshChatHeader && App.refreshChatHeader();
}
App.loadChats = loadChats;
function sorted(list) { return list.sort((a, b) => (b.pinned - a.pinned) || ((b.last ? b.last.deliver_at : b.last_msg_at) - (a.last ? a.last.deliver_at : a.last_msg_at))); }
export function renderList() {
  const body = $('#tabbody'); if (!body || S.tab !== 'chats') return;
  const q = ($('#listq') && $('#listq').value.trim().toLowerCase()) || '';
  const all = [...S.chats.values()];
  const flt = S.filter || 'all';
  const pass = (c) => flt === 'all' || (flt === 'personal' && c.type === 'direct') || (flt === 'groups' && c.type === 'group' && !c.channel) || (flt === 'channels' && c.channel) || (flt === 'unread' && c.unread > 0);
  let list = all.filter((c) => !c.archived && !c.locked && pass(c));
  if (q) list = all.filter((c) => (!c.locked || S.unlocked) && chatTitle(c).toLowerCase().includes(q));
  const arch = all.filter((c) => c.archived && !c.locked); const locked = all.filter((c) => c.locked);
  let html = '';
  if (!q && locked.length) html += `<button class="row folder" data-folder="locked"><span class="av fold">${ICON.lock}</span><span class="row-main"><b>${t('Locked chats')}</b></span><span class="row-side">${locked.reduce((n, c) => n + (c.unread ? 1 : 0), 0) || ''}</span></button>`;
  if (!q && arch.length) html += `<button class="row folder" data-folder="archived"><span class="av fold">${ICON.archive}</span><span class="row-main"><b>${t('Archived')}</b></span><span class="row-side">${arch.reduce((n, c) => n + (c.unread ? 1 : 0), 0) || ''}</span></button>`;
  html += sorted(list).map(rowHtml).join('');
  if (!all.length) html += `<div class="empty"><p>${t('No chats yet.')}</p><button class="btn" id="startchat">${t('Start a chat')}</button></div>`;
  else if (!list.length && q) html += `<div class="empty"><p>${t('No chats found')}</p></div>`;
  const chips = [['all', t('All')], ['personal', t('Personal')], ['groups', t('Groups')], ['channels', t('Channels')], ['unread', t('Unread')]];
  body.innerHTML = `${q ? '' : '<div id="strip" class="strip"></div>'}<div class="fchips">${chips.map(([k, l]) => `<button class="fchip ${flt === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div><div class="list">${html}</div>`;
  bindRows(body);
  $$('.fchip', body).forEach((x) => (x.onclick = () => { S.filter = x.dataset.f; renderList(); }));
  App.renderStrip && App.renderStrip();
  $$('.folder', body).forEach((b) => (b.onclick = () => openFolder(b.dataset.folder)));
  const sc = $('#startchat', body); if (sc) sc.onclick = newChat;
}
App.renderList = renderList;
export function rowHtml(c) {
  const last = c.last; const typing = (S.typing.get(c.id) || []).filter((x) => x.until > Date.now());
  let sub;
  if (c.locked && !S.unlocked) sub = `<i>${t('Locked')}</i>`;
  else if (typing.length) sub = `<span class="typing">${typing[0].kind === 'recording' ? t('recording audio…') : c.type === 'group' ? esc(nameOf(typing[0].user_id)) + ' ' + t('is typing…') : t('typing…')}</span>`;
  else if (last) { const mine = last.sender_id === S.me.id; const who = c.type === 'group' && last.type !== 'system' && last.type !== 'call' ? esc(nameOf(last.sender_id)) + ': ' : ''; sub = (mine && !['system', 'call'].includes(last.type) && !last.deleted ? App.ticks(last, c) : '') + who + esc(previewText(last)); }
  else sub = c.type === 'group' ? `<i>${t('Group created')}</i>` : '';
  const muted = c.muted_until > Date.now();
  return `<button class="row chatrow ${S.open === c.id ? 'sel' : ''}" data-id="${c.id}">${avatar(chatAvatarObj(c))}<span class="row-main"><span class="row-top"><b class="nm">${esc(chatTitle(c))}</b><span class="tm ${c.unread && !muted ? 'hot' : ''}">${fmtListTime(last ? last.deliver_at : c.last_msg_at)}</span></span><span class="row-sub"><span class="sub">${sub}</span><span class="flags">${muted ? `<i class="fl">${ICON.mute}</i>` : ''}${c.pinned ? `<i class="fl">${ICON.pin}</i>` : ''}${c.unread ? `<span class="badge ${muted ? 'mut' : ''}">${c.unread}</span>` : ''}</span></span></span></button>`;
}
function bindRows(root) {
  $$('.chatrow', root).forEach((b) => { b.onclick = () => App.openChat(b.dataset.id); longPress(b, () => rowMenu(b.dataset.id)); });
}
App.bindRows = bindRows;
async function rowMenu(id) {
  const c = S.chats.get(id); if (!c) return;
  const muted = c.muted_until > Date.now();
  const set = async (b, msg) => { try { await api(`/api/chats/${id}/prefs`, { body: b }); Object.assign(c, Object.fromEntries(Object.entries(b))); if (b.muted_until !== undefined) c.muted_until = b.muted_until; renderList(); refreshFolders(); msg && toast(msg); } catch (e) { toast(e.message); } };
  sheet(esc(chatTitle(c)), [
    { icon: ICON.pin, label: c.pinned ? t('Unpin chat') : t('Pin chat'), run: () => set({ pinned: !c.pinned }) },
    { icon: ICON.archive, label: c.archived ? t('Unarchive chat') : t('Archive chat'), run: () => set({ archived: !c.archived }, c.archived ? t('Chat unarchived') : t('Chat archived')) },
    { icon: ICON.mute, label: muted ? t('Unmute') : t('Mute notifications'), run: () => (muted ? set({ muted_until: 0 }) : App.muteMenu(c)) },
    { icon: ICON.lock, label: c.locked ? t('Unlock chat') : t('Lock chat'), run: () => App.toggleLock(c) },
    c.unread ? { icon: ICON.check, label: t('Mark as read'), run: async () => { await api(`/api/chats/${id}/read`, { body: { upto: Date.now() } }); c.unread = 0; renderList(); updateBadges(); } } : null,
    { icon: ICON.trash, label: c.type === 'group' && !c.left ? t('Exit group') : t('Delete chat'), danger: true, run: () => App.deleteOrExit(c) },
  ]);
}
App.rowMenu = rowMenu;
const folders = [];
function refreshFolders() { folders.forEach((f) => f()); }
async function openFolder(kind) {
  if (kind === 'locked' && !S.unlocked) { const ok = await App.askPin(); if (!ok) return; }
  const d = openDrawer(kind === 'locked' ? t('Locked chats') : t('Archived'), '', { onClose: () => folders.splice(folders.indexOf(render), 1) });
  const render = () => { const list = sorted([...S.chats.values()].filter((c) => (kind === 'locked' ? c.locked : c.archived && !c.locked))); d.body.innerHTML = `<div class="list">${list.map(rowHtml).join('') || `<div class="empty"><p>${t('Nothing here')}</p></div>`}</div>${kind === 'archived' ? `<p class="fine pad">${t('Archived chats stay archived when new messages arrive.')}</p>` : ''}`; bindRows(d.body); };
  folders.push(render); render();
}
App.refreshFolders = refreshFolders;
export function updateBadges() {
  const unread = [...S.chats.values()].filter((c) => c.unread && !c.archived && c.muted_until < Date.now()).length;
  const tb = $('#tb-chats'); if (tb) tb.textContent = unread || '';
  document.title = (unread ? `(${unread}) ` : '') + 'AverChat';
  const missed = LS.get('missed-' + (S.me && S.me.id), 0); const tc = $('#tb-calls'); if (tc) tc.textContent = missed || '';
}
App.updateBadges = updateBadges;

// ---------- new chat / group ----------
async function userSearchHtml(users, sel) {
  return users.map((u) => `<button class="row userrow ${sel && sel.has(u.id) ? 'picked' : ''}" data-u="${u.id}">${avatar(u)}<span class="row-main"><b>${esc(u.name)}</b><span class="sub">@${esc(u.username)}${u.about ? ' · ' + esc(u.about) : ''}</span></span>${sel ? `<span class="chk">${ICON.check}</span>` : ''}</button>`).join('');
}
async function getContacts() { const r = await api('/api/contacts'); r.users.forEach((u) => S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u })); return r.users.sort((a, b) => a.name.localeCompare(b.name)); }
App.getContacts = getContacts;
export async function pickUsers({ title, multi, onDone, exclude = [] }) {
  const sel = new Map();
  const d = openDrawer(title, `<div class="searchrow"><input id="pq" placeholder="${t('Search username, phone or name')}" autocomplete="off"></div>${multi ? '<div class="chips" id="pchips"></div>' : ''}<div id="pres" class="list"></div>${multi ? `<button class="fab" id="pdone">${ICON.check}</button>` : ''}`);
  const res = $('#pres', d.el); const q = $('#pq', d.el);
  let contacts = [];
  const show = async (users, label) => { res.innerHTML = (label ? `<div class="sect">${label}</div>` : '') + (await userSearchHtml(users, multi ? sel : null)) || `<div class="empty"><p>${t('No one found. Ask your friend for their AverChat username.')}</p></div>`; $$('.userrow', res).forEach((b) => (b.onclick = () => { const u = S.users.get(b.dataset.u) || users.find((x) => x.id === b.dataset.u); if (!multi) { d.close(); onDone(u); return; } if (sel.has(u.id)) sel.delete(u.id); else sel.set(u.id, u); b.classList.toggle('picked'); chips(); })); };
  const chips = () => { const c = $('#pchips', d.el); if (c) c.innerHTML = [...sel.values()].map((u) => `<span class="chip">${esc(u.name)}</span>`).join(''); };
  let tm, seq = 0;
  const search = async () => { const v = q.value.trim(); const my = ++seq; if (v.length < 2) return show(contacts, contacts.length ? t('Contacts') : ''); try { const r = await api('/api/users/search?q=' + encodeURIComponent(v)); if (my !== seq) return; r.users.forEach((u) => S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u })); show(r.users.filter((u) => !exclude.includes(u.id)), t('Results')); } catch (e) { toast(e.message); } };
  q.oninput = () => { clearTimeout(tm); tm = setTimeout(search, 250); };
  try { contacts = (await getContacts()).filter((u) => !exclude.includes(u.id)); } catch {}
  if (q.value.trim().length < 2) show(contacts, contacts.length ? t('Contacts') : '');
  if (multi) $('#pdone', d.el).onclick = () => { if (!sel.size) return toast(t('Pick at least one person')); d.close(); onDone([...sel.values()]); };
  setTimeout(() => q.focus(), 100);
  return d;
}
App.pickUsers = pickUsers;
export async function newChat() {
  const d = await pickUsers({ title: t('New chat'), onDone: (u) => openDirect(u.id) });
  const top = el(`<div class="list"><button class="row" id="ng"><span class="av fold">${ICON.group}</span><span class="row-main"><b>${t('New group')}</b></span></button></div>`);
  d.body.insertBefore(top, d.body.children[1]); $('#ng', top).onclick = () => { d.close(); setTimeout(newGroup, 50); };
}
App.newChat = newChat;
export async function openDirect(userId) {
  try { const r = await api('/api/chats/direct', { body: { user_id: userId } }); for (const u of Object.values(r.users)) S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u }); S.chats.set(r.chat.id, r.chat); renderList(); App.closeAllDrawers(); App.openChat(r.chat.id); }
  catch (e) { toast(e.message); }
}
App.openDirect = openDirect;
async function newGroup() {
  pickUsers({ title: t('Add group members'), multi: true, onDone: (users) => groupDetails(users) });
}
function groupDetails(users) {
  let photo = null;
  const d = openDrawer(t('New group'), `<form class="form" id="gf"><div class="gphoto" id="gph">${ICON.camera}<span>${t('Add group icon')}</span></div><input type="file" accept="image/*" id="gfile" hidden>
    <label>${t('Group name')}<input name="name" required maxlength="60"></label><label>${t('Description (optional)')}<input name="description" maxlength="500"></label>
    <p class="muted">${t('Members')}: ${users.map((u) => esc(u.name)).join(', ')}</p><button class="btn wide">${t('Create group')}</button></form>`);
  $('#gph', d.el).onclick = () => $('#gfile', d.el).click();
  $('#gfile', d.el).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const sq = await App.squareImage(f, 512); const up = await App.uploadFile(sq, 'group-new', 'group.jpg'); photo = up.id; $('#gph', d.el).innerHTML = `<img src="${URL.createObjectURL(sq)}">`; } catch (er) { toast(er.message); } };
  $('#gf', d.el).onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target); const btn = e.target.querySelector('button'); btn.disabled = true;
    try { const r = await api('/api/chats/group', { body: { name: f.get('name'), description: f.get('description'), members: users.map((u) => u.id), photo } }); for (const u of Object.values(r.users)) S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u }); S.chats.set(r.chat.id, r.chat); App.closeAllDrawers(); setTimeout(() => App.openChat(r.chat.id), 60); renderList(); }
    catch (er) { toast(er.message); btn.disabled = false; }
  };
}
App.openFolder = openFolder;
App.newGroup = newGroup;

// ---------- sync loop ----------
let syncT = null, syncing = false, failCount = 0, stopped = false;
// Long-poll: the server holds /api/sync until something changes (or ~15 s pass), so new messages, ticks,
// typing and call signals arrive within a fraction of a second without hammering the server.
function waitMs() { if (S.b == null) return 0; if ([...S.typing.values()].some((a) => a.length)) return 3000; return 15000; }
let pollAbort = null, kicked = false;
export function startSync() { stopped = false; S.b = null; S.c = LS.get('c-' + S.me.id, 0) || Date.now() - 60000; S.c = Math.max(S.c, Date.now() - 6 * 3600000); tick(); }
export function stopSync() { stopped = true; clearTimeout(syncT); if (pollAbort) pollAbort.abort(); }
export function kick() { clearTimeout(syncT); if (syncing) { kicked = true; if (pollAbort) pollAbort.abort(); return; } syncT = setTimeout(tick, 10); }
App.kick = kick;
async function tick() {
  if (stopped || syncing) return; syncing = true; kicked = false;
  let aborted = false;
  try {
    const peer = S.open && S.chats.get(S.open) && S.chats.get(S.open).type === 'direct' ? S.chats.get(S.open).peer_id : '';
    const w = document.hidden && !isApp() ? 0 : waitMs();
    const ac = new AbortController(); pollAbort = ac; const to = setTimeout(() => ac.abort(), w + 20000);
    let r;
    try {
      const res = await fetch(`/api/sync?c=${S.c}&s=${S.s}&b=${S.b == null ? -1 : S.b}&w=${w}${peer ? '&peer=' + peer : ''}`, { headers: { 'x-avm': '1' }, credentials: 'same-origin', signal: ac.signal });
      if (res.status === 401) { App.loggedOut && App.loggedOut(); throw new Error('auth'); }
      if (!res.ok) throw new Error('http ' + res.status);
      r = await res.json();
      try { if (App.E2E && App.E2E.inbound) await App.E2E.inbound(r); } catch {} // open end-to-end encrypted messages
    } catch (e) { if (ac.signal.aborted && kicked) aborted = true; throw e; } finally { clearTimeout(to); pollAbort = null; }
    failCount = 0; document.body.classList.remove('offline');
    await handleSync(r);
    S.c = r.c; S.s = r.s; S.b = r.b; LS.set('c-' + S.me.id, S.c);
  } catch (e) { if (!aborted) { failCount++; if (!navigator.onLine || failCount > 1) document.body.classList.add('offline'); } }
  syncing = false;
  if (!stopped) syncT = setTimeout(tick, kicked || aborted ? 10 : failCount ? Math.min(15000, 1000 * 2 ** failCount) : document.hidden && !isApp() ? 4000 : 40);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { kick(); App.markRead && App.markRead(); } });
window.addEventListener('online', kick);
let chatsReload = null;
async function handleSync(r) {
  let needList = r.chats_changed;
  const changedChats = new Set();
  for (const m of r.messages) {
    const c = S.chats.get(m.chat_id); if (!c) { needList = true; continue; }
    const fresh = !S.seen.has(m.id) && !(m.client_id && S.pending.has(m.client_id));
    App.upsertMessage(m);
    if (!c.last || m.deliver_at > c.last.deliver_at || (c.last.id === m.id)) c.last = m;
    if (fresh) {
      S.seen.add(m.id);
      if (m.sender_id !== S.me.id && m.type !== 'system') {
        const viewing = S.open === m.chat_id && !document.hidden && !App.isLockedView();
        if (!viewing && m.deliver_at > (S.bootAt || 0) - 5000) { c.unread = (c.unread || 0) + 1; App.notify && App.notify(c, m); }
      }
    }
    changedChats.add(m.chat_id);
  }
  for (const rc of r.receipts) { let mp = S.receipts.get(rc.chat_id); if (!mp) S.receipts.set(rc.chat_id, (mp = new Map())); mp.set(rc.user_id, rc); changedChats.add(rc.chat_id); }
  const now = Date.now(); const prevTyping = S.typing; S.typing = new Map();
  for (const ty of r.typing) { const a = S.typing.get(ty.chat_id) || []; a.push({ ...ty, until: now + 6000 }); S.typing.set(ty.chat_id, a); changedChats.add(ty.chat_id); }
  for (const k of prevTyping.keys()) changedChats.add(k);
  if (r.presence) { const u = S.users.get(r.presence.id); if (u) { u.online = r.presence.online; u.last_seen = r.presence.last_seen; } }
  if (r.calls.length || r.signals.length) App.onCallSync && App.onCallSync(r.calls, r.signals);
  if (changedChats.size) { if (S.tab === 'chats') renderList(); refreshFolders(); updateBadges(); if (S.open && changedChats.has(S.open)) App.onChatChanged && App.onChatChanged(); }
  if (S.open) App.refreshChatHeader && App.refreshChatHeader();
  if (r.brand_v && S.config.brand && r.brand_v !== S.config.brand.v) App.loadConfig(true).then(() => { applyTheme(); App.refreshBrand && App.refreshBrand(); renderAnnounce(); }).catch(() => {});
  if (needList) { clearTimeout(chatsReload); chatsReload = setTimeout(async () => { try { await loadChats(); if (S.open) App.reloadOpenChatMeta && App.reloadOpenChatMeta(); } catch {} }, 150); }
}
S.bootAt = Date.now();

boot();
