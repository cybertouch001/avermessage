// AverChat — media: uploads, images, video, voice notes, viewer, emoji, notifications, sounds.
import { App, S, LS, t, $, $$, esc, el, api, upload, toast, ICON, fmtSize, fmtDur, fileUrl, openModal, isApp, plug, chatTitle, previewText, nameOf, avatar, chatAvatarObj } from './util.js';

App.uploadFile = (blob, scope, name, onProg) => upload(blob, scope, name, onProg);

// ---------- image helpers ----------
function loadImg(file) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(t('Could not read this image'))); i.src = URL.createObjectURL(file); }); }
async function compressImage(file, max = 1600, q = 0.85) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 200 * 1024) { try { const i = await loadImg(file); return { blob: file, w: i.naturalWidth, h: i.naturalHeight }; } catch { return { blob: file }; } }
  const i = await loadImg(file); let w = i.naturalWidth, h = i.naturalHeight; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(i, 0, 0, w, h);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q)); return { blob: blob && blob.size < file.size ? blob : file, w, h };
}
App.squareImage = async (file, size = 512) => {
  const i = await loadImg(file); const s = Math.min(i.naturalWidth, i.naturalHeight); const cv = document.createElement('canvas'); cv.width = cv.height = size;
  cv.getContext('2d').drawImage(i, (i.naturalWidth - s) / 2, (i.naturalHeight - s) / 2, s, s, 0, 0, size, size);
  return await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
};
function videoInfo(file) {
  return new Promise((res) => {
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.playsInline = true; let done = false;
    const fin = (o) => { if (!done) { done = true; res(o); } };
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => { try { const w = v.videoWidth, h = v.videoHeight; const s = Math.min(1, 480 / Math.max(w, h)); const cv = document.createElement('canvas'); cv.width = Math.round(w * s); cv.height = Math.round(h * s); cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height); cv.toBlob((b) => fin({ thumb: b, w, h, duration: v.duration }), 'image/jpeg', 0.75); } catch { fin({ duration: v.duration }); } };
    v.onerror = () => fin({}); setTimeout(() => fin({}), 6000);
    v.src = URL.createObjectURL(file);
  });
}

// ---------- sending files ----------
App.sendFiles = async (c, files, mode) => {
  if (!files.length) return;
  for (const f of files) if (f.size > (S.config.max_file || 52428800)) { toast(t('“{n}” is larger than 50 MB', { n: f.name })); return; }
  let caption = '';
  const media = files.filter((f) => /^(image|video)\//.test(f.type));
  if (mode !== 'doc' && media.length === files.length && files.length <= 10) {
    caption = await previewDialog(files); if (caption === null) return;
  }
  for (const [idx, f] of files.entries()) {
    const kind = mode === 'doc' ? (/^audio\//.test(f.type) ? 'audio' : 'file') : /^image\//.test(f.type) && !/svg/.test(f.type) ? 'image' : /^video\//.test(f.type) ? 'video' : /^audio\//.test(f.type) ? 'audio' : 'file';
    sendOne(c, f, kind, idx === 0 ? caption : '');
  }
};
async function sendOne(c, file, kind, caption) {
  const cid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const localUrl = URL.createObjectURL(file);
  const temp = { id: 'tmp-' + cid, client_id: cid, chat_id: c.id, sender_id: S.me.id, type: kind, body: caption, meta: { name: file.name, size: file.size, mime: file.type }, file_id: null, deliver_at: Date.now(), created_at: Date.now(), reactions: [], pending: true, ver: 0, _local: localUrl, _prog: 0 };
  const arr = S.msgs.get(c.id) || []; arr.push(temp); S.msgs.set(c.id, arr); S.pending.set(cid, temp); App.upsertMessage(temp);
  const prog = (p) => { temp._prog = p; const n = document.querySelector(`.msg[data-cid="${cid}"] .prog`); if (n) n.style.width = Math.round(p * 100) + '%'; };
  try {
    let blob = file, meta = {};
    if (kind === 'image') { const r = await compressImage(file); blob = r.blob; meta.width = r.w; meta.height = r.h; }
    if (kind === 'video') { const r = await videoInfo(file); meta.width = r.w; meta.height = r.h; meta.duration = r.duration && isFinite(r.duration) ? r.duration : undefined; if (r.thumb) { try { const th = await upload(r.thumb, 'chat:' + c.id, 'thumb.jpg'); meta.thumb = th.id; } catch {} } }
    const name = kind === 'image' && blob !== file ? file.name.replace(/\.\w+$/, '') + '.jpg' : file.name;
    const up = await upload(blob, 'chat:' + c.id, name, prog);
    const res = await api(`/api/chats/${c.id}/messages`, { body: { type: kind, file_id: up.id, body: caption, meta, client_id: cid } });
    App.upsertMessage(res.message); c.last = res.message; App.renderList();
  } catch (e) { temp.failed = true; temp._body = null; App.upsertMessage({ ...temp }); toast(e.message); }
}
function previewDialog(files) {
  return new Promise((res) => {
    let done = false;
    const thumbs = files.map((f) => /^image\//.test(f.type) ? `<img src="${URL.createObjectURL(f)}">` : `<video src="${URL.createObjectURL(f)}" muted playsinline></video>`).join('');
    const m = openModal(`<form class="dlg media-prev"><div class="mp-grid n${Math.min(files.length, 4)}">${thumbs}</div><p class="fine">${files.length} · ${fmtSize(files.reduce((a, f) => a + f.size, 0))}</p><input class="inp" placeholder="${t('Add a caption…')}" maxlength="2000"><div class="dlg-btns"><button type="button" class="btn ghost" data-close>${t('Cancel')}</button><button class="btn">${ICON.send} ${t('Send')}</button></div></form>`, { cls: 'wide', onClose: () => { if (!done) res(null); } });
    const f = m.el.querySelector('form'); setTimeout(() => f.querySelector('input').focus(), 60);
    f.onsubmit = (e) => { e.preventDefault(); done = true; res(f.querySelector('input').value.trim()); m.close(); };
  });
}

// ---------- rendering media in bubbles ----------
const docIcon = (name) => { const ext = (String(name).split('.').pop() || '').toLowerCase().slice(0, 4); return `<span class="docic">${esc(ext || 'file')}</span>`; };
App.mediaHtml = (m) => {
  if (m.deleted) return '';
  const src = m._local || (m.file_id ? fileUrl(m.file_id) : '');
  const prog = m.pending && !m.failed ? `<span class="progwrap"><span class="prog" style="width:${Math.round((m._prog || 0) * 100)}%"></span></span>` : '';
  if (m.type === 'image') { const ar = m.meta.width && m.meta.height ? `aspect-ratio:${m.meta.width}/${m.meta.height}` : 'aspect-ratio:4/3'; return `<button class="mimg" data-view style="${ar}"><img src="${src}" loading="lazy" alt="">${prog}</button>`; }
  if (m.type === 'video') { const th = m.meta.thumb ? fileUrl(m.meta.thumb) : ''; const ar = m.meta.width && m.meta.height ? `aspect-ratio:${m.meta.width}/${m.meta.height}` : 'aspect-ratio:16/9'; return `<button class="mimg vid" data-view style="${ar}">${th ? `<img src="${th}" loading="lazy" alt="">` : m._local ? `<video src="${m._local}" muted playsinline preload="metadata"></video>` : '<span class="vph"></span>'}<span class="playic">${ICON.play}</span>${m.meta.duration ? `<span class="vdur">${fmtDur(m.meta.duration)}</span>` : ''}${prog}</button>`; }
  if (m.type === 'voice' || m.type === 'audio') return voiceHtml(m, src) + prog;
  if (m.type === 'file') return `<div class="docmsg">${docIcon(m.meta.name)}<span class="docinfo"><b>${esc(m.meta.name || t('Document'))}</b><span class="sub">${fmtSize(m.meta.size)}</span></span>${m.file_id ? `<a class="ib dl" href="${fileUrl(m.file_id, true)}" download="${esc(m.meta.name || '')}" title="${t('Download')}">${ICON.download}</a>` : ''}</div>${prog}`;
  return '';
};
function voiceHtml(m, src) {
  const wf = (m.meta.waveform && m.meta.waveform.length ? m.meta.waveform : Array.from({ length: 40 }, (_, i) => 30 + ((i * 37) % 50)));
  const bars = wf.map((v) => `<i style="height:${Math.max(12, v)}%"></i>`).join('');
  const isVoice = m.type === 'voice';
  return `<div class="voice ${isVoice ? '' : 'audiof'}" data-src="${esc(src)}" data-dur="${m.meta.duration || 0}">${isVoice ? `<span class="vav">${App.avatarFor ? '' : ''}🎤</span>` : `<span class="vav">🎵</span>`}<button class="vplay">${ICON.play}</button><span class="vwave">${bars}<span class="vprog"></span></span><span class="vtime">${fmtDur(m.meta.duration || 0)}</span><button class="vspeed">1×</button>${!isVoice ? `<span class="vname">${esc(m.meta.name || '')}</span>` : ''}</div>`;
}
let currentAudio = null;
App.bindMedia = (n, get) => {
  const v = n.querySelector('[data-view]'); if (v) v.onclick = () => { const m = get(); if (m && !m.pending) App.openViewer(m); };
  const dl = n.querySelector('.docmsg .dl'); if (dl) dl.onclick = (e) => { e.preventDefault(); const m = get(); if (m) App.downloadFile(m); };
  const vc = n.querySelector('.voice'); if (!vc) return;
  const btn = vc.querySelector('.vplay'), wave = vc.querySelector('.vwave'), prog = vc.querySelector('.vprog'), tm = vc.querySelector('.vtime'), sp = vc.querySelector('.vspeed');
  let a = null; const dur0 = +vc.dataset.dur || 0;
  const encId = (vc.dataset.src || '').includes('#avmenc=') ? vc.dataset.src.split('#avmenc=')[1] : null; // end-to-end encrypted: decrypt before playing
  const ensure = () => { if (a) return a; a = new Audio(encId ? undefined : vc.dataset.src); a.preload = 'auto'; vc.appendChild(a); a.style.display = 'none';
    a.ontimeupdate = () => { const d = isFinite(a.duration) && a.duration > 0 ? a.duration : dur0; prog.style.width = d ? Math.min(100, (a.currentTime / d) * 100) + '%' : '0'; tm.textContent = fmtDur(a.currentTime); };
    a.onended = () => { btn.innerHTML = ICON.play; prog.style.width = '0'; tm.textContent = fmtDur(dur0); vc.classList.remove('playing'); };
    a.onpause = () => { btn.innerHTML = ICON.play; vc.classList.remove('playing'); }; a.onplay = () => { btn.innerHTML = ICON.pause; vc.classList.add('playing'); };
    return a; };
  btn.onclick = async () => { const au = ensure(); if (encId && !au.src) { try { au.src = await App.E2E.blobUrl(encId); } catch { return toast(t('Couldn’t open this encrypted file')); } } if (au.paused) { if (currentAudio && currentAudio !== au) currentAudio.pause(); currentAudio = au; au.playbackRate = parseFloat(sp.textContent) || 1; au.play().catch((e) => toast(t('Can’t play this audio here'))); } else au.pause(); };
  sp.onclick = () => { const r = { '1×': '1.5×', '1.5×': '2×', '2×': '1×' }[sp.textContent] || '1×'; sp.textContent = r; if (a) a.playbackRate = parseFloat(r); };
  wave.onclick = (e) => { const au = ensure(); const rect = wave.getBoundingClientRect(); const d = isFinite(au.duration) && au.duration > 0 ? au.duration : dur0; if (d) au.currentTime = ((e.clientX - rect.left) / rect.width) * d; };
};

// ---------- viewer ----------
App.openViewer = (m) => {
  const src = m._local || fileUrl(m.file_id);
  const body = m.type === 'video' ? `<video src="${src}" controls autoplay playsinline></video>` : `<img src="${src}" alt="">`;
  const mm = openModal(`<div class="viewer"><header><button class="ib" data-close>${ICON.back}</button><span class="vw-t"><b>${esc(nameOf(m.sender_id))}</b><span class="sub">${new Date(m.deliver_at).toLocaleString()}</span></span><button class="ib" id="vw-fwd">${ICON.fwd}</button><a class="ib" href="${fileUrl(m.file_id, true)}" download="${esc(m.meta.name || '')}">${ICON.download}</a></header><div class="vw-body">${body}</div>${m.body ? `<div class="vw-cap">${esc(m.body)}</div>` : ''}</div>`, { cls: 'full' });
  const f = mm.el.querySelector('#vw-fwd'); f.onclick = () => { mm.close(); setTimeout(() => App.forward(m), 50); };
  const vd = mm.el.querySelector('header a.ib[download]'); if (vd) vd.onclick = (e) => { e.preventDefault(); App.downloadFile(m); };
};
App.viewImage = (src, title) => openModal(`<div class="viewer"><header><button class="ib" data-close>${ICON.back}</button><span class="vw-t"><b>${esc(title || '')}</b></span></header><div class="vw-body"><img src="${src}" alt=""></div></div>`, { cls: 'full' });

// ---------- voice recording ----------
App.startRecording = async (c) => {
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast(t('Voice recording is not supported in this browser'));
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { return toast(t('Microphone permission is needed to record voice messages')); }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((x) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(x)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = []; rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  const ac = new (window.AudioContext || window.webkitAudioContext)(); const srcN = ac.createMediaStreamSource(stream); const an = ac.createAnalyser(); an.fftSize = 512; srcN.connect(an);
  const buf = new Uint8Array(an.fftSize); const levels = []; const start = Date.now(); let cancelled = false, locked = false;
  const box = $('#c-compose'); const prev = box.innerHTML;
  box.innerHTML = `<div class="recbar"><button class="ib" id="r-x" title="${t('Cancel')}">${ICON.trash}</button><span class="recdot"></span><span id="r-t">0:00</span><span class="recwave" id="r-w"></span><span class="fine">${t('Recording…')}</span><button class="sendbtn" id="r-send">${ICON.send}</button></div>`;
  const tick = setInterval(() => { an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; } const rms = Math.sqrt(sum / buf.length); levels.push(Math.min(100, Math.round(rms * 300))); const w = $('#r-w'); if (w) w.innerHTML = levels.slice(-36).map((l) => `<i style="height:${Math.max(10, l)}%"></i>`).join(''); const tt = $('#r-t'); if (tt) tt.textContent = fmtDur((Date.now() - start) / 1000); if (Date.now() - start > 15 * 60000) finish(); }, 100);
  const typingT = setInterval(() => App.sendTyping('recording'), 3000); App.sendTyping('recording');
  const cleanup = () => { clearInterval(tick); clearInterval(typingT); stream.getTracks().forEach((tr) => tr.stop()); ac.close().catch(() => {}); App.stopTyping(); App.renderComposer(); };
  const finish = () => { if (rec.state !== 'inactive') rec.stop(); };
  rec.onstop = async () => {
    const dur = (Date.now() - start) / 1000; cleanup(); if (cancelled) return; if (dur < 0.8) return toast(t('Hold on — that was too short'));
    const type = (rec.mimeType || mime || 'audio/webm').split(';')[0]; const blob = new Blob(chunks, { type }); const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const n = 48; const wf = []; for (let i = 0; i < n; i++) { const a = Math.floor((i * levels.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n)); const seg = levels.slice(a, b); wf.push(seg.length ? Math.max(...seg) : 0); }
    const mx = Math.max(10, ...wf); const norm = wf.map((v) => Math.round((v / mx) * 100));
    await sendVoice(c, blob, `voice-${Date.now()}.${ext}`, dur, norm);
  };
  rec.start(250);
  $('#r-x').onclick = () => { cancelled = true; finish(); };
  $('#r-send').onclick = finish;
};
async function sendVoice(c, blob, name, duration, waveform) {
  const cid = 'v' + Date.now().toString(36);
  const temp = { id: 'tmp-' + cid, client_id: cid, chat_id: c.id, sender_id: S.me.id, type: 'voice', body: '', meta: { duration, waveform, name }, deliver_at: Date.now(), created_at: Date.now(), reactions: [], pending: true, ver: 0, _local: URL.createObjectURL(blob) };
  const arr = S.msgs.get(c.id) || []; arr.push(temp); S.msgs.set(c.id, arr); S.pending.set(cid, temp); App.upsertMessage(temp);
  try { const up = await upload(blob, 'chat:' + c.id, name); const r = await api(`/api/chats/${c.id}/messages`, { body: { type: 'voice', file_id: up.id, meta: { duration, waveform }, client_id: cid } }); App.upsertMessage(r.message); c.last = r.message; App.renderList(); }
  catch (e) { temp.failed = true; App.upsertMessage({ ...temp }); toast(e.message); }
}

// ---------- emoji ----------
const EMO = {
  '😀': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖',
  '👍': '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 ✍️ 💅 🤳 👀 🧠 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🙇 🤦 🤷 💃 🕺 👫 👪',
  '❤️': '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ 🌟 ⭐ 🔥 🎉 🎊 🎈 🎁 🏆 🥇 🎂 🪔 🎆 🎇',
  '🐶': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦉 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🐟 🌸 🌹 🌺 🌻 🌼 🌷 🌱 🌴 🌵 🍀 🍁 🌈 ☀️ 🌙 ⛅ 🌧️ ⚡ ❄️ 🌊',
  '🍕': '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🌶️ 🥕 🥔 🍞 🧀 🍳 🥞 🍔 🍟 🍕 🌭 🥪 🌮 🍜 🍛 🍚 🍙 🍲 🥗 🍿 🍩 🍪 🍫 🍬 🍭 🍦 🍰 ☕ 🍵 🥤 🧃 🥛 🍺 🍻',
  '⚽': '⚽ 🏀 🏏 🏈 ⚾ 🎾 🏐 🏓 🏸 🥊 🎯 🎮 🎲 🎵 🎶 🎤 🎧 🎸 🎹 🥁 🎬 📷 📱 💻 ⌚ 💡 📚 ✏️ 📌 📎 🔒 🔑 💰 💳 🚗 🛵 🚲 ✈️ 🚀 🏠 🏢 🕌 🛕 ⛪ 🗺️ ⏰ ✅ ❌ ❓ ❗ ➕ 🔔',
};
App.emojiPicker = (cb, keepOpen) => {
  const recent = LS.get('emo-recent', ['👍', '❤️', '😂', '🙏', '😊', '🔥']);
  const tabs = Object.keys(EMO);
  const m = openModal(`<div class="emoji"><div class="emo-tabs"><button data-t="recent" class="on">🕘</button>${tabs.map((k) => `<button data-t="${k}">${k}</button>`).join('')}</div><div class="emo-grid" id="emog"></div></div>`, { cls: 'sheet' });
  const show = (k) => { $$('.emo-tabs button', m.el).forEach((b) => b.classList.toggle('on', b.dataset.t === k)); const list = k === 'recent' ? LS.get('emo-recent', recent) : EMO[k].split(' '); $('#emog', m.el).innerHTML = list.map((e) => `<button>${e}</button>`).join(''); $$('#emog button', m.el).forEach((b) => (b.onclick = () => { const e = b.textContent; const r = [e, ...LS.get('emo-recent', recent).filter((x) => x !== e)].slice(0, 32); LS.set('emo-recent', r); cb(e); if (!keepOpen) m.close(); })); };
  $$('.emo-tabs button', m.el).forEach((b) => (b.onclick = () => show(b.dataset.t))); show('recent');
};

// ---------- sounds (generated, original) ----------
let actx = null;
function ctx() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume().catch(() => {}); return actx; }
function tone(freqs, dur = 0.12, gap = 0.02, vol = 0.12, type = 'sine') { try { const a = ctx(); let tt = a.currentTime; for (const f of freqs) { const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(vol, tt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, tt + dur); o.connect(g).connect(a.destination); o.start(tt); o.stop(tt + dur + 0.02); tt += dur + gap; } } catch {} }
App.sound = (kind) => { if (S.me && S.me.settings && S.me.settings.sounds === false && kind !== 'ring' && kind !== 'ringback') return; if (kind === 'msg') tone([880, 1318], 0.09, 0.03, 0.08, 'triangle'); else if (kind === 'sent') tone([660], 0.05, 0, 0.04); else if (kind === 'ring') tone([523, 659, 784, 659], 0.16, 0.06, 0.14, 'triangle'); else if (kind === 'ringback') tone([440, 480], 0.4, 0.05, 0.05); else if (kind === 'end') tone([494, 392], 0.15, 0.03, 0.08); };
document.addEventListener('pointerdown', () => { try { ctx(); } catch {} }, { once: true });

// ---------- notifications ----------
App.initNotifications = async () => {
  if (isApp()) { const LN = plug('LocalNotifications'); if (LN) { try { const p = await LN.checkPermissions(); if (p.display !== 'granted' && !LS.get('asked-notif')) { LS.set('asked-notif', 1); await LN.requestPermissions(); } LN.addListener && LN.addListener('localNotificationActionPerformed', (a) => { const id = a.notification && a.notification.extra && a.notification.extra.chat; if (id) App.openChat(id); }); } catch {} } }
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener && navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.chat) App.openChat(e.data.chat); });
};
// 2.0.1 Android app: "Instant notifications" (native always-on service). Older app versions / browsers: plugin missing -> nothing changes.
App.nativeNotify = () => plug('AvmNotify');
App.nativeInit = async () => {
  const N = App.nativeNotify(); if (!N) return;
  try { const st = await N.refresh(); App.nativeInstant = !!(st && st.instant); } catch {}
  try { const p = await N.takePendingChat(); if (p && p.chat) window.avmOpenChat && window.avmOpenChat(p.chat); } catch {}
};
App.notifPermission = async () => {
  if (isApp()) { const LN = plug('LocalNotifications'); if (!LN) return 'unsupported'; const r = await LN.requestPermissions(); return r.display; }
  if (!('Notification' in window)) return 'unsupported'; return await Notification.requestPermission();
};
let nid = 1;
// instant in-app notification (top banner) when a message lands in another chat while the app is open
function inAppBanner(c, m, st) {
  const title = c.type === 'group' ? chatTitle(c) : nameOf(m.sender_id);
  const body = c.locked || st.preview === false ? t('New message') : (c.type === 'group' ? nameOf(m.sender_id) + ': ' : '') + previewText(m);
  document.querySelectorAll('.inapp').forEach((x) => x.remove());
  const n = document.createElement('button'); n.className = 'inapp';
  n.innerHTML = `${avatar(chatAvatarObj(c), 38)}<span><b>${esc(title)}</b><span>${esc(body).slice(0, 140)}</span></span>`;
  n.onclick = () => { n.remove(); App.openChat(c.id); };
  document.body.appendChild(n); requestAnimationFrame(() => n.classList.add('in'));
  setTimeout(() => { n.classList.remove('in'); setTimeout(() => n.remove(), 300); }, 4000);
}
App.notify = async (c, m) => {
  const muted = c.muted_until > Date.now(); if (muted) return;
  const st = S.me.settings || {};
  if (!document.hidden && S.open !== c.id) { App.sound('msg'); inAppBanner(c, m, st); }
  if (!document.hidden) return;
  if (isApp() && App.nativeInstant) return; // the app's instant-notification service posts this one (no duplicates)
  const title = c.type === 'group' ? chatTitle(c) : nameOf(m.sender_id);
  const body = c.locked || st.preview === false ? t('New message') : (c.type === 'group' ? nameOf(m.sender_id) + ': ' : '') + previewText(m);
  if (isApp()) { const LN = plug('LocalNotifications'); if (LN) try { await LN.schedule({ notifications: [{ id: nid++ % 100000, title, body: String(body).slice(0, 200), extra: { chat: c.id }, smallIcon: 'ic_stat_notify' }] }); } catch {} return; }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) reg.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', tag: 'chat-' + c.id, data: { chat: c.id } }); else new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'chat-' + c.id }); } catch {}
};
App.notifyCall = async (from, kind) => {
  if (!document.hidden) return; if (isApp() && App.nativeInstant) return; const title = t('Incoming {k}', { k: kind === 'video' ? t('video call') : t('voice call') }); const body = from;
  if (isApp()) { const LN = plug('LocalNotifications'); if (LN) try { await LN.schedule({ notifications: [{ id: 99001, title, body, smallIcon: 'ic_stat_notify' }] }); } catch {} return; }
  if ('Notification' in window && Notification.permission === 'granted') try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) reg.showNotification(title, { body, icon: '/icons/icon-192.png', tag: 'call', requireInteraction: true }); } catch {}
};
