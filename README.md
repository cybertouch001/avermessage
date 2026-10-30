# Avermessage

An original messaging app: web app + Android app. Chats, groups, voice notes, photos/videos/documents,
1:1 voice and video calls, 24-hour status, and extras like scheduled messages, chat lock, disappearing
messages, polls, pinned messages, Hindi UI and an owner admin panel.

Live: https://avermessage.sites.tab.bot/ · Android app: https://avermessage.sites.tab.bot/download

## What's in here
- `site/` — the whole web app.
  - `_worker.js` — server (Cloudflare-Workers style): REST API, auth, chats, messages, files, calls signalling,
    status, admin. Storage: a SQL database (`DB`, D1/SQLite) and an object store (`FILES`, R2) for uploads.
  - `index.html`, `css/app.css`, `js/*.js` — the client (plain ES modules, no build step).
  - `sw.js` — service worker for notifications. `download.html` — Android download page.
- `app/` — native Android wrapper (Capacitor 7) that loads the live site, with camera/mic/file/download support
  and a small native `AvmCall` plugin (speaker, in-call mode, vibration). See `app/README.md`.
- `tools/` — `dev-server.mjs` runs the real worker locally on Node (SQLite in memory) for development/tests.
- `test/` — `api.test.mjs` (node:test API tests), `e2e.py` (Playwright: 3 users in separate browsers, incl. a
  WebRTC video call with fake camera/mic), `live_smoke.py`.
- `brand/` — the app icon.

## Run locally
    PORT=8790 AVM_BOOT_TOKEN=<random token> node tools/dev-server.mjs
    # open http://localhost:8790
    AVM_BOOT_TOKEN=<same token> node --test test/api.test.mjs
    python3 test/e2e.py /tmp/shots <same token>     # needs: pip install playwright && playwright install chromium

The first owner account (username `admin`) is created once with `POST /api/admin/bootstrap {token, password}`;
the worker only stores the SHA-256 of that token (`BOOT_HASH` in `_worker.js`) — set your own before deploying.

## How it works / honest limits
- Realtime is short polling (about every 1.5 s, faster during calls) — the host has no WebSockets.
- Calls are WebRTC peer-to-peer with public STUN servers. Without a TURN relay some mobile/corporate networks
  cannot connect; the admin panel has a field for a TURN server.
- Messages are sent over HTTPS and stored on the server. They are **not end-to-end encrypted**.
- Passwords: PBKDF2-SHA256 (100k iterations, per-user salt); login rate limit + lockout; HttpOnly session cookie;
  a CSRF header on every write; files are only readable by members of the chat they were sent in.
- No SMS verification: accounts are username (or phone) + password.
- Notifications work while the app/tab is open or in the background; there is no push service for a fully closed app.
- Group calls are not supported (1:1 only). Files up to 50 MB.
