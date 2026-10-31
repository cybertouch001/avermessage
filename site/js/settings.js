// AverChat — settings, profile, privacy, admin panel.
import { App, S, LS, t, $, $$, esc, el, api, upload, toast, avatar, ICON, fmtListTime, fmtSize, fileUrl, openModal, sheet, confirmBox, prompt2, isApp, lang } from './util.js';

async function saveMe(b, msg) { try { const r = await api('/api/me', { method: 'PATCH', body: b }); S.me = r.user; S.users.set(S.me.id, { ...(S.users.get(S.me.id) || {}), ...S.me }); App.applyTheme(); msg && toast(msg); return true; } catch (e) { toast(e.message); return false; } }
const setSetting = (k, v) => saveMe({ settings: { ...(S.me.settings || {}), [k]: v } });
const pv = (v) => ({ all: t('Everyone'), contacts: t('My contacts'), none: t('Nobody') }[v]);

App.settings = () => {
  const d = App.openDrawer(t('Settings'), '');
  const render = () => {
    const st = S.me.settings || {};
    d.body.innerHTML = `<button class="row profile" id="s-prof">${avatar(S.me, 64)}<span class="row-main"><b>${esc(S.me.name)}</b><span class="sub">${esc(S.me.about || '')}</span><span class="sub">@${esc(S.me.username)}${S.me.phone ? ' · ' + esc(S.me.phone) : ''}</span></span></button>
      <div class="card">
        <button class="row" id="s-priv"><span class="ic">${ICON.lock}</span><span class="row-main">${t('Privacy')}<span class="sub">${t('Last seen, profile photo, read receipts, blocked, chat lock')}</span></span></button>
        <button class="row" id="s-chats"><span class="ic">${ICON.chats}</span><span class="row-main">${t('Chats')}<span class="sub">${t('Theme, wallpaper, font size, enter to send')}</span></span></button>
        <button class="row" id="s-notif"><span class="ic">${ICON.bell}</span><span class="row-main">${t('Notifications')}<span class="sub">${t('Message & call alerts, sounds')}</span></span></button>
        <button class="row" id="s-lang"><span class="ic">${ICON.globe}</span><span class="row-main">${t('App language')}<span class="sub">${lang() === 'hi' ? 'हिन्दी' : 'English'}</span></span></button>
        <button class="row" id="s-acct"><span class="ic">${ICON.key}</span><span class="row-main">${t('Account')}<span class="sub">${t('Password, devices, delete account')}</span></span></button>
        <button class="row" id="s-star"><span class="ic">${ICON.star}</span><span class="row-main">${t('Starred messages')}</span></button>
        ${S.me.role === 'admin' ? `<button class="row" id="s-admin"><span class="ic">${ICON.shield}</span><span class="row-main">${t('Admin panel')}<span class="sub">${t('Users, bans, reports, call servers')}</span></span></button>` : ''}
      </div>
      <div class="card"><button class="row" id="s-help"><span class="ic">${ICON.info}</span><span class="row-main">${t('Help & about')}</span></button>${isApp() ? '' : `<a class="row" href="/download"><span class="ic">${ICON.download}</span><span class="row-main">${t('Get the Android app')}</span></a>`}
      <button class="row danger" id="s-out"><span class="ic">${ICON.logout}</span><span class="row-main">${t('Log out')}</span></button></div>
      <p class="fine pad center">AverChat ${esc(S.config.version || '')}</p>`;
    const on = (id, fn) => { const n = $(id, d.body); if (n) n.onclick = fn; };
    on('#s-prof', () => profile(render)); on('#s-priv', () => privacy()); on('#s-chats', chatsSettings); on('#s-notif', notifSettings);
    on('#s-lang', () => sheet(t('App language'), [{ label: 'English', run: async () => { LS.set('lang', 'en'); await setSetting('lang', 'en'); location.reload(); } }, { label: 'हिन्दी (Hindi)', run: async () => { LS.set('lang', 'hi'); await setSetting('lang', 'hi'); location.reload(); } }]));
    on('#s-acct', account); on('#s-star', () => App.starred()); on('#s-admin', () => App.openAdmin()); on('#s-help', help);
    on('#s-out', async () => { if (await confirmBox(t('Log out of this app on this device?'), t('Log out'), true)) App.logout(); });
  };
  render();
};
function profile(after) {
  const d = App.openDrawer(t('Profile'), '');
  const render = () => {
    d.body.innerHTML = `<div class="info-top"><button class="bigav" id="p-av">${avatar(S.me, 140)}<span class="cam">${ICON.camera}</span></button><input type="file" accept="image/*" id="p-file" hidden></div>
      <div class="card"><button class="row" id="p-name"><span class="ic">${ICON.user}</span><span class="row-main"><span class="sub">${t('Name')}</span>${esc(S.me.name)}</span><span class="ic">${ICON.edit}</span></button>
      <button class="row" id="p-about"><span class="ic">${ICON.info}</span><span class="row-main"><span class="sub">${t('About')}</span>${esc(S.me.about || '')}</span><span class="ic">${ICON.edit}</span></button>
      <button class="row" id="p-email"><span class="ic">${ICON.globe}</span><span class="row-main"><span class="sub">${t('Email')}</span>${esc(S.me.email || t('Not added'))}</span><span class="ic">${ICON.edit}</span></button>
      <button class="row" id="p-phone"><span class="ic">${ICON.phone}</span><span class="row-main"><span class="sub">${t('Phone')}</span>${esc(S.me.phone || t('Not added'))}</span><span class="ic">${ICON.edit}</span></button>
      <div class="row"><span class="ic">@</span><span class="row-main"><span class="sub">${t('Username')}</span>${esc(S.me.username)}</span></div></div>
      <p class="fine pad">${t('People can find you by your username or phone number. Your phone number is only shown to people who saved you as a contact.')}</p>`;
    $('#p-av', d.body).onclick = () => sheet('', [{ icon: ICON.image, label: t('Choose photo'), run: () => $('#p-file', d.body).click() }, S.me.photo ? { icon: ICON.trash, label: t('Remove photo'), danger: true, run: async () => { await saveMe({ photo: null }); render(); after(); } } : null]);
    $('#p-file', d.body).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const sq = await App.squareImage(f, 512); const up = await upload(sq, 'avatar', 'avatar.jpg'); await saveMe({ photo: up.id }, t('Profile photo updated')); render(); after(); } catch (er) { toast(er.message); } };
    $('#p-name', d.body).onclick = async () => { const v = await prompt2(t('Your name'), { value: S.me.name, max: 50 }); if (v && v.trim()) { await saveMe({ name: v.trim() }); render(); after(); } };
    $('#p-about', d.body).onclick = async () => { const v = await prompt2(t('About'), { value: S.me.about || '', max: 140 }); if (v !== null) { await saveMe({ about: v }); render(); after(); } };
    $('#p-email', d.body).onclick = async () => { const v = await prompt2(t('Email'), { value: S.me.email || '', type: 'email', max: 200, placeholder: 'you@example.com' }); if (v !== null) { try { await saveMe({ email: v.trim() || null }); } catch (e) { return; } render(); after(); } };
    $('#p-phone', d.body).onclick = async () => { const v = await prompt2(t('Phone number'), { value: S.me.phone || '', type: 'tel', max: 16, placeholder: '+91…' }); if (v !== null) { await saveMe({ phone: v.trim() || null }); render(); after(); } };
  };
  render();
}
function privacy() {
  const d = App.openDrawer(t('Privacy'), '');
  const render = () => {
    const row = (k, label) => `<button class="row" data-p="${k}"><span class="row-main">${label}<span class="sub">${pv(S.me[k])}</span></span></button>`;
    d.body.innerHTML = `<div class="card"><div class="sect">${t('Who can see my personal info')}</div>${row('p_last_seen', t('Last seen and online'))}${row('p_photo', t('Profile photo'))}${row('p_about', t('About'))}${row('p_status', t('Status'))}
      <label class="row"><span class="row-main">${t('Read receipts')}<span class="sub">${t('If turned off, you won’t send or receive read receipts in 1:1 chats. Groups always show them.')}</span></span><input type="checkbox" id="pr-rr" ${S.me.read_receipts ? 'checked' : ''}></label></div>
      <div class="card"><button class="row" id="pr-blocked"><span class="ic">${ICON.block}</span><span class="row-main">${t('Blocked contacts')}</span></button>
      <button class="row" id="pr-pin"><span class="ic">${ICON.lock}</span><span class="row-main">${t('Chat lock PIN')}<span class="sub">${S.me.has_pin ? t('On — locked chats need this PIN') : t('Off')}</span></span></button></div>
      <p class="fine pad">${ICON.shield} ${t('Passwords are stored hashed and everything goes over HTTPS. 1:1 and group messages, photos, videos, voice notes and files are end-to-end encrypted on your phone; the server only stores locked data it can’t read. Your encryption key backup is locked with your password. Channels, status updates and messages from before the encryption update are not end-to-end encrypted. Calls are encrypted directly between the phones.')}</p>`;
    $$('[data-p]', d.body).forEach((b) => (b.onclick = () => { const k = b.dataset.p; sheet('', ['all', 'contacts', 'none'].map((v) => ({ label: (S.me[k] === v ? '✓ ' : '') + pv(v), run: async () => { await saveMe({ [k]: v }); render(); } }))); }));
    $('#pr-rr', d.body).onchange = (e) => saveMe({ read_receipts: e.target.checked });
    $('#pr-blocked', d.body).onclick = blocked; $('#pr-pin', d.body).onclick = async () => { await App.setPin(); render(); };
  };
  render();
}
App.setPin = async () => {
  const items = [{ label: S.me.has_pin ? t('Change PIN') : t('Set PIN'), run: async () => { const pin = await prompt2(t('New 4–6 digit PIN'), { type: 'password', max: 6 }); if (!pin) return; if (!/^\d{4,6}$/.test(pin)) return toast(t('PIN must be 4–6 digits')); const pw = await prompt2(t('Confirm with your account password'), { type: 'password', max: 100 }); if (!pw) return; try { await api('/api/me/pin', { body: { pin, password: pw } }); S.me.has_pin = true; toast(t('Chat lock PIN saved')); } catch (e) { toast(e.message); } } }];
  if (S.me.has_pin) items.push({ label: t('Turn off chat lock'), danger: true, run: async () => { const pw = await prompt2(t('Confirm with your account password'), { type: 'password', max: 100 }); if (!pw) return; try { await api('/api/me/pin', { body: { pin: null, password: pw } }); S.me.has_pin = false; S.unlocked = false; [...S.chats.values()].forEach((c) => (c.locked = false)); App.renderList(); toast(t('Chat lock turned off')); } catch (e) { toast(e.message); } } });
  await sheet(t('Chat lock PIN'), items);
};
async function blocked() {
  const d = App.openDrawer(t('Blocked contacts'), `<div class="loading">${t('Loading…')}</div>`);
  const render = async () => { const r = await api('/api/blocks'); d.body.innerHTML = `<div class="list">${r.users.map((u) => `<div class="row">${avatar(u, 40)}<span class="row-main"><b>${esc(u.name)}</b><span class="sub">@${esc(u.username)}</span></span><button class="btn sm ghost" data-u="${u.id}">${t('Unblock')}</button></div>`).join('') || `<div class="empty"><p>${t('No blocked contacts')}</p></div>`}</div>`; $$('[data-u]', d.body).forEach((b) => (b.onclick = async () => { await api(`/api/users/${b.dataset.u}/block`, { body: { on: false } }); const u = S.users.get(b.dataset.u); if (u) u.blocked = false; render(); })); };
  render().catch((e) => toast(e.message));
}
function chatsSettings() {
  const d = App.openDrawer(t('Chats'), '');
  const render = () => {
    const st = S.me.settings || {}; const th = st.theme || 'system';
    d.body.innerHTML = `<div class="card"><div class="sect">${t('Display')}</div>
      <button class="row" id="cs-theme"><span class="ic">${ICON.moon}</span><span class="row-main">${t('Theme')}<span class="sub">${App.brand().theme !== 'user' ? t('Set by the admin') : { system: t('System default'), light: t('Light'), dark: t('Dark') }[th]}</span></span></button>
      <button class="row" id="cs-wall"><span class="ic">${ICON.wall}</span><span class="row-main">${t('Default wallpaper')}<span class="sub">${esc(st.wallpaper || 'default')}</span></span></button>
      <button class="row" id="cs-font"><span class="ic">Aa</span><span class="row-main">${t('Font size')}<span class="sub">${{ small: t('Small'), normal: t('Medium'), large: t('Large') }[st.font || 'normal']}</span></span></button></div>
      <div class="card"><div class="sect">${t('Motion')}</div><label class="row"><span class="row-main">${t('Background video')}<span class="sub">${t('Turn off to save battery and data')}</span></span><input type="checkbox" id="cs-bgv" ${LS.get('bgvideo', true) !== false ? 'checked' : ''}></label>
      <label class="row"><span class="row-main">${t('Intro video on start')}</span><input type="checkbox" id="cs-intro" ${LS.get('intro', true) !== false ? 'checked' : ''}></label></div>
      <div class="card"><label class="row"><span class="row-main">${t('Enter key sends')}<span class="sub">${t('Press Enter to send (Shift+Enter for a new line)')}</span></span><input type="checkbox" id="cs-enter" ${(st.enter_send !== undefined ? st.enter_send : !('ontouchstart' in window)) ? 'checked' : ''}></label></div>`;
    $('#cs-theme', d.body).onclick = () => sheet(t('Theme'), ['system', 'light', 'dark'].map((v) => ({ label: { system: t('System default'), light: t('Light'), dark: t('Dark') }[v], run: async () => { LS.set('theme', v); await setSetting('theme', v); render(); } })));
    $('#cs-wall', d.body).onclick = () => App.wallpaperMenu(null);
    $('#cs-bgv', d.body).onchange = (e) => App.setBgVideoPref(e.target.checked);
    $('#cs-intro', d.body).onchange = (e) => LS.set('intro', e.target.checked);
    $('#cs-font', d.body).onclick = () => sheet(t('Font size'), ['small', 'normal', 'large'].map((v) => ({ label: { small: t('Small'), normal: t('Medium'), large: t('Large') }[v], run: async () => { await setSetting('font', v); render(); } })));
    $('#cs-enter', d.body).onchange = (e) => setSetting('enter_send', e.target.checked);
  };
  render();
}
function notifSettings() {
  const d = App.openDrawer(t('Notifications'), '');
  const N = App.nativeNotify && App.nativeNotify(); let ns = { instant: true, battery: true };
  if (N) { N.getState().then((r) => { ns = r; render(); }).catch(() => {}); document.addEventListener('visibilitychange', () => { if (!document.hidden && N) N.getState().then((r) => { ns = r; if (d.body.isConnected) render(); }).catch(() => {}); }); }
  const render = () => {
    const st = S.me.settings || {}; const perm = isApp() ? '' : ('Notification' in window ? Notification.permission : 'unsupported');
    d.body.innerHTML = `<div class="card"><button class="row" id="ns-perm"><span class="ic">${ICON.bell}</span><span class="row-main">${t('Allow notifications on this device')}<span class="sub">${perm === 'granted' ? t('Allowed') : perm === 'denied' ? t('Blocked in browser settings') : perm === 'unsupported' ? t('Not supported in this browser') : t('Tap to allow')}</span></span></button>
      <label class="row"><span class="row-main">${t('Sounds')}<span class="sub">${t('Play a sound for new messages while the app is open')}</span></span><input type="checkbox" id="ns-snd" ${st.sounds !== false ? 'checked' : ''}></label>
      <label class="row"><span class="row-main">${t('Show message preview')}</span><input type="checkbox" id="ns-prev" ${st.preview !== false ? 'checked' : ''}></label></div>
      ${N ? `<div class="card"><label class="row"><span class="row-main">${t('Instant notifications')}<span class="sub">${t('Messages arrive within seconds even when the app is closed. Shows a small “AverChat connected” notification (you can hide it in phone settings).')}</span></span><input type="checkbox" id="ns-inst" ${ns.instant ? 'checked' : ''}></label>
      <button class="row" id="ns-batt"><span class="ic">${ICON.settings}</span><span class="row-main">${t('Battery & autostart settings')}<span class="sub">${ns.battery ? t('Battery: unrestricted ✓') : t('Allow unrestricted battery so the phone does not stop AverChat')}</span></span></button></div>` : ''}
      <p class="fine pad">${ICON.info} ${N ? (ns.instant ? t('Instant notifications are on: new messages show up within seconds, even when AverChat is closed. Some phones (Vivo, Xiaomi, Oppo) still stop apps unless battery is set to unrestricted and autostart is on.') : t('Instant notifications are off: when AverChat is closed the phone checks for new messages about every 15 minutes.')) : t('Notifications arrive while AverChat is open or in the background. When the app or browser is fully closed, new messages show up the next time you open it.')}</p>`;
    const inst = $('#ns-inst', d.body); if (inst) inst.onchange = async (e) => { try { const r = await N.setInstant({ on: e.target.checked }); App.nativeInstant = !!r.instant; ns = r; } catch {} render(); };
    const batt = $('#ns-batt', d.body); if (batt) batt.onclick = () => { N.openSetup().catch(() => {}); };
    $('#ns-perm', d.body).onclick = async () => { const r = await App.notifPermission(); toast(r === 'granted' ? t('Notifications allowed') : t('Notifications not allowed')); render(); };
    $('#ns-snd', d.body).onchange = (e) => setSetting('sounds', e.target.checked); $('#ns-prev', d.body).onchange = (e) => setSetting('preview', e.target.checked);
  };
  render();
}
function account() {
  const d = App.openDrawer(t('Account'), `<div class="card"><button class="row" id="ac-pw"><span class="ic">${ICON.key}</span><span class="row-main">${t('Change password')}</span></button><button class="row" id="ac-dev"><span class="ic">${ICON.shield}</span><span class="row-main">${t('Logged-in devices')}</span></button><button class="row" id="ac-all"><span class="ic">${ICON.logout}</span><span class="row-main">${t('Log out all other devices')}</span></button>${S.me.role === 'admin' ? '' : `<button class="row danger" id="ac-del"><span class="ic">${ICON.trash}</span><span class="row-main">${t('Delete my account')}</span></button>`}</div>`);
  $('#ac-pw', d.body).onclick = async () => { const cur = await prompt2(t('Current password'), { type: 'password', max: 100 }); if (!cur) return; const nx = await prompt2(t('New password (at least 8 characters)'), { type: 'password', max: 100 }); if (!nx) return; const nx2 = await prompt2(t('Type the new password again'), { type: 'password', max: 100 }); if (nx !== nx2) return toast(t('Passwords don’t match')); try { await api('/api/me/password', { body: { current: cur, next: nx } }); toast(t('Password changed. Other devices were logged out.')); } catch (e) { toast(e.message); } };
  $('#ac-dev', d.body).onclick = async () => { try { const r = await api('/api/me/sessions'); openModal(`<div class="dlg"><h3>${t('Logged-in devices')}</h3><div class="list">${r.sessions.map((s) => `<div class="row"><span class="row-main"><b>${esc(uaName(s.ua))}${s.current ? ' · ' + t('this device') : ''}</b><span class="sub">${t('Last active')} ${fmtListTime(s.last_used)}</span></span></div>`).join('')}</div><div class="dlg-btns"><button class="btn" data-close>${t('Close')}</button></div></div>`); } catch (e) { toast(e.message); } };
  $('#ac-all', d.body).onclick = async () => { if (await confirmBox(t('Log out every other device?'), t('Log out'), true)) { await api('/api/me/logout-all', { body: {} }); toast(t('Done')); } };
  const del = $('#ac-del', d.body); if (del) del.onclick = async () => { if (!(await confirmBox(t('Delete your account? Your profile, contacts and status are removed and you leave all groups. This can’t be undone.'), t('Delete'), true))) return; const pw = await prompt2(t('Confirm with your account password'), { type: 'password', max: 100 }); if (!pw) return; try { await api('/api/me', { method: 'DELETE', body: { password: pw } }); location.href = '/'; } catch (e) { toast(e.message); } };
}
const uaName = (ua) => { ua = ua || ''; if (/AverChatApp|AverChatApp/.test(ua)) return 'AverChat Android app'; const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'; const o = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''; return b + (o ? ' · ' + o : ''); };
function help() {
  App.openDrawer(t('Help & about'), `<div class="pad"><div class="info-top"><img src="${App.logoUrl()}" width="96" alt=""><h2>${esc(App.brand().app_name)}</h2><p class="muted">${t('Version')} ${esc(S.config.version || '')}</p></div>
    <h3>${t('Tips')}</h3><ul class="tips"><li>${t('Tap and hold (or right-click) a message to reply, react, forward, star, pin, edit or delete it.')}</li><li>${t('Swipe a message to the right to reply.')}</li><li>${t('Tap the microphone to record a voice message; tap send when done.')}</li><li>${t('Format text: *bold*, _italic_, ~strikethrough~.')}</li><li>${t('Lock a chat with a PIN from the chat menu.')}</li></ul>
    <h3>${t('Privacy & security')}</h3><p class="muted">${t('Passwords are stored as salted hashes. Every connection uses HTTPS. 1:1 and group chats are end-to-end encrypted (only chat members can read them, not the server or admin). Channels, status updates and older messages from before the update are not end-to-end encrypted.')}</p>
    <h3>${t('Limits')}</h3><p class="muted">${t('Files up to 50 MB. Groups up to 256 members. Calls are one-to-one.')}</p></div>`);
}

// ---------- admin ----------
App.admin = async () => {
  if (S.me.role !== 'admin') return;
  const d = App.openDrawer(t('Admin panel'), `<div class="seg pad"><button class="on" data-k="stats">${t('Overview')}</button><button data-k="users">${t('Users')}</button><button data-k="reports">${t('Reports')}</button><button data-k="settings">${t('Settings')}</button></div><div id="adm"></div>`, { wide: true });
  const box = $('#adm', d.body);
  const show = async (k) => {
    $$('.seg button', d.body).forEach((b) => b.classList.toggle('on', b.dataset.k === k)); box.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
    try {
      if (k === 'stats') { const s = await api('/api/admin/stats'); const card = (n, l) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`; box.innerHTML = `<div class="stats">${card(s.users, t('Users'))}${card(s.new_users_24h, t('New in 24 h'))}${card(s.active_24h, t('Active in 24 h'))}${card(s.messages, t('Messages'))}${card(s.messages_24h, t('Messages in 24 h'))}${card(s.direct_chats, t('1:1 chats'))}${card(s.groups, t('Groups'))}${card(s.calls, t('Calls'))}${card(s.files + ' · ' + fmtSize(s.file_bytes), t('Files stored'))}${card(s.live_statuses, t('Live statuses'))}${card(s.open_reports, t('Open reports'))}</div>`; }
      if (k === 'users') { box.innerHTML = `<div class="searchrow"><input id="aq" placeholder="${t('Search users')}"></div><div id="aul"></div>`; const load = async () => { const r = await api('/api/admin/users?q=' + encodeURIComponent($('#aq', box).value.trim())); $('#aul', box).innerHTML = `<table class="tbl"><tr><th>${t('User')}</th><th>${t('Phone')}</th><th>${t('Joined')}</th><th>${t('Last seen')}</th><th>${t('Msgs')}</th><th>${t('Reports')}</th><th></th></tr>${r.users.map((u) => `<tr class="${u.banned ? 'banned' : ''}"><td><b>${esc(u.name)}</b><br><span class="sub">@${esc(u.username)}${u.role === 'admin' ? ' · admin' : ''}${u.deleted ? ' · ' + t('deleted') : ''}</span></td><td>${esc(u.phone || '')}</td><td>${fmtListTime(u.created_at)}</td><td>${fmtListTime(u.last_seen)}</td><td>${u.msgs}</td><td>${u.reports}</td><td>${u.role === 'admin' || u.deleted ? '' : `<button class="btn sm ${u.banned ? 'ghost' : 'danger'}" data-ban="${u.id}" data-on="${u.banned ? 0 : 1}">${u.banned ? t('Unban') : t('Ban')}</button>`}</td></tr>`).join('')}</table>`; $$('[data-ban]', box).forEach((b) => (b.onclick = async () => { const on = b.dataset.on === '1'; if (on && !(await confirmBox(t('Ban this user? They are logged out and can’t log in again until unbanned.'), t('Ban'), true))) return; await api(`/api/admin/users/${b.dataset.ban}/ban`, { body: { on } }); load(); })); }; let tm; $('#aq', box).oninput = () => { clearTimeout(tm); tm = setTimeout(load, 300); }; await load(); }
      if (k === 'reports') { const r = await api('/api/admin/reports'); box.innerHTML = `<div class="list">${r.reports.map((x) => `<div class="row ${x.resolved ? 'muted' : ''}"><span class="row-main"><b>@${esc(x.target || '?')}</b> ${t('reported by')} @${esc(x.reporter || '?')}<span class="sub">${esc(x.reason || '')} · ${fmtListTime(x.created_at)}</span></span>${x.resolved ? `<span class="tag">${t('Resolved')}</span>` : `<button class="btn sm ghost" data-res="${x.id}">${t('Resolve')}</button>`}</div>`).join('') || `<div class="empty"><p>${t('No reports')}</p></div>`}</div>`; $$('[data-res]', box).forEach((b) => (b.onclick = async () => { await api(`/api/admin/reports/${b.dataset.res}/resolve`, { body: {} }); show('reports'); })); }
      if (k === 'settings') { const s = await api('/api/admin/settings'); box.innerHTML = `<form class="form pad" id="asf"><h3>${t('Announcement')}</h3><textarea class="inp" name="ann" maxlength="300" rows="2" placeholder="${t('Shown at the top of everyone’s chat list')}">${esc(s.public.announcement || '')}</textarea>
        <label class="chkrow"><input type="checkbox" name="open" ${s.public.signup_open !== false ? 'checked' : ''}> ${t('Allow new sign-ups')}</label>
        <h3>${t('Call relay (TURN) server')}</h3><p class="fine">${t('Calls first try a direct connection (STUN). On strict mobile networks a TURN relay is needed. Paste a TURN server you own or rent here (e.g. turn:turn.example.com:3478).')}</p>
        <input class="inp" name="turl" placeholder="turn:host:3478, turns:host:5349" value="${esc((s.turn.urls || []).join(', '))}"><input class="inp" name="tuser" placeholder="${t('Username')}" value="${esc(s.turn.username || '')}"><input class="inp" name="tcred" placeholder="${t('Password / credential')}" value="${esc(s.turn.credential || '')}">
        <button class="btn">${t('Save')}</button></form>`; $('#asf', box).onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await api('/api/admin/settings', { body: { public: { announcement: f.ann.value, signup_open: f.open.checked }, turn: { urls: f.turl.value, username: f.tuser.value, credential: f.tcred.value } } }); toast(t('Saved')); } catch (er) { toast(er.message); } }; }
    } catch (e) { box.innerHTML = `<p class="pad">${esc(e.message)}</p>`; }
  };
  $$('.seg button', d.body).forEach((b) => (b.onclick = () => show(b.dataset.k))); show('stats');
};
App.settingsPages = { profile, privacy, chatsSettings, notifSettings, account, help, blocked };
