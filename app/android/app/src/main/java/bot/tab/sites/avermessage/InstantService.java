package bot.tab.sites.avermessage;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * "Instant notifications": a foreground service that keeps one long-poll request open to /api/notify (the server holds it
 * up to ~28 s and answers the moment something changes), so a new message shows as a notification within a second or two
 * even when the app is closed. While the app itself is on screen it stays idle (the page shows its own banners).
 * Uses the same login as the app (its session cookie, copied natively). Reconnects with backoff, faster on network change.
 */
public class InstantService extends Service {
    static final int ONGOING_ID = 7000;
    static final long HOLD_MS = 28000;
    static volatile boolean running = false;
    static volatile long lastOkAt = 0;
    static volatile long lastPostedAt = 0;
    static volatile int lastPostedCount = 0;

    private static final Object LOCK = new Object();
    private volatile boolean stopped = false;
    private Thread worker;
    private volatile HttpURLConnection current;
    private ConnectivityManager.NetworkCallback netCb;
    private volatile int fails = 0;

    // ---- control from elsewhere (all safe to call any time; never throw) ----
    /** Start (or keep) the service if Instant is on and someone is logged in. Returns false if Android refused. */
    static boolean start(Context c) {
        try {
            if (!AvmNotifier.instantEnabled(c)) return false;
            if (AvmNotifier.token(c) == null) return false;
            Intent i = new Intent(c, InstantService.class);
            ContextCompat.startForegroundService(c, i);
            return true;
        } catch (Throwable t) { // ForegroundServiceStartNotAllowedException (Android 12+ from background), SecurityException, ...
            return false;
        }
    }

    static void stop(Context c) {
        try { c.stopService(new Intent(c, InstantService.class)); } catch (Throwable ignored) {}
    }

    /** Wake the loop now (app went to background, network came back, settings changed). */
    static void poke() { synchronized (LOCK) { LOCK.notifyAll(); } }

    static boolean healthy() { return running && System.currentTimeMillis() - lastOkAt < 3 * 60 * 1000L; }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        AvmNotifier.ensureChannels(this);
        if (!goForeground()) { stopSelf(); return; }
        running = true;
        registerNetwork();
        worker = new Thread(this::loop, "averchat-instant");
        worker.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!running) { // onCreate failed to go foreground
            stopSelf();
            return START_NOT_STICKY;
        }
        goForeground(); // must be called after every startForegroundService
        poke();
        return START_STICKY;
    }

    private boolean goForeground() {
        try {
            int type = 0;
            if (Build.VERSION.SDK_INT >= 34) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING;
            else if (Build.VERSION.SDK_INT >= 29) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            ServiceCompat.startForeground(this, ONGOING_ID, ongoing(), type);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private Notification ongoing() {
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, AvmNotifier.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_avermessage)
            .setContentTitle("AverChat connected")
            .setContentText("Naye messages turant aayenge")
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .setContentIntent(AvmNotifier.openApp(this, null));
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                Intent hide = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                    .putExtra(Settings.EXTRA_CHANNEL_ID, AvmNotifier.CH_SERVICE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                b.addAction(0, "Ise chhupao (hide)", PendingIntent.getActivity(this, 7002, hide, fl));
            } catch (Throwable ignored) {}
        }
        return b.build();
    }

    private void registerNetwork() {
        if (Build.VERSION.SDK_INT < 24) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            netCb = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { reconnectNow(); }
                @Override public void onLost(Network n) { reconnectNow(); }
            };
            cm.registerDefaultNetworkCallback(netCb);
        } catch (Throwable ignored) { netCb = null; }
    }

    /** Network changed: drop the request in flight (it may be stuck on the old network) and retry at once. */
    private void reconnectNow() {
        fails = 0;
        HttpURLConnection c = current;
        if (c != null) new Thread(() -> { try { c.disconnect(); } catch (Throwable ignored) {} }).start();
        poke();
    }

    private void pause(long ms) {
        if (ms <= 0 || stopped) return;
        synchronized (LOCK) { try { LOCK.wait(ms); } catch (InterruptedException ignored) {} }
    }

    private void loop() {
        long since = AvmNotifier.prefs(this).getLong("notify_since", System.currentTimeMillis() - 10 * 60 * 1000L);
        long b = -1;
        while (!stopped) {
            try {
                if (!AvmNotifier.instantEnabled(this)) { stopSelf(); return; }
                if (MainActivity.foreground) { // the app is on screen: it shows messages itself
                    since = System.currentTimeMillis() - 3000;
                    lastOkAt = System.currentTimeMillis();
                    pause(60000);
                    continue;
                }
                String tok = AvmNotifier.token(this);
                if (tok == null) { stopSelf(); return; }
                String url = AvmNotifier.server(this) + "/api/notify?dl=1&since=" + since + "&w=" + HOLD_MS + (b >= 0 ? "&b=" + b : "");
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                current = con;
                con.setConnectTimeout(15000);
                con.setReadTimeout((int) HOLD_MS + 20000);
                con.setUseCaches(false);
                con.setRequestProperty("Cookie", "avm_s=" + tok);
                con.setRequestProperty("Accept", "application/json");
                con.setRequestProperty("User-Agent", "AverChat-Android/" + BuildConfig.VERSION_NAME + " instant");
                long t0 = System.currentTimeMillis();
                int code = con.getResponseCode();
                if (code == 401 || code == 403) { // logged out / suspended: stop until the app is opened again
                    con.disconnect(); current = null;
                    AvmNotifier.clearToken(this);
                    stopSelf();
                    return;
                }
                if (code != 200) { con.disconnect(); current = null; throw new java.io.IOException("HTTP " + code); }
                StringBuilder sb = new StringBuilder();
                try (BufferedReader rd = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"))) { String line; while ((line = rd.readLine()) != null) sb.append(line); }
                con.disconnect(); current = null;
                JSONObject r = new JSONObject(sb.toString());
                PowerManager.WakeLock wl = null;
                try {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) { wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "averchat:instant"); wl.acquire(10000); }
                } catch (Throwable ignored) {}
                try {
                    if (!MainActivity.foreground) {
                        int n = AvmNotifier.postMessages(this, r);
                        if (n > 0) { lastPostedAt = System.currentTimeMillis(); lastPostedCount = n; }
                        AvmNotifier.postCalls(this, r);
                    }
                } finally { try { if (wl != null && wl.isHeld()) wl.release(); } catch (Throwable ignored) {} }
                long now = r.optLong("now", System.currentTimeMillis());
                since = Math.max(since, now - 5000); // overlap a little; ids are de-duplicated
                AvmNotifier.prefs(this).edit().putLong("notify_since", since).apply();
                lastOkAt = System.currentTimeMillis();
                fails = 0;
                if (r.has("b")) b = r.optLong("b", -1);
                else pause(60000); // an older server that cannot hold the request: don't hammer it
                if (System.currentTimeMillis() - t0 < 300) pause(300);
            } catch (Throwable t) {
                current = null;
                if (stopped) return;
                fails = Math.min(fails + 1, 7);
                long wait = Math.min(60000L, 1000L << fails); // 2 s, 4 s ... 60 s; a network change cuts it short
                pause(wait);
            }
        }
    }

    // Android 15 time limit for some service types (not remoteMessaging, but be safe): stop cleanly, the worker restarts us later.
    @Override public void onTimeout(int startId) { stopSelf(); }
    @Override public void onTimeout(int startId, int fgsType) { stopSelf(); }

    @Override
    public void onDestroy() {
        stopped = true;
        running = false;
        try { HttpURLConnection c = current; if (c != null) new Thread(() -> { try { c.disconnect(); } catch (Throwable ignored) {} }).start(); } catch (Throwable ignored) {}
        poke();
        if (netCb != null && Build.VERSION.SDK_INT >= 24) {
            try { ((ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCb); } catch (Throwable ignored) {}
        }
        super.onDestroy();
    }
}
