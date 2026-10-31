// AverChat — v2 screens: Groups tab, Me tab, status strip, channels, invite links, location & contact sharing.
import { App, S, LS, t, $, $$, esc, api, toast, avatar, ICON, fmtListTime, chatTitle, chatAvatarObj, sheet, confirmBox, openModal, prompt2, uid, isApp, plug } from './util.js';

const sv = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
Object.assign(ICON, {
  loc: sv('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0119 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  link: sv('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  channel: sv('<path d="M3 10v4a1 1 0 001 1h2l5 4V5L6 9H4a1 1 0 00-1 1z"/><path d="M15 9a4 4 0 010 6M18 6a8 8 0 010 12"/>'),
});
ICON.pin2 = ICON.loc;

// ---------- status strip on the Chats tab ----------
App.renderStrip = () => {
  const box = $('#strip'); if (!box || !App.statusData) return;
  const data = App.statusData(); const by = new Map();
  for (const s of data.statuses || []) { if (!by.has(s.user_id)) by.set(s.user_id, []); by.get(s.user_id).push(s); }
  const mine = by.get(S.me.id) || []; by.delete(S.me.id);
  const others = [...by.entries()].map(([u, list]) => ({ u, list, unseen: list.some((x) => !x.seen), last: list[list.length - 1].created_at })).sort((a, b) => (b.unseen - a.unseen) || (b.last - a.last)).slice(0, 20);
  box.innerHTML = `<button class="sti" data-me="1"><span class="sring ${mine.length ? 'seen' : 'add'}">${avatar(S.me, 54)}${mine.length ? '' : `<i class="splus">${ICON.plus}</i>`}</span><span>${t('My status')}</span></button>` +
    others.map((g) => { const u = S.users.get(g.u) || { id: g.u, name: '?' }; return `<button class="sti" data-u="${g.u}"><span class="sring ${g.unseen ? 'new' : 'seen'}">${avatar(u, 54)}</span><span>${esc((u.name || '').split(' ')[0])}</span></button>`; }).join('') +
    `<button class="sti more" data-all="1"><span class="sring seen"><span class="av" style="width:54px;height:54px;display:flex;align-items:center;justify-content:center">${ICON.status}</span></span><span>${t('All')}</span></button>`;
  box.querySelector('[data-me]').onclick = () => (mine.length ? App.statusView(S.me.id, mine) : App.newStatus());
  box.querySelector('[data-all]').onclick = () => App.setTab('status');
  $$('[data-u]', box).forEach((b) => (b.onclick = () => { const g = others.find((x) => x.u === b.dataset.u); if (g) App.statusView(g.u, g.list); }));
};

// ---------- Groups tab ----------
App.renderGroupsTab = () => {
  const body = $('#tabbody'); if (!body) return;
  const all = [...S.chats.values()].filter((c) => c.type === 'group' && !c.left);
  const groups = all.filter((c) => !c.channel), chans = all.filter((c) => c.channel);
  const sortFn = (a, b) => ((b.last ? b.last.deliver_at : b.last_msg_at) - (a.last ? a.last.deliver_at : a.last_msg_at));
  const row = (c) => `<button class="row chatrow" data-id="${c.id}">${avatar(chatAvatarObj(c))}<span class="row-main"><span class="row-top"><b class="nm">${esc(chatTitle(c))}</b><span class="tm">${fmtListTime(c.last ? c.last.deliver_at : c.last_msg_at)}</span></span><span class="row-sub"><span class="sub">${c.channel ? (c.public ? t('Public channel') : t('Private channel')) + ' · ' : ''}${t('{n} members', { n: c.member_count })}</span><span class="flags">${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</span></span></span></button>`;
  body.innerHTML = `<div class="gtop"><button class="gcard" id="g-new"><span class="gic">${ICON.group}</span><b>${t('New group')}</b><span class="sub">${t('Up to 1024 people')}</span></button><button class="gcard" id="g-chan"><span class="gic">${ICON.channel}</span><b>${t('New channel')}</b><span class="sub">${t('Broadcast to followers')}</span></button><button class="gcard" id="g-disc"><span class="gic">${ICON.search}</span><b>${t('Discover')}</b><span class="sub">${t('Public channels')}</span></button></div>
    <div class="list"><div class="sect">${t('Your groups')} (${groups.length})</div>${groups.sort(sortFn).map(row).join('') || `<p class="pad muted">${t('No groups yet.')}</p>`}
    <div class="sect">${t('Channels')} (${chans.length})</div>${chans.sort(sortFn).map(row).join('') || `<p class="pad muted">${t('No channels yet.')}</p>`}</div>`;
  $('#g-new').onclick = () => App.newGroup(); $('#g-chan').onclick = () => App.newChannel(); $('#g-disc').onclick = () => App.discoverChannels();
  $$('.chatrow', body).forEach((b) => (b.onclick = () => App.openChat(b.dataset.id)));
};

// ---------- Me tab ----------
App.renderMeTab = () => {
  const body = $('#tabbody'); if (!body) return; const me = S.me; const P = App.settingsPages || {};
  const r = (id, ic, label, sub) => `<button class="row" id="${id}"><span class="ic">${ic}</span><span class="row-main">${label}${sub ? `<span class="sub">${sub}</span>` : ''}</span></button>`;
  body.innerHTML = `<div class="mecard"><button class="mecard-av" id="me-prof">${avatar(me, 96)}</button><h2>${esc(me.name)}</h2><p class="sub">@${esc(me.username)}${me.phone ? ' · ' + esc(me.phone) : ''}</p>${me.about ? `<p class="muted">${esc(me.about)}</p>` : ''}
      <div class="mebtns"><button class="btn sm" id="me-edit">${ICON.edit} ${t('Edit profile')}</button><button class="btn sm ghost" id="me-status">${ICON.status} ${t('My status')}</button></div></div>
    <div class="card list">${r('me-priv', ICON.lock, t('Privacy'), t('Last seen, read receipts, app lock, blocked'))}${r('me-chats', ICON.chats, t('Chats & appearance'), t('Theme, wallpaper, background video'))}${r('me-notif', ICON.bell, t('Notifications'), '')}${r('me-star', ICON.star, t('Starred messages'), '')}${r('me-media', ICON.image, t('Archived chats'), '')}${r('me-acct', ICON.key, t('Account'), t('Password, devices, delete account'))}${r('me-all', ICON.settings, t('All settings'), '')}${me.role === 'admin' ? r('me-admin', ICON.shield, t('Admin panel'), t('Users, look & feel, videos, screenshots')) : ''}${r('me-help', ICON.info, t('Help'), '')}</div>
    <div class="card list">${r('me-out', ICON.logout, `<span style="color:var(--danger)">${t('Log out')}</span>`, '')}</div>
    <p class="fine center pad">${esc(App.brand().app_name)} · v${esc((S.config && S.config.version) || '')}</p>`;
  const on = (id, fn) => { const n = $('#' + id, body); if (n) n.onclick = fn; };
  const after = () => App.renderMeTab();
  on('me-prof', () => P.profile && P.profile(after)); on('me-edit', () => P.profile && P.profile(after));
  on('me-status', () => App.setTab('status'));
  on('me-priv', () => P.privacy && P.privacy()); on('me-chats', () => P.chatsSettings && P.chatsSettings()); on('me-notif', () => P.notifSettings && P.notifSettings());
  on('me-star', () => App.starred()); on('me-media', () => App.openFolder && App.openFolder('archived')); on('me-acct', () => P.account && P.account());
  on('me-all', () => App.settings()); on('me-admin', () => App.openAdmin()); on('me-help', () => P.help && P.help());
  on('me-out', async () => { if (await confirmBox(t('Log out of {a} on this device?', { a: App.brand().app_name }), t('Log out'), true)) App.logout(); });
};

// ---------- admin ----------
App.openAdmin = () => { location.href = '/admin'; };

// ---------- channels ----------
App.newChannel = () => {
  const m = openModal(`<form class="dlg"><h3>${ICON.channel} ${t('New channel')}</h3><p class="muted">${t('Only admins post in a channel; followers read and react.')}</p>
    <input class="inp" name="name" maxlength="60" required placeholder="${t('Channel name')}"><textarea class="inp" name="description" maxlength="500" rows="2" placeholder="${t('Description (optional)')}"></textarea>
    <label class="chkrow"><input type="checkbox" name="public"> ${t('Public — anyone can find and follow it')}</label>
    <div class="dlg-btns"><button type="button" class="btn ghost" data-close>${t('Cancel')}</button><button class="btn">${t('Create')}</button></div></form>`);
  const f = m.el.querySelector('form'); m.el.querySelector('[data-close]').onclick = () => m.close();
  f.onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/chats/channel', { body: { name: f.name.value, description: f.description.value, public: f.public.checked } }); for (const u of Object.values(r.users || {})) S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u }); S.chats.set(r.chat.id, r.chat); m.close(); App.renderList(); App.openChat(r.chat.id); toast(t('Channel created')); } catch (er) { toast(er.message); } };
};
App.discoverChannels = () => {
  const d = App.openDrawer(t('Discover channels'), `<div class="searchrow"><input id="dcq" placeholder="${t('Search channels')}"></div><div id="dcl" class="list"></div>`);
  const load = async () => {
    try { const r = await api('/api/channels?q=' + encodeURIComponent($('#dcq', d.body).value.trim()));
      $('#dcl', d.body).innerHTML = r.channels.map((c) => `<div class="row">${avatar({ id: c.id, name: c.name, photo: c.photo })}<span class="row-main"><b>${esc(c.name)}</b><span class="sub">${t('{n} followers', { n: c.member_count })}${c.description ? ' · ' + esc(c.description) : ''}</span></span>${c.joined ? `<button class="btn sm ghost" data-open="${c.id}">${t('Open')}</button>` : `<button class="btn sm" data-join="${c.id}">${t('Follow')}</button>`}</div>`).join('') || `<p class="pad muted">${t('No public channels yet.')}</p>`;
      $$('[data-join]', d.body).forEach((b) => (b.onclick = async () => { try { const r2 = await api(`/api/chats/${b.dataset.join}/join`, { body: {} }); S.chats.set(r2.chat.id, r2.chat); d.close(); App.renderList(); App.openChat(r2.chat.id); } catch (e) { toast(e.message); } }));
      $$('[data-open]', d.body).forEach((b) => (b.onclick = () => { d.close(); App.openChat(b.dataset.open); }));
    } catch (e) { toast(e.message); }
  };
  let tm; $('#dcq', d.body).oninput = () => { clearTimeout(tm); tm = setTimeout(load, 300); }; load();
};

// ---------- invite links ----------
App.inviteLink = async (c) => {
  try {
    const r = await api(`/api/chats/${c.id}/invite`);
    const m = openModal(`<div class="dlg"><h3>${ICON.link} ${t('Invite link')}</h3><p class="muted">${t('Anyone with this link can join “{n}”. Share it only with people you trust.', { n: esc(c.name) })}</p><input class="inp" readonly value="${esc(r.url)}">
      <div class="dlg-btns wrap"><button class="btn ghost" data-reset>${t('Reset link')}</button><button class="btn ghost" data-copy>${t('Copy')}</button><button class="btn" data-share>${t('Share')}</button></div></div>`);
    const inp = m.el.querySelector('input');
    m.el.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(inp.value); toast(t('Link copied')); } catch { inp.select(); document.execCommand('copy'); toast(t('Link copied')); } };
    m.el.querySelector('[data-share]').onclick = async () => { const text = t('Join “{n}” on {a}: {u}', { n: c.name, a: App.brand().app_name, u: inp.value }); if (navigator.share) { try { await navigator.share({ text }); } catch {} } else { try { await navigator.clipboard.writeText(text); toast(t('Link copied')); } catch {} } };
    m.el.querySelector('[data-reset]').onclick = async () => { if (!(await confirmBox(t('Reset the link? The old link will stop working.'), t('Reset link'), true))) return; const r2 = await api(`/api/chats/${c.id}/invite`, { body: { reset: true } }); inp.value = r2.url; toast(t('New link created')); };
  } catch (e) { toast(e.message); }
};
App.handleJoinPath = async () => {
  const mm = location.pathname.match(/^\/join\/([A-Za-z0-9]{6,20})$/) || (location.hash.match(/^#join=([A-Za-z0-9]{6,20})$/));
  if (!mm) return; const code = mm[1]; history.replaceState(null, '', '/');
  try {
    const r = await api('/api/invite/' + code); const c = r.chat;
    if (c.joined) { App.openChat(c.id); return; }
    if (await confirmBox(`${t(c.channel ? 'Follow channel “{n}”?' : 'Join group “{n}”?', { n: esc(c.name) })} (${t('{n} members', { n: c.member_count })})`, c.channel ? t('Follow') : t('Join'))) {
      const j = await api(`/api/invite/${code}/join`, { body: {} }); for (const u of Object.values(j.users || {})) S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u }); S.chats.set(j.chat.id, j.chat); App.renderList(); App.openChat(j.chat.id);
    }
  } catch (e) { toast(e.message); }
};

// ---------- location / contact ----------
async function sendSpecial(c, type, meta) {
  try { const r = await api(`/api/chats/${c.id}/messages`, { body: { type, meta, client_id: uid() } }); App.upsertMessage(r.message); c.last = r.message; App.renderList(); App.kick(); }
  catch (e) { toast(e.message); }
}
App.shareLocation = (c) => {
  if (!navigator.geolocation) return toast(t('Location is not available on this device'));
  toast(t('Getting your location…'));
  navigator.geolocation.getCurrentPosition(async (p) => {
    const lat = p.coords.latitude, lng = p.coords.longitude, acc = Math.round(p.coords.accuracy || 0);
    if (!(await confirmBox(`${t('Send your current location?')} (${lat.toFixed(5)}, ${lng.toFixed(5)}${acc ? ', ±' + acc + ' m' : ''})`, t('Send')))) return;
    const label = await prompt2(t('Add a name for this place (optional)'), { max: 120, value: '' });
    sendSpecial(c, 'location', { lat, lng, acc, label: label || '' });
  }, (e) => toast(e.code === 1 ? t('Location permission was denied') : t('Could not get your location')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
};
App.shareContact = (c) => {
  if (!App.pickUsers) return;
  App.pickUsers({ title: t('Share contact'), multi: false, onDone: (x) => { const u = Array.isArray(x) ? x[0] : x; if (u) sendSpecial(c, 'contact', { user_id: u.id }); } });
};
