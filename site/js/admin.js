// AverChat Admin — runs in the browser at /admin and inside the Windows admin app.
const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: { 'x-avm': '1' }, credentials: 'same-origin' };
  if (opts.body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch(path, o); let d = null; try { d = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((d && d.error) || 'Request failed (' + r.status + ')'); e.status = r.status; throw e; } return d;
}
function upload(file, onProg) {
  return new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('POST', `/api/upload?scope=brand&name=${encodeURIComponent(file.name)}`); x.setRequestHeader('x-avm', '1'); x.setRequestHeader('content-type', file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProg && onProg(e.loaded / e.total);
    x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 && d ? res(d.file) : rej(new Error((d && d.error) || 'Upload failed')); }; x.onerror = () => rej(new Error('Upload failed — check the connection')); x.send(file); });
}
const toast = (m) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); };
const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const ago = (ms) => { if (!ms) return '—'; const s = (Date.now() - ms) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; };
const PRESETS = {
  purple: { label: 'Purple (default)', theme: 'dark', accent: '#7c3aed', accent2: '#d946ef', bg: '#0c0718', panel: '#1a1130', text: '#f3eefe', bubble_out: '#6d28d9', bubble_in: '#241a3d' },
  blue: { label: 'Ocean blue', theme: 'dark', accent: '#2563eb', accent2: '#06b6d4', bg: '#07111f', panel: '#0f1d33', text: '#eaf2ff', bubble_out: '#1d4ed8', bubble_in: '#16263f' },
  green: { label: 'Emerald green', theme: 'dark', accent: '#059669', accent2: '#84cc16', bg: '#06140f', panel: '#0e2219', text: '#eafff5', bubble_out: '#047857', bubble_in: '#13291f' },
  rose: { label: 'Rose sunset', theme: 'dark', accent: '#e11d48', accent2: '#f97316', bg: '#160709', panel: '#2a0f15', text: '#fff0f2', bubble_out: '#be123c', bubble_in: '#33161c' },
  midnight: { label: 'Midnight dark', theme: 'dark', accent: '#6366f1', accent2: '#a855f7', bg: '#000000', panel: '#111111', text: '#f5f5f5', bubble_out: '#3730a3', bubble_in: '#1c1c1c' },
  light: { label: 'Classic light', theme: 'light', accent: '#7c3aed', accent2: '#d946ef', bg: '#f5f3ff', panel: '#ffffff', text: '#1e1b4b', bubble_out: '#ede9fe', bubble_in: '#ffffff' },
  sky: { label: 'Sky light', theme: 'light', accent: '#0284c7', accent2: '#22d3ee', bg: '#f0f9ff', panel: '#ffffff', text: '#0c1a2b', bubble_out: '#e0f2fe', bubble_in: '#ffffff' },
};
const COLORS = [['accent', 'Primary'], ['accent2', 'Accent'], ['bg', 'Background'], ['panel', 'Cards / panels'], ['text', 'Text'], ['bubble_out', 'My bubbles'], ['bubble_in', 'Their bubbles']];
const FONT_NAMES = { system: 'System default', poppins: 'Poppins', inter: 'Inter', nunito: 'Nunito (rounded)', baloo: 'Baloo 2 (Hindi friendly)', serif: 'Serif', mono: 'Monospace' };
const LAYOUT_NAMES = { glass: 'Glass (see-through cards over the video)', solid: 'Solid (flat, full-width bottom bar)', compact: 'Compact (more chats on screen)' };
const VIDEO_NAMES = { intro: 'Intro glow', aurora: 'Aurora', particles: 'Particles', waves: 'Waves', nebula: 'Nebula' };
const vurl = (v) => (!v || v === 'none' ? '' : v.startsWith('default:') ? `/media/${v.slice(8)}.mp4` : `/api/brand/${v.slice(5)}`);
let ME = null, BR = null, META = null, TAB = 'dash';

async function boot() {
  try { const r = await api('/api/me'); ME = r.user; if (ME.role !== 'admin') return login('This account is not the admin. Log in with the admin account.'); shell(); }
  catch (e) { login(); }
}
function login(msg = '') {
  $('#root').innerHTML = `<div class="login"><div class="lcard"><img src="/icons/icon-192.png" alt=""><h1>AverChat Admin</h1><div class="sub">Control panel</div>
    <form id="lf"><label class="f">Admin username<input name="id" required autocomplete="username" value="admin"></label><label class="f">Password<input name="password" type="password" required autocomplete="current-password"></label><div class="err" id="le">${esc(msg)}</div><button class="btn">Log in</button></form></div></div>`;
  $('#lf').onsubmit = async (e) => { e.preventDefault(); const f = e.target; $('#le').textContent = ''; try { const r = await api('/api/auth/login', { body: { id: f.id.value, password: f.password.value } }); if (r.user.role !== 'admin') { await api('/api/auth/logout', { body: {} }).catch(() => {}); return ($('#le').textContent = 'This account is not the admin.'); } ME = r.user; shell(); } catch (er) { $('#le').textContent = er.message; } };
}
function shell() {
  const tabs = [['dash', '📊 Dashboard'], ['users', '👥 Users'], ['look', '🎨 Theme & colours'], ['brand', '🏷️ Name, logo & font'], ['videos', '🎬 Videos'], ['security', '🔒 Screenshots & sign-up'], ['announce', '📣 Announcement'], ['reports', '🚩 Reports'], ['calls', '📞 Call servers']];
  $('#root').innerHTML = `<div class="app"><nav><div class="brand"><img id="nlogo" src="/icons/icon-192.png" alt=""><span id="nname">AverChat</span></div>${tabs.map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}<div class="sp"></div><button id="lo">↩ Log out</button></nav><main id="m"></main></div>`;
  $$('nav button[data-t]').forEach((b) => (b.onclick = () => go(b.dataset.t))); $('#lo').onclick = async () => { await api('/api/auth/logout', { body: {} }).catch(() => {}); location.reload(); };
  loadBrand().then(() => go(TAB));
}
async function loadBrand() { const r = await api('/api/admin/brand'); BR = r.brand; META = r; $('#nname').textContent = BR.app_name + ' Admin'; $('#nlogo').src = BR.logo ? '/api/brand/' + BR.logo : '/icons/icon-192.png'; }
async function saveBrand(patch, msg = 'Saved — users see it on their next refresh') { try { const r = await api('/api/admin/brand', { body: patch }); BR = r.brand; toast(msg); $('#nname').textContent = BR.app_name + ' Admin'; $('#nlogo').src = BR.logo ? '/api/brand/' + BR.logo : '/icons/icon-192.png'; return true; } catch (e) { toast(e.message); return false; } }
function go(t) { TAB = t; $$('nav button[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t)); const m = $('#m'); m.innerHTML = '<p class="sub">Loading…</p>'; ({ dash, users, look, brand, videos, security, announce, reports, calls })[t](m).catch((e) => { if (e.status === 401 || e.status === 403) login('Please log in again.'); else m.innerHTML = `<p class="err">${esc(e.message)}</p>`; }); }

async function dash(m) {
  const s = await api('/api/admin/stats');
  const c = (n, l) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`;
  m.innerHTML = `<h2>Dashboard</h2><div class="sub">Live numbers from the server. 1:1 and group chats are end-to-end encrypted: this panel (and the server) can't read message contents.</div><div class="cards">${c(s.online_now, '🟢 Online now')}${c(s.users, 'Total users')}${c(s.new_users_24h, 'New users (24 h)')}${c(s.active_24h, 'Active (24 h)')}${c(s.messages, 'Messages')}${c(s.encrypted_messages ?? 0, '🔒 End-to-end encrypted messages')}${c(s.users_with_encryption ?? 0, '🔒 Users with encryption on')}${c(s.messages_24h, 'Messages (24 h)')}${c(s.groups, 'Groups & channels')}${c(s.direct_chats, '1:1 chats')}${c(s.calls, 'Calls')}${c(s.live_statuses, 'Live statuses')}${c((s.file_bytes / 1048576).toFixed(1) + ' MB', s.files + ' files stored')}${c(s.open_reports, 'Open reports')}</div>
    <div class="box"><h3>Online now</h3><div id="onl" class="sub">Loading…</div></div>`;
  const r = await api('/api/admin/users?online=1'); const on = r.users.filter((u) => u.online);
  $('#onl').innerHTML = on.length ? on.map((u) => `<span class="tag"><span class="dot on"></span>${esc(u.name)} @${esc(u.username)}</span>`).join(' ') : 'Nobody is online right now.';
}
async function users(m) {
  m.innerHTML = `<h2>Users</h2><div class="note">🔐 Passwords are stored only as a one-way encrypted hash — nobody (not even the admin) can read them. To help someone, use <b>Set new password</b> and tell them the new one.</div>
    <div class="row" style="margin:14px 0"><input id="q" placeholder="Search name, username, phone or email" style="max-width:360px"><span class="sub" id="cnt"></span><button class="btn ghost sm" id="csv">⬇ Export CSV</button></div><div class="tw" id="tw"></div>`;
  let rows = [];
  const load = async () => { const r = await api('/api/admin/users?q=' + encodeURIComponent($('#q').value.trim())); rows = r.users; render(); };
  const render = () => {
    $('#cnt').textContent = rows.length + ' user(s)';
    $('#tw').innerHTML = `<table><tr><th>Name</th><th>Username</th><th>Phone</th><th>Email</th><th>Joined</th><th>Last seen</th><th>Msgs</th><th>Password</th><th>Actions</th></tr>${rows.map((u) => `<tr data-id="${u.id}"><td><span class="dot ${u.online ? 'on' : ''}"></span>${esc(u.name)}${u.e2e ? ' <span title="End-to-end encryption on">🔒</span>' : ''} ${u.role === 'admin' ? '<span class="tag">admin</span>' : ''}${u.banned ? ' <span class="tag bad">banned</span>' : ''}</td><td>@${esc(u.username)}</td><td>${esc(u.phone || '—')}</td><td>${esc(u.email || '—')}</td><td>${fmt(u.created_at)}</td><td>${u.online ? 'online' : ago(u.last_seen)}</td><td>${u.msgs}</td><td><span class="sub">•••••• (hashed)</span></td>
      <td><div class="row">${u.role === 'admin' ? '' : `<button class="btn ghost sm" data-a="pw">Set new password</button><button class="btn ghost sm" data-a="ban">${u.banned ? 'Unban' : 'Ban'}</button><button class="btn bad sm" data-a="del">Delete</button>`}</div></td></tr>`).join('')}</table>`;
    $$('[data-a]', $('#tw')).forEach((b) => (b.onclick = () => act(b.dataset.a, rows.find((x) => x.id === b.closest('tr').dataset.id))));
  };
  const act = async (a, u) => {
    if (a === 'pw') { if (u.e2e && !confirm(`@${u.username} uses end-to-end encryption. Their encryption key backup is locked with their OLD password, so after a reset their earlier encrypted messages will not open on a new or reinstalled phone (a phone that is still logged in keeps working). Continue?`)) return; const p = prompt(`New password for @${u.username} (at least 8 characters):`); if (!p) return; if (p.length < 8) return toast('At least 8 characters'); try { await api(`/api/admin/users/${u.id}/password`, { body: { password: p } }); toast('Password changed. Their other devices were logged out.'); } catch (e) { toast(e.message); } }
    if (a === 'ban') { try { await api(`/api/admin/users/${u.id}/ban`, { body: { on: !u.banned } }); toast(u.banned ? 'Unbanned' : 'Banned and logged out'); load(); } catch (e) { toast(e.message); } }
    if (a === 'del') { if (!confirm(`Delete @${u.username} (${u.name})?\n\nTheir account, messages, status, photos and files are removed. This cannot be undone.`)) return; try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('User deleted'); load(); } catch (e) { toast(e.message); } }
  };
  $('#csv').onclick = () => { const head = ['name', 'username', 'phone', 'email', 'joined', 'last_seen', 'banned']; const lines = [head.join(',')].concat(rows.map((u) => [u.name, u.username, u.phone || '', u.email || '', new Date(u.created_at).toISOString(), u.last_seen ? new Date(u.last_seen).toISOString() : '', u.banned ? 'yes' : 'no'].map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(','))); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'averchat-users.csv'; a.click(); };
  let tm; $('#q').oninput = () => { clearTimeout(tm); tm = setTimeout(load, 300); }; await load();
}
function previewHtml(b) {
  const light = b.theme === 'light'; const ink = (h) => { const n = parseInt(h.slice(1), 16); const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.6 ? '#16122a' : '#fff'; };
  const g = `linear-gradient(135deg,${b.accent},${b.accent2})`;
  return `<div class="preview" style="background:${b.bg};color:${b.text}"><div class="pv-bg" style="background:radial-gradient(circle at 30% 10%,${b.accent}55,transparent 60%),radial-gradient(circle at 90% 90%,${b.accent2}44,transparent 60%)"></div>
    <div class="pv-bar"><img src="${b.logo ? '/api/brand/' + b.logo : '/icons/icon-192.png'}">${esc(b.app_name)}</div>
    <div class="pv-chips"><span style="background:${g};color:#fff">All</span><span style="background:${b.panel};border:1px solid ${b.text}22">Personal</span><span style="background:${b.panel};border:1px solid ${b.text}22">Groups</span></div>
    ${['Rahul', 'Family group', 'Priya'].map((n, i) => `<div class="pv-row" style="background:${b.panel}${b.layout === 'glass' ? 'cc' : ''}"><i style="background:${g}"></i><div><b>${n}</b><div style="opacity:.6">${['Kal milte hain 👍', 'Photo', 'Voice message'][i]}</div></div></div>`).join('')}
    <div class="pv-b" style="background:${b.bubble_in};color:${ink(b.bubble_in)};border-radius:${b.bubble === 'square' ? 6 : 14}px">Hi! Kaise ho?</div>
    <div class="pv-b" style="background:${b.bubble_out};color:${ink(b.bubble_out)};margin-left:auto;border-radius:${b.bubble === 'square' ? 6 : 14}px;width:max-content">Badhiya 😄</div>
    <div class="pv-nav" style="background:${b.panel};border:1px solid ${b.text}22"><span>Chats</span><span>Calls</span><span class="pv-plus" style="background:${g}"></span><span>Groups</span><span>Me</span></div></div>`;
}
async function look(m) {
  let d = { ...BR };
  const render = () => {
    m.innerHTML = `<h2>Theme & colours</h2><div class="sub">Pick a ready theme or set every colour yourself. Changes reach every user's app live (within seconds) or on next open.</div>
    <div class="row" style="align-items:flex-start;gap:24px;margin-top:14px"><div style="flex:1;min-width:300px">
      <div class="box"><h3>Ready themes</h3><div class="presets">${Object.entries(PRESETS).map(([k, p]) => `<button class="preset ${d.preset === k ? 'on' : ''}" data-p="${k}"><i style="background:linear-gradient(135deg,${p.bg} 0 40%,${p.accent} 40% 70%,${p.accent2} 70%)"></i>${p.label}</button>`).join('')}</div></div>
      <div class="box"><h3>Custom colours</h3><div class="colors">${COLORS.map(([k, l]) => `<label><input type="color" data-c="${k}" value="${d[k]}"> ${l}</label>`).join('')}</div></div>
      <div class="box"><h3>Mode, layout & bubbles</h3><div class="grid2">
        <label class="f">Light / dark mode<select id="theme"><option value="dark">Dark (everyone)</option><option value="light">Light (everyone)</option><option value="user">Let each user choose</option></select></label>
        <label class="f">Layout<select id="layout">${Object.entries(LAYOUT_NAMES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="f">Message bubbles<select id="bubble"><option value="round">Rounded</option><option value="square">Square</option></select></label></div></div>
      <div class="row"><button class="btn" id="save">Save & apply to all users</button><button class="btn ghost" id="reset">Reset everything to default</button></div>
    </div><div><div class="sub" style="margin-bottom:8px">Preview</div><div id="pv">${previewHtml(d)}</div></div></div>`;
    $('#theme').value = d.theme; $('#layout').value = d.layout; $('#bubble').value = d.bubble;
    const upd = () => ($('#pv').innerHTML = previewHtml(d));
    $$('[data-p]').forEach((b) => (b.onclick = () => { const p = PRESETS[b.dataset.p]; const { label, ...rest } = p; d = { ...d, ...rest, preset: b.dataset.p }; render(); }));
    $$('[data-c]').forEach((i) => (i.oninput = () => { d[i.dataset.c] = i.value; d.preset = 'custom'; $$('.preset').forEach((x) => x.classList.remove('on')); upd(); }));
    $('#theme').onchange = (e) => { d.theme = e.target.value; upd(); }; $('#layout').onchange = (e) => { d.layout = e.target.value; upd(); }; $('#bubble').onchange = (e) => { d.bubble = e.target.value; upd(); };
    $('#save').onclick = async () => { const patch = { preset: d.preset, theme: d.theme, layout: d.layout, bubble: d.bubble }; for (const [k] of COLORS) patch[k] = d[k]; await saveBrand(patch); };
    $('#reset').onclick = async () => { if (!confirm('Reset name, logo, colours, font, layout and videos to the AverChat defaults?')) return; await api('/api/admin/brand', { body: { reset: true } }); await loadBrand(); d = { ...BR }; render(); toast('Reset to defaults'); };
  };
  render();
}
async function brand(m) {
  m.innerHTML = `<h2>Name, logo & font</h2><div class="sub">What users see inside the app.</div>
    <div class="box"><div class="grid2"><label class="f">App name<input id="an" maxlength="30" value="${esc(BR.app_name)}"></label><label class="f">Tagline (login & intro screen)<input id="tg" maxlength="80" value="${esc(BR.tagline || '')}"></label>
      <label class="f">Font<select id="fn">${META.fonts.map((f) => `<option value="${f}">${FONT_NAMES[f] || f}</option>`).join('')}</select></label></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="sv">Save</button></div></div>
    <div class="box"><h3>Logo shown inside the app</h3><div class="row"><img id="lg" src="${BR.logo ? '/api/brand/' + BR.logo : '/icons/icon-192.png'}" style="width:84px;height:84px;border-radius:22px;object-fit:cover;background:#000"><div><input type="file" id="lf" accept="image/png,image/jpeg,image/webp"><div class="sub">Square PNG/JPG, 512×512 or bigger works best.</div><div class="row" style="margin-top:8px"><button class="btn ghost sm" id="lr">Use default logo</button></div></div></div></div>
    <div class="note">ℹ️ The <b>home-screen icon and the name under it</b> on Android come from the installed app file and can't be changed from a server — Android doesn't allow that. The name and logo <b>inside</b> the app (header, login, intro, notifications title) change from here.</div>`;
  $('#fn').value = BR.font;
  $('#sv').onclick = () => saveBrand({ app_name: $('#an').value, tagline: $('#tg').value, font: $('#fn').value });
  $('#lf').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { toast('Uploading…'); const up = await upload(f); if (await saveBrand({ logo: up.id }, 'Logo updated')) $('#lg').src = '/api/brand/' + up.id; } catch (er) { toast(er.message); } };
  $('#lr').onclick = async () => { if (await saveBrand({ logo: null }, 'Default logo restored')) $('#lg').src = '/icons/icon-192.png'; };
}
async function videos(m) {
  const files = (await api('/api/admin/brand/files')).files.filter((f) => /^video\//.test(f.mime));
  const opts = [...META.videos.map((v) => ({ v: 'default:' + v, label: VIDEO_NAMES[v] || v })), ...files.map((f) => ({ v: 'file:' + f.id, label: f.name, id: f.id }))];
  const card = (o, cur, key) => `<div class="vid ${cur === o.v ? 'on' : ''}" data-k="${key}" data-v="${o.v}"><video src="${vurl(o.v)}" muted loop playsinline preload="metadata"></video><div>${esc(o.label)}</div>${o.id ? `<button class="x" data-del="${o.id}">delete</button>` : ''}</div>`;
  const none = (cur, key) => `<div class="vid ${cur === 'none' ? 'on' : ''}" data-k="${key}" data-v="none"><div style="height:180px;display:flex;align-items:center;justify-content:center;background:#000">No video</div><div>None</div></div>`;
  m.innerHTML = `<h2>Videos</h2><div class="sub">Intro video plays for a few seconds when the app opens. The background video loops softly behind the app. Users can turn the background video off for themselves (battery/data).</div>
    <div class="box"><h3>Intro video (on app open)</h3><label class="row"><input type="checkbox" id="ie" ${BR.intro_enabled ? 'checked' : ''}> Play an intro video when the app opens</label><div class="vids" style="margin-top:10px">${opts.map((o) => card(o, BR.intro_video, 'intro_video')).join('')}${none(BR.intro_video, 'intro_video')}</div></div>
    <div class="box"><h3>Background video</h3><div class="vids">${opts.map((o) => card(o, BR.bg_video, 'bg_video')).join('')}${none(BR.bg_video, 'bg_video')}</div>
      <label class="f" style="margin-top:12px;max-width:320px">Darken the video so text stays readable: <b id="dv">${Math.round(BR.bg_dim * 100)}%</b><input type="range" id="dim" min="0" max="90" value="${Math.round(BR.bg_dim * 100)}"></label></div>
    <div class="box"><h3>Upload your own video</h3><input type="file" id="vf" accept="video/mp4,video/webm"><div class="sub">MP4 or WebM. Keep it short (5–15 s) and small (under 5 MB) so the app stays smooth. Portrait 9:16 looks best on phones.</div><div id="vp" class="sub"></div></div>`;
  $$('.vid video').forEach((v) => { v.onmouseenter = () => v.play().catch(() => {}); v.onmouseleave = () => v.pause(); v.ontouchstart = () => v.play().catch(() => {}); });
  $$('.vid[data-v]').forEach((c) => (c.onclick = async (e) => { if (e.target.dataset.del) return; if (await saveBrand({ [c.dataset.k]: c.dataset.v }, 'Video saved')) videos(m); }));
  $$('[data-del]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); if (!confirm('Delete this uploaded video?')) return; try { await api('/api/admin/brand/files/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); videos(m); } catch (er) { toast(er.message); } }));
  $('#ie').onchange = (e) => saveBrand({ intro_enabled: e.target.checked });
  $('#dim').oninput = (e) => ($('#dv').textContent = e.target.value + '%'); $('#dim').onchange = (e) => saveBrand({ bg_dim: +e.target.value / 100 });
  $('#vf').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 50 * 1048576) return toast('Max 50 MB'); try { const up = await upload(f, (p) => ($('#vp').textContent = 'Uploading… ' + Math.round(p * 100) + '%')); $('#vp').textContent = 'Uploaded. Pick it above as intro or background.'; toast('Video uploaded'); videos(m); } catch (er) { toast(er.message); } };
}
async function security(m) {
  const s = await api('/api/admin/settings');
  m.innerHTML = `<h2>Screenshots & sign-up</h2>
    <div class="box"><h3>Screenshots</h3><label class="row"><input type="checkbox" id="ss" ${BR.screenshots !== false ? 'checked' : ''}> Allow users to take screenshots and screen recordings in the Android app</label>
      <div class="sub" style="margin-top:8px">When off, the Android app blocks screenshots and screen recording (and hides the app preview in the recent-apps list). It applies as soon as each phone gets the change (live, or on next open). Browsers can't block screenshots — this works in the Android app only.</div></div>
    <div class="box"><h3>New accounts</h3><label class="row"><input type="checkbox" id="so" ${s.public.signup_open !== false ? 'checked' : ''}> Allow new people to create accounts</label><div class="sub" style="margin-top:8px">New accounts must give a phone number. Old accounts made before the phone rule keep working without one.</div></div>`;
  $('#ss').onchange = (e) => saveBrand({ screenshots: e.target.checked }, e.target.checked ? 'Screenshots allowed' : 'Screenshots blocked in the app');
  $('#so').onchange = async (e) => { try { await api('/api/admin/settings', { body: { public: { ...s.public, signup_open: e.target.checked } } }); s.public.signup_open = e.target.checked; toast('Saved'); } catch (er) { toast(er.message); } };
}
async function announce(m) {
  const s = await api('/api/admin/settings');
  m.innerHTML = `<h2>Announcement</h2><div class="sub">A banner at the top of everyone's chat list (they can dismiss it). Leave empty to remove.</div>
    <div class="box"><textarea id="at" rows="3" maxlength="300" placeholder="e.g. New update is live — download from the website">${esc(s.public.announcement || '')}</textarea><div class="row" style="margin-top:10px"><button class="btn" id="as">Publish</button><button class="btn ghost" id="ac">Remove</button></div></div>`;
  const save = async (text) => { try { await api('/api/admin/announce', { body: { text } }); toast(text ? 'Announcement published' : 'Announcement removed'); } catch (e) { toast(e.message); } };
  $('#as').onclick = () => save($('#at').value.trim()); $('#ac').onclick = () => { $('#at').value = ''; save(''); };
}
async function reports(m) {
  const r = await api('/api/admin/reports');
  m.innerHTML = `<h2>Reports</h2><div class="tw"><table><tr><th>When</th><th>Reporter</th><th>Reported</th><th>Reason</th><th></th></tr>${r.reports.map((x) => `<tr><td>${fmt(x.created_at)}</td><td>@${esc(x.reporter || '?')}</td><td>@${esc(x.target || '—')}</td><td>${esc(x.reason || '')}</td><td>${x.resolved ? '<span class="tag">resolved</span>' : `<button class="btn ghost sm" data-r="${x.id}">Mark resolved</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="sub">No reports.</td></tr>'}</table></div>`;
  $$('[data-r]').forEach((b) => (b.onclick = async () => { await api(`/api/admin/reports/${b.dataset.r}/resolve`, { body: {} }); reports(m); }));
}
async function calls(m) {
  const s = await api('/api/admin/settings');
  m.innerHTML = `<h2>Call servers</h2><div class="sub">Calls connect directly between phones. On some mobile networks a relay (TURN) server is needed; add one here if calls fail to connect.</div>
    <div class="box"><label class="f">TURN/STUN URLs (one per line)<textarea id="tu" rows="3">${esc((s.turn.urls || []).join('\n'))}</textarea></label><div class="grid2" style="margin-top:10px"><label class="f">Username<input id="tn" value="${esc(s.turn.username || '')}"></label><label class="f">Credential<input id="tc" value="${esc(s.turn.credential || '')}"></label></div><div class="row" style="margin-top:10px"><button class="btn" id="ts">Save</button></div></div>`;
  $('#ts').onclick = async () => { try { await api('/api/admin/settings', { body: { turn: { urls: $('#tu').value, username: $('#tn').value, credential: $('#tc').value } } }); toast('Saved'); } catch (e) { toast(e.message); } };
}
boot();
