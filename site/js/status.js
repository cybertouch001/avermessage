// Avermessage — Status (24-hour stories).
import { App, S, LS, t, $, $$, esc, el, api, upload, toast, avatar, ICON, fmtListTime, fileUrl, openModal, sheet, confirmBox } from './util.js';

const BGS = ['#4b38dc', '#7a3ae6', '#c2410c', '#0e7490', '#be185d', '#15803d', '#1f2937', '#b45309'];
let data = { statuses: [], users: {} };
async function load() { data = await api('/api/status'); Object.values(data.users).forEach((u) => S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u })); const dot = $('#tb-status'); if (dot) dot.classList.toggle('show', data.statuses.some((s) => s.user_id !== S.me.id && !s.seen)); return data; }
setInterval(() => { if (S.me && S.tab !== 'status') load().catch(() => {}); }, 120000);
setTimeout(() => S.me && load().catch(() => {}), 4000);
App.renderStatusTab = async () => {
  const body = $('#tabbody'); if (!body) return;
  body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  try { await load(); } catch (e) { body.innerHTML = `<p class="pad">${esc(e.message)}</p>`; return; }
  if (S.tab !== 'status') return;
  const by = new Map(); for (const s of data.statuses) { if (!by.has(s.user_id)) by.set(s.user_id, []); by.get(s.user_id).push(s); }
  const mine = by.get(S.me.id) || []; by.delete(S.me.id);
  const groups = [...by.entries()].map(([uid, list]) => ({ uid, list, unseen: list.some((s) => !s.seen), last: list[list.length - 1].created_at })).sort((a, b) => b.last - a.last);
  const ring = (n, unseen) => `<span class="ring ${unseen ? 'new' : ''}" style="--n:${n}">`;
  const row = (g) => { const u = S.users.get(g.uid) || { id: g.uid, name: '?' }; return `<button class="row" data-u="${g.uid}">${ring(g.list.length, g.unseen)}${avatar(u, 48)}</span><span class="row-main"><b>${esc(u.name)}</b><span class="sub">${fmtListTime(g.last)}</span></span></button>`; };
  body.innerHTML = `<div class="list">
    <div class="row mystatus"><button class="mybtn" id="my-view">${mine.length ? ring(mine.length, false) : '<span class="ring none">'}${avatar(S.me, 48)}</span>${mine.length ? '' : `<span class="plus">${ICON.plus}</span>`}</button><span class="row-main" id="my-main"><b>${t('My status')}</b><span class="sub">${mine.length ? t('{n} update(s) · tap to view', { n: mine.length }) : t('Tap to add a status update')}</span></span>
      <button class="ib" id="st-text" title="${t('Text status')}">${ICON.edit}</button><button class="ib" id="st-photo" title="${t('Photo status')}">${ICON.camera}</button><input type="file" id="st-file" accept="image/*,video/*" hidden></div>
    ${groups.filter((g) => g.unseen).length ? `<div class="sect">${t('Recent updates')}</div>` + groups.filter((g) => g.unseen).map(row).join('') : ''}
    ${groups.filter((g) => !g.unseen).length ? `<div class="sect">${t('Viewed updates')}</div>` + groups.filter((g) => !g.unseen).map(row).join('') : ''}
    ${!groups.length ? `<div class="empty"><p>${t('No updates from your contacts yet.')}</p></div>` : ''}
  </div><p class="fine pad">${ICON.info} ${t('Status updates disappear after 24 hours. Who can see yours: Settings → Privacy → Status.')}</p>`;
  $('#my-view').onclick = () => (mine.length ? view(S.me.id, mine) : App.newStatus());
  $('#my-main').onclick = $('#my-view').onclick;
  $('#st-text').onclick = textStatus; $('#st-photo').onclick = () => $('#st-file').click();
  $('#st-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) mediaStatus(f); };
  $$('[data-u]', body).forEach((b) => (b.onclick = () => { const g = groups.find((x) => x.uid === b.dataset.u); view(g.uid, g.list); }));
};
App.newStatus = () => sheet(t('New status'), [{ icon: ICON.edit, label: t('Text'), run: textStatus }, { icon: ICON.camera, label: t('Photo or video'), run: () => { const i = el('<input type="file" accept="image/*,video/*">'); i.onchange = () => i.files[0] && mediaStatus(i.files[0]); i.click(); } }]);
function textStatus() {
  let bi = 0;
  const m = openModal(`<form class="st-compose" style="background:${BGS[0]}"><header><button type="button" class="ib" data-close>${ICON.close}</button><button type="button" class="ib" id="st-bg">🎨</button></header><textarea maxlength="700" placeholder="${t('Type a status')}" autofocus></textarea><button class="sendbtn">${ICON.send}</button></form>`, { cls: 'full' });
  const f = m.el.querySelector('form'); setTimeout(() => f.querySelector('textarea').focus(), 60);
  $('#st-bg', f).onclick = () => { bi = (bi + 1) % BGS.length; f.style.background = BGS[bi]; };
  f.onsubmit = async (e) => { e.preventDefault(); const body = f.querySelector('textarea').value.trim(); if (!body) return; try { await api('/api/status', { body: { type: 'text', body, bg: BGS[bi] } }); m.close(); toast(t('Status posted')); App.setTab('status'); } catch (er) { toast(er.message); } };
}
async function mediaStatus(file) {
  const isVid = /^video\//.test(file.type); if (!/^(image|video)\//.test(file.type)) return toast(t('Pick a photo or video'));
  if (file.size > 50 * 1048576) return toast(t('File too large (max 50 MB)'));
  const url = URL.createObjectURL(file);
  const m = openModal(`<form class="st-compose media"><header><button type="button" class="ib" data-close>${ICON.close}</button></header>${isVid ? `<video src="${url}" controls playsinline></video>` : `<img src="${url}">`}<div class="st-cap"><input class="inp" maxlength="300" placeholder="${t('Add a caption…')}"><button class="sendbtn">${ICON.send}</button></div><div class="progwrap"><span class="prog"></span></div></form>`, { cls: 'full' });
  const f = m.el.querySelector('form');
  f.onsubmit = async (e) => { e.preventDefault(); const btn = f.querySelector('.sendbtn'); btn.disabled = true; try { const up = await upload(file, 'status', file.name, (p) => (f.querySelector('.prog').style.width = Math.round(p * 100) + '%')); await api('/api/status', { body: { type: isVid ? 'video' : 'image', file_id: up.id, body: f.querySelector('input').value.trim() } }); m.close(); toast(t('Status posted')); App.setTab('status'); } catch (er) { toast(er.message); btn.disabled = false; } };
}
function view(uid, list) {
  let i = Math.max(0, list.findIndex((s) => !s.seen)); if (uid === S.me.id) i = 0;
  const u = S.users.get(uid) || S.me; let timer = null, paused = false, startAt = 0, remain = 0;
  const m = openModal(`<div class="st-view"><div class="st-bars">${list.map(() => '<i><b></b></i>').join('')}</div><header>${avatar(u, 36)}<span class="vw-t"><b>${esc(uid === S.me.id ? t('My status') : u.name)}</b><span class="sub" id="st-when"></span></span>${uid === S.me.id ? `<button class="ib" id="st-del">${ICON.trash}</button>` : ''}<button class="ib" data-close>${ICON.close}</button></header><div class="st-body" id="st-body"></div><div class="st-nav"><button id="st-prev"></button><button id="st-next"></button></div><div class="st-foot" id="st-foot"></div></div>`, { cls: 'full', onClose: () => { clearTimeout(timer); App.renderStatusTab(); } });
  const bars = $$('.st-bars b', m.el);
  const show = () => {
    clearTimeout(timer); const s = list[i]; if (!s) return m.close();
    bars.forEach((b, k) => { b.style.transition = 'none'; b.style.width = k < i ? '100%' : '0'; });
    $('#st-when', m.el).textContent = fmtListTime(s.created_at);
    const bodyEl = $('#st-body', m.el);
    if (s.type === 'text') bodyEl.innerHTML = `<div class="st-text" style="background:${esc(s.bg || '#4b38dc')}">${esc(s.body)}</div>`;
    else if (s.type === 'image') bodyEl.innerHTML = `<img src="${fileUrl(s.file_id)}">${s.body ? `<div class="vw-cap">${esc(s.body)}</div>` : ''}`;
    else bodyEl.innerHTML = `<video src="${fileUrl(s.file_id)}" autoplay playsinline></video>${s.body ? `<div class="vw-cap">${esc(s.body)}</div>` : ''}`;
    const foot = $('#st-foot', m.el); foot.innerHTML = uid === S.me.id ? `<button class="linkbtn" id="st-views">👁 ${s.views || 0} ${t('views')}</button>` : '';
    const vb = $('#st-views', m.el); if (vb) vb.onclick = () => viewers(s);
    if (uid !== S.me.id && !s.seen) { s.seen = true; api(`/api/status/${s.id}/view`, { body: {} }).catch(() => {}); }
    const dur = s.type === 'video' ? null : 5000;
    const run = (ms) => { const b = bars[i]; requestAnimationFrame(() => { b.style.transition = `width ${ms}ms linear`; b.style.width = '100%'; }); startAt = Date.now(); remain = ms; timer = setTimeout(next, ms); };
    if (dur) run(dur); else { const v = bodyEl.querySelector('video'); v.onloadedmetadata = () => run(Math.min(30000, (v.duration || 10) * 1000)); v.onerror = () => run(5000); }
  };
  const next = () => { i++; if (i >= list.length) m.close(); else show(); };
  const prev = () => { i = Math.max(0, i - 1); show(); };
  $('#st-next', m.el).onclick = next; $('#st-prev', m.el).onclick = prev;
  const del = $('#st-del', m.el); if (del) del.onclick = async () => { clearTimeout(timer); if (await confirmBox(t('Delete this status update?'), t('Delete'), true)) { try { await api(`/api/status/${list[i].id}`, { method: 'DELETE' }); list.splice(i, 1); if (!list.length) m.close(); else { i = Math.min(i, list.length - 1); show(); } } catch (e) { toast(e.message); } } else show(); };
  show();
}
async function viewers(s) {
  try { const r = await api(`/api/status/${s.id}/viewers`); openModal(`<div class="dlg"><h3>${t('Viewed by {n}', { n: r.viewers.length })}</h3><div class="list">${r.viewers.map((v) => `<div class="row">${avatar(v.user || {}, 34)}<span class="row-main"><b>${esc((v.user || {}).name || '')}</b><span class="sub">${fmtListTime(v.at)}</span></span></div>`).join('') || `<p class="muted">${t('No views yet')}</p>`}</div><div class="dlg-btns"><button class="btn" data-close>${t('Close')}</button></div></div>`); } catch (e) { toast(e.message); }
}
