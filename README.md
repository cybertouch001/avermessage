# AverChat

AverChat (formerly Avermessage) — a chat app: 1:1 and group chats, channels with invite links, voice notes, photos/videos/files,
location and contact sharing, replies, reactions, polls, status, 1:1 voice/video calls, an app lock, and an admin panel.

* Web app + API: `site/` — a Cloudflare Worker (`_worker.js`, D1 database, R2 file storage) serving a vanilla-JS app.
* Android app: `app/` — Capacitor 7 shell around the web app (package `bot.tab.sites.avermessage`, so it updates the old Avermessage app).
  Adds screenshot blocking (FLAG_SECURE, controlled by the admin), native downloads, and notifications when the app is closed:
  * 2.0.1 "Instant notifications" (default on, switch in Me > Notifications): a foreground service (`InstantService`, type remoteMessaging on Android 14+, dataSync on 10-13)
    keeps one long-poll request open to `/api/notify` (held up to ~28 s by the server, answered the moment something changes) using the app's own login cookie,
    posts one notification per chat (respects mute, block, chat lock and "show preview"; tap opens the chat), restarts after reboot / app update, reconnects on network change.
    A quiet "AverChat connected" notification shows while it runs (its channel can be turned off in phone settings).
  * A one-time setup screen (`SetupActivity`, Hinglish) asks for notification permission, unrestricted battery, and autostart on Vivo / Xiaomi / Oppo-type phones.
  * The old WorkManager check (about every 15 minutes) stays as a fallback.
  * 2.1.0: shows the real text of end-to-end encrypted messages in notifications (`AvmE2E`: key kept encrypted under an Android Keystore key), and saves decrypted files to Downloads/AverChat.
* End-to-end encryption (2.1.0, `site/js/e2e.js`): 1:1 and group messages, captions, photos, videos, voice notes, files, locations, contacts and poll texts are
  encrypted on the sender's device with standard WebCrypto: an ECDH P-256 identity key per user, a fresh AES-256-GCM key per message, sealed for each
  member with HKDF-SHA256 over ECDH(sender, member). The server stores only ciphertext (`messages.enc`), public keys, and a key backup locked with the
  user's password (PBKDF2-SHA256, 310k rounds), so a reinstall or new phone restores the key at login. A chat is encrypted when every member has a key;
  otherwise it falls back to normal messages, marked 🔓. Security codes (chat info) let two people verify keys; a key change is announced in the chat.
  Not end-to-end encrypted: channels, status updates, profile data, messages sent before 2.1.0, and metadata (who talks to whom, when, sizes, reactions).
  An admin password reset means that user's earlier encrypted messages can't be opened on a new/reinstalled phone. Test: `test/e2e_crypto.py`.
* Admin desktop app: `admin-app/` — Electron wrapper around `/admin` (Windows portable .exe via electron-builder).
* Brand assets: `brand/`. Tests: `test/` (`node test/api.test.mjs` against a local dev server, `tools/dev-server.mjs`).

## What the admin controls
App name, tagline, logo, colour theme / presets, font, layout, intro video and background video (built-in or uploaded),
screenshots on/off, sign-ups, announcements, users (search, ban, delete with all their data, set a new password; passwords are stored hashed and never shown),
reports, and call relay servers.

The Android launcher icon and launcher name are part of the installed APK and only change with a new APK build.

## Build
* Android: `cd app && npm install && npx cap sync android && cd android && ./gradlew assembleRelease` (signing config read from a local `signing.properties`, not in this repo).
* Admin exe: `cd admin-app && npm install && npx electron-builder --win portable --x64`.

Signing keys, bootstrap tokens and admin passwords are deliberately not in this repository.
