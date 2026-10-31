package bot.tab.sites.avermessage;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs about every 15 minutes (Android's minimum for background work) while the app is closed: asks the server for
 * messages that arrived since the last check, using the app's own login cookie, and shows them as notifications.
 * When the app is open the page shows notifications itself instantly, so this does nothing then.
 */
public class NotifyWorker extends Worker {
    static final String CHANNEL = "averchat_messages";
    static volatile boolean appAlive = false;

    public NotifyWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("New messages while the app is closed");
                nm.createNotificationChannel(ch);
            }
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        if (appAlive) return Result.success();
        try {
            final String BASE = c.getString(R.string.averchat_server);
            String cookie = CookieManager.getInstance().getCookie(BASE);
            if (cookie == null || !cookie.contains("avm_s=")) return Result.success();
            SharedPreferences sp = c.getSharedPreferences(AvmSecurePlugin.PREFS, Context.MODE_PRIVATE);
            long since = sp.getLong("notify_since", System.currentTimeMillis() - 20 * 60 * 1000L);
            HttpURLConnection con = (HttpURLConnection) new URL(BASE + "/api/notify?since=" + since).openConnection();
            con.setConnectTimeout(15000);
            con.setReadTimeout(20000);
            con.setRequestProperty("Cookie", cookie);
            con.setRequestProperty("User-Agent", "AverChatApp/2.0.0 (background)");
            int code = con.getResponseCode();
            if (code != 200) { con.disconnect(); return code >= 500 ? Result.retry() : Result.success(); }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"))) {
                String line; while ((line = br.readLine()) != null) sb.append(line);
            }
            con.disconnect();
            JSONObject r = new JSONObject(sb.toString());
            sp.edit().putLong("notify_since", r.optLong("now", System.currentTimeMillis()))
                .putBoolean("secure", !r.optBoolean("screenshots", true)).apply();
            String app = r.optString("app_name", "AverChat");
            JSONArray msgs = r.optJSONArray("messages");
            JSONArray calls = r.optJSONArray("calls");
            boolean allowed = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, "android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
            if (!allowed) return Result.success();
            ensureChannel(c);
            NotificationManagerCompat nm = NotificationManagerCompat.from(c);
            Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            if (calls != null) {
                for (int i = 0; i < calls.length(); i++) {
                    JSONObject k = calls.getJSONObject(i);
                    NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_stat_avermessage)
                        .setContentTitle(app).setContentText("Incoming " + ("video".equals(k.optString("kind")) ? "video" : "voice") + " call from " + k.optString("caller"))
                        .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_CALL).setAutoCancel(true).setContentIntent(pi);
                    nm.notify(("call" + k.optString("id")).hashCode(), b.build());
                }
            }
            if (msgs != null && msgs.length() > 0) {
                // one notification per chat (newest message first in the list from the server)
                java.util.LinkedHashMap<String, java.util.List<JSONObject>> byChat = new java.util.LinkedHashMap<>();
                for (int i = 0; i < msgs.length(); i++) {
                    JSONObject m = msgs.getJSONObject(i);
                    String id = m.optString("chat_id");
                    if (!byChat.containsKey(id)) byChat.put(id, new java.util.ArrayList<>());
                    byChat.get(id).add(m);
                }
                for (java.util.Map.Entry<String, java.util.List<JSONObject>> e : byChat.entrySet()) {
                    java.util.List<JSONObject> list = e.getValue();
                    JSONObject first = list.get(0);
                    NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle();
                    for (int i = Math.min(list.size(), 5) - 1; i >= 0; i--) {
                        JSONObject m = list.get(i);
                        style.addLine((m.optBoolean("group") ? m.optString("sender") + ": " : "") + m.optString("text"));
                    }
                    String text = (first.optBoolean("group") ? first.optString("sender") + ": " : "") + first.optString("text");
                    NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_stat_avermessage)
                        .setContentTitle(first.optString("title")).setContentText(list.size() > 1 ? list.size() + " new messages" : text)
                        .setStyle(style).setSubText(app).setNumber(list.size()).setWhen(first.optLong("at"))
                        .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_MESSAGE).setAutoCancel(true).setContentIntent(pi);
                    nm.notify(e.getKey().hashCode(), b.build());
                }
            }
            return Result.success();
        } catch (SecurityException se) {
            return Result.success();
        } catch (Exception ex) {
            return Result.retry();
        }
    }
}
