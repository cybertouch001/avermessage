// Avermessage — chat view: messages, composer, actions.
import { goBack, popModal, App, S, LS, t, $, $$, esc, el, api, toast, avatar, ICON, fmtTime, fmtDay, dayKey, fmtLastSeen, fmtSize, fmtDur, linkify, emojiOnly, colorFor, previewText, chatTitle, chatAvatarObj, nameOf, sheet, confirmBox, prompt2, openModal, longPress, fileUrl, uid, callLabel, sysText, dLabel, WALLPAPERS, isApp } from './util.js';
import './info.js';

const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
let replyTo = null, editing = null, lastReadSent = 0, typingSentAt = 0, typingStopT = null, loadingOlder = false;

App.isLockedView = () => { const c = S.open && S.chats.get(S.open); return !!(c && c.locked && !S.unlocked); };
App.askPin = async () => {
  if (!S.me.has_pin) { toast(t('Set a chat-lock PIN in Settings → Privacy first')); return false; }
  const pin = await prompt2(t('Enter your chat-lock PIN'), { type: 'password', max: 6, placeholder: '••••' }); if (pin === null) return false;
  try { await api('/api/me/pin/verify', { body: { pin } }); S.unlocked = true; clearTimeout(App._relock); App._relock = setTimeout(() => { S.unlocked = false; App.renderList(); }, 5 * 60000); return true; } catch (e) { toast(e.message); return false; }
};

// ---------- open / close ----------
App.openChat = async (id) => {
  const c = S.chats.get(id); if (!c) return;
  if (c.locked && !S.unlocked && !(await App.askPin())) return;
  const wasOpen = !!S.open;
  if (S.open !== id) { replyTo = null; editing = null; }
  S.open = id; lastReadSent = 0;
  if (!wasOpen) history.pushState({ chat: id }, ''); else history.replaceState({ chat: id }, '');
  document.body.classList.add('in-chat');
  renderChat(c);
  App.renderList();
  if (!S.msgs.has(id)) await loadMessages(id); else renderMessages(true);
  App.markRead(); App.kick();
};
App.closeChat = (fromPop) => {
  if (!S.open) return; S.open = null; document.body.classList.remove('in-chat'); stopTyping();
  $('#main').innerHTML = `<div class="empty-main"><img src="/icons/icon-192.png" alt=""><h2>Avermessage</h2><p>${t('Pick a chat to start messaging.')}</p></div>`;
  App.renderList(); if (!fromPop) goBack();
};
async function loadMessages(id, before) {
  const r = await api(`/api/chats/${id}/messages?limit=50${before ? '&before=' + before : ''}`);
  const arr = S.msgs.get(id) || [];
  const have = new Set(arr.map((m) => m.id));
  for (const m of r.messages) { S.seen.add(m.id); if (!have.has(m.id)) arr.push(m); }
  arr.sort(cmp); S.msgs.set(id, arr); S.more.set(id, r.more);
  const mp = S.receipts.get(id) || new Map(); for (const rc of r.receipts) mp.set(rc.user_id, { chat_id: id, ...rc }); S.receipts.set(id, mp);
  if (S.open === id) renderMessages(!before, before);
}
const cmp = (a, b) => a.deliver_at - b.deliver_at || (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0);

// ---------- upsert from sync / sends ----------
App.upsertMessage = (m) => {
  S.seen.add(m.id);
  const arr = S.msgs.get(m.chat_id); if (!arr) return;
  let i = arr.findIndex((x) => x.id === m.id || (m.client_id && x.client_id === m.client_id && x.pending));
  if (i >= 0) { if (!arr[i].pending && arr[i].ver > m.ver) return; arr[i] = m; } else { arr.push(m); arr.sort(cmp); }
  if (m.client_id) S.pending.delete(m.client_id);
  if (m.expires_at && m.expires_at <= Date.now()) { arr.splice(arr.indexOf(m), 1); }
  if (S.open === m.chat_id) placeMessage(m, i < 0);
};
App.removeMessage = (chatId, id) => { const arr = S.msgs.get(chatId); if (!arr) return; const i = arr.findIndex((x) => x.id === id); if (i >= 0) arr.splice(i, 1); const n = $(`.msg[data-id="${id}"]`); if (n) n.remove(); };

// ---------- header ----------
function renderChat(c) {
  const wp = c.wallpaper || (S.me.settings && S.me.settings.wallpaper) || 'default';
  $('#main').innerHTML = `<div class="chat wp-${esc(wp)}" id="chat">
    <header class="bar chat-bar"><button class="ib back" id="c-back">${ICON.back}</button><button class="chat-who" id="c-who"><span id="c-av"></span><span class="who-txt"><b id="c-title"></b><span id="c-sub" class="sub"></span></span></button>
      <div class="bar-btns"><button class="ib" id="c-video" title="${t('Video call')}">${ICON.video}</button><button class="ib" id="c-voice" title="${t('Voice call')}">${ICON.phone}</button><button class="ib" id="c-menu">${ICON.more}</button></div></header>
    <div id="c-pinned"></div><div id="c-sched"></div>
    <div class="msgs" id="msgs"><div class="msgs-inner" id="msgs-in"></div></div>
    <button class="jump hidden" id="jump">⌄<span class="badge" id="jumpn"></span></button>
    <div id="c-compose"></div>
  </div>`;
  $('#c-back').onclick = () => App.closeChat();
  $('#c-who').onclick = () => App.chatInfo(c.id);
  $('#c-menu').onclick = () => chatMenu(c.id);
  $('#c-voice').onclick = () => startCall(c, 'voice'); $('#c-video').onclick = () => startCall(c, 'video');
  const box = $('#msgs');
  box.addEventListener('scroll', () => { if (box.scrollTop < 120 && S.more.get(c.id) && !loadingOlder) loadOlder(c.id); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160; $('#jump').classList.toggle('hidden', nearBottom); if (nearBottom) { $('#jumpn').textContent = ''; App.markRead(); } });
  $('#jump').onclick = () => { box.scrollTop = box.scrollHeight; };
  App.refreshChatHeader(); renderComposer(); renderPinned(); renderSchedChip();
}
function startCall(c, kind) {
  if (c.type === 'group') return toast(t('Group calls are not available yet — call members one-to-one.'));
  if (c.left) return; App.startCall(c.peer_id, kind);
}
App.refreshChatHeader = () => {
  const c = S.open && S.chats.get(S.open); if (!c || !$('#c-title')) return;
  $('#c-av').innerHTML = avatar(chatAvatarObj(c), 40); $('#c-title').textContent = chatTitle(c);
  const ty = (S.typing.get(c.id) || []);
  let sub = '';
  if (ty.length) sub = `<span class="typing">${ty[0].kind === 'recording' ? (c.type === 'group' ? esc(nameOf(ty[0].user_id)) + ' ' : '') + t('recording audio…') : c.type === 'group' ? esc(ty.map((x) => nameOf(x.user_id)).join(', ')) + ' ' + t('is typing…') : t('typing…')}</span>`;
  else if (c.type === 'direct') { const u = S.users.get(c.peer_id); sub = u && u.blocked ? t('Blocked') : esc(fmtLastSeen(u)); }
  else sub = c.left ? t('You are no longer a member') : esc(c._memberNames || t('{n} members', { n: c.member_count }));
  $('#c-sub').innerHTML = sub;
  $('#c-voice').classList.toggle('hidden', c.type === 'group'); $('#c-video').classList.toggle('hidden', c.type === 'group');
};
App.reloadOpenChatMeta = () => { const c = S.open && S.chats.get(S.open); if (!c) return; App.refreshChatHeader(); renderPinned(); renderComposer(true); const ch = $('#chat'); if (ch) ch.className = 'chat wp-' + (c.wallpaper || (S.me.settings && S.me.settings.wallpaper) || 'default'); };
App.onChatChanged = () => { updateTicks(); };

// ---------- message list ----------
function renderMessages(toBottom, keepFrom) {
  const c = S.chats.get(S.open); const inner = $('#msgs-in'); if (!c || !inner) return;
  const box = $('#msgs'); const oldH = box.scrollHeight, oldTop = box.scrollTop;
  const arr = (S.msgs.get(S.open) || []).filter((m) => !m.expires_at || m.expires_at > Date.now());
  let html = ''; let prev = null;
  if (c.disappearing) html += `<div class="sysmsg">${ICON.timer} ${t('Disappearing messages are on ({d}). New messages vanish after that time.', { d: dLabel(c.disappearing) })}</div>`;
  html += `<div class="sysmsg enc">${ICON.shield} ${t('Messages are sent over an encrypted connection and stored on the Avermessage server (not end-to-end encrypted).')}</div>`;
  for (const m of arr) { if (!prev || dayKey(prev.deliver_at) !== dayKey(m.deliver_at)) html += `<div class="daysep"><span>${fmtDay(m.deliver_at)}</span></div>`; html += msgHtml(m, prev, c); prev = m; }
  inner.innerHTML = html; bindMsgs(inner);
  if (toBottom) box.scrollTop = box.scrollHeight; else if (keepFrom) box.scrollTop = box.scrollHeight - oldH + oldTop;
  // images loading late: keep at bottom
  if (toBottom) $$('img', inner).forEach((i) => i.addEventListener('load', () => { if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight; }, { once: true }));
}
function placeMessage(m, isNew) {
  const inner = $('#msgs-in'); if (!inner) return;
  const box = $('#msgs'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  const old = $(`.msg[data-id="${m.id}"]`, inner) || (m.client_id ? $(`.msg[data-cid="${m.client_id}"]`, inner) : null);
  if (old && !isNew) {
    if (old.querySelector('audio') && !old.querySelector('audio').paused && m.type === 'voice') { old.dataset.id = m.id; updateTicks(); return; }
    const arr = S.msgs.get(S.open) || []; const i = arr.findIndex((x) => x.id === m.id); const n = el(msgHtml(m, arr[i - 1], S.chats.get(S.open))); old.replaceWith(n); bindMsgs(n.parentElement, n); return;
  }
  renderMessages(false); const mine = m.sender_id === S.me.id;
  if (atBottom || mine) box.scrollTop = box.scrollHeight; else { const j = $('#jumpn'); j.textContent = (+j.textContent || 0) + 1; $('#jump').classList.remove('hidden'); }
}
async function loadOlder(id) { const arr = S.msgs.get(id) || []; const first = arr.find((m) => !m.pending); if (!first) return; loadingOlder = true; try { await loadMessages(id, first.deliver_at); } catch {} loadingOlder = false; }
App.loadUntil = async (id, msgId) => { for (let i = 0; i < 20; i++) { if ((S.msgs.get(id) || []).some((m) => m.id === msgId)) break; if (!S.more.get(id)) break; await loadOlder(id); } App.scrollToMsg(msgId); };
App.scrollToMsg = (id) => { const n = $(`.msg[data-id="${id}"]`); if (!n) return toast(t('Message not found')); n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1600); };

export function ticks(m, c) {
  if (m.pending) return `<span class="ticks pend">${m.failed ? '⚠️' : ICON.clock}</span>`;
  if (m.deliver_at > Date.now()) return `<span class="ticks pend">${ICON.sched}</span>`;
  const mp = S.receipts.get(m.chat_id); const others = mp ? [...mp.values()].filter((r) => !r.left_at || r.left_at > m.deliver_at) : [];
  if (!others.length) return `<span class="ticks">${ICON.tick1}</span>`;
  const read = others.every((r) => r.read_upto >= m.deliver_at); const dlv = others.every((r) => r.delivered_upto >= m.deliver_at || r.read_upto >= m.deliver_at);
  return `<span class="ticks ${read ? 'read' : ''}" title="${read ? t('Read') : dlv ? t('Delivered') : t('Sent')}">${dlv || read ? ICON.tick2 : ICON.tick1}</span>`;
}
App.ticks = ticks;
function updateTicks() { const c = S.chats.get(S.open); if (!c) return; for (const m of S.msgs.get(S.open) || []) if (m.sender_id === S.me.id) { const n = $(`.msg[data-id="${m.id}"] .ticks`); if (n) n.outerHTML = ticks(m, c); } }

function msgHtml(m, prev, c) {
  if (m.type === 'system') return `<div class="sysmsg msg" data-id="${m.id}">${esc(sysText(m))}</div>`;
  const mine = m.sender_id === S.me.id; const grp = c.type === 'group';
  const first = !prev || prev.sender_id !== m.sender_id || prev.type === 'system' || dayKey(prev.deliver_at) !== dayKey(m.deliver_at) || m.deliver_at - prev.deliver_at > 5 * 60000;
  let inner = '';
  if (grp && !mine && first) inner += `<div class="sender" style="color:${colorFor(m.sender_id)}">${esc(nameOf(m.sender_id))}</div>`;
  if (m.deleted) inner += `<div class="txt del">🚫 <i>${mine ? t('You deleted this message') : m.meta && m.meta.by_admin ? t('This message was deleted by admin {n}', { n: m.meta.by_admin }) : t('This message was deleted')}</i></div>`;
  else {
    if (m.forwarded) inner += `<div class="fwd">${ICON.fwd} ${t('Forwarded')}</div>`;
    if (m.reply) inner += `<button class="quote" data-q="${m.reply.id}" style="border-color:${colorFor(m.reply.sender_id)}"><b style="color:${colorFor(m.reply.sender_id)}">${esc(nameOf(m.reply.sender_id))}</b><span>${esc(m.reply.deleted ? t('This message was deleted') : previewText({ ...m.reply, meta: m.reply.meta || {} }))}</span></button>`;
    inner += App.mediaHtml ? App.mediaHtml(m) : '';
    if (m.type === 'poll') inner += pollHtml(m, c);
    if (m.type === 'call') inner += `<div class="callmsg ${m.meta.status === 'missed' && !mine ? 'missed' : ''}">${m.meta.kind === 'video' ? ICON.video : ICON.phone}<span>${esc(callLabel(m))}</span></div>`;
    if (m.body && m.type !== 'poll') inner += `<div class="txt ${emojiOnly(m.body) && m.type === 'text' ? 'big' : ''}">${linkify(m.body)}</div>`;
  }
  const meta = `<span class="meta">${m.starred ? `<i class="st">${ICON.star}</i>` : ''}${m.edited_at && !m.deleted ? `<i>${t('edited')}</i>` : ''}${m.expires_at ? `<i class="st">${ICON.timer}</i>` : ''}${fmtTime(m.deliver_at)}${mine && !m.deleted && m.type !== 'call' ? ticks(m, c) : ''}</span>`;
  const reacts = (m.reactions || []).length ? `<button class="reacts" data-r>${[...new Set(m.reactions.map((r) => r.emoji))].slice(0, 4).join('')}${m.reactions.length > 1 ? `<span>${m.reactions.length}</span>` : ''}</button>` : '';
  const media = ['image', 'video'].includes(m.type) && !m.body && !m.deleted;
  return `<div class="msg ${mine ? 'out' : 'in'} ${first ? 'first' : ''} ${m.pending ? 'pending' : ''} ${media ? 'media-only' : ''}" data-id="${m.id}" ${m.client_id ? `data-cid="${esc(m.client_id)}"` : ''}><div class="bubble">${inner}${meta}</div>${reacts}</div>`;
}
function pollHtml(m, c) {
  const votes = m.votes || []; const total = new Set(votes.map((v) => v.user_id)).size; const mine = new Set(votes.filter((v) => v.user_id === S.me.id).map((v) => v.opt));
  return `<div class="poll"><div class="pq">📊 ${esc(m.meta.question)}</div><div class="fine">${m.meta.multi ? t('Select one or more') : t('Select one')}</div>${m.meta.options.map((o, i) => { const n = votes.filter((v) => v.opt === i).length; const pct = total ? Math.round((n / total) * 100) : 0; return `<button class="popt ${mine.has(i) ? 'on' : ''}" data-opt="${i}"><span class="pchk">${mine.has(i) ? ICON.check : ''}</span><span class="ptxt">${esc(o)}</span><span class="pn">${n}</span><span class="pbar" style="width:${pct}%"></span></button>`; }).join('')}<button class="linkbtn pv" data-pv>${t('View votes')} (${total})</button></div>`;
}
function bindMsgs(root, only) {
  const nodes = only ? [only] : $$('.msg', root);
  for (const n of nodes) {
    if (n.classList.contains('sysmsg')) continue;
    const id = n.dataset.id; const get = () => (S.msgs.get(S.open) || []).find((x) => String(x.id) === String(n.dataset.id));
    longPress(n.querySelector('.bubble'), () => { const m = get(); if (m) msgMenu(m); });
    n.addEventListener('dblclick', (e) => { if (e.target.closest('a,button,audio,video')) return; const m = get(); if (m && !m.pending && !m.deleted) react(m, '❤️'); });
    const q = n.querySelector('.quote'); if (q) q.onclick = () => App.loadUntil(S.open, +q.dataset.q);
    const r = n.querySelector('[data-r]'); if (r) r.onclick = () => { const m = get(); if (m) App.showReactions(m); };
    n.querySelectorAll('.popt').forEach((b) => (b.onclick = () => { const m = get(); if (m) vote(m, +b.dataset.opt); }));
    const pv = n.querySelector('[data-pv]'); if (pv) pv.onclick = () => { const m = get(); if (m) App.pollVotes(m); };
    App.bindMedia && App.bindMedia(n, get);
    swipeReply(n, get);
  }
}
function swipeReply(n, get) {
  let sx = 0, sy = 0, dx = 0, on = false; const b = n.querySelector('.bubble');
  n.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; on = true; }, { passive: true });
  n.addEventListener('touchmove', (e) => { if (!on) return; dx = e.touches[0].clientX - sx; const dy = Math.abs(e.touches[0].clientY - sy); if (dy > 30) { on = false; b.style.transform = ''; return; } if (dx > 0) b.style.transform = `translateX(${Math.min(dx, 80)}px)`; }, { passive: true });
  n.addEventListener('touchend', () => { if (on && dx > 60) { const m = get(); if (m && !m.pending && !m.deleted) setReply(m); } b.style.transform = ''; on = false; }, { passive: true });
}
async function vote(m, opt) {
  const mine = new Set((m.votes || []).filter((v) => v.user_id === S.me.id).map((v) => v.opt));
  let opts; if (m.meta.multi) { mine.has(opt) ? mine.delete(opt) : mine.add(opt); opts = [...mine]; } else opts = mine.has(opt) ? [] : [opt];
  try { const r = await api(`/api/messages/${m.id}/vote`, { body: { options: opts } }); App.upsertMessage(r.message); } catch (e) { toast(e.message); }
}
async function react(m, emoji) {
  const mine = (m.reactions || []).find((r) => r.user_id === S.me.id);
  const e = mine && mine.emoji === emoji ? null : emoji;
  try { const r = await api(`/api/messages/${m.id}/react`, { body: { emoji: e } }); App.upsertMessage(r.message); } catch (er) { toast(er.message); }
}
App.react = react;

// ---------- message menu ----------
function msgMenu(m) {
  if (m.pending) { if (m.failed) sheet('', [{ icon: ICON.send, label: t('Retry'), run: () => App.retrySend(m) }, { icon: ICON.trash, label: t('Delete'), danger: true, run: () => App.removeMessage(m.chat_id, m.id) }]); return; }
  const mine = m.sender_id === S.me.id; const c = S.chats.get(m.chat_id);
  const canEdit = mine && m.type === 'text' && !m.deleted && Date.now() - m.deliver_at < 15 * 60000;
  const canAll = !m.deleted && !['call'].includes(m.type) && ((mine && Date.now() - m.deliver_at < 24 * 3600000) || (c.type === 'group' && c.my_role === 'admin'));
  const pinned = (c.pinned_msgs || []).includes(m.id);
  const items = [];
  if (!m.deleted && !c.left) items.push({ icon: ICON.reply, label: t('Reply'), run: () => setReply(m) });
  if (m.body && !m.deleted) items.push({ icon: ICON.copy, label: t('Copy'), run: () => { navigator.clipboard && navigator.clipboard.writeText(m.body).then(() => toast(t('Copied'))); } });
  if (!m.deleted && !['call'].includes(m.type)) items.push({ icon: ICON.fwd, label: t('Forward'), run: () => App.forward(m) });
  if (!m.deleted) items.push({ icon: ICON.star, label: m.starred ? t('Unstar') : t('Star'), run: async () => { try { const r = await api(`/api/messages/${m.id}/star`, { body: { on: !m.starred } }); App.upsertMessage(r.message); } catch (e) { toast(e.message); } } });
  if (!m.deleted && !c.left && m.type !== 'call') items.push({ icon: ICON.pin, label: pinned ? t('Unpin') : t('Pin'), run: async () => { try { const r = await api(`/api/messages/${m.id}/pin`, { body: { on: !pinned } }); c.pinned_msgs = r.pinned; renderPinned(); } catch (e) { toast(e.message); } } });
  if (canEdit) items.push({ icon: ICON.edit, label: t('Edit'), run: () => setEdit(m) });
  if (mine && !m.deleted) items.push({ icon: ICON.info, label: t('Info'), run: () => App.msgInfo(m) });
  if (m.file_id && !m.deleted) items.push({ icon: ICON.download, label: t('Download'), run: () => { const a = document.createElement('a'); a.href = fileUrl(m.file_id, true); a.download = m.meta.name || ''; document.body.appendChild(a); a.click(); a.remove(); } });
  items.push({ icon: ICON.trash, label: t('Delete'), danger: true, run: () => delMenu(m, canAll) });
  const m0 = sheet(`<div class="qreact">${QUICK.map((e) => `<button data-e="${e}">${e}</button>`).join('')}<button data-e="+">＋</button></div>`, items);
  setTimeout(() => $$('.qreact button').forEach((b) => (b.onclick = () => { App.closeTop(); if (b.dataset.e === '+') App.emojiPicker((e) => react(m, e)); else react(m, b.dataset.e); })), 20);
}
App.closeTop = () => popModal();
async function delMenu(m, canAll) {
  const items = [{ label: t('Delete for me'), run: async () => { try { await api(`/api/messages/${m.id}/delete`, { body: { for: 'me' } }); App.removeMessage(m.chat_id, m.id); } catch (e) { toast(e.message); } } }];
  if (canAll) items.unshift({ label: t('Delete for everyone'), danger: true, run: async () => { try { await api(`/api/messages/${m.id}/delete`, { body: { for: 'everyone' } }); App.upsertMessage({ ...m, deleted: true, body: '', file_id: null, reactions: [], ver: Date.now() }); } catch (e) { toast(e.message); } } });
  sheet(t('Delete message?'), items);
}

// ---------- pinned / scheduled ----------
function renderPinned() {
  const c = S.chats.get(S.open); const box = $('#c-pinned'); if (!c || !box) return;
  const pins = (c.pinned_msgs || []); if (!pins.length) { box.innerHTML = ''; return; }
  const idx = (box._i || 0) % pins.length; const id = pins[pins.length - 1 - idx]; const m = (S.msgs.get(S.open) || []).find((x) => x.id === id);
  box.innerHTML = `<button class="pinbar">${ICON.pin}<span><b>${t('Pinned message')}${pins.length > 1 ? ` ${idx + 1}/${pins.length}` : ''}</b><span class="sub">${m ? esc(previewText(m)) : t('Tap to view')}</span></span></button>`;
  box.querySelector('button').onclick = () => { App.loadUntil(S.open, id); box._i = idx + 1; setTimeout(renderPinned, 400); };
}
App.renderPinned = renderPinned;
async function renderSchedChip() {
  const c = S.chats.get(S.open); const box = $('#c-sched'); if (!c || !box || c.left) return;
  try { const r = await api(`/api/chats/${c.id}/scheduled`); if (S.open !== c.id) return; box.innerHTML = r.messages.length ? `<button class="schedbar">${ICON.sched} ${t('{n} scheduled message(s)', { n: r.messages.length })}</button>` : ''; const b = box.querySelector('button'); if (b) b.onclick = () => schedList(c, r.messages); } catch {}
}
App.renderSchedChip = renderSchedChip;
function schedList(c, list) {
  const m = openModal(`<div class="dlg"><h3>${t('Scheduled messages')}</h3><div class="list">${list.map((x) => `<div class="row"><span class="row-main"><b>${esc(new Date(x.deliver_at).toLocaleString())}</b><span class="sub">${esc(previewText(x))}</span></span><button class="ib" data-del="${x.id}">${ICON.trash}</button></div>`).join('')}</div><div class="dlg-btns"><button class="btn" data-close>${t('Close')}</button></div></div>`);
  $$('[data-del]', m.el).forEach((b) => (b.onclick = async () => { try { await api(`/api/messages/${b.dataset.del}/delete`, { body: { for: 'everyone' } }); b.closest('.row').remove(); renderSchedChip(); toast(t('Scheduled message cancelled')); } catch (e) { toast(e.message); } }));
}

// ---------- composer ----------
function renderComposer(soft) {
  const c = S.chats.get(S.open); const box = $('#c-compose'); if (!c || !box) return;
  if (soft && box.querySelector('.recbar')) return; // never wipe an active voice recording
  const u = c.type === 'direct' ? S.users.get(c.peer_id) : null;
  if (c.left) { box.innerHTML = `<div class="composer-note">${t('You can’t send messages to this group because you’re no longer a member.')}</div>`; return; }
  if (u && u.blocked) { box.innerHTML = `<div class="composer-note">${t('You blocked this contact.')} <button class="linkbtn" id="unb">${t('Unblock')}</button></div>`; $('#unb').onclick = async () => { await api(`/api/users/${u.id}/block`, { body: { on: false } }); u.blocked = false; renderComposer(); }; return; }
  if (c.type === 'group' && c.only_admins && c.my_role !== 'admin') { box.innerHTML = `<div class="composer-note">${t('Only admins can send messages.')}</div>`; return; }
  if (soft && $('#ta')) return;
  box.innerHTML = `<div id="ctx"></div><div class="composer"><div class="cbox"><button class="ib" id="b-emoji">${ICON.emoji}</button><textarea id="ta" rows="1" placeholder="${t('Message')}" maxlength="10000"></textarea><button class="ib" id="b-attach">${ICON.attach}</button><button class="ib" id="b-cam">${ICON.camera}</button></div><button class="sendbtn" id="b-send">${ICON.mic}</button></div>
    <input type="file" id="f-media" accept="image/*,video/*" multiple hidden><input type="file" id="f-doc" multiple hidden><input type="file" id="f-cam" accept="image/*" capture="environment" hidden>`;
  const ta = $('#ta'); const send = $('#b-send');
  const draft = LS.get('draft-' + c.id, ''); if (draft) ta.value = draft;
  const sync = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; const has = ta.value.trim().length > 0; send.innerHTML = has || editing ? ICON.send : ICON.mic; send.classList.toggle('rec', !has && !editing); };
  sync();
  ta.oninput = () => { sync(); if (!editing) LS.set('draft-' + c.id, ta.value); sendTyping(); };
  ta.onkeydown = (e) => { const enterSends = S.me.settings && S.me.settings.enter_send !== undefined ? S.me.settings.enter_send : !('ontouchstart' in window); if (e.key === 'Enter' && !e.shiftKey && enterSends) { e.preventDefault(); doSend(); } if (e.key === 'Escape') { setReply(null); setEdit(null); } };
  send.onclick = () => { if (ta.value.trim() || editing) doSend(); else App.startRecording(c); };
  let schedTm; send.addEventListener('contextmenu', (e) => { e.preventDefault(); if (ta.value.trim()) scheduleSend(); });
  send.addEventListener('touchstart', () => { if (ta.value.trim()) schedTm = setTimeout(() => { schedTm = 'fired'; scheduleSend(); }, 600); }, { passive: true });
  send.addEventListener('touchend', (e) => { if (schedTm === 'fired') { e.preventDefault(); } clearTimeout(schedTm); schedTm = null; });
  $('#b-emoji').onclick = () => App.emojiPicker((e) => { const p = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, p) + e + ta.value.slice(p); ta.focus(); sync(); }, true);
  $('#b-attach').onclick = () => attachMenu(c);
  $('#b-cam').onclick = () => $('#f-cam').click();
  $('#f-media').onchange = (e) => { App.sendFiles(c, [...e.target.files], 'media'); e.target.value = ''; };
  $('#f-doc').onchange = (e) => { App.sendFiles(c, [...e.target.files], 'doc'); e.target.value = ''; };
  $('#f-cam').onchange = (e) => { App.sendFiles(c, [...e.target.files], 'media'); e.target.value = ''; };
  ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); App.sendFiles(c, files, 'media'); } });
  const drop = $('#chat'); drop.ondragover = (e) => { e.preventDefault(); }; drop.ondrop = (e) => { e.preventDefault(); const f = [...e.dataTransfer.files]; if (f.length) App.sendFiles(c, f, 'auto'); };
  renderCtx();
}
App.renderComposer = renderComposer;
function attachMenu(c) {
  sheet('', [
    { icon: ICON.image, label: t('Photos & videos'), run: () => $('#f-media').click() },
    { icon: ICON.camera, label: t('Camera'), run: () => $('#f-cam').click() },
    { icon: ICON.doc, label: t('Document'), run: () => $('#f-doc').click() },
    c.type === 'group' ? { icon: ICON.poll, label: t('Poll'), run: () => App.newPoll(c) } : null,
    { icon: ICON.sched, label: t('Schedule a message'), run: () => scheduleSend(true) },
  ]);
}
function renderCtx() {
  const box = $('#ctx'); if (!box) return;
  if (editing) box.innerHTML = `<div class="ctxbar">${ICON.edit}<span><b>${t('Edit message')}</b><span class="sub">${esc(editing.body.slice(0, 80))}</span></span><button class="ib sm" id="ctx-x">${ICON.close}</button></div>`;
  else if (replyTo) box.innerHTML = `<div class="ctxbar" style="border-color:${colorFor(replyTo.sender_id)}">${ICON.reply}<span><b style="color:${colorFor(replyTo.sender_id)}">${esc(nameOf(replyTo.sender_id))}</b><span class="sub">${esc(previewText(replyTo))}</span></span><button class="ib sm" id="ctx-x">${ICON.close}</button></div>`;
  else box.innerHTML = '';
  const x = $('#ctx-x'); if (x) x.onclick = () => { if (editing) { setEdit(null); $('#ta').value = LS.get('draft-' + S.open, ''); } setReply(null); };
}
function setReply(m) { replyTo = m; editing = null; renderCtx(); if (m) $('#ta') && $('#ta').focus(); }
function setEdit(m) { editing = m; replyTo = null; renderCtx(); const ta = $('#ta'); if (ta && m) { ta.value = m.body; ta.focus(); ta.dispatchEvent(new Event('input')); } }
App.setReply = setReply;
async function doSend(deliverAt) {
  const c = S.chats.get(S.open); const ta = $('#ta'); if (!c || !ta) return;
  const text = ta.value.trim(); if (!text) return;
  if (editing) { const m = editing; setEdit(null); ta.value = LS.get('draft-' + c.id, ''); ta.dispatchEvent(new Event('input')); try { const r = await api(`/api/messages/${m.id}`, { method: 'PATCH', body: { body: text } }); App.upsertMessage(r.message); } catch (e) { toast(e.message); } return; }
  ta.value = ''; LS.set('draft-' + c.id, ''); ta.dispatchEvent(new Event('input')); stopTyping();
  const rep = replyTo; setReply(null);
  await App.sendMessage(c, { type: 'text', body: text, reply_to: rep ? rep.id : undefined, deliver_at: deliverAt }, rep);
}
async function scheduleSend(fromMenu) {
  const ta = $('#ta'); if (!ta) return;
  if (fromMenu && !ta.value.trim()) { const txt = await prompt2(t('Message to schedule'), { multiline: true, max: 2000 }); if (!txt) return; ta.value = txt; }
  if (!ta.value.trim()) return;
  const d = new Date(Date.now() + 3600000); d.setSeconds(0, 0); const local = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const m = openModal(`<form class="dlg"><h3>${ICON.sched} ${t('Schedule message')}</h3><p class="muted">${t('It will be delivered automatically at this time.')}</p><input class="inp" type="datetime-local" required value="${local}"><div class="dlg-btns"><button type="button" class="btn ghost" data-close>${t('Cancel')}</button><button class="btn">${t('Schedule')}</button></div></form>`);
  m.el.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const v = new Date(m.el.querySelector('input').value).getTime(); if (!(v > Date.now() + 30000)) return toast(t('Pick a time in the future')); m.close(); await doSend(v); toast(t('Message scheduled for {t}', { t: new Date(v).toLocaleString() })); renderSchedChip(); };
}
App.sendMessage = async (c, body, rep) => {
  const cid = uid(); const now = Date.now();
  const scheduled = body.deliver_at && body.deliver_at > now;
  const temp = { id: 'tmp-' + cid, client_id: cid, chat_id: c.id, sender_id: S.me.id, type: body.type, body: body.body || '', meta: body.meta || {}, file_id: body.file_id || null, reply: rep ? { id: rep.id, sender_id: rep.sender_id, type: rep.type, body: rep.body, meta: rep.meta } : null, deliver_at: now, created_at: now, reactions: [], pending: true, ver: 0, _body: body, ...(body._local || {}) };
  delete body._local;
  if (!scheduled) { S.pending.set(cid, temp); const arr = S.msgs.get(c.id) || []; arr.push(temp); S.msgs.set(c.id, arr); if (S.open === c.id) placeMessage(temp, true); }
  try {
    const r = await api(`/api/chats/${c.id}/messages`, { body: { ...body, client_id: cid } });
    if (!scheduled) { App.upsertMessage(r.message); c.last = r.message; App.renderList(); }
    return r.message;
  } catch (e) {
    if (scheduled) { toast(e.message); return null; }
    temp.failed = true; if (S.open === c.id) placeMessage(temp, false); toast(e.message); return null;
  }
};
App.retrySend = async (m) => { App.removeMessage(m.chat_id, m.id); S.pending.delete(m.client_id); const c = S.chats.get(m.chat_id); if (c) App.sendMessage(c, m._body); };
function sendTyping(kind = 'typing') {
  const now = Date.now(); clearTimeout(typingStopT); typingStopT = setTimeout(stopTyping, 5000);
  if (now - typingSentAt > 4000 && S.open) { typingSentAt = now; api(`/api/chats/${S.open}/typing`, { body: { kind } }).catch(() => {}); }
}
App.sendTyping = sendTyping;
function stopTyping() { clearTimeout(typingStopT); if (typingSentAt && S.open) { api(`/api/chats/${S.open}/typing`, { body: { kind: null } }).catch(() => {}); } typingSentAt = 0; }
App.stopTyping = stopTyping;

// ---------- read receipts ----------
App.markRead = () => {
  const c = S.open && S.chats.get(S.open); if (!c || document.hidden) return;
  const box = $('#msgs'); if (box && box.scrollHeight - box.scrollTop - box.clientHeight > 300) return;
  const arr = S.msgs.get(c.id) || []; const last = [...arr].reverse().find((m) => m.sender_id !== S.me.id && !m.pending);
  if (c.unread) { c.unread = 0; App.renderList(); App.updateBadges(); }
  if (!last || last.deliver_at <= lastReadSent) return; lastReadSent = last.deliver_at;
  api(`/api/chats/${c.id}/read`, { body: { upto: last.deliver_at } }).catch(() => {});
};
setInterval(() => { if (S.open) App.markRead(); const arr = S.open && S.msgs.get(S.open); if (arr && arr.some((m) => m.expires_at && m.expires_at < Date.now())) { S.msgs.set(S.open, arr.filter((m) => !m.expires_at || m.expires_at > Date.now())); renderMessages(false); } }, 3000);

// ---------- chat menu ----------
async function chatMenu(id) {
  const c = S.chats.get(id); const u = c.type === 'direct' ? S.users.get(c.peer_id) : null; const muted = c.muted_until > Date.now();
  sheet('', [
    { icon: ICON.info, label: c.type === 'group' ? t('Group info') : t('Contact info'), run: () => App.chatInfo(id) },
    { icon: ICON.search, label: t('Search'), run: () => chatSearch(c) },
    { icon: ICON.image, label: t('Media, links and docs'), run: () => App.mediaGallery(c) },
    !c.left ? { icon: ICON.timer, label: t('Disappearing messages'), run: () => App.disappearingMenu(c) } : null,
    { icon: ICON.mute, label: muted ? t('Unmute notifications') : t('Mute notifications'), run: () => (muted ? App.setPrefs(c, { muted_until: 0 }) : App.muteMenu(c)) },
    { icon: ICON.lock, label: c.locked ? t('Unlock chat') : t('Lock chat'), run: () => App.toggleLock(c) },
    { icon: ICON.wall, label: t('Wallpaper'), run: () => App.wallpaperMenu(c) },
    !c.left ? { icon: ICON.sched, label: t('Schedule a message'), run: () => scheduleSend(true) } : null,
    { icon: ICON.trash, label: t('Clear chat'), run: async () => { if (await confirmBox(t('Clear all messages in this chat (only for you)?'), t('Clear'), true)) { await api(`/api/chats/${id}/clear`, { body: {} }); S.msgs.set(id, []); c.last = null; renderMessages(true); App.renderList(); } } },
    u ? { icon: ICON.block, label: u.blocked ? t('Unblock') : t('Block'), danger: !u.blocked, run: () => App.toggleBlock(u) } : null,
    u ? { icon: ICON.flag, label: t('Report'), danger: true, run: () => App.report(u.id, c.id) } : null,
    c.type === 'group' && !c.left ? { icon: ICON.logout, label: t('Exit group'), danger: true, run: () => App.deleteOrExit(c) } : null,
  ]);
}
function chatSearch(c) {
  const d = App.openDrawer(t('Search messages'), `<div class="searchrow"><input id="sq" placeholder="${t('Search…')}" autocomplete="off"></div><div class="list" id="sres"></div>`);
  const q = $('#sq', d.el); let tm; setTimeout(() => q.focus(), 80);
  q.oninput = () => { clearTimeout(tm); tm = setTimeout(async () => { const v = q.value.trim(); if (!v) { $('#sres', d.el).innerHTML = ''; return; } try { const r = await api(`/api/chats/${c.id}/search?q=${encodeURIComponent(v)}`); const re = new RegExp('(' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'); $('#sres', d.el).innerHTML = r.messages.map((m) => `<button class="row" data-m="${m.id}"><span class="row-main"><span class="row-top"><b>${esc(nameOf(m.sender_id))}</b><span class="tm">${fmtDay(m.deliver_at)}</span></span><span class="sub">${esc(previewText(m)).replace(re, '<mark>$1</mark>')}</span></span></button>`).join('') || `<div class="empty"><p>${t('No messages found')}</p></div>`; $$('[data-m]', d.el).forEach((b) => (b.onclick = () => { d.close(); setTimeout(() => App.loadUntil(c.id, +b.dataset.m), 250); })); } catch (e) { toast(e.message); } }, 300); };
}
