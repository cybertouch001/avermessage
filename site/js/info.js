// AverChat — info screens and chat-level actions.
import { App, S, LS, t, $, $$, esc, el, api, toast, avatar, ICON, fmtTime, fmtDay, fmtLastSeen, fmtSize, fmtDur, previewText, chatTitle, chatAvatarObj, nameOf, sheet, confirmBox, prompt2, openModal, fileUrl, dLabel, WALLPAPERS } from './util.js';

App.setPrefs = async (c, b, msg) => { try { await api(`/api/chats/${c.id}/prefs`, { body: b }); Object.assign(c, b); App.renderList(); App.refreshFolders(); if (S.open === c.id) App.reloadOpenChatMeta(); msg && toast(msg); } catch (e) { toast(e.message); } };
App.muteMenu = (c) => sheet(t('Mute notifications for…'), [
  { label: t('8 hours'), run: () => App.setPrefs(c, { muted_until: Date.now() + 8 * 3600000 }, t('Muted')) },
  { label: t('1 week'), run: () => App.setPrefs(c, { muted_until: Date.now() + 7 * 86400000 }, t('Muted')) },
  { label: t('Always'), run: () => App.setPrefs(c, { muted_until: Date.now() + 100 * 365 * 86400000 }, t('Muted')) },
]);
App.toggleLock = async (c) => {
  if (!S.me.has_pin) { if (await confirmBox(t('To lock chats, first set a 4–6 digit chat-lock PIN. Set it now?'), t('Set PIN'))) App.setPin(); return; }
  if (c.locked) { if (!S.unlocked && !(await App.askPin())) return; await App.setPrefs(c, { locked: false }, t('Chat unlocked')); }
  else { await App.setPrefs(c, { locked: true }, t('Chat locked. Find it in “Locked chats” at the top of your list.')); if (S.open === c.id && !S.unlocked) App.closeChat(); }
};
App.disappearingMenu = (c) => {
  if (c.type === 'group' && c.my_role !== 'admin') return toast(t('Only group admins can change this'));
  sheet(t('Disappearing messages'), [0, 86400, 604800, 7776000].map((s) => ({ label: (c.disappearing === s ? '✓ ' : '') + dLabel(s), run: async () => { try { const r = await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { disappearing: s } }); Object.assign(c, r.chat); App.reloadOpenChatMeta(); } catch (e) { toast(e.message); } } })));
};
App.wallpaperMenu = (c) => {
  const cur = c ? c.wallpaper : (S.me.settings || {}).wallpaper;
  const m = openModal(`<div class="dlg"><h3>${t('Wallpaper')}</h3><div class="wpgrid">${WALLPAPERS.map((w) => `<button class="wpsw wp-${w} ${cur === w ? 'on' : ''}" data-w="${w}"><span>${t(w[0].toUpperCase() + w.slice(1))}</span></button>`).join('')}</div>${c ? `<button class="linkbtn" data-w="">${t('Use default')}</button>` : ''}<div class="dlg-btns"><button class="btn ghost" data-close>${t('Close')}</button></div></div>`);
  $$('[data-w]', m.el).forEach((b) => (b.onclick = async () => { m.close(); const w = b.dataset.w || null; if (c) await App.setPrefs(c, { wallpaper: w }); else { S.me.settings = { ...(S.me.settings || {}), wallpaper: w }; await api('/api/me', { method: 'PATCH', body: { settings: S.me.settings } }); if (S.open) App.reloadOpenChatMeta(); toast(t('Saved')); } }));
};
App.toggleBlock = async (u) => {
  if (!u.blocked && !(await confirmBox(t('Block {n}? Blocked contacts can’t call you or send you messages.', { n: u.name }), t('Block'), true))) return;
  try { await api(`/api/users/${u.id}/block`, { body: { on: !u.blocked } }); u.blocked = !u.blocked; toast(u.blocked ? t('Blocked') : t('Unblocked')); if (S.open) { App.renderComposer(); App.refreshChatHeader(); } } catch (e) { toast(e.message); }
};
App.report = async (userId, chatId) => {
  const reason = await prompt2(t('Report to the AverChat admin. What happened?'), { multiline: true, max: 500, placeholder: t('e.g. spam, abuse, fake account') }); if (reason === null) return;
  const block = await confirmBox(t('Also block this contact?'), t('Block'), true);
  try { await api(`/api/users/${userId}/report`, { body: { reason, chat_id: chatId, block } }); if (block) { const u = S.users.get(userId); if (u) u.blocked = true; if (S.open) App.renderComposer(); } toast(t('Reported. Thank you.')); } catch (e) { toast(e.message); }
};
App.deleteOrExit = async (c) => {
  if (c.type === 'group' && !c.left) { if (!(await confirmBox(t('Exit “{n}”?', { n: c.name }), t('Exit group'), true))) return; try { await api(`/api/chats/${c.id}/members/${S.me.id}`, { method: 'DELETE' }); c.left = true; await App.loadChats(); if (S.open === c.id) App.reloadOpenChatMeta(); } catch (e) { toast(e.message); } return; }
  if (!(await confirmBox(t('Delete this chat? Messages are removed from this device list (others keep theirs).'), t('Delete chat'), true))) return;
  try { await api(`/api/chats/${c.id}/delete`, { body: {} }); S.chats.delete(c.id); S.msgs.delete(c.id); if (S.open === c.id) App.closeChat(); App.renderList(); App.refreshFolders(); } catch (e) { toast(e.message); }
};

// ---------- contact / group info ----------
App.chatInfo = async (id) => {
  const c = S.chats.get(id); if (!c) return;
  if (c.type === 'direct') return App.userInfo(c.peer_id, c);
  const d = App.openDrawer(t('Group info'), `<div class="loading">${t('Loading…')}</div>`);
  const render = async () => {
    let r; try { r = await api(`/api/chats/${id}`); } catch (e) { d.body.innerHTML = `<p class="pad">${esc(e.message)}</p>`; return; }
    Object.values(r.users).forEach((u) => S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u })); Object.assign(c, r.chat);
    const admin = c.my_role === 'admin' && !c.left;
    c._memberNames = r.members.map((m) => nameOf(m.user_id)).join(', '); App.refreshChatHeader();
    d.body.innerHTML = `<div class="info-top"><button class="bigav" id="gp">${avatar(chatAvatarObj(c), 120)}${admin ? `<span class="cam">${ICON.camera}</span>` : ''}</button><input type="file" accept="image/*" id="gpf" hidden>
      <h2>${esc(c.name)} ${admin ? `<button class="ib sm" id="gn">${ICON.edit}</button>` : ''}</h2><p class="muted">${t('Group')} · ${t('{n} members', { n: r.members.length })}</p></div>
      <div class="card"><div class="sub">${esc(c.description || '')}${admin ? ` <button class="linkbtn" id="gd">${c.description ? t('Edit description') : t('Add group description')}</button>` : ''}</div></div>
      <div class="card"><button class="row" id="gmedia"><span class="ic">${ICON.image}</span><span class="row-main">${t('Media, links and docs')}</span></button>
        <button class="row" id="gdis"><span class="ic">${ICON.timer}</span><span class="row-main">${t('Disappearing messages')}<span class="sub">${dLabel(c.disappearing)}</span></span></button>
        ${c.channel ? `<div class="row"><span class="ic">${ICON.lock}</span><span class="row-main">${t('Encryption')}<span class="sub">${t('Channel messages are not end-to-end encrypted.')}</span></span></div>` : `<button class="row" id="genc"><span class="ic">${ICON.lock}</span><span class="row-main">${t('Encryption')}<span class="sub" id="genc-s">…</span></span></button>`}
        ${admin ? `<label class="row"><span class="ic">${ICON.shield}</span><span class="row-main">${t('Only admins can send messages')}</span><input type="checkbox" id="goa" ${c.only_admins ? 'checked' : ''}></label>` : ''}</div>
      <div class="card"><div class="sect">${t('{n} members', { n: r.members.length })}</div>${admin ? `<button class="row" id="gadd"><span class="av fold">${ICON.plus}</span><span class="row-main"><b>${t('Add members')}</b></span></button><button class="row" id="ginv"><span class="av fold">${ICON.link}</span><span class="row-main"><b>${t('Invite via link')}</b><span class="sub">${t('Anyone with the link can join')}</span></span></button>` : ''}
        ${r.members.sort((a, b) => (a.user_id === S.me.id ? -1 : b.user_id === S.me.id ? 1 : (b.role === 'admin') - (a.role === 'admin'))).map((m) => { const u = S.users.get(m.user_id) || { id: m.user_id, name: '?' }; return `<button class="row" data-mem="${m.user_id}">${avatar(u, 40)}<span class="row-main"><b>${m.user_id === S.me.id ? t('You') : esc(u.name)}</b><span class="sub">${esc(u.about || '@' + (u.username || ''))}</span></span>${m.role === 'admin' ? `<span class="tag">${t('Admin')}</span>` : ''}</button>`; }).join('')}</div>
      <div class="card">${!c.left ? `<button class="row danger" id="gexit"><span class="ic">${ICON.logout}</span><span class="row-main">${t('Exit group')}</span></button>` : `<button class="row danger" id="gdel"><span class="ic">${ICON.trash}</span><span class="row-main">${t('Delete group')}</span></button>`}</div>`;
    const on = (sel, fn) => { const n = $(sel, d.body); if (n) n.onclick = fn; };
    on('#gmedia', () => App.mediaGallery(c)); on('#gdis', () => App.disappearingMenu(c)); on('#genc', () => App.encInfo(c, null));
    if (!c.channel) App.encStatus(c).then((s) => { const n = $('#genc-s', d.body); if (n) n.textContent = s; });
    on('#gexit', () => App.deleteOrExit(c).then(render)); on('#gdel', () => { App.deleteOrExit(c); d.close(); });
    on('#gn', async () => { const n = await prompt2(t('Group name'), { value: c.name, max: 60 }); if (n && n.trim()) { await patch({ name: n.trim() }); render(); } });
    on('#gd', async () => { const n = await prompt2(t('Group description'), { value: c.description || '', max: 500, multiline: true }); if (n !== null) { await patch({ description: n }); render(); } });
    const oa = $('#goa', d.body); if (oa) oa.onchange = async () => { await patch({ only_admins: oa.checked }); App.renderComposer(); };
    if (admin) { on('#gp', () => $('#gpf', d.body).click()); $('#gpf', d.body).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const sq = await App.squareImage(f, 512); const up = await App.uploadFile(sq, 'group:' + c.id, 'group.jpg'); await patch({ photo: up.id }); render(); App.renderList(); } catch (er) { toast(er.message); } }; }
    on('#ginv', () => App.inviteLink(c));
    on('#gadd', () => App.pickUsers({ title: t('Add members'), multi: true, exclude: r.members.map((m) => m.user_id), onDone: async (users) => { try { await api(`/api/chats/${id}/members`, { body: { user_ids: users.map((u) => u.id) } }); toast(t('Added')); render(); } catch (e) { toast(e.message); } } }));
    $$('[data-mem]', d.body).forEach((b) => (b.onclick = () => { const uid2 = b.dataset.mem; if (uid2 === S.me.id) return; const mem = r.members.find((m) => m.user_id === uid2); const u = S.users.get(uid2);
      sheet(esc(u.name), [{ icon: ICON.chats, label: t('Message {n}', { n: u.name }), run: () => App.openDirect(uid2) }, { icon: ICON.info, label: t('View {n}', { n: u.name }), run: () => App.userInfo(uid2) },
        admin ? { icon: ICON.shield, label: mem.role === 'admin' ? t('Dismiss as admin') : t('Make group admin'), run: async () => { try { await api(`/api/chats/${id}/members/${uid2}/role`, { body: { role: mem.role === 'admin' ? 'member' : 'admin' } }); render(); } catch (e) { toast(e.message); } } } : null,
        admin ? { icon: ICON.trash, label: t('Remove {n}', { n: u.name }), danger: true, run: async () => { if (await confirmBox(t('Remove {n} from the group?', { n: u.name }), t('Remove'), true)) { try { await api(`/api/chats/${id}/members/${uid2}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message); } } } } : null]); }));
  };
  const patch = async (b) => { try { const r = await api(`/api/chats/${id}`, { method: 'PATCH', body: b }); Object.assign(c, r.chat); App.reloadOpenChatMeta(); App.renderList(); } catch (e) { toast(e.message); } };
  render();
};
App.userInfo = async (uid2, chat) => {
  const d = App.openDrawer(t('Contact info'), `<div class="loading">${t('Loading…')}</div>`);
  let r; try { r = await api(`/api/users/${uid2}`); } catch (e) { d.body.innerHTML = `<p class="pad">${esc(e.message)}</p>`; return; }
  const u = r.user; S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u });
  const c = chat || [...S.chats.values()].find((x) => x.type === 'direct' && x.peer_id === u.id);
  const render = () => {
    d.body.innerHTML = `<div class="info-top"><button class="bigav" id="uav">${avatar(u, 120)}</button><h2>${esc(u.name)}</h2><p class="muted">@${esc(u.username)}${u.phone ? ' · ' + esc(u.phone) : ''}</p><p class="muted">${esc(fmtLastSeen(u))}</p>
      <div class="actions"><button class="act" id="ua-msg">${ICON.chats}<span>${t('Message')}</span></button><button class="act" id="ua-voice">${ICON.phone}<span>${t('Voice')}</span></button><button class="act" id="ua-video">${ICON.video}<span>${t('Video')}</span></button></div></div>
      ${u.about ? `<div class="card"><div class="sect">${t('About')}</div><div class="pad0">${esc(u.about)}</div></div>` : ''}
      <div class="card">${c ? `<button class="row" id="umedia"><span class="ic">${ICON.image}</span><span class="row-main">${t('Media, links and docs')}</span></button><button class="row" id="udis"><span class="ic">${ICON.timer}</span><span class="row-main">${t('Disappearing messages')}<span class="sub">${dLabel(c.disappearing)}</span></span></button><button class="row" id="uenc"><span class="ic">${ICON.lock}</span><span class="row-main">${t('Encryption')}<span class="sub" id="uenc-s">…</span></span></button>` : ''}
        <button class="row" id="ucontact"><span class="ic">${ICON.user}</span><span class="row-main">${u.contact ? t('Remove from contacts') : t('Add to contacts')}</span></button></div>
      ${r.common_groups.length ? `<div class="card"><div class="sect">${t('{n} groups in common', { n: r.common_groups.length })}</div>${r.common_groups.map((g) => `<button class="row" data-g="${g.id}">${avatar({ id: g.id, type: 'group', name: g.name, photo: (S.chats.get(g.id) || {}).photo }, 40)}<span class="row-main"><b>${esc(g.name)}</b></span></button>`).join('')}</div>` : ''}
      <div class="card"><button class="row danger" id="ublock"><span class="ic">${ICON.block}</span><span class="row-main">${u.blocked ? t('Unblock {n}', { n: u.name }) : t('Block {n}', { n: u.name })}</span></button><button class="row danger" id="ureport"><span class="ic">${ICON.flag}</span><span class="row-main">${t('Report {n}', { n: u.name })}</span></button></div>`;
    const on = (sel, fn) => { const n = $(sel, d.body); if (n) n.onclick = fn; };
    on('#ua-msg', () => App.openDirect(u.id)); on('#ua-voice', () => App.startCall(u.id, 'voice')); on('#ua-video', () => App.startCall(u.id, 'video'));
    on('#uav', () => u.photo && App.viewImage(fileUrl(u.photo), u.name));
    on('#umedia', () => App.mediaGallery(c)); on('#udis', () => App.disappearingMenu(c)); on('#uenc', () => App.encInfo(c, u));
    if (c) App.encStatus(c).then((s) => { const n = $('#uenc-s', d.body); if (n) n.textContent = s; });
    on('#ublock', async () => { await App.toggleBlock(S.users.get(u.id)); u.blocked = S.users.get(u.id).blocked; render(); });
    on('#ureport', () => App.report(u.id, c && c.id));
    on('#ucontact', async () => { try { if (u.contact) await api(`/api/contacts/${u.id}`, { method: 'DELETE' }); else await api('/api/contacts', { body: { user_id: u.id } }); u.contact = !u.contact; render(); } catch (e) { toast(e.message); } });
    $$('[data-g]', d.body).forEach((b) => (b.onclick = () => { App.closeAllDrawers(); App.openChat(b.dataset.g); }));
  };
  render();
};

// ---------- message info, reactions, votes ----------
App.msgInfo = async (m) => {
  const mm = openModal(`<div class="dlg"><h3>${t('Message info')}</h3><div class="loading">${t('Loading…')}</div></div>`);
  try {
    const r = await api(`/api/messages/${m.id}/info`);
    const sect = (label, list, icon) => list.length ? `<div class="sect">${icon} ${label}</div>${list.map((x) => `<div class="row">${avatar(x.user || {}, 34)}<span class="row-main"><b>${esc((x.user || {}).name || '')}</b>${x.at ? `<span class="sub">${fmtDay(x.at)} ${fmtTime(x.at)}</span>` : ''}</span></div>`).join('')}` : '';
    mm.el.querySelector('.loading').outerHTML = `<div class="list">${sect(t('Read by'), r.read, '<span class="ticks read">' + ICON.tick2 + '</span>')}${sect(t('Delivered to'), r.delivered, '<span class="ticks">' + ICON.tick2 + '</span>')}${sect(t('Not delivered yet'), r.pending, '<span class="ticks">' + ICON.tick1 + '</span>')}</div><p class="fine">${t('People who turned off read receipts show as delivered.')}</p><div class="dlg-btns"><button class="btn" data-close>${t('Close')}</button></div>`;
  } catch (e) { toast(e.message); }
};
App.showReactions = (m) => {
  const mine = m.reactions.find((r) => r.user_id === S.me.id);
  const mm = openModal(`<div class="dlg"><h3>${t('Reactions')}</h3><div class="list">${m.reactions.map((r) => `<div class="row">${avatar(S.users.get(r.user_id) || { id: r.user_id, name: nameOf(r.user_id) }, 34)}<span class="row-main"><b>${esc(nameOf(r.user_id))}</b>${r.user_id === S.me.id ? `<span class="sub">${t('Tap to remove')}</span>` : ''}</span><span class="bigemo" ${r.user_id === S.me.id ? 'data-rm' : ''}>${r.emoji}</span></div>`).join('')}</div><div class="dlg-btns"><button class="btn" data-close>${t('Close')}</button></div></div>`);
  const rm = mm.el.querySelector('[data-rm]'); if (rm) rm.closest('.row').onclick = () => { mm.close(); App.react(m, mine.emoji); };
};
App.pollVotes = (m) => {
  const v = m.votes || [];
  openModal(`<div class="dlg"><h3>📊 ${esc(m.meta.question)}</h3>${m.meta.options.map((o, i) => { const who = v.filter((x) => x.opt === i); return `<div class="sect">${esc(o)} · ${who.length}</div>${who.map((x) => `<div class="row">${avatar(S.users.get(x.user_id) || { id: x.user_id, name: nameOf(x.user_id) }, 30)}<span class="row-main">${esc(nameOf(x.user_id))}</span></div>`).join('')}`; }).join('')}<div class="dlg-btns"><button class="btn" data-close>${t('Close')}</button></div></div>`);
};
App.newPoll = (c) => {
  const m = openModal(`<form class="dlg poll-new"><h3>📊 ${t('Create poll')}</h3><input class="inp" name="q" required maxlength="200" placeholder="${t('Ask a question')}"><div id="opts">${[1, 2].map((i) => `<input class="inp opt" maxlength="100" placeholder="${t('Option {n}', { n: i })}">`).join('')}</div><button type="button" class="linkbtn" id="addopt">+ ${t('Add option')}</button><label class="chkrow"><input type="checkbox" name="multi"> ${t('Allow multiple answers')}</label><div class="dlg-btns"><button type="button" class="btn ghost" data-close>${t('Cancel')}</button><button class="btn">${t('Send')}</button></div></form>`);
  const f = m.el.querySelector('form');
  $('#addopt', f).onclick = () => { const n = $$('.opt', f).length; if (n >= 12) return; $('#opts', f).appendChild(el(`<input class="inp opt" maxlength="100" placeholder="${t('Option {n}', { n: n + 1 })}">`)); };
  f.onsubmit = async (e) => { e.preventDefault(); const options = $$('.opt', f).map((i) => i.value.trim()).filter(Boolean); if (options.length < 2) return toast(t('Add at least 2 options')); m.close(); await App.sendMessage(c, { type: 'poll', meta: { question: f.q.value.trim(), options, multi: f.multi.checked } }); };
};

// ---------- forward ----------
App.forward = (m) => {
  const sel = new Set();
  const chats = [...S.chats.values()].filter((c) => !c.left && !(c.locked && !S.unlocked)).sort((a, b) => (b.last ? b.last.deliver_at : 0) - (a.last ? a.last.deliver_at : 0));
  const mm = openModal(`<div class="dlg fwd-dlg"><h3>${t('Forward to…')}</h3><div class="list scroll">${chats.map((c) => `<button class="row" data-c="${c.id}">${avatar(chatAvatarObj(c), 38)}<span class="row-main"><b>${esc(chatTitle(c))}</b></span><span class="chk">${ICON.check}</span></button>`).join('')}</div><p class="fine">${t('Up to 5 chats')}</p><div class="dlg-btns"><button class="btn ghost" data-close>${t('Cancel')}</button><button class="btn" id="fwgo">${t('Forward')}</button></div></div>`);
  $$('[data-c]', mm.el).forEach((b) => (b.onclick = () => { const id = b.dataset.c; if (sel.has(id)) sel.delete(id); else if (sel.size < 5) sel.add(id); else return toast(t('Up to 5 chats')); b.classList.toggle('picked', sel.has(id)); }));
  $('#fwgo', mm.el).onclick = async () => { if (!sel.size) return toast(t('Pick a chat')); mm.close(); try { const r = await api(`/api/messages/${m.id}/forward`, { body: { chat_ids: [...sel] } }); r.messages.forEach((x) => { App.upsertMessage(x); const c = S.chats.get(x.chat_id); if (c) c.last = x; }); App.renderList(); toast(t('Forwarded')); } catch (e) { toast(e.message); } };
};

// ---------- media gallery, starred ----------
App.mediaGallery = async (c) => {
  if (!c) return;
  const d = App.openDrawer(t('Media, links and docs'), `<div class="seg pad"><button class="on" data-k="media">${t('Media')}</button><button data-k="docs">${t('Docs')}</button><button data-k="links">${t('Links')}</button></div><div id="gal"></div>`);
  let r; try { r = await api(`/api/chats/${c.id}/media`); } catch (e) { toast(e.message); return; }
  let links = []; try { const all = S.msgs.get(c.id) || []; links = all.filter((m) => m.body && /https?:\/\//.test(m.body)); } catch {}
  const show = (k) => {
    $$('.seg button', d.body).forEach((b) => b.classList.toggle('on', b.dataset.k === k)); const g = $('#gal', d.body);
    if (k === 'media') { const list = r.messages.filter((m) => ['image', 'video'].includes(m.type)); g.innerHTML = list.length ? `<div class="grid">${list.map((m) => `<button class="gi" data-m="${m.id}">${m.type === 'image' ? `<img src="${fileUrl(m.file_id)}" loading="lazy">` : `${m.meta.thumb ? `<img src="${fileUrl(m.meta.thumb)}" loading="lazy">` : ''}<span class="vbadge">${ICON.video}</span>`}</button>`).join('')}</div>` : `<div class="empty"><p>${t('No media')}</p></div>`; $$('[data-m]', g).forEach((b) => (b.onclick = () => { const m = list.find((x) => String(x.id) === b.dataset.m); App.openViewer(m); })); }
    if (k === 'docs') { const list = r.messages.filter((m) => ['file', 'audio', 'voice'].includes(m.type)); g.innerHTML = `<div class="list">${list.map((m) => `<a class="row" href="${fileUrl(m.file_id, true)}" download data-dl="${m.id}"><span class="ic">${ICON.doc}</span><span class="row-main"><b>${esc(m.meta.name || t('Voice message'))}</b><span class="sub">${fmtSize(m.meta.size)} · ${fmtDay(m.deliver_at)}</span></span><span class="ic">${ICON.download}</span></a>`).join('') || `<div class="empty"><p>${t('No documents')}</p></div>`}</div>`; $$('[data-dl]', g).forEach((a) => (a.onclick = (e) => { e.preventDefault(); const m = list.find((x) => String(x.id) === a.dataset.dl); if (m) App.downloadFile(m); })); }
    if (k === 'links') { g.innerHTML = `<div class="list">${links.map((m) => (m.body.match(/https?:\/\/[^\s]+/g) || []).map((u) => `<a class="row" href="${esc(u)}" target="_blank" rel="noopener"><span class="ic">${ICON.globe}</span><span class="row-main"><span class="sub">${esc(u)}</span></span></a>`).join('')).join('') || `<div class="empty"><p>${t('No links in loaded messages')}</p></div>`}</div>`; }
  };
  $$('.seg button', d.body).forEach((b) => (b.onclick = () => show(b.dataset.k))); show('media');
};
App.starred = async () => {
  const d = App.openDrawer(t('Starred messages'), `<div class="loading">${t('Loading…')}</div>`);
  try { const r = await api('/api/starred'); d.body.innerHTML = `<div class="list">${r.messages.map((m) => { const c = S.chats.get(m.chat_id); return `<button class="row" data-m="${m.id}" data-c="${m.chat_id}"><span class="row-main"><span class="row-top"><b>${esc(nameOf(m.sender_id))}${c ? ' → ' + esc(chatTitle(c)) : ''}</b><span class="tm">${fmtDay(m.deliver_at)}</span></span><span class="sub">${esc(previewText(m))}</span></span></button>`; }).join('') || `<div class="empty"><p>${ICON.star}<br>${t('Tap and hold any message, then Star it to find it here.')}</p></div>`}</div>`;
    $$('[data-m]', d.body).forEach((b) => (b.onclick = async () => { App.closeAllDrawers(); await App.openChat(b.dataset.c); setTimeout(() => App.loadUntil(b.dataset.c, +b.dataset.m), 300); })); } catch (e) { toast(e.message); }
};

// ---------- end-to-end encryption: status line, safety number ----------
App.encStatus = async (c) => {
  const E = App.E2E; if (!E) return '';
  if (c.channel) return t('Channel messages are not end-to-end encrypted.');
  if (!E.ready) return t('Locked on this device: tap to unlock');
  if (await E.readyFor(c.id)) return c.type === 'direct' ? t('Messages are end-to-end encrypted. Tap to verify.') : t('Messages are end-to-end encrypted.');
  const miss = (await E.missing(c.id)) || []; return miss.length ? t('Not yet: {n} needs to open the updated AverChat', { n: miss.slice(0, 3).join(', ') }) : t('Not end-to-end encrypted yet.');
};
App.encInfo = async (c, u) => {
  const E = App.E2E; if (!E) return; if (!E.ready) return E.ask();
  let code = '';
  if (c.type === 'direct') { try { const d = await E.chatKeys(c.id, true); const peer = d.members.find((m) => m.id !== S.me.id); if (peer && peer.pub) code = await E.safetyNumber(E.key.pub, peer.pub); } catch {} }
  const ready = await E.readyFor(c.id);
  openModal(`<div class="dlg"><h3>🔒 ${t('End-to-end encryption')}</h3>
    <p class="fine">${ready ? t('Messages, photos, videos, voice notes and files in this chat are encrypted on your phone and can only be opened on the phones of the people in this chat. The AverChat server and admin cannot read them. Calls are encrypted directly between the two phones.') : t('This chat is not end-to-end encrypted yet, because someone in it has not opened the updated AverChat. Older messages from before the update are not end-to-end encrypted either.')}</p>
    ${code ? `<div class="sect">${t('Security code with {n}', { n: esc((u && u.name) || '') })}</div><div style="font:600 17px/1.7 ui-monospace,monospace;letter-spacing:1px;text-align:center;padding:8px 0">${code}</div><p class="fine">${t('Compare this code with the one on your contact’s phone (in person or on a call). If they match, nobody is in the middle.')}</p>` : ''}
    <div class="dlg-btns"><button class="btn" data-close>${t('OK')}</button></div></div>`);
};
