# AverChat

AverChat (formerly Avermessage) — a chat app: 1:1 and group chats, channels with invite links, voice notes, photos/videos/files,
location and contact sharing, replies, reactions, polls, status, 1:1 voice/video calls, an app lock, and an admin panel.

* Web app + API: `site/` — a Cloudflare Worker (`_worker.js`, D1 database, R2 file storage) serving a vanilla-JS app.
* Android app: `app/` — Capacitor 7 shell around the web app (package `bot.tab.sites.avermessage`, so it updates the old Avermessage app).
  Adds screenshot blocking (FLAG_SECURE, controlled by the admin), background message checks (WorkManager, about every 15 minutes) and native downloads.
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
