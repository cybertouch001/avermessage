# Avermessage — native Android app (v1.0.0)

A native Capacitor 7 Android app (Android System WebView — not a Trusted Web Activity, no browser bar) that loads the live
web app https://avermessage.sites.tab.bot/ inside the app, with the Capacitor bridge injected into that remote page so the
page can call native plugins.

- Package / appId: `bot.tab.sites.avermessage` · app name "Avermessage" · versionCode 1 · versionName 1.0.0
- minSdk 23 (Android 6) · target/compile SDK 35
- User agent gets ` AvermessageApp/1.0.0` appended (the page can detect the app with `navigator.userAgent` or
  `window.Capacitor?.isNativePlatform()`).

## Layout
- `capacitor.config.json` — `server.url` = the live site, `allowNavigation` = `avermessage.sites.tab.bot`,
  `server.errorPath` = `offline.html` (shown when the site can't load; retries automatically when back online),
  splash / status bar / notification icon settings, `App.disableBackButtonHandler` (MainActivity owns the back button).
- `www/` — `offline.html` (+ `icon.png`) and a tiny `index.html` that redirects to the live URL. Copied into the APK.
- `android/` — the native project.
  - `MainActivity.java` — registers `AvmCall`, sets the WebView DownloadListener, handles the back button.
  - `AvmCallPlugin.java` — the `AvmCall` plugin (below).
  - `com/getcapacitor/AvmPluginAccess.java` — tiny shim so MainActivity can ask whether the page listens to
    App `backButton` (Capacitor's `hasListeners` is protected).
- `tools/make_native_res.py` — launcher icons (legacy, round, adaptive foreground + gradient background, Android 13
  monochrome), notification icon, Android 12+ splash icon and classic splash images, all from `../brand/icon-1024*.png`.

## Native behaviour
- **Camera / mic in the page (calls, voice notes):** Capacitor's `BridgeWebChromeClient.onPermissionRequest` asks for
  CAMERA (video capture) and RECORD_AUDIO + MODIFY_AUDIO_SETTINGS (audio capture) at runtime, then grants the WebView
  request; denied -> the page's `getUserMedia` rejects. `mediaPlaybackRequiresUserGesture` is false (set by Capacitor's
  Bridge), so ringtones and remote audio can autoplay.
- **File chooser:** Capacitor's `onShowFileChooser` handles `<input type=file>` incl. `accept` (several types ->
  EXTRA_MIME_TYPES) and `multiple` (EXTRA_ALLOW_MULTIPLE); `capture` opens the camera.
- **Downloads:** normal links that the server answers as a download (e.g. `/api/files/<id>?download=1` with
  Content-Disposition) go to Android's DownloadManager with the WebView's cookies, user agent and referer, saved to
  Downloads with a progress/complete notification. File name from Content-Disposition (`filename*` UTF-8 first).
  On Android 6–9 the storage permission is asked; if refused the file goes to the app's own Downloads folder.
  `blob:` / `data:` URLs are ignored natively (the page should handle those itself).
- **Back button:** if the page registered `App.addListener('backButton', ...)` it gets the event (`{canGoBack}`) and
  decides (`history.back()`, close a sheet, or `App.minimizeApp()`); otherwise the WebView goes back in history; at the
  start of history the app is minimised (moved to background, not killed).
- **Plugins in the remote page:** `@capacitor/app`, `@capacitor/local-notifications`, `@capacitor/status-bar`,
  `@capacitor/splash-screen` and `AvmCall`. The bridge script is injected with `addDocumentStartJavaScript` for the
  origin `https://avermessage.sites.tab.bot` (any WebView ≥ ~v83). The page should use `window.Capacitor.Plugins.X`
  (no bundler needed) — e.g. `Capacitor.Plugins.LocalNotifications.schedule({...})`.

### AvmCall (window.Capacitor.Plugins.AvmCall)
| call | does |
|---|---|
| `setSpeaker({on: true\|false})` | MODE_IN_COMMUNICATION; Android 12+: `setCommunicationDevice` (speaker / BT / wired headset / earpiece), older: `setSpeakerphoneOn`. Resolves `{on}` |
| `setInCall({on: true})` | keep screen on, MODE_IN_COMMUNICATION, transient audio focus, volume keys = call volume; on Android 12+ asks once for BLUETOOTH_CONNECT (pass `askBluetooth:false` to skip). Resolves state |
| `setInCall({on: false})` | clears all of that, MODE_NORMAL |
| `vibrate({ms})` / `vibrate({pattern:[0,800,600,800], repeat:true})` / `stopVibrate()` | vibration (ringing) |
| `getState()` | `{inCall, speaker, sdk, bluetoothPermission}` |
| `checkPermissions()` / `requestPermissions({permissions:['bluetooth']})` | BLUETOOTH_CONNECT |

## Build
    npm install
    python3 tools/make_native_res.py          # only when the brand icons change (needs pillow numpy scipy)
    npx cap sync android
    cd android
    JAVA_HOME=<path to JDK 21> ANDROID_HOME=<path to Android SDK> ./gradlew assembleRelease
    # -> android/app/build/outputs/apk/release/app-release.apk

Release signing reads a properties file kept OUTSIDE this tree — env `AVM_MSG_SIGNING_PROPS`
(default `../../kit/signing.properties`, outside the repo) with `storeFile`, `storePassword`, `keyAlias`,
`keyPassword`. Alias `avermessage`. No keystore is in this tree. Every future update must be signed with the same key,
or phones will refuse to install it over the old version.

Verify:
    apksigner verify --print-certs app-release.apk
    aapt dump badging app-release.apk
    zipalign -c -P 16 -v 4 app-release.apk
