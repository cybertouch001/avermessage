// API tests: the real worker with in-memory D1/R2. Run: node --test test/
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { makeEnv } from '../tools/env.mjs';
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const tmp = '/tmp/avmsg-test-' + process.pid + '.mjs'; fs.copyFileSync(path.join(SITE, '_worker.js'), tmp);
const W = (await import(tmp)).default;
const env = makeEnv(SITE);
const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
const BOOT = process.env.AVM_BOOT_TOKEN;

function client(ipAddr = '10.0.0.' + Math.floor(Math.random() * 200)) {
  let cookie = '';
  const call = async (method, p, body, extra = {}) => {
    const headers = { 'cf-connecting-ip': ipAddr, cookie };
    if (method !== 'GET') headers['x-avm'] = '1';
    Object.assign(headers, extra.headers || {});
    let b;
    if (body instanceof Uint8Array) { b = body; } else if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await W.fetch(new Request('https://avermessage.sites.tab.bot' + p, { method, headers, body: b }), env);
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
    return { status: r.status, data, headers: r.headers };
  };
  return { call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b ?? {}) };
}
const ok = (r, msg) => { assert.ok(r.status < 300, (msg || '') + ' -> ' + r.status + ' ' + JSON.stringify(r.data)); return r.data; };

const A = client('1.1.1.1'), B = client('1.1.1.2'), C = client('1.1.1.3'), X = client('9.9.9.9');
let ua, ub, uc, direct, group;

test('signup + reserved names + login lockout', async () => {
  ua = ok(await A.post('/api/auth/signup', { name: 'Asha', username: 'asha', phone: '9876543210', password: 'secret-pass-1' })).user;
  assert.equal(ua.phone, '+919876543210');
  ub = ok(await B.post('/api/auth/signup', { name: 'Bilal', username: 'bilal', password: 'secret-pass-2' })).user;
  uc = ok(await C.post('/api/auth/signup', { name: 'Chitra', username: 'chitra', password: 'secret-pass-3' })).user;
  for (const bad of ['admin', 'Adm1n', 'admin_1', 'the.admin', 'avermessage', 'support']) assert.equal((await X.post('/api/auth/signup', { name: 'x', username: bad, password: 'aaaaaaaa1' })).status, 400, bad);
  assert.equal((await X.post('/api/auth/signup', { name: 'x', username: 'asha', password: 'aaaaaaaa1' })).status, 409);
  assert.equal((await X.post('/api/auth/signup', { name: 'x', username: 'zed1', phone: '+919876543210', password: 'aaaaaaaa1' })).status, 409);
  assert.equal((await X.get('/api/me')).status, 401);
  assert.equal((await A.call('POST', '/api/chats/group', { name: 'x' }, { headers: { 'x-avm': '0' } })).status, 403, 'csrf header required');
  const L = client('5.5.5.5');
  for (let i = 0; i < 5; i++) assert.equal((await L.post('/api/auth/login', { id: 'bilal', password: 'wrong' })).status, 401);
  const locked = await L.post('/api/auth/login', { id: 'bilal', password: 'secret-pass-2' });
  assert.equal(locked.status, 429, 'locked after 5 wrong');
  const byPhone = client('6.6.6.6'); ok(await byPhone.post('/api/auth/login', { id: '+91 98765 43210', password: 'secret-pass-1' }), 'login by phone');
  const bad = await client('7.7.7.7').post('/api/auth/login', { id: 'nobody', password: 'x' }); assert.equal(bad.data.error, 'Wrong username/phone or password');
});

test('search, direct chat, send, delivered, read ticks', async () => {
  const s = ok(await A.get('/api/users/search?q=bil')); assert.equal(s.users[0].username, 'bilal');
  direct = ok(await A.post('/api/chats/direct', { user_id: ub.id })).chat;
  // B does not see an empty chat yet
  assert.equal(ok(await B.get('/api/chats')).chats.length, 0);
  const m1 = ok(await A.post(`/api/chats/${direct.id}/messages`, { type: 'text', body: 'Namaste 🙏', client_id: 'cid-1' })).message;
  const again = ok(await A.post(`/api/chats/${direct.id}/messages`, { type: 'text', body: 'Namaste 🙏', client_id: 'cid-1' })).message;
  assert.equal(again.id, m1.id, 'client_id idempotent');
  const lb = ok(await B.get('/api/chats')); assert.equal(lb.chats.length, 1); assert.equal(lb.chats[0].unread, 1);
  // A syncs: no receipts yet
  let sa = ok(await A.get('/api/sync?c=0'));
  const sb = ok(await B.get('/api/sync?c=0')); assert.ok(sb.messages.some((m) => m.id === m1.id), 'B got message via sync');
  sa = ok(await A.get('/api/sync?c=0')); const rb = sa.receipts.find((r) => r.user_id === ub.id && r.chat_id === direct.id);
  assert.ok(rb.delivered_upto >= m1.deliver_at, 'delivered'); assert.ok(rb.read_upto < m1.deliver_at, 'not read yet');
  ok(await B.post(`/api/chats/${direct.id}/read`, { upto: m1.deliver_at }));
  sa = ok(await A.get('/api/sync?c=0')); assert.ok(sa.receipts.find((r) => r.user_id === ub.id).read_upto >= m1.deliver_at, 'read');
  assert.equal(ok(await B.get('/api/chats')).chats[0].unread, 0);
  // reply, edit, react, star
  const m2 = ok(await B.post(`/api/chats/${direct.id}/messages`, { body: 'Hello!', reply_to: m1.id })).message; assert.equal(m2.reply.id, m1.id);
  const ed = ok(await A.patch(`/api/messages/${m1.id}`, { body: 'Namaste ji' })).message; assert.equal(ed.body, 'Namaste ji'); assert.ok(ed.edited_at);
  assert.equal((await B.patch(`/api/messages/${m1.id}`, { body: 'hack' })).status, 403);
  const rr = ok(await B.post(`/api/messages/${m1.id}/react`, { emoji: '❤️' })).message; assert.equal(rr.reactions[0].emoji, '❤️');
  ok(await A.post(`/api/messages/${m2.id}/star`, { on: true })); assert.equal(ok(await A.get('/api/starred')).messages.length, 1);
  // typing
  ok(await B.post(`/api/chats/${direct.id}/typing`, { kind: 'typing' })); assert.equal(ok(await A.get('/api/sync?c=0')).typing[0].user_id, ub.id);
  // delete for me / everyone
  const m3 = ok(await A.post(`/api/chats/${direct.id}/messages`, { body: 'oops' })).message;
  assert.equal((await B.post(`/api/messages/${m3.id}/delete`, { for: 'everyone' })).status, 403);
  ok(await A.post(`/api/messages/${m3.id}/delete`, { for: 'everyone' }));
  const after = ok(await B.get(`/api/chats/${direct.id}/messages`)).messages.find((m) => m.id === m3.id); assert.equal(after.deleted, true); assert.equal(after.body, '');
  ok(await B.post(`/api/messages/${m2.id}/delete`, { for: 'me' }));
  assert.ok(!ok(await B.get(`/api/chats/${direct.id}/messages`)).messages.some((m) => m.id === m2.id), 'hidden for me');
  assert.ok(ok(await A.get(`/api/chats/${direct.id}/messages`)).messages.some((m) => m.id === m2.id), 'still there for other');
  // search
  assert.equal(ok(await A.get(`/api/chats/${direct.id}/search?q=namaste`)).messages.length, 1);
  // outsider cannot read
  assert.equal((await C.get(`/api/chats/${direct.id}/messages`)).status, 404);
  assert.equal((await C.post(`/api/chats/${direct.id}/messages`, { body: 'x' })).status, 404);
});

test('files: upload, members-only access, range, html forced to download', async () => {
  const up = ok(await A.call('POST', `/api/upload?scope=chat:${direct.id}&name=report.pdf`, new Uint8Array(Buffer.from('%PDF-1.4 hello world')), { headers: { 'content-type': 'application/pdf' } })).file;
  const msg = ok(await A.post(`/api/chats/${direct.id}/messages`, { type: 'file', file_id: up.id })).message; assert.equal(msg.meta.name, 'report.pdf');
  const got = await B.get(`/api/files/${up.id}`); assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'application/octet-stream'); assert.match(got.headers.get('content-disposition'), /attachment/);
  assert.equal((await C.get(`/api/files/${up.id}`)).status, 404, 'non-member blocked');
  const rng = await B.call('GET', `/api/files/${up.id}`, undefined, { headers: { range: 'bytes=0-3' } }); assert.equal(rng.status, 206); assert.equal(Buffer.from(rng.data).toString(), '%PDF');
  const html = ok(await A.call('POST', `/api/upload?scope=chat:${direct.id}&name=x.html`, new Uint8Array(Buffer.from('<script>alert(1)</script>')), { headers: { 'content-type': 'text/html' } })).file;
  const h = await B.get(`/api/files/${html.id}`); assert.equal(h.headers.get('content-type'), 'application/octet-stream'); assert.match(h.headers.get('content-security-policy'), /sandbox/);
  const img = ok(await A.call('POST', `/api/upload?scope=chat:${direct.id}&name=p.png`, new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })).file;
  assert.equal((await B.get(`/api/files/${img.id}`)).headers.get('content-type'), 'image/png');
  assert.equal((await C.call('POST', `/api/upload?scope=chat:${direct.id}&name=a.txt`, new Uint8Array([1]), { headers: { 'content-type': 'text/plain' } })).status, 404, 'cannot upload into foreign chat');
  // file of another chat cannot be attached
  assert.equal((await B.post(`/api/chats/${direct.id}/messages`, { type: 'image', file_id: img.id })).status, 400);
});

test('groups: create, admin rules, add/remove, poll, only-admins, forward', async () => {
  const g = ok(await A.post('/api/chats/group', { name: 'Family', members: [ub.id] })); group = g.chat; assert.equal(group.my_role, 'admin');
  const sysm = ok(await B.get(`/api/chats/${group.id}/messages`)).messages; assert.ok(sysm.some((m) => m.type === 'system' && m.meta.ev === 'created'));
  assert.equal((await B.patch(`/api/chats/${group.id}`, { name: 'Hacked' })).status, 403);
  assert.equal((await B.post(`/api/chats/${group.id}/members`, { user_ids: [uc.id] })).status, 403);
  ok(await A.post(`/api/chats/${group.id}/members`, { user_ids: [uc.id] }));
  const det = ok(await C.get(`/api/chats/${group.id}`)); assert.equal(det.members.length, 3);
  // C (joined later) does not see earlier messages
  const early = ok(await C.get(`/api/chats/${group.id}/messages`)).messages; assert.ok(!early.some((m) => m.meta.ev === 'created'));
  ok(await A.post(`/api/chats/${group.id}/members/${ub.id}/role`, { role: 'admin' }));
  ok(await B.patch(`/api/chats/${group.id}`, { name: 'Family ❤️' }));
  const poll = ok(await C.post(`/api/chats/${group.id}/messages`, { type: 'poll', meta: { question: 'Dinner?', options: ['Pizza', 'Dosa'] } })).message;
  ok(await A.post(`/api/messages/${poll.id}/vote`, { options: [1] })); const v = ok(await B.post(`/api/messages/${poll.id}/vote`, { options: [1, 0] })).message;
  assert.equal(v.votes.length, 2, 'single choice keeps one vote each');
  assert.equal((await A.post(`/api/chats/${direct.id}/messages`, { type: 'poll', meta: { question: 'x', options: ['a', 'b'] } })).status, 400, 'no polls in 1:1');
  ok(await A.patch(`/api/chats/${group.id}`, { only_admins: true }));
  assert.equal((await C.post(`/api/chats/${group.id}/messages`, { body: 'hi' })).status, 403);
  ok(await A.patch(`/api/chats/${group.id}`, { only_admins: false }));
  const pm = ok(await A.post(`/api/chats/${group.id}/messages`, { body: 'pin me' })).message;
  assert.deepEqual(ok(await C.post(`/api/messages/${pm.id}/pin`, { on: true })).pinned, [pm.id]);
  // forward a file into the group, C can read it there
  const up = ok(await A.call('POST', `/api/upload?scope=chat:${direct.id}&name=a.png`, new Uint8Array([137, 80, 78, 71, 1]), { headers: { 'content-type': 'image/png' } })).file;
  const fm = ok(await A.post(`/api/chats/${direct.id}/messages`, { type: 'image', file_id: up.id })).message;
  const fw = ok(await A.post(`/api/messages/${fm.id}/forward`, { chat_ids: [group.id] })).messages[0]; assert.equal(fw.forwarded, true);
  assert.equal((await C.get(`/api/files/${fw.file_id}`)).status, 200); assert.equal((await C.get(`/api/files/${up.id}`)).status, 404);
  // remove C; C cannot send, cannot see new messages
  ok(await A.del(`/api/chats/${group.id}/members/${uc.id}`));
  assert.equal((await C.post(`/api/chats/${group.id}/messages`, { body: 'still here?' })).status, 403);
  shift += 5;
  const secret = ok(await A.post(`/api/chats/${group.id}/messages`, { body: 'after C left' })).message;
  assert.ok(!ok(await C.get(`/api/chats/${group.id}/messages`)).messages.some((m) => m.id === secret.id));
  // message info
  const info = ok(await A.get(`/api/messages/${secret.id}/info`)); assert.equal(info.read.length + info.delivered.length + info.pending.length, 1);
  // leave group: last admin hands over
  ok(await B.del(`/api/chats/${group.id}/members/${ub.id}`)); ok(await A.del(`/api/chats/${group.id}/members/${ua.id}`));
});

test('scheduled and disappearing messages', async () => {
  const due = Date.now() + 120000;
  const sm = ok(await A.post(`/api/chats/${direct.id}/messages`, { body: 'Happy birthday!', deliver_at: due })).message;
  assert.equal(ok(await A.get(`/api/chats/${direct.id}/scheduled`)).messages.length, 1);
  assert.ok(!ok(await B.get(`/api/chats/${direct.id}/messages`)).messages.some((m) => m.id === sm.id), 'not visible before time');
  const cur = ok(await B.get('/api/sync?c=0')).c;
  shift += 130000;
  const s2 = ok(await B.get('/api/sync?c=' + cur)); assert.ok(s2.messages.some((m) => m.id === sm.id), 'arrives when due');
  assert.equal((await A.post(`/api/chats/${direct.id}/messages`, { body: 'x', deliver_at: Date.now() - 5 })).status, 400);
  ok(await B.patch(`/api/chats/${direct.id}`, { disappearing: 86400 }));
  const dm = ok(await A.post(`/api/chats/${direct.id}/messages`, { body: 'vanish' })).message; assert.ok(dm.expires_at > dm.deliver_at);
  shift += 86400000 + 5000;
  assert.ok(!ok(await B.get(`/api/chats/${direct.id}/messages`)).messages.some((m) => m.id === dm.id), 'gone after 24h');
  ok(await B.patch(`/api/chats/${direct.id}`, { disappearing: 0 }));
});

test('block, privacy, report', async () => {
  ok(await B.patch('/api/me', { p_last_seen: 'none', about: 'Busy' }));
  const pu = ok(await A.get(`/api/users/${ub.id}`)).user; assert.equal(pu.last_seen, undefined); assert.equal(pu.about, 'Busy');
  ok(await B.post(`/api/users/${ua.id}/block`, { on: true }));
  assert.equal((await A.post(`/api/chats/${direct.id}/messages`, { body: 'hi?' })).status, 403);
  assert.equal((await A.post('/api/calls', { to: ub.id, kind: 'voice' })).status, 403);
  assert.equal(ok(await A.get(`/api/users/${ub.id}`)).user.photo, null);
  ok(await B.post(`/api/users/${ua.id}/block`, { on: false }));
  ok(await C.post(`/api/users/${ua.id}/report`, { reason: 'spam' }));
  ok(await B.patch('/api/me', { p_last_seen: 'all' }));
});

test('calls: ring, signal, accept, end, busy, missed', async () => {
  const c = ok(await A.post('/api/calls', { to: ub.id, kind: 'video' })); assert.equal(c.call.status, 'ringing'); assert.ok(c.ice.length >= 1);
  let sb = ok(await B.get('/api/sync?c=0&s=0')); assert.ok(sb.calls.some((k) => k.id === c.call.id && k.status === 'ringing'));
  ok(await A.post(`/api/calls/${c.call.id}/signal`, { type: 'offer', payload: { sdp: 'v=0', type: 'offer' } }));
  sb = ok(await B.get('/api/sync?c=0&s=0')); const off = sb.signals.find((s) => s.type === 'offer'); assert.equal(off.payload.sdp, 'v=0');
  const busy = ok(await C.post('/api/calls', { to: ub.id, kind: 'voice' })); assert.equal(busy.busy, true);
  ok(await B.post(`/api/calls/${c.call.id}/accept`));
  ok(await B.post(`/api/calls/${c.call.id}/signal`, { type: 'answer', payload: { sdp: 'v=0', type: 'answer' } }));
  const sa = ok(await A.get('/api/sync?c=0&s=0')); assert.ok(sa.signals.some((s) => s.type === 'accepted')); assert.ok(sa.signals.some((s) => s.type === 'answer'));
  shift += 5000;
  ok(await A.post(`/api/calls/${c.call.id}/end`));
  assert.equal((await A.post(`/api/calls/${c.call.id}/signal`, { type: 'ice', payload: {} })).status, 409);
  const msgs = ok(await B.get(`/api/chats/${direct.id}/messages`)).messages; const cm = msgs.filter((m) => m.type === 'call').pop(); assert.equal(cm.meta.status, 'ended'); assert.ok(cm.meta.duration >= 4);
  const c2 = ok(await A.post('/api/calls', { to: ub.id, kind: 'voice' })).call;
  shift += 50000; ok(await B.get('/api/sync?c=0'));
  const hist = ok(await B.get('/api/calls')).calls; assert.equal(hist.find((k) => k.id === c2.id).status, 'missed');
  const c3 = ok(await A.post('/api/calls', { to: ub.id, kind: 'voice' })).call; ok(await B.post(`/api/calls/${c3.id}/decline`));
  assert.equal(ok(await A.get('/api/calls')).calls.find((k) => k.id === c3.id).status, 'declined');
  assert.equal((await C.post(`/api/calls/${c3.id}/end`)).status, 404, 'outsider cannot touch call');
});

test('status stories: visibility, views, 24h expiry', async () => {
  ok(await A.post('/api/status', { type: 'text', body: 'Good morning ☀️', bg: '#7a3ae6' }));
  const sb = ok(await B.get('/api/status')); const st = sb.statuses.find((s) => s.user_id === ua.id); assert.ok(st, 'B (A has B as contact) sees it');
  assert.ok(!ok(await C.get('/api/status')).statuses.some((s) => s.user_id === ua.id), 'C (not a contact) does not');
  ok(await B.post(`/api/status/${st.id}/view`)); assert.equal(ok(await A.get(`/api/status/${st.id}/viewers`)).viewers.length, 1);
  shift += 24 * 3600000 + 1000; assert.ok(!ok(await B.get('/api/status')).statuses.some((s) => s.id === st.id), 'expired');
});

test('chat prefs: pin limit, archive, lock needs PIN', async () => {
  assert.equal((await A.post(`/api/chats/${direct.id}/prefs`, { locked: true })).status, 400);
  ok(await A.post('/api/me/pin', { password: 'secret-pass-1', pin: '4321' }));
  ok(await A.post(`/api/chats/${direct.id}/prefs`, { locked: true, archived: true, muted_until: Date.now() + 3600000 }));
  assert.equal((await A.post('/api/me/pin/verify', { pin: '0000' })).status, 400); ok(await A.post('/api/me/pin/verify', { pin: '4321' }));
  const l = ok(await A.get('/api/chats')).chats.find((c) => c.id === direct.id); assert.equal(l.locked, true); assert.equal(l.archived, true);
  ok(await A.post('/api/me/password', { current: 'secret-pass-1', next: 'secret-pass-1b' }));
  assert.equal((await client('8.8.8.1').post('/api/auth/login', { id: 'asha', password: 'secret-pass-1' })).status, 401);
  ok(await client('8.8.8.2').post('/api/auth/login', { id: 'asha', password: 'secret-pass-1b' }));
});

test('admin: bootstrap once, stats, ban, settings; non-admin refused', async () => {
  assert.equal((await A.get('/api/admin/stats')).status, 403);
  assert.equal((await X.post('/api/admin/bootstrap', { token: 'nope', password: 'whatever-123' })).status, 403);
  if (!BOOT) return;
  ok(await X.post('/api/admin/bootstrap', { token: BOOT, password: 'Admin-pass-123' }));
  assert.equal((await X.post('/api/admin/bootstrap', { token: BOOT, password: 'Admin-pass-123' })).status, 409);
  const AD = client('2.2.2.2'); ok(await AD.post('/api/auth/login', { id: 'admin', password: 'Admin-pass-123' }));
  const st = ok(await AD.get('/api/admin/stats')); assert.ok(st.users >= 4); assert.ok(st.messages > 5);
  ok(await AD.post(`/api/admin/users/${uc.id}/ban`, { on: true })); assert.equal((await C.get('/api/me')).status, 401, 'banned user logged out');
  assert.equal((await client('3.3.3.3').post('/api/auth/login', { id: 'chitra', password: 'secret-pass-3' })).status, 403);
  ok(await AD.post('/api/admin/settings', { turn: { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }, public: { announcement: 'Welcome!' } }));
  assert.equal(ok(await A.get('/api/ice')).ice.length, 2);
  assert.ok(ok(await AD.get('/api/admin/reports')).reports.length >= 1);
});
