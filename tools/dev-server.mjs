// Dev/e2e server: the real _worker.js with local bindings. PORT env (default 8790). Serves http://localhost:PORT.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { makeEnv } from './env.mjs';
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const env = makeEnv(SITE, process.env.DB_FILE || ':memory:');
const tmp = path.join('/tmp', 'avmsg-worker-' + process.pid + '.mjs'); fs.copyFileSync(path.join(SITE, '_worker.js'), tmp);
const mod = await import(tmp);
const PORT = +process.env.PORT || 8790;
http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c); const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = { ...req.headers }; headers['cf-connecting-ip'] = req.headers['x-test-ip'] || req.socket.remoteAddress || '127.0.0.1';
    const r = await mod.default.fetch(new Request('http://localhost:' + PORT + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
    const h = {}; r.headers.forEach((v, k) => { if (k === 'set-cookie') return; h[k] = v; });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) h['set-cookie'] = sc;
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500); res.end('dev error'); }
}).listen(PORT, () => console.log('avermessage dev server on http://localhost:' + PORT));
