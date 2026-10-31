package bot.tab.sites.avermessage;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * Fallback background check (Android runs it about every 15 minutes, even with "Instant notifications" off or killed by
 * the phone): if the instant service is alive it does nothing; otherwise it tries to restart it and fetches any messages
 * that arrived since the last check, showing them the same way the service does.
 */
public class NotifyWorker extends Worker {
    static volatile boolean appAlive = false;

    public NotifyWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void schedule(Context c) {
        try {
            androidx.work.Constraints cons = new androidx.work.Constraints.Builder().setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build();
            androidx.work.PeriodicWorkRequest req = new androidx.work.PeriodicWorkRequest.Builder(NotifyWorker.class, 15, java.util.concurrent.TimeUnit.MINUTES).setConstraints(cons).build();
            androidx.work.WorkManager.getInstance(c).enqueueUniquePeriodicWork("averchat-notify", androidx.work.ExistingPeriodicWorkPolicy.KEEP, req);
        } catch (Throwable ignored) {}
    }

    @NonNull @Override
    public Result doWork() {
        Context c = getApplicationContext();
        try {
            if (MainActivity.foreground) return Result.success();
            if (InstantService.healthy()) return Result.success();
            InstantService.start(c); // may be refused by Android from the background; then the check below still runs
            String tok = AvmNotifier.token(c);
            if (tok == null) return Result.success();
            long since = AvmNotifier.prefs(c).getLong("notify_since", System.currentTimeMillis() - 20 * 60 * 1000L);
            HttpURLConnection con = (HttpURLConnection) new URL(AvmNotifier.server(c) + "/api/notify?since=" + since).openConnection();
            con.setConnectTimeout(15000); con.setReadTimeout(20000);
            con.setRequestProperty("Cookie", "avm_s=" + tok);
            con.setRequestProperty("User-Agent", "AverChat-Android/" + BuildConfig.VERSION_NAME + " worker");
            int code = con.getResponseCode();
            if (code == 401 || code == 403) { con.disconnect(); AvmNotifier.clearToken(c); return Result.success(); }
            if (code != 200) { con.disconnect(); return Result.retry(); }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader rd = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"))) { String l; while ((l = rd.readLine()) != null) sb.append(l); }
            con.disconnect();
            JSONObject r = new JSONObject(sb.toString());
            long now = r.optLong("now", System.currentTimeMillis());
            AvmNotifier.prefs(c).edit().putLong("notify_since", Math.max(since, now - 5000))
                .putBoolean("secure", !r.optBoolean("screenshots", true)).apply();
            if (!MainActivity.foreground) { AvmNotifier.postMessages(c, r); AvmNotifier.postCalls(c, r); }
            return Result.success();
        } catch (Throwable t) {
            return Result.retry();
        }
    }
}
