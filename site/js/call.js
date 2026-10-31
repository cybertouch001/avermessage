// AverChat — 1:1 voice and video calls (WebRTC; signalling through the server via /api/calls + sync polling).
import { App, S, LS, t, $, $$, esc, el, api, toast, avatar, ICON, fmtDur, fmtTime, fmtListTime, isApp, plug, nameOf } from './util.js';

let call = null; // {id, peer, kind, role, status, pc, local, remote, pendingIce[], startedAt, timer, ui, muted, camOff, facing, speaker}
const handled = new Set();
App.callActive = () => !!call;
const native = () => plug('AvmCall');

async function getMedia(kind, facing = 'user') {
  const v = kind === 'video' ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false;
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: v });
}
function mediaError(e, kind) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return kind === 'video' ? t('Camera and microphone permission is needed for video calls') : t('Microphone permission is needed for calls');
  if (n === 'NotFoundError') return kind === 'video' ? t('No camera or microphone found') : t('No microphone found');
  return t('Could not start the microphone/camera');
}

App.startCall = async (peerId, kind) => {
  if (call) return toast(t('You are already in a call'));
  if (!navigator.mediaDevices || !window.RTCPeerConnection) return toast(t('Calls are not supported in this browser'));
  const u = S.users.get(peerId) || { id: peerId, name: nameOf(peerId) };
  call = { peer: u, kind, role: 'caller', status: 'starting', pendingIce: [], facing: 'user' };
  renderCallUI();
  try { call.local = await getMedia(kind); } catch (e) { const msg = mediaError(e, kind); cleanup(); return toast(msg); }
  showLocal();
  let r; try { r = await api('/api/calls', { body: { to: peerId, kind } }); } catch (e) { cleanup(); return toast(e.message); }
  if (!call) return; call.id = r.call.id; handled.add(call.id);
  if (r.busy) { setStatus(t('{n} is on another call', { n: u.name })); App.sound('end'); setTimeout(cleanup, 2500); return; }
  call.status = 'ringing'; setStatus(t('Ringing…')); ringback(true);
  native() && native().setInCall({ on: true }).catch(() => {});
  setupPC(r.ice);
  call.local.getTracks().forEach((tr) => call.pc.addTrack(tr, call.local));
  const offer = await call.pc.createOffer(); await call.pc.setLocalDescription(offer);
  signal('offer', { type: offer.type, sdp: offer.sdp });
  call.ringTimeout = setTimeout(() => { if (call && call.status === 'ringing') { setStatus(t('No answer')); end('no_answer'); } }, 46000);
  App.kick();
};
App.newCallPicker = () => App.pickUsers({ title: t('New call'), onDone: (u) => { import('./util.js').then(({ sheet }) => sheet(u.name, [{ icon: ICON.phone, label: t('Voice call'), run: () => App.startCall(u.id, 'voice') }, { icon: ICON.video, label: t('Video call'), run: () => App.startCall(u.id, 'video') }])); } });

function setupPC(ice) {
  const pc = new RTCPeerConnection({ iceServers: ice && ice.length ? ice : S.ice });
  call.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) signal('ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
  pc.ontrack = (e) => { if (!call) return; call.remote = e.streams[0] || new MediaStream([e.track]); const v = $('#call-remote'); if (v) { v.srcObject = call.remote; v.play().catch(() => {}); } const a = $('#call-audio'); if (a) { a.srcObject = call.remote; a.play().catch(() => {}); } };
  pc.onconnectionstatechange = () => {
    if (!call) return; const st = pc.connectionState;
    if (st === 'connected') { if (call.status !== 'connected') { call.status = 'connected'; call.connectedAt = Date.now(); ringback(false); startTimer(); } $('#callui') && $('#callui').classList.add('live'); }
    if (st === 'disconnected') setStatus(t('Reconnecting…'));
    if (st === 'failed') { if (call.role === 'caller' && !call.restarted) { call.restarted = true; setStatus(t('Reconnecting…')); pc.createOffer({ iceRestart: true }).then(async (o) => { await pc.setLocalDescription(o); signal('offer', { type: o.type, sdp: o.sdp, restart: true }); }).catch(() => {}); } else { setStatus(t('Couldn’t connect. The network may be blocking calls.')); setTimeout(() => end('failed'), 2500); } }
  };
  pc.oniceconnectionstatechange = () => { if (call && pc.iceConnectionState === 'connected' && call.status !== 'connected') pc.onconnectionstatechange(); };
}
function signal(type, payload) { if (!call || !call.id) return; api(`/api/calls/${call.id}/signal`, { body: { type, payload } }).catch(() => {}); }
async function addIce(c) { try { await call.pc.addIceCandidate(c); } catch {} }

// ---------- incoming ----------
App.onCallSync = async (calls, signals) => {
  for (const c of calls) {
    if (c.callee_id === S.me.id && c.status === 'ringing' && !handled.has(c.id) && Date.now() - c.created_at < 45000) {
      handled.add(c.id);
      if (call) { api(`/api/calls/${c.id}/decline`, { body: {} }).catch(() => {}); continue; }
      incoming(c);
    }
    if (call && call.id === c.id && ['ended', 'declined', 'missed', 'busy'].includes(c.status) && call.status !== 'ended') remoteEnded(c.status);
    if (c.status === 'missed' && c.callee_id === S.me.id && !LS.get('seenmiss-' + c.id)) { LS.set('seenmiss-' + c.id, 1); LS.set('missed-' + S.me.id, LS.get('missed-' + S.me.id, 0) + 1); App.updateBadges(); }
  }
  for (const s of signals) {
    if (!call || s.call_id !== call.id) { if (s.type === 'offer' && !call) { (pendingOffers[s.call_id] ||= []).push(s); } else if (s.type === 'ice') (pendingOffers[s.call_id] ||= []).push(s); continue; }
    await onSignal(s);
  }
  if (calls.length && S.tab === 'calls') App.renderCallsTab();
};
const pendingOffers = {};
async function onSignal(s) {
  const pc = call.pc;
  if (s.type === 'offer') {
    if (!pc) { call.offer = s.payload; return; }
    await pc.setRemoteDescription(s.payload); const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); signal('answer', { type: ans.type, sdp: ans.sdp });
    for (const c of call.pendingIce.splice(0)) await addIce(c);
  } else if (s.type === 'answer') { if (pc && pc.signalingState !== 'stable') { await pc.setRemoteDescription(s.payload); for (const c of call.pendingIce.splice(0)) await addIce(c); } }
  else if (s.type === 'ice') { if (pc && pc.remoteDescription) await addIce(s.payload); else call.pendingIce.push(s.payload); }
  else if (s.type === 'accepted') { clearTimeout(call.ringTimeout); call.status = 'connecting'; ringback(false); setStatus(t('Connecting…')); }
  else if (s.type === 'state') { call.remoteState = s.payload || {}; updateRemoteState(); }
  else if (s.type === 'hangup') remoteEnded((s.payload && s.payload.status) || 'ended');
}
function incoming(c) {
  const u = S.users.get(c.caller_id) || { id: c.caller_id, name: nameOf(c.caller_id) };
  call = { id: c.id, peer: u, kind: c.kind, role: 'callee', status: 'incoming', pendingIce: [], facing: 'user' };
  for (const s of pendingOffers[c.id] || []) { if (s.type === 'offer') call.offer = s.payload; else call.pendingIce.push(s.payload); } delete pendingOffers[c.id];
  renderCallUI(); ring(true); App.notifyCall(u.name, c.kind);
  call.ringTimeout = setTimeout(() => { if (call && call.status === 'incoming') { ring(false); cleanup(); } }, 46000);
}
async function accept() {
  if (!call || call.status !== 'incoming') return; ring(false); call.status = 'connecting'; setStatus(t('Connecting…')); renderControls();
  try { call.local = await getMedia(call.kind); } catch (e) { toast(mediaError(e, call.kind)); return decline(); }
  showLocal();
  let r; try { r = await api(`/api/calls/${call.id}/accept`, { body: {} }); } catch (e) { toast(e.message); return cleanup(); }
  native() && native().setInCall({ on: true }).catch(() => {});
  setupPC(r.ice); call.local.getTracks().forEach((tr) => call.pc.addTrack(tr, call.local));
  if (call.offer) { await onSignal({ type: 'offer', payload: call.offer }); }
  App.kick();
}
async function decline() { if (!call) return; ring(false); const id = call.id; cleanup(); api(`/api/calls/${id}/decline`, { body: {} }).catch(() => {}); }
async function end(reason) { if (!call) return; const id = call.id; App.sound('end'); cleanup(); if (id) api(`/api/calls/${id}/end`, { body: { reason } }).catch(() => {}); }
function remoteEnded(status) {
  if (!call) return; const labels = { declined: t('Call declined'), busy: t('Busy'), missed: t('No answer'), ended: t('Call ended'), cancelled: t('Call ended') };
  setStatus(labels[status] || t('Call ended')); App.sound('end'); ring(false); ringback(false);
  call.status = 'ended'; const c0 = call; setTimeout(() => { if (call === c0) cleanup(); }, 1200);
}
function cleanup() {
  if (!call) return; clearTimeout(call.ringTimeout); clearInterval(call.timer); ring(false); ringback(false);
  try { call.pc && call.pc.close(); } catch {} try { call.local && call.local.getTracks().forEach((tr) => tr.stop()); } catch {}
  native() && native().setInCall({ on: false }).catch(() => {});
  const ui = $('#callui'); if (ui) ui.remove(); call = null; document.body.classList.remove('in-call');
  if (S.tab === 'calls') App.renderCallsTab();
}

// ---------- ringing sounds ----------
let ringT = null, rbT = null;
function ring(on) { clearInterval(ringT); ringT = null; if (native()) native().stopVibrate && native().stopVibrate().catch(() => {}); else navigator.vibrate && navigator.vibrate(0); if (!on) return; const go = () => App.sound('ring'); go(); ringT = setInterval(go, 2200); if (native()) native().vibrate({ pattern: [0, 800, 600, 800], repeat: true }).catch(() => {}); else navigator.vibrate && navigator.vibrate([600, 400, 600, 400, 600]); }
function ringback(on) { clearInterval(rbT); rbT = null; if (!on) return; const go = () => App.sound('ringback'); go(); rbT = setInterval(go, 3000); }

// ---------- UI ----------
function renderCallUI() {
  const old = $('#callui'); if (old) old.remove();
  document.body.classList.add('in-call');
  const u = call.peer;
  const ui = el(`<div id="callui" class="callui ${call.kind}"><video id="call-remote" autoplay playsinline></video><audio id="call-audio" autoplay></audio>
    <div class="call-peer">${avatar(u, 110)}<h2>${esc(u.name)}</h2><p id="call-st">${call.role === 'callee' ? (call.kind === 'video' ? t('Incoming video call') : t('Incoming voice call')) : t('Calling…')}</p><p id="call-rs" class="fine"></p></div>
    <video id="call-local" autoplay playsinline muted></video>
    <div class="call-ctrls" id="call-ctrls"></div><div class="call-brand">${esc(App.brand().app_name)} · ${call.kind === 'video' ? t('Video call') : t('Voice call')}</div></div>`);
  document.body.appendChild(ui); renderControls();
}
function renderControls() {
  const box = $('#call-ctrls'); if (!box || !call) return;
  if (call.status === 'incoming') { box.innerHTML = `<button class="cb decline" id="cb-dec">${ICON.end}<span>${t('Decline')}</span></button><button class="cb accept" id="cb-acc">${call.kind === 'video' ? ICON.video : ICON.phone}<span>${t('Accept')}</span></button>`; $('#cb-dec').onclick = decline; $('#cb-acc').onclick = accept; return; }
  box.innerHTML = `<button class="cb ${call.muted ? 'on' : ''}" id="cb-mute">${call.muted ? ICON.micOff : ICON.mic}<span>${call.muted ? t('Unmute') : t('Mute')}</span></button>
    ${call.kind === 'video' ? `<button class="cb ${call.camOff ? 'on' : ''}" id="cb-cam">${call.camOff ? ICON.camOff : ICON.video}<span>${t('Camera')}</span></button><button class="cb" id="cb-flip">${ICON.flip}<span>${t('Flip')}</span></button>` : ''}
    <button class="cb ${call.speaker ? 'on' : ''}" id="cb-spk">${ICON.speaker}<span>${t('Speaker')}</span></button>
    <button class="cb decline" id="cb-end">${ICON.end}<span>${t('End')}</span></button>`;
  $('#cb-end').onclick = () => end('hangup');
  $('#cb-mute').onclick = () => { call.muted = !call.muted; call.local && call.local.getAudioTracks().forEach((tr) => (tr.enabled = !call.muted)); signal('state', { muted: call.muted, camOff: call.camOff }); renderControls(); };
  const cam = $('#cb-cam'); if (cam) cam.onclick = () => { call.camOff = !call.camOff; call.local && call.local.getVideoTracks().forEach((tr) => (tr.enabled = !call.camOff)); $('#call-local').classList.toggle('off', call.camOff); signal('state', { muted: call.muted, camOff: call.camOff }); renderControls(); };
  const flip = $('#cb-flip'); if (flip) flip.onclick = flipCamera;
  $('#cb-spk').onclick = toggleSpeaker;
}
async function flipCamera() {
  if (!call || !call.local) return; call.facing = call.facing === 'user' ? 'environment' : 'user';
  try {
    const old = call.local.getVideoTracks()[0];
    const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: call.facing } } }).catch(async () => { const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); if (devs.length < 2) throw new Error('one'); const cur = old && old.getSettings().deviceId; const next = devs.find((d) => d.deviceId !== cur) || devs[0]; return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } }); });
    const nt = ns.getVideoTracks()[0]; const sender = call.pc && call.pc.getSenders().find((s) => s.track && s.track.kind === 'video'); if (sender) await sender.replaceTrack(nt);
    if (old) { call.local.removeTrack(old); old.stop(); } call.local.addTrack(nt); nt.enabled = !call.camOff; showLocal();
    $('#call-local').classList.toggle('mirror', call.facing === 'user');
  } catch (e) { toast(t('Only one camera found')); }
}
async function toggleSpeaker() {
  call.speaker = !call.speaker;
  if (native()) { try { await native().setSpeaker({ on: call.speaker }); } catch {} }
  else { const a = $('#call-audio'), v = $('#call-remote'); if (a && a.setSinkId) { try { const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); const target = call.speaker ? (outs.find((d) => /speaker/i.test(d.label)) || outs[0]) : outs[0]; if (target) { await a.setSinkId(target.deviceId); v.setSinkId && (await v.setSinkId(target.deviceId)); } } catch {} } else toast(t('Use your phone’s volume buttons — this browser can’t switch the speaker')); }
  renderControls();
}
function showLocal() { const v = $('#call-local'); if (v && call && call.local) { v.srcObject = call.local; v.classList.toggle('show', call.kind === 'video'); v.classList.add('mirror'); v.play().catch(() => {}); } }
function setStatus(s) { const n = $('#call-st'); if (n) n.textContent = s; }
function startTimer() { clearInterval(call.timer); const tick = () => { if (call && call.connectedAt) setStatus(fmtDur((Date.now() - call.connectedAt) / 1000)); }; tick(); call.timer = setInterval(tick, 1000); renderControls(); }
function updateRemoteState() { const rs = $('#call-rs'); if (!rs || !call) return; const s = call.remoteState || {}; rs.textContent = [s.muted ? t('{n} muted the microphone', { n: call.peer.name }) : '', s.camOff ? t('{n} turned the camera off', { n: call.peer.name }) : ''].filter(Boolean).join(' · '); $('#callui') && $('#callui').classList.toggle('remote-cam-off', !!s.camOff); }
App.debugCall = () => call && { status: call.status, pc: call.pc && call.pc.connectionState, ice: call.pc && call.pc.iceConnectionState, remoteTracks: call.remote ? call.remote.getTracks().map((x) => x.kind + ':' + x.readyState) : [] };
window.addEventListener('beforeunload', () => { if (call && call.id) navigator.sendBeacon && fetch(`/api/calls/${call.id}/end`, { method: 'POST', headers: { 'x-avm': '1', 'content-type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {}); });

// ---------- calls tab ----------
App.renderCallsTab = async () => {
  const body = $('#tabbody'); if (!body || S.tab !== 'calls') return;
  if (!S.callsLoaded) body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  let r; try { r = await api('/api/calls'); S.callsLoaded = true; } catch (e) { body.innerHTML = `<p class="pad">${esc(e.message)}</p>`; return; }
  Object.values(r.users).forEach((u) => S.users.set(u.id, { ...(S.users.get(u.id) || {}), ...u }));
  LS.set('missed-' + S.me.id, 0); App.updateBadges();
  if (S.tab !== 'calls') return;
  body.innerHTML = `<div class="list">${r.calls.map((c) => { const out = c.caller_id === S.me.id; const peer = out ? c.callee_id : c.caller_id; const u = S.users.get(peer) || { id: peer, name: '?' }; const missed = !out && ['missed', 'declined'].includes(c.status) && !c.answered_at;
    const dur = c.answered_at && c.ended_at ? ' · ' + fmtDur((c.ended_at - c.answered_at) / 1000) : '';
    return `<div class="row callrow">${avatar(u)}<span class="row-main"><b class="${missed ? 'miss' : ''}">${esc(u.name)}</b><span class="sub"><i class="dir ${missed ? 'miss' : out ? 'out' : 'in'}">${out ? ICON.callOut : ICON.callIn}</i>${fmtListTime(c.created_at)}${c.answered_at ? '' : ' · ' + ({ missed: t('Missed'), declined: t('Declined'), busy: t('Busy'), ended: t('Not answered'), ringing: t('Ringing'), accepted: '' }[c.status] || '')}${dur}</span></span><button class="ib" data-call="${peer}" data-k="${c.kind}">${c.kind === 'video' ? ICON.video : ICON.phone}</button></div>`; }).join('') || `<div class="empty"><p>${t('No calls yet. Tap the call button to call someone.')}</p></div>`}</div>
    <p class="fine pad">${ICON.info} ${t('Calls connect directly between devices. On some mobile networks a call may fail to connect.')}</p>`;
  $$('[data-call]', body).forEach((b) => (b.onclick = () => App.startCall(b.dataset.call, b.dataset.k)));
};
