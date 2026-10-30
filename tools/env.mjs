// Local stand-ins for the Worker bindings: D1 (node:sqlite), R2 (memory/disk), ASSETS (site folder).
import fs from 'node:fs'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
if (!globalThis.FixedLengthStream) globalThis.FixedLengthStream = class { constructor() { return new TransformStream(); } };
export function makeEnv(siteDir, dbFile = ':memory:') {
  const db = new DatabaseSync(dbFile);
  const exec = (sql, args) => { const st = db.prepare(sql); if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql)) return { results: st.all(...args).map((r) => ({ ...r })), meta: { changes: 0 } }; const r = st.run(...args); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, norm(a)), first: async () => { const r = exec(sql, args).results; return r.length ? r[0] : null; }, all: async () => exec(sql, args), run: async () => exec(sql, args), _x: () => exec(sql, args) });
  const DB = { prepare: (sql) => stmt(sql), exec: async (s) => db.exec(s), batch: async (l) => { db.exec('BEGIN'); try { const o = l.map((s) => s._x()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const store = new Map();
  const FILES = {
    put: async (k, buf, o) => { store.set(k, { buf: Buffer.from(buf), type: o?.httpMetadata?.contentType }); },
    get: async (k, o = {}) => { const v = store.get(k); if (!v) return null; let b = v.buf; if (o.range) b = b.subarray(o.range.offset, o.range.offset + o.range.length); return { body: new Blob([b]).stream(), size: v.buf.length }; },
    delete: async (k) => { store.delete(k); }, _store: store,
  };
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
  const ASSETS = { fetch: async (req) => { const u = new URL(req.url); let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html'; let f = path.join(siteDir, p); const isF = (x) => fs.existsSync(x) && fs.statSync(x).isFile(); if (!isF(f) && isF(f + '.html')) f += '.html'; if (!isF(f) || p.includes('_worker') || p.endsWith('tab-site.json')) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } }); return new Response(fs.readFileSync(f), { status: 200, headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } }); } };
  return { DB, FILES, ASSETS };
}
