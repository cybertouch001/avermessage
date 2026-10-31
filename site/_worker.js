// AverChat server (formerly Avermessage) — Cloudflare Worker (D1 database "DB", R2 bucket "FILES", static assets "ASSETS").
// Realtime: clients long-poll /api/sync (a change counter wakes waiting requests; no shared WebSocket rooms here). Calls: WebRTC, signalling via /api/calls/*.
// Security: PBKDF2-SHA256 password hashes, HttpOnly session cookies (token stored hashed), login lockout,
// a custom header on every write (CSRF), every API checks the session, files only for chat members.
// NOT end-to-end encrypted: data is encrypted in transit (HTTPS) and stored on the server.

const VERSION = '2.0.0';
const PBKDF2_ITER = 100000;
const MAX_FILE = 50 * 1024 * 1024;           // 50 MB per file
const EDIT_WINDOW = 15 * 60 * 1000;          // edit own message within 15 min
const DELETE_ALL_WINDOW = 24 * 3600 * 1000;  // delete for everyone within 24 h
const ONLINE_MS = 30000;
const RING_MS = 45000;
const BOOT_HASH = 'ee6e4823c2c93f8de5c095cf06bf370573c2796e734aca5b1d617d49e43b524c';
const STATUS_TTL = 24 * 3600 * 1000;
// Look & feel the admin controls (served publicly by /api/config so even the login screen is branded).
const BRAND_DEFAULT = { app_name: 'AverChat', tagline: 'Chat. Call. Connect.', logo: null, preset: 'purple', accent: '#7c3aed', accent2: '#d946ef', bg: '#0c0718', panel: '#1a1130', text: '#f3eefe', bubble_out: '#6d28d9', bubble_in: '#241a3d', font: 'system', layout: 'glass', bubble: 'round', theme: 'dark', intro_enabled: true, intro_video: 'default:intro', bg_video: 'default:aurora', bg_dim: 0.55, screenshots: true, v: 0 };
const BRAND_FONTS = ['system', 'poppins', 'inter', 'nunito', 'baloo', 'serif', 'mono'];
const BRAND_LAYOUTS = ['glass', 'solid', 'compact'];
const DEFAULT_VIDEOS = ['intro', 'aurora', 'particles', 'waves', 'nebula'];
async function getBrand(env) { return { ...BRAND_DEFAULT, ...(await getSetting(env, 'brand', {})) }; }
const normEmail = (e) => { if (!e) return null; const s = String(e).trim().toLowerCase(); return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(s) && s.length <= 200 ? s : 'bad'; };
const RESERVED = ['admin','administrator','root','support','avermessage','averchat','system','official','help','moderator','mod','staff','owner','security','team','avermontis'];

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, phone TEXT UNIQUE, name TEXT NOT NULL, about TEXT DEFAULT 'Hey there! I am using AverChat.', photo TEXT, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_iter INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'user', banned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, p_last_seen TEXT NOT NULL DEFAULT 'all', p_photo TEXT NOT NULL DEFAULT 'all', p_about TEXT NOT NULL DEFAULT 'all', p_status TEXT NOT NULL DEFAULT 'contacts', read_receipts INTEGER NOT NULL DEFAULT 1, pin_hash TEXT, settings TEXT NOT NULL DEFAULT '{}')`,
`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, ua TEXT)`,
`CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
`CREATE TABLE IF NOT EXISTS attempts (k TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS contacts (user_id TEXT NOT NULL, contact_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, contact_id))`,
`CREATE TABLE IF NOT EXISTS blocks (user_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, blocked_id))`,
`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL, target_id TEXT, chat_id TEXT, reason TEXT, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, photo TEXT, description TEXT DEFAULT '', created_by TEXT, created_at INTEGER NOT NULL, direct_key TEXT UNIQUE, disappearing INTEGER NOT NULL DEFAULT 0, only_admins INTEGER NOT NULL DEFAULT 0, pinned TEXT NOT NULL DEFAULT '[]', last_msg_at INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS members (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL, left_at INTEGER, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, muted_until INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, wallpaper TEXT, cleared_upto INTEGER NOT NULL DEFAULT 0, delivered_upto INTEGER NOT NULL DEFAULT 0, read_upto INTEGER NOT NULL DEFAULT 0, seen_upto INTEGER NOT NULL DEFAULT 0, rcpt_ver INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id, user_id))`,
`CREATE INDEX IF NOT EXISTS members_user ON members(user_id)`,
`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', file_id TEXT, meta TEXT NOT NULL DEFAULT '{}', reply_to INTEGER, forwarded INTEGER NOT NULL DEFAULT 0, edited_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, deliver_at INTEGER NOT NULL, expires_at INTEGER, client_id TEXT, ver INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, deliver_at)`,
`CREATE INDEX IF NOT EXISTS messages_ver ON messages(ver)`,
`CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages(sender_id, client_id)`,
`CREATE TABLE IF NOT EXISTS reactions (message_id INTEGER NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(message_id, user_id))`,
`CREATE TABLE IF NOT EXISTS stars (user_id TEXT NOT NULL, message_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id, message_id))`,
`CREATE TABLE IF NOT EXISTS hidden (user_id TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY(user_id, message_id))`,
`CREATE TABLE IF NOT EXISTS votes (message_id INTEGER NOT NULL, user_id TEXT NOT NULL, opt INTEGER NOT NULL, PRIMARY KEY(message_id, user_id, opt))`,
`CREATE TABLE IF NOT EXISTS typing (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(chat_id, user_id))`,
`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, r2_key TEXT NOT NULL, name TEXT, mime TEXT, size INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, chat_id TEXT, caller_id TEXT NOT NULL, callee_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER, end_reason TEXT, ver INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller_id, ver)`,
`CREATE INDEX IF NOT EXISTS calls_callee ON calls(callee_id, ver)`,
`CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS signals_to ON signals(to_id, id)`,
`CREATE TABLE IF NOT EXISTS statuses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT, bg TEXT, file_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS statuses_user ON statuses(user_id, expires_at)`,
`CREATE TABLE IF NOT EXISTS status_views (status_id TEXT NOT NULL, viewer_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(status_id, viewer_id))`,
`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS bump (k INTEGER PRIMARY KEY, v INTEGER NOT NULL)`,
`INSERT OR IGNORE INTO bump(k,v) VALUES(1,0)`,
];
// v2 migrations: added columns (each ALTER runs once; a duplicate-column error means it already ran).
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN email TEXT`,
  `ALTER TABLE chats ADD COLUMN invite_code TEXT`,
  `ALTER TABLE chats ADD COLUMN channel INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chats ADD COLUMN public INTEGER NOT NULL DEFAULT 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chats_invite ON chats(invite_code)`,
  `CREATE INDEX IF NOT EXISTS users_last_seen ON users(last_seen)`,
  // scheduling was removed in v2: anything still waiting is delivered now
  `UPDATE messages SET deliver_at=created_at, ver=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE deliver_at>CAST(strftime('%s','now') AS INTEGER)*1000 AND deleted=0`,
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const sv = await env.DB.prepare(`SELECT v FROM kv WHERE k='schema_v'`).first();
  if (!sv || +J(sv.v, 0) < 2) {
    for (const q of MIGRATIONS) { try { await env.DB.prepare(q).run(); } catch (e) { if (!/duplicate column|already exists/i.test(String(e && e.message))) throw e; } }
    await env.DB.prepare(`INSERT INTO kv(k,v) VALUES('schema_v','2') ON CONFLICT(k) DO UPDATE SET v='2'`).run();
  }
  schemaReady = true;
}

// ---------- helpers ----------
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rid = (n = 16) => b64u(crypto.getRandomValues(new Uint8Array(n))).replace(/[-_]/g, 'x');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export async function hashPassword(password, salt = rid(16), iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return { hash: hex(bits), salt, iterations };
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || 'error'; } }
const err = (status, msg, code) => { throw new HttpError(status, msg, code); };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(self), microphone=(self), geolocation=(self)', 'strict-transport-security': 'max-age=31536000' };
function withSec(resp) { const r = new Response(resp.body, resp); for (const [k, v] of Object.entries(SEC_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v); return r; }
function parseCookies(h) { const o = {}; (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
const clamp = (s, n) => String(s ?? '').slice(0, n);
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
export function normPhone(p) { if (!p) return null; let s = String(p).replace(/[\s\-()]/g, ''); if (!/^\+?\d{8,15}$/.test(s)) return 'bad'; if (!s.startsWith('+')) s = (s.length === 10 ? '+91' : '+') + s; return s; }
function lookalike(u) { return u.toLowerCase().replace(/[._\-]/g, '').replace(/0/g, 'o').replace(/[1|l!]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a'); }
export function usernameReserved(u) { const n = lookalike(u); return RESERVED.some((r) => { const rn = lookalike(r); return n === rn || (rn === 'admin' && (n.startsWith('admin') || n.startsWith('adimn') || n.endsWith('admin'))) || (rn === 'avermessage' && n.startsWith('avermessage')); }); }
const ip = (req) => req.headers.get('cf-connecting-ip') || '0.0.0.0';

async function getSetting(env, k, d) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first(); return r ? J(r.v, d) : d; }
async function setSetting(env, k, v) { await env.DB.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run(); }

async function rateCheck(env, k) {
  const now = Date.now(); const r = await env.DB.prepare('SELECT * FROM attempts WHERE k=?').bind(k).first();
  if (r && r.locked_until > now) return { locked: true, retry: Math.ceil((r.locked_until - now) / 60000) };
  return { locked: false };
}
async function rateFail(env, k, max, windowMs, lockMs) {
  const now = Date.now(); const r = await env.DB.prepare('SELECT * FROM attempts WHERE k=?').bind(k).first();
  let count = 1, first = now;
  if (r && now - r.first_at < windowMs && r.locked_until <= now) { count = r.count + 1; first = r.first_at; }
  const locked = count >= max ? now + lockMs : 0;
  await env.DB.prepare('INSERT INTO attempts(k,count,first_at,locked_until) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET count=excluded.count, first_at=excluded.first_at, locked_until=excluded.locked_until').bind(k, locked ? 0 : count, first, locked).run();
  return locked;
}
async function rateHit(env, k, max, windowMs) {
  const now = Date.now(); const r = await env.DB.prepare('SELECT * FROM attempts WHERE k=?').bind(k).first();
  if (r && now - r.first_at < windowMs) { if (r.count >= max) return false; await env.DB.prepare('UPDATE attempts SET count=count+1 WHERE k=?').bind(k).run(); return true; }
  await env.DB.prepare('INSERT INTO attempts(k,count,first_at,locked_until) VALUES(?,?,?,0) ON CONFLICT(k) DO UPDATE SET count=1, first_at=excluded.first_at').bind(k, 1, now).run(); return true;
}

async function newSession(env, req, userId) {
  const token = rid(32); const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,created_at,last_used,ua) VALUES(?,?,?,?,?)').bind(await sha256(token), userId, now, now, clamp(req.headers.get('user-agent'), 200)).run();
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `avm_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}${secure}`;
}
async function auth(env, req) {
  const tok = parseCookies(req.headers.get('cookie')).avm_s;
  if (!tok) err(401, 'Please log in', 'auth');
  const th = await sha256(tok);
  const u = await env.DB.prepare('SELECT u.*, s.last_used AS s_used FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').bind(th).first();
  if (!u || u.deleted) err(401, 'Please log in', 'auth');
  if (u.banned) err(403, 'This account has been suspended', 'banned');
  if (Date.now() - u.s_used > 3600000) await env.DB.prepare('UPDATE sessions SET last_used=? WHERE token_hash=?').bind(Date.now(), th).run();
  u.token_hash = th;
  return u;
}

// ---------- serialisation ----------
function pubUser(u, viewer, rel = {}) {
  if (!u) return null;
  const self = viewer && viewer.id === u.id;
  const can = (p) => self || (!rel.blockedByU && (p === 'all' || (p === 'contacts' && rel.isContact)));
  const o = { id: u.id, username: u.username, name: u.deleted ? 'Deleted account' : u.name };
  if (u.role === 'admin') o.role = 'admin';
  o.photo = can(u.p_photo) && !u.deleted ? u.photo || null : null;
  o.about = can(u.p_about) && !u.deleted ? u.about : null;
  if (can(u.p_last_seen) && !u.deleted) { o.last_seen = u.last_seen; o.online = Date.now() - u.last_seen < ONLINE_MS; }
  if (self) Object.assign(o, { phone: u.phone, email: u.email || null, p_last_seen: u.p_last_seen, p_photo: u.p_photo, p_about: u.p_about, p_status: u.p_status, read_receipts: !!u.read_receipts, has_pin: !!u.pin_hash, settings: J(u.settings, {}), created_at: u.created_at, role: u.role });
  else if (rel.isContact && u.phone && !u.deleted) o.phone = u.phone;
  return o;
}
async function relations(env, viewerId, ids) {
  const out = {}; if (!ids.length) return out;
  const q = ids.map(() => '?').join(',');
  const [a, b, c, d] = await env.DB.batch([
    env.DB.prepare(`SELECT user_id FROM contacts WHERE contact_id=? AND user_id IN (${q})`).bind(viewerId, ...ids),
    env.DB.prepare(`SELECT user_id FROM blocks WHERE blocked_id=? AND user_id IN (${q})`).bind(viewerId, ...ids),
    env.DB.prepare(`SELECT blocked_id FROM blocks WHERE user_id=? AND blocked_id IN (${q})`).bind(viewerId, ...ids),
    env.DB.prepare(`SELECT contact_id FROM contacts WHERE user_id=? AND contact_id IN (${q})`).bind(viewerId, ...ids),
  ]);
  for (const id of ids) out[id] = { isContact: false, blockedByU: false, iBlocked: false, inMyContacts: false };
  a.results.forEach((r) => (out[r.user_id].isContact = true));
  b.results.forEach((r) => (out[r.user_id].blockedByU = true));
  c.results.forEach((r) => (out[r.blocked_id].iBlocked = true));
  d.results.forEach((r) => (out[r.contact_id].inMyContacts = true));
  return out;
}
async function usersPublic(env, viewer, ids) {
  ids = [...new Set(ids.filter(Boolean))]; if (!ids.length) return {};
  const rows = (await env.DB.prepare(`SELECT * FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  const rel = await relations(env, viewer.id, ids);
  const o = {}; for (const u of rows) { o[u.id] = pubUser(u, viewer, rel[u.id]); if (u.id !== viewer.id) { o[u.id].blocked = rel[u.id].iBlocked; o[u.id].contact = rel[u.id].inMyContacts; } }
  return o;
}

const MSG_COLS = `m.*, r.sender_id AS r_sender, r.type AS r_type, substr(r.body,1,160) AS r_body, r.deleted AS r_deleted, r.meta AS r_meta`;
async function enrichMessages(env, me, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id); const q = ids.map(() => '?').join(',');
  const [re, vo, st] = await env.DB.batch([
    env.DB.prepare(`SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${q})`).bind(...ids),
    env.DB.prepare(`SELECT message_id, user_id, opt FROM votes WHERE message_id IN (${q})`).bind(...ids),
    env.DB.prepare(`SELECT message_id FROM stars WHERE user_id=? AND message_id IN (${q})`).bind(me.id, ...ids),
  ]);
  const reac = {}, votes = {}, stars = new Set(st.results.map((r) => r.message_id));
  re.results.forEach((r) => (reac[r.message_id] ||= []).push({ user_id: r.user_id, emoji: r.emoji }));
  vo.results.forEach((r) => (votes[r.message_id] ||= []).push({ user_id: r.user_id, opt: r.opt }));
  return rows.map((m) => serMsg(m, reac[m.id] || [], votes[m.id] || [], stars.has(m.id)));
}
const pickMeta = (x) => ({ name: x.name, duration: x.duration, question: x.question });
function serMsg(m, reactions = [], votes = [], starred = false) {
  const o = { id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, type: m.type, body: m.deleted ? '' : m.body, file_id: m.deleted ? null : m.file_id, meta: m.deleted ? J(m.meta, {}) : J(m.meta, {}), reply_to: m.reply_to || null, forwarded: !!m.forwarded, edited_at: m.edited_at || null, deleted: !!m.deleted, created_at: m.created_at, deliver_at: m.deliver_at, expires_at: m.expires_at || null, ver: m.ver, client_id: m.client_id || null, reactions: m.deleted ? [] : reactions, starred };
  if (m.reply_to && m.r_type) o.reply = { id: m.reply_to, sender_id: m.r_sender, type: m.r_type, body: m.r_deleted ? '' : m.r_body, deleted: !!m.r_deleted, meta: m.r_deleted ? {} : pickMeta(J(m.r_meta, {})) };
  if (m.type === 'poll' && !m.deleted) o.votes = votes;
  return o;
}

// ---------- membership ----------
async function member(env, chatId, userId, mustBeActive = true) {
  const r = await env.DB.prepare('SELECT m.*, c.type AS c_type, c.disappearing AS c_disappearing, c.only_admins AS c_only_admins, c.name AS c_name FROM members m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=? AND m.user_id=?').bind(chatId, userId).first();
  if (!r) err(404, 'Chat not found', 'not_found');
  if (mustBeActive && r.left_at) err(403, 'You are no longer a member of this group', 'left');
  return r;
}
async function directPeer(env, chatId, me) { const r = await env.DB.prepare('SELECT user_id FROM members WHERE chat_id=? AND user_id<>?').bind(chatId, me).first(); return r && r.user_id; }
async function isBlockedEither(env, a, b) { const r = await env.DB.prepare('SELECT 1 AS x FROM blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?) LIMIT 1').bind(a, b, b, a).first(); return !!r; }
async function bumpChat(env, chatId, now = Date.now()) { await env.DB.prepare('UPDATE chats SET ver=? WHERE id=?').bind(now, chatId).run(); }
async function sysMsg(env, chatId, actorId, meta) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO messages(chat_id,sender_id,type,body,meta,created_at,deliver_at,ver) VALUES(?,?,?,?,?,?,?,?)').bind(chatId, actorId, 'system', '', JSON.stringify(meta), now, now, now).run();
  await env.DB.prepare('UPDATE chats SET last_msg_at=MAX(last_msg_at,?) WHERE id=?').bind(now, chatId).run();
}

// ---------- chats list ----------
async function joinChat(env, me, c, now, ev) {
  const ex = await env.DB.prepare('SELECT left_at FROM members WHERE chat_id=? AND user_id=?').bind(c.id, me.id).first();
  if (ex && !ex.left_at) return;
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE chat_id=? AND left_at IS NULL').bind(c.id).first();
  if (n.n >= (c.channel ? 100000 : 1024)) err(400, 'This group is full');
  await env.DB.prepare(`INSERT INTO members(chat_id,user_id,role,joined_at,ver) VALUES(?,?,'member',?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET left_at=NULL, role='member', joined_at=excluded.joined_at, hidden=0, ver=excluded.ver`).bind(c.id, me.id, now - 1, now).run();
  if (!c.channel) await sysMsg(env, c.id, me.id, { ev, actor: me.name });
  await bumpChat(env, c.id);
}
async function adminDeleteUser(env, t, now) {
  // Removes the person and what they posted: profile scrubbed (username/phone/email freed), sessions, contacts,
  // blocks, statuses, memberships ended, their messages wiped and their uploaded files deleted from storage.
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET deleted=1, banned=1, name='Deleted account', about='', photo=NULL, phone=NULL, email=NULL, pin_hash=NULL, username=?, pw_hash=?, settings='{}' WHERE id=?`).bind('deleted_' + rid(6).toLowerCase(), rid(24), t.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM contacts WHERE user_id=? OR contact_id=?').bind(t.id, t.id),
    env.DB.prepare('DELETE FROM blocks WHERE user_id=? OR blocked_id=?').bind(t.id, t.id),
    env.DB.prepare('DELETE FROM status_views WHERE viewer_id=? OR status_id IN (SELECT id FROM statuses WHERE user_id=?)').bind(t.id, t.id),
    env.DB.prepare('DELETE FROM statuses WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM reactions WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM votes WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM stars WHERE user_id=?').bind(t.id),
    env.DB.prepare(`UPDATE messages SET deleted=1, body='', meta='{}', file_id=NULL, ver=? WHERE sender_id=? AND type NOT IN ('system','call')`).bind(now, t.id),
    env.DB.prepare('UPDATE members SET left_at=?, ver=? WHERE user_id=? AND left_at IS NULL').bind(now, now, t.id),
  ]);
  const keys = (await env.DB.prepare(`SELECT DISTINCT r2_key FROM files WHERE owner_id=? AND r2_key NOT IN (SELECT r2_key FROM files WHERE owner_id<>?)`).bind(t.id, t.id).all()).results.map((r) => r.r2_key);
  await env.DB.prepare('DELETE FROM files WHERE owner_id=?').bind(t.id).run();
  for (let i = 0; i < keys.length; i += 1000) if (env.FILES) await env.FILES.delete(keys.slice(i, i + 1000));
}
async function chatList(env, me, onlyId) {
  const now = Date.now();
  const rows = (await env.DB.prepare(`SELECT c.*, m.role AS my_role, m.left_at, m.archived, m.pinned AS my_pinned, m.muted_until, m.locked, m.hidden, m.wallpaper, m.cleared_upto, m.seen_upto, m.joined_at,
     (SELECT COUNT(*) FROM members mm WHERE mm.chat_id=c.id AND mm.left_at IS NULL) AS member_count,
     (SELECT COUNT(*) FROM messages x WHERE x.chat_id=c.id AND x.sender_id<>? AND x.type NOT IN ('system') AND x.deleted=0 AND x.deliver_at>m.seen_upto AND x.deliver_at>m.cleared_upto AND x.deliver_at<=? AND x.deliver_at>=m.joined_at AND (m.left_at IS NULL OR x.deliver_at<=m.left_at) AND (x.expires_at IS NULL OR x.expires_at>?)) AS unread
     FROM members m JOIN chats c ON c.id=m.chat_id WHERE m.user_id=? ${onlyId ? 'AND c.id=?' : ''}`).bind(me.id, now, now, me.id, ...(onlyId ? [onlyId] : [])).all()).results;
  const out = []; const userIds = [];
  for (const c of rows) {
    const last = await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.chat_id=? AND m.deliver_at<=? AND m.deliver_at>? AND m.deliver_at>=? AND (? IS NULL OR m.deliver_at<=?) AND (m.expires_at IS NULL OR m.expires_at>?) AND m.id NOT IN (SELECT message_id FROM hidden WHERE user_id=?) ORDER BY m.deliver_at DESC, m.id DESC LIMIT 1`).bind(c.id, now, c.cleared_upto, c.joined_at, c.left_at, c.left_at, now, me.id).first();
    if (c.hidden && !onlyId && (!last || last.deliver_at <= c.cleared_upto)) continue;
    let peer = null;
    if (c.type === 'direct') { peer = await directPeer(env, c.id, me.id); userIds.push(peer); }
    if (last) userIds.push(last.sender_id);
    out.push({ id: c.id, type: c.type, channel: !!c.channel, public: !!c.public, name: c.name, photo: c.photo, description: c.description, disappearing: c.disappearing, only_admins: !!c.only_admins, pinned_msgs: J(c.pinned, []), created_at: c.created_at, last_msg_at: Math.max(c.last_msg_at, c.created_at), peer_id: peer, my_role: c.my_role, left: !!c.left_at, archived: !!c.archived, pinned: !!c.my_pinned, muted_until: c.muted_until, locked: !!c.locked, wallpaper: c.wallpaper, unread: c.unread, member_count: c.member_count, last: last ? serMsg(last) : null, ver: c.ver });
  }
  const users = await usersPublic(env, me, userIds);
  return { chats: out, users };
}

// ---------- sync ----------
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
async function bumpRead(env) { const r = await env.DB.prepare('SELECT v FROM bump WHERE k=1').first(); return r ? r.v : 0; }
async function bumpAll(env) { await env.DB.prepare('UPDATE bump SET v=v+1 WHERE k=1').run(); }
async function sync(env, me, url) {
  let now = Date.now();
  const cur = Math.max(0, +url.searchParams.get('c') || 0);
  const sig = Math.max(0, +url.searchParams.get('s') || 0);
  const peer = url.searchParams.get('peer');
  const writes = [
    env.DB.prepare(`UPDATE members SET delivered_upto=?, rcpt_ver=? WHERE user_id=? AND left_at IS NULL AND EXISTS (SELECT 1 FROM messages x WHERE x.chat_id=members.chat_id AND x.sender_id<>? AND x.deliver_at>members.delivered_upto AND x.deliver_at<=?)`).bind(now, now, me.id, me.id, now),
  ];
  if (now - me.last_seen > 10000) writes.push(env.DB.prepare('UPDATE users SET last_seen=? WHERE id=?').bind(now, me.id));
  const wr = await env.DB.batch(writes);
  if (wr[0] && wr[0].meta && wr[0].meta.changes > 0) await bumpAll(env);
  // long-poll: the client sends the change counter it last saw (b) and how long it may wait (w ms).
  // Nothing changed since -> hold the request, re-reading the one-row counter, until something does or time runs out.
  let bv = await bumpRead(env);
  const seen = url.searchParams.has('b') ? +url.searchParams.get('b') : -1;
  const wait = Math.min(Math.max(0, +url.searchParams.get('w') || 0), 20000);
  if (wait && seen === bv) {
    const until = Date.now() + wait; const step = wait > 6000 ? 700 : 400;
    while (Date.now() < until) { await new Promise((r) => setTimeout(r, step)); const v = await bumpRead(env); if (v !== bv) { bv = v; break; } }
  }
  now = Date.now();
  const stale = (await env.DB.prepare(`SELECT * FROM calls WHERE status IN ('ringing','accepted') AND ((status='ringing' AND created_at<?) OR (status='accepted' AND ver<?)) AND (caller_id=? OR callee_id=?)`).bind(now - RING_MS, now - 6 * 3600000, me.id, me.id).all()).results;
  for (const c of stale) await finishCall(env, c, c.status === 'ringing' ? 'missed' : 'ended', c.caller_id);
  if (stale.length) await bumpAll(env);
  const [msgs, rc, ty, calls, sigs, chg] = await env.DB.batch([
    env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m JOIN members cm ON cm.chat_id=m.chat_id AND cm.user_id=? LEFT JOIN messages r ON r.id=m.reply_to WHERE m.ver>? AND m.deliver_at<=? AND m.deliver_at>=cm.joined_at AND m.deliver_at>cm.cleared_upto AND (cm.left_at IS NULL OR m.deliver_at<=cm.left_at) AND m.id NOT IN (SELECT message_id FROM hidden WHERE user_id=?) ORDER BY m.ver LIMIT 400`).bind(me.id, cur, now, me.id),
    env.DB.prepare(`SELECT o.chat_id, o.user_id, o.delivered_upto, o.read_upto, o.left_at FROM members o JOIN members mine ON mine.chat_id=o.chat_id AND mine.user_id=? WHERE o.user_id<>? AND o.rcpt_ver>?`).bind(me.id, me.id, cur),
    env.DB.prepare(`SELECT t.chat_id, t.user_id, t.kind FROM typing t JOIN members mine ON mine.chat_id=t.chat_id AND mine.user_id=? AND mine.left_at IS NULL WHERE t.until>? AND t.user_id<>?`).bind(me.id, now, me.id),
    env.DB.prepare(`SELECT * FROM calls WHERE (caller_id=? OR callee_id=?) AND ver>?`).bind(me.id, me.id, cur),
    env.DB.prepare(`SELECT * FROM signals WHERE to_id=? AND id>? ORDER BY id LIMIT 300`).bind(me.id, sig),
    env.DB.prepare(`SELECT 1 AS x FROM members m JOIN chats c ON c.id=m.chat_id WHERE m.user_id=? AND (m.ver>? OR c.ver>?) LIMIT 1`).bind(me.id, cur, cur),
  ]);
  const out = { now, b: bv, c: now - 5000, s: sig, messages: await enrichMessages(env, me, msgs.results), receipts: rc.results, typing: ty.results, calls: calls.results, signals: sigs.results.map((s) => ({ ...s, payload: J(s.payload, null) })), chats_changed: chg.results.length > 0 };
  if (sigs.results.length) out.s = sigs.results[sigs.results.length - 1].id;
  if (msgs.results.length === 400) out.c = msgs.results[399].ver - 1;
  if (peer) { const pu = await usersPublic(env, me, [peer]); out.presence = pu[peer] ? { id: peer, online: !!pu[peer].online, last_seen: pu[peer].last_seen || null } : null; }
  const br = await getSetting(env, 'brand', {}); out.brand_v = br.v || 0;
  const lastSweep = await getSetting(env, 'sweep', 0);
  if (now - lastSweep > 3600000) await sweep(env, now);
  return out;
}
async function sweep(env, now) {
  await setSetting(env, 'sweep', now);
  const exp = (await env.DB.prepare('SELECT id, file_id FROM messages WHERE expires_at IS NOT NULL AND expires_at<? AND deleted=0 LIMIT 500').bind(now - 60000).all()).results;
  for (const m of exp) { await env.DB.prepare(`UPDATE messages SET deleted=1, body='', meta='{}', file_id=NULL, ver=? WHERE id=?`).bind(now, m.id).run(); if (m.file_id) await dropFile(env, m.file_id); }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM signals WHERE created_at<?').bind(now - 3600000),
    env.DB.prepare('DELETE FROM typing WHERE until<?').bind(now - 60000),
    env.DB.prepare('DELETE FROM attempts WHERE first_at<? AND locked_until<?').bind(now - 86400000, now),
  ]);
  const st = (await env.DB.prepare('SELECT id, file_id FROM statuses WHERE expires_at<? LIMIT 200').bind(now).all()).results;
  for (const s of st) { await env.DB.prepare('DELETE FROM statuses WHERE id=?').bind(s.id).run(); await env.DB.prepare('DELETE FROM status_views WHERE status_id=?').bind(s.id).run(); if (s.file_id) await dropFile(env, s.file_id); }
}
async function dropFile(env, id) {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first(); if (!f) return;
  await env.DB.prepare('DELETE FROM files WHERE id=?').bind(id).run();
  const other = await env.DB.prepare('SELECT 1 AS x FROM files WHERE r2_key=? LIMIT 1').bind(f.r2_key).first();
  if (!other && env.FILES) await env.FILES.delete(f.r2_key);
}

// ---------- calls ----------
async function finishCall(env, c, status, actor, reason) {
  const now = Date.now();
  const r = await env.DB.prepare(`UPDATE calls SET status=?, ended_at=?, end_reason=?, ver=? WHERE id=? AND status IN ('ringing','accepted')`).bind(status, now, reason || status, now, c.id).run();
  if (!r.meta.changes) return false;
  const fresh = await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(c.id).first();
  const duration = fresh.answered_at ? Math.round((now - fresh.answered_at) / 1000) : 0;
  const shown = status === 'ended' && !fresh.answered_at ? 'cancelled' : status;
  if (c.chat_id) {
    await env.DB.prepare('INSERT INTO messages(chat_id,sender_id,type,body,meta,created_at,deliver_at,ver) VALUES(?,?,?,?,?,?,?,?)').bind(c.chat_id, c.caller_id, 'call', '', JSON.stringify({ kind: c.kind, status: shown, duration, call_id: c.id }), now, now, now).run();
    await env.DB.prepare('UPDATE chats SET last_msg_at=MAX(last_msg_at,?) WHERE id=?').bind(now, c.chat_id).run();
  }
  for (const to of [c.caller_id, c.callee_id]) await env.DB.prepare('INSERT INTO signals(call_id,from_id,to_id,type,payload,created_at) VALUES(?,?,?,?,?,?)').bind(c.id, actor, to, 'hangup', JSON.stringify({ status: shown }), now).run();
  return true;
}
async function iceServers(env) {
  const cfg = await getSetting(env, 'turn', null);
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (cfg && cfg.urls && cfg.urls.length) list.push({ urls: cfg.urls, username: cfg.username || undefined, credential: cfg.credential || undefined });
  return list;
}

// ---------- status visibility ----------
async function canSeeStatusOf(env, viewerId, authorId) {
  if (viewerId === authorId) return true;
  if (await isBlockedEither(env, viewerId, authorId)) return false;
  const a = await env.DB.prepare('SELECT p_status FROM users WHERE id=?').bind(authorId).first(); if (!a) return false;
  if (a.p_status === 'none') return false;
  const c = await env.DB.prepare('SELECT 1 AS x FROM contacts WHERE user_id=? AND contact_id=?').bind(authorId, viewerId).first();
  if (c) return true;
  if (a.p_status === 'all') { const d = await env.DB.prepare('SELECT 1 AS x FROM chats WHERE direct_key=?').bind([viewerId, authorId].sort().join(':')).first(); return !!d; }
  return false;
}
async function canReadFile(env, me, f) {
  if (f.owner_id === me.id) return true;
  const [kind, id] = f.scope.split(':');
  if (kind === 'avatar') return true;
  if (kind === 'chat') { const m = await env.DB.prepare('SELECT left_at FROM members WHERE chat_id=? AND user_id=?').bind(id, me.id).first(); return !!m; }
  if (kind === 'group') { const m = await env.DB.prepare('SELECT left_at FROM members WHERE chat_id=? AND user_id=?').bind(id, me.id).first(); return !!m && !m.left_at; }
  if (kind === 'status') return canSeeStatusOf(env, me.id, f.owner_id);
  return false;
}
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(webm|ogg|mpeg|mp4|aac|wav|x-m4a|mp3))$/;

// ---------- API ----------
async function api(req, env, url) {
  const p = url.pathname; const m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && req.headers.get('x-avm') !== '1') err(403, 'Bad request', 'csrf');
  let mt;
  const body = async () => { if ((req.headers.get('content-type') || '').includes('application/json')) { try { return await req.json(); } catch { err(400, 'Bad JSON'); } } return {}; };

  if (p === '/api/health') return json({ ok: true, version: VERSION, time: Date.now() });
  if (p === '/api/config' && m === 'GET') { const s = await getSetting(env, 'public', {}); return json({ version: VERSION, max_file: MAX_FILE, announcement: s.announcement || '', announcement_at: s.announcement_at || 0, signup_open: s.signup_open !== false, phone_required: true, brand: await getBrand(env) }, 200, { 'cache-control': 'no-cache' }); }
  if ((mt = p.match(/^\/api\/brand\/(f_[\w]+)$/)) && (m === 'GET' || m === 'HEAD')) {
    // admin-chosen logo / intro / background video: public, read-only, only files uploaded with scope 'brand'
    const f = await env.DB.prepare(`SELECT * FROM files WHERE id=? AND scope='brand'`).bind(mt[1]).first(); if (!f) err(404, 'Not found');
    const range = req.headers.get('range'); let opts = {}; let start = 0, end = f.size - 1;
    const rm = range && range.match(/^bytes=(\d*)-(\d*)$/);
    if (rm && (rm[1] || rm[2])) { if (rm[1]) { start = +rm[1]; end = rm[2] ? Math.min(+rm[2], f.size - 1) : f.size - 1; } else { start = Math.max(0, f.size - +rm[2]); } if (start > end || start >= f.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${f.size}` } }); opts.range = { offset: start, length: end - start + 1 }; }
    const obj = await env.FILES.get(f.r2_key, opts); if (!obj) err(404, 'Not found');
    const h = { 'content-type': /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/.test(f.mime) ? f.mime : 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), 'content-security-policy': "default-src 'none'; sandbox" };
    if (opts.range) h['content-range'] = `bytes ${start}-${end}/${f.size}`;
    return new Response(m === 'HEAD' ? null : obj.body, { status: opts.range ? 206 : 200, headers: h });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    const b = await body(); const pub = await getSetting(env, 'public', {});
    if (pub.signup_open === false) err(403, 'New sign-ups are closed right now', 'closed');
    const username = clamp(b.username, 40).trim().toLowerCase().replace(/^@/, ''); const name = clamp(b.name, 50).trim(); const pw = String(b.password || '');
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) err(400, 'Username: 3–20 letters, numbers, _ or .', 'username');
    if (usernameReserved(username)) err(400, 'This username is not available', 'username_taken');
    if (!name) err(400, 'Please enter your name', 'name');
    if (pw.length < 8) err(400, 'Password must be at least 8 characters', 'password');
    if (!String(b.phone || '').trim()) err(400, 'Phone number is required for new accounts', 'phone_required');
    const phone = normPhone(b.phone); if (phone === 'bad') err(400, 'Phone number looks wrong (8–15 digits)', 'phone');
    const email = normEmail(b.email); if (email === 'bad') err(400, 'Email address looks wrong', 'email');
    if (!(await rateHit(env, 'signup:' + ip(req), 10, 3600000))) err(429, 'Too many sign-ups from this network. Try later.', 'rate');
    const ex = await env.DB.prepare('SELECT username, phone FROM users WHERE username=? OR (phone IS NOT NULL AND phone=?)').bind(username, phone || '-').first();
    if (ex) err(409, ex.username === username ? 'This username is taken' : 'This phone number is already registered', 'taken');
    const h = await hashPassword(pw); const id = 'u_' + rid(10); const now = Date.now();
    await env.DB.prepare('INSERT INTO users(id,username,phone,email,name,pw_hash,pw_salt,pw_iter,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, username, phone, email, name, h.hash, h.salt, h.iterations, now, now).run();
    const cookie = await newSession(env, req, id);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
    return json({ user: pubUser(u, u) }, 200, { 'set-cookie': cookie });
  }
  if (p === '/api/auth/login' && m === 'POST') {
    const b = await body(); const idf = clamp(b.id, 40).trim().toLowerCase().replace(/^@/, ''); const pw = String(b.password || '');
    const keyU = 'login:u:' + idf, keyI = 'login:ip:' + ip(req);
    for (const k of [keyU, keyI]) { const r = await rateCheck(env, k); if (r.locked) err(429, `Too many wrong attempts. Try again in ${r.retry} min.`, 'locked'); }
    const phone = normPhone(idf);
    const u = await env.DB.prepare('SELECT * FROM users WHERE (username=? OR (phone IS NOT NULL AND phone=?)) AND deleted=0').bind(idf, phone && phone !== 'bad' ? phone : '-').first();
    const h = await hashPassword(pw, u ? u.pw_salt : 'x-no-user-salt', u ? u.pw_iter : PBKDF2_ITER);
    if (!u || !safeEq(h.hash, u.pw_hash)) {
      await rateFail(env, keyU, 5, 15 * 60000, 15 * 60000); await rateFail(env, keyI, 30, 15 * 60000, 15 * 60000);
      err(401, 'Wrong username/phone or password', 'bad_login');
    }
    if (u.banned) err(403, 'This account has been suspended', 'banned');
    await env.DB.prepare('DELETE FROM attempts WHERE k=?').bind(keyU).run();
    const cookie = await newSession(env, req, u.id);
    return json({ user: pubUser(u, u) }, 200, { 'set-cookie': cookie });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const tok = parseCookies(req.headers.get('cookie')).avm_s; if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(tok)).run();
    return json({ ok: true }, 200, { 'set-cookie': 'avm_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }
  if (p === '/api/admin/bootstrap' && m === 'POST') {
    const b = await body(); if (!b.token || (await sha256(String(b.token))) !== BOOT_HASH) err(403, 'Forbidden', 'forbidden');
    const ex = await env.DB.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).first(); if (ex) err(409, 'Admin already exists', 'exists');
    if (String(b.password || '').length < 10) err(400, 'weak');
    const h = await hashPassword(String(b.password)); const now = Date.now();
    await env.DB.prepare(`INSERT INTO users(id,username,phone,name,about,pw_hash,pw_salt,pw_iter,role,created_at,last_seen,p_last_seen) VALUES(?,?,?,?,?,?,?,?,'admin',?,?,'none')`).bind('u_admin', 'admin', null, 'AverChat Admin', 'Owner of this AverChat server', h.hash, h.salt, h.iterations, now, now).run();
    return json({ ok: true });
  }

  const me = await auth(env, req);
  const now = Date.now();

  // ---- background notification check (used by the Android app's periodic worker when the app is closed) ----
  if (p === '/api/notify' && m === 'GET') {
    const since = Math.max(+url.searchParams.get('since') || 0, now - 2 * 86400000);
    const rows = (await env.DB.prepare(`SELECT m.id, m.chat_id, m.sender_id, m.type, substr(m.body,1,120) AS body, m.meta, m.deliver_at, c.type AS c_type, c.name AS c_name, u.name AS s_name
      FROM messages m JOIN members cm ON cm.chat_id=m.chat_id AND cm.user_id=? AND cm.left_at IS NULL JOIN chats c ON c.id=m.chat_id JOIN users u ON u.id=m.sender_id
      WHERE m.deliver_at>? AND m.deliver_at<=? AND m.sender_id<>? AND m.deleted=0 AND m.type NOT IN ('system') AND cm.muted_until<? AND m.deliver_at>cm.seen_upto AND m.deliver_at>=cm.joined_at
      AND m.sender_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id=?) ORDER BY m.deliver_at DESC LIMIT 30`).bind(me.id, since, now, me.id, now, me.id).all()).results;
    const ring = (await env.DB.prepare(`SELECT c.id, c.kind, u.name AS caller FROM calls c JOIN users u ON u.id=c.caller_id WHERE c.callee_id=? AND c.status='ringing' AND c.created_at>?`).bind(me.id, now - RING_MS).all()).results;
    const label = (r) => { const mm = J(r.meta, {}); return r.type === 'text' ? r.body : r.type === 'image' ? '📷 Photo' : r.type === 'video' ? '🎥 Video' : r.type === 'voice' ? '🎤 Voice message' : r.type === 'audio' ? '🎵 Audio' : r.type === 'file' ? '📄 ' + (mm.name || 'Document') : r.type === 'poll' ? '📊 ' + (mm.question || 'Poll') : r.type === 'location' ? '📍 Location' : r.type === 'contact' ? '👤 Contact' : r.type === 'call' ? '📞 Call' : 'New message'; };
    const brand = await getBrand(env);
    return json({ now, app_name: brand.app_name, screenshots: brand.screenshots !== false, messages: rows.map((r) => ({ id: r.id, chat_id: r.chat_id, title: r.c_type === 'group' ? r.c_name : r.s_name, sender: r.s_name, group: r.c_type === 'group', text: label(r), at: r.deliver_at })), calls: ring });
  }
  if (p === '/api/sync' && m === 'GET') return json(await sync(env, me, url));
  if (p === '/api/me' && m === 'GET') return json({ user: pubUser(me, me), ice: await iceServers(env), config: await getSetting(env, 'public', {}) });
  if (p === '/api/me' && m === 'PATCH') {
    const b = await body(); const sets = [], args = [];
    if (b.name !== undefined) { const n = clamp(b.name, 50).trim(); if (!n) err(400, 'Name cannot be empty'); sets.push('name=?'); args.push(n); }
    if (b.about !== undefined) { sets.push('about=?'); args.push(clamp(b.about, 140)); }
    if (b.photo !== undefined) { if (b.photo) { const f = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').bind(b.photo, me.id).first(); if (!f || f.scope !== 'avatar') err(400, 'Bad photo'); } sets.push('photo=?'); args.push(b.photo || null); }
    for (const k of ['p_last_seen', 'p_photo', 'p_about', 'p_status']) if (b[k] !== undefined) { if (!['all', 'contacts', 'none'].includes(b[k])) err(400, 'Bad privacy value'); sets.push(k + '=?'); args.push(b[k]); }
    if (b.read_receipts !== undefined) { sets.push('read_receipts=?'); args.push(b.read_receipts ? 1 : 0); }
    if (b.settings !== undefined) { const s = JSON.stringify(b.settings || {}); if (s.length > 4000) err(400, 'Settings too large'); sets.push('settings=?'); args.push(s); }
    if (b.email !== undefined) { const em = normEmail(b.email); if (em === 'bad') err(400, 'Email address looks wrong'); sets.push('email=?'); args.push(em); }
    if (b.phone !== undefined) { const ph = b.phone ? normPhone(b.phone) : null; if (ph === 'bad') err(400, 'Phone number looks wrong'); if (ph) { const ex = await env.DB.prepare('SELECT id FROM users WHERE phone=? AND id<>?').bind(ph, me.id).first(); if (ex) err(409, 'This phone number is already registered'); } sets.push('phone=?'); args.push(ph); }
    if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...args, me.id).run();
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(me.id).first();
    return json({ user: pubUser(u, u) });
  }
  if (p === '/api/me/password' && m === 'POST') {
    const b = await body(); const h = await hashPassword(String(b.current || ''), me.pw_salt, me.pw_iter);
    if (!safeEq(h.hash, me.pw_hash)) err(400, 'Current password is wrong', 'bad_password');
    if (String(b.next || '').length < 8) err(400, 'New password must be at least 8 characters');
    const n = await hashPassword(String(b.next));
    await env.DB.prepare('UPDATE users SET pw_hash=?, pw_salt=?, pw_iter=? WHERE id=?').bind(n.hash, n.salt, n.iterations, me.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(me.id, me.token_hash).run();
    return json({ ok: true });
  }
  if (p === '/api/me/sessions' && m === 'GET') { const rows = (await env.DB.prepare('SELECT created_at, last_used, ua, token_hash FROM sessions WHERE user_id=? ORDER BY last_used DESC').bind(me.id).all()).results; return json({ sessions: rows.map((r) => ({ created_at: r.created_at, last_used: r.last_used, ua: r.ua, current: r.token_hash === me.token_hash })) }); }
  if (p === '/api/me/logout-all' && m === 'POST') { await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(me.id, me.token_hash).run(); return json({ ok: true }); }
  if (p === '/api/me/pin' && m === 'POST') {
    const b = await body(); const h = await hashPassword(String(b.password || ''), me.pw_salt, me.pw_iter);
    if (!safeEq(h.hash, me.pw_hash)) err(400, 'Password is wrong', 'bad_password');
    if (b.pin === null) { await env.DB.prepare('UPDATE users SET pin_hash=NULL WHERE id=?').bind(me.id).run(); await env.DB.prepare('UPDATE members SET locked=0, ver=? WHERE user_id=?').bind(now, me.id).run(); return json({ ok: true }); }
    if (!/^\d{4,6}$/.test(String(b.pin || ''))) err(400, 'PIN must be 4–6 digits');
    const ph = await hashPassword(String(b.pin), rid(8), 20000);
    await env.DB.prepare('UPDATE users SET pin_hash=? WHERE id=?').bind(JSON.stringify(ph), me.id).run(); return json({ ok: true });
  }
  if (p === '/api/me/pin/verify' && m === 'POST') {
    const b = await body(); if (!me.pin_hash) err(400, 'No PIN set');
    const k = 'pin:' + me.id; const r = await rateCheck(env, k); if (r.locked) err(429, `Too many wrong PINs. Try again in ${r.retry} min.`, 'locked');
    const ph = J(me.pin_hash, {}); const h = await hashPassword(String(b.pin || ''), ph.salt, ph.iterations);
    if (!safeEq(h.hash, ph.hash)) { await rateFail(env, k, 5, 15 * 60000, 15 * 60000); err(400, 'Wrong PIN', 'bad_pin'); }
    await env.DB.prepare('DELETE FROM attempts WHERE k=?').bind(k).run(); return json({ ok: true });
  }
  if (p === '/api/me' && m === 'DELETE') {
    const b = await body(); const h = await hashPassword(String(b.password || ''), me.pw_salt, me.pw_iter);
    if (!safeEq(h.hash, me.pw_hash)) err(400, 'Password is wrong', 'bad_password');
    if (me.role === 'admin') err(400, 'The admin account cannot be deleted');
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET deleted=1, name='Deleted account', about='', photo=NULL, phone=NULL, username=?, settings='{}' WHERE id=?`).bind('deleted_' + rid(6).toLowerCase(), me.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(me.id),
      env.DB.prepare('DELETE FROM contacts WHERE user_id=? OR contact_id=?').bind(me.id, me.id),
      env.DB.prepare('DELETE FROM statuses WHERE user_id=?').bind(me.id),
      env.DB.prepare('UPDATE members SET left_at=?, ver=? WHERE user_id=? AND left_at IS NULL').bind(now, now, me.id),
    ]);
    return json({ ok: true }, 200, { 'set-cookie': 'avm_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }

  // ---- users / contacts / blocks ----
  if (p === '/api/users/search' && m === 'GET') {
    const q = clamp(url.searchParams.get('q'), 40).trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return json({ users: [] });
    const ph = normPhone(q);
    const rows = (await env.DB.prepare(`SELECT id FROM users WHERE banned=0 AND deleted=0 AND id<>? AND (username LIKE ? ESCAPE '\\' OR (? <> 'bad' AND phone=?) OR (length(?)>=3 AND lower(name) LIKE ? ESCAPE '\\')) AND id NOT IN (SELECT user_id FROM blocks WHERE blocked_id=?) ORDER BY (username=?) DESC, username LIMIT 25`).bind(me.id, likeEsc(q) + '%', ph || 'bad', ph || '-', q, '%' + likeEsc(q) + '%', me.id, q).all()).results;
    const users = await usersPublic(env, me, rows.map((r) => r.id));
    return json({ users: rows.map((r) => users[r.id]).filter(Boolean) });
  }
  if ((mt = p.match(/^\/api\/users\/([\w-]+)$/)) && m === 'GET') {
    const users = await usersPublic(env, me, [mt[1]]); if (!users[mt[1]]) err(404, 'User not found');
    const common = (await env.DB.prepare(`SELECT c.id, c.name FROM chats c JOIN members a ON a.chat_id=c.id AND a.user_id=? AND a.left_at IS NULL JOIN members b ON b.chat_id=c.id AND b.user_id=? AND b.left_at IS NULL WHERE c.type='group'`).bind(me.id, mt[1]).all()).results;
    return json({ user: users[mt[1]], common_groups: common });
  }
  if (p === '/api/contacts' && m === 'GET') {
    const ids = (await env.DB.prepare('SELECT contact_id FROM contacts WHERE user_id=?').bind(me.id).all()).results.map((r) => r.contact_id);
    const users = await usersPublic(env, me, ids); return json({ users: ids.map((i) => users[i]).filter((u) => u && u.name !== 'Deleted account') });
  }
  if (p === '/api/contacts' && m === 'POST') { const b = await body(); const u = await env.DB.prepare('SELECT id FROM users WHERE id=? AND deleted=0').bind(b.user_id).first(); if (!u || u.id === me.id) err(400, 'User not found'); await env.DB.prepare('INSERT OR IGNORE INTO contacts(user_id,contact_id,created_at) VALUES(?,?,?)').bind(me.id, u.id, now).run(); return json({ ok: true }); }
  if ((mt = p.match(/^\/api\/contacts\/([\w-]+)$/)) && m === 'DELETE') { await env.DB.prepare('DELETE FROM contacts WHERE user_id=? AND contact_id=?').bind(me.id, mt[1]).run(); return json({ ok: true }); }
  if ((mt = p.match(/^\/api\/users\/([\w-]+)\/block$/)) && m === 'POST') {
    const b = await body(); if (mt[1] === me.id) err(400, 'You cannot block yourself');
    if (b.on) await env.DB.prepare('INSERT OR IGNORE INTO blocks(user_id,blocked_id,created_at) VALUES(?,?,?)').bind(me.id, mt[1], now).run();
    else await env.DB.prepare('DELETE FROM blocks WHERE user_id=? AND blocked_id=?').bind(me.id, mt[1]).run();
    await env.DB.prepare(`UPDATE chats SET ver=? WHERE direct_key=?`).bind(now, [me.id, mt[1]].sort().join(':')).run();
    return json({ ok: true });
  }
  if (p === '/api/blocks' && m === 'GET') { const ids = (await env.DB.prepare('SELECT blocked_id FROM blocks WHERE user_id=?').bind(me.id).all()).results.map((r) => r.blocked_id); const users = await usersPublic(env, me, ids); return json({ users: ids.map((i) => users[i]).filter(Boolean) }); }
  if ((mt = p.match(/^\/api\/users\/([\w-]+)\/report$/)) && m === 'POST') {
    const b = await body(); if (!(await rateHit(env, 'report:' + me.id, 20, 86400000))) err(429, 'Too many reports today');
    await env.DB.prepare('INSERT INTO reports(reporter_id,target_id,chat_id,reason,created_at) VALUES(?,?,?,?,?)').bind(me.id, mt[1], b.chat_id || null, clamp(b.reason, 500), now).run();
    if (b.block) await env.DB.prepare('INSERT OR IGNORE INTO blocks(user_id,blocked_id,created_at) VALUES(?,?,?)').bind(me.id, mt[1], now).run();
    return json({ ok: true });
  }

  // ---- chats ----
  if (p === '/api/chats' && m === 'GET') return json(await chatList(env, me));
  if (p === '/api/chats/direct' && m === 'POST') {
    const b = await body(); const other = await env.DB.prepare('SELECT * FROM users WHERE id=? AND deleted=0 AND banned=0').bind(b.user_id).first();
    if (!other) err(404, 'User not found');
    let c;
    if (other.id === me.id) err(400, 'That is you');
    const key = [me.id, other.id].sort().join(':');
    c = await env.DB.prepare('SELECT id FROM chats WHERE direct_key=?').bind(key).first();
    if (!c) {
      const id = 'c_' + rid(10);
      await env.DB.prepare(`INSERT OR IGNORE INTO chats(id,type,created_by,created_at,direct_key,ver) VALUES(?,'direct',?,?,?,?)`).bind(id, me.id, now, key, now).run();
      c = await env.DB.prepare('SELECT id FROM chats WHERE direct_key=?').bind(key).first();
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO members(chat_id,user_id,joined_at,ver) VALUES(?,?,?,?)').bind(c.id, me.id, 0, now),
        env.DB.prepare('INSERT OR IGNORE INTO members(chat_id,user_id,joined_at,ver,hidden) VALUES(?,?,?,?,1)').bind(c.id, other.id, 0, now),
      ]);
    } else await env.DB.prepare('UPDATE members SET hidden=0, ver=? WHERE chat_id=? AND user_id=?').bind(now, c.id, me.id).run();
    await env.DB.prepare('INSERT OR IGNORE INTO contacts(user_id,contact_id,created_at) VALUES(?,?,?)').bind(me.id, other.id, now).run();
    const l = await chatList(env, me, c.id); return json({ chat: l.chats[0], users: l.users });
  }
  if (p === '/api/chats/group' && m === 'POST') {
    const b = await body(); const name = clamp(b.name, 60).trim(); if (!name) err(400, 'Please enter a group name');
    const ids = [...new Set((b.members || []).filter((x) => typeof x === 'string' && x !== me.id))].slice(0, 255);
    if (!ids.length) err(400, 'Pick at least one member');
    const ok = (await env.DB.prepare(`SELECT id, name FROM users WHERE deleted=0 AND banned=0 AND id IN (${ids.map(() => '?').join(',')}) AND id NOT IN (SELECT user_id FROM blocks WHERE blocked_id=?)`).bind(...ids, me.id).all()).results;
    const id = 'g_' + rid(10);
    const stmts = [env.DB.prepare(`INSERT INTO chats(id,type,name,description,photo,created_by,created_at,last_msg_at,ver) VALUES(?,'group',?,?,?,?,?,?,?)`).bind(id, name, clamp(b.description, 500), null, me.id, now, now, now),
      env.DB.prepare(`INSERT INTO members(chat_id,user_id,role,joined_at,ver) VALUES(?,?,'admin',?,?)`).bind(id, me.id, now - 1, now)];
    for (const u of ok) stmts.push(env.DB.prepare(`INSERT INTO members(chat_id,user_id,role,joined_at,ver) VALUES(?,?,'member',?,?)`).bind(id, u.id, now - 1, now));
    await env.DB.batch(stmts);
    if (b.photo) { const f = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').bind(b.photo, me.id).first(); if (f) { await env.DB.prepare('UPDATE files SET scope=? WHERE id=?').bind('group:' + id, f.id).run(); await env.DB.prepare('UPDATE chats SET photo=? WHERE id=?').bind(f.id, id).run(); } }
    await sysMsg(env, id, me.id, { ev: 'created', actor: me.name, name });
    if (ok.length) await sysMsg(env, id, me.id, { ev: 'added', actor: me.name, targets: ok.map((u) => u.name) });
    const l = await chatList(env, me, id); return json({ chat: l.chats[0], users: l.users, skipped: ids.length - ok.length });
  }
  // ---- channels, invite links ----
  if (p === '/api/chats/channel' && m === 'POST') {
    const b = await body(); const name = clamp(b.name, 60).trim(); if (!name) err(400, 'Please enter a channel name');
    if (!(await rateHit(env, 'chan:' + me.id, 20, 86400000))) err(429, 'Too many new channels today');
    const id = 'g_' + rid(10);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chats(id,type,name,description,photo,created_by,created_at,last_msg_at,ver,only_admins,channel,public) VALUES(?,'group',?,?,?,?,?,?,?,1,1,?)`).bind(id, name, clamp(b.description, 500), null, me.id, now, now, now, b.public ? 1 : 0),
      env.DB.prepare(`INSERT INTO members(chat_id,user_id,role,joined_at,ver) VALUES(?,?,'admin',?,?)`).bind(id, me.id, now - 1, now),
    ]);
    await sysMsg(env, id, me.id, { ev: 'created_channel', actor: me.name, name });
    const l = await chatList(env, me, id); return json({ chat: l.chats[0], users: l.users });
  }
  if (p === '/api/channels' && m === 'GET') {
    const q = clamp(url.searchParams.get('q'), 40).trim().toLowerCase();
    const rows = (await env.DB.prepare(`SELECT c.id, c.name, c.description, c.photo, (SELECT COUNT(*) FROM members mm WHERE mm.chat_id=c.id AND mm.left_at IS NULL) AS member_count, EXISTS(SELECT 1 FROM members x WHERE x.chat_id=c.id AND x.user_id=? AND x.left_at IS NULL) AS joined FROM chats c WHERE c.channel=1 AND c.public=1 AND (?='' OR lower(c.name) LIKE ?) ORDER BY member_count DESC, c.last_msg_at DESC LIMIT 50`).bind(me.id, q, '%' + likeEsc(q) + '%').all()).results;
    return json({ channels: rows.map((r) => ({ ...r, joined: !!r.joined })) });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/join$/)) && m === 'POST') {
    const c = await env.DB.prepare('SELECT * FROM chats WHERE id=?').bind(mt[1]).first();
    if (!c || !c.channel || !c.public) err(404, 'Channel not found');
    await joinChat(env, me, c, now, 'joined_channel');
    const l = await chatList(env, me, c.id); return json({ chat: l.chats[0], users: l.users });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/invite$/)) && (m === 'POST' || m === 'GET')) {
    const mem = await member(env, mt[1], me.id); if (mem.c_type !== 'group') err(400, 'Invite links are for groups and channels');
    if (mem.role !== 'admin') err(403, 'Only admins can share the invite link', 'not_admin');
    const c = await env.DB.prepare('SELECT invite_code FROM chats WHERE id=?').bind(mt[1]).first();
    let code = c.invite_code; const b = m === 'POST' ? await body() : {};
    if (b.revoke) { await env.DB.prepare('UPDATE chats SET invite_code=NULL WHERE id=?').bind(mt[1]).run(); return json({ code: null }); }
    if (!code || b.reset) { code = rid(9).replace(/[^A-Za-z0-9]/g, 'k'); await env.DB.prepare('UPDATE chats SET invite_code=? WHERE id=?').bind(code, mt[1]).run(); }
    return json({ code, url: new URL('/join/' + code, req.url).href });
  }
  if ((mt = p.match(/^\/api\/invite\/([A-Za-z0-9]{6,20})(\/join)?$/))) {
    const c = await env.DB.prepare('SELECT * FROM chats WHERE invite_code=?').bind(mt[1]).first();
    if (!c) err(404, 'This invite link is not valid anymore', 'bad_invite');
    if (!mt[2] && m === 'GET') {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE chat_id=? AND left_at IS NULL').bind(c.id).first();
      const mine = await env.DB.prepare('SELECT left_at FROM members WHERE chat_id=? AND user_id=?').bind(c.id, me.id).first();
      return json({ chat: { id: c.id, name: c.name, description: c.description, photo: c.photo, channel: !!c.channel, member_count: n.n, joined: !!(mine && !mine.left_at) } });
    }
    if (mt[2] && m === 'POST') {
      if (!(await rateHit(env, 'join:' + me.id, 60, 3600000))) err(429, 'Too many joins, try later');
      await joinChat(env, me, c, now, c.channel ? 'joined_channel' : 'joined_link');
      const l = await chatList(env, me, c.id); return json({ chat: l.chats[0], users: l.users });
    }
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)$/)) && m === 'GET') {
    await member(env, mt[1], me.id, false);
    const l = await chatList(env, me, mt[1]);
    const ms = (await env.DB.prepare('SELECT user_id, role, joined_at, left_at FROM members WHERE chat_id=?').bind(mt[1]).all()).results;
    let active = ms.filter((x) => !x.left_at);
    if (l.chats[0] && l.chats[0].channel && l.chats[0].my_role !== 'admin') active = active.filter((x) => x.role === 'admin' || x.user_id === me.id);
    const users = await usersPublic(env, me, active.map((x) => x.user_id));
    return json({ chat: l.chats[0], members: active.map((x) => ({ user_id: x.user_id, role: x.role, joined_at: x.joined_at })), users: { ...l.users, ...users } });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)$/)) && m === 'PATCH') {
    const mem = await member(env, mt[1], me.id); const b = await body();
    const isGroup = mem.c_type === 'group'; const isAdmin = mem.role === 'admin';
    if (isGroup && !isAdmin && (b.name !== undefined || b.photo !== undefined || b.only_admins !== undefined || b.disappearing !== undefined || b.description !== undefined)) err(403, 'Only group admins can change this', 'not_admin');
    if (b.name !== undefined && isGroup) { const n = clamp(b.name, 60).trim(); if (!n) err(400, 'Name cannot be empty'); await env.DB.prepare('UPDATE chats SET name=? WHERE id=?').bind(n, mt[1]).run(); await sysMsg(env, mt[1], me.id, { ev: 'name', actor: me.name, name: n }); }
    if (b.description !== undefined && isGroup) await env.DB.prepare('UPDATE chats SET description=? WHERE id=?').bind(clamp(b.description, 500), mt[1]).run();
    if (b.photo !== undefined && isGroup) { if (b.photo) { const f = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').bind(b.photo, me.id).first(); if (!f) err(400, 'Bad photo'); await env.DB.prepare('UPDATE files SET scope=? WHERE id=?').bind('group:' + mt[1], f.id).run(); } await env.DB.prepare('UPDATE chats SET photo=? WHERE id=?').bind(b.photo || null, mt[1]).run(); await sysMsg(env, mt[1], me.id, { ev: 'photo', actor: me.name }); }
    if (b.only_admins !== undefined && isGroup) { await env.DB.prepare('UPDATE chats SET only_admins=? WHERE id=?').bind(b.only_admins ? 1 : 0, mt[1]).run(); await sysMsg(env, mt[1], me.id, { ev: 'only_admins', actor: me.name, on: !!b.only_admins }); }
    if (b.disappearing !== undefined) { const d = [0, 86400, 604800, 7776000].includes(+b.disappearing) ? +b.disappearing : 0; await env.DB.prepare('UPDATE chats SET disappearing=? WHERE id=?').bind(d, mt[1]).run(); await sysMsg(env, mt[1], me.id, { ev: 'disappearing', actor: me.name, seconds: d }); }
    await bumpChat(env, mt[1]);
    const l = await chatList(env, me, mt[1]); return json({ chat: l.chats[0] });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/members$/)) && m === 'POST') {
    const mem = await member(env, mt[1], me.id); if (mem.c_type !== 'group' || mem.role !== 'admin') err(403, 'Only group admins can add members', 'not_admin');
    const b = await body(); const ids = [...new Set((b.user_ids || []).filter((x) => typeof x === 'string'))].slice(0, 100); if (!ids.length) err(400, 'Pick someone to add');
    const ok = (await env.DB.prepare(`SELECT id, name FROM users WHERE deleted=0 AND banned=0 AND id IN (${ids.map(() => '?').join(',')}) AND id NOT IN (SELECT user_id FROM blocks WHERE blocked_id=?) AND id NOT IN (SELECT user_id FROM members WHERE chat_id=? AND left_at IS NULL)`).bind(...ids, me.id, mt[1]).all()).results;
    for (const u of ok) await env.DB.prepare(`INSERT INTO members(chat_id,user_id,role,joined_at,ver) VALUES(?,?,'member',?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET left_at=NULL, role='member', joined_at=excluded.joined_at, hidden=0, ver=excluded.ver`).bind(mt[1], u.id, now - 1, now).run();
    if (ok.length) await sysMsg(env, mt[1], me.id, { ev: 'added', actor: me.name, targets: ok.map((u) => u.name) });
    await bumpChat(env, mt[1]); return json({ ok: true, added: ok.length });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/members\/([\w-]+)$/)) && m === 'DELETE') {
    const mem = await member(env, mt[1], me.id); if (mem.c_type !== 'group') err(400, 'Not a group');
    const target = mt[2]; const self = target === me.id;
    if (!self && mem.role !== 'admin') err(403, 'Only group admins can remove members', 'not_admin');
    const t = await env.DB.prepare('SELECT u.name, m.left_at FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? AND m.user_id=?').bind(mt[1], target).first(); if (!t || t.left_at) err(404, 'Not a member');
    await sysMsg(env, mt[1], me.id, self ? { ev: 'left', actor: me.name } : { ev: 'removed', actor: me.name, targets: [t.name] });
    await env.DB.prepare(`UPDATE members SET left_at=?, role='member', ver=? WHERE chat_id=? AND user_id=?`).bind(Date.now(), now, mt[1], target).run();
    const admins = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE chat_id=? AND left_at IS NULL AND role='admin'`).bind(mt[1]).first();
    if (!admins.n) { const next = await env.DB.prepare('SELECT user_id FROM members WHERE chat_id=? AND left_at IS NULL ORDER BY joined_at LIMIT 1').bind(mt[1]).first(); if (next) await env.DB.prepare(`UPDATE members SET role='admin', ver=? WHERE chat_id=? AND user_id=?`).bind(now, mt[1], next.user_id).run(); }
    await bumpChat(env, mt[1]); return json({ ok: true });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/members\/([\w-]+)\/role$/)) && m === 'POST') {
    const mem = await member(env, mt[1], me.id); if (mem.c_type !== 'group' || mem.role !== 'admin') err(403, 'Only group admins can do this', 'not_admin');
    const b = await body(); const role = b.role === 'admin' ? 'admin' : 'member';
    const t = await env.DB.prepare('SELECT u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? AND m.user_id=? AND m.left_at IS NULL').bind(mt[1], mt[2]).first(); if (!t) err(404, 'Not a member');
    await env.DB.prepare('UPDATE members SET role=?, ver=? WHERE chat_id=? AND user_id=?').bind(role, now, mt[1], mt[2]).run();
    await sysMsg(env, mt[1], me.id, { ev: role === 'admin' ? 'admin' : 'unadmin', actor: me.name, targets: [t.name] });
    await bumpChat(env, mt[1]); return json({ ok: true });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/prefs$/)) && m === 'POST') {
    await member(env, mt[1], me.id, false); const b = await body(); const sets = [], args = [];
    if (b.locked && !me.pin_hash) err(400, 'Set a chat-lock PIN in Settings first', 'no_pin');
    if (b.pinned) { const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id=? AND pinned=1 AND chat_id<>?').bind(me.id, mt[1]).first(); if (n.n >= 3) err(400, 'You can pin up to 3 chats', 'pin_limit'); }
    for (const k of ['archived', 'pinned', 'locked']) if (b[k] !== undefined) { sets.push(k + '=?'); args.push(b[k] ? 1 : 0); }
    if (b.muted_until !== undefined) { sets.push('muted_until=?'); args.push(Math.max(0, +b.muted_until || 0)); }
    if (b.wallpaper !== undefined) { sets.push('wallpaper=?'); args.push(b.wallpaper ? clamp(b.wallpaper, 40) : null); }
    if (sets.length) await env.DB.prepare(`UPDATE members SET ${sets.join(',')}, ver=? WHERE chat_id=? AND user_id=?`).bind(...args, now, mt[1], me.id).run();
    return json({ ok: true });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/read$/)) && m === 'POST') {
    const mem = await member(env, mt[1], me.id, false); const b = await body(); const upto = Math.min(now, +b.upto || now);
    if (upto > mem.seen_upto) {
      const pub = me.read_receipts || mem.c_type === 'group';
      if (pub) await env.DB.prepare(`UPDATE members SET seen_upto=?, delivered_upto=MAX(delivered_upto,?), read_upto=?, rcpt_ver=? WHERE chat_id=? AND user_id=?`).bind(upto, upto, upto, now, mt[1], me.id).run();
      else await env.DB.prepare(`UPDATE members SET seen_upto=?, delivered_upto=MAX(delivered_upto,?), rcpt_ver=? WHERE chat_id=? AND user_id=?`).bind(upto, upto, now, mt[1], me.id).run();
    }
    return json({ ok: true });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/typing$/)) && m === 'POST') {
    await member(env, mt[1], me.id); const b = await body();
    if (b.kind) await env.DB.prepare('INSERT INTO typing(chat_id,user_id,kind,until) VALUES(?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET kind=excluded.kind, until=excluded.until').bind(mt[1], me.id, b.kind === 'recording' ? 'recording' : 'typing', now + 6000).run();
    else await env.DB.prepare('DELETE FROM typing WHERE chat_id=? AND user_id=?').bind(mt[1], me.id).run();
    return json({ ok: true });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/clear$/)) && m === 'POST') { await member(env, mt[1], me.id, false); await env.DB.prepare('UPDATE members SET cleared_upto=?, seen_upto=MAX(seen_upto,?), ver=? WHERE chat_id=? AND user_id=?').bind(now, now, now, mt[1], me.id).run(); return json({ ok: true }); }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/delete$/)) && m === 'POST') {
    const mem = await member(env, mt[1], me.id, false); if (mem.c_type === 'group' && !mem.left_at) err(400, 'Exit the group first', 'exit_first');
    await env.DB.prepare('UPDATE members SET cleared_upto=?, seen_upto=MAX(seen_upto,?), hidden=1, archived=0, pinned=0, ver=? WHERE chat_id=? AND user_id=?').bind(now, now, now, mt[1], me.id).run(); return json({ ok: true });
  }
  return api2(req, env, url, me, body);
}

async function api2(req, env, url, me, body) {
  const p = url.pathname; const m = req.method; const now = Date.now(); let mt;

  // ---- messages in a chat ----
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/messages$/)) && m === 'GET') {
    const mem = await member(env, mt[1], me.id, false);
    const before = +url.searchParams.get('before') || now + 1; const limit = Math.min(100, +url.searchParams.get('limit') || 50);
    const rows = (await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.chat_id=? AND m.deliver_at<? AND m.deliver_at<=? AND m.deliver_at>=? AND m.deliver_at>? AND (? IS NULL OR m.deliver_at<=?) AND (m.expires_at IS NULL OR m.expires_at>?) AND m.id NOT IN (SELECT message_id FROM hidden WHERE user_id=?) ORDER BY m.deliver_at DESC, m.id DESC LIMIT ?`).bind(mt[1], before, now, mem.joined_at, mem.cleared_upto, mem.left_at, mem.left_at, now, me.id, limit).all()).results;
    const receipts = (await env.DB.prepare('SELECT user_id, delivered_upto, read_upto, left_at FROM members WHERE chat_id=? AND user_id<>?').bind(mt[1], me.id).all()).results;
    return json({ messages: (await enrichMessages(env, me, rows)).reverse(), receipts, more: rows.length === limit });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/search$/)) && m === 'GET') {
    const mem = await member(env, mt[1], me.id, false); const q = clamp(url.searchParams.get('q'), 60).trim(); if (!q) return json({ messages: [] });
    const like = '%' + likeEsc(q) + '%';
    const rows = (await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.chat_id=? AND m.deleted=0 AND m.deliver_at<=? AND m.deliver_at>=? AND m.deliver_at>? AND (? IS NULL OR m.deliver_at<=?) AND (m.expires_at IS NULL OR m.expires_at>?) AND (m.body LIKE ? ESCAPE '\\' OR json_extract(m.meta,'$.name') LIKE ? ESCAPE '\\' OR json_extract(m.meta,'$.question') LIKE ? ESCAPE '\\') AND m.id NOT IN (SELECT message_id FROM hidden WHERE user_id=?) ORDER BY m.deliver_at DESC LIMIT 50`).bind(mt[1], now, mem.joined_at, mem.cleared_upto, mem.left_at, mem.left_at, now, like, like, like, me.id).all()).results;
    return json({ messages: rows.map((r) => serMsg(r)) });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/media$/)) && m === 'GET') {
    const mem = await member(env, mt[1], me.id, false);
    const rows = (await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.chat_id=? AND m.deleted=0 AND m.file_id IS NOT NULL AND m.deliver_at<=? AND m.deliver_at>=? AND m.deliver_at>? AND (? IS NULL OR m.deliver_at<=?) AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.deliver_at DESC LIMIT 200`).bind(mt[1], now, mem.joined_at, mem.cleared_upto, mem.left_at, mem.left_at, now).all()).results;
    return json({ messages: rows.map((r) => serMsg(r)) });
  }
  if ((mt = p.match(/^\/api\/chats\/([\w-]+)\/messages$/)) && m === 'POST') {
    const mem = await member(env, mt[1], me.id); const b = await body();
    return json({ message: await createMessage(env, me, mem, mt[1], b) });
  }

  // ---- single message ----
  if ((mt = p.match(/^\/api\/messages\/(\d+)(\/[a-z]+)?$/))) {
    const id = +mt[1]; const action = mt[2] || '';
    const msg = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first(); if (!msg) err(404, 'Message not found');
    const mem = await member(env, msg.chat_id, me.id, !['/star', '/delete', '/info', '/forward'].includes(action));
    if ((msg.deliver_at > now && msg.sender_id !== me.id) || msg.deliver_at < mem.joined_at || msg.deliver_at <= mem.cleared_upto || (mem.left_at && msg.deliver_at > mem.left_at)) err(404, 'Message not found');
    const done = async () => { const row = await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.id=?`).bind(id).first(); return json({ message: (await enrichMessages(env, me, [row]))[0] }); };
    if (action === '' && m === 'PATCH') {
      const b = await body(); if (msg.sender_id !== me.id || msg.type !== 'text' || msg.deleted) err(403, 'You can only edit your own text messages', 'not_yours');
      if (now - msg.deliver_at > EDIT_WINDOW) err(400, 'Messages can be edited for 15 minutes after sending', 'edit_window');
      const t = clamp(b.body, 10000); if (!t.trim()) err(400, 'Empty message');
      await env.DB.prepare('UPDATE messages SET body=?, edited_at=?, ver=MAX(?, deliver_at) WHERE id=?').bind(t, now, now, id).run();
      return done();
    }
    if (action === '/delete' && m === 'POST') {
      const b = await body();
      if (b.for === 'everyone') {
        const isAdmin = mem.c_type === 'group' && mem.role === 'admin' && !mem.left_at;
        if (msg.sender_id !== me.id && !isAdmin) err(403, 'You can only delete your own messages for everyone', 'not_yours');
        if (msg.sender_id === me.id && !isAdmin && msg.deliver_at <= now && now - msg.deliver_at > DELETE_ALL_WINDOW) err(400, 'Too old to delete for everyone (24 h limit)', 'delete_window');
        if (msg.type === 'system' || msg.type === 'call') err(400, 'This can’t be deleted for everyone');
        await env.DB.prepare(`UPDATE messages SET deleted=1, body='', meta=?, file_id=NULL, ver=MAX(?, deliver_at) WHERE id=?`).bind(JSON.stringify(msg.sender_id !== me.id ? { by_admin: me.name } : {}), now, id).run();
        await env.DB.prepare('DELETE FROM reactions WHERE message_id=?').bind(id).run();
        if (msg.file_id) await dropFile(env, msg.file_id);
        const th = J(msg.meta, {}).thumb; if (th) await dropFile(env, th);
        const ch = await env.DB.prepare('SELECT pinned FROM chats WHERE id=?').bind(msg.chat_id).first(); const pins = J(ch.pinned, []);
        if (pins.includes(id)) await env.DB.prepare('UPDATE chats SET pinned=?, ver=? WHERE id=?').bind(JSON.stringify(pins.filter((x) => x !== id)), now, msg.chat_id).run();
      } else await env.DB.prepare('INSERT OR IGNORE INTO hidden(user_id,message_id) VALUES(?,?)').bind(me.id, id).run();
      return json({ ok: true });
    }
    if (action === '/react' && m === 'POST') {
      const b = await body(); if (msg.deleted || msg.type === 'system') err(400, 'Can’t react to this');
      if (b.emoji) { const e = clamp(b.emoji, 16); await env.DB.prepare('INSERT INTO reactions(message_id,user_id,emoji,at) VALUES(?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji, at=excluded.at').bind(id, me.id, e, now).run(); }
      else await env.DB.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=?').bind(id, me.id).run();
      await env.DB.prepare('UPDATE messages SET ver=MAX(?, deliver_at) WHERE id=?').bind(now, id).run();
      return done();
    }
    if (action === '/star' && m === 'POST') {
      const b = await body();
      if (b.on) await env.DB.prepare('INSERT OR IGNORE INTO stars(user_id,message_id,at) VALUES(?,?,?)').bind(me.id, id, now).run();
      else await env.DB.prepare('DELETE FROM stars WHERE user_id=? AND message_id=?').bind(me.id, id).run();
      return done();
    }
    if (action === '/pin' && m === 'POST') {
      const b = await body(); if (msg.deleted || msg.type === 'system') err(400, 'Can’t pin this');
      if (mem.c_type === 'group' && mem.c_only_admins && mem.role !== 'admin') err(403, 'Only admins can pin messages here', 'not_admin');
      const ch = await env.DB.prepare('SELECT pinned FROM chats WHERE id=?').bind(msg.chat_id).first(); let pins = J(ch.pinned, []).filter((x) => x !== id);
      if (b.on) { pins.push(id); if (pins.length > 3) pins = pins.slice(-3); }
      await env.DB.prepare('UPDATE chats SET pinned=?, ver=? WHERE id=?').bind(JSON.stringify(pins), now, msg.chat_id).run();
      if (b.on) await sysMsg(env, msg.chat_id, me.id, { ev: 'pinned', actor: me.name, msg: id });
      return json({ ok: true, pinned: pins });
    }
    if (action === '/vote' && m === 'POST') {
      const b = await body(); if (msg.type !== 'poll' || msg.deleted) err(400, 'Not a poll');
      const meta = J(msg.meta, {}); let opts = [...new Set((b.options || []).map((x) => +x).filter((x) => Number.isInteger(x) && x >= 0 && x < meta.options.length))];
      if (!meta.multi) opts = opts.slice(0, 1);
      await env.DB.prepare('DELETE FROM votes WHERE message_id=? AND user_id=?').bind(id, me.id).run();
      for (const o of opts) await env.DB.prepare('INSERT OR IGNORE INTO votes(message_id,user_id,opt) VALUES(?,?,?)').bind(id, me.id, o).run();
      await env.DB.prepare('UPDATE messages SET ver=MAX(?, deliver_at) WHERE id=?').bind(now, id).run();
      return done();
    }
    if (action === '/forward' && m === 'POST') {
      const b = await body(); if (msg.deleted || ['system', 'call'].includes(msg.type)) err(400, 'Can’t forward this');
      if (J(msg.meta, {}).once) err(400, 'View-once media can’t be forwarded');
      const targets = [...new Set((b.chat_ids || []).filter((x) => typeof x === 'string'))].slice(0, 5); if (!targets.length) err(400, 'Pick a chat');
      const out = [];
      for (const t of targets) {
        const tm = await member(env, t, me.id);
        let fileId = null, meta = J(msg.meta, {});
        if (msg.file_id) {
          const f = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(msg.file_id).first(); if (!f) continue;
          fileId = 'f_' + rid(12);
          await env.DB.prepare('INSERT INTO files(id,owner_id,scope,r2_key,name,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(fileId, me.id, 'chat:' + t, f.r2_key, f.name, f.mime, f.size, now).run();
          if (meta.thumb) { const tf = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(meta.thumb).first(); if (tf) { const nt = 'f_' + rid(12); await env.DB.prepare('INSERT INTO files(id,owner_id,scope,r2_key,name,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(nt, me.id, 'chat:' + t, tf.r2_key, tf.name, tf.mime, tf.size, now).run(); meta.thumb = nt; } else delete meta.thumb; }
        }
        if (msg.type === 'poll' && tm.c_type !== 'group') continue;
        out.push(await createMessage(env, me, tm, t, { type: msg.type, body: msg.body, meta, file_id: fileId }, { forwarded: 1, rawMeta: true }));
      }
      return json({ messages: out });
    }
    if (action === '/info' && m === 'GET') {
      if (msg.sender_id !== me.id) err(403, 'Only for your own messages');
      const rows = (await env.DB.prepare('SELECT user_id, delivered_upto, read_upto FROM members WHERE chat_id=? AND user_id<>? AND left_at IS NULL').bind(msg.chat_id, me.id).all()).results;
      const users = await usersPublic(env, me, rows.map((r) => r.user_id));
      return json({ read: rows.filter((r) => r.read_upto >= msg.deliver_at).map((r) => ({ user: users[r.user_id], at: r.read_upto })), delivered: rows.filter((r) => r.read_upto < msg.deliver_at && r.delivered_upto >= msg.deliver_at).map((r) => ({ user: users[r.user_id], at: r.delivered_upto })), pending: rows.filter((r) => r.delivered_upto < msg.deliver_at).map((r) => ({ user: users[r.user_id] })) });
    }
    err(404, 'Unknown action');
  }
  if (p === '/api/starred' && m === 'GET') {
    const rows = (await env.DB.prepare(`SELECT ${MSG_COLS} FROM stars s JOIN messages m ON m.id=s.message_id JOIN members cm ON cm.chat_id=m.chat_id AND cm.user_id=s.user_id LEFT JOIN messages r ON r.id=m.reply_to WHERE s.user_id=? AND m.deleted=0 AND m.deliver_at>cm.cleared_upto AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY s.at DESC LIMIT 200`).bind(me.id, now).all()).results;
    return json({ messages: (await enrichMessages(env, me, rows)) });
  }

  // ---- files ----
  if (p === '/api/upload' && m === 'POST') {
    const scope = clamp(url.searchParams.get('scope'), 60); const name = clamp(url.searchParams.get('name') || 'file', 200).replace(/[\/\\\r\n"]/g, '_');
    const mime = clamp((req.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase(), 100);
    const len = +req.headers.get('content-length') || 0;
    if (len > MAX_FILE) err(413, 'File too large (max 50 MB)', 'too_large');
    let sc;
    if (scope === 'avatar' || scope === 'status' || scope === 'group-new') sc = scope === 'group-new' ? 'group:new' : scope;
    else if (scope === 'brand') { if (me.role !== 'admin') err(403, 'Admins only'); sc = 'brand'; if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/.test(mime)) err(400, 'Logo: PNG/JPG/WebP image. Video: MP4 or WebM.'); }
    else if (/^chat:[\w-]+$/.test(scope)) { const mem = await member(env, scope.slice(5), me.id); sc = scope; }
    else if (/^group:[\w-]+$/.test(scope)) { const mem = await member(env, scope.slice(6), me.id); if (mem.role !== 'admin') err(403, 'Only group admins'); sc = scope; }
    else err(400, 'Bad scope');
    if (!(await rateHit(env, 'upload:' + me.id, 300, 3600000))) err(429, 'Too many uploads, slow down a little');
    const buf = await req.arrayBuffer(); if (buf.byteLength > MAX_FILE) err(413, 'File too large (max 50 MB)', 'too_large'); if (!buf.byteLength) err(400, 'Empty file');
    const id = 'f_' + rid(12); const key = `${me.id}/${id}`;
    await env.FILES.put(key, buf, { httpMetadata: { contentType: mime } });
    await env.DB.prepare('INSERT INTO files(id,owner_id,scope,r2_key,name,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, me.id, sc, key, name, mime, buf.byteLength, now).run();
    return json({ file: { id, name, mime, size: buf.byteLength } });
  }
  if ((mt = p.match(/^\/api\/files\/(f_[\w]+)$/)) && (m === 'GET' || m === 'HEAD')) {
    const f = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(mt[1]).first();
    if (!f || !(await canReadFile(env, me, f))) err(404, 'File not found');
    const range = req.headers.get('range'); let opts = {}; let start = 0, end = f.size - 1;
    const rm = range && range.match(/^bytes=(\d*)-(\d*)$/);
    if (rm && (rm[1] || rm[2])) { if (rm[1]) { start = +rm[1]; end = rm[2] ? Math.min(+rm[2], f.size - 1) : f.size - 1; } else { start = Math.max(0, f.size - +rm[2]); } if (start > end || start >= f.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${f.size}` } }); opts.range = { offset: start, length: end - start + 1 }; }
    const obj = await env.FILES.get(f.r2_key, opts); if (!obj) err(404, 'File not found');
    const inline = INLINE_TYPES.test(f.mime) && url.searchParams.get('download') !== '1';
    const h = { 'content-type': inline ? f.mime : 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable', 'accept-ranges': 'bytes', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`, 'content-length': String(end - start + 1) };
    if (opts.range) h['content-range'] = `bytes ${start}-${end}/${f.size}`;
    return new Response(m === 'HEAD' ? null : obj.body, { status: opts.range ? 206 : 200, headers: h });
  }

  // ---- calls ----
  if (p === '/api/ice' && m === 'GET') return json({ ice: await iceServers(env) });
  if (p === '/api/calls' && m === 'GET') {
    const rows = (await env.DB.prepare(`SELECT * FROM calls WHERE caller_id=? OR callee_id=? ORDER BY created_at DESC LIMIT 100`).bind(me.id, me.id).all()).results;
    const users = await usersPublic(env, me, rows.map((r) => (r.caller_id === me.id ? r.callee_id : r.caller_id)));
    return json({ calls: rows, users });
  }
  if (p === '/api/calls' && m === 'POST') {
    const b = await body(); const kind = b.kind === 'video' ? 'video' : 'voice';
    const to = await env.DB.prepare('SELECT * FROM users WHERE id=? AND deleted=0').bind(b.to).first(); if (!to || to.id === me.id) err(404, 'User not found');
    if (await isBlockedEither(env, me.id, to.id)) err(403, 'You can’t call this contact', 'blocked');
    if (!(await rateHit(env, 'call:' + me.id, 30, 600000))) err(429, 'Too many calls, wait a few minutes');
    const key = [me.id, to.id].sort().join(':');
    let chat = await env.DB.prepare('SELECT id FROM chats WHERE direct_key=?').bind(key).first();
    if (!chat) { const cid = 'c_' + rid(10); await env.DB.prepare(`INSERT OR IGNORE INTO chats(id,type,created_by,created_at,direct_key,ver) VALUES(?,'direct',?,?,?,?)`).bind(cid, me.id, now, key, now).run(); chat = await env.DB.prepare('SELECT id FROM chats WHERE direct_key=?').bind(key).first(); await env.DB.batch([env.DB.prepare('INSERT OR IGNORE INTO members(chat_id,user_id,joined_at,ver) VALUES(?,?,?,?)').bind(chat.id, me.id, 0, now), env.DB.prepare('INSERT OR IGNORE INTO members(chat_id,user_id,joined_at,ver) VALUES(?,?,?,?)').bind(chat.id, to.id, 0, now)]); }
    // stale cleanup for both
    const busy = (await env.DB.prepare(`SELECT * FROM calls WHERE status IN ('ringing','accepted') AND (caller_id IN (?,?) OR callee_id IN (?,?))`).bind(me.id, to.id, me.id, to.id).all()).results;
    for (const c of busy) { if ((c.status === 'ringing' && now - c.created_at > RING_MS) || (c.caller_id === me.id || c.callee_id === me.id)) await finishCall(env, c, c.status === 'ringing' ? 'missed' : 'ended', me.id); }
    const stillBusy = await env.DB.prepare(`SELECT id FROM calls WHERE status IN ('ringing','accepted') AND (caller_id=? OR callee_id=?)`).bind(to.id, to.id).first();
    const id = 'k_' + rid(12);
    if (stillBusy) {
      await env.DB.prepare('INSERT INTO calls(id,chat_id,caller_id,callee_id,kind,status,created_at,ended_at,end_reason,ver) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, chat.id, me.id, to.id, kind, 'busy', now, now, 'busy', now).run();
      return json({ call: await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(id).first(), busy: true });
    }
    await env.DB.prepare('INSERT INTO calls(id,chat_id,caller_id,callee_id,kind,status,created_at,ver) VALUES(?,?,?,?,?,?,?,?)').bind(id, chat.id, me.id, to.id, kind, 'ringing', now, now).run();
    return json({ call: await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(id).first(), ice: await iceServers(env) });
  }
  if ((mt = p.match(/^\/api\/calls\/(k_\w+)\/(signal|accept|decline|end)$/)) && m === 'POST') {
    const c = await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(mt[1]).first();
    if (!c || (c.caller_id !== me.id && c.callee_id !== me.id)) err(404, 'Call not found');
    const other = c.caller_id === me.id ? c.callee_id : c.caller_id; const b = await body();
    if (mt[2] === 'signal') {
      if (!['ringing', 'accepted'].includes(c.status)) err(409, 'Call is over', 'over');
      const type = ['offer', 'answer', 'ice', 'renegotiate', 'state'].includes(b.type) ? b.type : null; if (!type) err(400, 'Bad signal');
      const payload = JSON.stringify(b.payload ?? null); if (payload.length > 60000) err(413, 'Signal too large');
      await env.DB.prepare('INSERT INTO signals(call_id,from_id,to_id,type,payload,created_at) VALUES(?,?,?,?,?,?)').bind(c.id, me.id, other, type, payload, now).run();
      return json({ ok: true });
    }
    if (mt[2] === 'accept') {
      if (c.callee_id !== me.id) err(403, 'Not your call');
      const r = await env.DB.prepare(`UPDATE calls SET status='accepted', answered_at=?, ver=? WHERE id=? AND status='ringing'`).bind(now, now, c.id).run();
      if (!r.meta.changes) err(409, 'Call is over', 'over');
      await env.DB.prepare('INSERT INTO signals(call_id,from_id,to_id,type,payload,created_at) VALUES(?,?,?,?,?,?)').bind(c.id, me.id, other, 'accepted', 'null', now).run();
      return json({ ok: true, ice: await iceServers(env) });
    }
    if (mt[2] === 'decline') { await finishCall(env, c, c.callee_id === me.id && c.status === 'ringing' ? 'declined' : 'ended', me.id); return json({ ok: true }); }
    if (mt[2] === 'end') { await finishCall(env, c, 'ended', me.id, clamp(b.reason, 40)); return json({ ok: true }); }
  }

  // ---- status / stories ----
  if (p === '/api/status' && m === 'GET') {
    const rows = (await env.DB.prepare(`SELECT s.*, u.name, u.photo, u.p_photo FROM statuses s JOIN users u ON u.id=s.user_id WHERE s.expires_at>? AND u.deleted=0 AND u.banned=0 ORDER BY s.created_at`).bind(now).all()).results;
    const authors = [...new Set(rows.map((r) => r.user_id))]; const visible = new Set();
    for (const a of authors) if (await canSeeStatusOf(env, me.id, a)) visible.add(a);
    const mine = rows.filter((r) => visible.has(r.user_id));
    const ids = mine.map((r) => r.id);
    const views = ids.length ? (await env.DB.prepare(`SELECT status_id, viewer_id, at FROM status_views WHERE status_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results : [];
    const users = await usersPublic(env, me, [...visible, me.id]);
    const list = mine.map((s) => { const v = views.filter((x) => x.status_id === s.id); return { id: s.id, user_id: s.user_id, type: s.type, body: s.body, bg: s.bg, file_id: s.file_id, created_at: s.created_at, expires_at: s.expires_at, seen: v.some((x) => x.viewer_id === me.id), views: s.user_id === me.id ? v.length : undefined }; });
    return json({ statuses: list, users });
  }
  if (p === '/api/status' && m === 'POST') {
    const b = await body(); const type = b.type === 'image' || b.type === 'video' ? b.type : 'text';
    if (!(await rateHit(env, 'status:' + me.id, 30, 86400000))) err(429, 'Status limit reached for today');
    let fileId = null;
    if (type !== 'text') { const f = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').bind(b.file_id, me.id).first(); if (!f || f.scope !== 'status') err(400, 'Bad file'); fileId = f.id; }
    else if (!clamp(b.body, 700).trim()) err(400, 'Write something');
    const id = 's_' + rid(10);
    await env.DB.prepare('INSERT INTO statuses(id,user_id,type,body,bg,file_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, me.id, type, clamp(b.body, 700), clamp(b.bg, 20) || '#4b38dc', fileId, now, now + STATUS_TTL).run();
    return json({ ok: true, id });
  }
  if ((mt = p.match(/^\/api\/status\/(s_\w+)(\/view|\/viewers)?$/))) {
    const s = await env.DB.prepare('SELECT * FROM statuses WHERE id=? AND expires_at>?').bind(mt[1], now).first(); if (!s) err(404, 'Status not found');
    if (!mt[2] && m === 'DELETE') { if (s.user_id !== me.id) err(403, 'Not yours'); await env.DB.prepare('DELETE FROM statuses WHERE id=?').bind(s.id).run(); if (s.file_id) await dropFile(env, s.file_id); return json({ ok: true }); }
    if (mt[2] === '/view' && m === 'POST') { if (!(await canSeeStatusOf(env, me.id, s.user_id))) err(404, 'Status not found'); if (s.user_id !== me.id) await env.DB.prepare('INSERT OR IGNORE INTO status_views(status_id,viewer_id,at) VALUES(?,?,?)').bind(s.id, me.id, now).run(); return json({ ok: true }); }
    if (mt[2] === '/viewers' && m === 'GET') { if (s.user_id !== me.id) err(403, 'Not yours'); const v = (await env.DB.prepare('SELECT viewer_id, at FROM status_views WHERE status_id=? ORDER BY at DESC').bind(s.id).all()).results; const users = await usersPublic(env, me, v.map((x) => x.viewer_id)); return json({ viewers: v.map((x) => ({ user: users[x.viewer_id], at: x.at })) }); }
  }

  // ---- admin (owner) ----
  if (p.startsWith('/api/admin/')) {
    if (me.role !== 'admin') err(403, 'Admins only', 'not_admin');
    if (p === '/api/admin/stats' && m === 'GET') {
      const day = now - 86400000;
      const [u, u24, act, msgs, m24, ch, gr, fl, cl, rp, st] = await env.DB.batch([
        env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted=0'), env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at>? AND deleted=0').bind(day),
        env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE last_seen>? AND deleted=0').bind(day), env.DB.prepare('SELECT COUNT(*) AS n FROM messages'),
        env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at>?').bind(day), env.DB.prepare(`SELECT COUNT(*) AS n FROM chats WHERE type='direct'`),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM chats WHERE type='group'`), env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files'),
        env.DB.prepare('SELECT COUNT(*) AS n FROM calls'), env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE resolved=0'), env.DB.prepare('SELECT COUNT(*) AS n FROM statuses WHERE expires_at>?').bind(now),
      ]);
      const on = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE last_seen>? AND deleted=0').bind(now - ONLINE_MS).first();
      return json({ online_now: on.n, users: u.results[0].n, new_users_24h: u24.results[0].n, active_24h: act.results[0].n, messages: msgs.results[0].n, messages_24h: m24.results[0].n, direct_chats: ch.results[0].n, groups: gr.results[0].n, files: fl.results[0].n, file_bytes: fl.results[0].bytes, calls: cl.results[0].n, open_reports: rp.results[0].n, live_statuses: st.results[0].n });
    }
    if (p === '/api/admin/users' && m === 'GET') {
      // Passwords are never readable (stored only as salted PBKDF2 hashes); the admin can set a new one instead.
      const q = clamp(url.searchParams.get('q'), 60).trim().toLowerCase(); const lk = '%' + likeEsc(q) + '%';
      const onlyOnline = url.searchParams.get('online') === '1';
      const rows = (await env.DB.prepare(`SELECT id, username, name, phone, email, role, banned, deleted, created_at, last_seen, (SELECT COUNT(*) FROM messages WHERE sender_id=users.id) AS msgs, (SELECT COUNT(*) FROM reports WHERE target_id=users.id) AS reports FROM users WHERE deleted=0 AND (?='' OR username LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\') AND (?=0 OR last_seen>?) ORDER BY ${onlyOnline ? 'last_seen' : 'created_at'} DESC LIMIT 2000`).bind(q, lk, lk, lk, lk, onlyOnline ? 1 : 0, now - 120000).all()).results;
      return json({ users: rows.map((r) => ({ ...r, online: now - r.last_seen < ONLINE_MS })), now });
    }
    if ((mt = p.match(/^\/api\/admin\/users\/([\w-]+)$/)) && m === 'DELETE') {
      const t = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(mt[1]).first(); if (!t || t.deleted) err(404, 'User not found'); if (t.role === 'admin') err(400, 'The admin account can’t be deleted');
      await adminDeleteUser(env, t, now);
      return json({ ok: true });
    }
    if ((mt = p.match(/^\/api\/admin\/users\/([\w-]+)\/password$/)) && m === 'POST') {
      const b = await body(); const pw = String(b.password || ''); if (pw.length < 8) err(400, 'Password must be at least 8 characters');
      const t = await env.DB.prepare('SELECT id, role, username FROM users WHERE id=? AND deleted=0').bind(mt[1]).first(); if (!t) err(404, 'User not found');
      if (t.role === 'admin' && t.id !== me.id) err(400, 'Not allowed');
      const h = await hashPassword(pw);
      await env.DB.batch([env.DB.prepare('UPDATE users SET pw_hash=?, pw_salt=?, pw_iter=? WHERE id=?').bind(h.hash, h.salt, h.iterations, t.id), env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(t.id, me.token_hash), env.DB.prepare('DELETE FROM attempts WHERE k=?').bind('login:u:' + t.username)]);
      return json({ ok: true });
    }
    if (p === '/api/admin/brand' && m === 'GET') return json({ brand: await getBrand(env), defaults: BRAND_DEFAULT, fonts: BRAND_FONTS, layouts: BRAND_LAYOUTS, videos: DEFAULT_VIDEOS });
    if (p === '/api/admin/brand' && m === 'POST') {
      const b = await body(); const cur = await getBrand(env); const nx = { ...cur };
      const color = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toLowerCase() : null);
      const video = async (v) => { v = String(v || ''); if (v === 'none') return v; if (v.startsWith('default:') && DEFAULT_VIDEOS.includes(v.slice(8))) return v; if (/^file:f_\w+$/.test(v)) { const f = await env.DB.prepare(`SELECT mime FROM files WHERE id=? AND scope='brand'`).bind(v.slice(5)).first(); if (f && /^video\//.test(f.mime)) return v; } err(400, 'Bad video choice'); };
      if (b.reset) { await setSetting(env, 'brand', { v: now }); return json({ brand: await getBrand(env) }); }
      if (b.app_name !== undefined) { const n = clamp(b.app_name, 30).trim(); if (!n) err(400, 'App name cannot be empty'); nx.app_name = n; }
      if (b.tagline !== undefined) nx.tagline = clamp(b.tagline, 80);
      if (b.preset !== undefined) nx.preset = clamp(b.preset, 20);
      for (const k of ['accent', 'accent2', 'bg', 'panel', 'text', 'bubble_out', 'bubble_in']) if (b[k] !== undefined) { const c = color(b[k]); if (!c) err(400, 'Colours must look like #7c3aed'); nx[k] = c; }
      if (b.font !== undefined) { if (!BRAND_FONTS.includes(b.font)) err(400, 'Unknown font'); nx.font = b.font; }
      if (b.layout !== undefined) { if (!BRAND_LAYOUTS.includes(b.layout)) err(400, 'Unknown layout'); nx.layout = b.layout; }
      if (b.bubble !== undefined) nx.bubble = b.bubble === 'square' ? 'square' : 'round';
      if (b.theme !== undefined) nx.theme = ['dark', 'light', 'user'].includes(b.theme) ? b.theme : 'dark';
      if (b.logo !== undefined) { if (b.logo) { const f = await env.DB.prepare(`SELECT mime FROM files WHERE id=? AND scope='brand'`).bind(String(b.logo)).first(); if (!f || !/^image\//.test(f.mime)) err(400, 'Bad logo'); } nx.logo = b.logo || null; }
      if (b.intro_video !== undefined) nx.intro_video = await video(b.intro_video);
      if (b.bg_video !== undefined) nx.bg_video = await video(b.bg_video);
      if (b.intro_enabled !== undefined) nx.intro_enabled = !!b.intro_enabled;
      if (b.bg_dim !== undefined) nx.bg_dim = Math.max(0, Math.min(0.9, +b.bg_dim || 0));
      if (b.screenshots !== undefined) nx.screenshots = !!b.screenshots;
      nx.v = now;
      const save = {}; for (const k of Object.keys(BRAND_DEFAULT)) if (nx[k] !== BRAND_DEFAULT[k]) save[k] = nx[k];
      await setSetting(env, 'brand', save);
      return json({ brand: await getBrand(env) });
    }
    if (p === '/api/admin/brand/files' && m === 'GET') {
      const rows = (await env.DB.prepare(`SELECT id, name, mime, size, created_at FROM files WHERE scope='brand' ORDER BY created_at DESC LIMIT 100`).all()).results; return json({ files: rows });
    }
    if ((mt = p.match(/^\/api\/admin\/brand\/files\/(f_\w+)$/)) && m === 'DELETE') {
      const br = await getBrand(env); const used = [br.logo, br.intro_video, br.bg_video].some((v) => v && String(v).endsWith(mt[1]));
      if (used) err(400, 'This file is in use. Pick another one first.');
      await dropFile(env, mt[1]); return json({ ok: true });
    }
    if (p === '/api/admin/announce' && m === 'POST') {
      const b = await body(); const pub = await getSetting(env, 'public', { announcement: '', signup_open: true });
      pub.announcement = clamp(b.text, 300); pub.announcement_at = pub.announcement ? now : 0; await setSetting(env, 'public', pub);
      return json({ ok: true });
    }
    if ((mt = p.match(/^\/api\/admin\/users\/([\w-]+)\/ban$/)) && m === 'POST') {
      const b = await body(); const t = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(mt[1]).first(); if (!t) err(404, 'User not found'); if (t.role === 'admin') err(400, 'The admin can’t be banned');
      await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(b.on ? 1 : 0, mt[1]).run();
      if (b.on) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(mt[1]).run();
      return json({ ok: true });
    }
    if (p === '/api/admin/reports' && m === 'GET') {
      const rows = (await env.DB.prepare(`SELECT r.*, a.username AS reporter, b.username AS target FROM reports r LEFT JOIN users a ON a.id=r.reporter_id LEFT JOIN users b ON b.id=r.target_id ORDER BY r.resolved, r.created_at DESC LIMIT 200`).all()).results;
      return json({ reports: rows });
    }
    if ((mt = p.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/)) && m === 'POST') { await env.DB.prepare('UPDATE reports SET resolved=1 WHERE id=?').bind(+mt[1]).run(); return json({ ok: true }); }
    if (p === '/api/admin/settings' && m === 'GET') { return json({ turn: await getSetting(env, 'turn', { urls: [], username: '', credential: '' }), public: await getSetting(env, 'public', { announcement: '', signup_open: true }) }); }
    if (p === '/api/admin/settings' && m === 'POST') {
      const b = await body();
      if (b.turn) { const urls = (Array.isArray(b.turn.urls) ? b.turn.urls : String(b.turn.urls || '').split(/[\s,]+/)).map((x) => clamp(x, 200).trim()).filter((x) => /^(turns?|stuns?):/.test(x)).slice(0, 6); await setSetting(env, 'turn', { urls, username: clamp(b.turn.username, 200), credential: clamp(b.turn.credential, 200) }); }
      if (b.public) { const old = await getSetting(env, 'public', {}); const a = clamp(b.public.announcement, 300); await setSetting(env, 'public', { announcement: a, announcement_at: a && a !== old.announcement ? now : (old.announcement_at || 0), signup_open: b.public.signup_open !== false }); }
      return json({ ok: true });
    }
  }
  err(404, 'Not found', 'not_found');
}

async function createMessage(env, me, mem, chatId, b, opt = {}) {
  const now = Date.now();
  if (mem.c_type === 'direct') { const peer = await directPeer(env, chatId, me.id); if (await isBlockedEither(env, me.id, peer)) err(403, 'You can’t message this contact (blocked)', 'blocked'); }
  if (mem.c_type === 'group' && mem.c_only_admins && mem.role !== 'admin') err(403, 'Only admins can send messages in this group', 'only_admins');
  if (!(await rateHit(env, 'msg:' + me.id, 120, 60000))) err(429, 'You are sending too fast', 'rate');
  const type = ['text', 'image', 'video', 'file', 'audio', 'voice', 'poll', 'location', 'contact'].includes(b.type) ? b.type : 'text';
  const text = clamp(b.body, 10000);
  let meta = {}; let fileId = null;
  if (['image', 'video', 'file', 'audio', 'voice'].includes(type)) {
    const f = await env.DB.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').bind(b.file_id, me.id).first();
    if (!f || f.scope !== 'chat:' + chatId) err(400, 'File not uploaded for this chat', 'bad_file');
    fileId = f.id; const bm = b.meta || {};
    if (opt.rawMeta) meta = { ...bm, name: f.name, size: f.size, mime: f.mime, once: undefined };
    else {
      meta = { name: clamp(f.name, 200), size: f.size, mime: f.mime, width: +bm.width || undefined, height: +bm.height || undefined, duration: +bm.duration || undefined, waveform: Array.isArray(bm.waveform) ? bm.waveform.slice(0, 64).map((x) => Math.max(0, Math.min(100, +x | 0))) : undefined, thumb: typeof bm.thumb === 'string' ? bm.thumb : undefined, once: bm.once && ['image', 'video'].includes(type) ? true : undefined };
      if (meta.thumb) { const t = await env.DB.prepare('SELECT scope FROM files WHERE id=? AND owner_id=?').bind(meta.thumb, me.id).first(); if (!t || t.scope !== 'chat:' + chatId) delete meta.thumb; }
    }
  } else if (type === 'poll') {
    if (mem.c_type !== 'group') err(400, 'Polls are for groups');
    const bm = b.meta || {}; const opts = (bm.options || []).map((o) => clamp(o, 100).trim()).filter(Boolean).slice(0, 12);
    if (!clamp(bm.question, 200).trim() || opts.length < 2) err(400, 'A poll needs a question and at least 2 options');
    meta = { question: clamp(bm.question, 200).trim(), options: opts, multi: !!bm.multi };
  } else if (type === 'location') {
    const bm = b.meta || {}; const lat = +bm.lat, lng = +bm.lng;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180) || (lat === 0 && lng === 0)) err(400, 'Location looks wrong');
    meta = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, acc: Math.max(0, Math.min(100000, +bm.acc | 0)) || undefined, label: clamp(bm.label, 120) || undefined };
  } else if (type === 'contact') {
    const bm = b.meta || {}; const u = await env.DB.prepare('SELECT id, username, name FROM users WHERE id=? AND deleted=0').bind(String(bm.user_id || '')).first();
    if (!u) err(400, 'Contact not found');
    meta = { user_id: u.id, username: u.username, name: u.name };
  } else if (!text.trim()) err(400, 'Empty message');
  let replyTo = null;
  if (b.reply_to) { const r = await env.DB.prepare('SELECT id FROM messages WHERE id=? AND chat_id=?').bind(+b.reply_to, chatId).first(); if (r) replyTo = r.id; }
  if (b.deliver_at) err(400, 'Scheduled messages are not available', 'no_schedule');
  const deliver = now;
  const expires = mem.c_disappearing ? deliver + mem.c_disappearing * 1000 : null;
  const cid = b.client_id ? clamp(b.client_id, 40) : null;
  if (cid) { const ex = await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.sender_id=? AND m.client_id=?`).bind(me.id, cid).first(); if (ex) return serMsg(ex); }
  const r = await env.DB.prepare('INSERT INTO messages(chat_id,sender_id,type,body,file_id,meta,reply_to,forwarded,created_at,deliver_at,expires_at,client_id,ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(chatId, me.id, type, type === 'poll' ? '' : text, fileId, JSON.stringify(meta), replyTo, opt.forwarded ? 1 : 0, now, deliver, expires, cid, deliver).run();
  await env.DB.batch([
    env.DB.prepare('UPDATE chats SET last_msg_at=MAX(last_msg_at,?) WHERE id=?').bind(deliver, chatId),
    env.DB.prepare('UPDATE members SET hidden=0 WHERE chat_id=? AND hidden=1').bind(chatId),
    env.DB.prepare('DELETE FROM typing WHERE chat_id=? AND user_id=?').bind(chatId, me.id),
    env.DB.prepare('UPDATE members SET seen_upto=MAX(seen_upto,?) WHERE chat_id=? AND user_id=?').bind(Math.min(deliver, now), chatId, me.id),
  ]);
  const row = await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.id=?`).bind(r.meta.last_row_id).first();
  return serMsg(row);
}

// ---------- APK download (stored as chunks under /_dl/) ----------
async function serveChunks(env, req, manifest, type) {
  const man = await env.ASSETS.fetch(new Request(new URL('/_dl/' + manifest, req.url)));
  if (!man.ok) return new Response('Not uploaded yet.', { status: 404 });
  const info = await man.json();
  const { readable, writable } = new FixedLengthStream(info.size);
  (async () => { const w = writable.getWriter(); try { for (const c of info.chunks) { const r = await env.ASSETS.fetch(new Request(new URL('/_dl/' + c, req.url))); await w.write(new Uint8Array(await r.arrayBuffer())); } await w.close(); } catch (e) { await w.abort(e); } })();
  return new Response(readable, { headers: { 'content-type': type, 'content-disposition': `attachment; filename="${info.filename}"`, 'content-length': String(info.size), 'cache-control': 'no-cache', 'x-robots-tag': 'noindex' } });
}
async function serveApk(env, req) {
  const man = await env.ASSETS.fetch(new Request(new URL('/_dl/apk.json', req.url)));
  if (!man.ok) return new Response('The Android app is not uploaded yet.', { status: 404 });
  const info = await man.json();
  const { readable, writable } = new FixedLengthStream(info.size);
  (async () => { const w = writable.getWriter(); try { for (const c of info.chunks) { const r = await env.ASSETS.fetch(new Request(new URL('/_dl/' + c, req.url))); const b = new Uint8Array(await r.arrayBuffer()); await w.write(b); } await w.close(); } catch (e) { await w.abort(e); } })();
  return new Response(readable, { headers: { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': `attachment; filename="${info.filename}"`, 'content-length': String(info.size), 'cache-control': 'no-cache' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);
        const r = await api(req, env, url);
        if (req.method !== 'GET' && req.method !== 'HEAD' && r.status < 400) { try { await bumpAll(env); } catch {} }
        return withSec(r);
      }
      if (url.pathname === '/download/averchat.apk' || url.pathname === '/download/avermessage.apk' || url.pathname === '/avermessage.apk') return withSec(await serveApk(env, req));
      if (url.pathname === '/download/admin/AverChat-Admin.exe') return withSec(await serveChunks(env, req, 'exe.json', 'application/vnd.microsoft.portable-executable'));
      if (url.pathname === '/download/admin/info.json') { const r = await env.ASSETS.fetch(new Request(new URL('/_dl/exe.json', req.url))); return withSec(new Response(r.ok ? await r.text() : '{}', { status: r.ok ? 200 : 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' } })); }
      if (url.pathname === '/download/admin' || url.pathname === '/download/admin/') { const r = withSec(await env.ASSETS.fetch(new Request(new URL('/admin-download.html', req.url), req))); r.headers.set('x-robots-tag', 'noindex, nofollow'); r.headers.set('cache-control', 'no-cache'); return r; }
      if (url.pathname === '/admin' || url.pathname === '/admin/') { const r = withSec(await env.ASSETS.fetch(new Request(new URL('/admin.html', req.url), req))); r.headers.set('x-robots-tag', 'noindex, nofollow'); r.headers.set('cache-control', 'no-cache'); return r; }
      if (url.pathname.startsWith('/_dl/')) return new Response('Not found', { status: 404 });
      if (url.pathname === '/download' || url.pathname === '/download/') return withSec(await env.ASSETS.fetch(new Request(new URL('/download.html', req.url), req)));
      let r = await env.ASSETS.fetch(req);
      if (r.status === 404 && !/\.[a-z0-9]+$/i.test(url.pathname)) r = await env.ASSETS.fetch(new Request(new URL('/', req.url), req));
      const out = withSec(r);
      if (/\.(html)$|\/$/.test(url.pathname) || url.pathname === '/' || url.pathname === '/sw.js') out.headers.set('cache-control', 'no-cache');
      return out;
    } catch (e) {
      if (e instanceof HttpError) return withSec(json({ error: e.message, code: e.code }, e.status));
      console.error(e && e.stack || e);
      return withSec(json({ error: 'Something went wrong on the server', code: 'server' }, 500));
    }
  },
};
