package bot.tab.sites.avermessage;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import com.getcapacitor.AvmPluginAccess;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginHandle;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The app's one screen: Capacitor loads https://avermessage.sites.tab.bot (capacitor.config.json server.url) and injects
 * the Capacitor bridge into it. Added here: the AvmCall plugin, attachment downloads through Android's DownloadManager
 * (with the WebView's cookies, so authenticated /api/files/... links work), and the back button.
 */
public class MainActivity extends BridgeActivity {

    private ActivityResultLauncher<String> storagePermission;
    private DownloadManager.Request pendingDownload;
    private String pendingName;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AvmCallPlugin.class);
        registerPlugin(AvmSecurePlugin.class);
        registerPlugin(AvmNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        // screenshots: apply the admin's last known choice before anything is drawn
        AvmSecurePlugin.apply(this, AvmSecurePlugin.saved(this));
        NotifyWorker.appAlive = true;
        // the page's renderer can be killed (low memory on budget phones, or a WebView bug): without this the whole app
        // closes. Instead: rebuild the page, and after repeated failures show a simple native message with a retry button.
        try {
            if (getBridge() != null) getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    onWebCrash(view);
                    return true;
                }
            });
        } catch (Throwable ignored) { }
        AvmNotifier.ensureChannels(this);
        // fallback background check (about every 15 minutes) in case the instant service is off or the phone killed it
        NotifyWorker.schedule(this);
        handleOpenChat(getIntent());
        // one-time "turn on instant notifications" screen after installing / updating to 2.0.1
        try {
            if (!AvmNotifier.prefs(this).getBoolean(SetupActivity.DONE_KEY, false)) startActivity(new Intent(this, SetupActivity.class));
        } catch (Throwable ignored) { }

        storagePermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            DownloadManager.Request r = pendingDownload;
            String name = pendingName;
            pendingDownload = null;
            pendingName = null;
            if (r == null) return;
            if (!granted) {
                // no public Downloads access on Android 6-9 without the permission: keep it in the app's own folder
                r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            }
            enqueue(r, name);
        });

        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.setDownloadListener(this::onDownload);
        }

        // Back: the page decides if it listens to App 'backButton'; otherwise go back in history; otherwise minimise.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBack();
            }
        });
    }

    private void handleBack() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        PluginHandle app = getBridge() != null ? getBridge().getPlugin("App") : null;
        if (app != null && AvmPluginAccess.hasListeners(app.getInstance(), "backButton")) {
            JSObject data = new JSObject();
            data.put("canGoBack", webView != null && webView.canGoBack());
            AvmPluginAccess.notifyListeners(app.getInstance(), "backButton", data, true);
            getBridge().triggerJSEvent("backbutton", "document");
        } else if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true); // minimise; the WebView stays alive in the background
        }
    }

    // ---- downloads -------------------------------------------------------------------------------------------------

    private void onDownload(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            return; // blob:/data: URLs are the page's own business
        }
        try {
            String name = fileName(url, contentDisposition, mimeType);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null && !cookies.isEmpty()) r.addRequestHeader("Cookie", cookies);
            if (userAgent != null && !userAgent.isEmpty()) r.addRequestHeader("User-Agent", userAgent);
            String referer = getBridge() != null && getBridge().getWebView() != null ? getBridge().getWebView().getUrl() : null;
            if (referer != null && referer.startsWith("https://")) r.addRequestHeader("Referer", referer);
            if (mimeType != null && !mimeType.isEmpty() && !"application/octet-stream".equals(mimeType)) r.setMimeType(mimeType);
            r.setTitle(name);
            r.setDescription(getString(R.string.app_name));
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setAllowedOverMetered(true);
            r.setAllowedOverRoaming(true);
            if (Build.VERSION.SDK_INT < 29 && Build.VERSION.SDK_INT >= 23
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                pendingDownload = r;
                pendingName = name;
                storagePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
                return;
            }
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            enqueue(r, name);
        } catch (Exception e) {
            Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void enqueue(DownloadManager.Request r, String name) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(r);
            Toast.makeText(this, "Downloading " + name + "\u2026", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private static final Pattern CD_STAR = Pattern.compile("filename\\*\\s*=\\s*([^']*)'[^']*'([^;]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern CD_PLAIN = Pattern.compile("filename\\s*=\\s*(\"([^\"]*)\"|[^;]+)", Pattern.CASE_INSENSITIVE);

    /** Content-Disposition filename* (RFC 5987, UTF-8) first, then filename, then Android's guess. */
    static String fileName(String url, String cd, String mimeType) {
        String name = null;
        if (cd != null) {
            Matcher m = CD_STAR.matcher(cd);
            if (m.find()) {
                try {
                    String cs = m.group(1).trim();
                    name = URLDecoder.decode(m.group(2).trim().replace("+", "%2B"), cs.isEmpty() ? "UTF-8" : cs);
                } catch (Exception ignored) {}
            }
            if (name == null || name.isEmpty()) {
                m = CD_PLAIN.matcher(cd);
                if (m.find()) name = m.group(2) != null ? m.group(2) : m.group(1).trim();
            }
        }
        if (name == null || name.trim().isEmpty()) name = URLUtil.guessFileName(url, cd, mimeType);
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.startsWith(".")) name = "_" + name;
        if (name.isEmpty()) name = "download";
        if (!name.contains(".") && mimeType != null) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType.toLowerCase(Locale.ROOT));
            if (ext != null) name = name + "." + ext;
        }
        if (name.length() > 120) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
            name = name.substring(0, 120 - ext.length()) + ext;
        }
        return name;
    }

    // ---- page renderer crash recovery ----
    private static final long[] webCrashes = new long[3];
    private static int webCrashIdx = 0;

    private void onWebCrash(WebView view) {
        long now = System.currentTimeMillis();
        boolean tooMany = now - webCrashes[webCrashIdx] < 60000; // 3 crashes within a minute
        webCrashes[webCrashIdx] = now; webCrashIdx = (webCrashIdx + 1) % webCrashes.length;
        runOnUiThread(() -> {
            try { android.view.ViewParent p = view.getParent(); if (p instanceof android.view.ViewGroup) ((android.view.ViewGroup) p).removeView(view); } catch (Throwable ignored) { }
            if (!tooMany) { try { recreate(); return; } catch (Throwable ignored) { } }
            showWebError();
        });
    }

    private void showWebError() {
        try {
            android.widget.LinearLayout box = new android.widget.LinearLayout(this);
            box.setOrientation(android.widget.LinearLayout.VERTICAL);
            box.setGravity(android.view.Gravity.CENTER);
            int pad = (int) (24 * getResources().getDisplayMetrics().density);
            box.setPadding(pad, pad, pad, pad);
            box.setBackgroundColor(0xFF0C0718);
            android.widget.TextView t = new android.widget.TextView(this);
            t.setText("AverChat ka page abhi load nahi ho paya.\nNotifications chalte rahenge.\n\nDobara try karo, ya phone restart karke kholo.");
            t.setTextColor(0xFFFFFFFF); t.setTextSize(17); t.setGravity(android.view.Gravity.CENTER);
            box.addView(t);
            android.widget.Button b = new android.widget.Button(this);
            b.setText("Dobara try karo"); b.setAllCaps(false);
            b.setOnClickListener(v -> { try { recreate(); } catch (Throwable ignored) { } });
            box.addView(b);
            setContentView(box);
        } catch (Throwable ignored) { }
    }

    // ---- instant notifications: foreground state, login copy, tapped-notification -> open that chat ----
    static volatile boolean foreground = false;
    private static volatile String pendingChat = null;

    /** The app is on screen: the page shows its own banner/sound, so no Android notification for any chat. */
    static boolean isChatVisible(String chatId) { return foreground; }

    static String takePendingChat() { String c = pendingChat; pendingChat = null; return c; }

    private void handleOpenChat(Intent i) {
        try {
            if (i == null) return;
            String c = i.getStringExtra(AvmNotifier.EXTRA_CHAT);
            if (c == null || !c.matches("[A-Za-z0-9_-]{1,80}")) return;
            i.removeExtra(AvmNotifier.EXTRA_CHAT);
            pendingChat = c;
            // page already running: ask it to open the chat (if it is still loading it picks it up via takePendingChat)
            if (getBridge() != null && getBridge().getWebView() != null) {
                final String js = "window.avmOpenChat&&window.avmOpenChat('" + c + "')";
                getBridge().getWebView().postDelayed(() -> { try { if (pendingChat != null) getBridge().getWebView().evaluateJavascript(js, null); } catch (Throwable ignored) {} }, 400);
            }
        } catch (Throwable ignored) { }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleOpenChat(intent);
    }

    @Override
    public void onDestroy() {
        NotifyWorker.appAlive = false;
        foreground = false;
        // messages that arrived while the app was open were already shown by the page
        getSharedPreferences(AvmSecurePlugin.PREFS, MODE_PRIVATE).edit().putLong("notify_since", System.currentTimeMillis()).apply();
        InstantService.poke();
        super.onDestroy();
    }

    @Override
    public void onResume() {
        super.onResume();
        NotifyWorker.appAlive = true;
        foreground = true;
        AvmNotifier.resetStacks(this);
        AvmSecurePlugin.apply(this, AvmSecurePlugin.saved(this));
        try { AvmNotifier.captureToken(this); InstantService.start(this); } catch (Throwable ignored) { }
    }

    @Override
    public void onPause() {
        foreground = false;
        try {
            getSharedPreferences(AvmSecurePlugin.PREFS, MODE_PRIVATE).edit().putLong("notify_since", System.currentTimeMillis() - 3000).apply();
            AvmNotifier.captureToken(this);
            InstantService.poke(); // leave the idle wait and start listening now
        } catch (Throwable ignored) { }
        super.onPause();
    }
}
